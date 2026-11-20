/** `scripts/install/runtime.ts` 各安装期只读校验、数据库核验与 Mini App 配置沿用逻辑的隔离单元测试。 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_BOT_TIME_ZONE } from "../../packages/consts/bot";
import {
  IDENTITY_DATABASE_SCHEMA_VERSION,
  IDENTITY_DATABASE_TIME_ZONE_KEY,
} from "../../packages/consts/identityStorage";
import { MINI_APP_PASSWORD_PLACEHOLDER } from "../../packages/consts/miniApp";
import {
  GLOBAL_STATE_FILE_PATH,
  IDENTITY_DATABASE_PATH,
  MINI_APP_TOTP_FILE_PATH,
} from "../../packages/consts/paths";
import { TELEGRAM_BOT_TOKEN_PLACEHOLDER } from "../../packages/consts/telegram";
import { InputValidationError } from "../../packages/libs/inputValidation";
import type { BotConfig } from "../../packages/types/config";
import {
  assertStateFilesMigrated,
  assertStorageDatabaseMigrated,
  assertStorageDatabaseTimeZone,
  carryOverMiniAppConfig,
  loadInstallerBotConfig,
  validateExistingDeploymentInputs,
  validateStagedBotConfig,
} from "../../scripts/install/runtime";
import { TEST_DATA_ROOT } from "../preloadEnv";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir: string = mkdtempSync(join(TEST_DATA_ROOT, prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach((): void => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const VALID_BOT_FIELDS: Readonly<Record<string, unknown>> = {
  bot_token: "123456789:installer-runtime-test-token",
  super_admin_user_id: 987_654_321,
  time_zone: "Asia/Tokyo",
  log_level: "operation",
};

const VALID_MINI_APP: Readonly<Record<string, unknown>> = {
  url: "https://console.example.test",
  host: "127.0.0.1",
  port: 8443,
  password: "real-mini-app-password-987654",
};

describe("scripts/install/runtime 隔离辅助接口", (): void => {
  test("validateExistingDeploymentInputs 在隔离测试根上校验通过", async (): Promise<void> => {
    await expect(validateExistingDeploymentInputs()).resolves.toBeUndefined();
  });

  test("assertStateFilesMigrated 通过合法或缺失状态，并拒绝非法全局状态与 TOTP 文件", async (): Promise<void> => {
    await expect(assertStateFilesMigrated()).resolves.toBeUndefined();

    mkdirSync(join(GLOBAL_STATE_FILE_PATH, ".."), { recursive: true });
    await Bun.write(GLOBAL_STATE_FILE_PATH, JSON.stringify({ copy: { copiedUser: null }, unexpected: 1 }));
    try {
      await expect(assertStateFilesMigrated()).rejects.toThrow(InputValidationError);
    } finally {
      rmSync(GLOBAL_STATE_FILE_PATH, { force: true });
    }

    mkdirSync(join(MINI_APP_TOTP_FILE_PATH, ".."), { recursive: true });
    await Bun.write(MINI_APP_TOTP_FILE_PATH, JSON.stringify({ version: 1, secret: "bad", createdAt: 1 }));
    try {
      await expect(assertStateFilesMigrated()).rejects.toThrow(InputValidationError);
    } finally {
      rmSync(MINI_APP_TOTP_FILE_PATH, { force: true });
    }
  });

  test("assertStorageDatabaseMigrated 通过当前 schema、缺失库跳过，并拒绝旧 schema 版本", async (): Promise<void> => {
    await expect(assertStorageDatabaseMigrated()).resolves.toBeUndefined();

    const db: Database = new Database(IDENTITY_DATABASE_PATH);
    try {
      db.run("UPDATE storage_metadata SET data = jsonb(?) WHERE key = 'schema-version'", [
        JSON.stringify({ version: IDENTITY_DATABASE_SCHEMA_VERSION - 1 }),
      ]);
    } finally {
      db.close(true);
    }
    try {
      await expect(assertStorageDatabaseMigrated()).rejects.toThrow(
        `${IDENTITY_DATABASE_PATH}: storage_metadata.schema-version must be {"version":${IDENTITY_DATABASE_SCHEMA_VERSION}}.`
      );
    } finally {
      const restoreDb: Database = new Database(IDENTITY_DATABASE_PATH);
      try {
        restoreDb.run("UPDATE storage_metadata SET data = jsonb(?) WHERE key = 'schema-version'", [
          JSON.stringify({ version: IDENTITY_DATABASE_SCHEMA_VERSION }),
        ]);
      } finally {
        restoreDb.close(true);
      }
    }

    const backupDir: string = makeTempDir("db-backup-");
    const movedDb: string = join(backupDir, "storage.sqlite");
    await rename(IDENTITY_DATABASE_PATH, movedDb);
    try {
      await expect(assertStorageDatabaseMigrated()).resolves.toBeUndefined();
    } finally {
      await rename(movedDb, IDENTITY_DATABASE_PATH);
    }
  });

  test("assertStorageDatabaseTimeZone 接受匹配时区并拒绝不匹配时区", (): void => {
    expect((): void => assertStorageDatabaseTimeZone(DEFAULT_BOT_TIME_ZONE)).not.toThrow();
    expect((): void => assertStorageDatabaseTimeZone("America/New_York")).toThrow(
      `${IDENTITY_DATABASE_PATH}: storage_metadata.${IDENTITY_DATABASE_TIME_ZONE_KEY} must be {"timeZone":"America/New_York"}.`
    );
  });

  test("loadInstallerBotConfig 剥离占位 mini_app 并保留已配置的 mini_app，validateStagedBotConfig 校验严格配置", async (): Promise<void> => {
    const dir: string = makeTempDir("installer-bot-config-");
    const placeholderPath: string = join(dir, "placeholder.json");
    await Bun.write(placeholderPath, JSON.stringify({
      ...VALID_BOT_FIELDS,
      bot_token: TELEGRAM_BOT_TOKEN_PLACEHOLDER,
      mini_app: { ...VALID_MINI_APP, password: `  ${MINI_APP_PASSWORD_PLACEHOLDER}  ` },
    }));
    const parsedPlaceholder: BotConfig = await loadInstallerBotConfig(placeholderPath);
    expect(parsedPlaceholder.miniApp).toBeUndefined();
    expect(parsedPlaceholder.timeZone).toBe("Asia/Tokyo");

    const configuredPath: string = join(dir, "configured.json");
    await Bun.write(configuredPath, JSON.stringify({
      ...VALID_BOT_FIELDS,
      mini_app: VALID_MINI_APP,
    }));
    const parsedConfigured: BotConfig = await loadInstallerBotConfig(configuredPath);
    expect(parsedConfigured.miniApp).toEqual({
      url: "https://console.example.test/",
      host: "127.0.0.1",
      port: 8443,
      password: "real-mini-app-password-987654",
    });
    await expect(validateStagedBotConfig(configuredPath)).resolves.toBeUndefined();

    const nonRecordPath: string = join(dir, "non-record.json");
    await Bun.write(nonRecordPath, "null");
    await expect(loadInstallerBotConfig(nonRecordPath))
      .rejects.toThrow(`${nonRecordPath}: $ must be { bot_token, super_admin_user_id,`);
  });

  test("carryOverMiniAppConfig 仅在既有文件含非占位 mini_app 且候选文件为对象时并入配置", async (): Promise<void> => {
    const dir: string = makeTempDir("carry-over-mini-app-");
    const existingPath: string = join(dir, "existing.json");
    const candidatePath: string = join(dir, "candidate.json");
    const initialCandidate: string = `${JSON.stringify(VALID_BOT_FIELDS, null, 2)}\n`;

    // 既有文件不存在时直接跳过，不改动候选文件。
    await Bun.write(candidatePath, initialCandidate);
    await carryOverMiniAppConfig(existingPath, candidatePath);
    expect(await Bun.file(candidatePath).text()).toBe(initialCandidate);

    // 既有文件非对象、无 mini_app、或仅含占位密码时均不并入。
    for (const ignoredExisting of [
      [],
      VALID_BOT_FIELDS,
      { ...VALID_BOT_FIELDS, mini_app: { ...VALID_MINI_APP, password: MINI_APP_PASSWORD_PLACEHOLDER } },
    ]) {
      await Bun.write(existingPath, JSON.stringify(ignoredExisting));
      await Bun.write(candidatePath, initialCandidate);
      await carryOverMiniAppConfig(existingPath, candidatePath);
      expect(await Bun.file(candidatePath).text()).toBe(initialCandidate);
    }

    // 既有文件含真实 mini_app 但候选文件不是普通对象时保持候选文件原样。
    await Bun.write(existingPath, JSON.stringify({ ...VALID_BOT_FIELDS, mini_app: VALID_MINI_APP }));
    await Bun.write(candidatePath, "[]");
    await carryOverMiniAppConfig(existingPath, candidatePath);
    expect(await Bun.file(candidatePath).text()).toBe("[]");

    // 既有文件含真实 mini_app 且候选文件为普通对象时原样并入 mini_app 字段。
    await Bun.write(candidatePath, initialCandidate);
    await carryOverMiniAppConfig(existingPath, candidatePath);
    expect(await Bun.file(candidatePath).json()).toEqual({
      ...VALID_BOT_FIELDS,
      mini_app: VALID_MINI_APP,
    });
  });
});

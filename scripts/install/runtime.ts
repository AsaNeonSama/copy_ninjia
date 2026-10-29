/** 安装器共用的路径、严格校验和建库入口；二进制发行时单独打包。 */
export { RUNTIME_DATA_ROOT, IDENTITY_DATABASE_PATH } from "../../packages/consts/paths";
import { IDENTITY_DATABASE_PATH } from "../../packages/consts/paths";
import { IDENTITY_DATABASE_SCHEMA_VERSION } from "../../packages/consts/identityStorage";
import { closeStorageDatabase, openStorageDatabase } from "../../packages/database/interact/connection";
import { readStorageDatabaseSchemaMetadata } from "../../packages/database/interact/inspection";
import { assertStorageTimeZone, readStorageSchemaVersion } from "../../packages/database/validation/storageRows";
import type { StorageDatabase, StoredStorageMetadataRow } from "../../packages/types/storageDatabase";
export { assertNoMisplacedConfigFiles } from "../../packages/config/layout";
export { validateAgentDeploymentConfig } from "../../packages/config/agent";
import { parseBotConfig } from "../../packages/config/botInput";
import { MINI_APP_PASSWORD_PLACEHOLDER } from "../../packages/consts/miniApp";
import { TELEGRAM_BOT_TOKEN_PLACEHOLDER } from "../../packages/consts/telegram";
import { StateStore, loadCurrentGlobalState } from "../../packages/infra/storage/statePersistence";
import { invalidInput, readJsonInput } from "../../packages/libs/inputValidation";
import { isPlainRecord } from "../../packages/libs/record";
import { inspectWedMemberFiles } from "../../packages/workers/diskIO/wedMemberFiles";
import type { BotConfig } from "../../packages/types/config";
import type * as Readiness from "../../packages/config/readiness";
export { bootstrapStorageDatabase } from "../../packages/database/interact/initialization";

/** 完成问卷和新库初始化后才加载启动总闸。 */
export async function validateExistingDeploymentInputs(): Promise<void> {
  const readiness: typeof Readiness = await import("../../packages/config/readiness");
  await readiness.validateExistingDeploymentInputs();
}

/**
 * 安装前按启动恢复同一口径只读校验全局状态：旧位置的状态文件（`LEGACY_STATE_FILE_PATHS`）
 * 存在，或 memory/global/state.json 不是当前格式时拒绝。
 */
export async function assertStateFilesMigrated(): Promise<void> {
  await loadCurrentGlobalState(new StateStore());
}

/**
 * 安装前按启动恢复同一口径只读校验 memory/wed：任一群文件不是当前 `{ id, enteredAt }` 滑窗格式
 * （例如仍是未经 migrate:wed-member-window 的成员 ID 数组）时拒绝，不改写文件。
 */
export async function assertWedMemberFilesMigrated(): Promise<void> {
  await inspectWedMemberFiles();
}

/**
 * 只读读出已有共享数据库的 metadata，并先确认 schema 版本是当前版本。
 *
 * @param database 已只读打开的共享存储数据库
 * @returns 数据库 `storage_metadata` 表行列表
 */
function readCurrentStorageMetadata(database: StorageDatabase): readonly StoredStorageMetadataRow[] {
  const metadata: readonly StoredStorageMetadataRow[] = readStorageDatabaseSchemaMetadata(database);
  const version: number = readStorageSchemaVersion({ metadata }, IDENTITY_DATABASE_PATH);
  if (version !== IDENTITY_DATABASE_SCHEMA_VERSION) {
    invalidInput(IDENTITY_DATABASE_PATH, "storage_metadata.schema-version", `{"version":${IDENTITY_DATABASE_SCHEMA_VERSION}}`);
  }
  return metadata;
}

/**
 * 安装前只读核对已有共享数据库的 schema 版本：不是当前版本时拒绝，不改写数据库。库不存在时由
 * 建库步骤创建；完整校验留给启动恢复。
 */
export async function assertStorageDatabaseMigrated(): Promise<void> {
  if (!await Bun.file(IDENTITY_DATABASE_PATH).exists()) return;
  const database: StorageDatabase = openStorageDatabase({ path: IDENTITY_DATABASE_PATH, readonly: true });
  try {
    readCurrentStorageMetadata(database);
  } finally {
    closeStorageDatabase(database);
  }
}

/**
 * 配置写定后、注册服务前只读核对已有共享数据库绑定的时区：time-zone 标记必须等于 bot.json
 * 的规范化时区，与启动闸同一口径；不改写数据库。
 *
 * @param timeZone `bot.json` 解析出的规范化 IANA 时区名称
 */
export function assertStorageDatabaseTimeZone(timeZone: string): void {
  const database: StorageDatabase = openStorageDatabase({ path: IDENTITY_DATABASE_PATH, readonly: true });
  try {
    assertStorageTimeZone({ metadata: readCurrentStorageMetadata(database) }, IDENTITY_DATABASE_PATH, timeZone);
  } finally {
    closeStorageDatabase(database);
  }
}

/**
 * 只严格校验候选文件内容；配置目录布局由安装准备（runtime.sh）与启动总闸检查。
 *
 * @param path 候选 `bot.json` 文件路径
 */
export async function validateStagedBotConfig(path: string): Promise<void> {
  parseBotConfig(await readJsonInput(path), path);
}

/**
 * 判断 `bot.json` 原始对象中的 `mini_app` 段是否为示例占位密码。
 *
 * @param miniApp `bot.json` 的 `mini_app` 原始字段值
 * @returns 当 `mini_app` 为普通对象且 `password` trim 后等于 `MINI_APP_PASSWORD_PLACEHOLDER` 时返回 `true`
 */
function isPlaceholderMiniAppRecord(miniApp: unknown): boolean {
  return (
    isPlainRecord(miniApp) &&
    typeof miniApp.password === "string" &&
    miniApp.password.trim() === MINI_APP_PASSWORD_PLACEHOLDER
  );
}

/**
 * 问卷开始前校验既有 Bot 字段；仅示例 token 与示例占位 `mini_app` 允许等待本次填写或视同未配置，风格与时区原样保留。配置目录
 * 布局已由安装准备（runtime.sh）检查。
 *
 * @param path 既有 `bot.json` 配置文件路径
 * @returns 解析并规范化后的 Bot 配置对象
 */
export async function loadInstallerBotConfig(path: string): Promise<BotConfig> {
  const value: unknown = await readJsonInput(path);
  if (!isPlainRecord(value)) {
    return parseBotConfig(value, path);
  }
  const candidate: Record<string, unknown> = { ...value };
  if (
    typeof candidate.bot_token === "string" &&
    candidate.bot_token.trim() === TELEGRAM_BOT_TOKEN_PLACEHOLDER
  ) {
    candidate.bot_token = "installer-initial-identity";
  }
  if (isPlaceholderMiniAppRecord(candidate.mini_app)) {
    delete candidate.mini_app;
  }
  return parseBotConfig(candidate, path);
}

/**
 * 重新填写 `bot.json` 时，若既有配置文件含已配置（非示例占位密码）的 `mini_app` 段，将其原样并入候选文件；
 * 既有文件不含 `mini_app` 或仍为占位密码时不并入。
 *
 * @param existingPath 既有 `bot.json` 路径
 * @param candidatePath 候选 `bot.json` 临时文件路径
 */
export async function carryOverMiniAppConfig(
  existingPath: string,
  candidatePath: string
): Promise<void> {
  if (!await Bun.file(existingPath).exists()) return;
  const existing: unknown = await readJsonInput(existingPath);
  if (
    !isPlainRecord(existing) ||
    existing.mini_app === undefined ||
    isPlaceholderMiniAppRecord(existing.mini_app)
  ) {
    return;
  }
  const candidate: unknown = await readJsonInput(candidatePath);
  if (!isPlainRecord(candidate)) return;
  await Bun.write(
    candidatePath,
    `${JSON.stringify({ ...candidate, mini_app: existing.mini_app }, null, 2)}\n`
  );
}

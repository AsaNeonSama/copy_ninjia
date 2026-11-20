import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TEST_DATA_ROOT } from "../preloadEnv";
import { loadBotConfig } from "../../packages/config/botInput";
import { loadInstallerBotConfig, validateStagedBotConfig } from "../../scripts/install/runtime";
import { DEFAULT_LOG_LEVEL, LOG_LEVELS } from "../../packages/consts/logger";
import { TELEGRAM_BOT_TOKEN_PLACEHOLDER } from "../../packages/consts/telegram";

let root: string;
const tokenSentinel: string = "987654321:BotInputTokenSentinel_DoNotEcho_4321";
const passwordSentinel: string = "BotInputPasswordSentinel_DoNotEcho_432109";
const identity = {
  bot_token: tokenSentinel,
  super_admin_user_id: 7,
  log_level: "operation",
  mini_app: {
    url: "https://miniapp.example.com",
    host: "127.0.0.1",
    port: 3000,
    password: passwordSentinel,
  },
};
beforeEach(() => { root = mkdtempSync(join(TEST_DATA_ROOT, "bot-input-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test("当前配置异步加载，普通风格保留；缺少 bot 文件即拒绝", async () => {
  const path: string = join(root, "bot.json");
  await Bun.write(path, JSON.stringify({ ...identity, atmosphere: "normal" }));
  expect((await loadBotConfig(path)).atmosphere).toBe("normal");
  expect((await loadInstallerBotConfig(path)).atmosphere).toBe("normal");
  await Bun.file(path).delete();
  await expect(loadBotConfig(path)).rejects.toThrow(`${path}: $ must be a readable valid JSON document`);
});

test("加载配置保留显式时区，非法时区在启动配置读取时拒绝", async (): Promise<void> => {
  const path: string = join(root, "bot.json");
  await Bun.write(path, JSON.stringify({ ...identity, time_zone: " UTC " }));
  expect((await loadBotConfig(path)).timeZone).toBe("UTC");
  expect((await loadInstallerBotConfig(path)).timeZone).toBe("UTC");
  const badZoneSentinel: string = "InvalidZoneSentinel_DoNotEcho_6543";
  await Bun.write(path, JSON.stringify({ ...identity, time_zone: badZoneSentinel }));
  let zoneError: unknown;
  try {
    await loadBotConfig(path);
  } catch (error: unknown) {
    zoneError = error;
  }
  expect(zoneError).toBeInstanceOf(Error);
  expect((zoneError as Error).message).toBe(`${path}: $.time_zone must be an IANA time zone name.`);
  expect((zoneError as Error).message).not.toContain(tokenSentinel);
  expect((zoneError as Error).message).not.toContain(passwordSentinel);
  expect((zoneError as Error).message).not.toContain(badZoneSentinel);
});

test("运行时和安装器加载均保留风格未配置状态", async (): Promise<void> => {
  const path: string = join(root, "bot.json");
  await Bun.write(path, JSON.stringify(identity));
  expect((await loadBotConfig(path)).atmosphere).toBeUndefined();
  expect((await loadInstallerBotConfig(path)).atmosphere).toBeUndefined();
  await expect(validateStagedBotConfig(path)).resolves.toBeUndefined();
});

test("安装问卷允许示例 token 待填写，同时严格保留或拒绝已有风格", async () => {
  const path: string = join(root, "bot.json");
  await Bun.write(path, JSON.stringify({ ...identity, bot_token: TELEGRAM_BOT_TOKEN_PLACEHOLDER, atmosphere: "normal" }));
  expect((await loadInstallerBotConfig(path)).atmosphere).toBe("normal");
  await expect(loadBotConfig(path)).rejects.toThrow("non-placeholder");
  for (const [value, expectedMessage] of [
    [{ ...identity, atmosphere: null }, `${path}: $.atmosphere must be`],
    [{ ...identity, bot_token: "" }, `${path}: $.bot_token must be a configured non-placeholder string.`],
    [null, `${path}: $ must be { bot_token, super_admin_user_id,`],
  ] as const) {
    await Bun.write(path, JSON.stringify(value));
    await expect(loadInstallerBotConfig(path)).rejects.toThrow(expectedMessage);
  }
});

test("候选文件只校验内容，不检查其目录的旧入口，非法内容仍拒绝且不覆盖原件", async (): Promise<void> => {
  const original: string = join(root, "telegram.json");
  const staged: string = join(root, ".telegram.json.install.test");
  const content: string = JSON.stringify({ ...identity, atmosphere: "normal" });
  await Bun.write(original, content);
  await Bun.write(staged, content);
  await expect(validateStagedBotConfig(staged)).resolves.toBeUndefined();
  for (const invalid of [
    "{broken secret", new Uint8Array([0xff]),
    JSON.stringify({ ...identity, atmosphere: null }),
    JSON.stringify({ ...identity, super_admin_user_id: 0 }),
    JSON.stringify({ ...identity, bot_token: TELEGRAM_BOT_TOKEN_PLACEHOLDER }),
  ]) {
    await Bun.write(staged, invalid);
    await expect(validateStagedBotConfig(staged)).rejects.toThrow(staged);
  }
  await Bun.file(staged).delete();
  await expect(validateStagedBotConfig(staged)).rejects.toThrow("readable valid JSON document");
  expect(await Bun.file(original).text()).toBe(content);
});

test("log_level 缺省使用 DEFAULT_LOG_LEVEL，支持全部合法级别并去空白，存在非法值时运行时与安装校验均拒绝", async (): Promise<void> => {
  const path: string = join(root, "bot.json");
  const { log_level: _ignored, ...withoutLogLevel } = identity;
  await Bun.write(path, JSON.stringify(withoutLogLevel));
  expect((await loadBotConfig(path)).logLevel).toBe(DEFAULT_LOG_LEVEL);
  expect((await loadInstallerBotConfig(path)).logLevel).toBe(DEFAULT_LOG_LEVEL);
  await expect(validateStagedBotConfig(path)).resolves.toBeUndefined();

  for (const level of LOG_LEVELS) {
    await Bun.write(path, JSON.stringify({ ...identity, log_level: `  ${level}  ` }));
    expect((await loadBotConfig(path)).logLevel).toBe(level);
    expect((await loadInstallerBotConfig(path)).logLevel).toBe(level);
    await expect(validateStagedBotConfig(path)).resolves.toBeUndefined();
  }

  for (const invalid of [
    { ...identity, log_level: null },
    { ...identity, log_level: "" },
    { ...identity, log_level: "debug" },
  ]) {
    await Bun.write(path, JSON.stringify(invalid));
    for (const loader of [loadBotConfig, loadInstallerBotConfig, validateStagedBotConfig]) {
      let thrown: unknown;
      try {
        await loader(path);
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(`${path}: $.log_level must be info, operation, warn, or error`);
      expect((thrown as Error).message).not.toContain(tokenSentinel);
      expect((thrown as Error).message).not.toContain(passwordSentinel);
    }
  }
  const badPasswordSentinel: string = "WeakPasswordSentinel_DoNotEcho_1111";
  await Bun.write(
    path,
    JSON.stringify({
      ...identity,
      mini_app: {
        ...identity.mini_app,
        password: badPasswordSentinel,
      },
    })
  );
  for (const loader of [loadBotConfig, loadInstallerBotConfig, validateStagedBotConfig]) {
    let thrown: unknown;
    try {
      await loader(path);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(`${path}: $.mini_app.password`);
    expect((thrown as Error).message).not.toContain(tokenSentinel);
    expect((thrown as Error).message).not.toContain(badPasswordSentinel);
  }
});

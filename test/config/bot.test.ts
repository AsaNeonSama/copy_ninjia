import { getTimeZone } from "../../packages/config/time";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import {
  BOT_TOKEN,
  SUPER_ADMIN_USER_ID,
  getBotConfig,
} from "../../packages/config/bot";
import { parseBotConfig } from "../../packages/config/botInput";
import { CONFIG_ROOT_ENV } from "../../packages/consts/environment";
import { BOT_CONFIG_PATH } from "../../packages/consts/paths";
import { TELEGRAM_BOT_TOKEN_PLACEHOLDER } from "../../packages/consts/telegram";
import { botConfigCache } from "../../packages/cache/perThread/config";
import type { BotConfig } from "../../packages/types/config";
import { DEFAULT_BOT_TIME_ZONE, LEGACY_BOT_CONFIG_NAME } from "../../packages/consts/bot";
import { STATIC_CONFIG_DIR_NAME } from "../../packages/consts/configLayout";
import { DEFAULT_LOG_LEVEL, LOG_LEVELS } from "../../packages/consts/logger";
import {
  MINI_APP_DEFAULT_HOST,
  MINI_APP_PASSWORD_PLACEHOLDER,
} from "../../packages/consts/miniApp";
import { TEST_DATA_ROOT } from "../preloadEnv";

/** 部署配置中 `bot.json` 的文件名，取自生产路径常量。 */
const botConfigName: string = basename(BOT_CONFIG_PATH);

afterEach((): void => {
  botConfigCache.current = null;
});

describe("config/static/bot.json", () => {
  test("测试配置可加载且输出稳定的运行时类型", async () => {
    const expected: BotConfig = parseBotConfig(await Bun.file(BOT_CONFIG_PATH).json());
    expect(BOT_TOKEN).toBe(expected.botToken);
    expect(SUPER_ADMIN_USER_ID).toBe(expected.superAdminUserId);
  });

  test("严格解析 token 与正安全整数超级管理员 ID", () => {
    const parsed: BotConfig = parseBotConfig(
      { bot_token: "  token:secret  ", super_admin_user_id: 123, log_level: "operation" },
      "telegram.test.json"
    );
    expect(parsed).toEqual({
      timeZone: DEFAULT_BOT_TIME_ZONE,
      atmosphere: undefined,
      logLevel: "operation",
      botToken: "token:secret",
      superAdminUserId: 123,
    });
  });

  test("示例 token 在启动前拒绝且错误不回显原值", () => {
    // 取常量而不是再抄一份字面量：占位符在 consts、config_example 与 install.sh 各有一份；
    // 示例文件那一份的对拍见 test/config/examples.test.ts，install.sh 那一份见 test/scripts/installScript.test.ts。
    const placeholder: string = TELEGRAM_BOT_TOKEN_PLACEHOLDER;
    const parse = (): BotConfig => parseBotConfig(
      { bot_token: placeholder, super_admin_user_id: 123, log_level: "operation" },
      "telegram.test.json"
    );
    expect(parse).toThrow(
      "telegram.test.json: $.bot_token must be a configured non-placeholder string"
    );
    expect(parse).not.toThrow(placeholder);
  });

  test("解析结果在编译期保持只读", () => {
    const assertReadonly = (config: BotConfig): void => {
      // @ts-expect-error 部署配置只在进程启动时构造一次，调用方不得改写 token。
      config.botToken = "replacement";
      // @ts-expect-error 超级管理员身份同样只能通过停机修改配置来变更。
      config.superAdminUserId = 456;
      // @ts-expect-error 通知风格属于本次启动的只读配置。
      config.atmosphere = "normal";
      // @ts-expect-error 默认时区属于本次启动的只读配置。
      config.timeZone = "UTC";
      // @ts-expect-error 日志级别属于本次启动的只读配置。
      config.logLevel = "warn";
    };
    expect(assertReadonly).toBeDefined();
  });

  test("快照未初始化时读取直接抛错，且只写路径不写值", () => {
    // 快照尚未初始化时直接抛错，不回退默认值，也不把 token 回显进错误文案。
    botConfigCache.current = null;
    expect(getBotConfig).toThrow(
      `Telegram configuration was not initialized from ${BOT_CONFIG_PATH}.`
    );
    expect(getBotConfig).not.toThrow(BOT_TOKEN);
  });

  test("快照就位后读取原样交回同一份对象，不重新解析", () => {
    const snapshot: BotConfig = {
      timeZone: getTimeZone(),
      atmosphere: "mesugaki",
      logLevel: "operation",
      botToken: "token:snapshot",
      superAdminUserId: 7,
    };
    botConfigCache.current = snapshot;
    expect(getBotConfig()).toBe(snapshot);
  });

  test("缺字段、未知字段、空 token 与非法 ID 都拒绝且不回显输入", () => {
    const tokenSentinel: string = "777888999:BotConfigTokenSentinel_DoNotEcho_1122";
    const invalidValues: readonly unknown[] = [
      {},
      { bot_token: tokenSentinel },
      { bot_token: tokenSentinel, super_admin_user_id: 1, log_level: "" },
      { bot_token: tokenSentinel, super_admin_user_id: 1, log_level: "debug" },
      { bot_token: tokenSentinel, super_admin_user_id: 1, log_level: "operation", extra: true },
      { bot_token: "   ", super_admin_user_id: 1, log_level: "operation" },
      { bot_token: tokenSentinel, super_admin_user_id: "1", log_level: "operation" },
      { bot_token: tokenSentinel, super_admin_user_id: 0, log_level: "operation" },
      { bot_token: tokenSentinel, super_admin_user_id: Number.MAX_SAFE_INTEGER + 1, log_level: "operation" },
    ];
    for (const value of invalidValues) {
      const parse = (): BotConfig => parseBotConfig(value, "telegram.test.json");
      expect(parse).toThrow("telegram.test.json:");
      expect(parse).not.toThrow(tokenSentinel);
    }
  });
});

test("通知风格缺省保持未配置，显式值 trim 后保留且非法值拒绝", () => {
  for (const atmosphere of [undefined, "mesugaki", "normal"] as const) {
    expect(
      parseBotConfig({ bot_token: "secret", super_admin_user_id: 7, log_level: "operation", atmosphere }).atmosphere
    ).toBe(atmosphere);
  }
  for (const atmosphere of ["mesugaki", "normal"] as const) {
    expect(
      parseBotConfig({
        bot_token: "secret",
        super_admin_user_id: 7,
        log_level: "operation",
        atmosphere: ` ${atmosphere} `,
      }).atmosphere
    ).toBe(atmosphere);
  }
  const tokenSentinel: string = "777888999:AtmosphereTokenSentinel_DoNotEcho_3344";
  for (const atmosphere of [null, "plain", "teasing", "", "  ", 1, [], {}]) {
    const parse = (): BotConfig =>
      parseBotConfig(
        { bot_token: tokenSentinel, super_admin_user_id: 7, log_level: "operation", atmosphere },
        "bot.fixture.json"
      );
    expect(parse).toThrow("bot.fixture.json: $.atmosphere must be mesugaki or normal");
    expect(parse).not.toThrow(tokenSentinel);
  }
});

test("默认时区缺省使用 Bot 默认值，配置值 trim 后保留", () => {
  const identity: Readonly<Record<string, unknown>> = {
    bot_token: "secret",
    super_admin_user_id: 7,
    log_level: "operation",
  };
  expect(parseBotConfig(identity).timeZone).toBe(DEFAULT_BOT_TIME_ZONE);
  for (const timeZone of ["UTC", "Asia/Shanghai", "America/New_York", "Asia/Kathmandu"]) {
    expect(parseBotConfig({ ...identity, time_zone: ` ${timeZone} ` }).timeZone).toBe(timeZone);
  }
});

test("默认时区按 Temporal 规范化大小写，别名不折叠", () => {
  const identity: Readonly<Record<string, unknown>> = {
    bot_token: "secret",
    super_admin_user_id: 7,
    log_level: "operation",
  };
  for (const [input, canonical] of [
    ["asia/tokyo", "Asia/Tokyo"], ["ASIA/TOKYO", "Asia/Tokyo"], ["utc", "UTC"],
    ["europe/london", "Europe/London"], ["Japan", "Japan"], ["Asia/Calcutta", "Asia/Calcutta"],
  ] as const) {
    expect(parseBotConfig({ ...identity, time_zone: input }).timeZone).toBe(canonical);
  }
});

test("存在但非法的默认时区拒绝，错误只包含文件、字段与期望", () => {
  const tokenSentinel: string = "777888999:TimeZoneTokenSentinel_DoNotEcho_5566";
  const badZoneSentinel: string = "InvalidZoneSentinel_DoNotEcho_5566";
  for (const timeZone of [null, "", "  ", badZoneSentinel, "+09:00", 9, true, [], {}]) {
    const parse = (): BotConfig => parseBotConfig({
      bot_token: tokenSentinel, super_admin_user_id: 7, log_level: "operation", time_zone: timeZone,
    }, "bot.fixture.json");
    expect(parse).toThrow("bot.fixture.json: $.time_zone must be an IANA time zone name.");
    expect(parse).not.toThrow(tokenSentinel);
    expect(parse).not.toThrow(badZoneSentinel);
  }
});

test("log_level 缺省使用 DEFAULT_LOG_LEVEL，存在时只接受四个级别且去掉首尾空白后保留", () => {
  expect(parseBotConfig({
    bot_token: "secret",
    super_admin_user_id: 7,
  }).logLevel).toBe(DEFAULT_LOG_LEVEL);
  expect(parseBotConfig({
    bot_token: "secret",
    super_admin_user_id: 7,
    log_level: undefined,
  }).logLevel).toBe(DEFAULT_LOG_LEVEL);

  for (const level of LOG_LEVELS) {
    expect(parseBotConfig({
      bot_token: "secret",
      super_admin_user_id: 7,
      log_level: level,
    }).logLevel).toBe(level);
    expect(parseBotConfig({
      bot_token: "secret",
      super_admin_user_id: 7,
      log_level: `  ${level}  `,
    }).logLevel).toBe(level);
  }
  expect(parseBotConfig({
    bot_token: "secret",
    super_admin_user_id: 7,
    log_level: "  info  ",
  }).logLevel).toBe("info");

  const tokenSentinel: string = "777888999:LogLevelTokenSentinel_DoNotEcho_7788";
  const badLevelSentinel: string = "DebugSentinel_DoNotEcho_7788";
  for (const invalidLogLevel of [null, "", "   ", badLevelSentinel, "log", "INFO", 1, true, [], {}]) {
    const parse = (): BotConfig => parseBotConfig({
      bot_token: tokenSentinel,
      super_admin_user_id: 7,
      log_level: invalidLogLevel,
    }, "bot.fixture.json");
    expect(parse).toThrow("bot.fixture.json: $.log_level must be info, operation, warn, or error");
    expect(parse).not.toThrow(tokenSentinel);
    expect(parse).not.toThrow(badLevelSentinel);
  }
});

test("mini_app 缺省保持未配置，配置时 host 缺省默认 MINI_APP_DEFAULT_HOST 并严格校验 https URL、端口、host 与 password，拒绝遗留 Ed25519 密钥字段", () => {
  const withoutMiniApp: BotConfig = parseBotConfig({
    bot_token: "secret",
    super_admin_user_id: 7,
    log_level: "operation",
  });
  expect(withoutMiniApp.miniApp).toBeUndefined();

  const withDefaultHost: BotConfig = parseBotConfig({
    bot_token: "secret",
    super_admin_user_id: 7,
    log_level: "operation",
    mini_app: {
      url: "  https://miniapp.example.com/app  ",
      port: 3000,
      password: "  s3cr3t-pass-123456  ",
    },
  });
  expect(withDefaultHost.miniApp).toEqual({
    url: "https://miniapp.example.com/app",
    host: MINI_APP_DEFAULT_HOST,
    port: 3000,
    password: "s3cr3t-pass-123456",
  });

  const withUndefinedHost: BotConfig = parseBotConfig({
    bot_token: "secret",
    super_admin_user_id: 7,
    log_level: "operation",
    mini_app: {
      url: "https://miniapp.example.com/app",
      host: undefined,
      port: 3000,
      password: "s3cr3t-pass-123456",
    },
  });
  expect(withUndefinedHost.miniApp?.host).toBe(MINI_APP_DEFAULT_HOST);

  const withLoopbackHost: BotConfig = parseBotConfig({
    bot_token: "secret",
    super_admin_user_id: 7,
    log_level: "operation",
    mini_app: {
      url: "  https://miniapp.example.com/app  ",
      host: "  127.0.0.1  ",
      port: 3000,
      password: "  s3cr3t-pass-123456  ",
    },
  });
  expect(withLoopbackHost.miniApp).toEqual({
    url: "https://miniapp.example.com/app",
    host: "127.0.0.1",
    port: 3000,
    password: "s3cr3t-pass-123456",
  });

  const withCustomHost: BotConfig = parseBotConfig({
    bot_token: "secret",
    super_admin_user_id: 7,
    log_level: "operation",
    mini_app: {
      url: "https://miniapp.example.com/",
      host: " 0.0.0.0 ",
      port: 3000,
      password: "custom-password-654321",
    },
  });
  expect(withCustomHost.miniApp).toEqual({
    url: "https://miniapp.example.com/",
    host: "0.0.0.0",
    port: 3000,
    password: "custom-password-654321",
  });

  const tokenSentinel: string = "777888999:MiniAppTokenSentinel_DoNotEcho_9900";
  const passwordSentinel: string = "MiniAppPasswordSentinel_DoNotEcho_9900";
  const urlSentinel: string = "http://miniapp-sentinel-do-not-echo.example.com";
  const validMiniAppBase = {
    url: "https://miniapp.example.com",
    host: "127.0.0.1",
    port: 3000,
    password: passwordSentinel,
  };
  for (const invalidMiniApp of [
    null,
    urlSentinel,
    {},
    { ...validMiniAppBase, url: urlSentinel },
    { ...validMiniAppBase, port: 0 },
    { ...validMiniAppBase, port: 65_536 },
    { ...validMiniAppBase, host: null },
    { ...validMiniAppBase, host: "" },
    { ...validMiniAppBase, host: "   " },
    { ...validMiniAppBase, host: 127 },
    {
      url: "https://miniapp.example.com",
      host: "127.0.0.1",
      port: 3000,
    },
    { ...validMiniAppBase, password: "   " },
    { ...validMiniAppBase, password: "12345" },
    { ...validMiniAppBase, password: "only-letters-password" },
    { ...validMiniAppBase, password: "a1b2c3d4e5" },
    { ...validMiniAppBase, password: MINI_APP_PASSWORD_PLACEHOLDER },
    {
      ...validMiniAppBase,
      signing_private_key: "legacy-private-key-value",
    },
    {
      ...validMiniAppBase,
      signing_public_key: "legacy-public-key-value",
    },
    { ...validMiniAppBase, extra: true },
  ]) {
    const parse = (): BotConfig =>
      parseBotConfig(
        {
          bot_token: tokenSentinel,
          super_admin_user_id: 7,
          log_level: "operation",
          mini_app: invalidMiniApp,
        },
        "bot.fixture.json"
      );
    expect(parse).toThrow("bot.fixture.json: $.mini_app");
    expect(parse).not.toThrow(tokenSentinel);
    expect(parse).not.toThrow(passwordSentinel);
  }
});

describe("config/bot.ts 导入期窄前置检查", () => {
  async function importBotConfigInSubprocess(configRoot: string): Promise<{
    readonly exitCode: number;
    readonly stderr: string;
    readonly stdout: string;
  }> {
    const child: Bun.Subprocess<"ignore", "pipe", "pipe"> = Bun.spawn(
      [
        Bun.argv[0]!,
        "-e",
        'const mod = await import("./packages/config/bot.ts"); console.log(mod.SUPER_ADMIN_USER_ID);',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, [CONFIG_ROOT_ENV]: configRoot },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [exitResult, stdoutResult, stderrResult] = await Promise.allSettled([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (
      exitResult.status !== "fulfilled" ||
      stdoutResult.status !== "fulfilled" ||
      stderrResult.status !== "fulfilled"
    ) {
      throw new Error("Subprocess output collection failed.");
    }
    return {
      exitCode: exitResult.value,
      stdout: stdoutResult.value,
      stderr: stderrResult.value,
    };
  }

  test("旧版 config/telegram.json 与放错层级的 config/bot.json 在加载 bot.json 前报出明确诊断", async () => {
    const tempRoot: string = mkdtempSync(join(TEST_DATA_ROOT, "bot-precheck-"));
    try {
      const legacyPath: string = join(tempRoot, LEGACY_BOT_CONFIG_NAME);
      await Bun.write(legacyPath, "{}");
      const legacyResult = await importBotConfigInSubprocess(tempRoot);
      expect(legacyResult.exitCode).not.toBe(0);
      expect(legacyResult.stderr).toContain(
        `${legacyPath}: $ must be absent after explicit cold migration to ${botConfigName}.`
      );
      rmSync(legacyPath, { force: true });

      const misplacedPath: string = join(tempRoot, botConfigName);
      await Bun.write(misplacedPath, "{}");
      const misplacedResult = await importBotConfigInSubprocess(tempRoot);
      expect(misplacedResult.exitCode).not.toBe(0);
      expect(misplacedResult.stderr).toContain(
        `${misplacedPath}: $ must be absent; ${botConfigName} belongs in ${STATIC_CONFIG_DIR_NAME}/.`
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("config/static/bot.json 为指向常规文件的合法符号链接时照常启动加载", async () => {
    const tempRoot: string = mkdtempSync(join(TEST_DATA_ROOT, "bot-symlink-"));
    try {
      const externalFile: string = join(tempRoot, "mounted-bot.json");
      const configRoot: string = join(tempRoot, "config");
      const staticDir: string = join(configRoot, STATIC_CONFIG_DIR_NAME);
      mkdirSync(staticDir, { recursive: true });
      await Bun.write(externalFile, JSON.stringify({
        bot_token: "123456:valid-symlink-token",
        super_admin_user_id: 987654321,
        log_level: "operation",
      }));
      symlinkSync(externalFile, join(staticDir, botConfigName));

      const result = await importBotConfigInSubprocess(configRoot);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("987654321");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

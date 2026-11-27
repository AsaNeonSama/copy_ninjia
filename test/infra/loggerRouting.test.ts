import { getTimeZone } from "../../packages/config/time";
import { adoptLogLevel, getLogLevel } from "../../packages/config/logLevel";
import { TTS_DEFAULT_BOT_LANGUAGE, TTS_DEFAULT_STYLE } from "../../packages/consts/aiChat/voiceMessage";
import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test";
import { FLUSH_INTERVAL_MS } from "../../packages/consts/diskIO/appendOnly";
import { DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES } from "../../packages/consts/diskIO/diagnostics";
import { diskIORuntime } from "../../packages/cache/main/diskIO";
import {
  pauseDiskIODiagnosticChannel,
  resumeDiskIODiagnosticChannel,
} from "../../packages/infra/diskIO/diagnosticChannel";
import {
  emitSuccessfulDiskIOLoad,
  FakeDiskIOWorker,
  installFakeDiskIOWorker,
} from "../helpers/diskIOWorkerHarness";
import {
  CONSOLE_METHOD_BY_LOG_LEVEL,
  CONSOLE_PREFIX_BY_LOG_LEVEL,
  LOGGER_CIRCULAR_ERROR_VALUE,
  LOGGER_MAX_REDACTED_SECRETS,
  LOGGER_NESTED_ERROR_DEPTH_EXCEEDED_VALUE,
  LOGGER_NESTED_ERROR_MAX_DEPTH,
  LOGGER_UNSERIALIZABLE_VALUE,
  LOG_LEVELS,
  LOG_LEVEL_PRIORITY,
} from "../../packages/consts/logger";
import { REDACTED_SECRET } from "../../packages/consts/redaction";
import type {
  DiskDiagnosticBatchRequest,
  DiskIOMessage,
  LogEnvelope,
  LogLevel,
  LogMessage,
} from "../../packages/types/diskIO/messages";
import type { DiskIOReply } from "../../packages/types/diskIO/replies";
import type {
  AdDetectAgentConfig,
  AgentDeploymentConfig,
  BotConfig,
} from "../../packages/types/config";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly messages: DiskIOMessage[] = [];

  constructor(readonly url: string) {
    FakeWorker.instances.push(this);
  }

  unref(): void {}

  terminate(): void {}

  postMessage(message: DiskIOMessage): void {
    this.messages.push(message);
  }
}

const diskIO = await import("../../packages/infra/diskIO");
const { logger } = await import("../../packages/infra/logger");
const {
  adoptAdDetectAgentConfig,
  adoptAgentDeploymentConfig,
} = await import("../../packages/config/agent");
const {
  adDetectAgentConfigCache,
  agentDeploymentConfigCache,
  botConfigCache,
} = await import("../../packages/cache/perThread/config");
const { logRelaySink, loggerSecretsMemo } = await import("../../packages/cache/perThread/logger");

describe("logger persistence routing boundary", () => {
  // 脱敏名单会保留热重载替换下来的旧凭据；每条用例从空名单起步，不沿用前一条装进 holder 的替身值。
  beforeEach((): void => {
    loggerSecretsMemo.current = null;
  });

  test("初始化前只写控制台，完整恢复成功后达到或高于阈值的日志才转投唯一落盘 Worker", async () => {
    const originalWorker: typeof Worker = globalThis.Worker;
    const previousLogLevel: LogLevel = getLogLevel();
    globalThis.Worker = FakeWorker as unknown as typeof Worker;
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const consoleInfo = spyOn(console, "info").mockImplementation(() => {});
    adoptLogLevel("operation");
    try {
      logger.info("suppressed-before-threshold");
      expect(consoleInfo).not.toHaveBeenCalled();

      logger.error("before-lock");
      expect(consoleError).toHaveBeenCalledWith(CONSOLE_PREFIX_BY_LOG_LEVEL.error, "before-lock");
      expect(FakeWorker.instances).toHaveLength(0);

      diskIO.initDiskIO();
      const worker: FakeWorker = FakeWorker.instances[0]!;
      logger.operation("buffered-before-loaded");
      expect(consoleInfo).toHaveBeenCalledWith(CONSOLE_PREFIX_BY_LOG_LEVEL.operation, "buffered-before-loaded");
      expect(worker.messages).toHaveLength(0);

      const loaded = diskIO.loadPersistedData(1_000);
      expect(worker.messages).toEqual([expect.objectContaining({ type: "load" })]);
      worker.onmessage!({ data: {
        type: "loaded",
        wedMembers: new Map(),
        aiMemories: new Map(),
        stickerCatalogs: new Map(),
        luckDay: null,
        luckReceiptSecret: {
          version: 1,
          day: "2026-07-20",
          key: new Uint8Array(32).fill(1)
            .toBase64({ alphabet: "base64url", omitPadding: true }),
        },
        verifications: new Map(),
        pendingBlockedRemovals: new Map(),
        blocklistEntryCount: 0,
        permissionEntryCount: 0,
        chatStates: new Map(),
        chatQa: new Map(),
        adPackBlacklistCounts: { sticker: 0, emoji: 0 },
      } satisfies DiskIOReply } as unknown as MessageEvent<DiskIOReply>);
      await loaded;
      expect(worker.messages).toHaveLength(1);
      expect(diskIORuntime.diagnosticQueue.size).toBe(1);
      expect(diskIORuntime.diagnosticFlushTimer).not.toBeNull();
      worker.messages.length = 0;

      logger.error("after-lock", new Error("persist me"));
      expect(worker.messages).toHaveLength(1);
      const message: DiskIOMessage = worker.messages[0]!;
      expect(message.type).toBe("diagnosticBatch");
      const batch: DiskDiagnosticBatchRequest = message as DiskDiagnosticBatchRequest;
      expect(batch.messages).toHaveLength(2);
      const bufferedLog: LogEnvelope = batch.messages[0] as LogEnvelope;
      expect(bufferedLog.level).toBe("operation");
      expect(bufferedLog.args).toEqual(["buffered-before-loaded"]);
      const errorLog: LogEnvelope = batch.messages[1] as LogEnvelope;
      expect(errorLog.level).toBe("error");
      expect(errorLog.args[0]).toBe("after-lock");
      expect(errorLog.args[1]).toMatchObject({ name: "Error", message: "persist me" });
      expect(diskIORuntime.diagnosticFlushTimer).toBeNull();
      worker.onmessage!({
        data: { type: "diagnosticBatchAccepted", batchId: batch.batchId },
      } as MessageEvent<DiskIOReply>);
    } finally {
      adoptLogLevel(previousLogLevel);
      consoleInfo.mockRestore();
      consoleError.mockRestore();
      diskIORuntime.writable = false;
      await diskIO.terminateDiskIO();
      globalThis.Worker = originalWorker;
      FakeWorker.instances.length = 0;
    }
  });

  test("四个 log_level 阈值均先过滤再序列化，达到阈值按级别路由控制台并带 level 投递落盘", () => {
    const previousLogLevel: LogLevel = getLogLevel();
    const previousRelaySink: typeof logRelaySink.current = logRelaySink.current;
    const relayed: LogMessage[] = [];
    logRelaySink.current = (message: LogMessage): boolean => {
      relayed.push(message);
      return true;
    };
    const consoleSpies = {
      info: spyOn(console, "info").mockImplementation(() => {}),
      warn: spyOn(console, "warn").mockImplementation(() => {}),
      error: spyOn(console, "error").mockImplementation(() => {}),
    };
    try {
      for (const threshold of LOG_LEVELS) {
        adoptLogLevel(threshold);
        for (const level of LOG_LEVELS) {
          consoleSpies.info.mockClear();
          consoleSpies.warn.mockClear();
          consoleSpies.error.mockClear();
          relayed.length = 0;

          let evaluated: boolean = false;
          const probe: { readonly value: string } = {
            get value(): string {
              evaluated = true;
              return `payload-${level}`;
            },
          };
          logger[level](`msg-${threshold}-${level}`, probe);

          const enabled: boolean = LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[threshold];
          expect(evaluated).toBe(enabled);
          if (!enabled) {
            expect(consoleSpies.info).not.toHaveBeenCalled();
            expect(consoleSpies.warn).not.toHaveBeenCalled();
            expect(consoleSpies.error).not.toHaveBeenCalled();
            expect(relayed).toHaveLength(0);
            continue;
          }

          const targetMethod: "info" | "warn" | "error" = CONSOLE_METHOD_BY_LOG_LEVEL[level];
          for (const method of ["info", "warn", "error"] as const) {
            if (method === targetMethod) {
              expect(consoleSpies[method]).toHaveBeenCalledTimes(1);
              expect(consoleSpies[method]).toHaveBeenCalledWith(
                CONSOLE_PREFIX_BY_LOG_LEVEL[level],
                `msg-${threshold}-${level}`,
                { value: `payload-${level}` }
              );
            } else {
              expect(consoleSpies[method]).not.toHaveBeenCalled();
            }
          }
          expect(relayed).toHaveLength(1);
          expect(relayed[0]?.level).toBe(level);
          expect(relayed[0]?.args).toEqual([`msg-${threshold}-${level}`, { value: `payload-${level}` }]);
        }
      }
    } finally {
      adoptLogLevel(previousLogLevel);
      logRelaySink.current = previousRelaySink;
      consoleSpies.info.mockRestore();
      consoleSpies.warn.mockRestore();
      consoleSpies.error.mockRestore();
    }
  });

  test("字符串参数与 Error 可枚举字段里的敏感值都被脱敏后才进控制台与落盘", () => {
    const originalTelegram: BotConfig | null = botConfigCache.current;
    const token: string = "logger-telegram-token";
    botConfigCache.current = {
      timeZone: getTimeZone(),
      atmosphere: "mesugaki",
      logLevel: "operation",
      botToken: token,
      superAdminUserId: 1,
    };
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      // 字符串走的是不经 JSON 往返的快路径；对象/Error 仍走序列化后整份脱敏。
      logger.error(`download failed: https://api.telegram.org/file/bot${token}/photo.jpg`);
      expect(consoleError.mock.calls.at(-1)![0]).toBe(CONSOLE_PREFIX_BY_LOG_LEVEL.error);
      const stringArg: unknown = consoleError.mock.calls.at(-1)![1];
      expect(stringArg).toBe("download failed: https://api.telegram.org/file/bot[REDACTED]/photo.jpg");
      expect(String(stringArg)).not.toContain(token);

      const failure = Object.assign(new Error("fetch failed"), {
        path: `https://api.telegram.org/file/bot${token}/photo.jpg`,
      });
      logger.error("boom", failure);
      expect(consoleError.mock.calls.at(-1)![0]).toBe(CONSOLE_PREFIX_BY_LOG_LEVEL.error);
      const errorArg = consoleError.mock.calls.at(-1)![2] as { path: string; message: string };
      expect(errorArg.message).toBe("fetch failed");
      expect(errorArg.path).toBe("https://api.telegram.org/file/bot[REDACTED]/photo.jpg");
      expect(JSON.stringify(errorArg)).not.toContain(token);
    } finally {
      consoleError.mockRestore();
      botConfigCache.current = originalTelegram;
    }
  });

  /**
   * 脱敏值列表按三个 holder 的对象身份记忆化（见 cache/perThread/logger.ts 的 loggerSecretsMemo）。
   * 三个 holder 都是惰性填充的：取得实例锁之前经过的日志算出的空结果不按「已经算过一次」缓存，
   * 配置读完之后每条日志照常脱敏。
   */
  test("配置在第一条日志之后才填上时，后续日志照常脱敏（记忆化不得把空结果钉死）", () => {
    const originalTelegram: BotConfig | null = botConfigCache.current;
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      botConfigCache.current = null;
      logger.error("no-config-yet");
      expect(consoleError.mock.calls.at(-1)![0]).toBe(CONSOLE_PREFIX_BY_LOG_LEVEL.error);
      expect(consoleError.mock.calls.at(-1)![1]).toBe("no-config-yet");

      const token: string = "late-arriving-telegram-token";
      botConfigCache.current = {
        timeZone: getTimeZone(),
        atmosphere: "mesugaki",
        logLevel: "operation",
        botToken: token,
        superAdminUserId: 1,
      };
      logger.error(`now with token ${token}`);
      const stringArg: unknown = consoleError.mock.calls.at(-1)![1];
      expect(stringArg).toBe(`now with token ${REDACTED_SECRET}`);
      expect(String(stringArg)).not.toContain(token);

      // 换成另一份配置同样要立刻生效（测试替身、启动总闸与热重载都是整体替换 holder）。
      const rotated: string = "rotated-telegram-token";
      botConfigCache.current = {
        timeZone: getTimeZone(),
        atmosphere: "mesugaki",
        logLevel: "operation",
        botToken: rotated,
        superAdminUserId: 1,
      };
      logger.error(`rotated ${rotated} but old ${token}`);
      const afterRotate: string = String(consoleError.mock.calls.at(-1)![1]);
      expect(afterRotate).not.toContain(rotated);
      // 旧凭据可能还在旧客户端的在途请求里，退役后照样脱敏。
      expect(afterRotate).not.toContain(token);
    } finally {
      consoleError.mockRestore();
      botConfigCache.current = originalTelegram;
    }
  });

  test("退役凭据按先进先出封顶保留，超出上限时最早退役的不再脱敏", () => {
    const originalTelegram: BotConfig | null = botConfigCache.current;
    const originalAgent: AgentDeploymentConfig | null = agentDeploymentConfigCache.current;
    const originalAdDetect: AdDetectAgentConfig | null = adDetectAgentConfigCache.current;
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      // 只留 Telegram 一份当前凭据，名单容量全部留给退役值。
      agentDeploymentConfigCache.current = null;
      adDetectAgentConfigCache.current = null;
      const tokens: string[] = [];
      for (let index: number = 0; index <= LOGGER_MAX_REDACTED_SECRETS; index++) {
        const token: string = `retired-telegram-token-${String(index).padStart(3, "0")}`;
        tokens.push(token);
        botConfigCache.current = {
          timeZone: getTimeZone(),
          atmosphere: "mesugaki",
          logLevel: "operation",
          botToken: token,
          superAdminUserId: 1,
        };
        logger.error("rotate");
      }
      logger.error(tokens.join(" "));
      const output: string = String(consoleError.mock.calls.at(-1)![1]);
      // 当前 1 个加最近退役的 LOGGER_MAX_REDACTED_SECRETS - 1 个仍在名单里。
      expect(output).toContain(tokens[0]!);
      for (const token of tokens.slice(1)) expect(output).not.toContain(token);
    } finally {
      consoleError.mockRestore();
      botConfigCache.current = originalTelegram;
      agentDeploymentConfigCache.current = originalAgent;
      adDetectAgentConfigCache.current = originalAdDetect;
    }
  });

  test("telegram 与 agent 配置中实际使用的密钥都会脱敏", () => {
    const originalTelegram: BotConfig | null = botConfigCache.current;
    const originalAgent: AgentDeploymentConfig | null = agentDeploymentConfigCache.current;
    const originalAdDetect: AdDetectAgentConfig | null = adDetectAgentConfigCache.current;
    const normalizedSecrets: readonly [string, string, string] = [
      "normalized-telegram-token",
      "normalized-gemini-key",
      "normalized-deepseek-key",
    ];
    botConfigCache.current = {
      timeZone: getTimeZone(),
      atmosphere: "mesugaki",
      logLevel: "operation",
      botToken: normalizedSecrets[0],
      superAdminUserId: 1,
    };
    agentDeploymentConfigCache.current = {
      text: { provider: "google", apiKey: normalizedSecrets[1], baseUrl: undefined, model: "text" },
      summary: { provider: "openai", apiKey: "summary-key", baseUrl: undefined, model: "summary" },
      media: { provider: "google", apiKey: "media-key", baseUrl: undefined, model: "media" },
    };
    adDetectAgentConfigCache.current = {
      provider: "openai",
      apiKey: normalizedSecrets[2],
      baseUrl: "https://api.deepseek.com",
      model: "ad",
    };
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      logger.error(
        `request failed: ${normalizedSecrets.join(" / ")}`,
        Object.assign(new Error("fetch failed"), {
          path: `https://api.telegram.org/file/bot${normalizedSecrets[0]}/photo.jpg`,
          details: { apiKey: normalizedSecrets[1], cause: normalizedSecrets[2] },
        })
      );

      const stringArg: unknown = consoleError.mock.calls.at(-1)![1];
      const errorArg: unknown = consoleError.mock.calls.at(-1)![2];
      expect(stringArg).toBe("request failed: [REDACTED] / [REDACTED] / [REDACTED]");
      expect(errorArg).toMatchObject({
        path: "https://api.telegram.org/file/bot[REDACTED]/photo.jpg",
        details: { apiKey: REDACTED_SECRET, cause: REDACTED_SECRET },
      });
      const serialized: string = JSON.stringify([stringArg, errorArg]);
      for (const secret of normalizedSecrets) expect(serialized).not.toContain(secret);
    } finally {
      consoleError.mockRestore();
      botConfigCache.current = originalTelegram;
      agentDeploymentConfigCache.current = originalAgent;
      adDetectAgentConfigCache.current = originalAdDetect;
    }
  });

  test("Worker 侧 adopt 进来的快照同样进脱敏名单", () => {
    // 两条业务线程不读盘，凭据只经初始化消息 adopt 进本 isolate 的 holder（见 config/agent.ts）；
    // 脱敏名单读这两个 holder，与主线程解析那条等价。
    const originalAgent: AgentDeploymentConfig | null = agentDeploymentConfigCache.current;
    const originalAdDetect: AdDetectAgentConfig | null = adDetectAgentConfigCache.current;
    const workerSecrets: readonly string[] = [
      "adopted-text-key",
      "adopted-summary-key",
      "adopted-media-key",
      "adopted-image-key",
      "adopted-tts-key",
      "adopted-ad-key",
    ];
    adoptAgentDeploymentConfig({
      text: { provider: "google", apiKey: "adopted-text-key", baseUrl: undefined, model: "text" },
      summary: { provider: "openai", apiKey: "adopted-summary-key", baseUrl: undefined, model: "summary" },
      media: { provider: "google", apiKey: "adopted-media-key", baseUrl: undefined, model: "media" },
      image: { provider: "google", apiKey: "adopted-image-key", baseUrl: undefined, model: "image", imageProtocol: undefined, maxReferenceImages: 1 },
      tts: { provider: "google", apiKey: "adopted-tts-key", baseUrl: undefined, model: "tts", voice: "Leda", speechProtocol: undefined, style: TTS_DEFAULT_STYLE, language: undefined, botLanguage: TTS_DEFAULT_BOT_LANGUAGE, dailyLimit: 100, dailyReserveQuota: 25 },
    });
    adoptAdDetectAgentConfig({
      provider: "openai",
      apiKey: "adopted-ad-key",
      baseUrl: "https://api.deepseek.com",
      model: "ad",
    });
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      logger.error(
        `worker request failed: ${workerSecrets.join(" / ")}`,
        Object.assign(new Error("upstream rejected"), {
          headers: { authorization: `Bearer ${workerSecrets[0]}` },
          query: `key=${workerSecrets[5]}`,
        })
      );
      const serialized: string = JSON.stringify(consoleError.mock.calls.at(-1));
      for (const secret of workerSecrets) expect(serialized).not.toContain(secret);
    } finally {
      consoleError.mockRestore();
      agentDeploymentConfigCache.current = originalAgent;
      adDetectAgentConfigCache.current = originalAdDetect;
    }
  });

  test("SDK 错误对象里的凭据响应头按字段脱敏，非敏感诊断保持可读", () => {
    const cloudflareCookie: string = "__cf_bm=cloudflare-sensitive-cookie; HttpOnly; Secure";
    const bearer: string = "Bearer upstream-sensitive-token";
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const failure = Object.assign(new Error("xAI request failed"), {
        headers: {
          "set-cookie": [cloudflareCookie],
          Authorization: bearer,
          "x-request-id": "request-visible-123",
        },
        rawHeaders: [
          ["Set-Cookie", cloudflareCookie],
          ["x-ratelimit-remaining", "42"],
        ],
        usage: { output_tokens: 17 },
      });

      logger.error("image request failed", failure);

      const serialized: unknown = consoleError.mock.calls.at(-1)![2];
      expect(serialized).toMatchObject({
        message: "xAI request failed",
        headers: {
          "set-cookie": REDACTED_SECRET,
          Authorization: REDACTED_SECRET,
          "x-request-id": "request-visible-123",
        },
        rawHeaders: [
          ["Set-Cookie", REDACTED_SECRET],
          ["x-ratelimit-remaining", "42"],
        ],
        usage: { output_tokens: 17 },
      });
      const text: string = JSON.stringify(serialized);
      expect(text).not.toContain(cloudflareCookie);
      expect(text).not.toContain(bearer);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("字符串化响应头与扁平 rawHeaders 同样脱敏，并保留非凭据诊断", () => {
    const cloudflareCookie: string =
      "__cf_bm=string-or-flat-sensitive-cookie; Expires=Thu, 06 Aug 2099 16:57:18 GMT; HttpOnly";
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      logger.error(
        `upstream failed: {"set-cookie":["${cloudflareCookie}"],` +
        `"x-request-id":"request-visible-456","x-ratelimit-remaining":"40","output_tokens":18}`
      );
      const textArg: string = String(consoleError.mock.calls.at(-1)![1]);
      expect(textArg).not.toContain(cloudflareCookie);
      expect(textArg).toContain(REDACTED_SECRET);
      expect(textArg).toContain("request-visible-456");
      expect(textArg).toContain("\"x-ratelimit-remaining\":\"40\"");
      expect(textArg).toContain("\"output_tokens\":18");

      const failure = Object.assign(
        new Error(
          `upstream failed: {"set-cookie":["${cloudflareCookie}"],` +
          `"x-request-id":"request-visible-789"}`
        ),
        {
          rawHeaders: [
            "x-request-id",
            "request-visible-789",
            "Set-Cookie",
            cloudflareCookie,
            "x-ratelimit-remaining",
            "41",
          ],
          usage: { output_tokens: 19 },
        }
      );
      logger.error("image request failed", failure);

      const serialized: unknown = consoleError.mock.calls.at(-1)![2];
      const message: string = (serialized as { message: string }).message;
      expect(message.includes("request-visible-789")).toBeTrue();
      expect(serialized).toMatchObject({
        message: expect.stringContaining(REDACTED_SECRET),
        rawHeaders: [
          "x-request-id",
          "request-visible-789",
          "Set-Cookie",
          REDACTED_SECRET,
          "x-ratelimit-remaining",
          "41",
        ],
        usage: { output_tokens: 19 },
      });
      const serializedText: string = JSON.stringify(serialized);
      expect(serializedText).not.toContain(cloudflareCookie);
      expect(serializedText).toContain("request-visible-789");
    } finally {
      consoleError.mockRestore();
    }
  });

  test("Error 自带 __proto__ 自有属性时照常落进诊断字段，不命中原型访问器", () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      // 依赖抛出的 Error 可能带 __proto__ 自有属性（grammY/genai/gRPC 包装的 payload）；
      // 该字段进入诊断字段，不命中 Object.prototype 继承来的访问器，记录的原型不变。
      const error: Error = new Error("dependency blew up");
      Object.defineProperty(error, "__proto__", {
        value: { hint: "from dependency" },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      logger.error("boom", error);

      const serialized: unknown = consoleError.mock.calls.at(-1)![2];
      expect(serialized).toMatchObject({
        message: "dependency blew up",
        ["__proto__"]: { hint: "from dependency" },
      });
      // 原型没有被换掉：记录仍是普通对象。
      expect(Object.getPrototypeOf(serialized as object)).toBe(Object.prototype);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("cause、AggregateError.errors 与值为 Error 的字段递归展开，嵌套层同样脱敏", () => {
    const originalTelegram: BotConfig | null = botConfigCache.current;
    const token: string = "nested-cause-telegram-token";
    botConfigCache.current = {
      timeZone: getTimeZone(),
      atmosphere: "mesugaki",
      logLevel: "operation",
      botToken: token,
      superAdminUserId: 1,
    };
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const fetchFailure = Object.assign(new TypeError("fetch failed"), {
        path: `https://api.telegram.org/file/bot${token}/photo.jpg`,
        headers: { authorization: "Bearer nested-upstream-bearer" },
      });
      const wrapped: Error = new Error("download wrapper", { cause: fetchFailure });
      const httpLike = Object.assign(new Error("Network request failed"), { error: wrapped });
      const departure: AggregateError = new AggregateError(
        [httpLike, "plain reason"],
        "Failed to complete departure"
      );

      logger.error("teardown failed", departure);

      const serialized: unknown = consoleError.mock.calls.at(-1)![2];
      expect(serialized).toMatchObject({
        name: "AggregateError",
        message: "Failed to complete departure",
        errors: [
          {
            name: "Error",
            message: "Network request failed",
            error: {
              name: "Error",
              message: "download wrapper",
              cause: {
                name: "TypeError",
                message: "fetch failed",
                path: `https://api.telegram.org/file/bot${REDACTED_SECRET}/photo.jpg`,
                headers: { authorization: REDACTED_SECRET },
              },
            },
          },
          "plain reason",
        ],
      });
      const text: string = JSON.stringify(serialized);
      expect(text).not.toContain(token);
      expect(text).not.toContain("nested-upstream-bearer");
    } finally {
      consoleError.mockRestore();
      botConfigCache.current = originalTelegram;
    }
  });

  test("嵌套 Error 有深度上限、循环引用只输出占位符，且不执行嵌套 getter", () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const looping: Error = new Error("self loop");
      const middle: Error = new Error("middle", { cause: looping });
      Object.defineProperty(looping, "cause", {
        value: middle,
        enumerable: false,
        writable: true,
        configurable: true,
      });
      let getterCalls: number = 0;
      Object.defineProperty(middle, "response", {
        enumerable: true,
        get(): unknown {
          getterCalls++;
          return new Error("from getter");
        },
      });
      expect((): void => logger.error(looping)).not.toThrow();
      expect(consoleError.mock.calls.at(-1)![1]).toMatchObject({
        message: "self loop",
        cause: {
          message: "middle",
          cause: LOGGER_CIRCULAR_ERROR_VALUE,
          response: LOGGER_UNSERIALIZABLE_VALUE,
        },
      });
      expect(getterCalls).toBe(0);

      let deepest: Error = new Error("level 0");
      for (let level: number = 1; level <= LOGGER_NESTED_ERROR_MAX_DEPTH + 1; level++) {
        deepest = new Error(`level ${level}`, { cause: deepest });
      }
      logger.error(deepest);
      let record: unknown = consoleError.mock.calls.at(-1)![1];
      for (let level: number = 0; level < LOGGER_NESTED_ERROR_MAX_DEPTH; level++) {
        expect(record).toMatchObject({ message: `level ${LOGGER_NESTED_ERROR_MAX_DEPTH + 1 - level}` });
        record = (record as { cause: unknown }).cause;
      }
      expect(record).toMatchObject({
        message: "level 1",
        cause: LOGGER_NESTED_ERROR_DEPTH_EXCEEDED_VALUE,
      });

      // 无嵌套的普通 Error 输出形态不变：不凭空多出 cause/errors 字段。
      logger.error(new Error("plain"));
      expect(Object.keys(consoleError.mock.calls.at(-1)![1] as object)).toEqual(["name", "message", "stack"]);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("密钥恰好是 JSON 结构字符时，脱敏后解析不了也不能让 logger 自己抛出去", () => {
    const originalConfig: AdDetectAgentConfig | null = adDetectAgentConfigCache.current;
    // 逗号既可作为非空凭据值，也参与 JSON 结构；整份文本脱敏后允许退化为字符串。
    adDetectAgentConfigCache.current = {
      provider: "openai",
      apiKey: ",",
      baseUrl: "https://api.deepseek.com",
      model: "ad",
    };
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      // logger 内部不向上抛 SyntaxError，原始错误照常落盘。
      expect((): void => logger.error("boom", new Error("fetch failed"))).not.toThrow();
      const fallback: unknown = consoleError.mock.calls.at(-1)![2];
      // 解析不了就退化成脱敏后的文本，敏感值仍然不得出现。
      expect(typeof fallback).toBe("string");
      expect(String(fallback)).toContain("fetch failed");
      expect(String(fallback)).toContain(REDACTED_SECRET);
    } finally {
      consoleError.mockRestore();
      adDetectAgentConfigCache.current = originalConfig;
    }
  });

  test("异常对象的 getter、转换方法与 Proxy trap 只能降级内容，不能让 logger 抛错", () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const hostileObject: object = {
        toJSON(): never {
          throw new Error("toJSON failed");
        },
        toString(): never {
          throw new Error("toString failed");
        },
      };
      expect((): void => logger.error(hostileObject)).not.toThrow();
      expect(consoleError.mock.calls.at(-1)![1]).toBe(LOGGER_UNSERIALIZABLE_VALUE);

      const hostileError: Error = new Error("original failure");
      Object.defineProperty(hostileError, "name", {
        enumerable: false,
        get(): never {
          throw new Error("name getter failed");
        },
      });
      Object.defineProperty(hostileError, "response", {
        enumerable: true,
        get(): never {
          throw new Error("response getter failed");
        },
      });
      expect((): void => logger.error(hostileError)).not.toThrow();
      expect(consoleError.mock.calls.at(-1)![1]).toMatchObject({
        name: "Error",
        message: "original failure",
        response: LOGGER_UNSERIALIZABLE_VALUE,
      });

      const proxiedError: Error = new Proxy(new Error("proxied failure"), {
        ownKeys(): never {
          throw new Error("ownKeys failed");
        },
      });
      expect((): void => logger.error(proxiedError)).not.toThrow();
      expect(consoleError.mock.calls.at(-1)![1]).toMatchObject({
        name: "Error",
        message: "proxied failure",
      });

      const revoked: { proxy: object; revoke: () => void } = Proxy.revocable({}, {});
      revoked.revoke();
      expect((): void => logger.error(revoked.proxy)).not.toThrow();
      expect(consoleError.mock.calls.at(-1)![1]).toBe(LOGGER_UNSERIALIZABLE_VALUE);
    } finally {
      consoleError.mockRestore();
    }
  });
});

async function startWritableLogDiskIO(level: LogLevel): Promise<{
  readonly worker: FakeDiskIOWorker;
  readonly previousLogLevel: LogLevel;
  readonly restoreWorker: () => void;
}> {
  const restoreWorker: () => void = installFakeDiskIOWorker();
  const previousLogLevel: LogLevel = getLogLevel();
  adoptLogLevel(level);
  diskIO.initDiskIO();
  const worker: FakeDiskIOWorker = FakeDiskIOWorker.instances[0]!;
  const loaded: Promise<unknown> = diskIO.loadPersistedData(1_000);
  emitSuccessfulDiskIOLoad(worker);
  await loaded;
  worker.messages.length = 0;
  return { worker, previousLogLevel, restoreWorker };
}

async function stopWritableLogDiskIO(
  previousLogLevel: LogLevel,
  restoreWorker: () => void
): Promise<void> {
  adoptLogLevel(previousLogLevel);
  await diskIO.terminateDiskIO();
  restoreWorker();
}

describe("main-thread log buffering", () => {
  afterEach((): void => {
    jest.useRealTimers();
  });

  test("普通级别日志在主线程缓冲，到达 FLUSH_INTERVAL_MS 时整批落盘且不因后续普通日志重置计时", async () => {
    jest.useFakeTimers();
    const consoleInfo = spyOn(console, "info").mockImplementation(() => {});
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
    const { worker, previousLogLevel, restoreWorker } = await startWritableLogDiskIO("info");
    try {
      logger.info("info-1");
      logger.operation("op-2");
      logger.warn("warn-3");
      expect(worker.messages).toHaveLength(0);
      expect(diskIORuntime.diagnosticQueue.size).toBe(3);
      expect(diskIORuntime.diagnosticFlushTimer).not.toBeNull();

      jest.advanceTimersByTime(FLUSH_INTERVAL_MS - 1);
      logger.operation("op-4");
      expect(worker.messages).toHaveLength(0);
      expect(diskIORuntime.diagnosticQueue.size).toBe(4);

      jest.advanceTimersByTime(1);
      expect(worker.messages).toHaveLength(1);
      const batch = worker.messages[0] as DiskDiagnosticBatchRequest;
      expect(batch.type).toBe("diagnosticBatch");
      expect(batch.messages.map((entry) => (entry as LogEnvelope).args[0])).toEqual([
        "info-1",
        "op-2",
        "warn-3",
        "op-4",
      ]);
      expect(diskIORuntime.diagnosticFlushTimer).toBeNull();

      worker.onmessage!({
        data: { type: "diagnosticBatchAccepted", batchId: batch.batchId },
      } as MessageEvent<DiskIOReply>);
      expect(diskIORuntime.diagnosticQueue.size).toBe(0);
      expect(diskIORuntime.diagnosticFlushPendingCount).toBe(0);
    } finally {
      consoleInfo.mockRestore();
      consoleWarn.mockRestore();
      await stopWritableLogDiskIO(previousLogLevel, restoreWorker);
    }
  });

  test("普通级别日志攒满 DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES 立即成批发送，且在途小批不触发提前整批冲刷", async () => {
    jest.useFakeTimers();
    const consoleInfo = spyOn(console, "info").mockImplementation(() => {});
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const { worker, previousLogLevel, restoreWorker } = await startWritableLogDiskIO("operation");
    try {
      for (let i = 0; i < DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES - 1; i += 1) {
        logger.operation(`fill-${i}`);
      }
      expect(worker.messages).toHaveLength(0);
      expect(diskIORuntime.diagnosticFlushTimer).not.toBeNull();

      logger.operation(`fill-${DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES - 1}`);
      expect(worker.messages).toHaveLength(1);
      const firstBatch = worker.messages[0] as DiskDiagnosticBatchRequest;
      expect(firstBatch.messages).toHaveLength(DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES);
      expect(diskIORuntime.diagnosticFlushTimer).toBeNull();
      worker.onmessage!({
        data: { type: "diagnosticBatchAccepted", batchId: firstBatch.batchId },
      } as MessageEvent<DiskIOReply>);
      worker.messages.length = 0;

      // 在途 1 条 error 时队列又堆积 MAX-1 条 operation：即使队列总长度达到 MAX，ACK 后仍继续等待凑满整批或超时。
      logger.error("in-flight-error");
      expect(worker.messages).toHaveLength(1);
      const errorBatch = worker.messages[0] as DiskDiagnosticBatchRequest;
      worker.messages.length = 0;

      for (let i = 0; i < DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES - 1; i += 1) {
        logger.operation(`pending-after-error-${i}`);
      }
      expect(worker.messages).toHaveLength(0);
      expect(diskIORuntime.diagnosticQueue.size).toBe(DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES);

      worker.onmessage!({
        data: { type: "diagnosticBatchAccepted", batchId: errorBatch.batchId },
      } as MessageEvent<DiskIOReply>);
      expect(worker.messages).toHaveLength(0);
      expect(diskIORuntime.diagnosticQueue.size).toBe(DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES - 1);
      expect(diskIORuntime.diagnosticFlushTimer).not.toBeNull();

      logger.operation("complete-second-full-batch");
      expect(worker.messages).toHaveLength(1);
      const secondBatch = worker.messages[0] as DiskDiagnosticBatchRequest;
      expect(secondBatch.messages).toHaveLength(DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES);
      worker.onmessage!({
        data: { type: "diagnosticBatchAccepted", batchId: secondBatch.batchId },
      } as MessageEvent<DiskIOReply>);
      expect(diskIORuntime.diagnosticFlushTimer).toBeNull();
    } finally {
      consoleInfo.mockRestore();
      consoleError.mockRestore();
      await stopWritableLogDiskIO(previousLogLevel, restoreWorker);
    }
  });

  test("非日志诊断、flushDiskIO 与 flushDiskIODomain(\"log\") 会立即排空主线程缓冲日志", async () => {
    jest.useFakeTimers();
    const consoleInfo = spyOn(console, "info").mockImplementation(() => {});
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});
    const { worker, previousLogLevel, restoreWorker } = await startWritableLogDiskIO("info");
    try {
      logger.operation("before-ad-sample");
      expect(worker.messages).toHaveLength(0);
      expect(diskIO.postDiskIODiagnostic({
        type: "adSample",
        chatId: -100,
        senderId: 42,
        label: "tester",
        detectedAt: "2026/07/20 12:00:00",
        reason: "spam",
        messages: [],
      })).toBe(true);
      expect(worker.messages).toHaveLength(1);
      const sampleBatch = worker.messages[0] as DiskDiagnosticBatchRequest;
      expect(sampleBatch.messages.map((entry) => entry.type)).toEqual(["log", "adSample"]);
      worker.onmessage!({
        data: { type: "diagnosticBatchAccepted", batchId: sampleBatch.batchId },
      } as MessageEvent<DiskIOReply>);
      worker.messages.length = 0;

      logger.warn("before-flush-all");
      expect(worker.messages).toHaveLength(0);
      const flushAllPromise: Promise<unknown> = diskIO.flushDiskIO(1_000);
      expect(worker.messages).toHaveLength(1);
      const flushAllLogBatch = worker.messages[0] as DiskDiagnosticBatchRequest;
      expect((flushAllLogBatch.messages[0] as LogEnvelope).args).toEqual(["before-flush-all"]);
      worker.onmessage!({
        data: { type: "diagnosticBatchAccepted", batchId: flushAllLogBatch.batchId },
      } as MessageEvent<DiskIOReply>);
      await Promise.resolve();
      await Promise.resolve();
      const flushAllReq = worker.messages[1] as Extract<DiskIOMessage, { type: "flush" }>;
      expect(flushAllReq.type).toBe("flush");
      expect(flushAllReq.scope).toBe("all");
      worker.onmessage!({
        data: { type: "flushed", flushedId: flushAllReq.flushId } satisfies DiskIOReply,
      } as unknown as MessageEvent<DiskIOReply>);
      await expect(flushAllPromise).resolves.toBe("flushed");
      worker.messages.length = 0;

      logger.operation("before-flush-log-domain");
      expect(worker.messages).toHaveLength(0);
      const flushDomainPromise: Promise<unknown> = diskIO.flushDiskIODomain("log", 1_000);
      expect(worker.messages).toHaveLength(1);
      const domainLogBatch = worker.messages[0] as DiskDiagnosticBatchRequest;
      expect((domainLogBatch.messages[0] as LogEnvelope).args).toEqual(["before-flush-log-domain"]);
      worker.onmessage!({
        data: { type: "diagnosticBatchAccepted", batchId: domainLogBatch.batchId },
      } as MessageEvent<DiskIOReply>);
      await Promise.resolve();
      await Promise.resolve();
      const flushDomainReq = worker.messages[1] as Extract<DiskIOMessage, { type: "flush" }>;
      expect(flushDomainReq.type).toBe("flush");
      expect(flushDomainReq.scope).toBe("log");
      worker.onmessage!({
        data: { type: "flushed", flushedId: flushDomainReq.flushId } satisfies DiskIOReply,
      } as unknown as MessageEvent<DiskIOReply>);
      await expect(flushDomainPromise).resolves.toEqual({ result: "flushed" });
    } finally {
      consoleInfo.mockRestore();
      consoleWarn.mockRestore();
      await stopWritableLogDiskIO(previousLogLevel, restoreWorker);
    }
  });

  test("Worker 代际切换保持未满窗缓冲继续等待，但在途未确认批次在恢复后立即重投", async () => {
    jest.useFakeTimers();
    const consoleInfo = spyOn(console, "info").mockImplementation(() => {});
    const { worker, previousLogLevel, restoreWorker } = await startWritableLogDiskIO("operation");
    try {
      logger.operation("survives-generation-pause");
      expect(worker.messages).toHaveLength(0);
      expect(diskIORuntime.diagnosticFlushTimer).not.toBeNull();

      pauseDiskIODiagnosticChannel();
      expect(diskIORuntime.diagnosticFlushTimer).not.toBeNull();
      expect(diskIORuntime.diagnosticFlushPendingCount).toBe(0);

      resumeDiskIODiagnosticChannel(worker as unknown as Worker);
      expect(worker.messages).toHaveLength(0);

      jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
      expect(worker.messages).toHaveLength(1);
      const firstDelivery = worker.messages[0] as DiskDiagnosticBatchRequest;
      expect((firstDelivery.messages[0] as LogEnvelope).args).toEqual(["survives-generation-pause"]);

      pauseDiskIODiagnosticChannel();
      resumeDiskIODiagnosticChannel(worker as unknown as Worker);
      expect(worker.messages).toHaveLength(2);
      const redelivery = worker.messages[1] as DiskDiagnosticBatchRequest;
      expect(redelivery.batchId).toBe(firstDelivery.batchId);
      worker.onmessage!({
        data: { type: "diagnosticBatchAccepted", batchId: redelivery.batchId },
      } as MessageEvent<DiskIOReply>);
      expect(diskIORuntime.diagnosticQueue.size).toBe(0);
    } finally {
      consoleInfo.mockRestore();
      await stopWritableLogDiskIO(previousLogLevel, restoreWorker);
    }
  });
});

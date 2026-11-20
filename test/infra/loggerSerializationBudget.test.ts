import { describe, expect, test } from "bun:test";
import {
  adDetectAgentConfigCache,
  agentDeploymentConfigCache,
  botConfigCache,
} from "../../packages/cache/perThread/config";
import { loggerSecretsMemo } from "../../packages/cache/perThread/logger";
import { parseAdDetectAgentConfig, parseAgentDeploymentConfig } from "../../packages/config/agent";
import { serializeLogArgs } from "../../packages/infra/logger/serialization";
import {
  LOGGER_CIRCULAR_ERROR_VALUE,
  LOGGER_MAX_ERROR_NODES,
  LOGGER_MAX_REDACTED_SECRETS,
  LOGGER_MAX_SERIALIZED_BYTES,
  LOGGER_MAX_SERIALIZED_ITEMS,
  LOGGER_NESTED_ERROR_DEPTH_EXCEEDED_VALUE,
  LOGGER_NESTED_ERROR_MAX_DEPTH,
  LOGGER_SERIALIZATION_LIMIT_VALUE,
  LOGGER_UNSERIALIZABLE_VALUE,
} from "../../packages/consts/logger";
import { REDACTED_SECRET } from "../../packages/consts/redaction";
import type { AdDetectAgentConfig, AgentDeploymentConfig, BotConfig } from "../../packages/types/config";
import type { LoggerSecretsSnapshot } from "../../packages/types/logger";

test("多个参数与重复引用的 AggregateError 共用展开预算", () => {
  let error: Error = new Error("leaf");
  error.stack = "leaf";
  for (let depth: number = 0; depth < 5; depth++) {
    error = new AggregateError(Array<Error>(6).fill(error), "nested");
    error.stack = "nested";
  }
  const text: string = JSON.stringify(serializeLogArgs([error, error]));
  expect([...text.matchAll(/"name":/g)].length).toBeLessThanOrEqual(LOGGER_MAX_ERROR_NODES);
  expect(text).toContain(LOGGER_SERIALIZATION_LIMIT_VALUE);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(LOGGER_MAX_SERIALIZED_BYTES);
});

test("宽数组与大量参数只读取预算内的条目", () => {
  const elements: unknown[] = new Array<unknown>(LOGGER_MAX_SERIALIZED_ITEMS * 100);
  Object.defineProperty(elements, LOGGER_MAX_SERIALIZED_ITEMS + 1, {
    get: (): never => { throw new Error("must not read past budget"); },
  });
  const error: AggregateError = new AggregateError([], "wide");
  Object.defineProperty(error, "errors", { value: elements });
  const [serialized] = serializeLogArgs([error]) as { errors: unknown[] }[];
  expect(serialized!.errors.length).toBeLessThanOrEqual(LOGGER_MAX_SERIALIZED_ITEMS + 1);
  expect(serialized!.errors.at(-1)).toBe(LOGGER_SERIALIZATION_LIMIT_VALUE);
  const args: unknown[] = serializeLogArgs(Array<string>(1_000).fill("argument"));
  expect(args).toHaveLength(LOGGER_MAX_SERIALIZED_ITEMS + 1);
  expect(args.at(-1)).toBe(LOGGER_SERIALIZATION_LIMIT_VALUE);
});

test("输出预算覆盖多字节文本、JSON 转义与多个参数，截断使用静态标记", () => {
  const values: readonly unknown[][] = [
    ["保留", "\u0000".repeat(LOGGER_MAX_SERIALIZED_BYTES)],
    [new Error("界".repeat(LOGGER_MAX_SERIALIZED_BYTES))],
    Array<string>(256).fill("界".repeat(1_000)),
  ];
  for (const args of values) {
    const result: unknown[] = serializeLogArgs(args);
    expect(result).toContain(LOGGER_SERIALIZATION_LIMIT_VALUE);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(LOGGER_MAX_SERIALIZED_BYTES);
  }
});

/** 临时覆盖本线程日志脱敏配置快照，并在回调结束后原样还原。 */
function withThreadSecretCaches(
  overrides: {
    readonly bot?: BotConfig | null;
    readonly adDetect?: AdDetectAgentConfig | null;
    readonly agent?: AgentDeploymentConfig | null;
  },
  run: () => void
): void {
  const prevBot: BotConfig | null = botConfigCache.current;
  const prevAdDetect: AdDetectAgentConfig | null = adDetectAgentConfigCache.current;
  const prevAgent: AgentDeploymentConfig | null = agentDeploymentConfigCache.current;
  const prevMemo: LoggerSecretsSnapshot | null = loggerSecretsMemo.current;
  try {
    loggerSecretsMemo.current = null;
    botConfigCache.current = overrides.bot === undefined ? null : overrides.bot;
    adDetectAgentConfigCache.current = overrides.adDetect === undefined ? null : overrides.adDetect;
    agentDeploymentConfigCache.current = overrides.agent === undefined ? null : overrides.agent;
    run();
  } finally {
    botConfigCache.current = prevBot;
    adDetectAgentConfigCache.current = prevAdDetect;
    agentDeploymentConfigCache.current = prevAgent;
    loggerSecretsMemo.current = prevMemo;
  }
}

describe("serializeLogArgs 原语、错误属性、预算与异常 Proxy 分支", () => {
  test("无凭据与有凭据时原语值（null/undefined/symbol/function/boolean/number/-0/NaN/Infinity）均准确规范化并脱敏", () => {
    const plainFn = (): void => {};
    const toJsonFn: (() => void) & { toJSON(): string } = Object.assign((): void => {}, {
      toJSON: (): string => "fn-json",
    });

    // secrets.json.length === 0 路径
    withThreadSecretCaches({ bot: null, adDetect: null, agent: null }, () => {
      const noSecretsResult: unknown[] = serializeLogArgs([
        null, undefined, Symbol("sym"), plainFn, toJsonFn,
        true, false, 42, -0, Number.NaN, Number.POSITIVE_INFINITY,
      ]);
      expect(noSecretsResult).toEqual([
        null, null, null, null, "fn-json",
        true, false, 42, 0, null, null,
      ]);
      expect(Object.is(noSecretsResult[8], 0)).toBeTrue();
    });

    // secrets.json.length > 0 且凭据不命中原语文本
    const baseCapability = (apiKey: string): Readonly<{ provider: string; model: string; api_key: string }> => ({
      provider: "google",
      model: "mock",
      api_key: apiKey,
    });
    const fullAgent: AgentDeploymentConfig = parseAgentDeploymentConfig({
      text: baseCapability("secret-text-key"),
      summary: baseCapability("secret-summary-key"),
      media: baseCapability("secret-media-key"),
      image: baseCapability("secret-image-key"),
      tts: { ...baseCapability("secret-tts-key"), voice: "Kore" },
      web_search: { ...baseCapability("secret-web-key"), max_calls_per_use: 2 },
    });
    const botWithMiniApp: BotConfig = {
      botToken: "secret-bot-token",
      superAdminUserId: 1,
      timeZone: "UTC",
      logLevel: "info",
      miniApp: { url: "https://example.test", host: "127.0.0.1", port: 8443, password: "secret-mini-password" },
    };
    const adDetect: AdDetectAgentConfig = parseAdDetectAgentConfig(baseCapability("secret-ad-key"));

    withThreadSecretCaches({ bot: botWithMiniApp, adDetect, agent: fullAgent }, () => {
      const nonMatching: unknown[] = serializeLogArgs([
        null, undefined, Symbol("s"), plainFn, true, false, 42, -0, Number.NaN, Number.NEGATIVE_INFINITY,
      ]);
      expect(nonMatching).toEqual([null, null, null, null, true, false, 42, 0, null, null]);
      expect(Object.is(nonMatching[7], 0)).toBeTrue();
    });

    // secrets.json.length > 0 且凭据恰好命中 "null" / "true" / "12345"（同时覆盖 parseRedactedJson 退化返回原文）
    const primitiveSecretAgent: AgentDeploymentConfig = parseAgentDeploymentConfig({
      text: baseCapability("null"),
      summary: baseCapability("true"),
      media: baseCapability("12345"),
    });
    withThreadSecretCaches({ bot: null, adDetect: null, agent: primitiveSecretAgent }, () => {
      const matching: unknown[] = serializeLogArgs([
        null, undefined, Number.NaN, true, false, 12_345, 99,
      ]);
      expect(matching).toEqual([
        REDACTED_SECRET, REDACTED_SECRET, REDACTED_SECRET,
        REDACTED_SECRET, false, REDACTED_SECRET, 99,
      ]);
    });

    // 多次热重载切换配置时，旧凭据列表在达到 LOGGER_MAX_REDACTED_SECRETS 后停止扩张
    withThreadSecretCaches({ bot: null, adDetect: null, agent: null }, () => {
      for (let round: number = 0; round < LOGGER_MAX_REDACTED_SECRETS + 4; round++) {
        agentDeploymentConfigCache.current = parseAgentDeploymentConfig({
          text: baseCapability(`rotated-text-${round}`),
          summary: baseCapability(`rotated-summary-${round}`),
          media: baseCapability(`rotated-media-${round}`),
        });
        serializeLogArgs(["probe"]);
      }
      expect(loggerSecretsMemo.current!.text.length).toBeLessThanOrEqual(LOGGER_MAX_REDACTED_SECRETS);
    });
  });

  test("Error 自有属性覆盖条目预算截断、数值规范化、访问器、普通对象与嵌套深度/循环保护", () => {
    // 1. 自有属性超过 LOGGER_MAX_SERIALIZED_ITEMS 时命中预算截断
    const wideError: Error & Record<string, unknown> = new Error("many-props") as Error & Record<string, unknown>;
    wideError.stack = "stack";
    for (let index: number = 0; index < LOGGER_MAX_SERIALIZED_ITEMS + 5; index++) {
      wideError[`k${index}`] = index;
    }
    const [wideSerialized] = serializeLogArgs([wideError]) as [Record<string, unknown>];
    expect(Object.values(wideSerialized)).toContain(LOGGER_SERIALIZATION_LIMIT_VALUE);

    // 2. 数值自有属性（有限数、-0、NaN、Infinity）、undefined 跳过、null/boolean/string、普通对象与 getter
    const typedError: Error & Record<string, unknown> = new Error("typed-props") as Error & Record<string, unknown>;
    typedError.stack = "stack";
    typedError.skipped = undefined;
    typedError.nil = null;
    typedError.flag = true;
    typedError.label = "ok";
    typedError.code = 429;
    typedError.negZero = -0;
    typedError.nanVal = Number.NaN;
    typedError.infVal = Number.POSITIVE_INFINITY;
    typedError.payload = { nested: [1, 2] };
    Object.defineProperty(typedError, "getterProp", {
      enumerable: true,
      get: (): never => { throw new Error("getter must not run"); },
    });
    const [typedSerialized] = serializeLogArgs([typedError]) as [Record<string, unknown>];
    expect("skipped" in typedSerialized).toBeFalse();
    expect(typedSerialized.nil).toBeNull();
    expect(typedSerialized.flag).toBeTrue();
    expect(typedSerialized.label).toBe("ok");
    expect(typedSerialized.code).toBe(429);
    expect(Object.is(typedSerialized.negZero, 0)).toBeTrue();
    expect(typedSerialized.nanVal).toBeNull();
    expect(typedSerialized.infVal).toBeNull();
    expect(typedSerialized.payload).toEqual({ nested: [1, 2] });
    expect(typedSerialized.getterProp).toBe(LOGGER_UNSERIALIZABLE_VALUE);

    // 3. 嵌套深度超限与循环引用
    let deep: Error = new Error("root");
    deep.stack = "s";
    for (let depth: number = 0; depth <= LOGGER_NESTED_ERROR_MAX_DEPTH + 1; depth++) {
      const parent: Error = new Error(`level-${depth}`, { cause: deep });
      parent.stack = "s";
      deep = parent;
    }
    const [deepSerialized] = serializeLogArgs([deep]) as [Record<string, unknown>];
    let cursor: unknown = deepSerialized;
    for (let step: number = 0; step <= LOGGER_NESTED_ERROR_MAX_DEPTH; step++) {
      cursor = (cursor as Record<string, unknown>).cause;
    }
    expect(cursor).toBe(LOGGER_NESTED_ERROR_DEPTH_EXCEEDED_VALUE);

    const cyclic: Error & { cause?: unknown } = new Error("cycle");
    cyclic.stack = "s";
    cyclic.cause = cyclic;
    const [cyclicSerialized] = serializeLogArgs([cyclic]) as [Record<string, unknown>];
    expect(cyclicSerialized.cause).toBe(LOGGER_CIRCULAR_ERROR_VALUE);
  });

  test("AggregateError.errors 支持非数组、稀疏空洞、getter 元素、普通值元素与抛错 Proxy", () => {
    const nonArrayAgg: AggregateError = new AggregateError([], "non-array");
    nonArrayAgg.stack = "s";
    Object.defineProperty(nonArrayAgg, "errors", { value: { reason: "custom" }, configurable: true });
    const [nonArrayOut] = serializeLogArgs([nonArrayAgg]) as [Record<string, unknown>];
    expect(nonArrayOut.errors).toEqual({ reason: "custom" });

    const mixedElements: unknown[] = new Array<unknown>(3);
    mixedElements[1] = { detail: "plain-item" };
    Object.defineProperty(mixedElements, 2, {
      enumerable: true,
      get: (): never => { throw new Error("element getter must not run"); },
    });
    const mixedAgg: AggregateError = new AggregateError([], "mixed");
    mixedAgg.stack = "s";
    Object.defineProperty(mixedAgg, "errors", { value: mixedElements, configurable: true });
    const [mixedOut] = serializeLogArgs([mixedAgg]) as [{ errors: unknown[] }];
    expect(mixedOut.errors).toEqual([null, { detail: "plain-item" }, LOGGER_UNSERIALIZABLE_VALUE]);

    const throwingProxyErrors: unknown[] = new Proxy<unknown[]>([], {
      get(_target: unknown[], prop: string | symbol): unknown {
        if (prop === "length") throw new Error("proxy length boom");
        return Reflect.get(_target, prop);
      },
    });
    const proxyAgg: AggregateError = new AggregateError([], "proxy-errors");
    proxyAgg.stack = "s";
    Object.defineProperty(proxyAgg, "errors", { value: throwingProxyErrors, configurable: true });
    const [proxyOut] = serializeLogArgs([proxyAgg]) as [{ errors: unknown }];
    expect(proxyOut.errors).toBe(LOGGER_UNSERIALIZABLE_VALUE);
  });

  test("恶意 Proxy 触发 instanceof、核心属性 getter 与 ownKeys 异常时均安全降级", () => {
    // 1. instanceof Error 抛错的 Proxy（覆盖 asError catch）
    const protoThrowProxy: object = new Proxy({}, {
      getPrototypeOf(): never { throw new Error("proto boom"); },
    });
    expect(serializeLogArgs([protoThrowProxy])).toEqual([{}]);

    // 2. Error 核心字符串字段（name/message/stack）为抛错 getter 或非字符串时降级
    const brokenCore: Error = new Error("ok");
    Object.defineProperty(brokenCore, "name", { get: (): never => { throw new Error("name boom"); } });
    Object.defineProperty(brokenCore, "message", { get: (): unknown => 123 });
    Object.defineProperty(brokenCore, "stack", { get: (): never => { throw new Error("stack boom"); } });
    const [brokenOut] = serializeLogArgs([brokenCore]) as [Record<string, unknown>];
    expect(brokenOut).toMatchObject({
      name: "Error",
      message: LOGGER_UNSERIALIZABLE_VALUE,
    });
    expect(brokenOut.stack).toBeUndefined();

    // 3. 首次 instanceof Error 放行，随后 isAggregateError 抛错的 Proxy（覆盖 isAggregateError catch）
    let protoReads: number = 0;
    const aggTrapError: Error = new Proxy(new Error("agg-trap"), {
      getPrototypeOf(target: Error): object | null {
        protoReads += 1;
        if (protoReads === 1) return Reflect.getPrototypeOf(target);
        throw new Error("aggregate check boom");
      },
    });
    const [aggTrapOut] = serializeLogArgs([aggTrapError]) as [Record<string, unknown>];
    expect(aggTrapOut).toMatchObject({ name: "Error", message: "agg-trap" });

    // 4. ownKeys 抛错的 Error Proxy（覆盖 Object.getOwnPropertyDescriptors catch）
    const ownKeysTrapError: Error = new Proxy(new Error("own-keys-trap"), {
      ownKeys(): never { throw new Error("ownKeys boom"); },
    });
    const [ownKeysOut] = serializeLogArgs([ownKeysTrapError]) as [Record<string, unknown>];
    expect(ownKeysOut).toMatchObject({ name: "Error", message: "own-keys-trap" });
  });
});

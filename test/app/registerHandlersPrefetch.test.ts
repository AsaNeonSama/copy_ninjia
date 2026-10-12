import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Bot, Context } from "grammy";

/**
 * 前置链里身份预热那一段的两条路径（app/updatePreamble.ts）：全热 update 同步进入下一段，
 * 有冷身份时先等预热完成再进入下游。经 registerHandlers 唯一登记的中间件驱动整条链。
 */

/** 调用顺序流水：预热与下游各记一笔，用来钉住两者的先后。 */
const calls: string[] = [];
let allCached: boolean = true;

const prefetchIdentityPolicies = mock(
  async (ids: readonly number[]): Promise<boolean> => {
    // 跨一次真实调度点后才记账，用以区分「已发起」与「已完成」。
    await Bun.sleep(0);
    calls.push(`prefetch:${[...ids].join(",")}`);
    return true;
  }
);

// 只覆写这两个出口，其余保留：identityStorage 其它导出仍被黑名单成员判定、
// 命令目标解析等模块使用。
const actualIdentityStorage = await import("../../packages/infra/identityStorage");
mock.module("../../packages/infra/identityStorage", () => ({
  ...actualIdentityStorage,
  isIdentityPolicyCached: (): boolean => allCached,
  prefetchIdentityPolicies,
}));

// 预热之前的两道网关放行；预热之后的第一段（私聊中转判定）记一笔「下游」并就地短路，
// 不进入后面的 ingress 与消息流水线。
const actualUpdateGate = await import("../../packages/infra/updateGate");
mock.module("../../packages/infra/updateGate", () => ({
  ...actualUpdateGate,
  shouldPassInitGate: (): boolean => true,
  shouldPassPrivateCommandGate: (): boolean => true,
  shouldRoutePrivateProxyMessage: (): boolean => {
    calls.push("downstream");
    return true;
  },
}));
const actualAuto = await import("../../packages/auto");
mock.module("../../packages/auto", () => ({
  ...actualAuto,
  handleIncomingMessageMiddleware: (): undefined => undefined,
}));

const { registerHandlers } = await import("../../packages/app/registerHandlers");

type TestMiddleware = (ctx: Context, next: () => Promise<void>) => unknown;

/** 装一次链路，取出唯一登记的中间件。 */
function registeredMiddleware(): TestMiddleware {
  let middleware: TestMiddleware | undefined;
  const noop = (): unknown => fakeBot;
  const fakeBot: Record<string, unknown> = {
    use(...handlers: TestMiddleware[]): unknown {
      middleware = handlers[0];
      return fakeBot;
    },
    command: noop,
    hears: noop,
    on: noop,
    catch: noop,
  };
  registerHandlers(fakeBot as unknown as Bot);
  if (middleware === undefined) throw new Error("registerHandlers must register one middleware");
  return middleware;
}

function updateContext(msg: Record<string, unknown>): Context {
  return {
    update: { update_id: 1 },
    me: { id: 999, username: "test_bot" },
    from: { id: 123 },
    message: undefined,
    channelPost: undefined,
    msg,
    chat: { id: -1001, type: "supergroup" },
  } as unknown as Context;
}

const next = (): Promise<void> => {
  calls.push("next");
  return Promise.resolve();
};

beforeEach((): void => {
  calls.length = 0;
  allCached = true;
  prefetchIdentityPolicies.mockClear();
});

describe("前置链的身份预热段", () => {
  test("全热 update 不做跨线程读取，同步进入下游", (): void => {
    registeredMiddleware()(updateContext({}), next);

    expect(prefetchIdentityPolicies).not.toHaveBeenCalled();
    expect(calls).toEqual(["downstream"]);
  });

  test("有冷身份时先预热完再进入下游——下游是同步 LRU 读，留冷就会误判未授权", async (): Promise<void> => {
    allCached = false;

    const pending: unknown = registeredMiddleware()(updateContext({}), next);
    expect(calls).toEqual([]);
    await pending;

    expect(calls).toEqual(["prefetch:123", "downstream"]);
  });

  test("一条 update 里的多个可见身份合并成一次预热", async (): Promise<void> => {
    allCached = false;

    await registeredMiddleware()(updateContext({
      sender_chat: { id: -1009 },
      reply_to_message: { from: { id: 456 } },
    }), next);

    expect(prefetchIdentityPolicies).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["prefetch:123,-1009,456", "downstream"]);
  });
});

import { describe, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { Composer, GrammyError } from "grammy";
import type { Bot, Context } from "grammy";
import { botMessageActivity } from "../../packages/cache/main/botMessage";
import { BOT_MESSAGE_ACTIVITY_LIMIT } from "../../packages/consts/botMessage";
const composerUseAtImport: Mock<Composer<Context>["use"]> = spyOn(Composer.prototype, "use");
const { registerHandlers } = await import("../../packages/app/registerHandlers");
/** 显式注册之前调用 SDK use 的次数；模块导入不安装任何中间件。 */
const SDK_REGISTRATIONS_AFTER_IMPORT: number = composerUseAtImport.mock.calls.length;
composerUseAtImport.mockRestore();

type TestMiddleware = (ctx: Context, next: () => Promise<void>) => unknown;

interface FakeBot {
  use(...handlers: TestMiddleware[]): FakeBot;
  command(command: string, handler: unknown): FakeBot;
  hears(trigger: RegExp, handler: unknown): FakeBot;
  on(update: unknown, handler?: unknown): FakeBot;
  catch(handler: unknown): FakeBot;
}

/** 只带 update 类型字段的最小上下文；ingress 外闸只读 message / channelPost。 */
function nonMessageContext(): Context {
  return { update: { update_id: 1 }, message: undefined, channelPost: undefined, me: { id: 999 } } as unknown as Context;
}

/** 一次 registerHandlers 在假 bot 上留下的全部登记。 */
interface Registration {
  readonly registration: ReturnType<typeof registerHandlers>;
  readonly used: readonly (readonly TestMiddleware[])[];
  /** 直接挂在 bot 上的命令与 hears，必须恒为空（见 app/registerHandlers.ts）。 */
  readonly directCommands: readonly string[];
  readonly directHears: readonly RegExp[];
  readonly updates: readonly unknown[];
  /** use 与 on 记在同一条有序流水里，钉住承重的相对顺序。 */
  readonly registrationOrder: readonly string[];
  readonly catchHandlers: readonly ((error: { ctx: Context; error: unknown }) => void)[];
  /** 子 Composer 上按注册顺序登记的命令名。 */
  readonly commands: readonly unknown[];
  /** 子 Composer 上按注册顺序登记的 update 过滤器（非消息路由）。 */
  readonly composerUpdates: readonly unknown[];
  /** 唯一登记的那一个中间件。 */
  readonly middleware: TestMiddleware;
}

function registerOnFakeBot(): Registration {
  const used: TestMiddleware[][] = [];
  const directCommands: string[] = [];
  const directHears: RegExp[] = [];
  const updates: unknown[] = [];
  const registrationOrder: string[] = [];
  const catchHandlers: ((error: { ctx: Context; error: unknown }) => void)[] = [];
  const fakeBot: FakeBot = {
    use(...handlers: TestMiddleware[]): FakeBot {
      used.push(handlers);
      registrationOrder.push("use");
      return fakeBot;
    },
    command(command: string, _handler: unknown): FakeBot {
      directCommands.push(command);
      registrationOrder.push(`command:${command}`);
      return fakeBot;
    },
    hears(trigger: RegExp, _handler: unknown): FakeBot {
      directHears.push(trigger);
      registrationOrder.push("hears");
      return fakeBot;
    },
    on(update: unknown, _handler?: unknown): FakeBot {
      updates.push(update);
      registrationOrder.push(`on:${JSON.stringify(update)}`);
      return fakeBot;
    },
    catch(handler: unknown): FakeBot {
      catchHandlers.push(handler as (error: { ctx: Context; error: unknown }) => void);
      return fakeBot;
    },
  };
  const composerCommands = spyOn(Composer.prototype, "command");
  const composerOn = spyOn(Composer.prototype, "on");
  try {
    const registration: ReturnType<typeof registerHandlers> = registerHandlers(fakeBot as unknown as Bot);
    const middleware: TestMiddleware | undefined = used[0]?.[0];
    if (middleware === undefined) throw new Error("registerHandlers must register its update chain with bot.use.");
    return {
      registration,
      used,
      directCommands,
      directHears,
      updates,
      registrationOrder,
      catchHandlers,
      commands: composerCommands.mock.calls.map((call: unknown[]): unknown => call[0]),
      composerUpdates: composerOn.mock.calls.map((call: unknown[]): unknown => call[0]),
      middleware,
    };
  } finally {
    composerCommands.mockRestore();
    composerOn.mockRestore();
  }
}

/** 运势回执是 bot 发言外闸之后的第一段，首先读取 ctx.msg；用读取次数判断 update 是否越过外闸。 */
function gateProbeContext(updateId: number, message: unknown): { ctx: Context; msgReads: () => number } {
  let reads: number = 0;
  const ctx: Record<string, unknown> = {
    update: { update_id: updateId },
    me: { id: 999, username: "test_bot" },
    message,
    channelPost: undefined,
    // 未初始化的群：初始化网关在这里终止链路，不进入预热与业务分发。
    chat: { id: -1001, type: "supergroup" },
  };
  Object.defineProperty(ctx, "msg", {
    get(): unknown {
      reads += 1;
      return message;
    },
  });
  return { ctx: ctx as unknown as Context, msgReads: (): number => reads };
}

describe("application handler registration", () => {
  test("导入不注册；显式调用后整条链只挂一个 bot.use、零个 bot.on，命令全部收在外闸后的子 Composer", () => {
    expect(SDK_REGISTRATIONS_AFTER_IMPORT).toBe(0);
    const { used, updates, commands, directCommands, directHears }: Registration = registerOnFakeBot();

    // 前置链由 app/updatePreamble.ts 的续接函数串成，整条只经一个中间件登记。
    expect(used).toHaveLength(1);
    expect(used[0]).toHaveLength(1);
    expect(updates).toEqual([]);
    expect(commands).toEqual([
      "permission",
      "white",
      "copy",
      "translate",
      "icon",
      "wed",
      "h_image",
      "info",
      "block",
      "batch_kick",
      "ai_chat",
      "clear_context",
      "ad_detect",
      "flood_control",
      "antiraid",
      "bot_status",
      "mood",
      "init",
      "quiet",
      "unquiet",
      "mute",
      "unmute",
      "gag",
      "ungag",
      "delete_message",
      "send",
      "qa",
      "x",
    ]);
    expect(directCommands).toEqual([]);
    expect(directHears).toEqual([]);
  });

  test("非消息 update 在子 Composer 上按固定顺序路由，错误处理器只装一个", () => {
    const { registrationOrder, composerUpdates, catchHandlers }: Registration = registerOnFakeBot();
    expect(registrationOrder).toEqual(["use"]);
    // callback_query:data 的 handler：/wed 与 /qa query 翻页先认领（未认领时 next()），未认领的交给入群验证（不调 next()）。
    expect(composerUpdates).toEqual([
      "message_reaction",
      "chat_member",
      "my_chat_member",
      "callback_query:data",
      "callback_query:data",
      "inline_query",
      "chosen_inline_result",
    ]);
    expect(catchHandlers).toHaveLength(1);
  });

  test("未被认领的非消息 update 穿过整条前置链，只调用一次外层 next", async () => {
    const { middleware }: Registration = registerOnFakeBot();
    let nextCalls: number = 0;
    await middleware(nonMessageContext(), (): Promise<void> => {
      nextCalls++;
      return Promise.resolve();
    });
    expect(nextCalls).toBe(1);
  });

  test("唯一中间件追踪见过的最大 update_id", async () => {
    const { middleware, registration }: Registration = registerOnFakeBot();
    const next = async (): Promise<void> => undefined;
    await middleware(gateProbeContext(12, undefined).ctx, next);
    await middleware(gateProbeContext(8, undefined).ctx, next);
    expect(registration.getLastSeenUpdateId()).toBe(12);
  });

  test("bot 发言外闸在回执和业务分发之前截断超额 bot 消息", () => {
    const { middleware }: Registration = registerOnFakeBot();
    const botMessage: unknown = { from: { id: 42, is_bot: true }, chat: { id: -1001, type: "supergroup" } };
    let passedBotMessages: number = 0;
    try {
      for (let index: number = 0; index <= BOT_MESSAGE_ACTIVITY_LIMIT; index += 1) {
        const probe: { ctx: Context; msgReads: () => number } = gateProbeContext(index + 1, botMessage);
        middleware(probe.ctx, (): Promise<void> => Promise.resolve());
        passedBotMessages += probe.msgReads() > 0 ? 1 : 0;
      }
      expect(passedBotMessages).toBe(BOT_MESSAGE_ACTIVITY_LIMIT);
    } finally {
      for (const activity of botMessageActivity.values()) {
        if (activity.timer !== null) clearTimeout(activity.timer);
      }
      botMessageActivity.clear();
    }
  });

  test("GrammyError 只记状态码与描述，不把请求 payload 写进日志", () => {
    const { catchHandlers }: Registration = registerOnFakeBot();
    const secret: string = "private-message-text-marker";
    const apiError: GrammyError = new GrammyError(
      "Call to 'sendMessage' failed!",
      { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" },
      "sendMessage",
      { chat_id: 7, text: secret }
    );
    const consoleError: Mock<typeof console.error> = spyOn(console, "error").mockImplementation((): void => {});
    try {
      expect(() => catchHandlers[0]!({ ctx: { update: { update_id: 14 } } as Context, error: apiError })).toThrow(apiError);
      const logged: string = consoleError.mock.calls.map((call: unknown[]): string => call.map(String).join(" ")).join("\n");
      expect(logged).toBe("Unhandled error while handling update 14: 403 Forbidden: bot was blocked by the user");
      expect(logged).not.toContain(secret);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("错误处理器把错误原样抛回 runner", () => {
    const { catchHandlers }: Registration = registerOnFakeBot();
    const durabilityError = new Error("durability barrier failed");
    expect(() => catchHandlers[0]!({
      ctx: { update: { update_id: 13 } } as Context,
      error: durabilityError,
    })).toThrow(durabilityError);
  });
});

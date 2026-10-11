import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";
import { deferredCommandRuntime } from "../../packages/cache/main/deferredCommands";
import { blocklistIdentityMutationRunner } from "../../packages/cache/main/blocklist";
import {
  DEFERRED_COMMAND_MAX_BACKGROUND_PENDING,
  DEFERRED_COMMAND_MAX_CONCURRENT,
} from "../../packages/consts/deferredCommands";

const errorLogs: string[] = [];
mock.module("../../packages/infra/logger", () => ({
  logger: loggerStub({ error(message: unknown): void { errorLogs.push(String(message)); } }),
}));

const { runBlocklistFanOut } = await import("../../packages/commands/blocklistFanOut");
const {
  drainDeferredCommandRuntime,
  initDeferredCommandRuntime,
  submitDeferredCommand,
} = await import("../../packages/commands/deferredCommands");

const IDENTITY_ID: number = 4242;

/** 没有名单写入的处置：只记扇出顺序。 */
function fanOutOnly(order: string[], label: string): Parameters<typeof runBlocklistFanOut<object>>[0] {
  return {
    identityId: IDENTITY_ID,
    command: "/block test",
    prepare: async (): Promise<object> => ({}),
    fanOut: async (): Promise<void> => { order.push(label); },
  };
}

/**
 * 占满执行器：并发槽位由交互任务占住，并发满后先提交 first，再用后台任务补满后台等待位，
 * 之后同档的提交都会被拒收。返回放行占位任务的函数。
 */
async function fillExecutorAround(first: () => Promise<void>): Promise<() => void> {
  const blocker: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  for (let index: number = 0; index < DEFERRED_COMMAND_MAX_CONCURRENT; index++) {
    expect(submitDeferredCommand({ priority: "interactive", task: (): Promise<void> => blocker.promise, errorLabel: "test:" })).toBeTrue();
  }
  await first();
  for (let index: number = 1; index < DEFERRED_COMMAND_MAX_BACKGROUND_PENDING; index++) {
    expect(submitDeferredCommand({ priority: "background", task: (): Promise<void> => blocker.promise, errorLabel: "test:" })).toBeTrue();
  }
  expect(deferredCommandRuntime.current!.runner.backgroundPendingCount).toBe(DEFERRED_COMMAND_MAX_BACKGROUND_PENDING);
  return blocker.resolve;
}

/** 在该身份的串行位上挂一个更早的在途处置，返回放行它的函数。 */
function holdIdentitySlot(): () => void {
  const hold: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  void blocklistIdentityMutationRunner.run(IDENTITY_ID, (): Promise<void> => hold.promise);
  return hold.resolve;
}

beforeEach((): void => {
  errorLogs.length = 0;
  deferredCommandRuntime.current = null;
  initDeferredCommandRuntime();
});

afterEach(async (): Promise<void> => {
  await drainDeferredCommandRuntime(0);
});

describe("/block 名单写入与跨群扇出的同身份顺序", () => {
  test("串行位空闲时名单写入在调用方内完成，扇出留给执行器", async () => {
    const order: string[] = [];
    const fanOutGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();

    await runBlocklistFanOut({
      identityId: IDENTITY_ID,
      command: "/block test",
      prepare: async (): Promise<{ readonly listed: boolean }> => { order.push("prepare"); return { listed: true }; },
      fanOut: async (prepared: { readonly listed: boolean }): Promise<void> => {
        await fanOutGate.promise;
        order.push(`fan-out:${prepared.listed}`);
      },
    });

    // 调用方已返回：名单写入已完成，扇出还在执行器里等待。
    expect(order).toEqual(["prepare"]);
    fanOutGate.resolve();
    expect(await drainDeferredCommandRuntime(1_000)).toBe("flushed");
    expect(order).toEqual(["prepare", "fan-out:true"]);
  });

  test("有更早的同身份处置在途时，调用方不等它，名单写入随扇出排到它之后", async () => {
    const order: string[] = [];
    const releaseEarlier: () => void = holdIdentitySlot();

    await runBlocklistFanOut({
      identityId: IDENTITY_ID,
      command: "/block test",
      prepare: async (): Promise<object> => { order.push("prepare"); return {}; },
      fanOut: async (): Promise<void> => { order.push("fan-out"); },
    });
    await Bun.sleep(0);
    expect(order).toEqual([]);

    releaseEarlier();
    expect(await drainDeferredCommandRuntime(1_000)).toBe("flushed");
    expect(order).toEqual(["prepare", "fan-out"]);
  });

  test("延后的解除之后紧跟拉黑：两条命令的名单写入按到达顺序落定，最终仍在名单里", async () => {
    let listed: boolean = true;
    const order: string[] = [];
    const releaseEarlier: () => void = holdIdentitySlot();

    await runBlocklistFanOut({
      identityId: IDENTITY_ID,
      command: "/block disable",
      prepare: async (): Promise<object> => { listed = false; order.push("disable"); return {}; },
      fanOut: async (): Promise<void> => { order.push("unban"); },
    });
    await runBlocklistFanOut({
      identityId: IDENTITY_ID,
      command: "/block enable",
      prepare: async (): Promise<object> => { listed = true; order.push("enable"); return {}; },
      fanOut: async (): Promise<void> => { order.push("ban"); },
    });

    releaseEarlier();
    expect(await drainDeferredCommandRuntime(1_000)).toBe("flushed");
    expect(order).toEqual(["disable", "unban", "enable", "ban"]);
    expect(listed).toBeTrue();
  });

  test("执行器满额时就地执行的扇出排在仍在排队的同身份扇出之后", async () => {
    const order: string[] = [];
    const release: () => void = await fillExecutorAround(
      (): Promise<void> => runBlocklistFanOut(fanOutOnly(order, "queued fan-out"))
    );

    // 执行器拒收，这条就地执行；它必须等前一条同身份扇出跑完。
    const inline: Promise<void> = runBlocklistFanOut(fanOutOnly(order, "inline fan-out"));
    await Bun.sleep(0);
    expect(order).toEqual([]);

    release();
    await inline;
    expect(order).toEqual(["queued fan-out", "inline fan-out"]);
  });

  test("排队中的扇出被停机撤销时释放串行位，记下未执行的部分，后续同身份变更不被卡住", async () => {
    const order: string[] = [];
    await fillExecutorAround((): Promise<void> => runBlocklistFanOut(fanOutOnly(order, "dropped")));
    const inline: Promise<void> = runBlocklistFanOut(fanOutOnly(order, "inline"));

    // 零预算排空撤销所有排队任务；占位任务仍挂着，不影响串行位释放。
    await drainDeferredCommandRuntime(0);
    await inline;
    expect(order).toEqual(["inline"]);
    expect(errorLogs).toEqual([
      `Cancelled the deferred /block test for identity ${IDENTITY_ID} before it ran; ` +
      "the cross-chat fan-out did not run and no receipt was sent.",
    ]);
    await expect(blocklistIdentityMutationRunner.run(IDENTITY_ID, (): string => "after")).resolves.toBe("after");
  });

  test("等串行位的名单写入被停机撤销时不再执行，日志写明名单没有改动", async () => {
    const releaseEarlier: () => void = holdIdentitySlot();
    const prepare = mock(async (): Promise<object> => ({}));
    await runBlocklistFanOut({
      identityId: IDENTITY_ID,
      command: "/block disable",
      prepare,
      fanOut: async (): Promise<void> => {},
    });

    await drainDeferredCommandRuntime(0);
    releaseEarlier();
    await expect(blocklistIdentityMutationRunner.run(IDENTITY_ID, (): string => "after")).resolves.toBe("after");
    expect(prepare).not.toHaveBeenCalled();
    expect(errorLogs).toEqual([
      `Cancelled the deferred /block disable for identity ${IDENTITY_ID} before it ran; ` +
      "the blocklist was not changed and no receipt was sent.",
    ]);
  });

  test("名单写入在调用方内抛错时释放串行位并交回调用方", async () => {
    await expect(runBlocklistFanOut({
      identityId: IDENTITY_ID,
      command: "/block test",
      prepare: async (): Promise<object> => { throw new Error("prepare failed"); },
      fanOut: async (): Promise<void> => {},
    })).rejects.toThrow("prepare failed");
    await expect(blocklistIdentityMutationRunner.run(IDENTITY_ID, (): string => "after")).resolves.toBe("after");
  });

  test("扇出抛错时仍释放串行位，错误留给执行器记日志", async () => {
    initDeferredCommandRuntime();
    deferredCommandRuntime.current!.accepting = false;
    await expect(runBlocklistFanOut({
      identityId: IDENTITY_ID,
      command: "/block test",
      prepare: async (): Promise<object> => ({}),
      fanOut: async (): Promise<void> => { throw new Error("fan-out failed"); },
    })).rejects.toThrow("fan-out failed");
    await expect(blocklistIdentityMutationRunner.run(IDENTITY_ID, (): string => "after")).resolves.toBe("after");
  });
});

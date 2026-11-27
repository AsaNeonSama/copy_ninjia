/**
 * `packages/aiChat/workerBridge.ts` 崩溃重建拒收、初始化终止失败、配置热重载拒收、
 * 双阶段 `invalidateAiChat` 聚合错误与 `abuseMark` 事件分支专项单测。
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { adoptStickerConfig } from "../../../packages/config/stickers";
import { logger } from "../../../packages/infra/logger";
import type { AiChatWorkerEvent, AiChatWorkerMessage } from "../../../packages/types/aiChat/protocol";
import type { DiskBusinessMessage } from "../../../packages/types/diskIO";
import { diskIOStub } from "../../helpers/diskIOMock";

let workerPostAccepted: boolean = true;
let diskPostAccepted: boolean = true;
let terminateRejectError: Error | undefined;
let supervisorOptions: {
  onEvent: (event: AiChatWorkerEvent) => void;
  onRespawn: (post: (message: AiChatWorkerMessage) => boolean) => void;
  onGiveUp: () => void;
} | undefined;

const initWorker = mock((): void => {});
const terminateWorker = mock(async (): Promise<void> => {
  if (terminateRejectError !== undefined) throw terminateRejectError;
});

mock.module("../../../packages/infra/supervisedWorker", () => ({
  superviseWorker: (options: typeof supervisorOptions) => {
    supervisorOptions = options;
    return {
      init: initWorker,
      post: (_message: AiChatWorkerMessage): boolean => workerPostAccepted,
      terminate: terminateWorker,
    };
  },
}));
mock.module("../../../packages/infra/diskIO", () => (diskIOStub({
  postDiskIO: (_message: DiskBusinessMessage): boolean => diskPostAccepted,
  relayLogMessage: (): boolean => true,
})));
mock.module("../../../packages/infra/storage/stateStore", () => ({
  activeCopyTargetIdIn: (): undefined => undefined,
  getTtsUsage: (): null => null,
  adoptTtsUsage: (): void => {},
}));

const { isAbuseMarkedUser, clearAbuseMarkedUsers } = await import("../../../packages/aiChat/abuseMark");
const {
  invalidateAiChat,
  startAiChatWorker,
  syncAiChatConfig,
  terminateAiChat,
} = await import("../../../packages/aiChat/workerBridge");
const {
  aiChatWorkerState,
  lastInitState,
  latestAiMemories,
  latestStickerCatalogs,
  pendingAiMemoryDeletes,
  purgedAiMemoryChats,
} = await import("../../../packages/cache/main/aiChat");

beforeEach((): void => {
  workerPostAccepted = true;
  diskPostAccepted = true;
  terminateRejectError = undefined;
  initWorker.mockClear();
  terminateWorker.mockClear();
  clearAbuseMarkedUsers();
  lastInitState.current = null;
  aiChatWorkerState.available = false;
  latestAiMemories.clear();
  latestStickerCatalogs.clear();
  pendingAiMemoryDeletes.clear();
  purgedAiMemoryChats.clear();
  adoptStickerConfig({ packs: ["Pack_A"] });
});

afterEach(async (): Promise<void> => {
  terminateRejectError = undefined;
  await terminateAiChat();
  clearAbuseMarkedUsers();
  lastInitState.current = null;
  latestAiMemories.clear();
  latestStickerCatalogs.clear();
  pendingAiMemoryDeletes.clear();
  purgedAiMemoryChats.clear();
});

describe("aiChat/workerBridge 崩溃、错误与事件分支", () => {
  test("onRespawn 依次在 init / hydrateTtsUsage / hydrate 被拒收时短路返回，并在 hydrateStickerCatalog 被拒收时记错", () => {
    startAiChatWorker({ id: 9, username: "copy_bot", first_name: "Copy" });
    latestAiMemories.set(-1001, '{"version":1}');
    latestStickerCatalogs.set("Pack_A", '{"pack":"Pack_A"}');

    const errorSpy = spyOn(logger, "error").mockImplementation((): void => {});
    try {
      // 1. init 被拒收即立刻短路，不投递后续恢复消息。
      const seenInitReject: string[] = [];
      supervisorOptions!.onRespawn((msg: AiChatWorkerMessage): boolean => {
        seenInitReject.push(msg.type);
        return false;
      });
      expect(seenInitReject).toEqual(["init"]);

      // 2. hydrateTtsUsage 被拒收即短路。
      const seenTtsReject: string[] = [];
      supervisorOptions!.onRespawn((msg: AiChatWorkerMessage): boolean => {
        seenTtsReject.push(msg.type);
        return msg.type !== "hydrateTtsUsage";
      });
      expect(seenTtsReject).toEqual(["init", "hydrateTtsUsage"]);

      // 3. hydrate 被拒收即短路，不投递 hydrateStickerCatalog。
      const seenHydrateReject: string[] = [];
      supervisorOptions!.onRespawn((msg: AiChatWorkerMessage): boolean => {
        seenHydrateReject.push(msg.type);
        return msg.type !== "hydrate";
      });
      expect(seenHydrateReject).toEqual(["init", "hydrateTtsUsage", "hydrate"]);
      expect(errorSpy).not.toHaveBeenCalled();

      // 4. hydrateStickerCatalog 被拒收时记录错误日志。
      const seenCatalogReject: string[] = [];
      supervisorOptions!.onRespawn((msg: AiChatWorkerMessage): boolean => {
        seenCatalogReject.push(msg.type);
        return msg.type !== "hydrateStickerCatalog";
      });
      expect(seenCatalogReject).toEqual([
        "init",
        "hydrateTtsUsage",
        "hydrate",
        "hydrateStickerCatalog",
      ]);
      expect(errorSpy).toHaveBeenCalledWith("AI Worker sticker catalog replay was rejected.");
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("startAiChatWorker 初始化投递失败且终止 Worker 抛错时，记录终止错误并向外抛出初始化错误", async () => {
    workerPostAccepted = false;
    terminateRejectError = new Error("terminate boom");
    const errorSpy = spyOn(logger, "error").mockImplementation((): void => {});
    try {
      expect((): void => {
        startAiChatWorker({ id: 9, username: "copy_bot", first_name: "Copy" });
      }).toThrow("AI Worker is unavailable.");
      await Promise.resolve();
      await Promise.resolve();
      expect(errorSpy).toHaveBeenCalledWith(
        "Failed to terminate the AI Worker after its initialization failed:",
        terminateRejectError
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("syncAiChatConfig 在 Worker 拒收 configReload 时更新快照并记录错误日志", () => {
    startAiChatWorker({ id: 9, username: "copy_bot", first_name: "Copy" });
    workerPostAccepted = false;
    const errorSpy = spyOn(logger, "error").mockImplementation((): void => {});
    try {
      syncAiChatConfig({ aiAgent: false, mood: true, stickers: false });
      expect(errorSpy).toHaveBeenCalledWith(
        "AI Worker rejected the deployment config reload; the next respawn replays the reloaded snapshot."
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("invalidateAiChat 在持久删除与 Worker 失效双阶段均失败时抛出 AggregateError", async () => {
    startAiChatWorker({ id: 9, username: "copy_bot", first_name: "Copy" });
    diskPostAccepted = false;
    workerPostAccepted = false;
    const errorSpy = spyOn(logger, "error").mockImplementation((): void => {});
    try {
      let caught: unknown;
      try {
        await invalidateAiChat(-1009);
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      const aggregate: AggregateError = caught as AggregateError;
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.message).toBe("AI chat invalidation failed for chat -1009.");
      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("onEvent 收到 abuseMark 事件时登记对应用户的滥用冷却标记", () => {
    expect(isAbuseMarkedUser(42)).toBeFalse();
    supervisorOptions!.onEvent({ type: "abuseMark", userId: 42 });
    expect(isAbuseMarkedUser(42)).toBeTrue();
  });
});

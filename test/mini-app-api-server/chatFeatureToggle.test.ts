/**
 * Mini App 群功能开关 `setManagedChatFeature`：未 `/init` 拒绝、配置未就绪拒绝开启、入口检查到置位
 * 不让出执行权、关闭方向先落盘再尽力拆除（`/antiraid` 拆除失败单独回执、翻译先停目标再落盘开关），
 * 以及 `/send` 代发目标的顶替。
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { CHAT_FEATURE_SWITCHES } from "../../packages/consts/chatFeatureSwitch";
import type {
  ChatFeatureSwitchDescriptor,
  ChatState,
  ChatToggleFeature,
} from "../../packages/types/chatState";
import type { ConfigReadiness, ConfigReadinessCache } from "../../packages/types/config";
import type { MiniAppFeatureToggleResult } from "../../packages/types/miniApp/chats";
import {
  installMiniAppTestDiskIOMock,
  miniAppTestJoinLogState,
  resetMiniAppTestDiskIOState,
} from "../helpers/miniAppInitData";

installMiniAppTestDiskIOMock();

const { resetChatStateCache } = await import("../../packages/cache/main/chatState");
const {
  adDetectConfigReadinessCache,
  aiChatConfigReadinessCache,
  translateConfigReadinessCache,
} = await import("../../packages/cache/main/configReadiness");
const { logger } = await import("../../packages/infra/logger");
const {
  getChatState,
  getChatStateCache,
  getOrCreateChatState,
  purgeChatStateExceptLockdown,
} = await import("../../packages/infra/chatStateStorage");
const { setManagedChatFeature } = await import(
  "../../packages/mini-app-api-server/view/chats/toggle"
);

/** 夹具群 ID。 */
const CHAT_ID: number = -1_009_300_001;

/** 需要部署配置就绪才能开启的功能及其可用性缓存；开关字段查 CHAT_FEATURE_SWITCHES。 */
const GATED_FEATURES: readonly {
  readonly feature: ChatToggleFeature;
  readonly readiness: ConfigReadinessCache;
}[] = [
  { feature: "aiChat", readiness: aiChatConfigReadinessCache },
  { feature: "translation", readiness: translateConfigReadinessCache },
  { feature: "adDetect", readiness: adDetectConfigReadinessCache },
];

/** 一份不可用的配置结论夹具。 */
const UNAVAILABLE: ConfigReadiness = {
  ok: false,
  failure: { file: "config/dynamic/agent.json", reason: "fixture" },
};

/**
 * 登记一个已 `/init` 的夹具群。
 * @param chatId 群 ID。
 */
function seedInitializedChat(chatId: number): void {
  getOrCreateChatState(chatId).isInitEnabled = true;
}

let loggerError: ReturnType<typeof spyOn<typeof logger, "error">>;

beforeEach((): void => {
  loggerError = spyOn(logger, "error").mockImplementation((): void => {});
});

afterEach((): void => {
  loggerError.mockRestore();
  for (const { readiness } of GATED_FEATURES) readiness.current = { ok: true };
  resetMiniAppTestDiskIOState();
  resetChatStateCache();
});

describe("Mini App 群功能开关", () => {
  test("未 /init 的群对任一功能都回 CHAT_NOT_INITIALIZED 且不写状态", async () => {
    for (const feature of [
      "init", "aiChat", "translation", "adDetect", "floodControl", "antiRaid", "proxySend",
    ] as const) {
      const result: Readonly<MiniAppFeatureToggleResult> =
        await setManagedChatFeature({ chatId: CHAT_ID, feature, enabled: true });
      expect(result).toMatchObject({
        ok: false,
        removedFromList: true,
        feature,
        message: "CHAT_NOT_INITIALIZED",
        detail: null,
      });
    }
    expect(getChatState(CHAT_ID).isAIChatEnabled).toBeFalse();
    expect(getChatState(CHAT_ID).isProxySendEnabled).toBeFalse();
  });

  test("开启已开的 /init 回 CHAT_INIT_ALREADY_ENABLED 并附群详情", async () => {
    seedInitializedChat(CHAT_ID);
    const result: Readonly<MiniAppFeatureToggleResult> =
      await setManagedChatFeature({ chatId: CHAT_ID, feature: "init", enabled: true });
    expect(result.ok).toBeTrue();
    expect(result.message).toBe("CHAT_INIT_ALREADY_ENABLED");
    expect(result.detail?.chatId).toBe(CHAT_ID);
  });

  test("配置未就绪时拒绝开启并回报配置文件；关闭方向不检查配置", async () => {
    seedInitializedChat(CHAT_ID);
    for (const { feature, readiness } of GATED_FEATURES) {
      const { switchKey } = CHAT_FEATURE_SWITCHES[feature];
      readiness.current = UNAVAILABLE;
      const refused: Readonly<MiniAppFeatureToggleResult> =
        await setManagedChatFeature({ chatId: CHAT_ID, feature, enabled: true });
      expect(refused).toMatchObject({
        ok: false,
        removedFromList: false,
        feature,
        configFile: "config/dynamic/agent.json",
        message: "FEATURE_CONFIG_NOT_READY",
      });
      expect(refused.detail?.chatId).toBe(CHAT_ID);
      expect(getChatState(CHAT_ID)[switchKey]).toBeFalse();

      const disabled: Readonly<MiniAppFeatureToggleResult> =
        await setManagedChatFeature({ chatId: CHAT_ID, feature, enabled: false });
      expect(disabled.ok).toBeTrue();
      expect(disabled.message).toBe("FEATURE_DISABLED");
    }
  });

  test("入口 /init 检查到置位之间不让出执行权：调用返回前开关已写入", async () => {
    for (const { feature } of GATED_FEATURES) {
      const { switchKey } = CHAT_FEATURE_SWITCHES[feature];
      seedInitializedChat(CHAT_ID);
      const pending: Promise<Readonly<MiniAppFeatureToggleResult>> =
        setManagedChatFeature({ chatId: CHAT_ID, feature, enabled: true });
      expect(getChatState(CHAT_ID)[switchKey]).toBeTrue();
      expect((await pending).message).toBe("FEATURE_ENABLED");
    }
  });

  test("开启置位并落盘后回 FEATURE_ENABLED", async () => {
    seedInitializedChat(CHAT_ID);
    const entries = Object.entries(CHAT_FEATURE_SWITCHES) as [ChatToggleFeature, ChatFeatureSwitchDescriptor][];
    for (const [feature, { switchKey }] of entries) {
      const result: Readonly<MiniAppFeatureToggleResult> =
        await setManagedChatFeature({ chatId: CHAT_ID, feature, enabled: true });
      expect(result.ok).toBeTrue();
      expect(result.message).toBe("FEATURE_ENABLED");
      expect(result.detail?.features[feature]).toBeTrue();
      expect(getChatState(CHAT_ID)[switchKey]).toBeTrue();
    }
  });

  test("关闭时 Worker 侧拆除失败只记日志，开关已落盘为关闭", async () => {
    for (const feature of ["adDetect", "floodControl"] as const) {
      const { switchKey, runtimeLabel } = CHAT_FEATURE_SWITCHES[feature];
      seedInitializedChat(CHAT_ID);
      getOrCreateChatState(CHAT_ID)[switchKey] = true;
      loggerError.mockClear();
      const result: Readonly<MiniAppFeatureToggleResult> =
        await setManagedChatFeature({ chatId: CHAT_ID, feature, enabled: false });
      expect(result.ok).toBeTrue();
      expect(result.message).toBe("FEATURE_DISABLED");
      expect(getChatState(CHAT_ID)[switchKey]).toBeFalse();
      expect(String(loggerError.mock.calls[0]?.[0])).toContain(
        `Failed to tear down the ${runtimeLabel} of chat ${CHAT_ID}`
      );
    }
  });

  test("关闭 /antiraid 时拆除失败回 ANTI_RAID_DISABLED_TEARDOWN_FAILED，开关已落盘为关闭", async () => {
    seedInitializedChat(CHAT_ID);
    getOrCreateChatState(CHAT_ID).isAntiRaidEnabled = true;
    const result: Readonly<MiniAppFeatureToggleResult> =
      await setManagedChatFeature({ chatId: CHAT_ID, feature: "antiRaid", enabled: false });
    expect(result).toMatchObject({
      ok: true,
      removedFromList: false,
      feature: "antiRaid",
      message: "ANTI_RAID_DISABLED_TEARDOWN_FAILED",
    });
    expect(result.detail?.features.antiRaid).toBeFalse();
    expect(getChatState(CHAT_ID).isAntiRaidEnabled).toBeFalse();
    expect(String(loggerError.mock.calls[0]?.[0])).toContain(
      `Failed to tear down the ${CHAT_FEATURE_SWITCHES.antiRaid.runtimeLabel} of chat ${CHAT_ID}`
    );
  });

  test("关闭翻译先停掉全部翻译目标并落盘，再置位落盘开关（与 /translate disable 同序）", async () => {
    seedInitializedChat(CHAT_ID);
    const state = getOrCreateChatState(CHAT_ID);
    state.isTranslationEnabled = true;
    state.translate = [{ translatedUser: { id: 77_001, first_name: "Target" }, language: "ja" }];
    const flushed: { readonly translationEnabled: boolean; readonly targets: number }[] = [];
    const recordFlush = (): void => {
      const current = getChatState(CHAT_ID);
      flushed.push({
        translationEnabled: current.isTranslationEnabled,
        targets: current.translate?.length ?? 0,
      });
      miniAppTestJoinLogState.onFlushDiskIODomain = flushed.length < 2 ? recordFlush : undefined;
    };
    miniAppTestJoinLogState.onFlushDiskIODomain = recordFlush;

    const result: Readonly<MiniAppFeatureToggleResult> =
      await setManagedChatFeature({ chatId: CHAT_ID, feature: "translation", enabled: false });
    expect(result.message).toBe("FEATURE_DISABLED");
    expect(flushed).toEqual([
      { translationEnabled: true, targets: 0 },
      { translationEnabled: false, targets: 0 },
    ]);
  });

  test("关闭翻译的前置落盘期间本群 /init 被关闭并 purge 后，收尾不走 getOrCreateChatState 新建条目", async () => {
    seedInitializedChat(CHAT_ID);
    const state: ChatState = getOrCreateChatState(CHAT_ID);
    state.isTranslationEnabled = true;
    state.translate = [{ translatedUser: { id: 77_001, first_name: "Target" }, language: "ja" }];
    miniAppTestJoinLogState.onFlushDiskIODomain = (): void => {
      miniAppTestJoinLogState.onFlushDiskIODomain = undefined;
      purgeChatStateExceptLockdown(CHAT_ID);
    };

    const result: Readonly<MiniAppFeatureToggleResult> =
      await setManagedChatFeature({ chatId: CHAT_ID, feature: "translation", enabled: false });
    expect(result.ok).toBeTrue();
    expect(getChatStateCache().has(CHAT_ID)).toBeFalse();
  });

  test("开启 /send 顶替其它群的代发目标并先为旧目标落盘", async () => {
    const previousChatId: number = -1_009_300_002;
    seedInitializedChat(CHAT_ID);
    seedInitializedChat(previousChatId);
    getOrCreateChatState(previousChatId).isProxySendEnabled = true;

    const enabled: Readonly<MiniAppFeatureToggleResult> =
      await setManagedChatFeature({ chatId: CHAT_ID, feature: "proxySend", enabled: true });
    expect(enabled.ok).toBeTrue();
    expect(enabled.message).toBe("PROXY_SEND_ENABLED");
    expect(getChatState(previousChatId).isProxySendEnabled).toBeFalse();
    expect(getChatState(CHAT_ID).isProxySendEnabled).toBeTrue();

    const disabled: Readonly<MiniAppFeatureToggleResult> =
      await setManagedChatFeature({ chatId: CHAT_ID, feature: "proxySend", enabled: false });
    expect(disabled.message).toBe("PROXY_SEND_DISABLED");
    expect(getChatState(CHAT_ID).isProxySendEnabled).toBeFalse();
  });

  test("为旧代发目标落盘期间本群 /init 被关闭时回 CHAT_NOT_INITIALIZED，不再为本群落盘", async () => {
    const previousChatId: number = -1_009_300_003;
    seedInitializedChat(CHAT_ID);
    seedInitializedChat(previousChatId);
    getOrCreateChatState(previousChatId).isProxySendEnabled = true;
    miniAppTestJoinLogState.onFlushDiskIODomain = (): void => {
      miniAppTestJoinLogState.onFlushDiskIODomain = undefined;
      getOrCreateChatState(CHAT_ID).isInitEnabled = false;
    };

    const result: Readonly<MiniAppFeatureToggleResult> =
      await setManagedChatFeature({ chatId: CHAT_ID, feature: "proxySend", enabled: true });
    expect(result).toMatchObject({
      ok: false,
      removedFromList: true,
      feature: "proxySend",
      message: "CHAT_NOT_INITIALIZED",
      detail: null,
    });
    expect(getChatState(previousChatId).isProxySendEnabled).toBeFalse();
  });
});

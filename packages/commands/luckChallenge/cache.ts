import {
  dailyLuckCache,
  dailyLuckCacheSaturated,
  luckCacheState,
  luckReceiptSecretState,
  luckRuntimeState,
  pendingLuckDraws,
} from "../../cache/main/luckChallenge";
import {
  DAILY_LUCK_CACHE_MAX,
  luckTierByLabel,
} from "../../consts/luckChallenge";
import { DISK_IO_RESPAWN_PRIORITIES } from "../../consts/diskIO/common";
import { logger } from "../../infra/logger";
import { getDateKey } from "../../libs/time";
import type { DiskIORecoveryTransport } from "../../types/diskIO/messages";
import type { LuckAppendStalledReply } from "../../types/diskIO/replies";
import type { LuckDayCache, LuckReceiptSecret } from "../../types/diskIO/storage";
import type { LuckDraw, LuckTier } from "../../types/luckChallenge";
import { deriveLuckDraw } from "./draw";
import { ensureLuckReceiptSecret, onDiskIORespawn, onDiskIOReply, postDiskIO } from "../../infra/diskIO";

/**
 * 采用某个配置时区自然日的持久化密钥，并清空日缓存与 pending。换日采用时置
 * luckRuntimeState.daySwitchedInProcess，标记进程内已跨过配置时区的零点（见
 * promotePendingDraw：此后 pending 未命中不允许重建派生）。
 * @param secret 当天加载或生成的运势回执密钥。
 */
function adoptLuckSecret(secret: LuckReceiptSecret): void {
  if (luckCacheState.dayKey && luckCacheState.dayKey !== secret.day) {
    luckRuntimeState.daySwitchedInProcess = true;
  }
  luckReceiptSecretState.current = secret;
  luckCacheState.dayKey = secret.day;
  dailyLuckCache.clear();
  dailyLuckCacheSaturated.current = false;
  pendingLuckDraws.clear();
}

/**
 * 收下一条当日已确认结果；达到 DAILY_LUCK_CACHE_MAX 时拒收（不淘汰既有条目）并只记一行日志
 * （见 consts/luckChallenge.ts）。被拒的 key 重新预览仍得到同一结果（派生是确定性的）。
 * @param cacheKey 当日运势缓存键。
 * @param draw 抽签结果。
 * @returns 真的收下了为 true；撑满拒收为 false，调用方据此决定要不要落盘。
 */
function admitDailyLuckEntry(cacheKey: string, draw: LuckDraw): boolean {
  if (!dailyLuckCache.has(cacheKey) && dailyLuckCache.size >= DAILY_LUCK_CACHE_MAX) {
    if (!dailyLuckCacheSaturated.current) {
      dailyLuckCacheSaturated.current = true;
      logger.error(
        `Daily luck cache reached its ${DAILY_LUCK_CACHE_MAX}-entry ceiling for ${luckCacheState.dayKey}; ` +
        "further confirmed draws will not be remembered or persisted until the configured local day rolls over."
      );
    }
    return false;
  }
  dailyLuckCache.set(cacheKey, draw);
  return true;
}

/** 按自然日键（`YYYY-MM-DD`）向磁盘线程获取或创建运势回执密钥的异步函数类型。 */
type LuckSecretLoader = (day: string) => Promise<LuckReceiptSecret>;

/** 刷新运势日缓存与回执密钥时的加载器与重试选项。 */
interface EnsureLuckCacheFreshOptions {
  /** 按日期键向磁盘线程获取或创建运势回执密钥的加载器。 */
  loadSecret: LuckSecretLoader;
  /** 共享刷新 Promise 失败后是否允许当前调用方继续发起新一轮刷新。 */
  retryAfterSharedFailure: boolean;
}

/**
 * 循环向磁盘线程请求当日密钥，直至取得的密钥与当前自然日键一致并切换日缓存。
 * @param requestedDay 起始请求的自然日键（YYYY-MM-DD）。
 * @param loadSecret 获取指定自然日密钥的异步函数。
 */
async function rotateLuckCache(
  requestedDay: string,
  loadSecret: LuckSecretLoader
): Promise<void> {
  let targetDay: string = requestedDay;
  for (;;) {
    const secret: LuckReceiptSecret = await loadSecret(targetDay);
    if (secret.day !== targetDay) {
      throw new Error(`Disk I/O Worker returned luck secret for ${secret.day}, expected ${targetDay}`);
    }
    const currentDay: string = getDateKey();
    if (currentDay === targetDay) {
      adoptLuckSecret(secret);
      return;
    }
    targetDay = currentDay;
  }
}

/**
 * 确保主线程运势日缓存与密钥已对齐到当前配置时区的自然日。
 * @param options 密钥加载器与共享刷新失败后的重试策略。
 */
async function ensureLuckCacheFresh({
  loadSecret,
  retryAfterSharedFailure,
}: EnsureLuckCacheFreshOptions): Promise<void> {
  for (;;) {
    const todayKey: string = getDateKey();
    if (
      todayKey === luckCacheState.dayKey &&
      luckReceiptSecretState.current?.day === todayKey
    ) {
      return;
    }
    const sharedRefresh: Promise<void> | null = luckRuntimeState.dayRefreshPromise;
    if (sharedRefresh !== null) {
      try {
        await sharedRefresh;
      } catch (error: unknown) {
        if (!retryAfterSharedFailure) throw error;
      } finally {
        if (luckRuntimeState.dayRefreshPromise === sharedRefresh) {
          luckRuntimeState.dayRefreshPromise = null;
        }
      }
      continue;
    }
    const refresh: Promise<void> = rotateLuckCache(todayKey, loadSecret);
    luckRuntimeState.dayRefreshPromise = refresh;
    try {
      await refresh;
      return;
    } finally {
      if (luckRuntimeState.dayRefreshPromise === refresh) {
        luckRuntimeState.dayRefreshPromise = null;
      }
    }
  }
}

/**
 * 跨配置时区的零点时向唯一磁盘线程取得新日密钥，并整体切换日缓存。
 * @returns 日缓存与当日回执密钥均已对齐到当前自然日时完成的 Promise。
 */
export function ensureLuckCacheFreshForToday(): Promise<void> {
  return ensureLuckCacheFresh({
    loadSecret: ensureLuckReceiptSecret,
    retryAfterSharedFailure: false,
  });
}

/**
 * 当天的回执密钥；未初始化或仍是前一天的密钥时抛错。抽签派生与回执签名共用这一口径。
 * @returns 当前自然日已就绪的运势回执密钥。
 */
export function currentLuckSecret(): LuckReceiptSecret {
  const secret: LuckReceiptSecret | null = luckReceiptSecretState.current;
  if (secret?.day !== luckCacheState.dayKey) {
    throw new Error("Daily luck receipt secret is not initialized");
  }
  return secret;
}

/**
 * 预览优先复用已确认和 pending 结果；新结果只进有界 pending 缓存。
 * @param cacheKey 当日运势缓存键。
 * @returns 已确认、挂起或新派生出的运势抽签结果。
 */
export function getOrDrawLuck(cacheKey: string): LuckDraw {
  const confirmed: LuckDraw | undefined = dailyLuckCache.get(cacheKey);
  if (confirmed) return confirmed;
  const pending: LuckDraw | undefined = pendingLuckDraws.get(cacheKey);
  if (pending) return pending;

  const draw: LuckDraw = deriveLuckDraw(currentLuckSecret(), cacheKey);
  pendingLuckDraws.set(cacheKey, draw);
  return draw;
}

/**
 * chosen result 或有效签名把 pending 转正；重复确认幂等。
 *
 * pending 未命中时的重建派生（deriveLuckDraw 是确定性的）只在密钥同日时进行：
 * 进程重启后确认信号迟到时，重建结果与用户看到的一致。进程内跨过配置时区的零点后
 * （luckRuntimeState.daySwitchedInProcess），pending 未命中一律丢弃，除非调用方证明
 * 确认属于当天（签名回执验签，见 receipt.ts 的 confirmLuckDraw）；
 * chosen_inline_result 不带日期证明，跨天后丢弃。
 * @param cacheKey 当日运势缓存键。
 * @param confirmedForToday 调用方已证明这次确认属于当天（签名回执验签通过），
 *   允许在跨天后仍走重建派生。
 */
export function promotePendingDraw(cacheKey: string, confirmedForToday: boolean = false): void {
  const pending: LuckDraw | undefined = pendingLuckDraws.get(cacheKey);
  pendingLuckDraws.delete(cacheKey);
  if (dailyLuckCache.has(cacheKey)) return;
  if (!pending && luckRuntimeState.daySwitchedInProcess && !confirmedForToday) return;
  const draw: LuckDraw = pending ?? deriveLuckDraw(currentLuckSecret(), cacheKey);

  // 撑满时不投递落盘消息。
  if (!admitDailyLuckEntry(cacheKey, draw)) return;
  // 判 postDiskIO 的返回值：Worker 已终止、或恢复握手期积压达到硬顶时返回 false，
  // 条目此刻只在 dailyLuckCache 中，记一行错误日志；Worker 重生后由
  // onDiskIORespawn 的全量重放补投。
  if (!postDiskIO({
    type: "luckDraw",
    day: luckCacheState.dayKey,
    key: cacheKey,
    label: draw.tier.label,
    fortunePercent: draw.fortunePercent,
  })) {
    logger.error(
      `Daily luck draw for key ${cacheKey} on ${luckCacheState.dayKey} was not handed to the persistence Worker; ` +
      `it is only in memory until the Worker respawns and the cache is replayed.`
    );
  }
}

/** 注册 Disk I/O Worker 重生重放与连续追加失败告警处理器（幂等）。 */
function initializeRespawnRecovery(): void {
  if (luckRuntimeState.respawnRecoveryInitialized) return;
  luckRuntimeState.respawnRecoveryInitialized = true;
  onDiskIORespawn("daily luck", DISK_IO_RESPAWN_PRIORITIES.DAILY_LUCK, async (
    transport: DiskIORecoveryTransport
  ): Promise<boolean> => {
    await ensureLuckCacheFresh({
      loadSecret: transport.ensureLuckReceiptSecret,
      retryAfterSharedFailure: true,
    });
    for (const [key, draw] of dailyLuckCache) {
      if (!transport.post({
        type: "luckDraw",
        day: luckCacheState.dayKey,
        key,
        label: draw.tier.label,
        fortunePercent: draw.fortunePercent,
      })) {
        return false;
      }
    }
    return true;
  });
  // 落盘线程连续追加失败的告警在主线程经 logger 写入 logs/；触发口径与边沿语义见
  // workers/diskIO/luckFiles.ts。
  onDiskIOReply("luckAppendStalled", (reply: LuckAppendStalledReply): void => {
    logger.error(
      `Daily luck appends for ${reply.day} have failed ${reply.consecutiveFailures} times in a row; ` +
      `${reply.pendingEntries} confirmed draw(s) are stuck in the persistence Worker and are not on disk. ` +
      `Last error: ${reply.error}`
    );
  });
}

/**
 * 启动时接管当天密钥与已确认缓存，并显式安装 diskIO Worker 重建重放。
 * @param secret 启动预检加载的运势回执密钥。
 * @param loaded 启动预检加载的当日运势缓存；无缓存文件时为 null。
 */
export function restoreLuckState(secret: LuckReceiptSecret, loaded: LuckDayCache | null): void {
  initializeRespawnRecovery();
  const todayKey: string = getDateKey();
  if (secret.day !== todayKey) {
    // 跨过配置时区日界时丢弃过期凭据与快照，置位 daySwitchedInProcess，首次使用时由 ensureLuckCacheFreshForToday 重取当天密钥。
    logger.warn(
      `Loaded luck receipt secret is for ${secret.day} but the configured local day already rolled over to ${todayKey}; ` +
      "discarding it and re-deriving today's secret on first use."
    );
    luckRuntimeState.daySwitchedInProcess = true;
    return;
  }
  adoptLuckSecret(secret);
  if (loaded?.day !== todayKey) return;

  for (const [key, record] of loaded.entries) {
    const tier: LuckTier | undefined = luckTierByLabel(record.label);
    if (!tier) {
      throw new Error("Loaded luck state violates the validated tier-label invariant.");
    }
    const [min, max]: readonly [number, number] = tier.fortunePercentRange;
    if (record.fortunePercent < min || record.fortunePercent > max) {
      throw new Error("Loaded luck state violates the validated tier-range invariant.");
    }
    // 恢复同样经 admitDailyLuckEntry 过闸，超过上限时抛错。
    if (!admitDailyLuckEntry(key, { tier, fortunePercent: record.fortunePercent })) {
      throw new Error("Loaded luck state exceeds the validated persistence capacity.");
    }
  }
}

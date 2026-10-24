/**
 * 「整张表只挂一个 timer、按最早到期时刻清扫」的排程边界。表与 timer 位由调用方持有，
 * 本模块不持有任何状态（调用方：auto/message/aiReplyActivity.ts 的活跃度窗口、
 * auto/message/triggerPolicy.ts 的随机回复冷却表）。
 */

/** 一张表的清扫描述；调用方在模块级构造一次，每次排程原样传入。 */
export interface EarliestExpirySweeper {
  /** 调用方 cache 里的 timer 位；null 表示当前没有排程。 */
  readonly state: { timer: ReturnType<typeof setTimeout> | null };
  /** 全表最早到期时刻；空表返回非有限值。 */
  readonly earliestExpiry: () => number;
  /** 到期回调：按传入时刻清扫全表。 */
  readonly sweep: (now: number) => void;
}

/**
 * 已有排程时直接返回；否则按全表最早到期时刻挂一个 unref 的 timer，延迟按调用方的 now
 * 计算并收正。到点先按当时的墙钟清扫，再按清扫后的表重排；空表不排程。
 * 每条消息都可能调到这里，已有排程时只读一次 timer 位。
 * @param sweeper 包含 timer 状态位、最早到期查询与清扫回调的描述对象。
 * @param now 当前毫秒时间戳。
 */
export function scheduleEarliestExpirySweep(sweeper: EarliestExpirySweeper, now: number): void {
  if (sweeper.state.timer !== null) return;
  const expiry: number = sweeper.earliestExpiry();
  if (!Number.isFinite(expiry)) return;
  const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
    sweeper.state.timer = null;
    const currentTime: number = Date.now();
    sweeper.sweep(currentTime);
    scheduleEarliestExpirySweep(sweeper, currentTime);
  }, Math.max(1, expiry - now));
  timer.unref();
  sweeper.state.timer = timer;
}

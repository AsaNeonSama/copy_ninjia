/**
 * 引用类广告警告升级状态机的单记录类型与窗口态（纯归约见 packages/states/adReferenceWarning.ts，
 * 容器与代次推进见 packages/workers/antiRaid/adDetect/referencePolicy.ts）。
 */

/** 每个群内发送者的引用广告警告阶段。 */
export type ReferencedAdWarningState =
  | {
    readonly phase: "sending";
    /** 同 key 的单调 attempt；清群后迟到的旧回执不命中新状态。 */
    readonly generation: number;
  }
  | {
    readonly phase: "warned";
    readonly generation: number;
    readonly warnedAt: number;
    readonly expiresAt: number;
  };

/** 引用广告警告记录在给定墙钟时刻的窗口状态。 */
export type ReferencedAdWarningWindow = "none" | "active" | "stale";

import { exhaustiveList } from "../exhaustiveList";
import type { VerificationChallengeOperator, VerificationCleanupResult } from "../../types/antiRaid/verification";
import type { JoinExemption, VerificationEffect } from "../../types/states/verification";

/** 验证回调管理员查询等待上限；满载只回执稍后重试，不继续增加查询等待者。 */
export const VERIFICATION_CALLBACK_CHECK_MAX: number = 10_000;

/** 验证回执的在途上限；正常结果与查询过载回执共用预算，满载不创建新请求。 */
export const VERIFICATION_CALLBACK_REPLY_MAX: number = 10_000;

/**
 * 状态不变或无需副作用的验证转移共用的空效果表；只读，任何转移都不得向它追加。
 * 所属模块：states/verification/。
 */
export const NO_VERIFICATION_EFFECTS: readonly VerificationEffect[] = [];

/** 入群没有任何豁免来源时的结论；全局共享，只读。所属模块：states/verification/join.ts。 */
export const NO_JOIN_EXEMPTION: Readonly<JoinExemption> = { exempt: false, viaChannelComment: false };
/** 身份豁免或拉人者同步豁免命中时的结论；全局共享，只读。所属模块：states/verification/join.ts。 */
export const IDENTITY_JOIN_EXEMPTION: Readonly<JoinExemption> = { exempt: true, viaChannelComment: false };
/** 入群前已观察到关联频道评论时的结论；全局共享，只读。所属模块：states/verification/join.ts。 */
export const CHANNEL_COMMENT_JOIN_EXEMPTION: Readonly<JoinExemption> = { exempt: true, viaChannelComment: true };

/**
 * 清理已结清时的验证消息清理结果；missed 为 0 时战报文案不读 total。
 * 所属模块：workers/antiRaid/verificationEffects/terminal.ts。
 */
export const VERIFICATION_CLEANUP_SETTLED: Readonly<VerificationCleanupResult> = {
  total: 0,
  missed: 0,
  permissionDenied: false,
};

/**
 * 本人作答按钮 callback_data 的前缀，后面拼上 `<待验证成员 userId>:<选项数值>`。
 * 与 VERIFY_APPROVE_CALLBACK_PREFIX、consts/qa.ts 的看板前缀互不为前缀。
 */
export const VERIFY_SELF_CALLBACK_PREFIX: string = "verify:";
/** 本人作答按钮 callback_data 里 userId 与选项数值之间的分隔符；userId 段为纯数字，不含该字符。 */
export const VERIFY_ANSWER_SEPARATOR: string = ":";
/**
 * 本人作答选项数值的规范十进制形态：0 或不带前导零的正整数，最多 3 位（算术题答案上限为
 * VERIFICATION_CHALLENGE_OPERAND_MAX 的平方加干扰项偏移）。所属模块：antiRaid/updateIngress.ts。
 */
export const VERIFY_ANSWER_ARG_PATTERN: RegExp = /^(?:0|[1-9]\d{0,2})$/;
/** 算术题操作数的下限（含）；除法的除数同样不小于它，题目不出现 0 作除数。所属模块：workers/antiRaid/verificationChallenge.ts。 */
export const VERIFICATION_CHALLENGE_OPERAND_MIN: number = 1;
/** 算术题操作数的上限（含）；四则运算的两个操作数都不超过它，除法的被除数同样受限。所属模块：workers/antiRaid/verificationChallenge.ts。 */
export const VERIFICATION_CHALLENGE_OPERAND_MAX: number = 10;
/** 算术题可抽取的运算符，等概率抽取。所属模块：workers/antiRaid/verificationChallenge.ts。 */
export const VERIFICATION_CHALLENGE_OPERATORS: readonly VerificationChallengeOperator[] =
  exhaustiveList<VerificationChallengeOperator>()(["+", "-", "×", "÷"]);
/** 本人作答按钮的个数：一个正确答案加两个干扰项，排成提醒键盘的第一行。所属模块：workers/antiRaid/verificationChallenge.ts。 */
export const VERIFICATION_CHALLENGE_OPTION_COUNT: number = 3;
/**
 * 干扰项与正确答案的最大差值；下方干扰项取自 `answer - 本值…answer - 1` 中不小于 0 的整数，
 * 上方取自 `answer + 1…answer + 本值`。本值须不小于 VERIFICATION_CHALLENGE_OPTION_COUNT - 1，
 * 保证答案为 0（只能排最小）时上方候选仍凑得满选项。
 * 所属模块：workers/antiRaid/verificationChallenge.ts。
 */
export const VERIFICATION_CHALLENGE_DISTRACTOR_SPREAD: number = 3;
/** 「通过」按钮 callback_data 的前缀，后面拼上待验证成员的 userId。 */
export const VERIFY_APPROVE_CALLBACK_PREFIX: string = "approve:";
/** 新成员完成验证的完整时间窗口。 */
export const VERIFICATION_TIMEOUT_MS: number = 3 * 60_000;
/** 验证提醒投递失败后的指数退避边界；失败期间成员不会因看不到按钮被踢。 */
export const VERIFICATION_REMINDER_RETRY_INITIAL_MS: number = 1_000;
/** 验证提醒指数退避允许增长到的最大间隔。 */
export const VERIFICATION_REMINDER_RETRY_MAX_MS: number = 15_000;
/**
 * 「一条带按钮的提醒都没发出去」这种情形下，验证窗口最多能被连续续期到入群后
 * 多久为止。
 *
 * 提醒未送达期间验证窗口持续续期（没人看得见按钮，「没点」不按拒绝验证处理）；
 * 超过这个总时长就按普通超时结算：只踢不封，成员仍可重新加入。
 * 所属模块：states/verification/pending.ts 的 handleVerifyTimeout。
 */
export const VERIFICATION_REMINDER_UNDELIVERED_MAX_MS: number = 15 * 60 * 1000;
/** 终态踢人失败后的**首次**重试间隔；记录保持持久化，不能把未处置成员当作已完成。 */
export const VERIFICATION_TERMINAL_RETRY_MS: number = 30 * 1000;
/**
 * 终态重试指数退避的上限。
 *
 * 部分失败不会自行好转（机器人是管理员却没有封禁权限，或目标本人是该群管理员），
 * 记录按设计不删除：重试间隔从 VERIFICATION_TERMINAL_RETRY_MS 起指数增长到本上限，
 * 之后每个上限周期重试一次，管理员补上封禁权限后最迟一个上限周期内恢复。
 * 所属模块：workers/antiRaid/verificationEffects/retry.ts。
 */
export const VERIFICATION_TERMINAL_RETRY_MAX_MS: number = 30 * 60 * 1000;
/**
 * 同一完整进程内，每条可恢复验证终态最多获准执行的次数。
 *
 * 计数权威在主线程，Anti-Raid Worker 重建不会清零；耗尽后只卸载本进程运行态，
 * 不删除磁盘记录，下一次完整进程启动再从持久化快照恢复。所属模块：
 * antiRaid/verificationAttempts.ts 与 workers/antiRaid/verificationEffects.ts。
 */
export const VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS: number = 15;
/**
 * 单进程允许同时保留的持久化验证记录 key 总数（覆盖 active、延后终态与尚待落盘确认的 tombstone；超出时拒绝新 key 并触发受监督停机）。
 * 所属模块：antiRaid/verificationMirror.ts、antiRaid/workerBridge/controller.ts、workers/diskIO/verificationWrites.ts、workers/diskIO/verificationRecovery.ts。
 */
export const VERIFICATION_RECORD_CAPACITY: number = 15_000;
/**
 * Anti-Raid Worker 当前运行态共用的 key 硬顶（包含持久阶段及 exempt/kicked 去重；跨模块约束见 docs/cn/04-invariants.md）。
 * 所属模块：antiRaid/workerBridge/events.ts、workers/antiRaid/verificationAdmission.ts 与 workers/antiRaid/verificationRuntime.ts。
 */
export const VERIFICATION_RUNTIME_CAPACITY: number = VERIFICATION_RECORD_CAPACITY;
/** Worker 当前代际的活跃与保留期终结 revision 共用的硬上限；新键满额时请求主线程停机。 */
export const VERIFICATION_REVISION_CAPACITY: number = VERIFICATION_RECORD_CAPACITY;
/**
 * 冷启动恢复终态时，Worker 并发反查群类型的硬顶。请求按群复用，超过时保留终态
 * 等下一轮退避。
 */
export const VERIFICATION_CHAT_KIND_FETCH_MAX: number = 100;
/**
 * kicked 结算占位与 exempt 豁免占位的运行态去重窗口；同一物理入群的
 * chat_member 更新和 new_chat_members 服务消息共用占位，重复投递不续期。
 * kickPending 仍待持久处置，不使用本去重 timer。所属模块：workers/antiRaid/verificationRuntime.ts。
 */
export const LOCKDOWN_KICK_DEDUPE_MS: number = 30 * 1000;
/**
 * 私密模式秒踢占位区分同一次物理入群重复投递与重新申请入群的时间窗口（见 states/verification/join.ts 的 handleJoin）。
 */
export const KICKED_REJOIN_GRACE_MS: number = 5 * 1000;
/** 终结 revision 保留的时间，用于抵御重复 adopt；之后周期清理。 */
export const VERIFICATION_REVISION_RETENTION_MS: number = 10 * 60 * 1000;

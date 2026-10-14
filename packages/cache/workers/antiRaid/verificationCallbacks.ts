/** owner: workers/antiRaid。入群验证按钮回调在途准入计数。 */

/**
 * 在途管理员资格查询等待者计数，上限为 VERIFICATION_CALLBACK_CHECK_MAX。
 * 填充：受理回调时递增；清理：查询及回执结算时递减；重建：Worker 崩溃重启后归零。
 */
export const verificationCallbackChecks: { current: number } = { current: 0 };

/**
 * 在途验证回调回执发送计数，上限为 VERIFICATION_CALLBACK_REPLY_MAX。
 * 填充：受理回执发送时递增；清理：发送结算时递减；重建：Worker 崩溃重启后归零。
 */
export const verificationCallbackReplies: { current: number } = { current: 0 };

/** 验证回调回执满载告警单次闩锁；每个 isolate 至多告警一次，Worker 重启后恢复为 false，容量固定为单个布尔值。 */
export const verificationCallbackOverloadLogged: { current: boolean } = { current: false };

/** owner: workers/aiChat。cron 转交的联网摘要组稿请求在途表（packages/workers/aiChat/webDigest.ts）。 */

/**
 * requestId -> 摘要组稿请求的取消控制器。
 * 填充：收到 composeWebDigest 请求时登记。
 * 清理：组稿结算或收到 cancelWebDigest 中止收尾时删除；Worker 排空或停止时由统一生命周期信号中止并随结算摘除。
 * 重建：Worker 崩溃重启后从空表开始。
 * 容量：等于主线程 cron 同时在途的组稿请求数，不设淘汰。
 */
export const webDigestRequests: Map<number, AbortController> = new Map();

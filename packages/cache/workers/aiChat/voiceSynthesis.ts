/** owner: workers/aiChat。主线程转交的语音合成请求在途表（packages/workers/aiChat/voiceSynthesis.ts）。 */

/**
 * requestId -> 语音合成请求的取消控制器。
 * 填充：收到 synthesizeVoice 请求时登记。
 * 清理：合成结算或收到 cancelVoiceSynthesis 中止收尾时删除；Worker 排空或停止时由统一生命周期信号中止并随结算摘除。
 * 重建：Worker 崩溃重启后从空表开始。
 * 容量：等于主线程同时在途的 `/send` TTS 与 cron `send_voice` 请求数，不设淘汰。
 */
export const voiceSynthesisRequests: Map<number, AbortController> = new Map();

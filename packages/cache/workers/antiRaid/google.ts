/** owner: workers/antiRaid。Google 广告检测客户端缓存。 */

import type { GoogleGenAI } from "@google/genai";

/**
 * Google 广告检测客户端单例 holder。
 * 填充：首次发起 Google 广告检测请求时创建写入。
 * 清理：主线程投递新 ad_detect 配置快照时由 workers/antiRaid/adDetect/config.ts 置空，或随进程退出释放。
 * 重建：Worker 崩溃重启后从 null 按当前配置重建。
 * 容量：固定为单个客户端实例，不设淘汰。
 */
export const adDetectGoogleClientHolder: { current: GoogleGenAI | null } = { current: null };

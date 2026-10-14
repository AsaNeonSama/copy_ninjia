/** owner: main。按功能聚合的部署配置可用性结论（packages/config/readiness.ts），跨线程边界见 docs/cn/04-invariants.md。 */

import type { ConfigReadinessCache } from "../../types/config";

/**
 * AI 闲聊部署配置可用性结论单例：启动预检（validateExistingDeploymentInputs）填充，热重载（adoptAiChatConfigReadiness）在结论变化时整体覆盖；运行期不清零、不淘汰，进程重启后恢复为 null（未就绪）。
 */
export const aiChatConfigReadinessCache: ConfigReadinessCache = { current: null };
/** 广告检测部署配置可用性结论单例：启动预检填充，热重载（adoptAdDetectConfigReadiness）在结论变化时整体覆盖；运行期不清零、不淘汰，进程重启后恢复为 null。 */
export const adDetectConfigReadinessCache: ConfigReadinessCache = { current: null };
/** 翻译服务账号密钥（g-auth.json）可用性结论单例：启动预检填充，运行期不热重载、不清零、不淘汰，进程重启后恢复为 null。 */
export const translateConfigReadinessCache: ConfigReadinessCache = { current: null };

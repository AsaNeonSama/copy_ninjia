/** owner: main。业务 Worker 监督器进程级状态（packages/infra/workerSupervisor.ts）。 */

import type { BusinessWorkerFatalHandler } from "../../types/workerSupervisor";

/** 业务 Worker 致命错误处理器单例：应用生命周期取得实例锁后填充，dispose 时清空为 null；Worker 重建不改变该处理器，不淘汰，进程重启后从 null 重新注册。 */
export const businessWorkerFatalHandler: { current: BusinessWorkerFatalHandler | null } = {
  current: null,
};

import {
  adoptVerificationDay,
  inspectVerificationDay,
  maintainVerificationDay,
} from "../../../packages/workers/diskIO/verificationRecovery";
import type { VerificationRecoveryInspection } from "../../../packages/workers/diskIO/verificationRecovery";
import { resetVerificationPersistenceCache } from "../../../packages/cache/workers/diskIO/verification";
import type { VerificationSnapshot } from "../../../packages/types/antiRaid/verification";

/**
 * 验证领域单独恢复的测试编排，按生产 handleDiskIOStartupLoad 的顺序跑
 * inspect -> adopt -> maintenance（见 workers/diskIO/startup.ts），数据目录由用例给出。
 *
 * 与生产的差异：生产的 runMaintenance 对每个领域单独 try/catch 并只记一行
 * console.error，不上抛、也不重置本领域缓存；这里维护阶段失败时先重置缓存再上抛。
 */
export async function recoverVerificationDay(
  day: string,
  dir: string
): Promise<Map<string, VerificationSnapshot>> {
  const inspection: VerificationRecoveryInspection = await inspectVerificationDay(day, dir);
  const recovered: Map<string, VerificationSnapshot> = adoptVerificationDay(inspection);
  try {
    await maintainVerificationDay(inspection);
  } catch (error: unknown) {
    resetVerificationPersistenceCache();
    throw error;
  }
  return recovered;
}

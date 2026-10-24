import { requestMainThread } from "../../libs/workerDuplex";
import type {
  AntiRaidWorkerRequest,
  VerificationAttemptPermitResult,
} from "../../types/antiRaid/protocol";

/**
 * Worker 通过既有双工桥向主线程申请一轮进程级验证终态执行许可。
 * @param key 待验证键（`chatId:userId`）。
 * @param generation 当前 Worker 验证代际号。
 * @param revision 当前验证记录的修订号。
 * @returns 主线程对本次终态尝试许可的审批结果。
 */
export function requestVerificationAttemptPermit(
  key: string,
  generation: number,
  revision: number
): Promise<VerificationAttemptPermitResult> {
  return requestMainThread<AntiRaidWorkerRequest, VerificationAttemptPermitResult>({
    operation: "verificationAttemptPermit",
    key,
    generation,
    revision,
  });
}

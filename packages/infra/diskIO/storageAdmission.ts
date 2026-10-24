import { STORAGE_PENDING_MAX_BYTES, STORAGE_PENDING_MAX_ENTRIES } from "../../consts/diskIO/business";
import { StorageWriteCapacityError } from "../../libs/storageWriteBudget";
import { signalDiskIOFatal } from "./fatal";

/**
 * 主线程在发布最终值前检查所属领域的未 ACK 预算；拒收不淘汰既有事实。
 *
 * @param entries 计入本次写入后该领域的未确认条目总数。
 * @param bytes 计入本次写入后该领域的未确认累计字节数。
 */
export function assertStorageAdmission(entries: number, bytes: number): void {
  if (entries <= STORAGE_PENDING_MAX_ENTRIES && bytes <= STORAGE_PENDING_MAX_BYTES) return;
  const error: StorageWriteCapacityError = new StorageWriteCapacityError();
  signalDiskIOFatal(error);
  throw error;
}

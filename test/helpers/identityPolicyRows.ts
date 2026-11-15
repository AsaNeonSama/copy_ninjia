import {
  blocklistEntries,
  permissionList,
} from "../../packages/database/schema/identityPolicy";
import type { IdentityPolicyTable } from "../../packages/types/identityPolicy";
import type { StorageDatabase } from "../../packages/types/storageDatabase";

export interface PutIdentityPolicyRowOptions {
  readonly database: StorageDatabase;
  readonly table: IdentityPolicyTable;
  readonly id: number;
  readonly data: string;
}

/**
 * 绕过生产写入编码与校验，直接向名单表写入原始行数据。
 * 仅供严格启动校验测试构造损坏或越界输入；生产代码不提供按表名写入任意 `data` 的入口。
 */
export function putIdentityPolicyRow({
  database,
  table,
  id,
  data,
}: PutIdentityPolicyRowOptions): void {
  if (table === "whitelist") {
    database.insert(permissionList).values({ id, data })
      .onConflictDoUpdate({ target: permissionList.id, set: { data } }).run();
    return;
  }
  database.insert(blocklistEntries).values({ id, data })
    .onConflictDoUpdate({ target: blocklistEntries.id, set: { data } }).run();
}

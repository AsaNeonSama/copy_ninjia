import {
  unacknowledgedIdentityWrites,
} from "../../cache/main/identityStorage";
import { assertTelegramIdentityId } from "../../database/codec/identity";
import type { IdentityPolicyTable } from "../../types/identityPolicy";
import type { UnacknowledgedIdentityWrite } from
  "../../types/identityStorage";

/**
 * 校验并收敛 Disk I/O 返回的一张身份策略原始行表。
 *
 * @param rows Disk I/O Worker 返回的 `[id, jsonText]` 原始行列表。
 * @param requested 本次请求查询的身份 ID 只读集合。
 * @param table 当前校验的目标身份策略表名（`"whitelist"` 或 `"blocklist"`）。
 * @returns 按身份 ID 索引的原始 JSON 文本映射。
 */
export function rawIdentityPolicyRows(
  rows: readonly (readonly [number, string])[],
  requested: ReadonlySet<number>,
  table: IdentityPolicyTable
): Map<number, string> {
  const result: Map<number, string> = new Map();
  for (const [id, data] of rows) {
    assertTelegramIdentityId(id, `identity ${table} read reply`);
    if (!requested.has(id) || result.has(id)) {
      throw new Error(
        `Disk I/O returned an unexpected or duplicate ${table} identity ${id}.`
      );
    }
    result.set(id, data);
  }
  return result;
}

/**
 * 本地未 ACK 最终值覆盖数据库迟到值后的当前原始策略。
 *
 * @param table 目标身份策略表名（`"whitelist"` 或 `"blocklist"`）。
 * @param id 目标用户或频道身份 ID。
 * @param databaseText 从数据库读出的原始 JSON 文本；数据库中不存在该行时为 `undefined`。
 * @returns 叠加本地未确认写入后的最新 JSON 文本；确证已删除或不存在时返回 `null`。
 */
export function currentIdentityPolicyText(
  table: IdentityPolicyTable,
  id: number,
  databaseText: string | undefined
): string | null {
  const pending: UnacknowledgedIdentityWrite | undefined =
    unacknowledgedIdentityWrites(table).get(id);
  return pending === undefined ? databaseText ?? null : pending.data;
}

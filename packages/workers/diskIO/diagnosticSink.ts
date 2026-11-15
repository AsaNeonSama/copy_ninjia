/**
 * Disk I/O Worker 故障的非递归诊断输出边界（不经过 logger，直接写入 stderr）。
 */

/**
 * 将诊断参数原样输出到 stderr。
 * 跨层依赖豁免登记见 `scripts/conventions/moduleBoundaries.ts` 的 `INFRA_LAYERING_EXEMPTIONS`。
 * @param values 待原样输出到 stderr 的诊断参数列表。
 */
export function writeDiskIODiagnostic(...values: readonly unknown[]): void {
  console.error(...values);
}

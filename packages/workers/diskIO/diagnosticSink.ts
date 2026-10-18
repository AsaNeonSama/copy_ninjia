/**
 * Disk I/O 故障的非递归诊断输出边界，直接写入 stderr。
 * 跨层依赖豁免见 scripts/conventions/moduleBoundaries.ts 的 INFRA_LAYERING_EXEMPTIONS。
 */
export function writeDiskIODiagnostic(...values: readonly unknown[]): void {
  console.error(...values);
}

/**
 * 把报告渲染为各语言性能文档的 Markdown 区块。
 * 数字使用固定千分位与小数格式，输出不受运行环境的 locale 影响。
 */

import {
  README_BLOCK_END,
  README_BLOCK_START,
} from "./constants";
import { benchmarkCopy } from "./markdownCopy";
import { benchmarkEntryCopy } from "./markdownEntryCopy";
import type { BenchmarkCopy, Language } from "./markdownCopy";
import type { BenchmarkEntryCopy } from "./markdownEntryCopy";
import type {
  BenchmarkEntry,
  BenchmarkSection,
  FullSuiteReport,
  MetricStats,
  SuiteTotals,
} from "./types";

const BYTE_UNITS: readonly string[] = ["B", "KiB", "MiB", "GiB"];

/**
 * 为数字字符串的整数部分添加千分位逗号。
 * @param text 十进制数字字符串。
 * @returns 带千分位分隔符的数字字符串。
 */
function group(text: string): string {
  const [whole, fraction]: string[] = text.split(".");
  const grouped: string = (whole ?? "0").replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ","
  );
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/**
 * 将计数值四舍五入为整数并格式化为千分位字符串。
 * @param value 待格式化的计数值。
 * @returns 四舍五入并带千分位分隔符的整数字符串。
 */
function formatCount(value: number): string {
  return group(Math.round(value).toString());
}

/**
 * 将字节数按 1024 进制自适应格式化为带二进制单位的字符串。
 * @param value 字节数（允许正负值）。
 * @returns 附带 `B`/`KiB`/`MiB`/`GiB` 单位的格式化字符串。
 */
function formatBytes(value: number): string {
  const sign: string = value < 0 ? "-" : "";
  let magnitude: number = Math.abs(value);
  let unit: number = 0;
  while (magnitude >= 1_024 && unit < BYTE_UNITS.length - 1) {
    magnitude /= 1_024;
    unit += 1;
  }
  const digits: number = unit === 0 ? 0 : 2;
  return `${sign}${group(magnitude.toFixed(digits))} ${BYTE_UNITS[unit]}`;
}

/**
 * 耗时按量级选 ns、µs 或 ms 单位。
 * @param value 纳秒为单位的耗时数值。
 * @returns 带自适应时间单位的格式化字符串。
 */
function formatNanoseconds(value: number): string {
  if (value < 1_000) return `${value.toFixed(1)} ns`;
  if (value < 1_000_000) {
    const microseconds: number = value / 1_000;
    const digits: number = microseconds < 10 ? 3 : microseconds < 100 ? 2 : 1;
    return `${group(microseconds.toFixed(digits))} µs`;
  }
  const milliseconds: number = value / 1_000_000;
  if (milliseconds < 100) return `${milliseconds.toFixed(2)} ms`;
  return `${group(milliseconds.toFixed(1))} ms`;
}

/**
 * 将毫秒值换算为纳秒后按自适应时间单位格式化。
 * @param value 毫秒为单位的耗时数值。
 * @returns 带自适应时间单位的格式化字符串。
 */
function formatMilliseconds(value: number): string {
  return formatNanoseconds(value * 1_000_000);
}

/**
 * 按指标的量纲单位将平均值格式化为表格单元格文本。
 * @param metric 待格式化的聚合指标对象。
 * @param entryCopy 当前语言的条目与单位文案表。
 * @returns 格式化后的指标读数字符串。
 */
function formatMetric(
  metric: MetricStats,
  entryCopy: BenchmarkEntryCopy
): string {
  switch (metric.unit) {
    case "ns/op":
      return formatNanoseconds(metric.mean);
    case "ops/s":
      return `${formatCount(metric.mean)} ${entryCopy.operationsPerSecond}`;
    case "records/s":
      return `${formatCount(metric.mean)} ${entryCopy.recordsPerSecond}`;
    case "ms":
      return formatMilliseconds(metric.mean);
    case "bytes":
      return formatBytes(metric.mean);
    case "count":
      return formatCount(metric.mean);
    case "percent":
      return `${metric.mean.toFixed(2)}%`;
  }
}

/**
 * 将指标的变异系数格式化为 `±x.x%` 文本。
 * @param metric 待格式化的聚合指标对象。
 * @returns 变异系数百分比字符串。
 */
function formatVariation(metric: MetricStats): string {
  return `±${metric.coefficientOfVariationPercent.toFixed(1)}%`;
}

/**
 * 将单元格列表拼接为一行 Markdown 表格行。
 * @param cells 单行各列的内容列表。
 * @returns Markdown 表格行文本。
 */
function tableRow(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

/**
 * 生成指定列数的 Markdown 表格分隔行。
 * @param columns 表格总列数。
 * @returns Markdown 表格分隔行文本。
 */
function tableSeparator(columns: number): string {
  return `|${" --- |".repeat(columns)}`;
}

/**
 * 表头只写指标名，单位跟着每个单元格走。
 * @param metric 指标统计对象。
 * @param copy 当前语言的区块文案表。
 * @returns 本地化后的表头列名。
 */
function metricHeader(metric: MetricStats, copy: BenchmarkCopy): string {
  return copy.metricLabels[metric.metric] ?? metric.metric;
}

/**
 * 一个分区渲染成一张表。
 *
 * 列由第一行的指标表决定，其余行按名字对齐；对不上即抛错。
 * @param section 待渲染的基准分区数据。
 * @param copy 当前语言的区块文案表。
 * @param entryCopy 当前语言的条目与单位文案表。
 * @returns 该分区的 Markdown 行列表。
 */
function renderSection(
  section: BenchmarkSection,
  copy: BenchmarkCopy,
  entryCopy: BenchmarkEntryCopy
): readonly string[] {
  const first: BenchmarkEntry | undefined = section.entries[0];
  if (first === undefined) {
    throw new Error(`Benchmark section ${section.id} has no entries to render.`);
  }
  const header: string[] = [copy.sectionSubjects[section.id]];
  for (const metric of first.metrics) header.push(metricHeader(metric, copy));
  header.push(copy.variationColumn);
  const lines: string[] = [
    `## ${copy.sectionTitles[section.id]}`,
    "",
    `> ${copy.sectionNotes[section.id]}`,
    "",
    tableRow(header),
    tableSeparator(header.length),
  ];
  for (const entry of section.entries) {
    if (entry.metrics.length !== first.metrics.length) {
      throw new Error(
        `Benchmark section ${section.id} mixes different metric sets.`
      );
    }
    const label: string = entryCopy.labels[entry.id] ?? entry.id;
    const cells: string[] = [`${label}<br><code>${entry.id}</code>`];
    for (let index: number = 0; index < entry.metrics.length; index += 1) {
      const metric: MetricStats = entry.metrics[index]!;
      if (metric.metric !== first.metrics[index]!.metric) {
        throw new Error(
          `Benchmark section ${section.id} mixes different metric sets.`
        );
      }
      cells.push(formatMetric(metric, entryCopy));
    }
    cells.push(formatVariation(entry.metrics[0]!));
    lines.push(tableRow(cells));
  }
  lines.push("");
  return lines;
}

/**
 * 渲染每轮总吞吐与总 I/O 汇总表。
 * @param totals 全量基准的单轮汇总统计。
 * @param copy 当前语言的区块文案表。
 * @returns 汇总表的 Markdown 行列表。
 */
function renderTotals(
  totals: SuiteTotals,
  copy: BenchmarkCopy
): readonly string[] {
  const rows: readonly (readonly [string, string])[] = [
    [copy.totalsLabels.measuredOperations, formatCount(totals.measuredOperations)],
    [copy.totalsLabels.rcharBytes, formatBytes(totals.rcharBytes)],
    [copy.totalsLabels.wcharBytes, formatBytes(totals.wcharBytes)],
    [copy.totalsLabels.readBytes, formatBytes(totals.readBytes)],
    [copy.totalsLabels.writeBytes, formatBytes(totals.writeBytes)],
    [copy.totalsLabels.readSyscalls, formatCount(totals.readSyscalls)],
    [copy.totalsLabels.writeSyscalls, formatCount(totals.writeSyscalls)],
    [copy.totalsLabels.mockRootBytes, formatBytes(totals.mockRootBytes)],
    [copy.totalsLabels.mockRootFiles, formatCount(totals.mockRootFiles)],
  ];
  const lines: string[] = [
    `## ${copy.totalsTitle}`,
    "",
    `> ${copy.totalsNote}`,
    "",
    tableRow([copy.metricColumn, copy.valueColumn]),
    tableSeparator(2),
  ];
  for (const [label, value] of rows) lines.push(tableRow([label, value]));
  lines.push("");
  return lines;
}

/**
 * 渲染运行环境与硬件摘要表。
 * @param report 全量性能基准报告。
 * @param copy 当前语言的区块文案表。
 * @returns 运行环境表的 Markdown 行列表。
 */
function renderEnvironment(
  report: FullSuiteReport,
  copy: BenchmarkCopy
): readonly string[] {
  const rows: readonly (readonly [string, string])[] = [
    [
      copy.environmentLabels.runtime,
      `Bun ${report.environment.bunVersion} (\`${report.environment.bunRevision}\`)`,
    ],
    [
      copy.environmentLabels.kernel,
      `${report.environment.platform} ${report.environment.kernel} · ${report.environment.arch}`,
    ],
    [copy.environmentLabels.cpuCores, formatCount(report.environment.cpuCount)],
    [copy.environmentLabels.memory, formatBytes(report.environment.totalMemoryBytes)],
    [copy.environmentLabels.rounds, formatCount(report.rounds)],
    [copy.environmentLabels.dataRoot, `\`${report.mockDataRoot}/\``],
    [copy.environmentLabels.generatedAt, report.generatedAt],
  ];
  const lines: string[] = [
    `## ${copy.environmentTitle}`,
    "",
    tableRow([copy.metricColumn, copy.valueColumn]),
    tableSeparator(2),
  ];
  for (const [label, value] of rows) lines.push(tableRow([label, value]));
  lines.push("");
  return lines;
}

/** 摘要行要取的那一格读数。 */
interface MetricLocator {
  /** 目标分区 ID。 */
  readonly sectionId: BenchmarkSection["id"];
  /** 分区内目标条目 ID。 */
  readonly entryId: string;
  /** 条目内目标指标名。 */
  readonly metricName: string;
}

/**
 * 按分区、条目与指标名从报告中精确查找一格聚合读数。
 * @param report 全量性能基准报告。
 * @param options 目标分区 ID、条目 ID 与指标名。
 * @returns 匹配到的指标统计对象。
 */
function findMetric(
  report: FullSuiteReport,
  { sectionId, entryId, metricName }: MetricLocator
): MetricStats {
  const section: BenchmarkSection | undefined = report.sections.find(
    (candidate: BenchmarkSection): boolean => candidate.id === sectionId
  );
  const entry: BenchmarkEntry | undefined = section?.entries.find(
    (candidate: BenchmarkEntry): boolean => candidate.id === entryId
  );
  const metric: MetricStats | undefined = entry?.metrics.find(
    (candidate: MetricStats): boolean => candidate.metric === metricName
  );
  if (metric === undefined) {
    throw new Error(
      `Benchmark report is missing ${sectionId}/${entryId}/${metricName}; ` +
      "the README summary line cannot be rendered from a partial run."
    );
  }
  return metric;
}

/**
 * 渲染基准区块顶部的单行关键指标摘要。
 * @param report 全量性能基准报告。
 * @param copy 当前语言的区块文案表。
 * @param entryCopy 当前语言的条目与单位文案表。
 * @returns 单行 Markdown 摘要文本。
 */
function renderSummaryLine(
  report: FullSuiteReport,
  copy: BenchmarkCopy,
  entryCopy: BenchmarkEntryCopy
): string {
  const ready: MetricStats = findMetric(report, {
    sectionId: "cold-start",
    entryId: "ready-total",
    metricName: "duration",
  });
  const spine: MetricStats = findMetric(report, {
    sectionId: "hot-path",
    entryId: "incoming-message-spine",
    metricName: "medianLatency",
  });
  const aiLatency: MetricStats = findMetric(report, {
    sectionId: "chain",
    entryId: "ai-reply-command",
    metricName: "p50Latency",
  });
  const aiThroughput: MetricStats = findMetric(report, {
    sectionId: "chain",
    entryId: "ai-reply-command",
    metricName: "completedThroughput",
  });
  const adLatency: MetricStats = findMetric(report, {
    sectionId: "chain",
    entryId: "ad-detect-command",
    metricName: "p50Latency",
  });
  const adThroughput: MetricStats = findMetric(report, {
    sectionId: "chain",
    entryId: "ad-detect-command",
    metricName: "completedThroughput",
  });
  return `**${copy.summaryPrefix}** · Bun ${report.environment.bunVersion} · ` +
    `${copy.summaryRounds.replace("{n}", formatCount(report.rounds))} · ` +
    `${report.generatedAt} · ` +
    `${entryCopy.labels["ready-total"] ?? "ready-total"} ${formatMetric(ready, entryCopy)} · ` +
    `${entryCopy.labels["incoming-message-spine"] ?? "incoming-message-spine"} ` +
    `${formatMetric(spine, entryCopy)} · ` +
    `${entryCopy.labels["ai-reply-command"] ?? "ai-reply-command"} ` +
    `${formatMetric(aiLatency, entryCopy)} / ${formatMetric(aiThroughput, entryCopy)} · ` +
    `${entryCopy.labels["ad-detect-command"] ?? "ad-detect-command"} ` +
    `${formatMetric(adLatency, entryCopy)} / ${formatMetric(adThroughput, entryCopy)}`;
}

/**
 * 渲染冷启动分区下方的恢复规模与峰值 RSS 引用行。
 * @param report 全量性能基准报告。
 * @param copy 当前语言的区块文案表。
 * @returns 替换占位符后的冷启动注记行。
 */
function renderColdStartCaption(
  report: FullSuiteReport,
  copy: BenchmarkCopy
): string {
  return `> ${copy.coldStartCaption
    .replace("{whitelist}", formatCount(report.coldStart.recovered.permissionList))
    .replace("{blocklist}", formatCount(report.coldStart.recovered.blocklistEntries))
    .replace("{chats}", formatCount(report.coldStart.recovered.chatStates))
    .replace("{qa}", formatCount(report.coldStart.recovered.chatQaEntries))
    .replace("{memories}", formatCount(report.coldStart.recovered.aiMemoryChats))
    .replace("{rss}", formatBytes(report.coldStart.peakRssBytes.mean))}`;
}

/**
 * 渲染一份语言的完整区块，含首尾标记。
 *
 * 区块嵌进 `docs/<lang>/10-performance.md`：页标题、语言切换和上下页导航是那一页
 * 手写的部分，生成块只含标记之间的读数，重跑基准时按标记整块替换。
 * @param report 全量性能基准报告。
 * @param language 目标文档语言。
 * @returns 含起止注释标记的完整 Markdown 区块。
 */
export function renderBenchmarkBlock(
  report: FullSuiteReport,
  language: Language
): string {
  const copy: BenchmarkCopy = benchmarkCopy(language);
  const entryCopy: BenchmarkEntryCopy = benchmarkEntryCopy(language);
  const lines: string[] = [
    README_BLOCK_START,
    "",
    renderSummaryLine(report, copy, entryCopy),
    "",
    ...renderEnvironment(report, copy),
    ...renderTotals(report.totals, copy),
  ];
  for (const section of report.sections) {
    lines.push(...renderSection(section, copy, entryCopy));
    if (section.id === "cold-start") {
      lines.push(renderColdStartCaption(report, copy), "");
    }
  }
  lines.push(`> ${copy.footer}`, "", README_BLOCK_END);
  return lines.join("\n");
}

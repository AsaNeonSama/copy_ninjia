/**
 * 每个线程独立构造的默认时区、当前时间格式器、UTC 偏移区段缓存，以及按本地日序号缓存的日期前缀。
 * 时区与格式器构造后不变；区段与日期前缀缓存各字段只由 libs/time.ts 在未命中时成对改写。
 */
export interface TimeZoneState {
  readonly timeZone: string;
  readonly fullTimeFormatter: Readonly<Intl.DateTimeFormat>;
  /** 当前缓存的 UTC 偏移区段 [offsetStartMs, offsetEndMs)；初值为空区段（start > end）。 */
  offsetStartMs: number;
  offsetEndMs: number;
  /** 区段内恒定的 UTC 偏移毫秒数。 */
  offsetMs: number;
  /**
   * formatLocalTime 最近一次格式化的本地日序号与对应的 `YYYY/MM/DD ` 前缀（含末尾空格），
   * 两字段成对写入；日序号不变时直接复用前缀。初值 dateDay 为 NaN，首次格式化必然重建。
   * 前缀只由日序号决定，adoptTimeZone 换时区时随整份状态一起重置。
   */
  dateDay: number;
  datePrefix: string;
  /**
   * formatLogTimestamp 最近一次格式化的本地日序号与对应的 `YYYY-MM-DD ` 前缀（含末尾空格），
   * 两字段成对写入；日序号不变时直接复用前缀。初值 logDateDay 为 NaN，首次格式化必然重建。
   * 前缀只由日序号决定，adoptTimeZone 换时区时随整份状态一起重置。
   */
  logDateDay: number;
  logDatePrefix: string;
}

/** 供模型请求使用的同一时刻的 UTC 时间、配置时区名与本地化描述。 */
export interface CurrentTimeResult {
  readonly iso: string;
  readonly timezone: string;
  readonly formatted: string;
}

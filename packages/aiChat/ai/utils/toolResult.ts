/**
 * 工具调用返回给模型的 JSON wire 格式构造与解析。
 */

/** 工具结果 JSON 中供编排层读取的字段。 */
interface ToolResultWire {
  success?: boolean;
  actions_used?: number;
  error?: unknown;
}

/** 解析后的工具执行结果摘要。 */
export interface ParsedToolResult {
  /** 占用的动作额度：成功结果按 actions_used 计（未指定时按单次动作计），失败结果不占用额度。 */
  readonly actionsUsed: number;
  /** 失败说明；非失败结果时为 null。 */
  readonly error: string | null;
}

/**
 * 序列化一条工具失败结果 JSON，可选附带供模型读取的扩展字段。
 */
export function toolError(message: string, extra?: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ error: message, ...extra });
}

/** 解析单条工具结果 JSON。 */
export function parseToolResult(result: string): ParsedToolResult {
  const parsed: ToolResultWire = JSON.parse(result) as ToolResultWire;
  return {
    actionsUsed: parsed.success === true ? parsed.actions_used ?? 1 : 0,
    error: typeof parsed.error === "string" ? parsed.error : null,
  };
}

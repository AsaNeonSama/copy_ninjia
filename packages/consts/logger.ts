/** logger 无法安全读取或序列化某个值时使用的静态占位符；不得调用故障对象的方法生成兜底。 */
export const LOGGER_UNSERIALIZABLE_VALUE: string = "[unserializable value]";

/**
 * JSON 日志与嵌入文本按字段名脱敏的全部全小写敏感字段清单（包含 HTTP 常见凭据头）。
 * 必须与 infra/logger/redaction.ts 中 isSensitiveLogField 的 switch 分支逐项一致（由
 * test/infra/loggerRedaction.test.ts 双向核对）；所属模块：infra/logger/redaction.ts。
 */
export const LOGGER_SENSITIVE_FIELD_NAMES: readonly string[] = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
  "api_key",
  "token",
  "access-token",
  "access_token",
  "accesstoken",
  "refresh-token",
  "refresh_token",
  "refreshtoken",
  "client-secret",
  "client_secret",
  "clientsecret",
  "password",
  "passwd",
  "secret",
];

/** LOGGER_SENSITIVE_FIELD_NAMES 中最短敏感字段名的字符长度（模块加载时由清单求得），用于 switch 前的零分配长度剪枝；所属模块：infra/logger/redaction.ts。 */
export const LOGGER_SENSITIVE_FIELD_MIN_LENGTH: number = Math.min(
  ...LOGGER_SENSITIVE_FIELD_NAMES.map((name: string): number => name.length)
);

/** LOGGER_SENSITIVE_FIELD_NAMES 中最长敏感字段名的字符长度（模块加载时由清单求得），用于 switch 前的零分配长度剪枝；所属模块：infra/logger/redaction.ts。 */
export const LOGGER_SENSITIVE_FIELD_MAX_LENGTH: number = Math.max(
  ...LOGGER_SENSITIVE_FIELD_NAMES.map((name: string): number => name.length)
);

/** 日志字符串中的 HTTP(S) URL 边界；统一移除查询串、fragment 与 userinfo，所属模块：infra/logger/redaction.ts。 */
export const LOGGER_HTTP_URL_PATTERN: Readonly<RegExp> = /https?:\/\/[^\s"<>]+/giu;

/**
 * 日志序列化展开嵌套 Error（`cause`、`AggregateError.errors`、值为 Error 的自有可枚举字段）
 * 的最大层数；顶层 Error 为第 0 层，更深的 Error 以 LOGGER_NESTED_ERROR_DEPTH_EXCEEDED_VALUE
 * 代替。所属模块：infra/logger/serialization.ts。
 */
export const LOGGER_NESTED_ERROR_MAX_DEPTH: number = 5;

/** 嵌套 Error 超过 LOGGER_NESTED_ERROR_MAX_DEPTH 时的静态占位符；所属模块：infra/logger/serialization.ts。 */
export const LOGGER_NESTED_ERROR_DEPTH_EXCEEDED_VALUE: string = "[nested error depth exceeded]";

/** 嵌套 Error 指回自身展开链上某个祖先时的静态占位符；所属模块：infra/logger/serialization.ts。 */
export const LOGGER_CIRCULAR_ERROR_VALUE: string = "[circular error reference]";

/**
 * 线程内值级脱敏名单的容量上限：当前生效的 Telegram token 与各 agent 能力的 api_key，
 * 加上 config/dynamic/ 热重载替换下来的旧凭据；超出时丢弃最早退役的旧凭据。当前凭据恒排在
 * 旧凭据之前且不受上限截断。所属模块：infra/logger/serialization.ts。
 */
export const LOGGER_MAX_REDACTED_SECRETS: number = 128;

/** logger 单次 emit 最多展开的 Error 数，所有参数与嵌套分支共享预算。 */
export const LOGGER_MAX_ERROR_NODES: number = 64;

/** logger 单次 emit 最多读取的参数、Error 属性及 AggregateError 数组元素总数。 */
export const LOGGER_MAX_SERIALIZED_ITEMS: number = 256;

/** logger 单次 emit 的参数 JSON 最大 UTF-8 字节数，包含截断标记与数组结构。 */
export const LOGGER_MAX_SERIALIZED_BYTES: number = 64 * 1_024;

/** logger 超出展开或输出预算时的静态占位符，不包含被截断内容。 */
export const LOGGER_SERIALIZATION_LIMIT_VALUE: string = "[log serialization limit exceeded]";

/** 业务 Worker 单次转发给主线程的最大日志条数；所属模块：cache/perThread/logger.ts。 */
export const LOGGER_FORWARD_BATCH_MAX_MESSAGES: number = 32;

/** 每个业务 Worker 的 error 日志转发 FIFO 最大消息数；越界只累计标量摘要。 */
export const LOGGER_FORWARD_MAX_PENDING_MESSAGES: number = 1_024;

/** 每个业务 Worker 的 error 日志转发 FIFO 最大 JSON 序列化载荷字节数。 */
export const LOGGER_FORWARD_MAX_SERIALIZED_BYTES: number = 2 * 1_024 * 1_024;

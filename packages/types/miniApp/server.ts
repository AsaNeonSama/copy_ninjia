/** Mini App HTTP 路由中间件链与处理器共享的请求上下文。 */
export interface MiniAppRouteContext {
  /** 原始 HTTP 请求对象。 */
  readonly request: Request;
  /** 已解析的请求 URL。 */
  readonly url: URL;
  /** 大写 HTTP 方法（如 `"GET"`、`"POST"`、`"DELETE"`、`"HEAD"`）。 */
  readonly method: string;
  /** 动态路由路径参数映射（如 `{ chatId: "-100123", fileName: "abc.png" }`）。 */
  readonly params: Readonly<Record<string, string>>;
}

/** Mini App 标准路由处理器函数签名。 */
export type MiniAppRouteHandler = (
  ctx: Readonly<MiniAppRouteContext>
) => Response | Promise<Response>;

/** Mini App 路由静态声明的鉴权策略配置，由鉴权管道按固定同步顺序统一执行。 */
export interface MiniAppAuthPolicy {
  /** 是否允许在 `GET`/`HEAD` 请求中从 `token`、`initData` 或 `session` 查询参数提取凭据。 */
  readonly allowQueryAuth: boolean;
  /** 已验明查询参数 `?token=` 受保护资源令牌且未显式携带会话令牌时，是否免检 45 分钟密码会话。 */
  readonly allowVerifiedAssetTokenBypass: boolean;
  /** 是否要求校验 45 分钟密码解锁会话并在距签发超过 5 分钟时通过响应头滑动续期。 */
  readonly requireSession: boolean;
}

/** 经 `withMiniAppAuth` 包装、可直接注册到 `Bun.serve` 原生路由表的 Mini App 路由处理器。 */
export type MiniAppBunRouteHandler = (request: Request) => Promise<Response>;

/**
 * `routes/` 目录各领域路由表片段（模块级共享常量）的形态：路径键与每条路径下的 HTTP 方法表均为只读，
 * 由 `server/register.ts` 的 `createMiniAppBunRoutes` 展开合并为传给 `Bun.serve` 的原生路由表。
 */
export type MiniAppBunRouteTable = Readonly<
  Record<string, Readonly<Partial<Record<Bun.Serve.HTTPMethod, MiniAppBunRouteHandler>>>>
>;

/** Mini App 外部访问地址解析出的规范化子路径前缀与主机名快照。 */
export interface MiniAppPublicUrlParts {
  /** 规范化后的子路径前缀（根路径为 `"/"`，子路径去尾斜杠如 `"/sub"`）。 */
  readonly basePath: string;
  /** URL 的 `host`（小写主机名含非默认端口，如 `"bot.example.com:8443"`）。 */
  readonly host: string;
}

/** 单份已物化的 Mini App 前端打包静态资源（字节内容、MIME 类型与强校验 ETag）。 */
export interface BundledMiniAppAsset {
  /** 资源原始字节内容。 */
  readonly content: Uint8Array;
  /** 资源的 `Content-Type` 响应头取值。 */
  readonly contentType: string;
  /** 资源的强校验 `ETag` 响应头取值。 */
  readonly etag: string;
}

/** 经短暂本地回环实例物化的 Mini App 完整前端入口 HTML 与本地打包静态资源只读快照。 */
export interface BundledMiniAppAssets {
  /** 已将本地根路径引用（`<script src="/...">`、`<link href="/...">`）改写为 `./...` 相对路径的入口 HTML。 */
  readonly html: string;
  /** 本地打包产物原始根路径（如 `"/chunk-xxx.js"`）到已物化资源元数据的只读映射。 */
  readonly assets: ReadonlyMap<string, Readonly<BundledMiniAppAsset>>;
}

/** 单项模型子能力或已加载任务的结构化明细项（供前端竖向样式化展示）。 */
export interface MiniAppCapabilityDetailItem {
  readonly label: string;
  readonly value: string;
  readonly sub?: string;
}

/** Mini App 首页展示的单个功能配置槽位状态。 */
export interface MiniAppCapabilityStatus {
  readonly key: string;
  readonly label: string;
  readonly ready: boolean;
  readonly detail: string;
  readonly items: readonly Readonly<MiniAppCapabilityDetailItem>[];
}

/** `GET /api/mood` 返回的 AI 全局情绪实时状态视图。 */
export interface MiniAppMoodView {
  readonly ok: boolean;
  readonly available: boolean;
  readonly currentMood: string | null;
}

/** `POST /api/mood/switch` 触发重抽 AI 全局情绪后的响应结果。 */
export interface MiniAppMoodMutationResult {
  readonly ok: boolean;
  readonly available: boolean;
  readonly currentMood: string | null;
  readonly message: string;
}

/** Mini App 首页展示的活跃交互会话计数。 */
export interface MiniAppActiveSessionCounts {
  readonly total: number;
  readonly gag: number;
  readonly wed: number;
  readonly verify: number;
  readonly qaSet: number;
}

/** Mini App 首页展示的实时运行状态快照。 */
export interface MiniAppStatusView {
  readonly generatedAt: number;
  readonly uptimeMs: number;
  readonly cpuAveragePercent: number;
  readonly memoryPeakRssBytes: number;
  readonly memoryCurrentRssBytes: number;
  readonly memoryOtherBytes: number;
  readonly memoryTotalBytes: number;
  readonly memoryHeapUsedBytes: number;
  readonly managedChatCount: number;
  readonly whitelistCount: number;
  readonly blocklistCount: number;
  readonly activeSessions: Readonly<MiniAppActiveSessionCounts>;
  readonly telegramOutbound: Readonly<{
    readonly inFlight: number;
    readonly maxConcurrency: number;
    readonly waiting: number;
    readonly retryQueueSize: number;
    readonly retryQueueMax: number;
  }>;
  readonly capabilities: readonly Readonly<MiniAppCapabilityStatus>[];
}

/** 按唯一 `<body>` 标签预切分后的未授权拒绝页静态模板首尾片段。 */
export interface MiniAppRejectHtmlTemplate {
  /** `<body>` 起始标签中 `<body` 之前的 HTML 前缀（包含 `<body` 本身）。 */
  readonly head: string;
  /** `<body>` 起始标签闭合 `>` 及其之后的 HTML 后缀（从 `>` 开始）。 */
  readonly tail: string;
}

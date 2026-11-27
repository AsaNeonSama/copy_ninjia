/**
 * `config/static/bot.json` 中 `mini_app.host` 缺省时绑定的本地回环地址。
 * 不变量：仅监听本机回环，由反向代理提供公网 HTTPS。所属模块：`packages/config/botInput.ts`。
 */
export const MINI_APP_DEFAULT_HOST: string = "127.0.0.1";

/**
 * `mini_app.port` 允许的最小 TCP 端口号。
 * 不变量：正整数下界为 1。所属模块：`packages/config/botInput.ts` 与 `packages/mini-app-api-server/libs/request.ts`。
 */
export const MINI_APP_PORT_MIN: number = 1;

/**
 * `mini_app.port` 允许的最大 TCP 端口号。
 * 不变量：16 位无符号端口上界 65535。所属模块：`packages/config/botInput.ts` 与 `packages/mini-app-api-server/libs/request.ts`。
 */
export const MINI_APP_PORT_MAX: number = 65_535;

/**
 * 十进制正整数时间戳与端口号的匹配规则。
 * 不变量：不带全局标志 `g`，供 `verifyMiniAppInitData` 与客户端 IP 可选端口校验无状态复用。
 * 所属模块：`packages/libs/miniAppAuth.ts` 与 `packages/mini-app-api-server/libs/request.ts`。
 */
export const MINI_APP_POSITIVE_INTEGER_PATTERN: Readonly<RegExp> = /^[1-9]\d*$/;

/**
 * 十进制有符号整数参数的匹配规则。
 * 不变量：不带全局标志 `g`，供 HTTP 查询参数解析无状态复用。所属模块：`packages/mini-app-api-server/libs/request.ts`。
 */
export const MINI_APP_SIGNED_INTEGER_PATTERN: Readonly<RegExp> = /^-?\d+$/u;

/**
 * IPv4 字面量主机名的匹配规则（用于拦截 `Host` 请求头回显源站 IP 字面量）。
 * 不变量：不带全局标志 `g`，供 `buildMiniAppAccessDiagnostics` 无状态复用。所属模块：`packages/mini-app-api-server/libs/response.ts`。
 */
export const MINI_APP_IPV4_HOST_PATTERN: Readonly<RegExp> = /^(?:\d{1,3}\.){3}\d{1,3}$/u;

/**
 * Mini App 响应禁止 Cloudflare Tunnel 边缘节点与浏览器缓存的 `Cache-Control` 取值。
 * 不变量：所有动态页面与业务 JSON API 响应均带上此缓存控制头。所属模块：`packages/mini-app-api-server/libs/response.ts`。
 */
export const MINI_APP_NO_STORE_CACHE_CONTROL: string =
  "no-store, no-cache, must-revalidate, max-age=0";

/**
 * Mini App 公开静态图标资源（如 `/favicon.ico`）下发的 `Cache-Control` 取值（7 天持久化缓存）。
 * 不变量：仅用于未携带会话凭据的公开静态资源 `200 OK` / `304 Not Modified` 响应；受保护图库读取路由 `/api/gallery/file` 使用 `MINI_APP_GALLERY_FILE_CACHE_CONTROL` 与 `serveGalleryFileResponse`，
 * 未通过鉴权的 `401`/`403` 响应固定使用 `no-store`。所属模块：`packages/mini-app-api-server/libs/response.ts`。
 */
export const MINI_APP_ASSET_CACHE_CONTROL: string =
  "public, max-age=604800, s-maxage=604800, immutable";

/**
 * Mini App 已通过超级管理员门禁校验的前端打包产物（`/chunk-*.js`、`/chunk-*.css` 等）使用的私有协商缓存头取值。
 * 不变量：禁止公共代理与 CDN 缓存受保护前端包（配合 `CDN-Cache-Control: no-store`），
 * 浏览器每次重用前须向源站以 `If-None-Match` 复核鉴权与门禁状态；受保护图库读取路由 `/api/gallery/file` 使用 `MINI_APP_GALLERY_FILE_CACHE_CONTROL`。
 * 所属模块：`packages/mini-app-api-server/libs/response.ts`。
 */
export const MINI_APP_BUNDLE_CACHE_CONTROL: string =
  "private, no-cache, must-revalidate";

/**
 * Mini App 受保护图库图片读取路由（`/api/gallery/file`）下发的 7 天私有协商缓存头取值。
 * 不变量：禁止公共代理与 CDN 缓存（配合 `CDN-Cache-Control: no-store`）；浏览器及前端本地图库缓存最多保留 7 天（`max-age=604800`），
 * 每次复用均须附带 `If-None-Match` 向源站复核会话鉴权与文件 `ETag`（未变化返回 `304`）。所属模块：`packages/mini-app-api-server/libs/response.ts`。
 */
export const MINI_APP_GALLERY_FILE_CACHE_CONTROL: string =
  "private, no-cache, max-age=604800, must-revalidate";

/**
 * Mini App 前端打包产物响应的 `Vary` 头取值。
 * 不变量：按门禁 Cookie 与 `initData` 凭据请求头隔离缓存副本。所属模块：`packages/mini-app-api-server/libs/response.ts`。
 */
export const MINI_APP_BUNDLE_VARY_HEADER_VALUE: string =
  "Cookie, X-Telegram-Init-Data, Authorization";

/**
 * Mini App 受保护图库图片读取路由（`/api/gallery/file`）响应的 `Vary` 头取值。
 * 不变量：受保护图库图片依赖请求头鉴权与加密 `?e=` 查询串，必须配合 `CDN-Cache-Control: no-store` 与 `MINI_APP_GALLERY_FILE_CACHE_CONTROL` 按鉴权与会话请求头隔离共享缓存，严禁跨凭据混用缓存副本。
 * 所属模块：`packages/mini-app-api-server/libs/response.ts`。
 */
export const MINI_APP_GALLERY_FILE_VARY_HEADER_VALUE: string =
  "X-Telegram-Init-Data, Authorization, X-Mini-App-Session";

/**
 * Mini App 前端打包产物候选根路径的匹配规则（单层文件名加打包静态资源扩展名）。
 * 不变量：不带全局标志 `g`，供兜底路由匹配单层打包静态资源路径。所属模块：`packages/mini-app-api-server/routes/page.ts`。
 */
export const MINI_APP_BUNDLE_ASSET_ROUTE_PATTERN: Readonly<RegExp> =
  /^\/[^/]+\.(?:js|css|ico|svg|png|webp|woff2?)$/iu;

/**
 * 兜底拦截受保护非 API 图片与矢量图路径后缀的匹配规则（让携带图片后缀的未知非 API 路径先经受保护资源鉴权中间件链再返回 404，不含公开 `/favicon.ico`）。
 * 不变量：不带全局标志 `g`，大小写不敏感匹配常见图片与矢量图扩展名。
 * 所属模块：`packages/mini-app-api-server/server/register.ts` 与 `packages/mini-app-api-server/routes/page.ts`。
 */
export const MINI_APP_PROTECTED_ASSET_EXT_PATTERN: Readonly<RegExp> =
  /\.(?:svg|png|jpe?g|webp|gif|avif)$/iu;

/**
 * Mini App 响应的 `Content-Security-Policy` 安全策略头取值。
 * 不变量：仅允许同源脚本、`https://telegram.org` 官方脚本以及 `index.html` 首屏语言初始化脚本与独立
 * `reject.html` 门禁引导/诊断脚本的静态 SHA-256 哈希，拒绝外联脚本与跨文档嵌套。
 * 所属模块：`packages/mini-app-api-server/libs/response.ts`。
 */
export const MINI_APP_CSP_HEADER_VALUE: string =
  "default-src 'self'; script-src 'self' https://telegram.org 'sha256-QWTSQdDnyTbsLW0pe3w3OntSBjLiStumg3aS49sZVGo=' 'sha256-6HRRJ3O1niCvWgy+fenSOsUA+l5SavnbMG88swSp4uw='; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/**
 * Mini App 响应的 `X-Frame-Options` 安全头取值。
 * 不变量：恒为 `"DENY"`，禁止任何恶意外层页面嵌套（Clickjacking）。所属模块：`packages/mini-app-api-server/libs/response.ts`。
 */
export const MINI_APP_X_FRAME_OPTIONS_VALUE: string = "DENY";

/**
 * Mini App 未授权独立拒绝页（`reject.html`）中用于一次性预切分模板的唯一起始标签字面量。
 * 不变量：模板内必须且仅出现一次 `<body>`，预切分保留 `<body` 前缀与 `>` 后缀。所属模块：`packages/mini-app-api-server/handlers/page.ts`。
 */
export const MINI_APP_REJECT_HTML_BODY_TAG: string = "<body>";

/**
 * Mini App JSON 写接口允许的最大请求体字节数（32 KiB）。
 * 不变量：用于 JSON 请求体解析边界。所属模块：`packages/mini-app-api-server/libs/request.ts`。
 */
export const MINI_APP_MAX_JSON_BODY_BYTES: number = 32_768;

/**
 * Mini App HTTP 服务允许的最大请求体字节数（11 MiB，覆盖 10 MiB 随机图库单图上传上限并提供结构化超限报错余量）。
 * 不变量：大于 `RANDOM_IMAGE_MAX_BYTES`，配置到 `Bun.serve` 的 `maxRequestBodySize`。所属模块：`packages/mini-app-api-server/server/serve.ts`。
 */
export const MINI_APP_MAX_UPLOAD_BODY_BYTES: number = 11 * 1024 * 1024;

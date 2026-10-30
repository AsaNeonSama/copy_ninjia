import type { MiniAppMiddleware } from "../../types/miniApp";
import { createMiniAppHeaderGuardMiddleware } from "./headerGuard";
import { createMiniAppInitDataMiddleware } from "./initData";
import { createMiniAppSessionMiddleware } from "./sessionToken";

/**
 * 仅校验请求头快路径（跨站、直接导航与凭据形态）、Telegram WebApp 签名、超管 ID 与 30 分钟密码锁定的中间件链（用于 `/api/auth/precheck` 与 `/api/auth/login`）。
 */
export const MINI_APP_INIT_DATA_MIDDLEWARE_CHAIN: readonly MiniAppMiddleware[] = [
  createMiniAppHeaderGuardMiddleware(false),
  createMiniAppInitDataMiddleware(false),
];

/**
 * 受保护图库图片资源的专属鉴权中间件链（请求头快路径拦截跨站与浏览器直接导航 + 强制校验 Telegram WebApp 签名或资源令牌与超管 ID，用于 `/api/gallery/file/:fileName` 及受保护图片后缀路径）。
 */
export const MINI_APP_PROTECTED_ASSET_MIDDLEWARE_CHAIN: readonly MiniAppMiddleware[] = [
  createMiniAppHeaderGuardMiddleware(true),
  createMiniAppInitDataMiddleware(true),
];

/**
 * 业务 JSON 与写操作 API 的完整双层鉴权中间件链（请求头快路径 + Telegram WebApp 超管签名 + 45 分钟密码会话，用于 `/api/status`、`/api/mood*`、`/api/totp*`、`/api/chats/*`、`/api/identities/*`、`/api/picker/*`、`/api/gallery*`）。
 */
export const MINI_APP_API_AUTH_MIDDLEWARE_CHAIN: readonly MiniAppMiddleware[] = [
  createMiniAppHeaderGuardMiddleware(false),
  createMiniAppInitDataMiddleware(false),
  createMiniAppSessionMiddleware(false),
];

/**
 * 图库原图附件下载路由的完整双层鉴权中间件链（请求头快路径 + Telegram WebApp 超管签名或资源令牌 + 45 分钟密码会话，允许 GET/HEAD 查询参数传凭据以供 Telegram 原生下载器直连保存至系统默认下载目录，用于 `/api/gallery/download/:fileName`）。
 */
export const MINI_APP_GALLERY_DOWNLOAD_MIDDLEWARE_CHAIN: readonly MiniAppMiddleware[] = [
  createMiniAppHeaderGuardMiddleware(true),
  createMiniAppInitDataMiddleware(true),
  createMiniAppSessionMiddleware(true),
];

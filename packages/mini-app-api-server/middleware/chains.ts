import type { MiniAppMiddleware } from "../../types/miniApp";
import { createMiniAppHeaderGuardMiddleware } from "./headerGuard";
import { createMiniAppInitDataMiddleware } from "./initData";
import { createMiniAppSessionMiddleware } from "./sessionToken";

/** 仅校验请求头快路径（跨站、直接导航与凭据形态）、Telegram WebApp 签名、超管 ID 与 30 分钟密码锁定的中间件链（用于 `/api/auth/precheck` 与 `/api/auth/login`）。 */
const initDataMiddlewareChain: readonly MiniAppMiddleware[] = [
  createMiniAppHeaderGuardMiddleware(false),
  createMiniAppInitDataMiddleware(false),
];

/** 受保护 SVG 与图库图片资源的专属鉴权中间件链（请求头快路径拦截跨站与浏览器直接导航 + 强制校验 Telegram WebApp 签名或资源令牌与超管 ID）。 */
const protectedAssetMiddlewareChain: readonly MiniAppMiddleware[] = [
  createMiniAppHeaderGuardMiddleware(true),
  createMiniAppInitDataMiddleware(true),
];

/** 业务 JSON 与写操作 API 的完整双层鉴权中间件链（请求头快路径 + Telegram WebApp 超管签名 + 45 分钟密码会话）。 */
const apiAuthMiddlewareChain: readonly MiniAppMiddleware[] = [
  createMiniAppHeaderGuardMiddleware(false),
  createMiniAppInitDataMiddleware(false),
  createMiniAppSessionMiddleware(false),
];

/** 图库原图附件下载路由的完整双层鉴权中间件链（请求头快路径 + Telegram WebApp 超管签名或资源令牌 + 45 分钟密码会话，允许 GET/HEAD 查询参数传凭据以供 Telegram 原生下载器直连保存至系统默认下载目录）。 */
const galleryDownloadMiddlewareChain: readonly MiniAppMiddleware[] = [
  createMiniAppHeaderGuardMiddleware(true),
  createMiniAppInitDataMiddleware(true),
  createMiniAppSessionMiddleware(true),
];

/**
 * 获取公开路由（`/healthz`、`/`、`/index.html`、`/favicon.ico`）的中间件链。
 * @returns 只读中间件数组。
 */
export function getMiniAppPublicMiddlewareChain(): readonly MiniAppMiddleware[] {
  return [];
}

/**
 * 获取首屏预检与密码登录路由（`/api/auth/precheck`、`/api/auth/login`）的中间件链。
 * @returns 只读中间件数组。
 */
export function getMiniAppInitDataMiddlewareChain(): readonly MiniAppMiddleware[] {
  return initDataMiddlewareChain;
}

/**
 * 获取受保护图片与 SVG 资源路由（`/api/gallery/file/:fileName`、`/api/resources/svg/:fileName`、`/miniAppResoures/:fileName`）的中间件链。
 * @returns 只读中间件数组。
 */
export function getMiniAppProtectedAssetMiddlewareChain(): readonly MiniAppMiddleware[] {
  return protectedAssetMiddlewareChain;
}

/**
 * 获取受保护业务 API 路由（`/api/status`、`/api/mood*`、`/api/totp*`、`/api/chats/*`、`/api/identities/*`、`/api/picker/*`、`/api/gallery*`）的中间件链。
 * @returns 只读中间件数组。
 */
export function getMiniAppApiAuthMiddlewareChain(): readonly MiniAppMiddleware[] {
  return apiAuthMiddlewareChain;
}

/**
 * 获取图库原图附件下载路由（`/api/gallery/download/:fileName`）的完整双层鉴权中间件链。
 * @returns 只读中间件数组。
 */
export function getMiniAppGalleryDownloadMiddlewareChain(): readonly MiniAppMiddleware[] {
  return galleryDownloadMiddlewareChain;
}

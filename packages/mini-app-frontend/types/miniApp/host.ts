/**
 * Mini App 前端运行的 Telegram WebApp 宿主、Web Storage、IndexedDB 与全局窗口最小接口。
 */

import type {
  CachedGalleryBinaryEntry,
  MiniAppGalleryCacheStorage,
} from "./gallery";

/** Telegram WebApp `initDataUnsafe` 中当前用户信息。 */
interface TelegramWebAppUser {
  readonly id: number;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly username?: string;
  readonly language_code?: string;
}

/** Mini App 由最小化恢复或被最小化时 Telegram 宿主派发的事件名（Bot API 8.0+）。 */
type TelegramWebAppActivityEvent = "activated" | "deactivated";

/** Telegram WebApp 注入浏览器的宿主对象接口。 */
export interface TelegramWebApp {
  readonly initData?: string;
  readonly initDataUnsafe?: Readonly<{ readonly user?: Readonly<TelegramWebAppUser> }>;
  readonly ready?: () => void;
  readonly expand?: () => void;
  readonly setHeaderColor?: (color: string) => void;
  readonly setBackgroundColor?: (color: string) => void;
  readonly isVersionAtLeast?: (version: string) => boolean;
  /** Mini App 当前是否处于激活态；被最小化时为 `false`（Bot API 8.0+，更早版本缺省）。 */
  readonly isActive?: boolean;
  /** 注册宿主事件处理器（本应用只订阅 Bot API 8.0+ 的 `activated` / `deactivated`）。 */
  readonly onEvent?: (eventType: TelegramWebAppActivityEvent, handler: () => void) => void;
  /** 注销 `onEvent` 注册过的宿主事件处理器。 */
  readonly offEvent?: (eventType: TelegramWebAppActivityEvent, handler: () => void) => void;
  /** 唤起 Telegram 客户端原生文件下载器将 HTTPS 资源保存至系统默认下载目录（Bot API 8.0+）。 */
  readonly downloadFile?: (
    params: Readonly<{ readonly url: string; readonly file_name: string }>,
    callback?: (accepted: boolean) => void
  ) => void;
  /** 唤起 `savePreparedKeyboardButton` 创建的原生好友/联系人/群组/频道选择器（Bot API 9.6+）。 */
  readonly requestChat?: (preparedButtonId: string, callback?: (accepted: boolean) => void) => void;
}

/** 供浏览器触发附件保存的临时 `<a download>` 节点最小接口。 */
export interface MiniAppDownloadAnchorElement {
  href: string;
  download: string;
  rel: string;
  readonly style: { display: string };
  readonly click: () => void;
  readonly remove: () => void;
}

/** 浏览器 Web Storage（`localStorage` / `sessionStorage`）最小读写接口。 */
interface MiniAppWebStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}

/** 浏览器 IndexedDB 异步请求最小接口（无 DOM lib 下承接结构化克隆 `CryptoKey`）。 */
export interface MiniAppIdbRequestLike<TResult = unknown> {
  readonly result?: TResult;
  readonly error?: unknown;
  onsuccess: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onupgradeneeded?: ((event?: unknown) => void) | null;
  onblocked?: ((event?: unknown) => void) | null;
}

/** 浏览器 IndexedDB 对象存储仓库最小读写接口。 */
export interface MiniAppIdbObjectStoreLike {
  readonly get: (key: string) => MiniAppIdbRequestLike<unknown>;
  readonly put: (value: unknown, key?: string) => MiniAppIdbRequestLike<unknown>;
  readonly delete: (key: string) => MiniAppIdbRequestLike<unknown>;
}

/** 浏览器 IndexedDB 事务最小接口。 */
export interface MiniAppIdbTransactionLike {
  readonly error?: unknown;
  readonly objectStore: (name: string) => MiniAppIdbObjectStoreLike;
  oncomplete: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onabort: ((event?: unknown) => void) | null;
}

/** 浏览器 IndexedDB 数据库实例最小接口。 */
export interface MiniAppIdbDatabaseLike {
  readonly objectStoreNames: Readonly<{ readonly contains: (name: string) => boolean }>;
  readonly createObjectStore: (name: string) => unknown;
  readonly transaction: (storeName: string, mode: "readonly" | "readwrite") => MiniAppIdbTransactionLike;
  readonly close: () => void;
}

/** IndexedDB 中同一事务写入的会话令牌与其不可导出 `AES-GCM` `CryptoKey` 配对记录（不含明文密钥）。 */
export interface MiniAppPersistedSessionKey {
  /** 与 `cryptoKey` 同代签发的 64 位十六进制会话令牌。 */
  readonly token: string;
  /** 该令牌对应的不可导出 `AES-GCM` `CryptoKey`。 */
  readonly cryptoKey: CryptoKey;
}

/** 浏览器全局 `indexedDB` 工厂最小接口，用于在 WebView 中持久化不可导出 `CryptoKey`。 */
export interface MiniAppIdbFactoryLike {
  readonly open: (name: string, version?: number) => MiniAppIdbRequestLike<MiniAppIdbDatabaseLike>;
}

/** 带有可选 `Telegram.WebApp` 与标准浏览器宿主能力的全局窗口视图。 */
export interface TelegramWindow {
  readonly Telegram?: Readonly<{ readonly WebApp?: Readonly<TelegramWebApp> }>;
  /** 浏览器标准 `CacheStorage`（受限隐私模式或纯 Node/Bun 单测环境下可缺省）。 */
  readonly caches?: Readonly<MiniAppGalleryCacheStorage>;
  /** 单页生命周期内的图库二进制与 `ETag` 内存协商缓存表（作为 `CacheStorage` 热层与无 `caches` 环境的回退层）。 */
  __copyNinjaGalleryBinaryCache?: Map<string, Readonly<CachedGalleryBinaryEntry>>;
  /** 当前页面生命周期内单飞共享的过期持久化缓存清扫承诺（确保并发首读等待首轮清扫完成后再写入）。 */
  __copyNinjaGalleryCachePrunePromise?: Promise<void>;
  readonly indexedDB?: Readonly<MiniAppIdbFactoryLike>;
  readonly localStorage?: Readonly<MiniAppWebStorage>;
  readonly sessionStorage?: Readonly<MiniAppWebStorage>;
  readonly location?: Readonly<{
    readonly href?: string;
    readonly host?: string;
    readonly search: string;
    readonly hash: string;
    readonly reload?: () => void;
  }>;
  readonly confirm?: (message?: string) => boolean;
  readonly scrollTo?: (
    options: Readonly<{ readonly top: number; readonly behavior?: "auto" | "instant" | "smooth" }>
  ) => void;
  readonly navigator?: Readonly<{ readonly language?: string; readonly languages?: readonly string[] }>;
  readonly document?: {
    title?: string;
    readonly getElementById: (elementId: string) => Element | null;
    readonly createElement?: (tagName: "a") => MiniAppDownloadAnchorElement;
    readonly body?: Readonly<{ readonly appendChild?: (node: MiniAppDownloadAnchorElement) => void }>;
    readonly documentElement?: Readonly<{
      readonly setAttribute?: (qualifiedName: string, value: string) => void;
    }>;
    /** 页面可见性；切到后台或被遮挡时为 `"hidden"`。 */
    readonly visibilityState?: "visible" | "hidden";
    readonly addEventListener?: (type: "visibilitychange", listener: () => void) => void;
    readonly removeEventListener?: (type: "visibilitychange", listener: () => void) => void;
  };
}

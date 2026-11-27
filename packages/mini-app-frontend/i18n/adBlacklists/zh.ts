import type {
  MiniAppAdBlacklistKind,
  MiniAppAdBlacklistStickerSetType,
} from "../../types/miniApp/adBlacklists";
import type {
  MiniAppAdBlacklistsTranslations,
  MiniAppServerNoticeParams,
} from "../../types/miniAppI18n";

/**
 * 将内容黑名单种类键映射为简体中文标签。
 *
 * @param kind 内容黑名单种类
 * @returns 中文种类标签
 */
function formatZhKindLabel(kind?: MiniAppAdBlacklistKind): string {
  return kind === "emoji" ? "自定义表情包" : "贴纸包";
}

/**
 * 将内容黑名单相关的服务端状态码格式化为简体中文提示。
 *
 * @param code 去除前缀后的状态码
 * @param params 可选插值参数
 * @returns 命中时返回中文文案，未命中时返回 `null`
 */
export function formatZhAdBlacklistServerNotice(
  code: string,
  params?: Readonly<MiniAppServerNoticeParams>
): string | null {
  const kindLabel: string = formatZhKindLabel(params?.kind);
  const packText: string =
    params?.pack !== undefined && params.pack.length > 0 ? `「${params.pack}」` : "该包";
  const persistNote: string =
    params?.persisted === false ? "（注意：磁盘持久化确认未完成）" : "";
  switch (code) {
    case "AD_BLACKLIST_ADDED":
      return `哼，本天才已经帮杂鱼把${kindLabel}${packText}关进内容黑名单啦${persistNote}♡`;
    case "AD_BLACKLIST_DUPLICATE":
      return `笨蛋杂鱼♡，${kindLabel}${packText}早就已经在内容黑名单里啦，不许重复添加！`;
    case "AD_BLACKLIST_REMOVED":
      return `哼，已经把${kindLabel}${packText}从内容黑名单里放出来啦${persistNote}♡`;
    case "AD_BLACKLIST_NOT_FOUND":
      return `杂鱼♡，${kindLabel}${packText}原本就不在内容黑名单里哦。`;
    case "INVALID_AD_BLACKLIST_PARAMS":
      return "笨蛋杂鱼♡，内容黑名单请求参数格式不对哦！";
    case "INVALID_AD_BLACKLIST_PACK":
      return "笨蛋杂鱼♡，包名格式不对哦，仅支持 1–64 位字母、数字与下划线！";
    case "AD_BLACKLIST_BOT_OWN_PACK":
      return `笨蛋杂鱼♡，${packText}是本天才自己在用的贴纸包，不许拉黑本天才的包！`;
    case "AD_BLACKLIST_STORAGE_UNAVAILABLE":
      return params?.changed === true && params.persisted === false
        ? `啧，${kindLabel}${packText}的实时内容黑名单状态已经更新生效，但磁盘持久化确认失败（重启后可能丢失），杂鱼快去检查存储状态♡`
        : "啧，内容黑名单存储暂时没空理你，杂鱼稍后再试♡";
    case "AD_BLACKLIST_PREVIEW_NOT_FOUND":
      return "啧，Telegram 上已经找不到这个贴纸/表情包啦，可能已经被原作者删掉或改名了哦♡";
    case "AD_BLACKLIST_PREVIEW_UNAVAILABLE":
      return "啧，暂时从 Telegram 拉不到这个包的预览，杂鱼点重试或者稍后再试吧♡";
    default:
      return null;
  }
}

/**
 * 返回简体中文（杂鱼语气）的内容黑名单页面专属文案字典。
 *
 * @returns 中文内容黑名单界面文案对象
 */
export function getZhAdBlacklistsTranslations(): Readonly<MiniAppAdBlacklistsTranslations> {
  return {
    stickerTab: "贴纸包黑名单",
    emojiTab: "表情包黑名单",
    refreshButton: "刷新",
    searchPlaceholder: "快说，杂鱼",
    searchClearAria: "清空搜索词",
    addFoldButton: "添加内容",
    addInputPlaceholder: "写清楚，杂鱼",
    addButton: "加入黑名单",
    addingButton: "添加中…",
    invalidPackNotice:
      "笨蛋杂鱼♡，请输入 1–64 位英文字母、数字或下划线包名，或合法的 t.me/addstickers/…、t.me/addemoji/… 链接！",
    noticeBannerTitle: "操作诊断",
    duplicateBannerTitle: "重复添加拦截",
    dismissNoticeAria: "关闭提示横幅",
    previewPackButtonTitle: (kind: MiniAppAdBlacklistKind): string =>
      kind === "sticker" ? "页内预览贴纸包" : "页内预览表情包",
    previewCountBadge: (count: number): string => `${count} 枚`,
    previewStickerTypeLabel: (
      stickerType: MiniAppAdBlacklistStickerSetType
    ): string => {
      switch (stickerType) {
        case "custom_emoji":
          return "自定义表情包";
        case "mask":
          return "面具贴纸包";
        case "regular":
          return "普通贴纸包";
      }
    },
    previewLoadMoreButton: (shown: number, total: number): string =>
      `加载更多（已显示 ${shown} / ${total}）`,
    previewLoadingMoreButton: "加载中…",
    previewRetryButton: "重试",
    previewCopyLinkButton: "复制链接",
    previewLinkCopiedToast: "哼，包链接已经帮你复制到剪贴板啦♡",
    previewCopyFailedToast: "啧，剪贴板不让写呢，杂鱼手动复制一下吧♡",
    previewOpenTelegramButton: "在 Telegram 打开",
    previewCloseButton: "关闭",
    previewEmptyHint: "这个包里居然一枚内容都没有呢，空荡荡的哦。",
    previewAnimatedTag: "TGS",
    previewVideoTag: "WEBM",
    removeButton: "移除",
    confirmRemovePack: (kind: MiniAppAdBlacklistKind, pack: string): string =>
      `杂鱼，确定要把${formatZhKindLabel(kind)}「${pack}」从内容黑名单移除吗？`,
    emptySearchHint: (query: string): string =>
      `啧，找不到包含「${query}」的黑名单包名呢，杂鱼是不是拼错啦？`,
    emptyListHint: (kind: MiniAppAdBlacklistKind): string =>
      kind === "sticker"
        ? "贴纸包内容黑名单里空荡荡的呢，点上方「添加内容」塞几个进来吧杂鱼♡"
        : "自定义表情包内容黑名单里空荡荡的呢，点上方「添加内容」塞几个进来吧杂鱼♡",
  };
}

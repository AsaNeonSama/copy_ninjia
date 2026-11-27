import type {
  MiniAppAdBlacklistKind,
  MiniAppAdBlacklistStickerSetType,
} from "../../types/miniApp/adBlacklists";
import type {
  MiniAppAdBlacklistsTranslations,
  MiniAppServerNoticeParams,
} from "../../types/miniAppI18n";

/**
 * 将内容黑名单种类键映射为英文标签。
 *
 * @param kind 内容黑名单种类
 * @returns 英文种类标签
 */
function formatEnKindLabel(kind?: MiniAppAdBlacklistKind): string {
  return kind === "emoji" ? "custom emoji pack" : "sticker pack";
}

/**
 * 将内容黑名单相关的服务端状态码格式化为英文提示。
 *
 * @param code 去除前缀后的状态码
 * @param params 可选插值参数
 * @returns 命中时返回英文文案，未命中时返回 `null`
 */
export function formatEnAdBlacklistServerNotice(
  code: string,
  params?: Readonly<MiniAppServerNoticeParams>
): string | null {
  const kindLabel: string = formatEnKindLabel(params?.kind);
  const packText: string =
    params?.pack !== undefined && params.pack.length > 0 ? `"${params.pack}"` : "that pack";
  const persistNote: string =
    params?.persisted === false ? " (Note: disk persistence confirmation incomplete)" : "";
  switch (code) {
    case "AD_BLACKLIST_ADDED":
      return `Hmph, locked ${kindLabel} ${packText} into the content blacklist for you${persistNote}, Zaako♡`;
    case "AD_BLACKLIST_DUPLICATE":
      return `Clueless Zaako♡, ${kindLabel} ${packText} is already in the content blacklist! No duplicates allowed!`;
    case "AD_BLACKLIST_REMOVED":
      return `Hmph, removed ${kindLabel} ${packText} from the content blacklist${persistNote}, Zaako♡`;
    case "AD_BLACKLIST_NOT_FOUND":
      return `Zaako♡, ${kindLabel} ${packText} wasn't in the content blacklist in the first place.`;
    case "INVALID_AD_BLACKLIST_PARAMS":
      return "Clueless Zaako♡, invalid content blacklist request parameters!";
    case "INVALID_AD_BLACKLIST_PACK":
      return "Clueless Zaako♡, invalid pack name! Only 1–64 ASCII letters, digits, and underscores are allowed!";
    case "AD_BLACKLIST_BOT_OWN_PACK":
      return `Clueless Zaako♡, ${packText} is one of this Genius's own sticker packs! Hands off!`;
    case "AD_BLACKLIST_STORAGE_UNAVAILABLE":
      return params?.changed === true && params.persisted === false
        ? `Tsk, live content blacklist state for ${kindLabel} ${packText} was updated, but disk persistence confirmation failed (changes may be lost on restart). Check storage, Zaako♡`
        : "Tsk, content blacklist storage is temporarily unavailable. Try again later, Zaako♡";
    case "AD_BLACKLIST_PREVIEW_NOT_FOUND":
      return "Tsk, this sticker/emoji pack no longer exists on Telegram (deleted or invalid), Zaako♡";
    case "AD_BLACKLIST_PREVIEW_UNAVAILABLE":
      return "Tsk, couldn't fetch this pack's preview from Telegram right now. Retry in a moment, Zaako♡";
    default:
      return null;
  }
}

/**
 * 返回英文（Zaako♡ 杂鱼语气）的内容黑名单页面专属文案字典。
 *
 * @returns 英文内容黑名单界面文案对象
 */
export function getEnAdBlacklistsTranslations(): Readonly<MiniAppAdBlacklistsTranslations> {
  return {
    stickerTab: "Sticker Packs",
    emojiTab: "Emoji Packs",
    refreshButton: "Refresh",
    searchPlaceholder: "Speak up, Zaako",
    searchClearAria: "Clear search query",
    addFoldButton: "Add Item",
    addInputPlaceholder: "Write clearly, Zaako",
    addButton: "Add Pack",
    addingButton: "Adding…",
    invalidPackNotice:
      "Clueless Zaako♡, enter a 1–64 char ASCII pack name (letters, digits, underscores) or a valid t.me/addstickers/... / t.me/addemoji/... link!",
    noticeBannerTitle: "Action Diagnostic",
    duplicateBannerTitle: "Duplicate Blocked",
    dismissNoticeAria: "Dismiss notice banner",
    previewPackButtonTitle: (kind: MiniAppAdBlacklistKind): string =>
      kind === "sticker" ? "Preview sticker pack in-app" : "Preview emoji pack in-app",
    previewCountBadge: (count: number): string => `${count} items`,
    previewStickerTypeLabel: (
      stickerType: MiniAppAdBlacklistStickerSetType
    ): string => {
      switch (stickerType) {
        case "custom_emoji":
          return "Custom Emoji";
        case "mask":
          return "Mask Pack";
        case "regular":
          return "Sticker Pack";
      }
    },
    previewLoadMoreButton: (shown: number, total: number): string =>
      `Load more (${shown} / ${total})`,
    previewLoadingMoreButton: "Loading…",
    previewRetryButton: "Retry",
    previewCopyLinkButton: "Copy Link",
    previewLinkCopiedToast: "Hmph, copied the pack link to your clipboard, Zaako♡",
    previewCopyFailedToast: "Tsk, clipboard access was blocked. Copy the link manually, Zaako♡",
    previewOpenTelegramButton: "Open in Telegram",
    previewCloseButton: "Close",
    previewEmptyHint: "This pack has zero items inside.",
    previewAnimatedTag: "TGS",
    previewVideoTag: "WEBM",
    removeButton: "Remove",
    confirmRemovePack: (kind: MiniAppAdBlacklistKind, pack: string): string =>
      `Zaako, remove ${formatEnKindLabel(kind)} "${pack}" from the content blacklist?`,
    emptySearchHint: (query: string): string =>
      `Tsk, no blacklisted pack matching "${query}" found. Did you mistype it, Zaako?`,
    emptyListHint: (kind: MiniAppAdBlacklistKind): string =>
      kind === "sticker"
        ? "No sticker packs in the content blacklist yet! Click '+ Add Item' above to add one, Zaako♡"
        : "No custom emoji packs in the content blacklist yet! Click '+ Add Item' above to add one, Zaako♡",
  };
}

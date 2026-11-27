import type {
  MiniAppAdBlacklistKind,
  MiniAppAdBlacklistStickerSetType,
} from "../../types/miniApp/adBlacklists";
import type {
  MiniAppAdBlacklistsTranslations,
  MiniAppServerNoticeParams,
} from "../../types/miniAppI18n";

/**
 * 将内容黑名单种类键映射为日文标签。
 *
 * @param kind 内容黑名单种类
 * @returns 日文种类标签
 */
function formatJaKindLabel(kind?: MiniAppAdBlacklistKind): string {
  return kind === "emoji" ? "カスタム絵文字パック" : "ステッカーパック";
}

/**
 * 将内容黑名单相关的服务端状态码格式化为日文提示。
 *
 * @param code 去除前缀后的状态码
 * @param params 可选插值参数
 * @returns 命中时返回日文文案，未命中时返回 `null`
 */
export function formatJaAdBlacklistServerNotice(
  code: string,
  params?: Readonly<MiniAppServerNoticeParams>
): string | null {
  const kindLabel: string = formatJaKindLabel(params?.kind);
  const packText: string =
    params?.pack !== undefined && params.pack.length > 0 ? `「${params.pack}」` : "そのパック";
  const persistNote: string =
    params?.persisted === false ? "（※ディスク保存確認が未完了）" : "";
  switch (code) {
    case "AD_BLACKLIST_ADDED":
      return `ふん、${kindLabel}${packText}を内容ブラックリストに叩き込んであげたわよ${persistNote}♡`;
    case "AD_BLACKLIST_DUPLICATE":
      return `マヌケな雑魚♡、${kindLabel}${packText}はとっくに内容ブラックリストに入ってるわよ！重複追加はダメ！`;
    case "AD_BLACKLIST_REMOVED":
      return `ふん、${kindLabel}${packText}を内容ブラックリストから外してあげたわよ${persistNote}♡`;
    case "AD_BLACKLIST_NOT_FOUND":
      return `雑魚♡、${kindLabel}${packText}は最初から内容ブラックリストにいないわよ。`;
    case "INVALID_AD_BLACKLIST_PARAMS":
      return "マヌケな雑魚♡、内容ブラックリストのリクエストパラメータが不正よ！";
    case "INVALID_AD_BLACKLIST_PACK":
      return "マヌケな雑魚♡、パック名の形式が違うわよ（半角英数字とアンダースコア 1〜64 文字にしなさい）！";
    case "AD_BLACKLIST_BOT_OWN_PACK":
      return `マヌケな雑魚♡、${packText}は天才のアタシ自身のステッカーパックよ！ブラックリストに入れるなんて100年早いわ！`;
    case "AD_BLACKLIST_STORAGE_UNAVAILABLE":
      return params?.changed === true && params.persisted === false
        ? `ちぇっ、${kindLabel}${packText}のメモリ上の状態は更新されたけど、ディスク保存の確認に失敗したわ（再起動で消えるかも）。ストレージを確認しなさい、雑魚♡`
        : "ちぇっ、内容ブラックリストのストレージが今忙しいみたい。あとでやり直しなさい、雑魚♡";
    case "AD_BLACKLIST_PREVIEW_NOT_FOUND":
      return "ちぇっ、このステッカー／絵文字パックは Telegram 上で見つからないわよ（削除済みの可能性あり）♡";
    case "AD_BLACKLIST_PREVIEW_UNAVAILABLE":
      return "ちぇっ、今は Telegram からプレビューを取得できないみたい。再試行しなさい、雑魚♡";
    default:
      return null;
  }
}

/**
 * 返回日文（雑魚♡语气）的内容黑名单页面专属文案字典。
 *
 * @returns 日文内容黑名单界面文案对象
 */
export function getJaAdBlacklistsTranslations(): Readonly<MiniAppAdBlacklistsTranslations> {
  return {
    stickerTab: "ステッカー規制",
    emojiTab: "絵文字パック規制",
    refreshButton: "更新",
    searchPlaceholder: "早く言いなさい、雑魚",
    searchClearAria: "検索語をクリア",
    addFoldButton: "内容追加",
    addInputPlaceholder: "はっきり書きなさい、雑魚",
    addButton: "追加",
    addingButton: "追加中…",
    invalidPackNotice:
      "マヌケな雑魚♡、1〜64 文字の半角英数字・アンダースコアのパック名か、有効な t.me/addstickers/…・t.me/addemoji/… リンクを入れなさい！",
    noticeBannerTitle: "操作エラー詳細",
    duplicateBannerTitle: "重複追加ブロック",
    dismissNoticeAria: "通知バナーを閉じる",
    previewPackButtonTitle: (kind: MiniAppAdBlacklistKind): string =>
      kind === "sticker"
        ? "アプリ内でステッカーパックをプレビュー"
        : "アプリ内で絵文字パックをプレビュー",
    previewCountBadge: (count: number): string => `${count} 個`,
    previewStickerTypeLabel: (
      stickerType: MiniAppAdBlacklistStickerSetType
    ): string => {
      switch (stickerType) {
        case "custom_emoji":
          return "カスタム絵文字";
        case "mask":
          return "マスクパック";
        case "regular":
          return "ステッカーパック";
      }
    },
    previewLoadMoreButton: (shown: number, total: number): string =>
      `さらに読み込む（${shown} / ${total}）`,
    previewLoadingMoreButton: "読み込み中…",
    previewRetryButton: "再試行",
    previewCopyLinkButton: "リンクをコピー",
    previewLinkCopiedToast: "ふん、パックのリンクをコピーしてあげたわよ♡",
    previewCopyFailedToast: "ちぇっ、クリップボードに書き込めないわ。手動でコピーしなさい、雑魚♡",
    previewOpenTelegramButton: "Telegram で開く",
    previewCloseButton: "閉じる",
    previewEmptyHint: "このパックの中身は空っぽよ。",
    previewAnimatedTag: "TGS",
    previewVideoTag: "WEBM",
    removeButton: "解除",
    confirmRemovePack: (kind: MiniAppAdBlacklistKind, pack: string): string =>
      `雑魚、本当に${formatJaKindLabel(kind)}「${pack}」を内容ブラックリストから外すの？`,
    emptySearchHint: (query: string): string =>
      `ちぇっ、「${query}」に一致するブラックリスト項目は見つからないわよ。スペルミスじゃないの、雑魚？`,
    emptyListHint: (kind: MiniAppAdBlacklistKind): string =>
      kind === "sticker"
        ? "ステッカーパックの内容ブラックリストは空っぽよ。上の「内容追加」から入れなさい、雑魚♡"
        : "カスタム絵文字パックの内容ブラックリストは空っぽよ。上の「内容追加」から入れなさい、雑魚♡",
  };
}

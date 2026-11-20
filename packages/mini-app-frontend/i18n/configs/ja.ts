import {
  MINI_APP_INVALID_HANDSHAKE_CODE,
  MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE,
} from "../../consts/miniAppCrypto";
import type {
  MiniAppConfigsTranslations,
  MiniAppServerNoticeParams,
} from "../../types/miniAppI18n";

/**
 * 将加密握手与配置编辑相关的服务端状态码格式化为日文提示。
 *
 * @param code 去除前缀后的状态码
 * @param params 可选插值参数
 * @returns 命中时返回日文文案，未命中时返回 `null`
 */
export function formatJaConfigServerNotice(
  code: string,
  params?: Readonly<MiniAppServerNoticeParams>
): string | null {
  switch (code) {
    case "INVALID_ENCRYPTED_PAYLOAD":
      return "暗号化ペイロードの検証に失敗したわ。セッションを再解除してやり直しなさい、雑魚♡";
    case MINI_APP_INVALID_HANDSHAKE_CODE:
      return "一時 ECDH ハンドシェイクの検証に失敗したか期限切れよ。更新してからやり直しなさい♡";
    case MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE:
      return "現在のブラウザまたは Telegram WebView はセキュアコンテキストまたは Ed25519 / X25519 WebCrypto に対応していないわ。クライアントを更新してから開き直しなさい♡";
    case "INVALID_CONFIG_TARGET":
      return "マヌケな雑魚♡、その設定ファイルは編集許可リストに入ってないわよ！";
    case "INVALID_JSON_SYNTAX":
      return params?.errorDetail !== undefined && params.errorDetail.length > 0
        ? `マヌケな雑魚♡、JSON の構文が間違ってるわ：${params.errorDetail}`
        : "マヌケな雑魚♡、JSON 構文が不正よ！構文エラーを直してから保存しなさい！";
    case "CONFIG_VALIDATION_FAILED":
      return params?.errorDetail !== undefined && params.errorDetail.length > 0
        ? `設定スキーマ検証エラー：${params.errorDetail}`
        : "設定フィールドの検証に通らなかったわ。エラー内容を確認して修正しなさい♡";
    case "CONFIG_SAVED":
      return `ふん、${params?.fileName ?? "設定ファイル"} を検証してディスクに保存してあげたわよ♡`;
    case "SERVICE_RESTARTED":
      return "ふん、systemctl restart copy-ninjia を実行したわ！数秒待てば再接続されるわよ♡";
    case "SERVICE_RESTART_FAILED":
      return params?.errorDetail !== undefined && params.errorDetail.length > 0
        ? `ちぇっ、サービス再起動に失敗したわ：${params.errorDetail}`
        : "ちぇっ、systemctl restart copy-ninjia の実行に失敗したわ。権限や稼働状態を確認しなさい♡";
    default:
      return null;
  }
}

/**
 * 返回日文（雑魚♡语气）的配置编辑器专属文案字典。
 *
 * @returns 日文配置编辑界面文案对象
 */
export function getJaConfigsTranslations(): Readonly<MiniAppConfigsTranslations> {
  return {
    dynamicTab: "動的設定",
    staticTab: "静的設定",
    refreshButton: "更新",
    fileSelectorAria: "編集する JSON 設定ファイルを選択",
    fileExistsBadge: "作成済み",
    fileMissingBadge: "未作成",
    dirtyBadge: "未保存の変更",
    missingFileHint: (fileName: string): string =>
      `ディスク上にまだ ${fileName} が存在しないわ。下に正しい JSON を書いて保存すれば新規作成できるわよ♡`,
    editorAriaLabel: (fileName: string): string => `${fileName} JSON コードエディタ`,
    editorPlaceholder: "{\n  \n}",
    lineStatsText: (lineCount: number, byteLength: number): string =>
      `${lineCount} 行 · ${byteLength} B`,
    syntaxValidBadge: "JSON 構文正常",
    syntaxErrorBadge: (line: number, column: number): string =>
      `${line} 行 ${column} 列に構文エラー`,
    syntaxErrorDetail: (line: number, column: number, reason: string): string =>
      `JSON 構文エラー（${line} 行 ${column} 列）：${reason}`,
    emptyJsonError: "マヌケな雑魚♡、設定内容を空欄にはできないわ！有効な JSON オブジェクトを入力しなさい！",
    contentTooLargeError: (maxBytes: number): string =>
      `雑魚♡、設定ファイルサイズが上限（${maxBytes} バイト）を超えてるわよ！`,
    errorBannerTitle: "設定検証・保存エラー詳細",
    formatButton: "整形",
    resetButton: "変更破棄",
    saveButton: "保存",
    confirmDiscardChanges: (fileName: string): string =>
      `雑魚、${fileName} にまだ保存していない変更があるわよ。破棄して切り替えてもいいの？`,
    confirmRestartAfterSave: (fileName: string): string =>
      `静的設定 ${fileName} をディスクに保存したわ。反映させるために今すぐ systemctl restart copy-ninjia でサービスを再起動する？`,
    restartConfirmCancelButton: "後で実行",
    restartConfirmAcceptButton: "今すぐ実行",
    fileDescriptions: {
      "ad_detect.json": "AI 広告検知モデル・プロンプトと閾値設定",
      "agent.json": "AI チャット・マルチモーダル・翻訳モデル設定",
      "assets.json": "ランダム図鑑ディレクトリと静的アセットパス",
      "cron.json": "定期テキスト・画像・音声配信タスク定義",
      "mood.json": "AI 感情プール・ペルソナとローテーション設定",
      "stickers.json": "AI 返信で使用するステッカーパック一覧",
      "bot.json": "Bot トークン・管理者 ID・ポート等の起動設定",
      "g-auth.json": "Google サービスアカウント認証キー情報",
    },
  };
}

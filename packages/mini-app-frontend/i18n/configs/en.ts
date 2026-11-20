import {
  MINI_APP_INVALID_HANDSHAKE_CODE,
  MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE,
} from "../../consts/miniAppCrypto";
import type {
  MiniAppConfigsTranslations,
  MiniAppServerNoticeParams,
} from "../../types/miniAppI18n";

/**
 * 将加密握手与配置编辑相关的服务端状态码格式化为英文提示。
 *
 * @param code 去除前缀后的状态码
 * @param params 可选插值参数
 * @returns 命中时返回英文文案，未命中时返回 `null`
 */
export function formatEnConfigServerNotice(
  code: string,
  params?: Readonly<MiniAppServerNoticeParams>
): string | null {
  switch (code) {
    case "INVALID_ENCRYPTED_PAYLOAD":
      return "Encrypted payload verification failed. Re-unlock your session and try again, Zaako♡";
    case MINI_APP_INVALID_HANDSHAKE_CODE:
      return "Ephemeral ECDH handshake verification failed or expired. Refresh and try unlocking again, Zaako♡";
    case MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE:
      return "This browser or Telegram WebView lacks a secure context or Ed25519 / X25519 WebCrypto support. Please update your client before accessing the panel, Zaako♡";
    case "INVALID_CONFIG_TARGET":
      return "Clueless Zaako♡, that configuration file is not in the editable allowlist!";
    case "INVALID_JSON_SYNTAX":
      return params?.errorDetail !== undefined && params.errorDetail.length > 0
        ? `Clueless Zaako♡, invalid JSON syntax: ${params.errorDetail}`
        : "Clueless Zaako♡, invalid JSON syntax! Fix the syntax before saving!";
    case "CONFIG_VALIDATION_FAILED":
      return params?.errorDetail !== undefined && params.errorDetail.length > 0
        ? `Config schema validation failed: ${params.errorDetail}`
        : "Config schema validation failed. Fix the highlighted fields and save again, Zaako♡";
    case "CONFIG_SAVED":
      return `Hmph, validated and saved ${params?.fileName ?? "config"} to disk for you, Zaako♡`;
    case "SERVICE_RESTARTED":
      return "Hmph, triggered systemctl restart copy-ninjia! Wait a few seconds to reconnect, Zaako♡";
    case "SERVICE_RESTART_FAILED":
      return params?.errorDetail !== undefined && params.errorDetail.length > 0
        ? `Tsk, service restart failed: ${params.errorDetail}`
        : "Tsk, failed to execute systemctl restart copy-ninjia. Check service permissions, Zaako♡";
    default:
      return null;
  }
}

/**
 * 返回英文（Zaako♡ 杂鱼语气）的配置编辑器专属文案字典。
 *
 * @returns 英文配置编辑界面文案对象
 */
export function getEnConfigsTranslations(): Readonly<MiniAppConfigsTranslations> {
  return {
    dynamicTab: "Dynamic",
    staticTab: "Static",
    refreshButton: "Refresh",
    fileSelectorAria: "Select JSON configuration file",
    fileExistsBadge: "On Disk",
    fileMissingBadge: "Not Created",
    dirtyBadge: "Unsaved",
    missingFileHint: (fileName: string): string =>
      `${fileName} does not exist on disk yet. Write valid JSON below and save to create it, Zaako♡`,
    editorAriaLabel: (fileName: string): string => `${fileName} JSON code editor`,
    editorPlaceholder: "{\n  \n}",
    lineStatsText: (lineCount: number, byteLength: number): string =>
      `${lineCount} lines · ${byteLength} B`,
    syntaxValidBadge: "Valid JSON",
    syntaxErrorBadge: (line: number, column: number): string =>
      `Syntax error Ln ${line}, Col ${column}`,
    syntaxErrorDetail: (line: number, column: number, reason: string): string =>
      `JSON syntax error (Line ${line}, Column ${column}): ${reason}`,
    emptyJsonError: "Clueless Zaako♡, config content cannot be blank—enter a valid JSON object!",
    contentTooLargeError: (maxBytes: number): string =>
      `Zaako♡, config size exceeds the ${maxBytes}-byte limit!`,
    errorBannerTitle: "Config Validation & Save Diagnostics",
    formatButton: "Format",
    resetButton: "Discard",
    saveButton: "Save",
    confirmDiscardChanges: (fileName: string): string =>
      `Zaako, you have unsaved edits in ${fileName}. Discard them and switch anyway?`,
    confirmRestartAfterSave: (fileName: string): string =>
      `Static config ${fileName} has been saved to disk. Restart copy-ninjia now (systemctl restart copy-ninjia) so the changes take effect?`,
    restartConfirmCancelButton: "Not Now",
    restartConfirmAcceptButton: "Run Now",
    fileDescriptions: {
      "ad_detect.json": "AI ad detection model, prompt & thresholds",
      "agent.json": "AI chat, multimodal vision & translation endpoints",
      "assets.json": "Gallery directory & static media asset paths",
      "cron.json": "Scheduled group text, image & voice broadcast tasks",
      "mood.json": "AI mood pool, persona prompts & rotation rules",
      "stickers.json": "Telegram sticker pack catalog for AI replies",
      "bot.json": "Bot token, SuperAdmin ID, port & core boot options",
      "g-auth.json": "Google service account credentials & auth keys",
    },
  };
}

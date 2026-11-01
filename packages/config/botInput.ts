/** 安装器与运行时共用的 Bot 配置解码；导入时不读盘、不填充线程缓存。 */

import { DEFAULT_BOT_TIME_ZONE } from "../consts/bot";
import {
  MINI_APP_DEFAULT_HOST,
  MINI_APP_PASSWORD_AT_LEAST_SIX_DIGITS_PATTERN,
  MINI_APP_PASSWORD_PLACEHOLDER,
  MINI_APP_PORT_MAX,
  MINI_APP_PORT_MIN,
} from "../consts/miniApp";
import { BOT_CONFIG_PATH } from "../consts/paths";
import { TELEGRAM_BOT_TOKEN_PLACEHOLDER } from "../consts/telegram";
import { invalidInput, readJsonInput } from "../libs/inputValidation";
import { hasOnlyKeys, isPlainRecord } from "../libs/record";
import type { BotConfig, BotMiniAppConfig } from "../types/config";
import { parseTimeZone } from "./timeZoneInput";

/**
 * 解码可选的 `mini_app` 配置段；缺省返回 undefined，存在但字段非法或含未知键时直接拒绝。
 * @param raw `bot.json` 中的 `mini_app` 原始字段值。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns 严格校验后的 Mini App 配置，或缺省时的 undefined。
 */
function parseBotMiniAppConfig(
  raw: unknown,
  sourcePath: string
): Readonly<BotMiniAppConfig> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainRecord(raw) || !hasOnlyKeys(raw, ["url", "port", "host", "password"])) {
    return invalidInput(sourcePath, "$.mini_app", "{ url, port, host?: string, password }");
  }
  if (typeof raw.url !== "string" || raw.url.trim().length === 0) {
    return invalidInput(sourcePath, "$.mini_app.url", "an absolute https URL");
  }
  const parsedUrl: URL | null = URL.parse(raw.url.trim());
  if (parsedUrl?.protocol !== "https:") {
    return invalidInput(sourcePath, "$.mini_app.url", "an absolute https URL");
  }
  if (
    typeof raw.port !== "number" ||
    !Number.isSafeInteger(raw.port) ||
    raw.port < MINI_APP_PORT_MIN ||
    raw.port > MINI_APP_PORT_MAX
  ) {
    return invalidInput(sourcePath, "$.mini_app.port", "an integer port in 1..65535");
  }
  let host: string = MINI_APP_DEFAULT_HOST;
  if (raw.host !== undefined) {
    if (typeof raw.host !== "string" || raw.host.trim().length === 0) {
      return invalidInput(sourcePath, "$.mini_app.host", "a non-empty string");
    }
    host = raw.host.trim();
  }
  if (
    typeof raw.password !== "string" ||
    raw.password.trim().length === 0 ||
    raw.password.trim() === MINI_APP_PASSWORD_PLACEHOLDER ||
    !MINI_APP_PASSWORD_AT_LEAST_SIX_DIGITS_PATTERN.test(raw.password.trim())
  ) {
    return invalidInput(
      sourcePath,
      "$.mini_app.password",
      "a configured non-empty password string containing at least 6 digits"
    );
  }
  return {
    url: parsedUrl.href,
    host,
    port: raw.port,
    password: raw.password.trim(),
  };
}

/**
 * 解码 config/static/bot.json；风格与 mini_app 缺省保持未配置，未知字段及非法身份、风格、时区和 mini_app 一律拒绝。
 * @param value 待校验的原始 JSON 值。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns 已通过校验的 Bot 配置。
 */
export function parseBotConfig(
  value: unknown,
  sourcePath: string = BOT_CONFIG_PATH
): BotConfig {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["bot_token", "super_admin_user_id", "atmosphere", "time_zone", "mini_app"])) {
    return invalidInput(sourcePath, "$", "{ bot_token, super_admin_user_id, atmosphere?: mesugaki | normal, time_zone?: IANA time zone, mini_app?: { url, port, host?, password } }");
  }
  if (
    typeof value.bot_token !== "string" ||
    value.bot_token.trim().length === 0 ||
    value.bot_token.trim() === TELEGRAM_BOT_TOKEN_PLACEHOLDER
  ) {
    return invalidInput(sourcePath, "$.bot_token", "a configured non-placeholder string");
  }
  if (
    typeof value.super_admin_user_id !== "number" ||
    !Number.isSafeInteger(value.super_admin_user_id) ||
    value.super_admin_user_id <= 0
  ) {
    return invalidInput(sourcePath, "$.super_admin_user_id", "a positive safe integer");
  }
  const atmosphere: unknown = typeof value.atmosphere === "string" ? value.atmosphere.trim() : value.atmosphere;
  if (atmosphere !== undefined && atmosphere !== "mesugaki" && atmosphere !== "normal") {
    return invalidInput(sourcePath, "$.atmosphere", "mesugaki or normal");
  }
  const timeZone: string = parseTimeZone(
    value.time_zone === undefined ? DEFAULT_BOT_TIME_ZONE : value.time_zone,
    sourcePath,
    "$.time_zone"
  );
  const miniApp: Readonly<BotMiniAppConfig> | undefined = parseBotMiniAppConfig(
    value.mini_app,
    sourcePath
  );
  if (miniApp === undefined) {
    return {
      atmosphere,
      botToken: value.bot_token.trim(),
      superAdminUserId: value.super_admin_user_id,
      timeZone,
    };
  }
  return {
    atmosphere,
    botToken: value.bot_token.trim(),
    superAdminUserId: value.super_admin_user_id,
    timeZone,
    miniApp,
  };
}

/**
 * 按指定路径读取并严格解析，不改写运行时快照；目录布局由 config/layout.ts 另行检查。
 * @param path Bot 配置文件路径。
 * @returns 已通过校验的 Bot 配置。
 */
export async function loadBotConfig(
  path: string = BOT_CONFIG_PATH
): Promise<BotConfig> {
  return parseBotConfig(await readJsonInput(path), path);
}

/** `memory/mini-app-totp/totp.json` 的严格读取与 schema 解码；启动校验、安装预检与运行期读取共用，不接触缓存。 */
import {
  MINI_APP_TOTP_RECORD_VERSION,
  MINI_APP_TOTP_SECRET_PATTERN,
} from "../consts/miniAppTotp";
import {
  invalidInput,
  parseJsonInput,
  readOptionalRegularTextInput,
} from "./inputValidation";
import { hasOnlyKeys, isPlainRecord } from "./record";
import type { MiniAppTotpRecord } from "../types/miniAppTotp";

/**
 * 解码并严格校验 `totp.json` 的根对象结构；错误统一以 `InputValidationError` 报告文件路径、
 * 字段路径和期望形态，不回显密钥或原始值。
 * @param value `JSON.parse` 产出的未知根值。
 * @param source 出现在报错里的文件路径。
 * @returns 严格校验后的只读 TOTP 记录对象。
 */
export function decodeMiniAppTotpFile(
  value: unknown,
  source: string
): Readonly<MiniAppTotpRecord> {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["version", "secret", "createdAt"])) {
    return invalidInput(source, "$", "an object with only version, secret, and createdAt");
  }
  if (value.version !== MINI_APP_TOTP_RECORD_VERSION) {
    return invalidInput(source, "$.version", String(MINI_APP_TOTP_RECORD_VERSION));
  }
  const secret: string = typeof value.secret === "string" ? value.secret.trim() : "";
  if (!MINI_APP_TOTP_SECRET_PATTERN.test(secret)) {
    return invalidInput(source, "$.secret", "a 32-character RFC 4648 Base32 secret");
  }
  if (
    typeof value.createdAt !== "number" ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt <= 0
  ) {
    return invalidInput(source, "$.createdAt", "a positive safe integer timestamp");
  }
  return {
    version: MINI_APP_TOTP_RECORD_VERSION,
    secret,
    createdAt: value.createdAt,
  };
}

/**
 * 严格读取并解码 `totp.json`：叶子路径缺失时返回 `null`；软链接、目录、不可访问、非法 UTF-8、
 * 非法 JSON 或 schema 不符时均抛出 `InputValidationError`。
 * @param path `totp.json` 文件路径。
 * @returns 严格校验后的只读 TOTP 记录对象；文件不存在时返回 `null`。
 */
export async function readMiniAppTotpFile(
  path: string
): Promise<Readonly<MiniAppTotpRecord> | null> {
  const rawText: string | null = await readOptionalRegularTextInput(path);
  if (rawText === null) return null;
  return decodeMiniAppTotpFile(parseJsonInput(rawText, path), path);
}

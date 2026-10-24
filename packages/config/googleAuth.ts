import { createPrivateKey } from "node:crypto";
import { GOOGLE_AUTH_FILE_PATH } from "../consts/paths";
import { invalidInput, readJsonInput, requiredString } from "../libs/inputValidation";
import { isPlainRecord } from "../libs/record";
import type { GoogleServiceAccountKey } from "../types/config";

/**
 * SDK 消费的可选字符串字段：缺省不影响其它存在字段的严格校验；存在时按去掉首尾空白后
 * 非空校验，并把 key 里的值换成去空白后的值。
 * @param key 服务账号 JSON 对象副本。
 * @param path 配置文件路径，用于构造致命错误诊断。
 * @param field 待规范化与校验的字段名。
 */
function normalizeOptionalString(key: Record<string, unknown>, path: string, field: string): void {
  if (!Object.hasOwn(key, field)) return;
  key[field] = requiredString(key[field], `$.${field}`, path);
}

/**
 * 解析翻译 SDK 的服务账号凭据；已知字符串字段去掉首尾空白后校验并返回去空白后的值。
 * private_key 的首尾换行属于 PEM 格式本身，按原文交给 SDK；其余字段原样保留。只报告字段
 * 期望，不回显密钥或底层解析错误。
 * @param value 待校验的原始 JSON 值。
 * @param path 服务账号文件路径，用于构造致命错误诊断。
 * @returns 已通过校验与空白规范化的 Google 服务账号密钥对象。
 */
export function parseGoogleServiceAccountKey(
  value: unknown,
  path: string = GOOGLE_AUTH_FILE_PATH
): GoogleServiceAccountKey {
  if (!isPlainRecord(value)) invalidInput(path, "$", "a Google service account JSON object");
  const key: Record<string, unknown> = { ...value };
  if (Object.hasOwn(key, "type")) {
    if (typeof key.type !== "string" || key.type.trim() !== "service_account") {
      invalidInput(path, "$.type", '"service_account"');
    }
    key.type = "service_account";
  }
  key.client_email = requiredString(key.client_email, "$.client_email", path);
  if (typeof key.private_key !== "string" || key.private_key.trim().length === 0) {
    invalidInput(path, "$.private_key", "a parseable non-empty PEM private key");
  }
  let keyType: string | undefined;
  try {
    keyType = createPrivateKey(key.private_key).asymmetricKeyType;
  } catch (_error: unknown) {
    invalidInput(path, "$.private_key", "a parseable non-empty PEM private key");
  }
  if (keyType !== "rsa") invalidInput(path, "$.private_key", "an RSA PEM private key for RS256");
  normalizeOptionalString(key, path, "private_key_id");
  normalizeOptionalString(key, path, "project_id");
  normalizeOptionalString(key, path, "quota_project_id");
  normalizeOptionalString(key, path, "universe_domain");
  return key as unknown as GoogleServiceAccountKey;
}

/**
 * 启动阶段读取并严格解析服务账号文件；外部连接时序见 docs/cn/04-invariants.md。
 * @returns 已通过校验的 Google 服务账号密钥对象。
 */
export async function validateGoogleServiceAccountKey(): Promise<GoogleServiceAccountKey> {
  return parseGoogleServiceAccountKey(await readJsonInput(GOOGLE_AUTH_FILE_PATH), GOOGLE_AUTH_FILE_PATH);
}

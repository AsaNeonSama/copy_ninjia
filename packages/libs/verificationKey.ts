import { KEY_SEPARATOR } from "../consts/verificationKey";

/**
 * 拼装入群验证会话的复合键 `${chatId}:${userId}`。
 * @param chatId 群聊 ID。
 * @param userId 用户 ID。
 * @returns 入群验证复合键字符串。
 */
export function verificationKey(chatId: number, userId: number): string {
  return `${chatId}${KEY_SEPARATOR}${userId}`;
}

/**
 * 某个群的键前缀，供「遍历整表挑出本群条目」的调用点做 `startsWith`；前缀由调用方
 * 提到循环外，格式只有这一处定义。
 * @param chatId 群聊 ID。
 * @returns 该群验证键的前缀字符串。
 */
export function verificationKeyPrefix(chatId: number): string {
  return `${chatId}${KEY_SEPARATOR}`;
}

/**
 * 某个用户的键后缀，供「遍历整表挑出同一用户条目」的调用点做 `endsWith`；后缀由调用方
 * 提到循环外，格式只有这一处定义。
 * @param userId 用户 ID。
 * @returns 该用户验证键的后缀字符串。
 */
export function verificationKeySuffix(userId: number): string {
  return `${KEY_SEPARATOR}${userId}`;
}

/**
 * 判断字符串片段是否为规范十进制整数表示（无前导零、无正号、无空白或指数记法，且禁止 `-0`）。
 * @param part 待校验的十进制数字片段。
 * @returns 为规范十进制整数写法时返回 `true`，否则返回 `false`。
 */
function isCanonicalDecimalInteger(part: string): boolean {
  const length: number = part.length;
  if (length === 0) return false;
  if (part === "0") return true;
  let index: number = 0;
  // 0x2d 为 `-`，0x30–0x39 为 `0`–`9`。
  if (part.charCodeAt(0) === 0x2d) {
    if (length === 1) return false;
    index = 1;
  }
  const firstDigit: number = part.charCodeAt(index);
  if (firstDigit < 0x31 || firstDigit > 0x39) return false;
  for (index += 1; index < length; index += 1) {
    const code: number = part.charCodeAt(index);
    if (code < 0x30 || code > 0x39) return false;
  }
  return true;
}

/** verificationKey 的解析结果。 */
export interface ParsedVerificationKey {
  chatId: number;
  userId: number;
}

/**
 * verificationKey 的逆函数。
 *
 * 用 `lastIndexOf` 定位分隔符；chatId 的负号在首位，不参与分隔。
 * 校验两侧均为规范十进制写法且落在安全整数范围内，拒绝非规范十进制写法。
 *
 * 形状不符一律返回 null；调用方把 null 当成「这个键不可用」处理。
 * @param key 待解析的验证复合键。
 * @returns 解析出的 `{ chatId, userId }`；不合法时返回 `null`。
 */
export function parseVerificationKey(key: string): ParsedVerificationKey | null {
  const separator: number = key.lastIndexOf(KEY_SEPARATOR);
  if (separator <= 0) return null;
  const chatPart: string = key.slice(0, separator);
  const userPart: string = key.slice(separator + 1);
  if (!isCanonicalDecimalInteger(chatPart) || !isCanonicalDecimalInteger(userPart)) return null;
  const chatId: number = Number(chatPart);
  const userId: number = Number(userPart);
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(userId)) return null;
  return { chatId, userId };
}

/**
 * 解析本线程自己用 verificationKey 生成的键；形状不符说明内部表被写坏，按不变量
 * 违例抛错。来自线程外的键仍用 parseVerificationKey 并自行处理 null。
 * @param key 本线程生成的验证复合键。
 * @returns 解析出的 `{ chatId, userId }`。
 */
export function requireVerificationKey(key: string): ParsedVerificationKey {
  const parsed: ParsedVerificationKey | null = parseVerificationKey(key);
  if (parsed === null) throw new Error(`Verification key was not produced by verificationKey: ${key}`);
  return parsed;
}

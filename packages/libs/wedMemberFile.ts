/** `memory/wed/<chatId>.json` 的严格解码与序列化；DiskIO 启动校验、落盘与冷迁移共用，不接触缓存。 */
import { WED_MEMBER_LIMIT } from "../consts/wed";
import { invalidInput } from "./inputValidation";
import { hasExactKeys, isPlainRecord } from "./record";
import { isTelegramGroupChatId } from "./telegramId";
import type { WedMemberEntry } from "../types/wed";

/** 解码以 `.json` 结尾的目录项名：前缀必须是规范十进制的负安全整数群 ID，返回该群 ID。 */
export function parseWedMemberFileName(name: string, path: string): number {
  const chatIdText: string = name.slice(0, -".json".length);
  const chatId: number = Number(chatIdText);
  if (!isTelegramGroupChatId(chatId) || String(chatId) !== chatIdText) {
    return invalidInput(path, "$filename", "the canonical <negative safe integer chatId>.json form");
  }
  return chatId;
}

/**
 * 解码一份成员滑窗文件：至多 WED_MEMBER_LIMIT 项，每项恰为 `{ id, enteredAt }`；id 为不重复的正安全
 * 整数，enteredAt 为非负安全整数毫秒且按数组顺序不减。返回按数组顺序插入的 ID → 进入时间。
 */
export function parseWedMemberFile(parsed: unknown, path: string): Map<number, number> {
  if (!Array.isArray(parsed) || parsed.length > WED_MEMBER_LIMIT) {
    return invalidInput(path, "$", `an array of at most ${WED_MEMBER_LIMIT} { id, enteredAt } member entries`);
  }
  const members: Map<number, number> = new Map();
  let previousEnteredAt: number = 0;
  for (let index: number = 0; index < parsed.length; index++) {
    const entry: unknown = parsed[index];
    if (!isPlainRecord(entry) || !hasExactKeys(entry, ["id", "enteredAt"])) {
      return invalidInput(path, `$[${index}]`, "an object with exactly id and enteredAt");
    }
    const id: unknown = entry.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || members.has(id)) {
      return invalidInput(path, `$[${index}].id`, "a unique positive safe integer user ID");
    }
    const enteredAt: unknown = entry.enteredAt;
    if (typeof enteredAt !== "number" || !Number.isSafeInteger(enteredAt) || enteredAt < previousEnteredAt) {
      return invalidInput(
        path,
        `$[${index}].enteredAt`,
        "a non-negative safe integer Unix millisecond timestamp not earlier than the previous entry"
      );
    }
    members.set(id, enteredAt);
    previousEnteredAt = enteredAt;
  }
  return members;
}

/** 把按进入顺序交替排列的 `[id0, enteredAt0, id1, enteredAt1, ...]` 写成文件正文。 */
export function serializeWedMemberEntries(entries: readonly number[]): string {
  const members: WedMemberEntry[] = [];
  for (let index: number = 0; index < entries.length; index += 2) {
    members.push({ id: entries[index]!, enteredAt: entries[index + 1]! });
  }
  return JSON.stringify(members);
}

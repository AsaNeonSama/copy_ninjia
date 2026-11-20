/**
 * 追着删目标清单纯函数增删规则单元测试（`/delete_message` 与 Mini App 共用唯一来源）。
 */

import { describe, expect, test } from "bun:test";
import { DELETE_MESSAGE_CHAT_TARGET_MAX } from "../../packages/consts/deleteMessage";
import {
  addDeleteMessageTargetId,
  removeDeleteMessageTargetId,
} from "../../packages/commands/deleteMessage/targets";

describe("deleteMessageTargets 单一来源纯函数", (): void => {
  test("空清单新增返回单元素数组，已有清单追加且不改写原数组", (): void => {
    const addedEmpty = addDeleteMessageTargetId(undefined, 101);
    expect(addedEmpty).toEqual({ ok: true, next: [101] });

    const original: readonly number[] = [101, -1002];
    const addedSecond = addDeleteMessageTargetId(original, 202);
    expect(addedSecond).toEqual({ ok: true, next: [101, -1002, 202] });
    expect(original).toEqual([101, -1002]);
  });

  test("重复目标返回 exists，满 DELETE_MESSAGE_CHAT_TARGET_MAX 上限返回 capacity", (): void => {
    expect(addDeleteMessageTargetId([101, 202], 202)).toEqual({
      ok: false,
      reason: "exists",
    });

    const full: readonly number[] = Array.from(
      { length: DELETE_MESSAGE_CHAT_TARGET_MAX },
      (_item: undefined, index: number): number => index + 1
    );
    expect(addDeleteMessageTargetId(full, 99_999)).toEqual({
      ok: false,
      reason: "capacity",
    });
  });

  test("不存在的目标移除返回 absent，移除后留空归一化为 undefined", (): void => {
    expect(removeDeleteMessageTargetId(undefined, 101)).toEqual({
      ok: false,
      reason: "absent",
    });
    expect(removeDeleteMessageTargetId([101], 202)).toEqual({
      ok: false,
      reason: "absent",
    });

    const original: readonly number[] = [101, 202];
    expect(removeDeleteMessageTargetId(original, 101)).toEqual({
      ok: true,
      next: [202],
    });
    expect(original).toEqual([101, 202]);

    expect(removeDeleteMessageTargetId([101], 101)).toEqual({
      ok: true,
      next: undefined,
    });
  });
});

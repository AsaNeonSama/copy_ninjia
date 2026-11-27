/**
 * `packages/libs/pagination.ts` 与 `packages/libs/stickerPackNames.ts`、
 * `packages/libs/messageDeletion.ts` 公共纯函数单元测试。
 */
import { describe, expect, test } from "bun:test";
import { TELEGRAM_DELETE_MESSAGES_BATCH_MAX } from "../../packages/consts/telegram";
import { deleteMessageIdBatches } from "../../packages/libs/messageDeletion";
import {
  clampPageSize,
  clampRequestedPage,
  overlayCursorPage,
  totalPagesFor,
} from "../../packages/libs/pagination";
import {
  collectValidStickerPackNames,
  deduplicatePreservingOrder,
} from "../../packages/libs/stickerPackNames";

describe("libs/pagination", () => {
  test("clampPageSize / clampRequestedPage / totalPagesFor 准确处理缺省、非有限值与边界裁剪", () => {
    expect(clampPageSize(undefined, 20, 100)).toBe(20);
    expect(clampPageSize(Number.NaN, 20, 100)).toBe(20);
    expect(clampPageSize(0, 20, 100)).toBe(1);
    expect(clampPageSize(-10, 20, 100)).toBe(1);
    expect(clampPageSize(25.9, 20, 100)).toBe(25);
    expect(clampPageSize(999, 20, 100)).toBe(100);

    expect(clampRequestedPage(undefined)).toBe(1);
    expect(clampRequestedPage(Number.NaN)).toBe(1);
    expect(clampRequestedPage(0)).toBe(1);
    expect(clampRequestedPage(-3)).toBe(1);
    expect(clampRequestedPage(4.8)).toBe(4);

    expect(totalPagesFor(0, 20)).toBe(1);
    expect(totalPagesFor(1, 20)).toBe(1);
    expect(totalPagesFor(20, 20)).toBe(1);
    expect(totalPagesFor(21, 20)).toBe(2);
  });

  test("overlayCursorPage 正确叠加未确认增删并保持游标边界与升序", () => {
    const compareNumbers = (left: number, right: number): number => left - right;
    const baseItems: readonly number[] = [10, 20, 30];

    // 无未确认写入时直接复用原列表。
    const untouched = overlayCursorPage({
      items: baseItems,
      afterCursor: 5,
      nextCursor: 30,
      done: false,
      pendingWrites: new Map<number, boolean>(),
      isDeleted: (alive: boolean): boolean => !alive,
      compare: compareNumbers,
    });
    expect(untouched.items).toBe(baseItems);
    expect(untouched.nextCursor).toBe(30);

    // 非末页：忽略 <= afterCursor 与 > nextCursor 的新增，删掉已删除项，保留落在本页区间的项。
    const midPage = overlayCursorPage({
      items: baseItems,
      afterCursor: 5,
      nextCursor: 30,
      done: false,
      pendingWrites: new Map<number, boolean>([
        [3, true],
        [5, true],
        [15, true],
        [20, false],
        [35, true],
      ]),
      isDeleted: (alive: boolean): boolean => !alive,
      compare: compareNumbers,
    });
    expect(midPage).toEqual({
      items: [10, 15, 30],
      nextCursor: 30,
      done: false,
    });

    // 末页：纳入 > afterCursor 的尾部新增并更新 nextCursor；全删空时游标回退到 afterCursor。
    const tailPage = overlayCursorPage({
      items: [10],
      afterCursor: 5,
      nextCursor: 10,
      done: true,
      pendingWrites: new Map<number, boolean>([
        [10, false],
        [25, true],
      ]),
      isDeleted: (alive: boolean): boolean => !alive,
      compare: compareNumbers,
    });
    expect(tailPage).toEqual({ items: [25], nextCursor: 25, done: true });

    const emptiedTail = overlayCursorPage({
      items: [10],
      afterCursor: 5,
      nextCursor: 10,
      done: true,
      pendingWrites: new Map<number, boolean>([[10, false]]),
      isDeleted: (alive: boolean): boolean => !alive,
      compare: compareNumbers,
    });
    expect(emptiedTail).toEqual({ items: [], nextCursor: 5, done: true });
  });
});

describe("libs/stickerPackNames 与 libs/messageDeletion", () => {
  test("deduplicatePreservingOrder 与 collectValidStickerPackNames 保序去重、裁剪并过滤候选", () => {
    expect(deduplicatePreservingOrder(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"]);
    expect(
      collectValidStickerPackNames(["  Pack_One  ", "bad pack!", "Pack_One", "Pack_Two"], {
        trim: true,
      })
    ).toEqual(["Pack_One", "Pack_Two"]);
    expect(
      collectValidStickerPackNames(["Pack_One", "Pack_Two", "Pack_One"], {
        allowed: new Set<string>(["Pack_One"]),
      })
    ).toEqual(["Pack_One"]);
  });

  test("deleteMessageIdBatches 单批透传原数组，超上限分批调用并统计失败批次数", async () => {
    expect(await deleteMessageIdBatches([], async (): Promise<boolean> => false)).toBe(0);

    const small: readonly number[] = [1, 2, 3];
    const seenSmall: (readonly number[])[] = [];
    expect(
      await deleteMessageIdBatches(small, async (batch: readonly number[]): Promise<boolean> => {
        seenSmall.push(batch);
        return true;
      })
    ).toBe(0);
    expect(seenSmall).toHaveLength(1);
    expect(seenSmall[0]).toBe(small);

    const large: number[] = Array.from(
      { length: TELEGRAM_DELETE_MESSAGES_BATCH_MAX + 5 },
      (_: unknown, index: number): number => index + 1
    );
    const sizes: number[] = [];
    let call: number = 0;
    const failed: number = await deleteMessageIdBatches(
      large,
      async (batch: readonly number[]): Promise<boolean> => {
        sizes.push(batch.length);
        call += 1;
        return call === 1;
      }
    );
    expect(sizes).toEqual([TELEGRAM_DELETE_MESSAGES_BATCH_MAX, 5]);
    expect(failed).toBe(1);
  });
});

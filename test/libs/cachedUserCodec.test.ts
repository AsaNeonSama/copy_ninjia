import { describe, expect, test } from "bun:test";
import { decodeCachedUser } from "../../packages/libs/cachedUserCodec";
import { InputValidationError } from "../../packages/libs/inputValidation";
import type { InputFieldContext } from "../../packages/libs/inputValidation";
import type { CachedUser } from "../../packages/types/chatState";

/** 夹具来源与字段路径：报错文案只应带出这两项和期望形态。 */
const CONTEXT: InputFieldContext = { source: "memory/global/state.json", path: "$.copy.copiedUser" };

/** 捕获解码抛出的错误；没抛就让断言失败。 */
function decodeError(value: unknown): InputValidationError {
  try {
    decodeCachedUser(value, CONTEXT);
  } catch (error: unknown) {
    if (error instanceof InputValidationError) return error;
    throw error;
  }
  throw new Error("expected decodeCachedUser to reject");
}

describe("decodeCachedUser：合法输入", () => {
  test("全字段对象逐项带回，键按固定顺序构造", () => {
    const user: CachedUser = decodeCachedUser(
      { isChannel: false, title: "群名", last_name: "B", first_name: "A", username: "alice", id: 42 },
      CONTEXT
    );

    expect(user).toEqual({ id: 42, username: "alice", first_name: "A", last_name: "B", title: "群名", isChannel: false });
    expect(Object.keys(user)).toEqual(Object.keys(decodeCachedUser({ id: 1 }, CONTEXT)));
  });

  test("只有 id 时其余可选字段为 undefined", () => {
    const user: CachedUser = decodeCachedUser({ id: 7 }, CONTEXT);

    expect(user.id).toBe(7);
    expect(user.username).toBeUndefined();
    expect(user.first_name).toBeUndefined();
    expect(user.last_name).toBeUndefined();
    expect(user.title).toBeUndefined();
    expect(user.isChannel).toBeUndefined();
  });

  test("频道等负数 id 合法，isChannel 为 true 原样保留", () => {
    const user: CachedUser = decodeCachedUser({ id: -1001234, title: "频道", isChannel: true }, CONTEXT);

    expect(user).toEqual({ id: -1001234, title: "频道", isChannel: true });
  });

  test("字符串按 Telegram 原样保留：空串与首尾空白都不规范化", () => {
    const user: CachedUser = decodeCachedUser({ id: 9, first_name: "", last_name: "  尾随 ", username: " " }, CONTEXT);

    expect(user.first_name).toBe("");
    expect(user.last_name).toBe("  尾随 ");
    expect(user.username).toBe(" ");
  });

  test("安全整数上下界本身合法", () => {
    expect(decodeCachedUser({ id: Number.MAX_SAFE_INTEGER }, CONTEXT).id).toBe(Number.MAX_SAFE_INTEGER);
    expect(decodeCachedUser({ id: Number.MIN_SAFE_INTEGER }, CONTEXT).id).toBe(Number.MIN_SAFE_INTEGER);
  });
});

describe("decodeCachedUser：拒绝非法输入", () => {
  test("不是普通对象时按对象路径报错", () => {
    for (const value of [null, undefined, 42, "user", [], [{ id: 1 }]]) {
      const error: InputValidationError = decodeError(value);
      expect(error.message.startsWith(`${CONTEXT.source}: ${CONTEXT.path} must be `)).toBeTrue();
    }
  });

  test("出现 schema 之外的键即拒绝，按对象路径报错", () => {
    const error: InputValidationError = decodeError({ id: 1, is_bot: false });

    expect(error.message.startsWith(`${CONTEXT.source}: ${CONTEXT.path} must be `)).toBeTrue();
  });

  test("id 缺失、为 0、非整数、越过安全整数或类型不符时按 .id 路径报错", () => {
    const invalidIds: readonly unknown[] = [
      undefined,
      0,
      -0,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      "42",
      42n,
      null,
    ];
    for (const id of invalidIds) {
      const value: Record<string, unknown> = id === undefined ? { username: "alice" } : { id };
      expect(decodeError(value).message.startsWith(`${CONTEXT.source}: ${CONTEXT.path}.id must be `)).toBeTrue();
    }
  });

  test("可选字段存在但类型不符时按各自字段路径报错", () => {
    const cases: readonly (readonly [string, unknown])[] = [
      ["username", 1],
      ["first_name", null],
      ["last_name", false],
      ["title", ["群"]],
      ["isChannel", "true"],
      ["isChannel", 1],
    ];
    for (const [key, field] of cases) {
      const error: InputValidationError = decodeError({ id: 1, [key]: field });
      expect(error.message.startsWith(`${CONTEXT.source}: ${CONTEXT.path}.${key} must be `)).toBeTrue();
    }
  });

  test("报错文案不回显非法取值", () => {
    const secret: string = "leaked-token-value";

    expect(decodeError({ id: secret }).message).not.toContain(secret);
    expect(decodeError({ id: 1, username: { secret } }).message).not.toContain(secret);
  });
});

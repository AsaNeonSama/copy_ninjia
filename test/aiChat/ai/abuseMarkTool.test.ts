/**
 * abuse_mark 拒答冷却工具的声明、目标校验、onAbuseMark 回传与冷处理通知发送：
 * - 工具声明始终挂载，说明与参数描述与常量一致
 * - user_id 必须是当前轮触发用户（triggerSenderId），拒绝非安全整数、0、非当前触发者、机器人自身与超级管理员
 * - 命中后同步触发 onAbuseMark(userId)，再经动作链发出冷处理通知并计入本轮动作与滚动记忆（用户明确授权的长期保留例外，不挂 30 秒自删）
 * - 通知文案按通知风格（teasing / plain）分派，继承本轮 replyToMessageId 与 messageThreadId
 * - 直接轮首条动作经过 typing 节奏停顿
 */
import {
  deleteMessageMock,
  resetReplyToolsetMocks,
  sendMessageMock,
} from "../../helpers/replyToolsetMocks";
import { executeAndSettle } from "../../helpers/replyToolExecution";
import { replyToolContextFixture } from "../../helpers/replyToolContext";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const { ABUSE_MARK_TOOL } = await import("../../../packages/consts/tools");
const {
  ABUSE_MARK_TOOL_INSTRUCTION,
  ABUSE_MARK_USER_ID_DESCRIPTION,
} = await import("../../../packages/consts/aiChat/prompts/tools");
const { ABUSE_MARK_NOTICE_TEXT: TEASING_ABUSE_MARK_NOTICE_TEXT } =
  await import("../../../packages/consts/atmosphere/teasing/aiChat_rateLimit");
const { ABUSE_MARK_NOTICE_TEXT: PLAIN_ABUSE_MARK_NOTICE_TEXT } =
  await import("../../../packages/consts/atmosphere/plain/aiChat_rateLimit");
const {
  atmosphereState,
  botInfoState,
  superAdminUserIdState,
} = await import("../../../packages/cache/workers/aiChat/identity");
const { createReplyToolset } = await import("../../../packages/aiChat/ai/tools/replyToolset/orchestrator");

beforeEach(() => {
  resetReplyToolsetMocks();
  atmosphereState.current = null;
  botInfoState.current = { id: 999_000, username: "ninjia_bot", first_name: "Ninjia" };
  superAdminUserIdState.current = 42;
});

afterEach(() => {
  atmosphereState.current = null;
  botInfoState.current = null;
  superAdminUserIdState.current = null;
});

describe("abuse_mark 工具", () => {
  test("工具集挂载 abuse_mark 声明且支持同步分派", async () => {
    const toolset = await createReplyToolset(replyToolContextFixture());
    const declaration = toolset.functions.find((item) => item.name === ABUSE_MARK_TOOL);
    expect(declaration).toEqual({
      name: ABUSE_MARK_TOOL,
      description: ABUSE_MARK_TOOL_INSTRUCTION,
      parametersJsonSchema: {
        type: "object",
        properties: {
          user_id: {
            type: "integer",
            description: ABUSE_MARK_USER_ID_DESCRIPTION,
          },
        },
        required: ["user_id"],
      },
    });
    expect(toolset.has(ABUSE_MARK_TOOL)).toBe(true);
  });

  test("拒绝缺失、非整数、0、非当前触发者、机器人自身及超级管理员的 user_id", async () => {
    const onAbuseMark = mock((_userId: number): void => {});
    const toolset = await createReplyToolset(replyToolContextFixture({
      triggerSenderId: 1001,
      onAbuseMark,
    }));

    for (const invalidArgs of [
      "{}",
      "not-json",
      JSON.stringify({ user_id: "1001" }),
      JSON.stringify({ user_id: 1.5 }),
      JSON.stringify({ user_id: 0 }),
      JSON.stringify({ user_id: -5 }),
      JSON.stringify({ user_id: 2002 }),
      JSON.stringify({ user_id: 999_000 }),
      JSON.stringify({ user_id: 42 }),
    ]) {
      const result = JSON.parse(await executeAndSettle(toolset, ABUSE_MARK_TOOL, invalidArgs));
      expect(typeof result.error).toBe("string");
    }

    // 触发者身份未知（triggerSenderId === 0）时，即使传入 user_id: 0 也必须拒绝标记。
    const unknownSenderToolset = await createReplyToolset(replyToolContextFixture({
      triggerSenderId: 0,
      onAbuseMark,
    }));
    const unknownSenderResult = JSON.parse(
      await executeAndSettle(unknownSenderToolset, ABUSE_MARK_TOOL, JSON.stringify({ user_id: 0 }))
    );
    expect(typeof unknownSenderResult.error).toBe("string");

    // 即使 triggerSenderId 恰好是超级管理员，也必须拒绝标记。
    const adminToolset = await createReplyToolset(replyToolContextFixture({
      triggerSenderId: 42,
      onAbuseMark,
    }));
    const adminResult = JSON.parse(
      await executeAndSettle(adminToolset, ABUSE_MARK_TOOL, JSON.stringify({ user_id: 42 }))
    );
    expect(typeof adminResult.error).toBe("string");

    // 即使 triggerSenderId 恰好等于机器人自身 ID，也必须拒绝标记。
    const botToolset = await createReplyToolset(replyToolContextFixture({
      triggerSenderId: 999_000,
      onAbuseMark,
    }));
    const botResult = JSON.parse(
      await executeAndSettle(botToolset, ABUSE_MARK_TOOL, JSON.stringify({ user_id: 999_000 }))
    );
    expect(typeof botResult.error).toBe("string");

    expect(onAbuseMark).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test("命中当前触发用户时回传 onAbuseMark，按 teasing 与 plain 语气发送长期保留的冷处理通知并记入滚动记忆", async () => {
    for (const [atmosphere, expectedText] of [
      ["teasing", TEASING_ABUSE_MARK_NOTICE_TEXT],
      ["plain", PLAIN_ABUSE_MARK_NOTICE_TEXT],
    ] as const) {
      resetReplyToolsetMocks();
      atmosphereState.current = atmosphere;
      const onAbuseMark = mock((_userId: number): void => {});
      const onMessageSent = mock((..._args: unknown[]): void => {});
      const phases: string[] = [];

      const toolset = await createReplyToolset(replyToolContextFixture({
        chatId: -100800,
        triggerSenderId: 1001,
        replyToMessageId: 77,
        messageThreadId: 321,
        direct: true,
        chatAction: {
          set: (phase): number => {
            phases.push(phase);
            return 0;
          },
          settle: async (): Promise<void> => {},
        },
        onAbuseMark,
        onMessageSent,
      }));

      const result = JSON.parse(
        await executeAndSettle(toolset, ABUSE_MARK_TOOL, JSON.stringify({ user_id: 1001 }))
      );

      expect(result).toEqual({
        success: true,
        queued: true,
        actions_used: 1,
      });
      expect(onAbuseMark).toHaveBeenCalledTimes(1);
      expect(onAbuseMark).toHaveBeenCalledWith(1001);
      expect(toolset.actionsUsed()).toBe(1);
      expect(toolset.actionsCompleted()).toBe(1);
      // 用户明确授权的长期保留例外：abuse_mark 通知作为会话性 AI 回复直接通过 sendMessageWithResult 发送，
      // 携带 replyToMessageId 与 messageThreadId，不挂 30 秒延迟删除，并经 onMessageSent 记入滚动记忆。
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledWith({
        chatId: -100800,
        text: expectedText,
        replyToMessageId: 77,
        messageThreadId: 321,
      });
      expect(onMessageSent).toHaveBeenCalledTimes(1);
      expect(onMessageSent).toHaveBeenCalledWith(expectedText, 100, 77);
      expect(deleteMessageMock).not.toHaveBeenCalled();
      expect(phases[0]).toBe("typing");
    }
  });
});

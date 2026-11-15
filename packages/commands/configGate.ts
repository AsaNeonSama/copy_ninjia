/**
 * 功能依赖的部署配置不可用时的统一拒绝点。
 *
 * 启动预检已拒绝存在但非法的部署输入；本边界读取各功能的 readiness，
 * 对缺省或能力不完整的配置发送拒绝回执并记录诊断，不改变功能状态。
 */

import { logger } from "../infra/logger";
import { sendCommandMessage } from "../infra/telegram";
import type { ConfigReadiness } from "../types/config";

/** 检查功能部署配置就绪度并在不可用时发送拒绝回执的参数。 */
export interface RefuseIfConfigBrokenParams {
  /** 本次判定的结论，由各功能自己的 readiness 函数给出。 */
  readiness: ConfigReadiness;
  /** 触发命令所在群或会话的 chatId。 */
  chatId: number;
  /** 触发这条命令的消息，用于挂回复引用；私聊/频道场景可能没有。 */
  messageId: number | undefined;
  /** 出现在英文错误日志里的功能名，如 `AI chat`。 */
  feature: string;
  /** 拒绝文案；参数是不可用的那份文件的相对路径，文案原样带出该路径。 */
  text: (file: string) => string;
}

/**
 * 校验功能部署配置是否就绪：就绪时直接返回 `false`；不可用时记录错误日志、向群内回复指明问题文件的拒绝提示并返回 `true`。
 * @param params 就绪度结论 `readiness`、目标会话 `chatId`、触发消息 `messageId`、日志功能名 `feature` 与拒绝文案构造函数 `text`。
 * @returns 已发送拒绝回执时返回 `true`（调用方应直接结束，不改动任何状态）；配置就绪时返回 `false`。
 */
export async function refuseIfConfigBroken({
  readiness,
  chatId,
  messageId,
  feature,
  text,
}: RefuseIfConfigBrokenParams): Promise<boolean> {
  if (readiness.ok) return false;
  logger.error(
    `${feature} is unavailable in chat ${chatId}: ${readiness.failure.file} is unusable — ${readiness.failure.reason}`
  );
  await sendCommandMessage({ chatId, text: text(readiness.failure.file), replyToMessageId: messageId });
  return true;
}

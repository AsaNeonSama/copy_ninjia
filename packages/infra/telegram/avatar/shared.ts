import { GrammyError, InputFile } from "grammy";
import type { InputProfilePhoto } from "grammy/types";
import {
  AVATAR_FETCH_MAX_ATTEMPTS,
  BOT_PROFILE_ANIMATION_FILE_NAME,
  BOT_PROFILE_PHOTO_FILE_NAME,
} from "../../../consts/telegram";
import { telegramSignal } from "../../../libs/telegramSignal";
import { bot } from "../mainClient";

/** 单次头像操作的结果：区分可重试故障与确定性失败。 */
export type AvatarOperationAttemptResult = "ok" | "transient-failure" | "permanent-failure";

/**
 * 头像操作异常的重试分类：Bot API 请求参数拒绝归为 `permanent-failure`，其余错误归为 `transient-failure`。
 * @param error 捕获到的异常值。
 * @returns 400 参数拒绝返回 "permanent-failure"，其余错误返回 "transient-failure"。
 */
export function avatarFailureFor(error: unknown): "transient-failure" | "permanent-failure" {
  return error instanceof GrammyError && error.error_code === 400 ? "permanent-failure" : "transient-failure";
}

/** 有界头像重试的最终结果；`aborted` 表示某次尝试开始前取消信号已经触发。 */
export type AvatarFetchAttemptsOutcome = "ok" | "failed" | "aborted";

/**
 * 按 `AVATAR_FETCH_MAX_ATTEMPTS` 有界重试一次头像操作：
 * 每次尝试前检查取消信号，`ok` 或 `permanent-failure` 立即终止，仅 `transient-failure` 继续重试。
 * @param attempt 接收从 1 开始的尝试次号并执行单次头像操作的回调。
 * @param signal 调用方的取消信号。
 * @returns 成功返回 "ok"，被取消返回 "aborted"，耗尽重试或确定性失败返回 "failed"。
 */
export async function runAvatarFetchAttempts(
  attempt: (attemptNumber: number) => Promise<AvatarOperationAttemptResult>,
  signal?: AbortSignal
): Promise<AvatarFetchAttemptsOutcome> {
  for (let attemptNumber: number = 1; attemptNumber <= AVATAR_FETCH_MAX_ATTEMPTS; attemptNumber++) {
    if (signal?.aborted) return "aborted";
    const result: AvatarOperationAttemptResult = await attempt(attemptNumber);
    if (result === "ok") return "ok";
    if (result === "permanent-failure") return "failed";
  }
  return "failed";
}

/**
 * 将素材字节上传为机器人头像（`static` 使用 `BOT_PROFILE_PHOTO_FILE_NAME`，
 * `animated` 使用 `BOT_PROFILE_ANIMATION_FILE_NAME`）。
 * @param bytes 头像素材字节。
 * @param type 头像形态（"static" 或 "animated"）。
 * @param signal 调用方的取消信号。
 */
export async function setBotProfilePhoto(
  bytes: Uint8Array,
  type: InputProfilePhoto["type"],
  signal?: AbortSignal
): Promise<void> {
  const photo: InputProfilePhoto = type === "animated"
    ? { type, animation: new InputFile(bytes, BOT_PROFILE_ANIMATION_FILE_NAME) }
    : { type, photo: new InputFile(bytes, BOT_PROFILE_PHOTO_FILE_NAME) };
  await bot.api.setMyProfilePhoto(photo, telegramSignal(signal));
}

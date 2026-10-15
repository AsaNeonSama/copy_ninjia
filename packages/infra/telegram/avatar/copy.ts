import { GrammyError } from "grammy";
import type { ChatFullInfo } from "grammy/types";
import { AVATAR_FETCH_MAX_ATTEMPTS } from "../../../consts/telegram";
import { logger } from "../../logger";
import { logApiError } from "../client";
import { bot } from "../mainClient";
import { telegramSignal } from "../../../libs/telegramSignal";
import { downloadAvatarFile } from "./download";
import type { AvatarDownloadResult } from "../../../types/telegram";
import { avatarFailureFor, runAvatarFetchAttempts, setBotProfilePhoto } from "./shared";
import type {
  AvatarFetchAttemptsOutcome,
  AvatarOperationAttemptResult,
} from "./shared";
import {
  extractPublicUsername,
  fetchAvatarFromWebProfile,
  normalizePublicUsername,
} from "./webProfile";

interface PublicUsernameLookupResult {
  username?: string;
  failed: boolean;
}

interface AttemptCopyUserProfilePhotoResult {
  readonly result: AvatarOperationAttemptResult;
  readonly chat: ChatFullInfo | undefined;
}

async function resolvePublicUsernameFromChat(
  targetId: number,
  isChannel: boolean,
  signal?: AbortSignal
): Promise<PublicUsernameLookupResult> {
  try {
    const chat: ChatFullInfo = await bot.api.getChat(targetId, telegramSignal(signal));
    return { username: extractPublicUsername(chat), failed: false };
  } catch (error: unknown) {
    if (signal?.aborted) return { failed: true };
    if (error instanceof GrammyError) {
      if (error.error_code === 403) {
        logger.warn(`Could not check ${isChannel ? "channel" : "user"} ${targetId} public username via getChat: 403 Forbidden (chat is not accessible to the bot)`);
      } else {
        logger.error(`Could not check ${isChannel ? "channel" : "user"} ${targetId} public username via getChat: ${error.error_code} ${error.description}`);
      }
    } else {
      logger.error(`Could not check ${isChannel ? "channel" : "user"} ${targetId} public username via getChat:`, error);
    }
    return { failed: true };
  }
}

async function attemptCopyUserProfilePhoto(
  targetId: number,
  isChannel: boolean,
  signal?: AbortSignal
): Promise<AttemptCopyUserProfilePhotoResult> {
  let chat: ChatFullInfo | undefined;
  try {
    if (signal?.aborted) return { result: "permanent-failure", chat: undefined };
    chat = await bot.api.getChat(targetId, telegramSignal(signal));
    if (!chat.photo) {
      logger.log(`${isChannel ? "Channel" : "User"} ${targetId} has no chat photo visible to the bot`);
      return { result: "permanent-failure", chat };
    }

    const download: AvatarDownloadResult = await downloadAvatarFile(chat.photo.big_file_id, targetId, signal);
    if (download.status !== "ok") return { result: download.status, chat };

    await setBotProfilePhoto(download.bytes, "static", signal);
    return { result: "ok", chat };
  } catch (error: unknown) {
    if (signal?.aborted) return { result: "permanent-failure", chat };
    logApiError("copy user profile photo", error);
    return { result: avatarFailureFor(error), chat };
  }
}

/** 复制用户头像时由调用方提供的诊断线索和取消信号。 */
export interface CopyUserProfilePhotoOptions {
  /**
   * 调用方上下文里带的 username（回复目标、身份缓存），只作诊断线索，不作抓取目标。
   */
  username?: string;
  signal?: AbortSignal;
}

/**
 * 复制用户或频道的当前头像。优先通过 Bot API 读取并下载当前 ChatPhoto，失败后用
 * getChat 的公开 username（优先复用尝试阶段已取得的结果，未取得时现查一次）抓取 t.me 页面兜底。
 */
export async function copyUserProfilePhoto(
  targetId: number,
  isChannel: boolean = false,
  options: CopyUserProfilePhotoOptions = {}
): Promise<boolean> {
  const { username, signal }: CopyUserProfilePhotoOptions = options;
  let lastChat: ChatFullInfo | undefined;
  const outcome: AvatarFetchAttemptsOutcome = await runAvatarFetchAttempts(
    async (attempt: number): Promise<AvatarOperationAttemptResult> => {
      const { result, chat }: AttemptCopyUserProfilePhotoResult = await attemptCopyUserProfilePhoto(targetId, isChannel, signal);
      if (chat !== undefined) lastChat = chat;
      if (result !== "ok") {
        logger.log(`copyUserProfilePhoto attempt ${attempt}/${AVATAR_FETCH_MAX_ATTEMPTS} failed for ${isChannel ? "channel" : "user"} ${targetId}`);
      }
      return result;
    },
    signal
  );
  if (outcome === "ok") return true;
  if (outcome === "aborted") return false;

  // 抓取目标只取 getChat 的结果（优先复用尝试阶段已取得的 chat，未取得时现查一次），
  // 不用调用方给的 username（它来自回复目标或身份缓存，不能证明仍指向 targetId）。
  const lookup: PublicUsernameLookupResult = lastChat !== undefined
    ? { username: extractPublicUsername(lastChat), failed: false }
    : await resolvePublicUsernameFromChat(targetId, isChannel, signal);
  const fallbackUsername: string | undefined = lookup.username;
  if (fallbackUsername) {
    logger.log(`Falling back to t.me web profile scrape for @${fallbackUsername}`);
    const imgBuffer: Uint8Array | null = await fetchAvatarFromWebProfile(fallbackUsername, signal);
    if (imgBuffer) {
      try {
        await setBotProfilePhoto(imgBuffer, "static", signal);
        return true;
      } catch (error: unknown) {
        if (signal?.aborted) return false;
        logApiError("set profile photo from web fallback", error);
      }
    }
  } else {
    // 命令上下文里的 username 只进日志，不用于抓取。
    const providedUsername: string | undefined = normalizePublicUsername(username);
    const hint: string = providedUsername === undefined
      ? ""
      : ` (command context suggested @${providedUsername}, not used because it cannot be proven to still belong to this id)`;
    logger.warn(
      lookup.failed
        ? `Skipping t.me web profile scrape fallback: getChat lookup for ${isChannel ? "channel" : "user"} ${targetId} failed${hint}`
        : `Skipping t.me web profile scrape fallback: ${isChannel ? "channel" : "user"} ${targetId} has no public username${hint}`
    );
  }
  return false;
}

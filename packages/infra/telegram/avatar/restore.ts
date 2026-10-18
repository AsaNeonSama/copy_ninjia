import type { InputProfilePhoto } from "grammy/types";
import {
  AVATAR_FETCH_MAX_ATTEMPTS,
  DEFAULT_AVATAR_EXPECTED_FORM,
  DEFAULT_AVATAR_FETCH_TIMEOUT_MS,
  DEFAULT_AVATAR_MAX_READ_BYTES,
} from "../../../consts/telegram";
import { signalWithTimeout } from "../../../libs/abortSignal";
import { discardResponseBody, readBoundedResponseBytes } from "../../../libs/boundedResponse";
import type { BoundedResponseResult } from "../../../libs/boundedResponse";
import { redactUrlForLog } from "../../../libs/redaction";
import { logger } from "../../logger";
import { logApiError } from "../client";
import { runTelegramCategorizedRequest } from "../outboundGate";
import { defaultAvatarPhotoType, describeDefaultAvatar } from "./photoType";
import { avatarFailureFor, runAvatarFetchAttempts, setBotProfilePhoto } from "./shared";
import type {
  AvatarFetchAttemptsOutcome,
  AvatarOperationAttemptResult,
} from "./shared";
import type { DefaultAvatarSource } from "../../../types/config";

/** 通过签名校验、可以上传的默认头像素材：字节与按签名判定的上传形态。 */
interface DefaultAvatarMedia {
  readonly bytes: Uint8Array;
  readonly type: InputProfilePhoto["type"];
}

/** 取默认头像素材的一次结果：可上传的素材，或已记过日志的失败分类。 */
type DefaultAvatarRead = DefaultAvatarMedia | "transient-failure" | "permanent-failure";

/**
 * 按配置来源（`url` 或本地 `path`）恢复机器人默认头像：
 * 经 `DEFAULT_AVATAR_MAX_READ_BYTES` 有界读取与 `defaultAvatarPhotoType` 校验签名及尺寸后上传，
 * 仅对瞬时失败按 `runAvatarFetchAttempts` 有界重试（见 `docs/cn/04-invariants.md`）。
 */
export async function restoreDefaultProfilePhoto(
  source: Readonly<DefaultAvatarSource>,
  signal?: AbortSignal
): Promise<boolean> {
  const outcome: AvatarFetchAttemptsOutcome = await runAvatarFetchAttempts(
    (attempt: number): Promise<AvatarOperationAttemptResult> =>
      attemptRestoreDefaultProfilePhoto(source, attempt, signal),
    signal
  );
  return outcome === "ok";
}

/** 单次「取默认头像并换上」的尝试；失败按可否重试分类，日志已在各分支记过。 */
async function attemptRestoreDefaultProfilePhoto(
  source: Readonly<DefaultAvatarSource>,
  attempt: number,
  signal?: AbortSignal
): Promise<AvatarOperationAttemptResult> {
  const label: string = source.kind === "url" ? redactUrlForLog(source.url) : source.path;
  try {
    const media: DefaultAvatarRead = source.kind === "url"
      ? await downloadDefaultAvatar(source.url, attempt, signal)
      : await readDefaultAvatarFile(source.path);
    if (typeof media === "string") return media;
    await setBotProfilePhoto(media.bytes, media.type, signal);
    return "ok";
  } catch (error: unknown) {
    if (signal?.aborted) return "permanent-failure";
    logApiError(`restore default profile photo from ${label} (attempt ${attempt}/${AVATAR_FETCH_MAX_ATTEMPTS})`, error);
    return avatarFailureFor(error);
  }
}

/** 下载 `url` 来源：经 `externalFetch` 出站闸请求，非成功响应归为瞬时失败，超限与格式不符归为确定性失败。 */
async function downloadDefaultAvatar(url: string, attempt: number, signal?: AbortSignal): Promise<DefaultAvatarRead> {
  const response: Response = await runTelegramCategorizedRequest({
    category: "externalFetch",
    signal: signalWithTimeout(signal, DEFAULT_AVATAR_FETCH_TIMEOUT_MS),
    execute: (requestSignal: AbortSignal): Promise<Response> => fetch(url, {
      redirect: "follow",
      signal: requestSignal,
    }),
  });
  if (!response.ok) {
    void discardResponseBody(response);
    logger.error(`Failed to download the default avatar (${response.status}) from ${redactUrlForLog(url)} (attempt ${attempt}/${AVATAR_FETCH_MAX_ATTEMPTS})`);
    return "transient-failure";
  }
  const download: BoundedResponseResult = await readBoundedResponseBytes(response, DEFAULT_AVATAR_MAX_READ_BYTES);
  if (!download.ok) {
    logger.error(`The default avatar at ${redactUrlForLog(url)} exceeded the download limit (${download.observedBytes} bytes)`);
    return "permanent-failure";
  }
  const type: InputProfilePhoto["type"] | null = defaultAvatarPhotoType(download.bytes);
  if (type === null) {
    logger.error(
      `The default avatar link ${redactUrlForLog(url)} did not return ${DEFAULT_AVATAR_EXPECTED_FORM} ` +
      `(sniffed=${describeDefaultAvatar(download.bytes)}, bytes=${download.bytes.byteLength}); ` +
      "it must serve raw media bytes rather than an HTML page such as a login, quota or virus-scan interstitial"
    );
    return "permanent-failure";
  }
  return { bytes: download.bytes, type };
}

/**
 * 读 `path` 来源：最多读 DEFAULT_AVATAR_MAX_READ_BYTES 加一个字节。读不到、超限与不符合
 * DEFAULT_AVATAR_EXPECTED_FORM 都属确定性失败。
 */
async function readDefaultAvatarFile(path: string): Promise<DefaultAvatarRead> {
  let bytes: Uint8Array;
  try {
    bytes = await Bun.file(path).slice(0, DEFAULT_AVATAR_MAX_READ_BYTES + 1).bytes();
  } catch (error: unknown) {
    logger.error(`Failed to read the default avatar file ${path}:`, error);
    return "permanent-failure";
  }
  if (bytes.byteLength > DEFAULT_AVATAR_MAX_READ_BYTES) {
    logger.error(`The default avatar file ${path} exceeds the size limit (${DEFAULT_AVATAR_MAX_READ_BYTES} bytes)`);
    return "permanent-failure";
  }
  const type: InputProfilePhoto["type"] | null = defaultAvatarPhotoType(bytes);
  if (type === null) {
    logger.error(
      `The default avatar file ${path} is not ${DEFAULT_AVATAR_EXPECTED_FORM} ` +
      `(sniffed=${describeDefaultAvatar(bytes)}, bytes=${bytes.byteLength})`
    );
    return "permanent-failure";
  }
  return { bytes, type };
}

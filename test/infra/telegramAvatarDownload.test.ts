/**
 * 头像下载结果的归类（infra/telegram/avatar/download.ts）：两段超时与文件服务器非 2xx 按可重试，
 * 缺 file_path、超限与空文件按确定性失败，每种失败记一条日志。
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { loggerStub } from "../helpers/loggerMock";
import type { AvatarDownloadResult, TelegramFileDownloadResult } from "../../packages/types/telegram";

const logError = mock((..._args: unknown[]): void => {});
let downloaded: TelegramFileDownloadResult = { status: "empty" };
const downloadTelegramFileBytes = mock(async (..._args: unknown[]): Promise<TelegramFileDownloadResult> => downloaded);

mock.module("../../packages/infra/logger", () => ({ logger: loggerStub({ error: logError }) }));
mock.module("../../packages/infra/telegram/fileDownload", () => ({ downloadTelegramFileBytes }));

const { downloadAvatarFile } = await import("../../packages/infra/telegram/avatar/download");
const { AVATAR_FETCH_TIMEOUT_MS, AVATAR_MAX_DOWNLOAD_BYTES } = await import("../../packages/consts/telegram");

beforeEach((): void => {
  logError.mockClear();
  downloadTelegramFileBytes.mockClear();
});

describe("downloadAvatarFile", () => {
  test("成功时原样交回字节，并按头像上限与超时请求下载", async () => {
    const bytes: Uint8Array = new Uint8Array([1, 2, 3]);
    downloaded = { status: "ok", bytes };
    const signal: AbortSignal = new AbortController().signal;

    await expect(downloadAvatarFile("file-1", 42, signal)).resolves.toEqual({ status: "ok", bytes });
    expect(downloadTelegramFileBytes).toHaveBeenCalledWith({
      fileId: "file-1",
      maxBytes: AVATAR_MAX_DOWNLOAD_BYTES,
      metadataTimeoutMs: AVATAR_FETCH_TIMEOUT_MS,
      downloadTimeoutMs: AVATAR_FETCH_TIMEOUT_MS,
      signal,
    });
    expect(logError).not.toHaveBeenCalled();
  });

  test.each([
    [{ status: "missingPath" }, "permanent-failure", ["getFile for avatar returned no file_path.", { targetId: 42 }]],
    [{ status: "metadataTimeout" }, "transient-failure", ["Downloading the avatar file timed out.", { targetId: 42, stage: "metadataTimeout" }]],
    [{ status: "httpError", httpStatus: 502 }, "transient-failure", ["Failed to download the avatar file.", { targetId: 42, httpStatus: 502 }]],
    [{ status: "downloadTimeout" }, "transient-failure", ["Downloading the avatar file timed out.", { targetId: 42, stage: "downloadTimeout" }]],
    [{ status: "tooLarge", observedBytes: 9 }, "permanent-failure", ["Avatar file exceeded the download limit.", { targetId: 42, observedBytes: 9 }]],
    [{ status: "empty" }, "permanent-failure", ["Avatar file downloaded empty.", { targetId: 42 }]],
  ] as const)("%o 归为 %s 并记一条日志", async (
    result: TelegramFileDownloadResult,
    expected: Exclude<AvatarDownloadResult["status"], "ok">,
    expectedLogArgs: readonly [string, Readonly<Record<string, unknown>>]
  ) => {
    downloaded = result;
    await expect(downloadAvatarFile("file-1", 42)).resolves.toEqual({ status: expected });
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith(...expectedLogArgs);
  });
});

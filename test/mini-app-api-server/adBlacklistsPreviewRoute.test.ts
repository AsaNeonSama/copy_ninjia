/**
 * Mini App 内容黑名单页内预览路由（`GET /api/ad-blacklists/preview`）端到端测试：
 * - 鉴权拦截（401）与拒绝未加密查询串（400）；
 * - 严格查询参数校验（缺失/非法/重复 `kind`、`pack`、`offset` 与未知键返回 `400`）；
 * - `getStickerSet` + 有界并发 `downloadTelegramFileBytes` + 魔数嗅探 `data:image/...;base64,...` 封装、
 *   静态无缩略图回退原图、动态/视频无缩略图及单枚下载失败/非图字节优雅降级为 `null`、分页 `offset`/`hasMore`/`nextOffset` 与零 `logger.operation` 审计；
 * - `400 STICKERSET_INVALID` 归一化为 `404 AD_BLACKLIST_PREVIEW_NOT_FOUND`，其余异常返回 `503 AD_BLACKLIST_PREVIEW_UNAVAILABLE`。
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Sticker, StickerSet } from "grammy/types";
import { miniAppAuthSessions } from "../../packages/cache/main/miniApp";
import { BOT_TOKEN, SUPER_ADMIN_USER_ID } from "../../packages/config/bot";
import { MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE } from "../../packages/consts/miniApp/features";
import { logger } from "../../packages/infra/logger";
import { telegramApi } from "../../packages/infra/telegram/client";
import { bot } from "../../packages/infra/telegram/mainClient";
import type { HydratedTelegramFile } from "../../packages/infra/telegram/mainClient";
import {
  issueMiniAppAuthSession,
  stopMiniAppServer,
} from "../../packages/mini-app-api-server";
import type { MiniAppAdBlacklistPreviewResponse } from "../../packages/types/miniApp/adBlacklists";
import {
  buildSuperAdminHeaders,
  ensureReusableTestSession,
} from "../helpers/miniAppInitData";
import {
  dispatchMiniAppTestRequest as handleMiniAppHttpRequest,
  dispatchRawMiniAppTestRequest,
} from "../helpers/miniAppRequest";

/** 最小合法 WebP 文件头（RIFF....WEBP）。 */
const SAMPLE_WEBP_BYTES: Uint8Array = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56,
  0x50, 0x38, 0x20,
]);

/** 最小合法 JPEG 文件头（FF D8 FF E0）。 */
const SAMPLE_JPEG_BYTES: Uint8Array = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
]);

/** 最小合法 PNG 文件头。 */
const SAMPLE_PNG_BYTES: Uint8Array = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

/** 非图片魔数字节（用于验证嗅探降级为 null）。 */
const SAMPLE_INVALID_BYTES: Uint8Array = new Uint8Array([
  0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

const originalFetch: typeof fetch = globalThis.fetch;

function superAdminHeaders(): Record<string, string> {
  return buildSuperAdminHeaders({
    botToken: BOT_TOKEN,
    superAdminUserId: SUPER_ADMIN_USER_ID,
    sessionToken: ensureReusableTestSession(issueMiniAppAuthSession).token,
    username: "super_admin",
  });
}

function makeSticker(
  index: number,
  overrides: Partial<Sticker> = {}
): Sticker {
  return {
    file_id: `sticker_file_${index}`,
    file_unique_id: `unique_${index}`,
    type: "regular",
    width: 512,
    height: 512,
    is_animated: false,
    is_video: false,
    emoji: "😀",
    thumbnail: {
      file_id: `thumb_file_${index}`,
      file_unique_id: `thumb_unique_${index}`,
      width: 128,
      height: 128,
    },
    ...overrides,
  };
}

beforeEach((): void => {
  miniAppAuthSessions.clear();
});

afterEach(async (): Promise<void> => {
  globalThis.fetch = originalFetch;
  await stopMiniAppServer();
  miniAppAuthSessions.clear();
});

describe("Mini App 内容黑名单页内预览路由 GET /api/ad-blacklists/preview", () => {
  test("未鉴权返回 401，未加密明文查询串返回 400", async () => {
    const unauth: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/ad-blacklists/preview?kind=emoji&pack=demo_pack")
    );
    expect(unauth.status).toBe(401);

    const plainQuery: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/ad-blacklists/preview?kind=emoji&pack=demo_pack", {
        headers: superAdminHeaders(),
      })
    );
    expect(plainQuery.status).toBe(400);
  });

  test("严格校验 kind、pack、offset、重复键与未知键（返回 400）", async () => {
    const badParamPaths: readonly string[] = [
      "/api/ad-blacklists/preview",
      "/api/ad-blacklists/preview?kind=sticker",
      "/api/ad-blacklists/preview?pack=valid_pack",
      "/api/ad-blacklists/preview?kind=other&pack=valid_pack",
      "/api/ad-blacklists/preview?kind=sticker&kind=emoji&pack=valid_pack",
      "/api/ad-blacklists/preview?kind=sticker&pack=a&pack=b",
      "/api/ad-blacklists/preview?kind=sticker&pack=valid_pack&offset=-1",
      "/api/ad-blacklists/preview?kind=sticker&pack=valid_pack&offset=01",
      "/api/ad-blacklists/preview?kind=sticker&pack=valid_pack&offset=1.5",
      "/api/ad-blacklists/preview?kind=sticker&pack=valid_pack&offset=abc",
      "/api/ad-blacklists/preview?kind=sticker&pack=valid_pack&offset=0&offset=1",
      "/api/ad-blacklists/preview?kind=sticker&pack=valid_pack&metaOnly=2",
      "/api/ad-blacklists/preview?kind=sticker&pack=valid_pack&metaOnly=true",
      "/api/ad-blacklists/preview?kind=sticker&pack=valid_pack&metaOnly=1&metaOnly=0",
      "/api/ad-blacklists/preview?kind=sticker&pack=valid_pack&extra=1",
    ];
    for (const path of badParamPaths) {
      const res: Response = await handleMiniAppHttpRequest(
        new Request(`http://127.0.0.1:3000${path}`, {
          headers: superAdminHeaders(),
        })
      );
      expect(`${path} -> ${res.status}`).toBe(`${path} -> 400`);
      expect(await res.json()).toEqual({ error: "INVALID_AD_BLACKLIST_PARAMS" });
    }

    for (const badPack of ["", "bad-pack", "中文", "a".repeat(65)]) {
      const res: Response = await handleMiniAppHttpRequest(
        new Request(
          `http://127.0.0.1:3000/api/ad-blacklists/preview?kind=emoji&pack=${encodeURIComponent(badPack)}`,
          { headers: superAdminHeaders() }
        )
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "INVALID_AD_BLACKLIST_PACK" });
    }
  });

  test("拉取包元数据并分页内联魔数嗅探缩略图，优雅降级异常/缺失缩略图且不写 operation 日志", async () => {
    const totalStickers: number = MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE + 2;
    const stickers: Sticker[] = [];
    for (let i: number = 0; i < totalStickers; i += 1) {
      if (i === 0) {
        // 静态带 WebP 缩略图
        stickers.push(makeSticker(i, { emoji: "🔥" }));
      } else if (i === 1) {
        // 静态无缩略图，回退下载原图（PNG）
        stickers.push(makeSticker(i, { emoji: "✨", thumbnail: undefined }));
      } else if (i === 2) {
        // TGS 动画带 JPEG 缩略图
        stickers.push(makeSticker(i, { emoji: "🎉", is_animated: true }));
      } else if (i === 3) {
        // TGS 动画无缩略图 -> 直接降级 null，不请求 getFile
        stickers.push(makeSticker(i, { emoji: "🌀", is_animated: true, thumbnail: undefined }));
      } else if (i === 4) {
        // WEBM 视频带非图片魔数字节 -> 降级 null
        stickers.push(makeSticker(i, { emoji: "🎬", is_video: true }));
      } else if (i === 5) {
        // 下载返回 HTTP 500 -> 降级 null
        stickers.push(makeSticker(i, { emoji: "⚠️" }));
      } else {
        stickers.push(makeSticker(i, { emoji: "🐱" }));
      }
    }

    const fakeSet: StickerSet = {
      name: "gfedfsedaff",
      title: "Sample Emoji Pack",
      sticker_type: "custom_emoji",
      stickers,
    };

    const requestedFileIds: string[] = [];
    const getStickerSetSpy = spyOn(telegramApi, "getStickerSet").mockResolvedValue(fakeSet);
    const getFileSpy = spyOn(bot.api, "getFile").mockImplementation(
      async (fileId: string): Promise<HydratedTelegramFile> => {
        requestedFileIds.push(fileId);
        return {
          file_id: fileId,
          file_unique_id: `u_${fileId}`,
          file_path: `stickers/${fileId}`,
          getUrl: (): string => `https://mock-telegram-cdn.local/files/${fileId}`,
        } as HydratedTelegramFile;
      }
    );
    const opSpy = spyOn(logger, "operation");

    globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
      const urlText: string =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (urlText.endsWith("/thumb_file_0")) {
        return new Response(new Uint8Array(SAMPLE_WEBP_BYTES), { status: 200 });
      }
      if (urlText.endsWith("/sticker_file_1")) {
        return new Response(new Uint8Array(SAMPLE_PNG_BYTES), { status: 200 });
      }
      if (urlText.endsWith("/thumb_file_2")) {
        return new Response(new Uint8Array(SAMPLE_JPEG_BYTES), { status: 200 });
      }
      if (urlText.endsWith("/thumb_file_4")) {
        return new Response(new Uint8Array(SAMPLE_INVALID_BYTES), { status: 200 });
      }
      if (urlText.endsWith("/thumb_file_5")) {
        return new Response("upstream error", { status: 500 });
      }
      return new Response(new Uint8Array(SAMPLE_WEBP_BYTES), { status: 200 });
    }) as typeof fetch;

    try {
      // 0. 仅元数据预查（metaOnly=1）：不调用 getFile/fetch，直接确认总枚数与精确 hasImage 标记
      const metaRes: Response = await handleMiniAppHttpRequest(
        new Request(
          "http://127.0.0.1:3000/api/ad-blacklists/preview?kind=emoji&pack=gfedfsedaff&metaOnly=1",
          { headers: superAdminHeaders() }
        )
      );
      expect(metaRes.status).toBe(200);
      const metaPage: MiniAppAdBlacklistPreviewResponse =
        (await metaRes.json()) as MiniAppAdBlacklistPreviewResponse;
      expect(metaPage.title).toBe("Sample Emoji Pack");
      expect(metaPage.totalCount).toBe(totalStickers);
      expect(metaPage.items).toHaveLength(MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE);
      expect(metaPage.items[0]).toEqual({
        fileUniqueId: "unique_0",
        emoji: "🔥",
        format: "static",
        hasImage: true,
        imageDataUrl: null,
      });
      expect(metaPage.items[3]).toEqual({
        fileUniqueId: "unique_3",
        emoji: "🌀",
        format: "animated",
        hasImage: false,
        imageDataUrl: null,
      });
      expect(requestedFileIds).toEqual([]);

      // 1. 首屏（offset=0，显式 metaOnly=0 拉取缩略图）
      const page1Res: Response = await handleMiniAppHttpRequest(
        new Request(
          "http://127.0.0.1:3000/api/ad-blacklists/preview?kind=emoji&pack=gfedfsedaff&metaOnly=0",
          { headers: superAdminHeaders() }
        )
      );
      expect(page1Res.status).toBe(200);
      const page1: MiniAppAdBlacklistPreviewResponse =
        (await page1Res.json()) as MiniAppAdBlacklistPreviewResponse;
      expect(page1.kind).toBe("emoji");
      expect(page1.pack).toBe("gfedfsedaff");
      expect(page1.title).toBe("Sample Emoji Pack");
      expect(page1.stickerType).toBe("custom_emoji");
      expect(page1.totalCount).toBe(totalStickers);
      expect(page1.offset).toBe(0);
      expect(page1.hasMore).toBeTrue();
      expect(page1.nextOffset).toBe(MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE);
      expect(page1.items).toHaveLength(MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE);

      expect(page1.items[0]).toEqual({
        fileUniqueId: "unique_0",
        emoji: "🔥",
        format: "static",
        hasImage: true,
        imageDataUrl: `data:image/webp;base64,${SAMPLE_WEBP_BYTES.toBase64()}`,
      });
      expect(page1.items[1]).toEqual({
        fileUniqueId: "unique_1",
        emoji: "✨",
        format: "static",
        hasImage: true,
        imageDataUrl: `data:image/png;base64,${SAMPLE_PNG_BYTES.toBase64()}`,
      });
      expect(page1.items[2]).toEqual({
        fileUniqueId: "unique_2",
        emoji: "🎉",
        format: "animated",
        hasImage: true,
        imageDataUrl: `data:image/jpeg;base64,${SAMPLE_JPEG_BYTES.toBase64()}`,
      });
      expect(page1.items[3]).toEqual({
        fileUniqueId: "unique_3",
        emoji: "🌀",
        format: "animated",
        hasImage: false,
        imageDataUrl: null,
      });
      expect(page1.items[4]).toEqual({
        fileUniqueId: "unique_4",
        emoji: "🎬",
        format: "video",
        hasImage: true,
        imageDataUrl: null,
      });
      expect(page1.items[5]).toEqual({
        fileUniqueId: "unique_5",
        emoji: "⚠️",
        format: "static",
        hasImage: true,
        imageDataUrl: null,
      });
      // 第 3 枚为无缩略图的动画贴纸，不得下载 .tgs 原文件。
      expect(requestedFileIds).not.toContain("sticker_file_3");
      expect(requestedFileIds).toContain("sticker_file_1");

      // 2. 第二页（offset = MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE）
      const page2Res: Response = await handleMiniAppHttpRequest(
        new Request(
          `http://127.0.0.1:3000/api/ad-blacklists/preview?kind=emoji&pack=gfedfsedaff&offset=${MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE}`,
          { headers: superAdminHeaders() }
        )
      );
      expect(page2Res.status).toBe(200);
      const page2: MiniAppAdBlacklistPreviewResponse =
        (await page2Res.json()) as MiniAppAdBlacklistPreviewResponse;
      expect(page2.offset).toBe(MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE);
      expect(page2.hasMore).toBeFalse();
      expect(page2.nextOffset).toBe(totalStickers);
      expect(page2.items).toHaveLength(2);

      // 3. 超出总数的 offset 夹紧并返回空切片
      const tailRes: Response = await handleMiniAppHttpRequest(
        new Request(
          "http://127.0.0.1:3000/api/ad-blacklists/preview?kind=emoji&pack=gfedfsedaff&offset=999",
          { headers: superAdminHeaders() }
        )
      );
      expect(tailRes.status).toBe(200);
      const tail: MiniAppAdBlacklistPreviewResponse =
        (await tailRes.json()) as MiniAppAdBlacklistPreviewResponse;
      expect(tail.offset).toBe(totalStickers);
      expect(tail.hasMore).toBeFalse();
      expect(tail.items).toEqual([]);

      expect(opSpy).not.toHaveBeenCalled();
    } finally {
      getStickerSetSpy.mockRestore();
      getFileSpy.mockRestore();
      opSpy.mockRestore();
    }
  });

  test("Telegram 返回 400 STICKERSET_INVALID 时回 404，其余错误回 503", async () => {
    const invalidErr: Error & { error_code: number; description: string } = Object.assign(
      new Error("400: Bad Request: STICKERSET_INVALID"),
      { error_code: 400, description: "Bad Request: STICKERSET_INVALID" }
    );
    const getStickerSetSpy = spyOn(telegramApi, "getStickerSet").mockRejectedValueOnce(invalidErr);
    const warnSpy = spyOn(logger, "warn").mockImplementation((): void => {});

    try {
      const notFoundRes: Response = await handleMiniAppHttpRequest(
        new Request(
          "http://127.0.0.1:3000/api/ad-blacklists/preview?kind=sticker&pack=deleted_pack",
          { headers: superAdminHeaders() }
        )
      );
      expect(notFoundRes.status).toBe(404);
      expect(await notFoundRes.json()).toEqual({ error: "AD_BLACKLIST_PREVIEW_NOT_FOUND" });
      expect(warnSpy).not.toHaveBeenCalled();

      getStickerSetSpy.mockRejectedValueOnce(new Error("ETIMEDOUT"));
      const unavailableRes: Response = await handleMiniAppHttpRequest(
        new Request(
          "http://127.0.0.1:3000/api/ad-blacklists/preview?kind=sticker&pack=slow_pack",
          { headers: superAdminHeaders() }
        )
      );
      expect(unavailableRes.status).toBe(503);
      expect(await unavailableRes.json()).toEqual({ error: "AD_BLACKLIST_PREVIEW_UNAVAILABLE" });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      getStickerSetSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("加密查询重建 Request 透传 request.signal：请求中途 abort 后停止后续缩略图下载", async () => {
    const stickers: Sticker[] = Array.from(
      { length: MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE },
      (_unused: unknown, index: number): Sticker => makeSticker(index)
    );
    const fakeSet: StickerSet = {
      name: "abort_midflight_pack",
      title: "Abort Midflight Pack",
      sticker_type: "regular",
      stickers,
    };
    const controller: AbortController = new AbortController();
    const requestedFileIds: string[] = [];
    const observedSignals: AbortSignal[] = [];

    const getStickerSetSpy = spyOn(telegramApi, "getStickerSet").mockResolvedValue(fakeSet);
    const getFileSpy = spyOn(bot.api, "getFile").mockImplementation(
      async (fileId: string, signal?: unknown): Promise<HydratedTelegramFile> => {
        requestedFileIds.push(fileId);
        const abortSignal: AbortSignal | undefined =
          signal instanceof AbortSignal ? signal : undefined;
        if (abortSignal !== undefined) observedSignals.push(abortSignal);
        if (requestedFileIds.length === 1) {
          controller.abort();
        }
        if (abortSignal?.aborted === true) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        return {
          file_id: fileId,
          file_unique_id: `u_${fileId}`,
          file_path: `stickers/${fileId}`,
          getUrl: (): string => `https://mock-telegram-cdn.local/files/${fileId}`,
        } as HydratedTelegramFile;
      }
    );
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (init?.signal?.aborted === true) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return new Response(new Uint8Array(SAMPLE_WEBP_BYTES), { status: 200 });
    }) as typeof fetch;

    try {
      const res: Response = await handleMiniAppHttpRequest(
        new Request(
          "http://127.0.0.1:3000/api/ad-blacklists/preview?kind=sticker&pack=abort_midflight_pack&metaOnly=0",
          {
            headers: superAdminHeaders(),
            signal: controller.signal,
          }
        )
      );
      expect(res.status).toBe(200);
      const body: MiniAppAdBlacklistPreviewResponse =
        (await res.json()) as MiniAppAdBlacklistPreviewResponse;
      expect(body.items).toHaveLength(MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE);
      expect(requestedFileIds.length).toBeLessThan(MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE);
      expect(observedSignals.length).toBeGreaterThan(0);
      expect(observedSignals.every((sig: AbortSignal): boolean => sig.aborted)).toBeTrue();
    } finally {
      getStickerSetSpy.mockRestore();
      getFileSpy.mockRestore();
    }
  });

  test("加密查询重建 Request 透传已中止的 request.signal：预先中止时直接向下游传递 aborted 信号且不打 warn 日志", async () => {
    const controller: AbortController = new AbortController();
    controller.abort();

    let receivedSignalAborted: boolean = false;
    const getStickerSetSpy = spyOn(telegramApi, "getStickerSet").mockImplementation(
      async (_name: string, signal?: unknown): Promise<StickerSet> => {
        receivedSignalAborted = signal instanceof AbortSignal && signal.aborted;
        throw new DOMException("The operation was aborted.", "AbortError");
      }
    );
    const getFileSpy = spyOn(bot.api, "getFile");
    const warnSpy = spyOn(logger, "warn").mockImplementation((): void => {});

    try {
      const res: Response = await handleMiniAppHttpRequest(
        new Request(
          "http://127.0.0.1:3000/api/ad-blacklists/preview?kind=sticker&pack=pre_aborted_pack&metaOnly=0",
          {
            headers: superAdminHeaders(),
            signal: controller.signal,
          }
        )
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "AD_BLACKLIST_PREVIEW_UNAVAILABLE" });
      expect(receivedSignalAborted).toBeTrue();
      expect(getFileSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      getStickerSetSpy.mockRestore();
      getFileSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

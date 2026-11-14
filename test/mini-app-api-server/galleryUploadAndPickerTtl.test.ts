import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import type { MiniAppGalleryUploadResult } from "../../packages/types/miniApp/gallery";
import type {
  MiniAppPickerResultEvent,
  MiniAppPreparedPickerSession,
} from "../../packages/types/miniApp/identities";
import { imageFixture } from "../helpers/image";
import {
  installMiniAppTestDiskIOMock,
  resetMiniAppTestDiskIOState,
} from "../helpers/miniAppInitData";

installMiniAppTestDiskIOMock();

const { resetIdentityStorageCache } = await import(
  "../../packages/cache/main/identityStorage"
);
const {
  miniAppCompletedPickerResults,
  miniAppPendingPickers,
} = await import("../../packages/cache/main/miniApp");
const { getAssetConfig } = await import("../../packages/config/assets");
const { RANDOM_IMAGE_MAX_BYTES } = await import("../../packages/consts/imageGallery");
const { MINI_APP_PICKER_TTL_MS } = await import("../../packages/consts/miniApp");
const { TELEGRAM_PHOTO_MAX_ASPECT_RATIO } = await import("../../packages/consts/telegram");
const { stopMiniAppServer } = await import("../../packages/mini-app-api-server");
const { handlePostGalleryUploadRoute } = await import(
  "../../packages/mini-app-api-server/handlers/gallery"
);
const {
  getMiniAppPickerResult,
  pruneExpiredMiniAppPickers,
  resetMiniAppPickerState,
} = await import("../../packages/mini-app-api-server/picker/sessions");
const { uploadMiniAppGalleryImage } = await import(
  "../../packages/mini-app-api-server/view/gallery"
);

afterEach(async (): Promise<void> => {
  await stopMiniAppServer();
  resetMiniAppPickerState();
  resetMiniAppTestDiskIOState();
  resetIdentityStorageCache();
});

describe("Mini App gallery upload failure paths & picker TTL eviction", () => {
  test("uploadMiniAppGalleryImage 对超限字节、损坏头尺寸读取失败、超限宽高比与落盘异常返回对应结构化失败结果", async () => {
    const galleryDir: string = getAssetConfig().randomHImageDirectory;
    rmSync(galleryDir, { recursive: true, force: true });
    mkdirSync(galleryDir, { recursive: true });

    const oversizedBytes: Uint8Array = new Uint8Array(RANDOM_IMAGE_MAX_BYTES + 1);
    const oversizedResult: Readonly<MiniAppGalleryUploadResult> =
      await uploadMiniAppGalleryImage(oversizedBytes);
    expect(oversizedResult).toEqual({
      ok: false,
      outcome: "tooLarge",
      message: "GALLERY_IMAGE_TOO_LARGE",
    });

    // 合法 PNG 魔数但缺少 IHDR 数据，sniffImageFormat 通过后由 readImageDimensions 返回 null。
    const truncatedPngBytes: Uint8Array = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x00,
    ]);
    const unreadableDimensionsResult: Readonly<MiniAppGalleryUploadResult> =
      await uploadMiniAppGalleryImage(truncatedPngBytes);
    expect(unreadableDimensionsResult).toEqual({
      ok: false,
      outcome: "failed",
      message: "GALLERY_UPLOAD_FAILED",
    });

    const invalidRatioWidth: number = TELEGRAM_PHOTO_MAX_ASPECT_RATIO + 2;
    const skewedPngBytes: Uint8Array = await new Bun.Image(
      imageFixture(invalidRatioWidth, 1)
    ).png().bytes();
    const invalidDimResult: Readonly<MiniAppGalleryUploadResult> =
      await uploadMiniAppGalleryImage(skewedPngBytes);
    expect(invalidDimResult).toEqual({
      ok: false,
      outcome: "invalidDimensions",
      width: invalidRatioWidth,
      height: 1,
      message: "GALLERY_INVALID_DIMENSIONS",
    });

    const validPngBytes: Uint8Array = await new Bun.Image(imageFixture(8, 8))
      .png()
      .bytes();
    const writeSpy = spyOn(Bun, "write").mockRejectedValueOnce(
      new Error("disk write failed")
    );
    try {
      const storeFailureResult: Readonly<MiniAppGalleryUploadResult> =
        await uploadMiniAppGalleryImage(validPngBytes);
      expect(storeFailureResult).toEqual({
        ok: false,
        outcome: "failed",
        message: "GALLERY_UPLOAD_FAILED",
      });
    } finally {
      writeSpy.mockRestore();
    }
  });

  test("handlePostGalleryUploadRoute 在 request.bytes() 抛错时返回 400 GALLERY_UPLOAD_READ_FAILED", async () => {
    const request: Request = new Request("http://127.0.0.1:3000/api/gallery/upload", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller: ReadableStreamDefaultController<Uint8Array>): void {
          controller.error(new Error("upload body aborted"));
        },
      }),
    });

    const response: Response = await handlePostGalleryUploadRoute(request);
    expect(response.status).toBe(400);
    const body: MiniAppGalleryUploadResult =
      (await response.json()) as MiniAppGalleryUploadResult;
    expect(body).toEqual({
      ok: false,
      outcome: "failed",
      message: "GALLERY_UPLOAD_READ_FAILED",
    });
  });

  test("pruneExpiredMiniAppPickers 与 getMiniAppPickerResult 按 MINI_APP_PICKER_TTL_MS 淘汰过期会话和回执并保留未过期项", () => {
    const baseNow: number = 1_700_000_000_000;
    const makeSession = (
      requestId: number,
      createdAt: number
    ): Readonly<MiniAppPreparedPickerSession> => ({
      requestId,
      preparedButtonId: `btn-${requestId}`,
      targetList: "whitelist",
      subjectKind: "users",
      createdAt,
    });
    const makeResult = (
      requestId: number,
      completedAt: number
    ): Readonly<MiniAppPickerResultEvent> => ({
      requestId,
      targetList: "whitelist",
      completedAt,
      addedIds: [requestId],
      skippedIds: [],
      summary: `done-${requestId}`,
    });

    miniAppPendingPickers.set(101, makeSession(101, baseNow - MINI_APP_PICKER_TTL_MS - 1));
    miniAppPendingPickers.set(102, makeSession(102, baseNow - MINI_APP_PICKER_TTL_MS));
    miniAppCompletedPickerResults.set(
      201,
      makeResult(201, baseNow - MINI_APP_PICKER_TTL_MS - 1)
    );
    miniAppCompletedPickerResults.set(
      202,
      makeResult(202, baseNow - MINI_APP_PICKER_TTL_MS)
    );

    pruneExpiredMiniAppPickers(baseNow);

    expect(miniAppPendingPickers.has(101)).toBeFalse();
    expect(miniAppPendingPickers.has(102)).toBeTrue();
    expect(miniAppCompletedPickerResults.has(201)).toBeFalse();
    expect(miniAppCompletedPickerResults.has(202)).toBeTrue();

    resetMiniAppPickerState();
    const wallNow: number = Date.now();
    miniAppCompletedPickerResults.set(
      301,
      makeResult(301, wallNow - MINI_APP_PICKER_TTL_MS - 10)
    );
    miniAppCompletedPickerResults.set(302, makeResult(302, wallNow));

    expect(getMiniAppPickerResult(301)).toBeNull();
    expect(miniAppCompletedPickerResults.has(301)).toBeFalse();
    expect(getMiniAppPickerResult(302)?.requestId).toBe(302);
  });
});

import { describe, expect, test } from "bun:test";
import type { Message, PhotoSize, Sticker } from "grammy/types";
import {
  isSendablePhotoDimensions,
  messageImageCandidate,
  pickAdImageSource,
  pickPhotoFile,
  pickPhotoSize,
  pickStickerVisionSource,
} from "../../packages/libs/telegramImage";
import { AD_DETECT_IMAGE_DOCUMENT_MIME_TYPES } from "../../packages/consts/antiRaid/adDetect";
import { TELEGRAM_PHOTO_MAX_ASPECT_RATIO, TELEGRAM_PHOTO_MAX_DIMENSION_SUM } from "../../packages/consts/telegram";
import { MEDIA_MAX_DOWNLOAD_BYTES } from "../../packages/consts/aiChat/media";

function message(fields: Record<string, unknown>): Message {
  return { message_id: 1, date: 1, chat: { id: -1, type: "supergroup", title: "g" }, ...fields } as unknown as Message;
}

describe("messageImageCandidate", () => {
  test("图片取最大尺寸", () => {
    expect(messageImageCandidate(message({
      photo: [
        { file_id: "small", file_unique_id: "u-small", width: 90, height: 90, file_size: 10 },
        { file_id: "large", file_unique_id: "u-large", width: 1280, height: 1280, file_size: 200 },
      ],
    }))).toEqual({ fileId: "large", fileUniqueId: "u-large", fileSize: 200 });
  });

  test("以文件发送的图片只收 jpeg、png、webp", () => {
    expect(messageImageCandidate(message({ document: { file_id: "d", file_unique_id: "u-d", mime_type: "image/png" } })))
      .toEqual({ fileId: "d", fileUniqueId: "u-d", fileSize: undefined });
    for (const mime of ["image/gif", "application/pdf", undefined]) {
      expect(messageImageCandidate(message({ document: { file_id: "d", file_unique_id: "u-d", mime_type: mime } }))).toBeUndefined();
    }
  });

  test("文字、贴纸与空图片数组都不是候选", () => {
    expect(messageImageCandidate(message({ text: "hi" }))).toBeUndefined();
    expect(messageImageCandidate(message({ sticker: { file_id: "s", file_unique_id: "u-s" } }))).toBeUndefined();
    expect(messageImageCandidate(message({ photo: [] }))).toBeUndefined();
  });
});

describe("isSendablePhotoDimensions", () => {
  test("宽高之和的边界：恰好 10000 放行，多 1 像素就拒", () => {
    // w + h 恰为 TELEGRAM_PHOTO_MAX_DIMENSION_SUM 且长宽比仍在上限以内的最扁一档。
    expect(isSendablePhotoDimensions({ width: 9_523, height: 477 })).toBeTrue();
    expect(9_523 + 477).toBe(TELEGRAM_PHOTO_MAX_DIMENSION_SUM);
    expect(isSendablePhotoDimensions({ width: 9_524, height: 477 })).toBeFalse();
    expect(isSendablePhotoDimensions({ width: 5_000, height: 5_000 })).toBeTrue();
    expect(isSendablePhotoDimensions({ width: 5_001, height: 5_000 })).toBeFalse();
  });

  test("长宽比的边界：恰好 20 放行，超一点就拒；两个方向同判", () => {
    expect(isSendablePhotoDimensions({ width: 2_000, height: 100 })).toBeTrue();
    expect(2_000 / 100).toBe(TELEGRAM_PHOTO_MAX_ASPECT_RATIO);
    expect(isSendablePhotoDimensions({ width: 100, height: 2_000 })).toBeTrue();
    expect(isSendablePhotoDimensions({ width: 2_001, height: 100 })).toBeFalse();
    expect(isSendablePhotoDimensions({ width: 100, height: 2_001 })).toBeFalse();
  });

  test("字节小但发不出去的长条图：两道门槛互不蕴含", () => {
    // 12000×40 的 PNG 只有几十 KB，字节闸放行，sendPhoto 仍以
    // PHOTO_INVALID_DIMENSIONS 拒绝。
    expect(isSendablePhotoDimensions({ width: 12_000, height: 40 })).toBeFalse();
  });

  test("零或负的边长按不合规处理", () => {
    for (const dimensions of [{ width: 0, height: 100 }, { width: 100, height: 0 }, { width: -1, height: 10 }]) {
      expect(isSendablePhotoDimensions(dimensions)).toBeFalse();
    }
  });

  test("寻常尺寸照常放行", () => {
    expect(isSendablePhotoDimensions({ width: 1_280, height: 1_280 })).toBeTrue();
    expect(isSendablePhotoDimensions({ width: 1, height: 1 })).toBeTrue();
  });
});

describe("pickPhotoSize", () => {
  const sizes: readonly PhotoSize[] = [
    { file_id: "small", file_unique_id: "small-u", width: 100, height: 100, file_size: 100 },
    { file_id: "middle", file_unique_id: "middle-u", width: 500, height: 500, file_size: MEDIA_MAX_DOWNLOAD_BYTES },
    { file_id: "large", file_unique_id: "large-u", width: 1000, height: 1000, file_size: MEDIA_MAX_DOWNLOAD_BYTES + 1 },
  ];
  const cases: readonly (readonly PhotoSize[])[] = [
    sizes,
    sizes.map((size: PhotoSize): PhotoSize => ({ ...size, file_size: MEDIA_MAX_DOWNLOAD_BYTES + 1 })),
    [...sizes, { file_id: "unknown", file_unique_id: "unknown-u", width: 1200, height: 1200 }],
  ];

  test("只剩选中那一档时再选一次仍是同一档，转成的视觉源与从全部档位选出的一致", () => {
    for (const photo of cases) {
      const picked: PhotoSize = pickPhotoSize(photo);
      expect(photo).toContain(picked);
      expect(pickPhotoSize([picked])).toBe(picked);
      expect(pickPhotoFile([picked])).toEqual(pickPhotoFile(photo));
    }
  });
});

describe("pickStickerVisionSource", () => {
  test("静态贴纸取本体，动态与视频贴纸取缩略图且保留原贴纸 fileUniqueId，无缩略图时返回 null", () => {
    const staticSticker: Sticker = {
      file_id: "static-f",
      file_unique_id: "static-u",
      type: "regular",
      width: 512,
      height: 512,
      is_animated: false,
      is_video: false,
    };
    expect(pickStickerVisionSource(staticSticker)).toEqual({
      fileId: "static-f",
      fileUniqueId: "static-u",
      width: 512,
      height: 512,
    });

    const videoSticker: Sticker = {
      ...staticSticker,
      file_id: "video-f",
      file_unique_id: "video-u",
      is_video: true,
      thumbnail: { file_id: "thumb-f", file_unique_id: "thumb-u", width: 128, height: 128 },
    };
    expect(pickStickerVisionSource(videoSticker)).toEqual({
      fileId: "thumb-f",
      fileUniqueId: "video-u",
      width: 128,
      height: 128,
    });

    const animatedWithoutThumb: Sticker = {
      ...staticSticker,
      file_id: "anim-f",
      file_unique_id: "anim-u",
      is_animated: true,
    };
    expect(pickStickerVisionSource(animatedWithoutThumb)).toBeNull();
  });
});

describe("pickAdImageSource", () => {
  test("普通图片经 pickPhotoFile 选档", () => {
    expect(pickAdImageSource(message({
      photo: [
        { file_id: "small", file_unique_id: "small-u", width: 90, height: 90, file_size: 100 },
        { file_id: "large", file_unique_id: "large-u", width: 800, height: 600, file_size: MEDIA_MAX_DOWNLOAD_BYTES },
        { file_id: "oversize", file_unique_id: "over-u", width: 2000, height: 2000, file_size: MEDIA_MAX_DOWNLOAD_BYTES + 1 },
      ],
    }))).toEqual({ fileId: "large", fileUniqueId: "large-u", width: 800, height: 600 });
  });

  test("图片文件白名单内未超限取原文件，超限时回退缩略图并保留原 fileUniqueId，非图片与超限无缩略图返回 undefined", () => {
    for (const mime of AD_DETECT_IMAGE_DOCUMENT_MIME_TYPES) {
      expect(pickAdImageSource(message({
        document: {
          file_id: "doc-f",
          file_unique_id: "doc-u",
          mime_type: mime,
          file_size: MEDIA_MAX_DOWNLOAD_BYTES,
        },
      }))).toEqual({ fileId: "doc-f", fileUniqueId: "doc-u", width: 0, height: 0 });
    }

    expect(pickAdImageSource(message({
      document: {
        file_id: "big-f",
        file_unique_id: "big-u",
        mime_type: "image/png",
        file_size: MEDIA_MAX_DOWNLOAD_BYTES + 1,
        thumbnail: { file_id: "doc-thumb-f", file_unique_id: "doc-thumb-u", width: 320, height: 240, file_size: 4_096 },
      },
    }))).toEqual({ fileId: "doc-thumb-f", fileUniqueId: "big-u", width: 320, height: 240 });

    expect(pickAdImageSource(message({
      document: {
        file_id: "big-no-thumb",
        file_unique_id: "big-no-thumb-u",
        mime_type: "image/jpeg",
        file_size: MEDIA_MAX_DOWNLOAD_BYTES + 1,
      },
    }))).toBeUndefined();

    expect(pickAdImageSource(message({
      document: { file_id: "pdf-f", file_unique_id: "pdf-u", mime_type: "application/pdf", file_size: 100 },
    }))).toBeUndefined();

    expect(pickAdImageSource(message({ text: "plain", photo: [] }))).toBeUndefined();
  });
});

/**
 * 生图参考相册缓存：相册图片按 messageId 排序、去重与容量裁剪，以及回复轮按主参考图补齐同一相册、
 * 合计不超过 `agent.image.max_reference_images` 张。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { agentDeploymentConfigCache } from "../../../packages/cache/perThread/config";
import {
  imageReferenceAlbums,
  resetImageReferenceAlbumCache,
} from "../../../packages/cache/workers/aiChat/imageReferenceAlbums";
import { IMAGE_GENERATION_MAX_REFERENCE_IMAGES } from "../../../packages/consts/aiChat/imageGeneration";
import {
  imageGenerationReferencesFor,
  observeImageReferenceAlbumPhoto,
} from "../../../packages/workers/aiChat/imageReferenceAlbums";
import type { ImageGenerationReference } from "../../../packages/types/aiChat/protocol";
import type { AgentDeploymentConfig, AgentImageCapabilityConfig } from "../../../packages/types/config";
import type { TelegramVisionSource } from "../../../packages/types/media";
import { aiRecordMediaMessageFixture } from "../../helpers/aiMemoryFixtures";

const CHAT_ID: number = -1001;
const ALBUM_ID: string = "album-1";
const originalConfig: AgentDeploymentConfig | null = agentDeploymentConfigCache.current;

/** 把本 isolate 的生图参考图上限换成 limit；image 能力沿用预装的示例配置。 */
function useReferenceLimit(limit: number): void {
  const config: AgentDeploymentConfig = originalConfig!;
  const image: AgentImageCapabilityConfig = config.image!;
  agentDeploymentConfigCache.current = { ...config, image: { ...image, maxReferenceImages: limit } };
}

/** 记录相册里第 messageId 条图片；fileId 与 fileUniqueId 都由 messageId 派生。 */
function observeAlbumPhoto(messageId: number, overrides: { chatId?: number; mediaGroupId?: string } = {}): void {
  observeImageReferenceAlbumPhoto(aiRecordMediaMessageFixture({
    chatId: overrides.chatId ?? CHAT_ID,
    messageId,
    fileId: `file-${messageId}`,
    fileUniqueId: `unique-${messageId}`,
    width: 100 + messageId,
    height: 200 + messageId,
    mediaGroupId: overrides.mediaGroupId ?? ALBUM_ID,
  }));
}

/** 相册里第 messageId 条图片作为主参考图。 */
function albumReference(messageId: number): ImageGenerationReference {
  return {
    fileId: `file-${messageId}`,
    fileUniqueId: `unique-${messageId}`,
    width: 100 + messageId,
    height: 200 + messageId,
    mediaGroupId: ALBUM_ID,
  };
}

function fileIds(references: readonly TelegramVisionSource[]): string[] {
  return references.map((reference: TelegramVisionSource): string => reference.fileId);
}

beforeEach((): void => {
  resetImageReferenceAlbumCache();
});

afterEach((): void => {
  agentDeploymentConfigCache.current = originalConfig;
  resetImageReferenceAlbumCache();
});

describe("相册图片登记", () => {
  test("只登记带相册 id 的图片，组内按 messageId 升序并去重", () => {
    observeImageReferenceAlbumPhoto(aiRecordMediaMessageFixture({ kind: "sticker", mediaGroupId: ALBUM_ID }));
    observeImageReferenceAlbumPhoto(aiRecordMediaMessageFixture({ mediaGroupId: undefined }));
    expect(imageReferenceAlbums.size).toBe(0);

    for (const messageId of [13, 11, 12, 11]) observeAlbumPhoto(messageId);

    expect(imageReferenceAlbums.get(ALBUM_ID)?.photos.map((photo) => photo.messageId)).toEqual([11, 12, 13]);
  });

  test("组满后只保留 messageId 最小的上限张数，别的群写不进同一相册", () => {
    const total: number = IMAGE_GENERATION_MAX_REFERENCE_IMAGES + 3;
    // 倒序到达：后到的更靠前，挤掉组里 messageId 最大的一张。
    for (let messageId: number = total; messageId >= 1; messageId--) observeAlbumPhoto(messageId);
    observeAlbumPhoto(0, { chatId: -2002 });

    expect(imageReferenceAlbums.get(ALBUM_ID)?.photos.map((photo) => photo.messageId))
      .toEqual(Array.from({ length: IMAGE_GENERATION_MAX_REFERENCE_IMAGES }, (_: unknown, index: number): number => index + 1));
    expect(imageReferenceAlbums.get(ALBUM_ID)?.chatId).toBe(CHAT_ID);
  });
});

describe("回复轮参考图补齐", () => {
  test("主参考图排第一，再按相册顺序补齐且跳过主参考图自身", () => {
    useReferenceLimit(3);
    for (const messageId of [1, 2, 3, 4]) observeAlbumPhoto(messageId);

    expect(fileIds(imageGenerationReferencesFor(CHAT_ID, albumReference(2)))).toEqual(["file-2", "file-1", "file-3"]);
    // 主参考图排在缓存保留的前几张之后时，仍排第一，其余取相册最前面的几张。
    expect(fileIds(imageGenerationReferencesFor(CHAT_ID, albumReference(9)))).toEqual(["file-9", "file-1", "file-2"]);
  });

  test("相册张数不足上限时全部带上", () => {
    useReferenceLimit(IMAGE_GENERATION_MAX_REFERENCE_IMAGES);
    for (const messageId of [1, 2]) observeAlbumPhoto(messageId);

    expect(fileIds(imageGenerationReferencesFor(CHAT_ID, albumReference(1)))).toEqual(["file-1", "file-2"]);
  });

  test("上限为 1、不在相册里、相册没登记或属于别的群时只有主参考图", () => {
    for (const messageId of [1, 2, 3]) observeAlbumPhoto(messageId);
    const reference: ImageGenerationReference = albumReference(2);

    useReferenceLimit(1);
    expect(imageGenerationReferencesFor(CHAT_ID, reference)).toEqual([reference]);

    useReferenceLimit(IMAGE_GENERATION_MAX_REFERENCE_IMAGES);
    const single: ImageGenerationReference = { ...reference, mediaGroupId: undefined };
    expect(imageGenerationReferencesFor(CHAT_ID, single)).toEqual([single]);
    const unknownAlbum: ImageGenerationReference = { ...reference, mediaGroupId: "album-unknown" };
    expect(imageGenerationReferencesFor(CHAT_ID, unknownAlbum)).toEqual([unknownAlbum]);
    expect(imageGenerationReferencesFor(-2002, reference)).toEqual([reference]);
  });

  test("部署没有配置生图能力时只有主参考图", () => {
    for (const messageId of [1, 2]) observeAlbumPhoto(messageId);
    agentDeploymentConfigCache.current = { ...originalConfig!, image: undefined };
    const reference: ImageGenerationReference = albumReference(1);

    expect(imageGenerationReferencesFor(CHAT_ID, reference)).toEqual([reference]);
  });
});

import { logger } from "../../../infra/logger";
import { getStickerConfig } from "../../../config/stickers";
import type { Sticker, StickerSet } from "grammy/types";
import { getStickerSet } from "./sets";
import { pickStickerVisionSource } from "./describe";
import { describeMediaForStickerCatalog } from "../imageDescription";
import { resampleAiText } from "../utils/resample";
import { summaryAiProvider } from "../../provider";
import { invalidInput } from "../../../libs/inputValidation";
import { parseStickerCatalogSnapshot } from "../../../libs/persistedSnapshotCodec";
import { sanitizeInline, truncateAtClauseBoundary } from "../../../libs/text";
import {
  catalogs,
  dirtyPacks,
  failedEntries,
  generatingPacks,
  packSummaries,
  stickerCatalogRetryState,
} from "../../../cache/workers/aiChat/stickers/catalog";
import { transientDescriptionCache } from "../../../cache/workers/aiChat/imageDescription";
import { aiChatWorkerAbortController } from "../../../cache/workers/aiChat/worker";
import { invalidateStickerMenu } from "../../../cache/workers/aiChat/stickers/menu";
import {
  STICKER_CATALOG_ENTRY_FAILURE_RETRY_MS,
  STICKER_CATALOG_RETRY_DELAYS_MS,
  STICKER_CATALOG_RETRY_INTERVAL_MS,
  STICKER_PACK_NAME_PATTERN,
  STICKER_PACK_SUMMARY_ERROR_LABEL,
  STICKER_PACK_SUMMARY_MAX_CHARS,
} from "../../../consts/aiChat/stickers";
import { STICKER_PACK_SUMMARY_PROMPT } from "../../../consts/aiChat/prompts/media";
import { isPendingWithin } from "../../../libs/clockWindow";
import type { StickerCatalogEntry, StickerCatalogSnapshot } from "../../../types/stickers/catalog";
import type { AiStickerCatalogEvent } from "../../../types/stickers/protocol";
import type { AiTextResult } from "../../../types/aiChat/provider";

interface ParsedStickerCatalog {
  readonly pack: string;
  readonly snapshot: StickerCatalogSnapshot;
}

/**
 * 白名单贴纸包的画面描述目录与整包简介管理（生命周期与持久化约束见 docs/cn/04-invariants.md）。
 */

/**
 * 获取或初始化指定贴纸包的常驻目录映射表。
 * @param pack 贴纸包短名称。
 * @returns 该包对应的贴纸条目映射表。
 */
function getPackMap(pack: string): Map<string, StickerCatalogEntry> {
  let map: Map<string, StickerCatalogEntry> | undefined = catalogs.get(pack);
  if (!map) {
    map = new Map();
    catalogs.set(pack, map);
  }
  return map;
}

/**
 * 将单枚贴纸记入所属包的失败负缓存。
 * @param pack 贴纸包短名称。
 * @param fileUniqueId 贴纸唯一标识（file_unique_id）。
 */
function markEntryFailed(pack: string, fileUniqueId: string): void {
  let failed: Map<string, number> | undefined = failedEntries.get(pack);
  if (!failed) {
    failed = new Map();
    failedEntries.set(pack, failed);
  }
  failed.set(fileUniqueId, Date.now() + STICKER_CATALOG_ENTRY_FAILURE_RETRY_MS);
}

/**
 * 判断单枚贴纸的失败负缓存是否仍在退避期内；已到期时清除记录。
 * @param pack 贴纸包短名称。
 * @param fileUniqueId 贴纸唯一标识（file_unique_id）。
 * @returns 仍在失败退避期内时返回 true，否则返回 false。
 */
function isEntryFailureActive(pack: string, fileUniqueId: string): boolean {
  const failed: Map<string, number> | undefined = failedEntries.get(pack);
  if (failed === undefined) return false;
  const retryAt: number | undefined = failed.get(fileUniqueId);
  if (retryAt === undefined) return false;
  if (isPendingWithin(retryAt, Date.now(), STICKER_CATALOG_ENTRY_FAILURE_RETRY_MS)) return true;
  failed.delete(fileUniqueId);
  if (failed.size === 0) failedEntries.delete(pack);
  return false;
}

/**
 * 启动或崩溃恢复时严格校验并灌入持久化的贴纸目录快照（仅填充内存中尚无目录的包）。
 * @param snapshots 贴纸包短名称到序列化快照 JSON 的映射表。
 */
export function hydrateStickerCatalogs(snapshots: Map<string, string>): void {
  const parsedCatalogs: ParsedStickerCatalog[] = [];
  for (const [pack, snapshotJson] of snapshots) {
    if (!STICKER_PACK_NAME_PATTERN.test(pack)) {
      return invalidInput(
        "Sticker catalog hydrate payload",
        "$.catalogs.<key>",
        "a canonical sticker pack short name"
      );
    }
    const snapshot: StickerCatalogSnapshot = parseStickerCatalogSnapshot(
      snapshotJson,
      `Sticker catalog hydrate payload for pack ${pack}`
    );
    parsedCatalogs.push({ pack, snapshot });
  }
  for (const { pack, snapshot } of parsedCatalogs) {
    if (catalogs.has(pack)) continue;
    catalogs.set(pack, new Map(Object.entries(snapshot.entries)));
    invalidateStickerMenu();
    for (const fileUniqueId of Object.keys(snapshot.entries)) {
      transientDescriptionCache.delete(fileUniqueId);
    }
    if (snapshot.summary) packSummaries.set(pack, snapshot.summary);
  }
}

/**
 * 按贴纸 file_unique_id 跨包查找已生成的常驻目录条目。
 * @param fileUniqueId 贴纸唯一标识（file_unique_id）。
 * @returns 命中的常驻目录条目；未找到时返回 undefined。
 */
export function getCatalogEntry(fileUniqueId: string): StickerCatalogEntry | undefined {
  for (const map of catalogs.values()) {
    const entry: StickerCatalogEntry | undefined = map.get(fileUniqueId);
    if (entry) return entry;
  }
  return undefined;
}

/**
 * 将单个包的贴纸目录与整包简介序列化为持久化快照 JSON 文本。
 * @param pack 贴纸包短名称。
 * @returns 格式化的持久化快照 JSON 字符串。
 */
function buildSnapshot(pack: string): string {
  const snapshot: StickerCatalogSnapshot = { version: 1, entries: Object.fromEntries(getPackMap(pack)), summary: packSummaries.get(pack) ?? null, savedAt: Date.now() };
  return JSON.stringify(snapshot, null, 2);
}

/**
 * 上报所有 dirty 包的序列化快照，清空 dirty 标记并剪枝已退出白名单的目录。
 * @param post 向主线程发送贴纸目录快照事件的回调。
 */
export function flushDirtyStickerCatalogs(post: (event: AiStickerCatalogEvent) => void): void {
  if (dirtyPacks.size === 0) return;
  for (const pack of dirtyPacks) {
    post({ type: "stickerCatalog", pack, snapshot: buildSnapshot(pack) });
  }
  dirtyPacks.clear();
  pruneStickerCatalogs(getStickerConfig().packs);
}

/**
 * 为白名单各包后台启动贴纸目录对账与生成任务（同包已有在途任务时跳过）。
 * @param packs 需要确保目录已生成的贴纸包短名称列表。
 */
export function ensureStickerCatalogs(packs: readonly string[]): void {
  const signal: AbortSignal = aiChatWorkerAbortController.current.signal;
  for (const pack of packs) {
    if (generatingPacks.has(pack)) continue;
    const task: Promise<void> = generatePackCatalog(pack, signal).finally((): void => {
      if (generatingPacks.get(pack) === task) generatingPacks.delete(pack);
      pruneStickerCatalogs(getStickerConfig().packs);
    });
    generatingPacks.set(pack, task);
  }
}

/**
 * 判断包是否已退出白名单且无在途生成任务与待上报快照。
 * @param pack 贴纸包短名称。
 * @param active 当前生效的白名单贴纸包集合。
 * @returns 可安全回收该包缓存时返回 true，否则返回 false。
 */
function isStalePack(pack: string, active: ReadonlySet<string>): boolean {
  return !active.has(pack) && !generatingPacks.has(pack) && !dirtyPacks.has(pack);
}

/**
 * 按当前白名单剪除已下架且无在途任务与脏快照的包目录、简介及失败记录。
 * @param activePacks 当前生效的白名单贴纸包短名称列表。
 */
export function pruneStickerCatalogs(activePacks: readonly string[]): void {
  const active: ReadonlySet<string> = new Set(activePacks);
  let dropped: boolean = false;
  for (const pack of catalogs.keys()) {
    if (!isStalePack(pack, active)) continue;
    catalogs.delete(pack);
    dropped = true;
  }
  for (const pack of packSummaries.keys()) {
    if (isStalePack(pack, active)) packSummaries.delete(pack);
  }
  for (const pack of failedEntries.keys()) {
    if (isStalePack(pack, active)) failedEntries.delete(pack);
  }
  if (dropped) invalidateStickerMenu();
}

/**
 * 等待所有已启动的贴纸目录生成任务结算完成。
 */
export async function drainStickerCatalogTasks(): Promise<void> {
  while (generatingPacks.size > 0) {
    await Promise.allSettled([...generatingPacks.values()]);
  }
}

/**
 * 按 STICKER_CATALOG_RETRY_INTERVAL_MS 间隔筛选目录为空、简介缺失或失败负缓存已到期的包并触发对账。
 * @param packs 当前白名单贴纸包短名称列表。
 * @param now 当前毫秒时间戳。
 */
export function retryIncompleteStickerCatalogs(packs: readonly string[], now: number = Date.now()): void {
  if (
    stickerCatalogRetryState.lastAttemptAt !== 0 &&
    now - stickerCatalogRetryState.lastAttemptAt < STICKER_CATALOG_RETRY_INTERVAL_MS
  ) {
    return;
  }
  const incomplete: string[] = packs.filter((pack: string): boolean => {
    if ((catalogs.get(pack)?.size ?? 0) === 0 || !packSummaries.has(pack)) return true;
    const failed: ReadonlyMap<string, number> | undefined = failedEntries.get(pack);
    if (failed !== undefined) {
      for (const retryAt of failed.values()) {
        if (!isPendingWithin(retryAt, now, STICKER_CATALOG_ENTRY_FAILURE_RETRY_MS)) return true;
      }
    }
    return false;
  });
  if (incomplete.length === 0) return;
  stickerCatalogRetryState.lastAttemptAt = now;
  ensureStickerCatalogs(incomplete);
}

/**
 * 对账单个贴纸包：剪除线上已移除的条目，串行补齐缺失贴纸描述，并在条目变更或缺失简介时生成整包简介。
 * @param pack 贴纸包短名称。
 * @param signal 取消信号；默认绑定 AI Worker 生命周期信号。
 */
export async function generatePackCatalog(pack: string, signal: AbortSignal = aiChatWorkerAbortController.current.signal): Promise<void> {
  let menuChanged: boolean = false;
  try {
    const set: StickerSet | null = await getStickerSet(pack, undefined, signal);
    if (!set || signal.aborted) return;

    const map: Map<string, StickerCatalogEntry> = getPackMap(pack);
    const liveIds: Set<string> = new Set(set.stickers.map((sticker: Sticker): string => sticker.file_unique_id));
    let entriesChanged: boolean = false;
    for (const fileUniqueId of map.keys()) {
      if (!liveIds.has(fileUniqueId)) {
        map.delete(fileUniqueId);
        transientDescriptionCache.delete(fileUniqueId);
        entriesChanged = true;
        dirtyPacks.add(pack);
      }
    }
    if (entriesChanged) invalidateStickerMenu();
    const failed: Map<string, number> | undefined = failedEntries.get(pack);
    if (failed) {
      for (const fileUniqueId of failed.keys()) {
        if (!liveIds.has(fileUniqueId)) failed.delete(fileUniqueId);
      }
      if (failed.size === 0) failedEntries.delete(pack);
    }

    for (const sticker of set.stickers) {
      if (signal.aborted) return;
      if (map.has(sticker.file_unique_id) || isEntryFailureActive(pack, sticker.file_unique_id)) continue;

      const source: { fileId: string; fileUniqueId: string } | null = pickStickerVisionSource(sticker);
      if (!source) {
        markEntryFailed(pack, sticker.file_unique_id);
        continue;
      }
      const description: string | null = await resampleAiText({
        label: `Sticker catalog description (pack "${pack}", sticker ${sticker.file_unique_id})`,
        call: (): Promise<AiTextResult> => describeMediaForStickerCatalog(source.fileId, signal),
        delaysMs: STICKER_CATALOG_RETRY_DELAYS_MS,
        signal,
      });
      if (signal.aborted) return;
      if (!description) {
        markEntryFailed(pack, sticker.file_unique_id);
        continue;
      }
      map.set(sticker.file_unique_id, { emoji: sticker.emoji ?? "", description });
      transientDescriptionCache.delete(sticker.file_unique_id);
      entriesChanged = true;
      dirtyPacks.add(pack);
      menuChanged = true;
    }

    if (map.size > 0 && (entriesChanged || !packSummaries.has(pack))) {
      const summary: string | null = await resampleAiText({
        label: `Sticker pack summary (pack "${pack}")`,
        call: (): Promise<AiTextResult> => summarizePack(set.title, [...map.values()].map(formatEntryForSummary), signal),
        delaysMs: STICKER_CATALOG_RETRY_DELAYS_MS,
        signal,
      });
      if (signal.aborted) return;
      if (summary) {
        packSummaries.set(pack, summary);
        dirtyPacks.add(pack);
        menuChanged = true;
      } else {
        logger.error(`Failed to generate pack summary for sticker pack "${pack}" after retries; layer-1 sticker tool will show a placeholder until next reconcile.`);
      }
    }
  } catch (error: unknown) {
    if (!signal.aborted) logger.error(`Error reconciling sticker catalog for pack "${pack}":`, error);
  } finally {
    if (menuChanged) invalidateStickerMenu();
  }
}

/**
 * 将目录条目格式化为供整包简介模型读取的单行文本。
 * @param entry 单枚贴纸的目录条目。
 * @returns 带可选 emoji 前缀的描述行。
 */
function formatEntryForSummary(entry: StickerCatalogEntry): string {
  return entry.emoji ? `${entry.emoji} ${entry.description}` : entry.description;
}

/**
 * 调用 summaryAiProvider 将包内全部贴纸描述压缩为整包简介。
 * @param title 贴纸包显示标题。
 * @param descriptions 包内各贴纸的格式化描述行列表。
 * @param signal 取消信号。
 * @returns 模型生成的整包简介 AI 文本结果。
 */
async function summarizePack(
  title: string,
  descriptions: string[],
  signal: AbortSignal
): Promise<AiTextResult> {
  return summaryAiProvider().generateText({
    purpose: "stickerPackSummary",
    systemPrompt: STICKER_PACK_SUMMARY_PROMPT,
    userContent: `贴纸包「${title}」内每枚贴纸的画面描述：\n${descriptions.join("\n")}`,
    signal,
    errorLabel: STICKER_PACK_SUMMARY_ERROR_LABEL,
    normalize: (text: string): string => {
      const sanitized: string = sanitizeInline(text);
      return sanitized ? truncateAtClauseBoundary(sanitized, STICKER_PACK_SUMMARY_MAX_CHARS) : "";
    },
  });
}

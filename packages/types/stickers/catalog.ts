/** 贴纸目录快照中单枚贴纸（按 file_unique_id 索引）的 emoji 与画面描述。 */
export interface StickerCatalogEntry {
  emoji: string;
  description: string;
}

/** memory/stickers/<pack>.json 的版本化落盘结构。 */
export interface StickerCatalogSnapshot {
  version: 1;
  entries: Record<string, StickerCatalogEntry>;
  summary: string | null;
  savedAt: number;
}

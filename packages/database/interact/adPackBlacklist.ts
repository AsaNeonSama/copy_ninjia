import { and, asc, count, eq, gt } from "drizzle-orm";
import { AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES } from "../../consts/identityStorage";
import { adPackBlacklists } from "../schema/adPackBlacklist";
import type {
  AdPackBlacklistCounts,
  AdPackBlacklistKind,
} from "../../types/adPackBlacklist";
import type {
  StorageDatabase,
  StorageDatabaseReader,
  StoredAdPackBlacklistRow,
} from "../../types/storageDatabase";

/** `readStoredAdPackBlacklistPage` 的游标与页大小。 */
export interface StoredAdPackBlacklistPageCursor {
  /** 上一页最后一个包名；首页传 `null`。 */
  readonly afterPack: string | null;
  /** 单页最多读取的行数。 */
  readonly limit: number;
}

/**
 * 读取 `ad_pack_blacklists` 全表已提交行（按 `(kind, pack)` 升序；供测试与冷迁移核验使用）。
 *
 * @param database 共享存储数据库连接。
 * @returns `ad_pack_blacklists` 表中的全部原始行列表。
 */
export function readStoredAdPackBlacklists(
  database: StorageDatabase
): readonly StoredAdPackBlacklistRow[] {
  return database
    .select({
      kind: adPackBlacklists.kind,
      pack: adPackBlacklists.pack,
    })
    .from(adPackBlacklists)
    .orderBy(asc(adPackBlacklists.kind), asc(adPackBlacklists.pack))
    .all();
}

/**
 * 统计 `ad_pack_blacklists` 中贴纸包与自定义表情包各自已提交的总条数（供启动恢复使用，不加载全表行）。
 *
 * @param database 共享存储数据库连接。
 * @returns 两类广告包黑名单的条数统计。
 */
export function readStoredAdPackBlacklistCounts(
  database: StorageDatabase
): Readonly<AdPackBlacklistCounts> {
  const sticker: number = database
    .select({ value: count() })
    .from(adPackBlacklists)
    .where(eq(adPackBlacklists.kind, "sticker"))
    .get()?.value ?? 0;
  const emoji: number = database
    .select({ value: count() })
    .from(adPackBlacklists)
    .where(eq(adPackBlacklists.kind, "emoji"))
    .get()?.value ?? 0;
  return { sticker, emoji };
}

/**
 * 通过预编译语句按 `(kind, pack)` 列表批量查询 `ad_pack_blacklists` 已提交的命中包名；
 * 单包名走主键等值快路径，多包名经 `json_each` 批量查询（不超过 `AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES`）。
 *
 * @param reader 共享存储数据库的预编译读取句柄。
 * @param kind 目标黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param packs 待查询的合法包名列表。
 * @returns 在 SQLite 中已存在的包名列表。
 */
export function readStoredAdPackBlacklistMatches(
  reader: StorageDatabaseReader,
  kind: AdPackBlacklistKind,
  packs: readonly string[]
): readonly string[] {
  if (packs.length === 0) return [];
  if (packs.length === 1) {
    const row: Pick<StoredAdPackBlacklistRow, "pack"> | undefined =
      reader.adPackBlacklistByKey.get({ kind, pack: packs[0]! });
    return row === undefined ? [] : [row.pack];
  }
  if (packs.length > AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES) {
    throw new Error(
      `Ad pack blacklist reads accept at most ${AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES} packs.`
    );
  }
  const rows: readonly Pick<StoredAdPackBlacklistRow, "pack">[] =
    reader.adPackBlacklistsByPacks.all({ kind, packs: JSON.stringify(packs) });
  return rows.map((row: Pick<StoredAdPackBlacklistRow, "pack">): string => row.pack);
}

/**
 * 按 `(kind, pack)` 主键升序游标读取一页广告黑名单包名。
 *
 * @param database 共享存储数据库连接。
 * @param kind 目标黑名单种类（`"sticker"` 或 `"emoji"`）。
 * @param cursor 游标起点（不含）与单页行数上限。
 * @returns 按 ASCII 字典序升序排列的包名列表。
 */
export function readStoredAdPackBlacklistPage(
  database: StorageDatabase,
  kind: AdPackBlacklistKind,
  { afterPack, limit }: StoredAdPackBlacklistPageCursor
): readonly string[] {
  const rows: readonly Pick<StoredAdPackBlacklistRow, "pack">[] = database
    .select({ pack: adPackBlacklists.pack })
    .from(adPackBlacklists)
    .where(
      afterPack === null
        ? eq(adPackBlacklists.kind, kind)
        : and(eq(adPackBlacklists.kind, kind), gt(adPackBlacklists.pack, afterPack))
    )
    .orderBy(asc(adPackBlacklists.pack))
    .limit(limit)
    .all();
  return rows.map((row: Pick<StoredAdPackBlacklistRow, "pack">): string => row.pack);
}

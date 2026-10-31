import type { StorageDatabaseMigrationJournalEntry } from "../types/storageDatabase";

/** 黑名单、白名单与临时广告免检各自在主线程保留的热查询 LRU 容量。 */
export const IDENTITY_READ_CACHE_MAX_ENTRIES: number = 8_192;

/**
 * 单次跨线程冷读携带的主键上限；**必须严格小于** IDENTITY_READ_CACHE_MAX_ENTRIES。
 *
 * 预热时已缓存的主键先刷新热度、冷键再整块写入；块不超过 LRU 容量，同一块里的
 * 主键写完后全部仍在缓存中，余量容纳同一条 update 的其它身份。
 * 破坏性批量处置不依赖这份缓存的驻留，按块直接取局部结论（见
 * infra/identityStorage/read.ts 的 readIdentityPolicyVerdicts）。
 */
export const IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES: number = 4_096;

/**
 * 群级黑名单补扫一次从 SQLite 读取并投给 Anti-Raid Worker 的主键数上限。
 *
 * 游标页、跨线程消息与单群在途处置共用这一上限；不得把多页重新拼成全量数组。
 * 所属模块：infra/identityStorage/sweep.ts、cache/main/blocklist.ts、workers/diskIO/storageDatabase/identityPolicy.ts。
 */
export const BLOCKLIST_SWEEP_PAGE_SIZE: number = 512;

/** 每张业务表独立累计到该变化数时，立即用显式事务提交当前全部待写变化。 */
export const IDENTITY_WRITE_BATCH_MAX_ENTRIES: number = 128;

/**
 * 游标读取允许叠加的 Worker 事务内黑名单变化上限。
 *
 * 补扫在每页前先 flush 并确认主线程 revision 已 ACK，叠加量通常为零；
 * 本上限约束并发写入与异常恢复时读请求合并的未提交变化数。
 * 所属模块：workers/diskIO/storageDatabase/identityPolicy.ts。
 */
export const BLOCKLIST_SWEEP_PENDING_DELTA_MAX_ENTRIES: number =
  IDENTITY_WRITE_BATCH_MAX_ENTRIES;

/** 第一条待写变化进入后，即使未满批也必须在该窗口内提交。 */
export const IDENTITY_WRITE_FLUSH_INTERVAL_MS: number = 30_000;

/**
 * 群问答未提交变化（按 (chatId, q) 计条，含删除墓碑）累计到该条数时，立即用显式事务
 * 提交当前全部待写变化。所属模块：workers/diskIO/storageDatabase/flush.ts。
 */
export const CHAT_QA_WRITE_BATCH_MAX_ENTRIES: number = 32;

/** SQLite 当前唯一受支持的 schema 版本。 */
export const IDENTITY_DATABASE_SCHEMA_VERSION: number = 13;

/**
 * 当前 schema 唯一受支持的完整迁移谱系，按 created_at 升序：每项是 `__drizzle_migrations` 的
 * created_at 与对应 SQL 文件的 SHA-256，与 database/schema/migrations 的 meta/_journal.json
 * 逐条对应，SQL 变更必须同步更新。启动要求 `__drizzle_migrations` 与本表逐行相等。
 * 所属模块：database/interact/inspection.ts。
 */
export const STORAGE_MIGRATION_LINEAGE: readonly StorageDatabaseMigrationJournalEntry[] = [
  // 0000_identity_storage
  { createdAt: 20_260_811_000_000, hash: "6c68bc6862efa69ffc2fbd29284275a7e4094de3e8e3206f7ae19ca3b9da0000" },
  // 0001_whitelist_delegation_permission
  { createdAt: 20_260_812_000_000, hash: "b227cd2cfb34ffa77f50dac3c2b018a1294ceca4009a3c804eeff55e8a3c932e" },
  // 0002_chat_state
  { createdAt: 20_260_813_000_000, hash: "35147ec6645084114dfbfd3328652c6464810a83a94d717424691de354f7208e" },
  // 0003_chat_qa
  { createdAt: 20_260_823_000_000, hash: "e1e14c54793d5e76e89c959c2c2ebdaf005b64a2e7e9c5998c1ba2fabefd107a" },
  // 0004_temporary_whitelist
  { createdAt: 20_260_829_000_000, hash: "9a5d4cf250abc3881ab6cebb7f7be2c2d80596b47e3872f490e19602a304c978" },
  // 0005_temporary_whitelist_ad_bypass
  { createdAt: 20_260_830_000_000, hash: "6e1d6777fdc2f7cac747be2c6f6e0b2ca7a2ce30dab8d7cd8dcdb33866391528" },
  // 0006_translate_sessions
  { createdAt: 20_260_908_000_000, hash: "f36aba558a2b386c784140e85f5181d08e6909466181e253ea1cc77da88661c5" },
  // 0007_ai_context_persona
  { createdAt: 20_260_915_000_000, hash: "9e4c495581a707c70612433d28876334695775917fab534bba770850c8b8d0c4" },
  // 0008_clear_context_permission
  { createdAt: 20_260_915_010_000, hash: "50aefd0c0916b681cae8914a589b7d50e212f368551551c186813299cde8242d" },
  // 0009_h_image_add_permission
  { createdAt: 20_260_920_000_000, hash: "699c8bfe967c8c2b6d88963f3b8f59725c2743ce417211ffdbf76d7c94ad5226" },
  // 0010_remove_chat_persona
  { createdAt: 20_261_001_000_000, hash: "86b4dee97dbd407b3acefcb93f6dc848c90bbee8a52ef0be4d832fc264807eef" },
  // 0011_time_zone_marker
  { createdAt: 20_261_003_000_000, hash: "0691bf88adb273181fd8e0365b8dddd1aa69b173c2a10534db6e43c6679741d1" },
];

/** SQLite 表级 CHECK 对自产 JSONB 做常数时间外壳校验的标志位。 */
export const IDENTITY_DATABASE_JSONB_VALIDATION_FLAG: number = 0x04;

/** 启动校验逐行确认内容是严格 SQLite JSONB 的标志位。 */
export const IDENTITY_DATABASE_JSONB_STRICT_VALIDATION_FLAG: number = 0x08;

/** storage_metadata 中 schema-version 行的当前值；写入边界会把它转换为 JSONB。 */
export const IDENTITY_DATABASE_SCHEMA_DATA: string = JSON.stringify(
  { version: IDENTITY_DATABASE_SCHEMA_VERSION }
);

/** storage_metadata 中记录 schema 版本的固定主键。 */
export const IDENTITY_DATABASE_SCHEMA_KEY: string = "schema-version";

/**
 * storage_metadata 中记录数据根绑定时区的固定主键；值形如 `{"timeZone":"<规范 IANA 名>"}`
 * （StorageTimeZoneMetadata）。建库时写入配置时区，启动与安装器只读比对，运行期不改写。
 * 所属模块：database/interact/initialization.ts、database/validation/storageRows.ts。
 */
export const IDENTITY_DATABASE_TIME_ZONE_KEY: string = "time-zone";

/**
 * 当前格式 storage_metadata 的完整主键集合：恰为 schema 版本与时区标记两行，缺项或多余键都拒绝启动。
 * 所属模块：database/validation/storageRows.ts。
 */
export const IDENTITY_DATABASE_METADATA_KEYS: readonly string[] = [
  IDENTITY_DATABASE_SCHEMA_KEY,
  IDENTITY_DATABASE_TIME_ZONE_KEY,
];

/** SQLite 目录权限；setgid 保证旁路文件继承部署数据根的协作组。 */
export const IDENTITY_DATABASE_DIRECTORY_MODE: number = 0o2770;

/** SQLite 主库及 WAL/SHM 旁路文件权限；owner 与部署协作组均可读写。 */
export const IDENTITY_DATABASE_FILE_MODE: number = 0o660;

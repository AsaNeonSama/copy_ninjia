/** 当前发布支持的直接冷迁移边描述。 */
export interface ColdMigrationEdge {
  /** `package.json` `scripts` 中登记的冷迁移命令名。 */
  readonly command: string;
  /** `package.json` `scripts` 对应的 Bun 执行命令文本。 */
  readonly invocation: string;
  /** 仓库内冷迁移 TypeScript 源码入口相对路径。 */
  readonly entryPath: string;
  /** 二进制发行包内打包后的 JS 产物相对路径。 */
  readonly bundledPath: string;
}

/**
 * 当前受支持的直接冷迁移边（两条边各自对应独立持久化数据集，互不替代）：
 * - `memory/wed/<chatId>.json`：上一次迁移产出格式的成员 ID 数组经 `migrate:wed-member-window`
 *   转换为 `{ id, enteredAt }` 滑窗数组，每群保留最后 `WED_MEMBER_LIMIT` 个 ID，进入时间统一记为迁移开始时刻；
 * - `database/storage.sqlite` 与可选 `config/dynamic/ad_detect.json`：schema v13 备份经
 *   `migrate:ad-pack-blacklists` 升至 schema v14（`ad_pack_blacklists` 表），将旧 4 键 `ad_detect.json`
 *   中的贴纸包与自定义表情包黑名单迁入 SQLite 并写出清理后的 2 键 `ad_detect.json`。
 */
export const ACTIVE_COLD_MIGRATION_EDGES: readonly ColdMigrationEdge[] = [{
  command: "migrate:wed-member-window",
  invocation: "bun scripts/migrateWedMemberWindow.ts",
  entryPath: "scripts/migrateWedMemberWindow.ts",
  bundledPath: "scripts/migrations/migrateWedMemberWindow.js",
}, {
  command: "migrate:ad-pack-blacklists",
  invocation: "bun scripts/migrateAdPackBlacklists.ts",
  entryPath: "scripts/migrateAdPackBlacklists.ts",
  bundledPath: "scripts/migrations/migrateAdPackBlacklists.js",
}];

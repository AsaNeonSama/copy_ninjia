/** 当前发布支持的直接冷迁移边。 */
export interface ColdMigrationEdge {
  readonly command: string;
  readonly invocation: string;
  readonly entryPath: string;
  readonly bundledPath: string;
}

/**
 * 当前受支持的直接冷迁移边：上一次迁移产出格式的 memory/wed/<chatId>.json（成员 ID 数组）
 * 经 migrate:wed-member-window 转换为 `{ id, enteredAt }` 滑窗数组，每群保留最后 WED_MEMBER_LIMIT 个 ID，
 * 进入时间统一记为迁移开始时刻。
 */
export const ACTIVE_COLD_MIGRATION_EDGES: readonly ColdMigrationEdge[] = [{
  command: "migrate:wed-member-window",
  invocation: "bun scripts/migrateWedMemberWindow.ts",
  entryPath: "scripts/migrateWedMemberWindow.ts",
  bundledPath: "scripts/migrations/migrateWedMemberWindow.js",
}];

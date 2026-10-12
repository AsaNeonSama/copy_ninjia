/** 当前发布支持的直接冷迁移边。 */
export interface ColdMigrationEdge {
  readonly command: string;
  readonly invocation: string;
  readonly entryPath: string;
  readonly bundledPath: string;
}

/**
 * 当前受支持的直接冷迁移边，只接受上一次迁移产出的格式：
 * 17.2.1 的 memory/wed/<chatId>.json（成员 ID 数组）经 migrate:wed-member-window 直接改写为
 * `{ id, enteredAt }` 滑窗数组，每群只保留最后 WED_MEMBER_LIMIT 个 ID，进入时间统一记为迁移开始时刻。
 * 其余持久化数据格式不变，原样沿用。
 *
 * 源文件不变，中断后保留现场并向新目录重跑；ready.json 是唯一完成标记；产物由运维在停服期间
 * 手工替换。落后于上一次迁移的部署先分阶段升级到其产出格式并完成该迁移；迁移边和对应测试
 * 整体维护，不追加更早格式的兼容入口。
 */
export const ACTIVE_COLD_MIGRATION_EDGES: readonly ColdMigrationEdge[] = [{
  command: "migrate:wed-member-window",
  invocation: "bun scripts/migrateWedMemberWindow.ts",
  entryPath: "scripts/migrateWedMemberWindow.ts",
  bundledPath: "scripts/migrations/migrateWedMemberWindow.js",
}];

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

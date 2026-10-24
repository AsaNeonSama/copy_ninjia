import type { PendingBlockedRemoval } from "./blocklist";
import type { ChatState } from "./chatState";
import type { BlocklistEntryData, WhitelistEntryData } from "./identityPolicy";
import type { TemporaryAdBypassActivity } from "./states/temporaryAdBypass";
import type { StoredTemporaryAdBypassActivity } from "./temporaryAdBypass";

/**
 * 主线程合并身份缓存的一条（cache/main/identityStorage.ts 的 identityPolicyCache）。三个字段固定写全、
 * 顺序固定：`undefined` 表示该项尚未加载，`null` 表示已确证不存在，对象为已加载的最终值。
 * 三项随条目一起淘汰。
 */
export interface IdentityPolicyCacheEntry {
  whitelist: Readonly<WhitelistEntryData> | null | undefined;
  blocklist: Readonly<BlocklistEntryData> | null | undefined;
  temporaryAdBypass: Readonly<TemporaryAdBypassActivity> | null | undefined;
}

/** Disk I/O 回执路由层尚未解码的永久策略文本与临时累计关系列。 */
export interface IdentityPolicyRawReadResult {
  readonly whitelist: readonly (readonly [number, string])[];
  readonly blocklist: readonly (readonly [number, string])[];
  readonly temporaryAdBypass: readonly StoredTemporaryAdBypassActivity[];
}

/**
 * 一次直接冷读得到的本批永久策略结论，只由发起读取的调用方局部持有；
 * 不经过身份 LRU，其它流量的缓存淘汰不改变它。
 */
export interface IdentityPolicyVerdicts {
  /** 读取时刻存在永久白名单记录的身份（不含只由配置授予的超级管理员）。 */
  readonly whitelisted: ReadonlySet<number>;
  /** 读取时刻存在黑名单记录的身份。 */
  readonly blocked: ReadonlySet<number>;
}

/** SQLite 按主键稳定顺序返回的一页黑名单 ID；载荷受固定页大小硬顶。 */
export interface BlocklistIdPage {
  readonly ids: readonly number[];
  /** 本页最后一个主键；空页保持请求游标，完成页不再使用它续读。 */
  readonly nextCursor: number | null;
  /** true 表示当前游标之后已没有更多有效黑名单主键。 */
  readonly done: boolean;
}

/** SQLite 按主键稳定顺序返回的一页白名单 ID；载荷受固定页大小硬顶。 */
export type WhitelistIdPage = BlocklistIdPage;

/** 主线程按表和主键保留到事务 ACK 的最终值。 */
export interface UnacknowledgedIdentityWrite {
  readonly data: string | null;
  readonly revision: number;
}

/** Disk I/O Worker 同一名单主键在事务提交前保留的最新最终值。 */
export interface PendingIdentityPolicyWrite {
  readonly data: string | null;
  readonly revision: number;
}

/**
 * 主线程待踢任务一行最近一次写入的 revision、投递结果与准入估算字节；正文不复制，投递与重放都从
 * pendingBlockedRemovals 现编码。posted 为 false 表示该次投递被 Disk I/O 拒收，write-ahead 前补投。
 */
export interface UnacknowledgedRemovalWrite {
  readonly revision: number;
  readonly posted: boolean;
  /** 这次写入该行正文的准入估算字节，计入 unacknowledgedRemovalBytes。 */
  readonly bytes: number;
}

/** Disk I/O Worker 待踢任务一行在事务提交前保留的最新最终值。 */
export interface PendingRemovalWrite {
  readonly data: string | null;
  readonly revision: number;
}

/**
 * Disk I/O Worker 已接受的一行待踢任务的处置目标（cache/workers/diskIO/storageDatabase.ts 的
 * removalRowTargets）：补扫行不冻结名单，指名行冻结 userIds。黑名单删除时据此校验没有行再引用。
 */
export interface RemovalRowTargets {
  readonly probeMembership: boolean;
  readonly userIds: readonly number[];
}

/** Disk I/O Worker 同一群主键在事务提交前保留的最新最终值。 */
export interface PendingChatStateWrite {
  readonly data: string | null;
  readonly revision: number;
}

/** 一群 AI 上下文的未提交最终值与对应 AI 记忆 revision；`snapshot` 为 null 表示清空。 */
export interface PendingAiContextWrite {
  readonly snapshot: string | null;
  readonly revision: number;
  /** 被本项覆盖、尚未回执的更早删除 revision；本项提交后一并回执，没有时为 null。 */
  readonly coveredDeleteRevision: number | null;
}

/** 一条群问答的未提交最终值；`data` 为 null 表示删除这条问答。 */
export interface PendingChatQaWrite {
  readonly data: string | null;
  readonly revision: number;
}

/** 主线程保留到 SQLite ACK 的最小群状态恢复元数据；正文只存在于群状态热读副本 chatStateCache。 */
export interface UnacknowledgedChatStateWrite {
  readonly revision: number;
  readonly deleted: boolean;
  /** 这次写入状态正文的准入估算字节，计入 unacknowledgedChatStateBytes。 */
  readonly bytes: number;
}

/** 共享存储数据库启动恢复交给主线程的有界结果。 */
export interface StorageDatabaseHydration {
  readonly blocklistEntryCount: number;
  readonly permissionEntryCount: number;
  readonly pendingBlockedRemovals: Map<number, PendingBlockedRemoval>;
  readonly chatStates: Map<number, ChatState>;
  /** 群 -> 问题 -> 答案。行数以 STATE_MANAGED_CHAT_LIMIT × CHAT_QA_MAX_PER_CHAT 为界，启动一次性读全。 */
  readonly chatQa: Map<number, ReadonlyMap<string, string>>;
}

/** 整库严格校验成功后的有限恢复快照；尚未发布到 Worker 缓存。 */
export interface StorageDatabaseInspection {
  readonly hydration: StorageDatabaseHydration;
  readonly aiMemories: ReadonlyMap<number, string>;
}

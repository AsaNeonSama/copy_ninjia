/** owner: main。发送者身份双向索引缓存（packages/users/senderIdentity.ts）。 */

import { USER_CACHE_MAX } from "../../consts/senderIdentity";
import { FifoMap } from "../../libs/fifoMap";
import type { CachedUser } from "../../types/chatState";

/**
 * 小写 username 到最近观测到的 CachedUser 的 FIFO 缓存：启动预热或收到消息时由 users/senderIdentity.ts 写入，发送者改名、去名或换绑时撤销旧键。
 * 容量上限为 USER_CACHE_MAX，满额时由 deleteAlias 连带淘汰最旧条目及其反向索引；进程重启后从空表开始。
 */
export const userCache: FifoMap<string, CachedUser> = new FifoMap(USER_CACHE_MAX);

/** 发送者 ID 到当前小写 username 的反向索引：与 userCache 成对写入、同步淘汰；容量上限为 USER_CACHE_MAX，进程重启后从空表开始。 */
export const senderUsernameCache: Map<number, string> = new Map();

/** 发送者 ID 到当前 CachedUser 引用的直查表：与 senderUsernameCache 键集一致，在 updateCachedIdentity 与 deleteAlias 中成对写入和淘汰；容量上限为 USER_CACHE_MAX，进程重启后从空表开始（无条目表示未缓存该身份）。 */
export const identityById: Map<number, CachedUser> = new Map();

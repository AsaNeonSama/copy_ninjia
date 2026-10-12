import type { User } from "grammy/types";
import type { CurrentAvatar } from "./telegram";

/** /wed 本轮核实的用户与头像发送源，仅在本次交互中持有。 */
export interface WedCandidate extends CurrentAvatar {
  readonly identity: User;
}

/** 主线程拥有的一张 /wed 结果；图片仅在单次请求栈中持有。 */
export interface WedSession {
  readonly chatId: number;
  readonly actor: User;
  readonly messageThreadId: number | undefined;
  readonly controller: AbortController;
  messageId: number | undefined;
  targetId: number | undefined;
  confirmed: boolean;
  busy: boolean;
}

/** 在途头像查询；按群记录新发言，防止旧查询结论删除新观察到的候选。 */
export interface WedAvatarProbe {
  readonly observedChats: Set<number>;
}

/** 每群结果会话为纯内存；成员滑窗引用主线程持久化 owner。 */
export interface WedChat {
  readonly controller: AbortController;
  /** 与 WedMemberState.members 是同一个 Map。 */
  readonly members: Map<number, number>;
  readonly sessions: Map<number, WedSession>;
  /** 机器人已离群或群已不存在：收尾置位后，正在重抽的会话不再删除被它替换的旧结果。 */
  departed: boolean;
}

/** `memory/wed/<chatId>.json` 数组的一项：成员 ID 与进入滑窗的 Unix 毫秒时间戳。 */
export interface WedMemberEntry {
  readonly id: number;
  readonly enteredAt: number;
}

/** 主线程拥有的成员滑窗；修订号只用于进程内恢复定序，不写入 JSON。 */
export interface WedMemberState {
  /** 成员 ID → 进入时间；插入顺序即进入顺序，进入时间随之不减，首项最早。 */
  readonly members: Map<number, number>;
  /** 本窗口已分配过的最大进入时间；新成员取它与当前时刻的较大值，墙钟回拨时也不破坏顺序。 */
  latestEnteredAt: number;
  revision: number;
  dirty: boolean;
}

/** 主线程每日成员复核的调度与当前探测；新在群观察可否决迟到的离群结果。 */
export interface WedMemberReview {
  readonly controller: AbortController;
  ready: boolean;
  pendingDay: string | null;
  lastDay: string | null;
  running: boolean;
  chatId: number | null;
  userId: number | null;
  observed: boolean;
}

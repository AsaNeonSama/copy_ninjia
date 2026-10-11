import { VERIFICATION_TIMEOUT_MS } from "../../../packages/consts/antiRaid/verification";
import {
  clearActiveVerificationSnapshots,
  isActiveVerificationUser,
  setActiveVerificationSnapshot,
} from "../../../packages/cache/main/antiRaid/verificationMirror";
import { verificationKey } from "../../../packages/libs/verificationKey";
import type { PendingVerificationSnapshot } from "../../../packages/types/antiRaid/verification";
import { BENCHMARK_CHAT_ID, BENCHMARK_EPOCH_MS, BENCHMARK_SENDER_ID } from "./fixtures";
import type { Scenario } from "./types";

/** 有待验证成员的群数。 */
const PENDING_CHAT_COUNT: number = 5;
/** 每个有待验证成员的群里的待验证人数。 */
const PENDING_USERS_PER_CHAT: number = 20;
/** 每个被查询的群里轮流发言的不同发送者数；前 PENDING_USERS_PER_CHAT 个在有待验证成员的群里是待验证者。 */
const QUERIED_USERS_PER_CHAT: number = 64;

/**
 * 每条群消息的「发送者是否待验证」判定（antiRaid/updateIngress.ts 与 antiRaid/adCandidate.ts 调用的
 * isActiveVerificationUser）。主线程验证镜像里有 PENDING_CHAT_COUNT 个群、每群 PENDING_USERS_PER_CHAT 条
 * 待验证快照；查询轮流落在这些群与同样数量的无待验证群上，发送者在 QUERIED_USERS_PER_CHAT 人之间轮换。
 */
export function pendingVerificationLookupScenario(): Scenario {
  const queriedChatIds: number[] = [];
  for (let index: number = 0; index < PENDING_CHAT_COUNT * 2; index++) {
    queriedChatIds.push(BENCHMARK_CHAT_ID - index);
  }
  const queriedUserIds: number[] = [];
  for (let index: number = 0; index < QUERIED_USERS_PER_CHAT; index++) {
    queriedUserIds.push(BENCHMARK_SENDER_ID + index);
  }
  return {
    iterations: 20_000_000,
    prepare: (): void => {
      for (let chatIndex: number = 0; chatIndex < PENDING_CHAT_COUNT; chatIndex++) {
        const chatId: number = queriedChatIds[chatIndex]!;
        for (let userIndex: number = 0; userIndex < PENDING_USERS_PER_CHAT; userIndex++) {
          const userId: number = queriedUserIds[userIndex]!;
          const snapshot: PendingVerificationSnapshot = {
            chatId,
            userId,
            generation: 1,
            revision: 1,
            phase: "pending",
            label: "待验证成员",
            isBot: false,
            announcementMessageId: undefined,
            trackedMessageTimes: [],
            invitedBy: undefined,
            reminderMessageId: undefined,
            replyReminderMessageId: undefined,
            replyReminderRequested: false,
            welcomeAnchorMessageId: undefined,
            reminderSuperseded: false,
            joinedAt: BENCHMARK_EPOCH_MS,
            expiresAt: BENCHMARK_EPOCH_MS + VERIFICATION_TIMEOUT_MS,
          };
          setActiveVerificationSnapshot(verificationKey(chatId, userId), snapshot);
        }
      }
    },
    run: (iterations: number): number => {
      let checksum: number = 0;
      const chatCount: number = queriedChatIds.length;
      for (let index: number = 0; index < iterations; index++) {
        const chatId: number = queriedChatIds[index % chatCount]!;
        const userId: number = queriedUserIds[index % QUERIED_USERS_PER_CHAT]!;
        if (isActiveVerificationUser(chatId, userId)) checksum++;
      }
      return checksum;
    },
    reset: clearActiveVerificationSnapshots,
    probes: { isActiveVerificationUser },
  };
}

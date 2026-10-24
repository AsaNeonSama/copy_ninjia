import type { DiskBusinessMessage } from "../types/diskIO/messages";
import type { IdentityPolicyTable } from "../types/identityPolicy";
import type { LinkedQueue } from "./linkedQueue";

/** 一次恢复的镜像水位与已覆盖消息身份；容量沿用领域未 ACK 表及有界 FIFO，恢复结束释放。 */
export class DiskIORecoveryRevisions {
  private readonly policies: Readonly<Record<IdentityPolicyTable, Map<number, number>>> = {
    whitelist: new Map(), blocklist: new Map(),
  };
  private readonly temporary: Map<number, number> = new Map();
  private readonly states: Map<number, number> = new Map();
  private readonly questions: Map<number, Map<string, number>> = new Map();
  private readonly removals: Map<number, number> = new Map();
  private joinLogs: number = 0;
  private readonly coveredStickers: WeakSet<DiskBusinessMessage> = new WeakSet();
  private readonly coveredWedOperations: WeakSet<DiskBusinessMessage> = new WeakSet();

  /**
   * 只在镜像成功进入有序通道后登记；消费 ACK 不会清除此恢复水位。
   * @param message 本轮恢复已排入有序通道的镜像业务消息。
   * @param buffered 当前已在恢复 FIFO 中的旧代业务消息队列。
   */
  record(message: DiskBusinessMessage, buffered: LinkedQueue<DiskBusinessMessage>): void {
    switch (message.type) {
      case "identityPolicyWrite": this.policies[message.table].set(message.id, message.revision); break;
      case "temporaryAdBypassWrite": this.temporary.set(message.id, message.revision); break;
      case "chatStateWrite": this.states.set(message.chatId, message.revision); break;
      case "wedMembers":
      case "deleteWedMembers":
        // 镜像代表此刻最终操作；只覆盖登记时已在 FIFO 的旧代消息，之后的新操作仍按序送达。
        for (const previous of buffered.values()) {
          if ((previous.type === "wedMembers" || previous.type === "deleteWedMembers") && previous.chatId === message.chatId) {
            this.coveredWedOperations.add(previous);
          }
        }
        break;
      case "chatQaWrite": {
        let questions: Map<string, number> | undefined = this.questions.get(message.chatId);
        if (questions === undefined) { questions = new Map(); this.questions.set(message.chatId, questions); }
        questions.set(message.q, message.revision);
        break;
      }
      case "blocklistRemovalWrite": this.removals.set(message.removalId, message.revision); break;
      // 未确认镜像按序号原序重放，FIFO 里序号不超过末条的入群事实都已随镜像送达。
      case "joinLog": this.joinLogs = message.sequence; break;
      case "stickerCatalog":
        for (const previous of buffered.values()) {
          if (previous.type === "stickerCatalog" && previous.pack === message.pack) this.coveredStickers.add(previous);
        }
        break;
      // 入群日志整群删除按 FIFO 执行。
      case "deleteJoinLog":
      case "aiMemory":
      case "deleteAiMemory":
      case "forgetAiMemory":
      case "luckDraw":
      case "verificationUpsert":
      case "verificationDelete": break;
    }
  }

  /**
   * 已被本轮镜像覆盖的旧 FIFO 操作不再执行；后续新操作继续按序投递。
   * @param message 待判定的恢复 FIFO 业务消息。
   * @returns 已被本轮恢复镜像水位或实体集合覆盖时返回 true，否则返回 false。
   */
  covers(message: DiskBusinessMessage): boolean {
    switch (message.type) {
      case "identityPolicyWrite": return (this.policies[message.table].get(message.id) ?? 0) >= message.revision;
      case "temporaryAdBypassWrite": return (this.temporary.get(message.id) ?? 0) >= message.revision;
      case "chatStateWrite": return (this.states.get(message.chatId) ?? 0) >= message.revision;
      case "wedMembers":
      case "deleteWedMembers": return this.coveredWedOperations.has(message);
      case "chatQaWrite": return (this.questions.get(message.chatId)?.get(message.q) ?? 0) >= message.revision;
      case "blocklistRemovalWrite": return (this.removals.get(message.removalId) ?? 0) >= message.revision;
      case "joinLog": return this.joinLogs >= message.sequence;
      case "stickerCatalog": return this.coveredStickers.has(message);
      default: return false;
    }
  }
}

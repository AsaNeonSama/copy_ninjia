import { DISK_BUSINESS_MESSAGE_BASE_BYTES, DISK_JSON_STRING_UNIT_MAX_BYTES } from "../consts/diskIO/business";
import type { VerificationSnapshot } from "../types/antiRaid/verification";
import type {
  DiskBusinessMessage,
  QueuedDiskIOOperationMessage,
  VerificationUpsertDiskMessage,
} from "../types/diskIO/messages";

/**
 * 联合类型各成员键的并集；结构上界模板据此必须列出每个可能出现的字段。模板只约束键齐全：
 * 整数字段填 LONGEST_SAFE_INTEGER、枚举填最长取值，字符串与数组字段在模板里留空，由
 * verificationUpsertMaxBytes 按实际长度单独计价，新增这类字段
 * 必须同时补上它的计价项。
 */
type AllKeys<T> = T extends unknown ? keyof T : never;

/** JSON 写法最长的安全整数（Number.MIN_SAFE_INTEGER），模板里的整数字段一律取它。 */
const LONGEST_SAFE_INTEGER: number = Number.MIN_SAFE_INTEGER;
/** 整数数组里一个元素的 JSON 上界：最长写法加分隔逗号。 */
const INTEGER_ELEMENT_MAX_BYTES: number = String(LONGEST_SAFE_INTEGER).length + 1;

/**
 * 验证快照的上界模板：各 phase 字段取并集、枚举取最长取值；label 与 trackedMessageTimes
 * 留空按实际长度另计。
 */
const VERIFICATION_SNAPSHOT_TEMPLATE: Readonly<Record<AllKeys<VerificationSnapshot>, unknown>> = {
  chatId: LONGEST_SAFE_INTEGER,
  userId: LONGEST_SAFE_INTEGER,
  generation: LONGEST_SAFE_INTEGER,
  revision: LONGEST_SAFE_INTEGER,
  label: "",
  isBot: false,
  announcementMessageId: LONGEST_SAFE_INTEGER,
  trackedMessageTimes: [],
  invitedBy: LONGEST_SAFE_INTEGER,
  reminderMessageId: LONGEST_SAFE_INTEGER,
  replyReminderMessageId: LONGEST_SAFE_INTEGER,
  replyReminderRequested: false,
  welcomeAnchorMessageId: LONGEST_SAFE_INTEGER,
  reminderSuperseded: false,
  joinedAt: LONGEST_SAFE_INTEGER,
  expiresAt: LONGEST_SAFE_INTEGER,
  phase: "checkingInviter",
  requestedAt: LONGEST_SAFE_INTEGER,
  countedJoinAt: LONGEST_SAFE_INTEGER,
  terminalInviterId: LONGEST_SAFE_INTEGER,
  expelReason: "timeout",
  successNoticeSent: true,
  failureNoticeSent: true,
  unconfirmedNoticeSent: true,
  removalConfirmed: true,
};
/** verificationUpsert 消息的上界模板。 */
const VERIFICATION_UPSERT_TEMPLATE: Readonly<Record<keyof VerificationUpsertDiskMessage, unknown>> = {
  type: "verificationUpsert",
  record: VERIFICATION_SNAPSHOT_TEMPLATE,
  critical: false,
};
/**
 * verificationUpsert 消息除 label 字符与 trackedMessageTimes 元素外的 JSON 字节上界：
 * 各 phase 的字段取并集，整数取最长写法，枚举取最长取值。
 */
const VERIFICATION_UPSERT_MAX_BYTES: number = JSON.stringify(VERIFICATION_UPSERT_TEMPLATE).length;

/**
 * verificationUpsert 的 JSON 字节上界。
 * @param message 入群验证状态落盘消息。
 * @returns 该消息序列化为 JSON 时的保守最大字节数。
 */
function verificationUpsertMaxBytes(message: VerificationUpsertDiskMessage): number {
  return VERIFICATION_UPSERT_MAX_BYTES +
    message.record.label.length * DISK_JSON_STRING_UNIT_MAX_BYTES +
    message.record.trackedMessageTimes.length * INTEGER_ELEMENT_MAX_BYTES;
}

/**
 * 操作 FIFO 中字符串与消息对象的保守成本；高频固定字段不重新序列化。验证快照按结构算
 * JSON 字节上界。启动 load 与诊断批次不进 FIFO，不在计价范围内。
 * @param message 待排入磁盘 I/O 操作 FIFO 的消息。
 * @returns 封顶在 `Number.MAX_SAFE_INTEGER` 内的正安全整数成本字节估算值。
 */
export function diskIOMessageCost(message: QueuedDiskIOOperationMessage): number {
  let payloadBytes: number = 0;
  switch (message.type) {
    case "aiMemory":
      payloadBytes = message.snapshot.length * 2;
      break;
    case "stickerCatalog":
      payloadBytes = (message.snapshot.length + message.pack.length) * 2;
      break;
    case "luckDraw":
      payloadBytes = (message.day.length + message.key.length + message.label.length) * 2;
      break;
    case "identityPolicyWrite":
    case "chatStateWrite":
    case "blocklistRemovalWrite":
      payloadBytes = (message.data?.length ?? 0) * 2;
      break;
    case "chatQaWrite":
      payloadBytes = (message.q.length + (message.data?.length ?? 0)) * 2;
      break;
    case "readIdentityPolicies":
      payloadBytes = message.ids.length * 8;
      break;
    case "wedMembers":
      payloadBytes = message.entries.length * 8;
      break;
    case "verificationUpsert":
      payloadBytes = verificationUpsertMaxBytes(message) * 2;
      break;
    case "ensureLuckSecret":
      payloadBytes = message.day.length * 2;
      break;
    case "joinLog":
    case "deleteJoinLog":
    case "deleteWedMembers":
    case "deleteAiMemory":
    case "forgetAiMemory":
    case "verificationDelete":
    case "temporaryAdBypassWrite":
    case "flush":
    case "readJoinLog":
    case "readBlocklistIdPage":
    case "recoveryReplay":
    case "storageFlushHold":
    case "closeStorage":
      break;
    default: {
      // 穷尽性断言：新增进 FIFO 的消息变体时这一行编译失败，须为它显式定价。
      // 计价是跨线程传输预算与背压的容量单位（见 infra/diskIO/transport.ts）。
      // 运行期不可达：调用方只对本线程构造的消息记账。
      const unhandled: never = message;
      throw new Error(
        "Unsupported Disk I/O operation message type: " +
        String((unhandled as QueuedDiskIOOperationMessage).type)
      );
    }
  }
  return Math.min(Number.MAX_SAFE_INTEGER, DISK_BUSINESS_MESSAGE_BASE_BYTES + payloadBytes);
}

/**
 * 代际失效时只把业务事实交给恢复 FIFO，逐请求等待者由宿主拒绝。
 * @param message 磁盘 I/O 操作队列中的消息。
 * @returns 为需要跨代保留重放的业务事实写消息时返回 true，控制或读取请求返回 false。
 */
export function isDiskBusinessMessage(message: QueuedDiskIOOperationMessage): message is DiskBusinessMessage {
  switch (message.type) {
    case "recoveryReplay":
    case "storageFlushHold":
    case "flush":
    case "readIdentityPolicies":
    case "readBlocklistIdPage":
    case "readJoinLog":
    case "ensureLuckSecret":
    case "closeStorage":
      return false;
    default:
      return true;
  }
}

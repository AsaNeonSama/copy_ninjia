import { mock } from "bun:test";
import { BLOCKLIST_SWEEP_PAGE_SIZE } from "../../packages/consts/identityStorage";
import {
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_SESSION_HEADER,
  MINI_APP_WEB_APP_DATA_SECRET_SEED,
} from "../../packages/consts/miniApp";
import type {
  AiMemoryDeletedPersistedReply,
  DiskBusinessMessage,
  DomainFlushOutcome,
  IdentityPolicyPersistedRevision,
  IdentityStoragePersistedReply,
  JoinLogRecord,
} from "../../packages/types/diskIO";
import type { IdentityPolicyTable } from "../../packages/types/identityPolicy";
import type {
  IdentityIdPage,
  IdentityPolicyRawReadResult,
} from "../../packages/types/identityStorage";
import { diskIOReplyStub, diskIOStub } from "./diskIOMock";

/** Mini App 集成测试共享的 Disk I/O 业务消息记录。 */
const miniAppTestDiskMessages: DiskBusinessMessage[] = [];

/** Mini App 集成测试共享的白名单数据库行夹具。 */
export const miniAppTestWhitelistRows: Map<number, string> = new Map<number, string>();

/** Mini App 集成测试共享的黑名单数据库行夹具。 */
export const miniAppTestBlocklistRows: Map<number, string> = new Map<number, string>();

/** Mini App 集成测试共享的入群日志与 flush 钩子可变状态。 */
export const miniAppTestJoinLogState: {
  records: readonly JoinLogRecord[];
  shouldThrow: boolean;
  onFlushDiskIODomain: (() => void) | undefined;
} = {
  records: [],
  shouldThrow: false,
  onFlushDiskIODomain: undefined,
};

const persistedListeners: ((reply: IdentityStoragePersistedReply) => void)[] = [];
const aiMemoryDeletedListeners: ((reply: AiMemoryDeletedPersistedReply) => void)[] = [];
let diskIOMockInstalled: boolean = false;

/**
 * 按 SQLite 游标页契约从夹具行表切出 `afterId` 之后的一页主键。
 * @param rows 内存模拟行表。
 * @param afterId 上一页游标。
 * @returns 游标分页结果。
 */
function idPage(rows: ReadonlyMap<number, string>, afterId: number | null): IdentityIdPage {
  const sorted: number[] = [...rows.keys()]
    .filter((id: number): boolean => afterId === null || id > afterId)
    .sort((left: number, right: number): number => left - right);
  const ids: number[] = sorted.slice(0, BLOCKLIST_SWEEP_PAGE_SIZE);
  return {
    ids,
    nextCursor: ids.length === 0 ? afterId : ids[ids.length - 1]!,
    done: sorted.length <= BLOCKLIST_SWEEP_PAGE_SIZE,
  };
}

/**
 * 按夹具行表回答身份策略冷读。
 * @param ids 待读取的身份 ID。
 * @returns 命中的白名单与黑名单行。
 */
async function readFixtureIdentityPolicies(ids: readonly number[]): Promise<IdentityPolicyRawReadResult> {
  const whitelist: [number, string][] = [];
  const blocklist: [number, string][] = [];
  for (const id of ids) {
    const wRow: string | undefined = miniAppTestWhitelistRows.get(id);
    if (wRow !== undefined) whitelist.push([id, wRow]);
    const bRow: string | undefined = miniAppTestBlocklistRows.get(id);
    if (bRow !== undefined) blocklist.push([id, bRow]);
  }
  return {
    whitelist,
    blocklist,
    temporaryAdBypass: [],
  };
}

/** Mini App 集成测试共享的 `readIdentityPolicies` 桩函数；用例可用 mockImplementationOnce 模拟冷读失败。 */
export const readIdentityPoliciesMock = mock(readFixtureIdentityPolicies);

/**
 * 按夹具行表回答身份主键游标页读取。
 * @param table 身份策略表名。
 * @param afterId 上一页游标。
 * @returns 游标分页结果。
 */
async function readFixtureIdentityIdPage(
  table: IdentityPolicyTable,
  afterId: number | null
): Promise<IdentityIdPage> {
  return idPage(table === "whitelist" ? miniAppTestWhitelistRows : miniAppTestBlocklistRows, afterId);
}

/** Mini App 集成测试共享的 `readIdentityIdPage` 桩函数。 */
export const readIdentityIdPageMock = mock(readFixtureIdentityIdPage);

/**
 * 幂等安装 Mini App 服务端测试共用的 `packages/infra/diskIO` 模块替身，使多文件同进程运行与 `--isolate` 具有一致的回执监听。
 */
export function installMiniAppTestDiskIOMock(): void {
  if (diskIOMockInstalled) {
    return;
  }
  diskIOMockInstalled = true;
  mock.module("../../packages/infra/diskIO", () =>
    diskIOStub({
      isDiskIOInitialized: (): boolean => true,
      flushDiskIODomain: async (): Promise<DomainFlushOutcome> => {
        const queuedMessages: DiskBusinessMessage[] = miniAppTestDiskMessages.splice(
          0,
          miniAppTestDiskMessages.length
        );
        const latestChatRevisions: Map<number, number> = new Map<number, number>();
        const identityWrites: IdentityPolicyPersistedRevision[] = [];
        for (const msg of queuedMessages) {
          if (msg.type === "chatStateWrite") {
            latestChatRevisions.set(msg.chatId, msg.revision);
          } else if (msg.type === "identityPolicyWrite") {
            identityWrites.push({ table: msg.table, id: msg.id, revision: msg.revision });
            const targetMap: Map<number, string> =
              msg.table === "whitelist" ? miniAppTestWhitelistRows : miniAppTestBlocklistRows;
            if (msg.data === null) targetMap.delete(msg.id);
            else targetMap.set(msg.id, msg.data);
          }
        }
        const chatStateWrites: { chatId: number; revision: number }[] = [];
        for (const [chatId, revision] of latestChatRevisions) {
          chatStateWrites.push({ chatId, revision });
        }
        for (const listener of persistedListeners) {
          listener({
            type: "identityStoragePersisted",
            writes: identityWrites,
            temporaryAdBypassWrites: [],
            chatStateWrites,
            chatQaWrites: [],
            removalWrites: [],
          });
        }
        miniAppTestJoinLogState.onFlushDiskIODomain?.();
        return { result: "flushed" };
      },
      onDiskIOReply: diskIOReplyStub({
        identityStoragePersisted: (
          listener: (reply: IdentityStoragePersistedReply) => void
        ): void => {
          persistedListeners.push(listener);
        },
        aiMemoryDeletedPersisted: (
          listener: (reply: AiMemoryDeletedPersistedReply) => void
        ): void => {
          aiMemoryDeletedListeners.push(listener);
        },
      }),
      postDiskIO: (message: DiskBusinessMessage): boolean => {
        miniAppTestDiskMessages.push(message);
        if (message.type === "deleteAiMemory") {
          for (const listener of aiMemoryDeletedListeners) {
            listener({
              type: "aiMemoryDeletedPersisted",
              chatId: message.chatId,
              revision: message.revision,
            });
          }
        }
        return true;
      },
      readJoinLog: async (params: {
        readonly chatId: number;
        readonly since: number;
        readonly now: number;
      }): Promise<readonly JoinLogRecord[]> => {
        if (miniAppTestJoinLogState.shouldThrow) {
          throw new Error("join log unavailable");
        }
        return miniAppTestJoinLogState.records.filter(
          (record: JoinLogRecord): boolean =>
            record.joinedAt >= params.since && record.joinedAt <= params.now
        );
      },
      readIdentityPolicies: readIdentityPoliciesMock,
      readIdentityIdPage: readIdentityIdPageMock,
      relayLogMessage: (): boolean => true,
    })
  );
}

/**
 * 清空 Mini App 集成测试共享的 Disk I/O 内存表与钩子状态。
 */
export function resetMiniAppTestDiskIOState(): void {
  miniAppTestDiskMessages.length = 0;
  miniAppTestWhitelistRows.clear();
  miniAppTestBlocklistRows.clear();
  miniAppTestJoinLogState.records = [];
  miniAppTestJoinLogState.shouldThrow = false;
  miniAppTestJoinLogState.onFlushDiskIODomain = undefined;
  readIdentityPoliciesMock.mockReset();
  readIdentityPoliciesMock.mockImplementation(readFixtureIdentityPolicies);
  readIdentityIdPageMock.mockReset();
  readIdentityIdPageMock.mockImplementation(readFixtureIdentityIdPage);
}

/**
 * 构造已按 Telegram WebApp 规范 HMAC-SHA256 签名的测试用 `initData` 查询字符串。
 * @param params 签名参数。
 * @returns URLSearchParams 编码后的 `initData`。
 */
export function buildSignedTestInitData(params: {
  readonly botToken: string;
  readonly authDate: number;
  readonly user?: Readonly<Record<string, unknown>>;
  readonly extra?: Readonly<Record<string, string>>;
}): string {
  const entries: Map<string, string> = new Map<string, string>();
  entries.set("auth_date", String(params.authDate));
  if (params.user !== undefined) {
    entries.set("user", JSON.stringify(params.user));
  }
  if (params.extra !== undefined) {
    for (const [k, v] of Object.entries(params.extra)) {
      entries.set(k, v);
    }
  }
  const sortedLines: string[] = [...entries.entries()]
    .sort(([a]: [string, string], [b]: [string, string]): number => a.localeCompare(b))
    .map(([k, v]: [string, string]): string => `${k}=${v}`);
  const dataCheckString: string = sortedLines.join("\n");
  const secretKey: Uint8Array = new Bun.CryptoHasher(
    "sha256",
    MINI_APP_WEB_APP_DATA_SECRET_SEED
  )
    .update(params.botToken, "utf8")
    .digest();
  const hashHex: string = new Bun.CryptoHasher("sha256", secretKey)
    .update(dataCheckString, "utf8")
    .digest("hex");

  const searchParams: URLSearchParams = new URLSearchParams();
  for (const [k, v] of entries) {
    searchParams.set(k, v);
  }
  searchParams.set("hash", hashHex);
  return searchParams.toString();
}

/** 构造超级管理员测试请求头的参数。 */
export interface SuperAdminHeadersOptions {
  /** 当前生效的 Bot Token。 */
  readonly botToken: string;
  /** 超级管理员数字 ID。 */
  readonly superAdminUserId: number;
  /** 本次会话令牌。 */
  readonly sessionToken: string;
  /** 可选附加用户名（如 `"super_admin"`）。 */
  readonly username?: string;
  /** 可选 `Content-Type` 头（如 `"application/json"`）。 */
  readonly contentType?: string;
}

/**
 * 构造携带当前 `BOT_TOKEN`、`SUPER_ADMIN_USER_ID` 签名与 45 分钟密码会话的测试请求头。
 * @param options 令牌、用户与可选附加头字段参数。
 * @returns 请求头字典。
 */
export function buildSuperAdminHeaders({
  botToken,
  superAdminUserId,
  sessionToken,
  username,
  contentType,
}: SuperAdminHeadersOptions): Record<string, string> {
  const initData: string = buildSignedTestInitData({
    botToken,
    authDate: Math.floor(Date.now() / 1000),
    user: {
      id: superAdminUserId,
      first_name: "SuperAdmin",
      ...(username === undefined ? {} : { username }),
    },
  });
  return {
    [MINI_APP_INIT_DATA_HEADER]: initData,
    [MINI_APP_SESSION_HEADER]: sessionToken,
    ...(contentType === undefined ? {} : { "Content-Type": contentType }),
  };
}

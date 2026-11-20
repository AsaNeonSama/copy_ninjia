/**
 * 真实 Disk I/O Worker 线程：经 startDiskIOWorker 接好的回执出口完成恢复握手、业务批与 flush，
 * 再以 closeStorage 干净关库。数据根是测试进程独占的临时目录。
 */

import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getTimeZone } from "../../packages/config/time";
import { getDateKey } from "../../packages/libs/time";
import {
  DISK_IO_WORKER_URL,
  IDENTITY_DATABASE_PATH,
  VERIFICATION_MEMORY_DIR,
} from "../../packages/consts/paths";
import { encodeChatStateData } from "../../packages/database/codec/chatState";
import {
  closeStorageDatabase,
  enableStorageDatabaseWal,
  openStorageDatabase,
} from "../../packages/database/interact/connection";
import { createChatState } from "../../packages/libs/chatState";
import type { ChatState } from "../../packages/types/chatState";
import type { DiskIOMessage } from "../../packages/types/diskIO/messages";
import type { DiskIOReply } from "../../packages/types/diskIO/replies";
import type { StorageDatabase } from "../../packages/types/storageDatabase";
import { clearStorageBusinessTables } from "../../scripts/fixtures/storageDatabase";

const REPLY_TIMEOUT_MS: number = 5_000;

/** 一个真实 Worker 及其已收到的回执；waitFor 按类型取第一条未消费的回执。 */
interface WorkerProbe {
  readonly worker: Worker;
  post(message: DiskIOMessage): void;
  waitFor<TType extends DiskIOReply["type"]>(type: TType): Promise<Extract<DiskIOReply, { type: TType }>>;
}

const started: Worker[] = [];

function startWorker(): WorkerProbe {
  // Worker 的环境默认取进程启动时的 process.env 快照，不含 test/preloadEnv.ts 运行期注入的
  // 数据根与配置根；显式传入当前环境，Worker 才会读写同一个临时数据根，不落到仓库根。
  const worker: Worker = new Worker(DISK_IO_WORKER_URL, { env: { ...process.env } as Record<string, string> });
  started.push(worker);
  const replies: DiskIOReply[] = [];
  const errors: string[] = [];
  worker.onmessage = (event: MessageEvent<DiskIOReply>): void => {
    replies.push(event.data);
  };
  worker.onerror = (event: ErrorEvent): void => {
    errors.push(event.message);
  };
  return {
    worker,
    post(message: DiskIOMessage): void {
      worker.postMessage(message);
    },
    async waitFor<TType extends DiskIOReply["type"]>(type: TType): Promise<Extract<DiskIOReply, { type: TType }>> {
      const deadline: number = performance.now() + REPLY_TIMEOUT_MS;
      for (;;) {
        const index: number = replies.findIndex((reply: DiskIOReply): boolean => reply.type === type);
        if (index !== -1) return replies.splice(index, 1)[0] as Extract<DiskIOReply, { type: TType }>;
        if (errors.length > 0) throw new Error(`Disk I/O Worker errored: ${errors.join("; ")}`);
        if (performance.now() >= deadline) {
          throw new Error(`Timed out waiting for ${type}; received ${replies.map((reply: DiskIOReply): string => reply.type).join(", ")}`);
        }
        await Bun.sleep(5);
      }
    },
  };
}

afterEach((): void => {
  for (const worker of started.splice(0)) worker.terminate();
});

test("真实线程：恢复握手、业务批与 flush 回执，closeStorage 关库后 WAL/SHM 删除且主库可重开", async () => {
  const database: StorageDatabase = openStorageDatabase({ path: IDENTITY_DATABASE_PATH });
  clearStorageBusinessTables(database);
  closeStorageDatabase(database);
  enableStorageDatabaseWal(IDENTITY_DATABASE_PATH);
  const probe: WorkerProbe = startWorker();

  probe.post({ type: "load", timeZone: getTimeZone(), stickerPacks: null });
  const loaded: Extract<DiskIOReply, { type: "loaded" }> = await probe.waitFor("loaded");
  expect(loaded.error).toBeUndefined();

  const state: ChatState = createChatState();
  state.isInitEnabled = true;
  probe.post({
    type: "operationBatch",
    batchId: 1,
    messages: [
      { type: "chatStateWrite", chatId: -1001, data: encodeChatStateData(state), revision: 1 },
      { type: "flush", flushId: 1, scope: "chatState" },
    ],
  });
  expect((await probe.waitFor("identityStoragePersisted")).chatStateWrites).toEqual([{ chatId: -1001, revision: 1 }]);
  expect((await probe.waitFor("flushed")).flushedId).toBe(1);
  expect((await probe.waitFor("operationBatchAccepted")).batchId).toBe(1);
  expect(await Bun.file(`${IDENTITY_DATABASE_PATH}-wal`).exists()).toBeTrue();

  probe.post({ type: "operationBatch", batchId: 2, messages: [{ type: "closeStorage", requestId: 1 }] });
  expect(await probe.waitFor("storageClosed")).toEqual({
    type: "storageClosed",
    requestId: 1,
    outcome: { committed: true, checkpointBusy: false },
  });

  expect(await Bun.file(`${IDENTITY_DATABASE_PATH}-wal`).exists()).toBeFalse();
  expect(await Bun.file(`${IDENTITY_DATABASE_PATH}-shm`).exists()).toBeFalse();
  const reopened: Database = new Database(IDENTITY_DATABASE_PATH, { readonly: true });
  try {
    expect(reopened.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM chat_states;").get()!.count).toBe(1);
  } finally {
    reopened.close();
  }
});

test("真实线程：待验证终态落盘后 Worker 崩溃重建，重放同代同版 critical upsert 立即补回 verificationPersisted", async () => {
  const todayFile: string = join(VERIFICATION_MEMORY_DIR, `${getDateKey()}.json`);
  rmSync(todayFile, { force: true });
  mkdirSync(VERIFICATION_MEMORY_DIR, { recursive: true });
  try {
    const worker1: WorkerProbe = startWorker();
    worker1.post({ type: "load", timeZone: getTimeZone(), stickerPacks: null });
    const loaded1: Extract<DiskIOReply, { type: "loaded" }> = await worker1.waitFor("loaded");
    expect(loaded1.error).toBeUndefined();

    const record = {
      chatId: -1001,
      userId: 42,
      generation: 1,
      revision: 3,
      phase: "expelling" as const,
      label: "待验证成员",
      isBot: false,
      trackedMessageTimes: [],
      replyReminderRequested: false,
      reminderSuperseded: true,
      joinedAt: 1_000,
      expiresAt: 121_000,
      expelReason: "timeout" as const,
    };
    worker1.post({
      type: "operationBatch",
      batchId: 1,
      messages: [{ type: "verificationUpsert", record, critical: true }],
    });
    const persisted1 = await worker1.waitFor("verificationPersisted");
    expect(persisted1).toEqual({
      type: "verificationPersisted",
      key: "-1001:42",
      generation: 1,
      revision: 3,
      deleted: false,
    });
    worker1.worker.terminate();

    // 模拟崩溃前刚落盘、主线程尚未收到或刚需重放同版终态：第二个真实 Worker 从磁盘恢复。
    const worker2: WorkerProbe = startWorker();
    worker2.post({ type: "load", timeZone: getTimeZone(), stickerPacks: null });
    const loaded2: Extract<DiskIOReply, { type: "loaded" }> = await worker2.waitFor("loaded");
    expect(loaded2.error).toBeUndefined();
    expect(loaded2.verifications.size).toBe(1);

    worker2.post({
      type: "operationBatch",
      batchId: 1,
      messages: [{ type: "verificationUpsert", record, critical: true }],
    });
    const replayedPersisted = await worker2.waitFor("verificationPersisted");
    expect(replayedPersisted).toEqual({
      type: "verificationPersisted",
      key: "-1001:42",
      generation: 1,
      revision: 3,
      deleted: false,
    });
    expect(await worker2.waitFor("operationBatchAccepted")).toEqual({
      type: "operationBatchAccepted",
      batchId: 1,
    });
  } finally {
    rmSync(todayFile, { force: true });
  }
});

/**
 * TOTP 验证器启用与删除的并发串行化门禁测试（`[IC-04]`）：
 * 验证 `enableMiniAppTotpFromPending` 与 `deleteMiniAppTotpRecord` 在交错调用下，
 * 落盘状态与主线程 `miniAppTotpRecordHolder` 始终保持严格一致，且前序异常不会毒化串行链。
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { rmSync } from "node:fs";
import * as realAtomicFile from "../../packages/libs/atomicFile";
import { TEST_DATA_ROOT } from "../preloadEnv";

// mock.module 会就地改写命名空间对象，先快照原始实现供转发调用。
const realAtomicFileSnapshot = { ...realAtomicFile };
const realAtomicWriteText = realAtomicFileSnapshot.atomicWriteText;

let pauseBeforeEnableWriteReturn: Promise<void> | null = null;
let enableWriteFinishedOnDisk: PromiseWithResolvers<void> | null = null;
let shouldFailNextAtomicWrite: boolean = false;

mock.module("../../packages/libs/atomicFile", () => ({
  ...realAtomicFileSnapshot,
  atomicWriteText: async (
    path: string,
    content: string,
    mode?: number
  ): Promise<void> => {
    if (shouldFailNextAtomicWrite) {
      shouldFailNextAtomicWrite = false;
      throw new Error("injected totp write failure");
    }
    await realAtomicWriteText(path, content, mode);
    if (pauseBeforeEnableWriteReturn !== null) {
      const gate: Promise<void> = pauseBeforeEnableWriteReturn;
      pauseBeforeEnableWriteReturn = null;
      enableWriteFinishedOnDisk?.resolve();
      await gate;
    }
  },
}));

const { miniAppTotpRecordHolder } = await import("../../packages/cache/main/miniApp");
const { SUPER_ADMIN_USER_ID } = await import("../../packages/config/bot");
const { MINI_APP_TOTP_FILE_PATH, MINI_APP_TOTP_MEMORY_DIR } = await import(
  "../../packages/consts/paths"
);
const { generateMiniAppTotpCodeAt } = await import("../../packages/libs/miniAppTotp");
const {
  createPendingMiniAppTotpSetup,
  deleteMiniAppTotpRecord,
  enableMiniAppTotpFromPending,
  resetMiniAppTotpMemoryCache,
} = await import("../../packages/mini-app-api-server/auth/totpStorage");

afterEach((): void => {
  pauseBeforeEnableWriteReturn = null;
  enableWriteFinishedOnDisk = null;
  shouldFailNextAtomicWrite = false;
  resetMiniAppTotpMemoryCache();
  rmSync(MINI_APP_TOTP_MEMORY_DIR, { recursive: true, force: true });
});

describe("TOTP enable/delete 并发串行一致性", () => {
  test("enable 刚写盘尚未回写内存 holder 时并发发起 delete，落盘状态与内存缓存保持一致（不会出现文件无、内存有）", async () => {
    expect(MINI_APP_TOTP_FILE_PATH.startsWith(TEST_DATA_ROOT)).toBeTrue();
    const nowMs: number = 1_777_020_000_000;
    const pending = createPendingMiniAppTotpSetup(SUPER_ADMIN_USER_ID, nowMs);
    const code: string = generateMiniAppTotpCodeAt(pending.secret, nowMs);

    const writeGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    enableWriteFinishedOnDisk = Promise.withResolvers<void>();
    pauseBeforeEnableWriteReturn = writeGate.promise;

    const enablePromise = enableMiniAppTotpFromPending(code, nowMs);
    await enableWriteFinishedOnDisk.promise;
    const deletePromise = deleteMiniAppTotpRecord();
    // 让非串行实现里的 delete 在 enable 恢复回写内存前先完成删盘与清空 holder；若已串行则仅让出时间片。
    await Promise.race([deletePromise, Bun.sleep(20)]);
    writeGate.resolve();

    const results = await Promise.allSettled([enablePromise, deletePromise]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("fulfilled");
    expect(await Bun.file(MINI_APP_TOTP_FILE_PATH).exists()).toBeFalse();
    expect(miniAppTotpRecordHolder.current).toBeNull();
  });

  test("前一次 enable 写盘失败后不毒化串行链，后续 enable/delete 正常推进", async () => {
    const nowMs: number = 1_777_020_030_000;
    const pendingFail = createPendingMiniAppTotpSetup(SUPER_ADMIN_USER_ID, nowMs);
    const codeFail: string = generateMiniAppTotpCodeAt(pendingFail.secret, nowMs);
    shouldFailNextAtomicWrite = true;
    await expect(enableMiniAppTotpFromPending(codeFail, nowMs)).rejects.toThrow(
      "injected totp write failure"
    );

    const pendingOk = createPendingMiniAppTotpSetup(SUPER_ADMIN_USER_ID, nowMs);
    const codeOk: string = generateMiniAppTotpCodeAt(pendingOk.secret, nowMs);
    const okRes = await enableMiniAppTotpFromPending(codeOk, nowMs);
    expect(okRes.ok).toBeTrue();
    expect(await Bun.file(MINI_APP_TOTP_FILE_PATH).exists()).toBeTrue();
    expect(miniAppTotpRecordHolder.current).not.toBeNull();

    await deleteMiniAppTotpRecord();
    expect(await Bun.file(MINI_APP_TOTP_FILE_PATH).exists()).toBeFalse();
    expect(miniAppTotpRecordHolder.current).toBeNull();
  });
});

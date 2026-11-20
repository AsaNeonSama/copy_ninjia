import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Subprocess } from "bun";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { assertNoMisplacedConfigFiles } from "../../../packages/config/layout";
import { DYNAMIC_CONFIG_DIR_NAME, STATIC_CONFIG_DIR_NAME } from "../../../packages/consts/configLayout";
import {
  AD_DETECT_CONFIG_PATH,
  AGENT_CONFIG_PATH,
  ASSETS_CONFIG_PATH,
  BOT_CONFIG_PATH,
  CRON_CONFIG_PATH,
  GOOGLE_AUTH_FILE_PATH,
  MOOD_CONFIG_PATH,
  STICKERS_CONFIG_PATH,
  TMP_FILE_SUFFIX,
} from "../../../packages/consts/paths";
import { logger } from "../../../packages/infra/logger";
import { cleanupOrphanedTempFiles } from "../../../packages/infra/storage/cleanup";
import { readLinuxProcessIdentity } from "../../../packages/infra/storage/instanceLock";
import type { ProcessIdentity } from "../../../packages/types/storage";

describe("storage startup cleanup", () => {
  test("只删除 state/totp/lock 原子写临时文件，目录扫描与删除均可注入", async () => {
    const removed: string[] = [];
    await cleanupOrphanedTempFiles({
      stateFilePath: "/virtual/state.json",
      totpFilePath: "/virtual/totp.json",
      lockFilePath: "/virtual/bot.lock",
      readDirectory: async () => [
        ".state.json.1.uuid.tmp",
        ".totp.json.1.uuid.tmp",
        ".bot.lock.1.uuid.tmp",
        ".other.json.1.uuid.tmp",
        "bot.lock.guard.candidate.42.11111111-1111-4111-8111-111111111111",
        "bot.lock.guard.candidate.43.22222222-2222-4222-8222-222222222222",
        "bot.lock.guard.candidate.bad.33333333-3333-4333-8333-333333333333",
        "bot.lock.guard.recovery",
        "state.json",
        "totp.json",
      ],
      isInactiveLockOwner: async (path) => !path.includes("candidate.43."),
      removeFile: async (path) => {
        removed.push(path);
      },
    });

    expect(removed).toEqual([
      "/virtual/.state.json.1.uuid.tmp",
      "/virtual/.totp.json.1.uuid.tmp",
      "/virtual/.bot.lock.1.uuid.tmp",
      "/virtual/bot.lock.guard.candidate.42.11111111-1111-4111-8111-111111111111",
      "/virtual/bot.lock.guard.recovery",
    ]);
  });

  test("状态文件、TOTP 文件、锁与配置目录不同目录时各扫各的：各目录只认本目标临时件，缺失目录直接跳过", async () => {
    const removed: string[] = [];
    const scanned: string[] = [];
    const listing: Readonly<Record<string, readonly string[]>> = {
      "/virtual": [".bot.lock.1.uuid.tmp", ".state.json.1.uuid.tmp", ".totp.json.1.uuid.tmp", "bot.lock.guard.recovery"],
      "/virtual/memory/global": [".state.json.2.uuid.tmp", ".bot.lock.2.uuid.tmp", "bot.lock.guard.recovery"],
      "/virtual/memory/mini-app-totp": [".totp.json.2.uuid.tmp", ".state.json.2.uuid.tmp", "totp.json"],
      "/virtual/config/static": [],
      "/virtual/config/dynamic": [],
    };
    await cleanupOrphanedTempFiles({
      stateFilePath: "/virtual/memory/global/state.json",
      totpFilePath: "/virtual/memory/mini-app-totp/totp.json",
      lockFilePath: "/virtual/bot.lock",
      configStaticDir: "/virtual/config/static",
      configDynamicDir: "/virtual/config/dynamic",
      readDirectory: async (path) => { scanned.push(path); return [...listing[path]!]; },
      isInactiveLockOwner: async () => true,
      removeFile: async (path) => { removed.push(path); },
    });
    expect(scanned).toEqual([
      "/virtual",
      "/virtual/memory/global",
      "/virtual/memory/mini-app-totp",
      "/virtual/config/static",
      "/virtual/config/dynamic",
    ]);
    expect(removed).toEqual([
      "/virtual/.bot.lock.1.uuid.tmp",
      "/virtual/bot.lock.guard.recovery",
      "/virtual/memory/global/.state.json.2.uuid.tmp",
      "/virtual/memory/mini-app-totp/.totp.json.2.uuid.tmp",
    ]);

    const missing: Error & { code?: string } = new Error("ENOENT");
    missing.code = "ENOENT";
    removed.length = 0;
    await cleanupOrphanedTempFiles({
      stateFilePath: "/virtual/memory/global/state.json",
      totpFilePath: "/virtual/memory/mini-app-totp/totp.json",
      lockFilePath: "/virtual/bot.lock",
      configStaticDir: "/virtual/config/static",
      configDynamicDir: "/virtual/config/dynamic",
      readDirectory: async (path) => {
        if (path !== "/virtual") throw missing;
        return [".bot.lock.3.uuid.tmp"];
      },
      removeFile: async (path) => { removed.push(path); },
    });
    expect(removed).toEqual(["/virtual/.bot.lock.3.uuid.tmp"]);
  });

  test("目录扫描失败时安全返回，不尝试删除任何文件", async () => {
    let removeCalls: number = 0;

    await expect(cleanupOrphanedTempFiles({
      stateFilePath: "/virtual/state.json",
      totpFilePath: "/virtual/totp.json",
      lockFilePath: "/virtual/bot.lock",
      readDirectory: async () => {
        throw new Error("injected readdir failure");
      },
      removeFile: async () => {
        removeCalls++;
      },
    })).resolves.toBeUndefined();

    expect(removeCalls).toBe(0);
  });

  test("单个删除失败或文件已消失时继续清理后续目标", async () => {
    const attempted: string[] = [];

    await cleanupOrphanedTempFiles({
      stateFilePath: "/virtual/state.json",
      totpFilePath: "/virtual/totp.json",
      lockFilePath: "/virtual/bot.lock",
      readDirectory: async () => [
        ".state.json.1.first.tmp",
        ".state.json.1.gone.tmp",
        ".bot.lock.1.last.tmp",
      ],
      removeFile: async (path) => {
        attempted.push(path);
        if (path.endsWith("first.tmp")) throw new Error("injected unlink failure");
        if (path.endsWith("gone.tmp")) {
          const error: NodeJS.ErrnoException = new Error("gone");
          error.code = "ENOENT";
          throw error;
        }
      },
    });

    expect(attempted).toEqual([
      "/virtual/.state.json.1.first.tmp",
      "/virtual/.state.json.1.gone.tmp",
      "/virtual/.bot.lock.1.last.tmp",
    ]);
  });
});

/**
 * 上面的用例注入了 isInactiveLockOwner 替身；这里用真实文件与真实 /proc 身份覆盖真实的
 * hasInactiveCurrentFormatOwner，它是「不认识的内容一律不删」这条 fail-closed 判定的唯一实现。
 */
describe("guard 归属判定的真实实现", () => {
  const BOOT_ID = "11111111-1111-4111-8111-111111111111";
  /** 远超 Linux pid_max，/proc 下不存在。 */
  const DEAD_PID = 999_999_999;
  let testDir: string;
  let lockFilePath: string;
  let stateFilePath: string;

  function candidateName(pid: number, uuid: string): string {
    return `bot.lock.guard.candidate.${pid}.${uuid}`;
  }

  async function writeCandidate(name: string, content: string): Promise<void> {
    await Bun.write(join(testDir, name), content);
  }

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "cleanup-owner-test-"));
    lockFilePath = join(testDir, "bot.lock");
    stateFilePath = join(testDir, "state.json");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("只删除当前格式且归属进程确已消失的 guard 残留", async () => {
    const current: ProcessIdentity = (await readLinuxProcessIdentity(process.pid))!;
    const unparseable: string = candidateName(42, "11111111-1111-4111-8111-111111111111");
    const unsafePid: string = candidateName(43, "22222222-2222-4222-8222-222222222222");
    const liveOwner: string = candidateName(44, "33333333-3333-4333-8333-333333333333");
    const deadOwner: string = candidateName(45, "44444444-4444-4444-8444-444444444444");
    const recycledPid: string = candidateName(46, "55555555-5555-4555-8555-555555555555");

    // 无法识别的内容：认不出归属，不删。
    await writeCandidate(unparseable, "legacy-owner-format");
    // pid 超出安全整数范围：同样拒绝。
    await writeCandidate(unsafePid, `v2:99999999999999999999:1234:${BOOT_ID}`);
    // 归属进程就是当前测试进程，仍然活着。
    await writeCandidate(liveOwner, `v2:${current.pid}:${current.startTimeTicks}:${current.bootId}`);
    // 归属进程已经不存在。
    await writeCandidate(deadOwner, `v2:${DEAD_PID}:1234:${BOOT_ID}`);
    // pid 还在，但 starttime 对不上——是被复用的 pid，原归属进程已消失。
    await writeCandidate(recycledPid, `v2:${current.pid}:1:${current.bootId}`);

    await cleanupOrphanedTempFiles({ stateFilePath, lockFilePath });

    const remaining: string[] = readdirSync(testDir).sort();
    expect(remaining).toEqual([unparseable, unsafePid, liveOwner].sort());
    expect(await Bun.file(join(testDir, deadOwner)).exists()).toBe(false);
    expect(await Bun.file(join(testDir, recycledPid)).exists()).toBe(false);
  });

  test("0 字节 candidate 按文件名里的 PID 判活：属主已死就回收，还活着就保留", async () => {
    // candidate 是先 open(wx) 建空文件、再写身份行的，中途被 SIGKILL/OOM/掉电打断会留下 0 字节孤儿；这种文件按文件名里的 PID 判活。
    const current: ProcessIdentity = (await readLinuxProcessIdentity(process.pid))!;
    const deadOwner: string = candidateName(DEAD_PID, "66666666-6666-4666-8666-666666666666");
    const liveOwner: string = candidateName(current.pid, "77777777-7777-4777-8777-777777777777");
    await writeCandidate(deadOwner, "");
    await writeCandidate(liveOwner, "");

    await cleanupOrphanedTempFiles({ stateFilePath, lockFilePath });

    expect(await Bun.file(join(testDir, deadOwner)).exists()).toBe(false);
    // PID 还活着（可能是原属主，也可能是复用）：保留。
    expect(await Bun.file(join(testDir, liveOwner)).exists()).toBe(true);
  });

  test("bot.lock.guard.recovery 内容为空时仍然保留：文件名里没有 PID 可兜底", async () => {
    // recovery 是从已写好并 fsync 过的 candidate hard link 出来的；内容为空时没有第二个身份来源，维持 fail-closed。
    const recoveryPath: string = join(testDir, "bot.lock.guard.recovery");
    await Bun.write(recoveryPath, "");

    await cleanupOrphanedTempFiles({ stateFilePath, lockFilePath });

    expect(await Bun.file(recoveryPath).exists()).toBe(true);
  });

  test("bot.lock.guard.recovery 同样按归属判定，读不出内容时保留", async () => {
    const recoveryPath: string = join(testDir, "bot.lock.guard.recovery");
    await Bun.write(recoveryPath, `v2:${DEAD_PID}:1234:${BOOT_ID}`);

    await cleanupOrphanedTempFiles({ stateFilePath, lockFilePath });
    expect(await Bun.file(recoveryPath).exists()).toBe(false);

    const current: ProcessIdentity = (await readLinuxProcessIdentity(process.pid))!;
    await Bun.write(recoveryPath, `v2:${current.pid}:${current.startTimeTicks}:${current.bootId}`);

    await cleanupOrphanedTempFiles({ stateFilePath, lockFilePath });
    expect(await Bun.file(recoveryPath).exists()).toBe(true);
  });

  test("配置目录只删格式严格匹配且归属 PID 已死或与本进程同 PID 的白名单临时件，其余残留交由布局检查拒绝", async () => {
    const configRoot: string = join(testDir, "config");
    const staticDir: string = join(configRoot, STATIC_CONFIG_DIR_NAME);
    const dynamicDir: string = join(configRoot, DYNAMIC_CONFIG_DIR_NAME);
    mkdirSync(staticDir, { recursive: true });
    mkdirSync(dynamicDir, { recursive: true });

    const uuidA: string = "11111111-1111-4111-8111-111111111111";
    const uuidB: string = "22222222-2222-4222-8222-222222222222";
    const deadStatic: string = `.${basename(BOT_CONFIG_PATH)}.${DEAD_PID}.${uuidA}${TMP_FILE_SUFFIX}`;
    const deadDynamicNames: readonly string[] = [
      AGENT_CONFIG_PATH,
      ASSETS_CONFIG_PATH,
      AD_DETECT_CONFIG_PATH,
      MOOD_CONFIG_PATH,
      STICKERS_CONFIG_PATH,
      CRON_CONFIG_PATH,
    ].map((path: string): string => `.${basename(path)}.${DEAD_PID}.${uuidB}${TMP_FILE_SUFFIX}`);
    const deadGAuth: string = `.${basename(GOOGLE_AUTH_FILE_PATH)}.${DEAD_PID}.${uuidB}${TMP_FILE_SUFFIX}`;
    // 启动清扫先于本进程任何配置写入：与本进程同 PID 的临时件只可能是 PID 复用前的残留，需清除；其他存活进程的临时件保留。
    const liveOwner: Subprocess = Bun.spawn(["sleep", "60"]);
    const selfPidDynamic: string = `.${basename(MOOD_CONFIG_PATH)}.${process.pid}.${uuidA}${TMP_FILE_SUFFIX}`;
    const liveDynamic: string = `.${basename(AGENT_CONFIG_PATH)}.${liveOwner.pid}.${uuidA}${TMP_FILE_SUFFIX}`;
    const swpFile: string = `.${basename(AGENT_CONFIG_PATH)}.swp`;
    const nonWhitelistTemp: string = `.other.json.${DEAD_PID}.${uuidA}${TMP_FILE_SUFFIX}`;
    const zeroPidTemp: string = `.${basename(AGENT_CONFIG_PATH)}.0.${uuidA}${TMP_FILE_SUFFIX}`;
    const badUuidTemp: string = `.${basename(AGENT_CONFIG_PATH)}.${DEAD_PID}.not-a-uuid${TMP_FILE_SUFFIX}`;

    await Bun.write(join(staticDir, deadStatic), "{}");
    await Bun.write(join(staticDir, deadGAuth), "{}");
    for (const fileName of deadDynamicNames) await Bun.write(join(dynamicDir, fileName), "{}");
    await Bun.write(join(dynamicDir, liveDynamic), "{}");
    await Bun.write(join(dynamicDir, selfPidDynamic), "{}");
    await Bun.write(join(dynamicDir, swpFile), "swap");
    await Bun.write(join(dynamicDir, nonWhitelistTemp), "{}");
    await Bun.write(join(dynamicDir, zeroPidTemp), "{}");
    await Bun.write(join(dynamicDir, badUuidTemp), "{}");

    try {
      await cleanupOrphanedTempFiles({
        stateFilePath,
        totpFilePath: join(testDir, "totp.json"),
        lockFilePath,
        configStaticDir: staticDir,
        configDynamicDir: dynamicDir,
      });
    } finally {
      liveOwner.kill();
      await liveOwner.exited;
    }

    expect(await Bun.file(join(dynamicDir, selfPidDynamic)).exists()).toBeFalse();
    expect(await Bun.file(join(staticDir, deadStatic)).exists()).toBeFalse();
    expect(await Bun.file(join(staticDir, deadGAuth)).exists()).toBeFalse();
    for (const fileName of deadDynamicNames) {
      expect(await Bun.file(join(dynamicDir, fileName)).exists()).toBeFalse();
    }
    expect(readdirSync(dynamicDir).sort()).toEqual(
      [liveDynamic, swpFile, nonWhitelistTemp, zeroPidTemp, badUuidTemp].sort()
    );
    await expect(assertNoMisplacedConfigFiles(configRoot)).rejects.toThrow("must be absent");

    for (const kept of [liveDynamic, swpFile, nonWhitelistTemp, zeroPidTemp, badUuidTemp]) {
      rmSync(join(dynamicDir, kept), { force: true });
    }
    await expect(assertNoMisplacedConfigFiles(configRoot)).resolves.toBeUndefined();

    // 单独放入死 PID 残留并重清扫后，布局白名单即直接通过。
    const loneDeadTemp: string = join(dynamicDir, `.${basename(CRON_CONFIG_PATH)}.${DEAD_PID}.${uuidA}${TMP_FILE_SUFFIX}`);
    await Bun.write(loneDeadTemp, "[]");
    await cleanupOrphanedTempFiles({
      stateFilePath,
      totpFilePath: join(testDir, "totp.json"),
      lockFilePath,
      configStaticDir: staticDir,
      configDynamicDir: dynamicDir,
    });
    expect(await Bun.file(loneDeadTemp).exists()).toBeFalse();
    await expect(assertNoMisplacedConfigFiles(configRoot)).resolves.toBeUndefined();
  });

  test("配置目录只读或删除返回 EACCES/EROFS 时记错误日志并继续，随后由布局检查拒绝启动", async () => {
    const configRoot: string = join(testDir, "config-ro");
    const staticDir: string = join(configRoot, STATIC_CONFIG_DIR_NAME);
    const dynamicDir: string = join(configRoot, DYNAMIC_CONFIG_DIR_NAME);
    mkdirSync(staticDir, { recursive: true });
    mkdirSync(dynamicDir, { recursive: true });

    const uuid: string = "33333333-3333-4333-8333-333333333333";
    const blockedTemp: string = `.${basename(AGENT_CONFIG_PATH)}.${DEAD_PID}.${uuid}${TMP_FILE_SUFFIX}`;
    const staticDeadTemp: string = `.${basename(BOT_CONFIG_PATH)}.${DEAD_PID}.${uuid}${TMP_FILE_SUFFIX}`;
    await Bun.write(join(dynamicDir, blockedTemp), "{}");
    await Bun.write(join(staticDir, staticDeadTemp), "{}");

    const errorSpy = spyOn(logger, "error").mockImplementation((): void => {});
    const removed: string[] = [];
    try {
      await cleanupOrphanedTempFiles({
        stateFilePath,
        totpFilePath: join(testDir, "totp.json"),
        lockFilePath,
        configStaticDir: staticDir,
        configDynamicDir: dynamicDir,
        readDirectory: async (path: string): Promise<string[]> => readdirSync(path),
        removeFile: async (path: string): Promise<void> => {
          if (path === join(dynamicDir, blockedTemp)) {
            const err: NodeJS.ErrnoException = new Error("EROFS: read-only file system");
            err.code = "EROFS";
            throw err;
          }
          removed.push(path);
          await Bun.file(path).delete();
        },
        isProcessPidDead: async (): Promise<boolean> => true,
      });
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(removed).toEqual([join(staticDir, staticDeadTemp)]);
      expect(await Bun.file(join(dynamicDir, blockedTemp)).exists()).toBeTrue();
      await expect(assertNoMisplacedConfigFiles(configRoot)).rejects.toThrow("must be absent");
    } finally {
      errorSpy.mockRestore();
    }
  });
});

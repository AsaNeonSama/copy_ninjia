import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_DATA_ROOT_ENV } from "../../packages/consts/environment";
import { REQUIRED_BUN_VERSION } from "../../scripts/installIsolation/fixture";
import type {
  InstallerFixture,
  InstallerRunResult,
  PromptReply,
} from "../../scripts/installIsolation/fixture";
import {
  checkServiceDataRoot,
  checkServiceObservation,
  checkServiceProtection,
} from "../../scripts/installIsolation/serviceChecks";
import type { ServiceCheckDependencies } from "../../scripts/installIsolation/serviceChecks";

const createdRoots: string[] = [];

function cleanMockRoots(): void {
  for (const root of createdRoots) rmSync(root, { recursive: true, force: true });
  createdRoots.length = 0;
}

async function mockWriteText(path: string, content: string, mode?: number): Promise<void> {
  await Bun.write(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

function createFakeDependencies(): {
  readonly dependencies: ServiceCheckDependencies;
  getCallCount(): number;
} {
  let installerCallCount: number = 0;

  async function createFixture(): Promise<InstallerFixture> {
    const root: string = mkdtempSync(join(tmpdir(), "copy-ninjia-svc-mock-"));
    createdRoots.push(root);
    const worktree: string = join(root, "work");
    const configRoot: string = join(root, "config");
    const backupRoot: string = join(root, "backup");
    const runtimeRoot: string = join(root, "runtime");
    const binRoot: string = join(root, "bin");
    const callLog: string = join(root, "call.log");
    const outboundLog: string = join(root, "outbound.log");
    mkdirSync(join(root, "systemd"), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    mkdirSync(configRoot, { recursive: true });
    mkdirSync(backupRoot, { recursive: true });
    mkdirSync(runtimeRoot, { recursive: true });
    mkdirSync(binRoot, { recursive: true });
    await Bun.write(join(root, "systemd/copy-ninjia.service"), "[Service]\n");
    await Bun.write(callLog, "");
    await Bun.write(outboundLog, "");
    return { realRuntime: false, root, worktree, configRoot, backupRoot, runtimeRoot, binRoot, callLog, outboundLog };
  }

  async function runInstaller(
    fixture: InstallerFixture,
    _replies: readonly PromptReply[] = [],
    environment: Readonly<Record<string, string | undefined>> = {}
  ): Promise<InstallerRunResult> {
    installerCallCount += 1;
    if (
      "FAKE_SERVICE_STATE" in environment ||
      "FAKE_SYSTEMCTL_FAIL" in environment ||
      ("FAKE_SERVICE_LOAD_STATE" in environment && environment.FAKE_SERVICE_LOAD_STATE === "masked") ||
      "FAKE_SERVICE_WORKDIR" in environment ||
      "FAKE_SERVICE_ENTRY" in environment
    ) {
      await Bun.write(fixture.outboundLog, "systemctl:guarded:show\n");
      return { exitCode: 1, output: "service check rejected" };
    }
    if (
      "FAKE_SERVICE_ENVIRONMENT" in environment ||
      "FAKE_SERVICE_ENVIRONMENT_FILES" in environment ||
      "FAKE_SERVICE_PASS_ENVIRONMENT" in environment ||
      "FAKE_SERVICE_UNSET_ENVIRONMENT" in environment ||
      (RUNTIME_DATA_ROOT_ENV in environment && environment[RUNTIME_DATA_ROOT_ENV] === undefined)
    ) {
      await Bun.write(fixture.outboundLog, "-p Environment\n");
      const envVal: string = environment.FAKE_SERVICE_ENVIRONMENT ?? "";
      const isRootUnset: boolean =
        RUNTIME_DATA_ROOT_ENV in environment && environment[RUNTIME_DATA_ROOT_ENV] === undefined;
      const accepted: boolean =
        (envVal === "LANG=C.UTF-8" && isRootUnset) ||
        envVal.includes(`=${fixture.runtimeRoot}/`) ||
        envVal.includes("\\there");
      if (accepted) return { exitCode: 0, output: "" };
      const msg: string = isRootUnset &&
        !("FAKE_SERVICE_ENVIRONMENT" in environment) &&
        !("FAKE_SERVICE_ENVIRONMENT_FILES" in environment)
        ? `Environment.${RUNTIME_DATA_ROOT_ENV} 与安装环境必须同时缺省或显式解析为同一数据根`
        : `${RUNTIME_DATA_ROOT_ENV} mismatch`;
      return { exitCode: 1, output: msg };
    }
    const interval: string = environment.FAKE_RESTART_INTERVAL ?? "5s";
    const randomized: string = environment.FAKE_RESTART_RANDOMIZED ?? "0";
    const steps: number = Number(environment.FAKE_RESTART_STEPS ?? "0");
    const maxVal: string = environment.FAKE_RESTART_MAX ?? "";
    const started: string = environment.FAKE_RESTARTS_STARTED ?? "0";
    const after: string = environment.FAKE_RESTARTS_AFTER ?? started;
    const isInvalidTiming: boolean = interval === "" || interval === "unknown" || randomized === "invalid";
    if (isInvalidTiming || started === "") {
      await Bun.write(fixture.outboundLog, "systemctl:guarded:show\nsystemctl:guarded:start \n");
      const backupDir: string = join(fixture.backupRoot, "b1");
      mkdirSync(backupDir, { recursive: true });
      await Bun.write(join(backupDir, "manifest.tsv"), "copy-ninjia.service\n");
      await Bun.write(join(backupDir, "original-1.json"), "[Service]\n");
      return { exitCode: 1, output: "invalid observation state" };
    }
    const baseSec: number = interval === "1min 500ms" ? 60.5 : interval === "0" ? 0 : 5;
    const randSec: number = randomized === "1min" ? 60 : 0;
    const seconds: number = steps === 3 && maxVal === "2min"
      ? (interval === "0" ? 2 : randSec > 0 ? 362 : 242)
      : baseSec * 2 + 2 + randSec * 2;
    await Bun.write(
      fixture.outboundLog,
      `systemctl:guarded:show\nsystemctl:guarded:start \n-p NRestarts\nsleep:guarded:${seconds}\n`
    );
    const failed: boolean =
      after === "" ||
      Number(after) > Number(started) ||
      (Number(after) === 0 && Number(started) > 0) ||
      environment.FAKE_STARTED_STATE === "failed" ||
      Boolean(environment.FAKE_JOURNAL_BODY) ||
      environment.FAKE_JOURNAL_FAIL === "1";
    if (failed) {
      const backupDir: string = join(fixture.backupRoot, "b1");
      mkdirSync(backupDir, { recursive: true });
      await Bun.write(join(backupDir, "manifest.tsv"), "copy-ninjia.service\n");
      await Bun.write(join(backupDir, "original-1.json"), "[Service]\n");
      const msg: string = Number(after) === 0 && Number(started) > 0 ? "重启计数回落" : "observation failed";
      return { exitCode: 1, output: msg };
    }
    return { exitCode: 0, output: "" };
  }

  return {
    dependencies: {
      createFixture,
      runInstaller,
      systemdPrompt: (): PromptReply => ({ prompt: `systemd ${REQUIRED_BUN_VERSION}`, reply: "y" }),
      validTelegram: (): string => JSON.stringify({ bot_token: "1:mock", super_admin_user_id: 1 }),
      writeText: mockWriteText,
    },
    getCallCount: (): number => installerCallCount,
  };
}

afterEach(cleanMockRoots);

describe("installIsolation/serviceChecks 状态断言路径", () => {
  test("checkServiceDataRoot、checkServiceProtection 与 checkServiceObservation 对符合约定的安装器各自跑完全部场景", async () => {
    const fake = createFakeDependencies();
    await checkServiceDataRoot(fake.dependencies);
    const afterDataRoot: number = fake.getCallCount();
    expect(afterDataRoot).toBeGreaterThan(0);
    await checkServiceProtection(fake.dependencies);
    const afterProtection: number = fake.getCallCount();
    expect(afterProtection).toBeGreaterThan(afterDataRoot);
    await checkServiceObservation(fake.dependencies);
    expect(fake.getCallCount()).toBeGreaterThan(afterProtection);
  });

  test("checkServiceDataRoot 在安装器放过数据根不一致的既有 unit 时拒绝通过", async () => {
    const fake = createFakeDependencies();
    await expect(
      checkServiceDataRoot({
        ...fake.dependencies,
        runInstaller: async (): Promise<InstallerRunResult> => ({ exitCode: 0, output: "" }),
      })
    ).rejects.toThrow("既有 unit 与安装环境的数据根不一致时必须失败");
  });

  test("checkServiceProtection 与 checkServiceObservation 在状态不变量被破坏时拒绝通过", async () => {
    const fake = createFakeDependencies();
    await expect(
      checkServiceProtection({
        ...fake.dependencies,
        runInstaller: async (): Promise<InstallerRunResult> => ({ exitCode: 0, output: "" }),
      })
    ).rejects.toThrow("运行中、未知状态或路径不符时必须失败");

    await expect(
      checkServiceProtection({
        ...fake.dependencies,
        runInstaller: async (fixture: InstallerFixture): Promise<InstallerRunResult> => {
          await Bun.write(fixture.outboundLog, "skipped\n");
          return { exitCode: 1, output: "rejected" };
        },
      })
    ).rejects.toThrow("服务保护必须实际查询 fake systemctl");

    await expect(
      checkServiceObservation({
        ...fake.dependencies,
        runInstaller: async (
          fixture: InstallerFixture,
          replies: readonly PromptReply[] = [],
          environment: Readonly<Record<string, string | undefined>> = {}
        ): Promise<InstallerRunResult> => {
          const result: InstallerRunResult = await fake.dependencies.runInstaller(fixture, replies, environment);
          if (result.exitCode !== 0) {
            rmSync(fixture.backupRoot, { recursive: true, force: true });
            mkdirSync(fixture.backupRoot, { recursive: true });
          }
          return result;
        },
      })
    ).rejects.toThrow("仅完整确认稳定后才能清理备份");

    await expect(
      checkServiceObservation({
        ...fake.dependencies,
        runInstaller: async (fixture: InstallerFixture): Promise<InstallerRunResult> => {
          await Bun.write(fixture.outboundLog, "systemctl:guarded:show\nsystemctl:guarded:start \n-p NRestarts\n");
          return { exitCode: 0, output: "" };
        },
      })
    ).rejects.toThrow("观察必须覆盖两个实际重启间隔");
  });
});

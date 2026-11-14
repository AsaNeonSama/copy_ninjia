import { afterEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIME_DATA_ROOT_ENV } from "../../packages/consts/environment";
import type {
  InstallerFixture,
  InstallerRunResult,
  PromptReply,
} from "../../scripts/installIsolation/fixture";

const createdRoots: string[] = [];
let installerCallCount: number = 0;

function cleanMockRoots(): void {
  installerCallCount = 0;
  for (const root of createdRoots) rmSync(root, { recursive: true, force: true });
  createdRoots.length = 0;
}

async function mockWriteText(path: string, content: string, mode?: number): Promise<void> {
  await Bun.write(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

mock.module("../../scripts/installIsolation/fixture", () => ({
  REQUIRED_BUN_VERSION: "1.4.4",
  writeText: mockWriteText,
  systemdPrompt: (): PromptReply => ({ prompt: "systemd", reply: "y" }),
  validTelegram: (): string => JSON.stringify({ bot_token: "1:mock", super_admin_user_id: 1 }),
  cleanupFixtures: cleanMockRoots,
  createFixture: async (): Promise<InstallerFixture> => {
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
  },
  runInstaller: async (
    fixture: InstallerFixture,
    _replies: readonly PromptReply[] = [],
    environment: Readonly<Record<string, string | undefined>> = {}
  ): Promise<InstallerRunResult> => {
    installerCallCount += 1;
    if ("FAKE_SERVICE_STATE" in environment || "FAKE_SYSTEMCTL_FAIL" in environment ||
      "FAKE_SERVICE_LOAD_STATE" in environment && environment.FAKE_SERVICE_LOAD_STATE === "masked" ||
      "FAKE_SERVICE_WORKDIR" in environment || "FAKE_SERVICE_ENTRY" in environment) {
      await Bun.write(fixture.outboundLog, "systemctl:guarded:show\n");
      return { exitCode: 1, output: "service check rejected" };
    }
    if ("FAKE_SERVICE_ENVIRONMENT" in environment || "FAKE_SERVICE_ENVIRONMENT_FILES" in environment ||
      "FAKE_SERVICE_PASS_ENVIRONMENT" in environment || "FAKE_SERVICE_UNSET_ENVIRONMENT" in environment ||
      (RUNTIME_DATA_ROOT_ENV in environment && environment[RUNTIME_DATA_ROOT_ENV] === undefined)) {
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
  },
}));

const {
  checkServiceDataRoot,
  checkServiceObservation,
  checkServiceProtection,
} = await import("../../scripts/installIsolation/serviceChecks");

afterEach(cleanMockRoots);

describe("installIsolation/serviceChecks 状态断言路径", () => {
  test("checkServiceDataRoot、checkServiceProtection 与 checkServiceObservation 全场景断言", async () => {
    await checkServiceDataRoot();
    await checkServiceProtection();
    await checkServiceObservation();
    expect(installerCallCount).toBeGreaterThan(0);
  });
});

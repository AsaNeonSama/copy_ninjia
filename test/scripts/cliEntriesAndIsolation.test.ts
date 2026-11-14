import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { CONFIG_ROOT_ENV, RUNTIME_DATA_ROOT_ENV } from "../../packages/consts/environment";
import { MINI_APP_FAVICON_PATH, MINI_APP_REJECT_HTML_PATH, PROJECT_ROOT } from "../../packages/consts/paths";
import {
  assertNoSourceMaps,
  assertPackagedResourcesMatch,
} from "../../scripts/checkBinary";
import {
  formatCoverageMetrics,
  runCoverageMetricsCheck,
} from "../../scripts/checkCoverageMetrics";
import { checkFixtureRoots } from "../../scripts/checkInstallIsolation";
import { checkInstallScriptSyntax } from "../../scripts/checkInstallScriptSyntax";
import { METRIC_SENTENCE_FILES, declaredCoverageMetrics } from "../../scripts/conventions/coverageMetrics";
import type { CoverageMetrics } from "../../scripts/conventions/coverageMetrics";
import { FAULT_INJECTION_TESTS } from "../../scripts/conventions/faultInjectionSuite";
import { copyFixtureTree } from "../../scripts/fixtures/copyTree";
import { runCapturedCommand } from "../../scripts/fixtures/subprocess";
import type { CapturedCommandResult } from "../../scripts/fixtures/subprocess";
import { cleanupFixtures } from "../../scripts/installIsolation/fixture";
import { runReleaseCli } from "../../scripts/release";
import type { ReleaseAsset } from "../../scripts/release/assets";
import type { CommandResult, ReleaseCommand } from "../../scripts/release/command";
import { runFaultInjectionSuite } from "../../scripts/testFaultInjection";

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const root: string = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach((): void => {
  cleanupFixtures();
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots.length = 0;
});

describe("scripts CLI 与隔离脚本直测", () => {
  test("scripts/binary.ts 处理 --help、--version、非法参数及无配置隔离目录失败退出", async () => {
    const binaryScript: string = join(PROJECT_ROOT, "scripts", "binary.ts");
    const help: CapturedCommandResult = await runCapturedCommand({
      cmd: [Bun.argv[0]!, binaryScript, "--help"],
      cwd: PROJECT_ROOT,
    });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Usage: ./copy-ninjia [--help|--version]");

    const versionDir: string = makeTempRoot("copy-ninjia-bin-ver-");
    await Bun.write(join(versionDir, "binary.json"), JSON.stringify({ version: "9.8.7" }));
    const ver: CapturedCommandResult = await runCapturedCommand({
      cmd: [Bun.argv[0]!, binaryScript, "--version"],
      cwd: versionDir,
    });
    expect(ver.exitCode).toBe(0);
    expect(ver.stdout.trim()).toBe("9.8.7");

    const invalidFlag: CapturedCommandResult = await runCapturedCommand({
      cmd: [Bun.argv[0]!, binaryScript, "--unknown-flag"],
      cwd: versionDir,
    });
    expect(invalidFlag.exitCode).toBe(1);
    expect(invalidFlag.stderr).toContain("Usage: ./copy-ninjia [--help|--version]");

    const isolatedDataRoot: string = makeTempRoot("copy-ninjia-bin-data-");
    const noConfigRun: CapturedCommandResult = await runCapturedCommand({
      cmd: [Bun.argv[0]!, binaryScript],
      cwd: isolatedDataRoot,
      env: {
        ...process.env,
        [RUNTIME_DATA_ROOT_ENV]: isolatedDataRoot,
        [CONFIG_ROOT_ENV]: join(isolatedDataRoot, "config"),
      },
    });
    expect(noConfigRun.exitCode).toBe(1);
    expect(noConfigRun.stderr).toContain(`${join(isolatedDataRoot, "config", "dynamic")}: $ must be an existing directory.`);
  });

  test("checkCoverageMetrics 覆盖格式化、声明缺失失败、当前一致通过与过期差异返回 1", async () => {
    const malformedRoot: string = makeTempRoot("copy-ninjia-cov-empty-");
    for (const rel of METRIC_SENTENCE_FILES) {
      mkdirSync(join(malformedRoot, rel, ".."), { recursive: true });
      await Bun.write(join(malformedRoot, rel), "");
    }
    const logSpy = spyOn(console, "log").mockImplementation((): void => {});
    const errSpy = spyOn(console, "error").mockImplementation((): void => {});
    try {
      const missingCode: number = await runCoverageMetricsCheck({
        projectRoot: malformedRoot,
        measure: (): CoverageMetrics => ({ tests: 1, files: 1, expectCalls: 1, functionPercent: 100, linePercent: 100 }),
      });
      expect(missingCode).toBe(1);

      const declared: CoverageMetrics | null = await declaredCoverageMetrics(PROJECT_ROOT, []);
      expect(declared).not.toBeNull();
      expect(formatCoverageMetrics(declared!)).toContain(`${declared!.tests} tests / ${declared!.files} files`);

      const currentCode: number = await runCoverageMetricsCheck({
        projectRoot: PROJECT_ROOT,
        measure: (): CoverageMetrics => declared!,
      });
      expect(currentCode).toBe(0);

      const staleCode: number = await runCoverageMetricsCheck({
        projectRoot: PROJECT_ROOT,
        measure: (): CoverageMetrics => ({ ...declared!, tests: declared!.tests + 1 }),
      });
      expect(staleCode).toBe(1);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  test("checkInstallScriptSyntax 校验合法与存在语法错误的隔离 bash 脚本", async () => {
    const validRoot: string = makeTempRoot("copy-ninjia-sh-ok-");
    mkdirSync(join(validRoot, "scripts", "install"), { recursive: true });
    await Bun.write(join(validRoot, "install.sh"), '#!/usr/bin/env bash\nsource "./scripts/install/ok.sh"\n');
    await Bun.write(join(validRoot, "scripts", "install", "ok.sh"), "echo ok\n");
    expect(await checkInstallScriptSyntax(validRoot)).toBe(0);

    const badRoot: string = makeTempRoot("copy-ninjia-sh-bad-");
    await Bun.write(join(badRoot, "install.sh"), "#!/usr/bin/env bash\nif then\n");
    expect(await checkInstallScriptSyntax(badRoot)).toBe(1);
  });

  test("testFaultInjection runFaultInjectionSuite 把 --isolate 与透传参数放在套件清单前", async () => {
    const spawnCalls: { readonly cmd: readonly string[]; readonly cwd: string | undefined }[] = [];
    const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((
      cmdOrOptions: unknown,
      options?: { readonly cwd?: string }
    ): ReturnType<typeof Bun.spawn> => {
      if (Array.isArray(cmdOrOptions)) {
        spawnCalls.push({ cmd: cmdOrOptions as readonly string[], cwd: options?.cwd });
      } else {
        const opts: { readonly cmd: readonly string[]; readonly cwd?: string } =
          cmdOrOptions as { readonly cmd: readonly string[]; readonly cwd?: string };
        spawnCalls.push({ cmd: opts.cmd, cwd: opts.cwd });
      }
      return { exited: Promise.resolve(42) } as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn);
    try {
      const code: number = await runFaultInjectionSuite(["--bail=1"]);
      expect(code).toBe(42);
      expect(spawnCalls).toHaveLength(1);
      expect(spawnCalls[0]!.cmd).toEqual([
        Bun.argv[0]!,
        "test",
        "--isolate",
        "--bail=1",
        ...FAULT_INJECTION_TESTS,
      ]);
      expect(resolve(spawnCalls[0]!.cwd!)).toBe(PROJECT_ROOT);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("scripts/build 与 scripts/perf/identityDatabase 在非入口导入时无副作用", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("unexpected process.exit on import");
    }) as never);
    const spawnSyncSpy = spyOn(Bun, "spawnSync");
    const spawnSpy = spyOn(Bun, "spawn");
    try {
      await import("../../scripts/build");
      await import("../../scripts/perf/identityDatabase");
      expect(exitSpy).not.toHaveBeenCalled();
      expect(spawnSyncSpy).not.toHaveBeenCalled();
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
      spawnSyncSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  test("checkBinary 的 assertNoSourceMaps、assertPackagedResourcesMatch 与 checkFixtureRoots 行为正确", async () => {
    const root: string = makeTempRoot("copy-ninjia-bin-check-");
    mkdirSync(join(root, "sub"), { recursive: true });
    await Bun.write(join(root, "sub", "app.js"), "console.log(1);");
    await assertNoSourceMaps(root);

    await Bun.write(join(root, "sub", "app.js.map"), "{}");
    await expect(assertNoSourceMaps(root)).rejects.toThrow("Binary package must not contain source maps");

    const pkgRoot: string = makeTempRoot("copy-ninjia-pkg-res-");
    const faviconRel: string = relative(PROJECT_ROOT, MINI_APP_FAVICON_PATH);
    const rejectRel: string = relative(PROJECT_ROOT, MINI_APP_REJECT_HTML_PATH);
    await expect(assertPackagedResourcesMatch(pkgRoot)).rejects.toThrow("Binary package is missing");

    mkdirSync(join(pkgRoot, "packages", "mini-app-api-server", "resource"), { recursive: true });
    await copyFixtureTree(MINI_APP_FAVICON_PATH, join(pkgRoot, faviconRel));
    await copyFixtureTree(MINI_APP_REJECT_HTML_PATH, join(pkgRoot, rejectRel));
    await assertPackagedResourcesMatch(pkgRoot);

    await Bun.write(join(pkgRoot, rejectRel), "<html>tampered</html>");
    await expect(assertPackagedResourcesMatch(pkgRoot)).rejects.toThrow("SHA-256 does not match source");

    await checkFixtureRoots();
  });

  test("release CLI 覆盖帮助输出、参数校验及 check/build/verify/publish 路由", async () => {
    const logs: string[] = [];
    await runReleaseCli({
      args: ["--", "--help"],
      log: (line: string): void => {
        logs.push(line);
      },
    });
    expect(logs[0]).toContain("Usage: bun run release:check");

    await expect(runReleaseCli({ args: ["unknown"] })).rejects.toThrow("Expected check, build, verify or publish");
    await expect(runReleaseCli({ args: ["check", "--bad", "1"] })).rejects.toThrow("Invalid or repeated release option");
    await expect(runReleaseCli({ args: ["check", "--version", "v1.0.0"] })).rejects.toThrow("MAJOR.MINOR.PATCH");

    const calls: string[] = [];
    const makeMockCommand = (branch: string): ((_root: string) => ReleaseCommand) =>
      (): ReleaseCommand =>
        (arguments_: readonly string[]): CommandResult => {
          calls.push(arguments_.join(" "));
          return {
            exitCode: 0,
            stdout: arguments_.includes("--show-current") ? branch : "ok",
          };
        };

    logs.length = 0;
    await runReleaseCli({
      args: ["check", "--version", "1.2.3"],
      projectRoot: "/repo",
      createCommand: makeMockCommand("dev"),
      log: (line: string): void => {
        logs.push(line);
      },
    });
    expect(calls[0]).toContain("install --frozen-lockfile");
    expect(calls[4]).toContain("/repo/scripts/build.ts --version 1.2.3");

    await expect(runReleaseCli({
      args: ["build", "--version", "1.2.3"],
      createCommand: makeMockCommand("dev"),
      readSourceTree: (): null => null,
    })).rejects.toThrow("clean, committed Git worktree");

    await expect(runReleaseCli({
      args: ["build", "--version", "1.2.3"],
      createCommand: makeMockCommand("master"),
      readSourceTree: (): string => "tree123",
    })).rejects.toThrow("Release builds must run on dev.");

    calls.length = 0;
    await runReleaseCli({
      args: ["build", "--version", "1.2.3"],
      projectRoot: "/repo",
      createCommand: makeMockCommand("dev"),
      readSourceTree: (): string => "tree123",
      log: (line: string): void => {
        logs.push(line);
      },
    });
    expect(calls.some((cmd: string): boolean => cmd.includes("/repo/scripts/build.ts --version 1.2.3"))).toBe(true);

    const assetFixture: readonly ReleaseAsset[] = [];
    await expect(runReleaseCli({
      args: ["publish", "--version", "1.2.3", "--platforms", "linux-x64"],
      projectRoot: "/repo",
      createCommand: makeMockCommand("dev"),
      readSourceTree: (): string => "tree123",
      verifyAssets: async (): Promise<readonly ReleaseAsset[]> => assetFixture,
    })).rejects.toThrow("publish requires --notes-file.");

    logs.length = 0;
    await runReleaseCli({
      args: ["verify", "--version", "1.2.3", "--platforms", "linux-x64"],
      projectRoot: "/repo",
      createCommand: makeMockCommand("dev"),
      readSourceTree: (): string => "tree123",
      verifyAssets: async (): Promise<readonly ReleaseAsset[]> => assetFixture,
      log: (line: string): void => {
        logs.push(line);
      },
    });
    expect(logs[0]).toContain("Verified 0 release assets for 1.2.3 (tree123).");

    logs.length = 0;
    const publishedNotesPaths: string[] = [];
    await runReleaseCli({
      args: ["publish", "--version", "1.2.3", "--platforms", "linux-x64", "--notes-file", "notes/v1.md"],
      projectRoot: "/repo",
      createCommand: makeMockCommand("dev"),
      readSourceTree: (): string => "tree123",
      verifyAssets: async (): Promise<readonly ReleaseAsset[]> => assetFixture,
      publish: async (options: { readonly notesPath: string }): Promise<string> => {
        publishedNotesPaths.push(options.notesPath);
        return "https://example.invalid/release/v1.2.3";
      },
      log: (line: string): void => {
        logs.push(line);
      },
    });
    expect(publishedNotesPaths).toEqual(["/repo/notes/v1.md"]);
    expect(logs[0]).toContain("https://example.invalid/release/v1.2.3");
  });
});

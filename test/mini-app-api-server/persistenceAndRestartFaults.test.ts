/**
 * Mini App 持久化故障注入、配置校验边界与宿主 systemd 重启测试：
 * - `POST /api/totp/enable` 写盘失败时返回 500、内存验证器记录保持未激活且不吊销其余会话；
 * - `saveMiniAppConfigFile` 写盘失败时返回校验/保存失败并完整保留磁盘旧配置与内存快照，超大载荷按 `MINI_APP_MAX_CONFIG_CONTENT_BYTES` 拒绝；
 * - 默认 `systemctl` 执行器通过隔离 PATH 子进程与进程内 `Bun.spawn` 替身覆盖实参传递、非零退出 stderr 透传/空输出/截断、同步抛错与超时/未退出中止；
 * - `readMiniAppConfigFile`、`saveMiniAppConfigFile` 与 `validateMiniAppConfigContent` 覆盖目录读失败、非白名单目标、跨文件容错回退、`web_digest` 缺口、本机默认头像路径校验与非 `InputValidationError` 错误归一化。
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installMiniAppTestDiskIOMock, buildSignedTestInitData, resetMiniAppTestDiskIOState } from "../helpers/miniAppInitData";
import { performMiniAppTestEcdhLogin } from "../helpers/miniAppRequest";
import type {
  AgentDeploymentConfig,
  AssetConfig,
  MoodConfig,
} from "../../packages/types/config";
import type { CronConfig } from "../../packages/types/cron";
import type {
  MiniAppConfigFileResponse,
  MiniAppConfigRestartResponse,
  MiniAppConfigSaveResponse,
} from "../../packages/types/miniApp/configs";
import { imageFixture } from "../helpers/image";

installMiniAppTestDiskIOMock();

let injectedAtomicWriteErrorPath: string | null = null;
const INJECTED_WRITE_ERROR_TEXT: string = "injected atomic write failure";

const realAtomicFile = { ...(await import("../../packages/libs/atomicFile")) };
const { mock } = await import("bun:test");
mock.module("../../packages/libs/atomicFile", () => ({
  ...realAtomicFile,
  atomicWriteText: async (path: string, content: string, mode?: number): Promise<void> => {
    if (injectedAtomicWriteErrorPath === path) {
      throw new Error(INJECTED_WRITE_ERROR_TEXT);
    }
    await realAtomicFile.atomicWriteText(path, content, mode);
  },
}));

const { assetConfigCache } = await import("../../packages/cache/main/assets");
const { cronConfigCache } = await import("../../packages/cache/main/cron");
const {
  miniAppAuthHandshakes,
  miniAppAuthSessions,
  miniAppPasswordGuardHolder,
  miniAppServiceRestartRunnerHolder,
  miniAppTotpRecordHolder,
} = await import("../../packages/cache/main/miniApp");
const {
  agentDeploymentConfigCache,
  defaultMoodConfigCache,
} = await import("../../packages/cache/perThread/config");
const { BOT_TOKEN, SUPER_ADMIN_USER_ID } = await import("../../packages/config/bot");
const {
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_SESSION_HEADER,
} = await import("../../packages/consts/miniApp");
const {
  MINI_APP_MAX_CONFIG_CONTENT_BYTES,
  MINI_APP_SERVICE_RESTART_COMMAND,
  MINI_APP_SERVICE_RESTART_STDERR_MAX_BYTES,
  MINI_APP_SERVICE_RESTART_TIMEOUT_MS,
} = await import("../../packages/consts/miniAppConfig");
const {
  MINI_APP_CONFIG_VALIDATION_FAILED_CODE,
  MINI_APP_INVALID_CONFIG_TARGET_CODE,
  MINI_APP_SERVICE_RESTART_FAILED_CODE,
} = await import("../../packages/consts/miniAppCrypto");
const {
  AGENT_CONFIG_PATH,
  ASSETS_CONFIG_PATH,
  BOT_CONFIG_PATH,
  CRON_CONFIG_PATH,
  DYNAMIC_CONFIG_DIR,
  GOOGLE_AUTH_FILE_PATH,
  IDENTITY_DATABASE_PATH,
  MINI_APP_TOTP_FILE_PATH,
  MINI_APP_TOTP_MEMORY_DIR,
  MOOD_CONFIG_PATH,
  RUNTIME_DATA_ROOT,
  STICKERS_CONFIG_PATH,
} = await import("../../packages/consts/paths");
const { ASSET_PATH_OR_URL_GROUP } = await import(
  "../../packages/consts/ui/assets"
);
const { logger } = await import("../../packages/infra/logger");
const { generateMiniAppTotpCodeAt } = await import("../../packages/libs/miniAppTotp");
const {
  issueMiniAppAuthSession,
  startMiniAppServer,
  stopMiniAppServer,
} = await import("../../packages/mini-app-api-server");
const {
  createPendingMiniAppTotpSetup,
  resetMiniAppTotpMemoryCache,
} = await import("../../packages/mini-app-api-server/auth/totpStorage");
const {
  readMiniAppConfigFile,
  restartMiniAppService,
  saveMiniAppConfigFile,
} = await import("../../packages/mini-app-api-server/view/configs/storage");
const {
  resolveMiniAppConfigTarget,
  validateMiniAppConfigContent,
} = await import("../../packages/mini-app-api-server/view/configs/validate");
const {
  buildMiniAppEnvelopeAad,
  encryptMiniAppEnvelope,
  importMiniAppAesGcmKey,
} = await import("../../packages/mini-app-frontend/libs/crypto");

let moodBackup: Uint8Array | null = null;
let savedMoodCache: MoodConfig | null = null;

beforeEach(async (): Promise<void> => {
  injectedAtomicWriteErrorPath = null;
  moodBackup = (await Bun.file(MOOD_CONFIG_PATH).exists())
    ? await Bun.file(MOOD_CONFIG_PATH).bytes()
    : null;
  savedMoodCache = defaultMoodConfigCache.current;
  resetMiniAppTotpMemoryCache();
  rmSync(MINI_APP_TOTP_MEMORY_DIR, { recursive: true, force: true });
});

afterEach(async (): Promise<void> => {
  injectedAtomicWriteErrorPath = null;
  await stopMiniAppServer();
  resetMiniAppTotpMemoryCache();
  rmSync(MINI_APP_TOTP_MEMORY_DIR, { recursive: true, force: true });
  resetMiniAppTestDiskIOState();
  miniAppAuthSessions.clear();
  miniAppAuthHandshakes.clear();
  miniAppPasswordGuardHolder.current = null;
  miniAppServiceRestartRunnerHolder.current = null;
  defaultMoodConfigCache.current = savedMoodCache;
  if (moodBackup === null) {
    rmSync(MOOD_CONFIG_PATH, { force: true });
  } else {
    await Bun.write(MOOD_CONFIG_PATH, moodBackup);
  }
});

describe("Mini App 持久化故障注入与宿主服务重启边界", (): void => {
  test("POST /api/totp/enable 写盘失败返回 500、保持未激活且不吊销其它会话", async (): Promise<void> => {
    const serverPassword: string = "totp-fault-password-123456";
    const server: ReturnType<typeof Bun.serve> | null = startMiniAppServer({
      url: "https://miniapp.example.com",
      host: "127.0.0.1",
      port: 0,
      password: serverPassword,
    });
    expect(server).not.toBeNull();
    const baseUrl: string = `http://127.0.0.1:${server!.port}`;

    const adminInitData: string = buildSignedTestInitData({
      botToken: BOT_TOKEN,
      authDate: Math.floor(Date.now() / 1000),
      user: { id: SUPER_ADMIN_USER_ID, first_name: "SuperAdmin" },
    });
    const otherSession = issueMiniAppAuthSession(Date.now());
    const { payload } = await performMiniAppTestEcdhLogin({
      initData: adminInitData,
      credentialPayload: { password: serverPassword },
      baseUrl,
      send: (req: Request): Promise<Response> => fetch(req),
    });
    const sessionKey: string = String(payload.sessionKey);
    const sessionToken: string = String(payload.sessionToken);
    const cryptoKey: CryptoKey = await importMiniAppAesGcmKey(sessionKey);
    const pending = await createPendingMiniAppTotpSetup(SUPER_ADMIN_USER_ID, Date.now());
    const validCode: string = generateMiniAppTotpCodeAt(pending.secret);
    const encryptedBody: string = JSON.stringify(
      await encryptMiniAppEnvelope(
        cryptoKey,
        JSON.stringify({ code: validCode }),
        buildMiniAppEnvelopeAad("POST", "/api/totp/enable", "req")
      )
    );

    injectedAtomicWriteErrorPath = MINI_APP_TOTP_FILE_PATH;
    const errorSpy = spyOn(logger, "error").mockImplementation((): void => {});
    try {
      const response: Response = await fetch(`${baseUrl}/api/totp/enable`, {
        method: "POST",
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData,
          [MINI_APP_SESSION_HEADER]: sessionToken,
          "Content-Type": "application/json",
        },
        body: encryptedBody,
      });
      expect(response.status).toBe(500);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }

    expect(miniAppTotpRecordHolder.current).toBeNull();
    expect(await Bun.file(MINI_APP_TOTP_FILE_PATH).exists()).toBeFalse();
    expect(miniAppAuthSessions.has(otherSession.token)).toBeTrue();
  });

  test("saveMiniAppConfigFile 写盘失败完整保留原配置文件与内存快照", async (): Promise<void> => {
    mkdirSync(DYNAMIC_CONFIG_DIR, { recursive: true });
    const originalMoodText: string = await Bun.file(
      join(process.cwd(), "config_example/dynamic/mood.json")
    ).text();
    await Bun.write(MOOD_CONFIG_PATH, originalMoodText);
    const parsed = JSON.parse(originalMoodText) as { moods: { weight: number; name: string; instruction: string }[] };
    const updatedMoodText: string = JSON.stringify(
      {
        ...parsed,
        moods: parsed.moods.map((item, idx) => {
          if (idx === 0) return { ...item, weight: item.weight + 1 };
          if (idx === 1) return { ...item, weight: item.weight - 1 };
          return item;
        }),
      },
      null,
      2
    );

    const cacheBefore = defaultMoodConfigCache.current;
    injectedAtomicWriteErrorPath = MOOD_CONFIG_PATH;
    const result: Readonly<MiniAppConfigSaveResponse> = await saveMiniAppConfigFile({
      scope: "dynamic",
      fileName: "mood.json",
      content: updatedMoodText,
    });

    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.code).toBe(MINI_APP_CONFIG_VALIDATION_FAILED_CODE);
      expect(result.error).toContain(INJECTED_WRITE_ERROR_TEXT);
    }
    expect(await Bun.file(MOOD_CONFIG_PATH).text()).toBe(originalMoodText);
    expect(defaultMoodConfigCache.current).toBe(cacheBefore);
  });

  test("saveMiniAppConfigFile 拒绝超出字节上限的配置文本且不触碰磁盘", async (): Promise<void> => {
    const oversizedContent: string = JSON.stringify({
      moods: [],
      filler: "a".repeat(MINI_APP_MAX_CONFIG_CONTENT_BYTES),
    });
    expect(new TextEncoder().encode(oversizedContent).length).toBeGreaterThan(
      MINI_APP_MAX_CONFIG_CONTENT_BYTES
    );

    const existedBefore: boolean = await Bun.file(MOOD_CONFIG_PATH).exists();
    const result: Readonly<MiniAppConfigSaveResponse> = await saveMiniAppConfigFile({
      scope: "dynamic",
      fileName: "mood.json",
      content: oversizedContent,
    });

    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.code).toBe(MINI_APP_CONFIG_VALIDATION_FAILED_CODE);
      expect(result.error).toContain(String(MINI_APP_MAX_CONFIG_CONTENT_BYTES));
    }
    expect(await Bun.file(MOOD_CONFIG_PATH).exists()).toBe(existedBefore);
  });

  test("默认 systemctl 执行器覆盖实参传递、stderr 透传/空输出/截断与超时中止", async (): Promise<void> => {
    const binDir: string = mkdtempSync(join(tmpdir(), "mini-app-systemctl-"));
    const systemctlPath: string = join(binDir, "systemctl");
    const argsRecordPath: string = join(binDir, "recorded-args.txt");

    const runRestartInChild = async (scriptBody: string): Promise<Readonly<MiniAppConfigRestartResponse>> => {
      await Bun.write(systemctlPath, `#!/usr/bin/env bash\n${scriptBody}\n`);
      chmodSync(systemctlPath, 0o755);
      // Bun.spawn 在未显式传 env 时按子进程启动时的 $PATH 解析二进制名，必须在隔离 PATH 子进程内运行，
      // 且调用前核对 Bun.which("systemctl") 确指假脚本，绝不触碰宿主真实 systemctl。
      const childScript: string = [
        `const { miniAppServiceRestartRunnerHolder } = await import(${JSON.stringify(join(process.cwd(), "packages/cache/main/miniApp.ts"))});`,
        `const { restartMiniAppService } = await import(${JSON.stringify(join(process.cwd(), "packages/mini-app-api-server/view/configs/storage.ts"))});`,
        `if (Bun.which("systemctl") !== ${JSON.stringify(systemctlPath)}) throw new Error("systemctl PATH guard triggered");`,
        "miniAppServiceRestartRunnerHolder.current = null;",
        "const outcome = await restartMiniAppService();",
        "console.log(JSON.stringify(outcome));",
      ].join("\n");
      const child = Bun.spawn({
        cmd: [Bun.argv[0]!, "-e", childScript],
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdoutPromise: Promise<string> = new Response(child.stdout).text();
      const stderrPromise: Promise<string> = new Response(child.stderr).text();
      const exitCode: number = await child.exited;
      const stdoutText: string = await stdoutPromise;
      const stderrText: string = await stderrPromise;
      expect(exitCode, stderrText).toBe(0);
      return JSON.parse(stdoutText.trim()) as MiniAppConfigRestartResponse;
    };

    try {
      // 1. exit 0 + 校验完整子命令实参。
      const okRes: Readonly<MiniAppConfigRestartResponse> = await runRestartInChild(
        `printf '%s' "$*" > ${JSON.stringify(argsRecordPath)}\nexit 0`
      );
      expect(okRes).toEqual({ ok: true });
      expect(await Bun.file(argsRecordPath).text()).toBe(
        MINI_APP_SERVICE_RESTART_COMMAND.slice(1).join(" ")
      );

      // 2. 非零退出且 stderr 非空：透传裁剪后的 stderr。
      const shortErrRes: Readonly<MiniAppConfigRestartResponse> = await runRestartInChild(
        'echo "  permission denied  " >&2\nexit 1'
      );
      expect(shortErrRes.ok).toBeFalse();
      if (!shortErrRes.ok) {
        expect(shortErrRes.code).toBe(MINI_APP_SERVICE_RESTART_FAILED_CODE);
        expect(shortErrRes.error).toBe("permission denied");
      }

      // 3. 非零退出且 stderr 为空：回落退出码文案。
      const emptyErrRes: Readonly<MiniAppConfigRestartResponse> = await runRestartInChild("exit 7");
      expect(emptyErrRes.ok).toBeFalse();
      if (!emptyErrRes.ok) {
        expect(emptyErrRes.code).toBe(MINI_APP_SERVICE_RESTART_FAILED_CODE);
        expect(emptyErrRes.error).toBe("systemctl exited with code 7.");
      }

      // 4. 非零退出且 stderr 超出 MINI_APP_SERVICE_RESTART_STDERR_MAX_BYTES：按上限截断。
      const truncatedErrRes: Readonly<MiniAppConfigRestartResponse> = await runRestartInChild(
        `head -c ${MINI_APP_SERVICE_RESTART_STDERR_MAX_BYTES * 2} /dev/zero | tr '\\0' 'E' >&2\nexit 2`
      );
      expect(truncatedErrRes.ok).toBeFalse();
      if (!truncatedErrRes.ok) {
        expect(truncatedErrRes.code).toBe(MINI_APP_SERVICE_RESTART_FAILED_CODE);
        expect(new TextEncoder().encode(truncatedErrRes.error).length).toBeLessThanOrEqual(
          MINI_APP_SERVICE_RESTART_STDERR_MAX_BYTES
        );
      }

      // 5. 子进程卡死超过 MINI_APP_SERVICE_RESTART_TIMEOUT_MS 时被超时中止并失败返回。
      const timedOutRes: Readonly<MiniAppConfigRestartResponse> = await runRestartInChild("exec sleep 30");
      expect(timedOutRes.ok).toBeFalse();
      if (!timedOutRes.ok) {
        expect(timedOutRes.code).toBe(MINI_APP_SERVICE_RESTART_FAILED_CODE);
        expect(timedOutRes.error?.length ?? 0).toBeGreaterThan(0);
      }
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 15_000);

  test("进程内 Bun.spawn 替身覆盖默认 systemctl 执行器全部分支、注入重启器抛错、读取非普通文件与非法目标保存", async (): Promise<void> => {
    const encoder: TextEncoder = new TextEncoder();

    const createMockSubprocess = (options: {
      readonly stderrBytes: Uint8Array;
      readonly exited: Promise<number>;
      readonly exitCode: number | null;
      readonly signalCode: NodeJS.Signals | null;
      readonly onKill: () => void;
    }): Bun.Subprocess<"ignore", "ignore", "pipe"> => {
      const stderrStream: ReadableStream<Uint8Array> =
        new ReadableStream<Uint8Array>({
          start(controller): void {
            if (options.stderrBytes.byteLength > 0) {
              controller.enqueue(options.stderrBytes);
            }
            controller.close();
          },
        });
      return {
        stderr: stderrStream,
        exited: options.exited,
        exitCode: options.exitCode,
        signalCode: options.signalCode,
        kill: (): void => {
          options.onKill();
        },
      } as unknown as Bun.Subprocess<"ignore", "ignore", "pipe">;
    };

    // 1. 退出码 0：核对实参与超时配置，且已退出的子进程不调用 kill()。
    let capturedSpawnArgs: unknown;
    let killCount: number = 0;
    const okSpawnSpy = spyOn(Bun, "spawn").mockImplementation(((
      spawnOptions: unknown
    ): Bun.Subprocess<"ignore", "ignore", "pipe"> => {
      capturedSpawnArgs = spawnOptions;
      return createMockSubprocess({
        stderrBytes: new Uint8Array(0),
        exited: Promise.resolve(0),
        exitCode: 0,
        signalCode: null,
        onKill: (): void => {
          killCount += 1;
        },
      });
    }) as typeof Bun.spawn);
    try {
      expect(await restartMiniAppService()).toEqual({ ok: true });
      expect(killCount).toBe(0);
      expect(capturedSpawnArgs).toEqual({
        cmd: [...MINI_APP_SERVICE_RESTART_COMMAND],
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        timeout: MINI_APP_SERVICE_RESTART_TIMEOUT_MS,
      });
    } finally {
      okSpawnSpy.mockRestore();
    }

    // 2. 非零退出且携带 stderr：裁剪空白后原样透传。
    const stderrSpawnSpy = spyOn(Bun, "spawn").mockImplementation((() =>
      createMockSubprocess({
        stderrBytes: encoder.encode("  Access denied by polkit  \n"),
        exited: Promise.resolve(1),
        exitCode: 1,
        signalCode: null,
        onKill: (): void => {},
      })) as typeof Bun.spawn);
    try {
      expect(await restartMiniAppService()).toEqual({
        ok: false,
        code: MINI_APP_SERVICE_RESTART_FAILED_CODE,
        error: "Access denied by polkit",
      });
    } finally {
      stderrSpawnSpy.mockRestore();
    }

    // 3. 非零退出且 stderr 为空或超限返回 null：回退为退出码文案。
    for (const [code, rawStderr] of [
      [7, encoder.encode("   ")],
      [2, new Uint8Array(MINI_APP_SERVICE_RESTART_STDERR_MAX_BYTES + 16).fill(69)],
    ] as readonly (readonly [number, Uint8Array])[]) {
      const emptyErrSpy = spyOn(Bun, "spawn").mockImplementation((() =>
        createMockSubprocess({
          stderrBytes: rawStderr,
          exited: Promise.resolve(code),
          exitCode: code,
          signalCode: null,
          onKill: (): void => {},
        })) as typeof Bun.spawn);
      try {
        expect(await restartMiniAppService()).toEqual({
          ok: false,
          code: MINI_APP_SERVICE_RESTART_FAILED_CODE,
          error: `systemctl exited with code ${code}.`,
        });
      } finally {
        emptyErrSpy.mockRestore();
      }
    }

    // 4. Bun.spawn 同步抛错：直接归一化为重启失败。
    const syncThrowSpy = spyOn(Bun, "spawn").mockImplementation((() => {
      throw new Error("spawn systemctl ENOENT");
    }) as typeof Bun.spawn);
    try {
      expect(await restartMiniAppService()).toEqual({
        ok: false,
        code: MINI_APP_SERVICE_RESTART_FAILED_CODE,
        error: "spawn systemctl ENOENT",
      });
    } finally {
      syncThrowSpy.mockRestore();
    }

    // 5. 等待子进程退出抛错且进程仍未结束：finally 必须调用 kill()。
    let killedInFinally: number = 0;
    const hangSpy = spyOn(Bun, "spawn").mockImplementation((() =>
      createMockSubprocess({
        stderrBytes: new Uint8Array(0),
        exited: Promise.reject(new Error("subprocess timed out")),
        exitCode: null,
        signalCode: null,
        onKill: (): void => {
          killedInFinally += 1;
        },
      })) as typeof Bun.spawn);
    try {
      expect(await restartMiniAppService()).toEqual({
        ok: false,
        code: MINI_APP_SERVICE_RESTART_FAILED_CODE,
        error: "subprocess timed out",
      });
      expect(killedInFinally).toBe(1);
    } finally {
      hangSpy.mockRestore();
    }

    // 6. 注入的自定义重启器抛错同样归一化为 SERVICE_RESTART_FAILED。
    miniAppServiceRestartRunnerHolder.current = async (): Promise<{
      readonly ok: true;
    }> => {
      throw new Error("custom runner crashed");
    };
    expect(await restartMiniAppService()).toEqual({
      ok: false,
      code: MINI_APP_SERVICE_RESTART_FAILED_CODE,
      error: "custom runner crashed",
    });

    // 7. 读取非普通文件（目录）失败与非白名单目标保存拒绝。
    rmSync(MOOD_CONFIG_PATH, { recursive: true, force: true });
    mkdirSync(MOOD_CONFIG_PATH, { recursive: true });
    try {
      const readErr: Readonly<MiniAppConfigFileResponse> =
        await readMiniAppConfigFile("dynamic", "mood.json");
      expect(readErr.ok).toBeFalse();
      if (!readErr.ok) {
        expect(readErr.code).toBe(MINI_APP_CONFIG_VALIDATION_FAILED_CODE);
        expect(readErr.scope).toBe("dynamic");
        expect(readErr.fileName).toBe("mood.json");
      }
    } finally {
      rmSync(MOOD_CONFIG_PATH, { recursive: true, force: true });
    }

    const badTargetSave: Readonly<MiniAppConfigSaveResponse> =
      await saveMiniAppConfigFile({
        scope: "dynamic",
        fileName: "not-in-whitelist.json",
        content: "{}",
      });
    expect(badTargetSave).toEqual({
      ok: false,
      code: MINI_APP_INVALID_CONFIG_TARGET_CODE,
      error: MINI_APP_INVALID_CONFIG_TARGET_CODE,
    });
  });

  test("validateMiniAppConfigContent 覆盖非法入参、agent/cron 跨文件回退、web_digest 缺口、本机默认头像路径校验与非 InputValidationError 归一化", async (): Promise<void> => {
    const extraPaths: readonly string[] = [
      AGENT_CONFIG_PATH,
      ASSETS_CONFIG_PATH,
      BOT_CONFIG_PATH,
      CRON_CONFIG_PATH,
      GOOGLE_AUTH_FILE_PATH,
      STICKERS_CONFIG_PATH,
    ];
    const backups: Map<string, Uint8Array | null> = new Map<
      string,
      Uint8Array | null
    >();
    for (const path of extraPaths) {
      backups.set(
        path,
        (await Bun.file(path).exists()) ? await Bun.file(path).bytes() : null
      );
    }
    const hadDb: boolean = await Bun.file(IDENTITY_DATABASE_PATH).exists();
    const savedCron: CronConfig | null = cronConfigCache.current;
    const savedAgent: Readonly<AgentDeploymentConfig> | null =
      agentDeploymentConfigCache.current;
    const savedAsset: AssetConfig = assetConfigCache.current;
    const avatarPath: string = join(RUNTIME_DATA_ROOT, "valid-avatar-test.png");

    try {
      expect(resolveMiniAppConfigTarget(123, "bot.json")).toBeNull();
      expect(resolveMiniAppConfigTarget("dynamic", null)).toBeNull();
      expect(resolveMiniAppConfigTarget("static", "unknown.json")).toBeNull();

      const agentTarget = resolveMiniAppConfigTarget("dynamic", "agent.json")!;
      const cronTarget = resolveMiniAppConfigTarget("dynamic", "cron.json")!;
      const assetsTarget = resolveMiniAppConfigTarget("dynamic", "assets.json")!;
      const botTarget = resolveMiniAppConfigTarget("static", "bot.json")!;

      const baseAgentRaw: string = await Bun.file(AGENT_CONFIG_PATH).text();
      const parsedAgent = JSON.parse(baseAgentRaw) as {
        agent: Record<string, unknown>;
      };
      const agentWithoutSummary: string = JSON.stringify({
        agent: {
          ...parsedAgent.agent,
          summary: undefined,
        },
      });

      // 1. cron.json 磁盘缺失时回退 cronConfigCache.current，含 send_web_digest 时触发 web_digest 缺口报错。
      rmSync(CRON_CONFIG_PATH, { force: true });
      cronConfigCache.current = [
        {
          name: "digest-job",
          chat_id: ["all"],
          cron: "0 8 * * *",
          actions: [{ type: "send_web_digest", payload: { topic: "news" } }],
        },
      ] as unknown as CronConfig;
      const missingCronFallbackRes = await validateMiniAppConfigContent(
        agentTarget,
        agentWithoutSummary
      );
      expect(missingCronFallbackRes.ok).toBeFalse();
      if (!missingCronFallbackRes.ok) {
        expect(missingCronFallbackRes.code).toBe(
          MINI_APP_CONFIG_VALIDATION_FAILED_CODE
        );
        expect(missingCronFallbackRes.error).toContain("send_web_digest");
      }

      // 2. cron.json 磁盘内容损坏时 catch 回退 cronConfigCache.current。
      await Bun.write(CRON_CONFIG_PATH, "{ broken cron json");
      cronConfigCache.current = null;
      const brokenCronFallbackRes = await validateMiniAppConfigContent(
        agentTarget,
        baseAgentRaw
      );
      expect(brokenCronFallbackRes.ok).toBeTrue();

      // 3. agent.json 磁盘缺失或损坏时，cron.json 校验回退到 agentDeploymentConfigSnapshot()。
      const plainMessageCron: string = JSON.stringify([
        {
          name: "plain-msg",
          chat_id: ["all"],
          cron: "0 10 * * *",
          actions: [{ type: "send_message", payload: { content: "hello" } }],
        },
      ]);
      rmSync(AGENT_CONFIG_PATH, { force: true });
      agentDeploymentConfigCache.current = null;
      expect(
        (await validateMiniAppConfigContent(cronTarget, plainMessageCron)).ok
      ).toBeTrue();

      await Bun.write(AGENT_CONFIG_PATH, "{ broken agent json");
      expect(
        (await validateMiniAppConfigContent(cronTarget, plainMessageCron)).ok
      ).toBeTrue();

      // 4. assets.json 的 botDefaultAvatar.kind === "path"：缺失文件拒绝，合法 PNG 通过，非 InputValidationError 归一化。
      const missingAvatarRes = await validateMiniAppConfigContent(
        assetsTarget,
        JSON.stringify({
          [ASSET_PATH_OR_URL_GROUP]: {
            bot_default_avatar: "./nonexistent-avatar-test.png",
          },
        })
      );
      expect(missingAvatarRes.ok).toBeFalse();
      if (!missingAvatarRes.ok) {
        expect(missingAvatarRes.code).toBe(MINI_APP_CONFIG_VALIDATION_FAILED_CODE);
      }

      const validPng: Uint8Array = await new Bun.Image(imageFixture(16, 16))
        .png()
        .bytes();
      await Bun.write(avatarPath, validPng);
      expect(
        (
          await validateMiniAppConfigContent(
            assetsTarget,
            JSON.stringify({
              [ASSET_PATH_OR_URL_GROUP]: {
                bot_default_avatar: "./valid-avatar-test.png",
              },
            })
          )
        ).ok
      ).toBeTrue();

      assetConfigCache.current = null as unknown as AssetConfig;
      try {
        const nonInputErrRes = await validateMiniAppConfigContent(
          assetsTarget,
          JSON.stringify({})
        );
        expect(nonInputErrRes.ok).toBeFalse();
        if (!nonInputErrRes.ok) {
          expect(nonInputErrRes.code).toBe(MINI_APP_CONFIG_VALIDATION_FAILED_CODE);
          expect(nonInputErrRes.error.length).toBeGreaterThan(0);
        }
      } finally {
        assetConfigCache.current = savedAsset;
      }

      // 5. 合法 bot.json 校验通过。
      expect(
        (
          await validateMiniAppConfigContent(
            botTarget,
            await Bun.file(BOT_CONFIG_PATH).text()
          )
        ).ok
      ).toBeTrue();
    } finally {
      rmSync(avatarPath, { force: true });
      for (const [path, backup] of backups.entries()) {
        rmSync(path, { recursive: true, force: true });
        if (backup !== null) {
          await Bun.write(path, backup);
        }
      }
      if (!hadDb && (await Bun.file(IDENTITY_DATABASE_PATH).exists())) {
        rmSync(IDENTITY_DATABASE_PATH, { force: true });
      }
      cronConfigCache.current = savedCron;
      agentDeploymentConfigCache.current = savedAgent;
      assetConfigCache.current = savedAsset;
    }
  });
});

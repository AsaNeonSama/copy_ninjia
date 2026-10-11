/**
 * 安装器的 systemd 分支隔离检查：既有 unit 的数据根与安装环境必须一致、运行中或路径不符的服务拒绝改写、
 * 启动后的稳定性观察与备份保留。由 scripts/checkInstallIsolation.ts 依次调用。
 */
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { STATIC_CONFIG_DIR_NAME } from "../../packages/consts/configLayout";
import { assertCondition, assertContains, assertEqual } from "./assertions";
import { createFixture, runInstaller, systemdPrompt, validTelegram, writeText } from "./fixture";
import type { InstallerFixture, InstallerRunResult } from "./fixture";

/** 一次安装的环境覆盖项；值为 undefined 表示移除该变量。 */
type EnvironmentOverrides = Readonly<Record<string, string | undefined>>;

/** 既有 unit 的 COPY_NINJIA_DATA_ROOT 与安装环境不一致时拒绝且不写任何东西，一致时继续。 */
export async function checkServiceDataRoot(): Promise<void> {
  const rejected: readonly ((fixture: InstallerFixture) => EnvironmentOverrides)[] = [
    (): EnvironmentOverrides => ({
      COPY_NINJIA_DATA_ROOT: undefined,
      FAKE_SERVICE_ENVIRONMENT: "",
      FAKE_SERVICE_ENVIRONMENT_FILES: "/srv/bot.env (ignore_errors=no)",
    }),
    (): EnvironmentOverrides => ({ FAKE_SERVICE_ENVIRONMENT_FILES: "/srv/bot.env (ignore_errors=no)" }),
    (): EnvironmentOverrides => ({ FAKE_SERVICE_PASS_ENVIRONMENT: "COPY_NINJIA_DATA_ROOT" }),
    (): EnvironmentOverrides => ({ FAKE_SERVICE_UNSET_ENVIRONMENT: "COPY_NINJIA_DATA_ROOT" }),
    (): EnvironmentOverrides => ({ FAKE_SERVICE_UNSET_ENVIRONMENT: "COPY_NINJIA_DATA_ROOT=/srv/bot" }),
    (fixture: InstallerFixture): EnvironmentOverrides => ({
      FAKE_SERVICE_ENVIRONMENT: `COPY_NINJIA_DATA_ROOT=${join(fixture.root, "other-runtime")}`,
    }),
    (): EnvironmentOverrides => ({ FAKE_SERVICE_ENVIRONMENT: "LANG=C.UTF-8" }),
    (): EnvironmentOverrides => ({ FAKE_SERVICE_ENVIRONMENT: "" }),
    (): EnvironmentOverrides => ({ COPY_NINJIA_DATA_ROOT: undefined }),
    (): EnvironmentOverrides => ({ FAKE_SERVICE_ENVIRONMENT: "COPY_NINJIA_DATA_ROOT=" }),
    (fixture: InstallerFixture): EnvironmentOverrides => ({
      FAKE_SERVICE_ENVIRONMENT: `"COPY_NINJIA_DATA_ROOT=${fixture.runtimeRoot}`,
    }),
    (fixture: InstallerFixture): EnvironmentOverrides => ({
      FAKE_SERVICE_ENVIRONMENT: `"COPY_NINJIA_DATA_ROOT=${fixture.runtimeRoot}\\001"`,
    }),
    (fixture: InstallerFixture): EnvironmentOverrides => ({
      FAKE_SERVICE_ENVIRONMENT:
        `COPY_NINJIA_DATA_ROOT=${fixture.runtimeRoot} COPY_NINJIA_DATA_ROOT=${fixture.runtimeRoot}`,
    }),
  ];
  for (const environment of rejected) {
    const fixture: InstallerFixture = await createFixture();
    mkdirSync(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME), { recursive: true });
    const telegram: string = validTelegram();
    await writeText(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json"), telegram, 0o600);
    const result: InstallerRunResult = await runInstaller(fixture, [], environment(fixture));
    assertCondition(result.exitCode !== 0, "既有 unit 与安装环境的数据根不一致时必须失败");
    assertContains(result.output, "COPY_NINJIA_DATA_ROOT", "拒绝信息必须点名数据根环境项");
    assertEqual(await Bun.file(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json")).text(), telegram, "拒绝时不得修改配置");
    assertEqual(readdirSync(fixture.configRoot).length, 1, "拒绝时不得创建配置");
    assertEqual(readdirSync(fixture.runtimeRoot).length, 0, "拒绝时不得写入运行时数据");
    assertEqual(readdirSync(fixture.backupRoot).length, 0, "拒绝时不得开始部署备份");
    assertCondition(!(await Bun.file(fixture.callLog).text()).includes("bun:install"), "数据根核对必须早于依赖安装");
    const calls: string = await Bun.file(fixture.outboundLog).text();
    assertContains(calls, "-p Environment", "数据根核对必须读取既有 unit 的 Environment");
    assertCondition(!/systemctl:guarded:(start|restart|enable|daemon-reload)|tee:guarded/.test(calls), "拒绝时不得执行服务写操作");
  }

  const missingRoot: InstallerFixture = await createFixture();
  const unsetResult: InstallerRunResult = await runInstaller(missingRoot, [], { COPY_NINJIA_DATA_ROOT: undefined });
  assertContains(
    unsetResult.output,
    "Environment.COPY_NINJIA_DATA_ROOT 与安装环境必须同时缺省或显式解析为同一数据根",
    "安装环境缺少数据根时只描述字段与期望条件"
  );
  assertCondition(!unsetResult.output.includes(missingRoot.runtimeRoot), "数据根预检失败不得回显 unit 的配置值");

  const quotedRoot: string = "data root \"q\" $v `x` 日本";
  const accepted: readonly ((fixture: InstallerFixture) => EnvironmentOverrides)[] = [
    (): EnvironmentOverrides => ({ COPY_NINJIA_DATA_ROOT: undefined, FAKE_SERVICE_ENVIRONMENT: "LANG=C.UTF-8" }),
    (fixture: InstallerFixture): EnvironmentOverrides => ({
      FAKE_SERVICE_ENVIRONMENT: `LANG=C.UTF-8 COPY_NINJIA_DATA_ROOT=${fixture.runtimeRoot}/ "NOTE=a b"`,
    }),
    (fixture: InstallerFixture): EnvironmentOverrides => ({
      COPY_NINJIA_DATA_ROOT: join(fixture.root, quotedRoot),
      FAKE_SERVICE_ENVIRONMENT:
        `"NOTE=tab\\there" "COPY_NINJIA_DATA_ROOT=${join(fixture.root, quotedRoot).replace(/["\\`$]/g, "\\$&")}"`,
    }),
  ];
  for (const environment of accepted) {
    const fixture: InstallerFixture = await createFixture();
    mkdirSync(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME), { recursive: true });
    await writeText(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json"), validTelegram(), 0o600);
    const result: InstallerRunResult = await runInstaller(fixture, [
      { prompt: "是否重新填写？", reply: "n" },
      { prompt: "现在配置 AI 能力", reply: "n" },
      systemdPrompt(),
    ], environment(fixture));
    assertEqual(result.exitCode, 0, `既有 unit 与安装环境指向同一数据根时必须继续：${result.output}`);
  }
}

/** 服务运行中、状态未知或入口路径不符时拒绝，且不执行任何服务写操作。 */
export async function checkServiceProtection(): Promise<void> {
  const rejected: readonly Readonly<Record<string, string>>[] = [
    { FAKE_SERVICE_STATE: "active" },
    { FAKE_SERVICE_STATE: "activating" },
    { FAKE_SERVICE_STATE: "" },
    { FAKE_SYSTEMCTL_FAIL: "1" },
    { FAKE_SERVICE_LOAD_STATE: "masked" },
    { FAKE_SERVICE_WORKDIR: "/tmp" },
    { FAKE_SERVICE_ENTRY: "{ path=/bin/node ; argv[]=/bin/node index.ts ; ignore_errors=no ; }" },
    { FAKE_SERVICE_ENTRY: "{ path=/guarded/bun ; argv[]=/guarded/bun other.ts ; ignore_errors=no ; }" },
    { FAKE_SERVICE_ENTRY: "{ path=/guarded/bun ; argv[]=/guarded/bun start ; ignore_errors=no ; }\n{ path=/bin/false ; argv[]=/bin/false ; ignore_errors=no ; }" },
    { FAKE_SERVICE_ENTRY: "{ path=/guarded/bun ; argv[]=/guarded/bun start ; ignore_errors=no ; } ; { path=/bin/false ; argv[]=/bin/false ; ignore_errors=no ; }" },
  ];
  for (const environment of rejected) {
    const fixture: InstallerFixture = await createFixture();
    mkdirSync(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME), { recursive: true });
    const telegram: string = validTelegram();
    await writeText(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json"), telegram, 0o600);
    const result: InstallerRunResult = await runInstaller(fixture, [], environment);
    assertCondition(result.exitCode !== 0, "运行中、未知状态或路径不符时必须失败");
    assertEqual(await Bun.file(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json")).text(), telegram, "拒绝时不得修改配置");
    assertEqual(readdirSync(fixture.configRoot).length, 1, "拒绝时不得创建配置");
    assertEqual(readdirSync(fixture.runtimeRoot).length, 0, "拒绝时不得写入运行时数据");
    assertEqual(readdirSync(fixture.backupRoot).length, 0, "拒绝时不得开始部署备份");
    assertCondition(!(await Bun.file(fixture.callLog).text()).includes("bun:install"), "拒绝必须早于依赖安装");
    const calls: string = await Bun.file(fixture.outboundLog).text();
    assertContains(calls, "systemctl:guarded:show", "服务保护必须实际查询 fake systemctl");
    assertCondition(!/systemctl:guarded:(start|restart|enable|daemon-reload)|tee:guarded/.test(calls), "拒绝时不得执行服务写操作");
  }
}

/** 启动后按实际重启间隔观察稳定性；只有确认稳定才清理备份。 */
export async function checkServiceObservation(): Promise<void> {
  const cases: readonly Readonly<{
    environment: Readonly<Record<string, string>>;
    fresh?: boolean;
    overwriteUnit?: boolean;
    seconds?: number;
    success: boolean;
  }>[] = [
    { environment: { FAKE_SERVICE_LOAD_STATE: "not-found" }, fresh: true, seconds: 12, success: true },
    { environment: { FAKE_RESTART_INTERVAL: "1min 500ms" }, seconds: 123, success: true },
    { environment: { FAKE_RESTART_STEPS: "3", FAKE_RESTART_MAX: "2min" }, seconds: 242, success: true },
    { environment: { FAKE_RESTART_STEPS: "3", FAKE_RESTART_MAX: "infinity" }, seconds: 12, success: true },
    { environment: { FAKE_RESTART_INTERVAL: "0", FAKE_RESTART_STEPS: "3", FAKE_RESTART_MAX: "2min" }, seconds: 2, success: true },
    { environment: { FAKE_RESTART_RANDOMIZED: "1min" }, seconds: 132, success: true },
    { environment: { FAKE_RESTART_STEPS: "3", FAKE_RESTART_MAX: "2min", FAKE_RESTART_RANDOMIZED: "1min" }, seconds: 362, success: true },
    { environment: { FAKE_RESTART_INTERVAL: "", FAKE_RESTART_STEPS: "3", FAKE_RESTART_MAX: "2min" }, success: false },
    { environment: { FAKE_RESTART_RANDOMIZED: "invalid" }, success: false },
    { environment: { FAKE_RESTART_INTERVAL: "unknown" }, success: false },
    { environment: { FAKE_RESTARTS_STARTED: "" }, success: false },
    { environment: { FAKE_RESTARTS_BEFORE: "3", FAKE_RESTARTS_STARTED: "0" }, seconds: 12, success: true },
    { environment: { FAKE_RESTARTS_STARTED: "2" }, seconds: 12, success: true },
    { environment: { FAKE_RESTARTS_STARTED: "2", FAKE_RESTARTS_AFTER: "0" }, seconds: 12, success: false },
    { environment: { FAKE_RESTARTS_AFTER: "1" }, seconds: 12, success: false },
    { environment: { FAKE_RESTARTS_AFTER: "" }, seconds: 12, success: false },
    { environment: { FAKE_STARTED_STATE: "failed" }, seconds: 12, success: false },
    { environment: { FAKE_JOURNAL_BODY: "Main process exited, code=exited, status=1/FAILURE" }, seconds: 12, success: false },
    { environment: { FAKE_JOURNAL_FAIL: "1" }, overwriteUnit: true, seconds: 12, success: false },
  ];
  for (const scenario of cases) {
    const fixture: InstallerFixture = await createFixture();
    if (scenario.fresh === true) await Bun.file(join(fixture.root, "systemd/copy-ninjia.service")).delete();
    mkdirSync(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME), { recursive: true });
    await writeText(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json"), validTelegram(), 0o600);
    const result: InstallerRunResult = await runInstaller(fixture, [
      { prompt: "是否重新填写？", reply: "y" },
      { prompt: "Telegram bot token", reply: "987654321:observation_test_token", secret: true },
      { prompt: "超级管理员用户 ID", reply: "987654321" },
      { prompt: "现在配置 AI 能力", reply: "n" },
      scenario.overwriteUnit === true ? { prompt: "覆盖它？", reply: "y" } : systemdPrompt(),
    ], scenario.environment);
    assertEqual(result.exitCode === 0, scenario.success, `服务观察结果不符：${result.output}`);
    const calls: string = await Bun.file(fixture.outboundLog).text();
    assertContains(calls, "systemctl:guarded:show", "必须执行 systemd 分支");
    const baselineIndex: number = calls.indexOf("-p NRestarts");
    if (scenario.seconds !== undefined) assertCondition(baselineIndex > -1, "必须读取重启计数基线");
    if (baselineIndex > -1) {
      const startIndex: number = calls.indexOf("systemctl:guarded:start ");
      assertCondition(
        startIndex > -1 && startIndex < baselineIndex,
        "重启计数基线必须在 systemctl start 返回之后读取"
      );
    }
    if (scenario.environment.FAKE_RESTARTS_AFTER === "0") {
      assertContains(result.output, "回落", "重启计数回落必须明确报告无法确认");
    }
    if (scenario.seconds !== undefined) {
      assertContains(calls, `sleep:guarded:${scenario.seconds}\n`, "观察必须覆盖两个实际重启间隔");
    }
    assertEqual(readdirSync(fixture.backupRoot).length, scenario.success ? 0 : 1, "仅完整确认稳定后才能清理备份");
    if (scenario.overwriteUnit === true) {
      const backup: string = join(fixture.backupRoot, readdirSync(fixture.backupRoot)[0]!);
      assertContains(await Bun.file(join(backup, "manifest.tsv")).text(), "copy-ninjia.service", "覆盖 unit 前必须记录备份清单");
      assertEqual(await Bun.file(join(backup, "original-1.json")).text(), "[Service]\n", "失败时必须保留 unit 原文");
    }
  }
}

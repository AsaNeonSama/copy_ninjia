import {
  lstatSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, join } from "node:path";
import { DYNAMIC_CONFIG_DIR_NAME, STATIC_CONFIG_DIR_NAME } from "../packages/consts/configLayout";
import {
  IDENTITY_DATABASE_DIRECTORY_MODE,
  IDENTITY_DATABASE_FILE_MODE,
} from "../packages/consts/identityStorage";
import {
  cleanupFixtures,
  createFixture,
  runInstaller,
  systemdPrompt,
  validTelegram,
  writeText,
} from "./installIsolation/fixture";
import type {
  InstallerFixture,
  InstallerRunResult,
} from "./installIsolation/fixture";
import { assertCondition, assertContains, assertEqual } from "./installIsolation/assertions";
import { checkServiceDataRoot, checkServiceObservation, checkServiceProtection } from "./installIsolation/serviceChecks";

/** 校验 Telegram 候选配置校验失败时的回滚与外部备份保留行为。 */
async function checkTelegramRollback(): Promise<void> {
  const fixture: InstallerFixture = await createFixture();
  mkdirSync(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME), { recursive: true });
  const botConfigPath: string = join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json");
  const original: string = validTelegram();
  await writeText(botConfigPath, original, 0o640);
  const result: InstallerRunResult = await runInstaller(fixture, [
    { prompt: "是否重新填写？", reply: "y" },
    { prompt: "Telegram bot token", reply: "987654321:new_test_token", secret: true },
    { prompt: "超级管理员用户 ID", reply: "987654321" },
  ], {
    FAKE_BACKUP_PRESERVE_FAIL: "1",
    FAKE_TELEGRAM_VALIDATION_FAIL: "1",
  });

  assertCondition(result.exitCode !== 0, "Telegram 候选配置校验失败时安装器必须失败");
  assertEqual(await Bun.file(botConfigPath).text(), original, "Telegram 原配置不得改变");
  assertEqual((await Bun.file(botConfigPath).stat()).mode & 0o777, 0o640, "Telegram 原权限不得改变");
  const backupDirectories: readonly string[] = readdirSync(fixture.backupRoot);
  assertEqual(backupDirectories.length, 1, "必须生成一份外部配置备份");
  const backupName: string | undefined = backupDirectories[0];
  assertCondition(backupName !== undefined, "外部配置备份目录缺失");
  const backupDirectory: string = join(fixture.backupRoot, backupName);
  assertEqual(
    await Bun.file(join(backupDirectory, "original-0.json")).text(),
    original,
    "外部备份内容必须与原配置一致"
  );
  const manifest: string = await Bun.file(join(backupDirectory, "manifest.tsv")).text();
  assertContains(manifest, "config/static/bot.json\tmode=640", "备份清单必须记录路径与权限");
  assertCondition(/sha256=[0-9a-f]{64}/.test(manifest), "备份清单必须记录 SHA-256");
  assertContains(await Bun.file(fixture.callLog).text(), "cp-preserve=failure", "属主保留失败分支必须实测");
  assertCondition(
    !readdirSync(fixture.configRoot).some(
      (name: string): boolean => name.includes(".install.")
    ),
    "校验失败后不得残留候选配置"
  );
}

/** 校验候选文件权限收紧失败时 EXIT trap 对候选文件的清理行为。 */
async function checkStagingPermissionFailureCleanup(): Promise<void> {
  const fixture: InstallerFixture = await createFixture();
  const result: InstallerRunResult = await runInstaller(
    fixture,
    [],
    { FAKE_STAGING_CHMOD_FAIL: "1" }
  );
  assertCondition(result.exitCode !== 0, "候选文件权限收紧失败时安装器必须失败");
  assertCondition(
    readdirSync(fixture.configRoot).every((name: string): boolean => !name.includes(".install.")),
    "权限收紧失败也必须由 EXIT trap 清理候选文件"
  );
}

/** 校验交互中断后重跑安装器并跳过 AI 配置的恢复行为。 */
async function checkInterruptedResume(): Promise<void> {
  const fixture: InstallerFixture = await createFixture();
  mkdirSync(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME), { recursive: true });
  await writeText(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json"), validTelegram(), 0o600);
  const interrupted: InstallerRunResult = await runInstaller(fixture, [
    { prompt: "是否重新填写？", reply: "n" },
    { prompt: "现在配置 AI 能力", close: true },
  ]);
  assertCondition(interrupted.exitCode !== 0, "步骤 6 输入中断时安装器必须失败");
  assertCondition(
    !(await Bun.file(join(fixture.configRoot, DYNAMIC_CONFIG_DIR_NAME, "agent.json")).exists()),
    "步骤 6 中断不得物化 agent 示例"
  );

  const resumed: InstallerRunResult = await runInstaller(fixture, [
    { prompt: "是否重新填写？", reply: "n" },
    { prompt: "现在配置 AI 能力", reply: "n" },
    systemdPrompt(),
  ]);
  assertEqual(resumed.exitCode, 0, "中断后重跑并跳过 AI 配置必须成功");
  assertContains(resumed.output, "现在配置 AI 能力", "重跑必须进入 AI 配置步骤");
  assertCondition(
    !(await Bun.file(join(fixture.configRoot, DYNAMIC_CONFIG_DIR_NAME, "agent.json")).exists()),
    "跳过 AI 配置不得物化 agent 示例"
  );
  assertCondition(
    !(await Bun.file(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "g-auth.json")).exists()),
    "安装器不得物化翻译凭据示例"
  );
  assertCondition(
    !(await Bun.file(join(fixture.configRoot, DYNAMIC_CONFIG_DIR_NAME, "cron.json")).exists()),
    "安装器不得物化定时任务示例"
  );
}

/**
 * 校验重新填写 Telegram 配置时的原子替换、权限保留、建库与备份清理行为。
 *
 * @param atmosphere 初始配置的回复风格字段（可选）
 */
async function checkSuccessfulReplacement(atmosphere?: string): Promise<void> {
  const fixture: InstallerFixture = await createFixture();
  mkdirSync(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME), { recursive: true });
  const botConfigPath: string = join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json");
  await writeText(botConfigPath, JSON.stringify({
    bot_token: "123456789:existing_test_token", super_admin_user_id: 123456789, atmosphere, time_zone: "UTC",
  }), 0o640);
  const originalOwner: Stats = await Bun.file(botConfigPath).stat();
  const replacementToken: string = "987654321:replacement_test_token";
  const result: InstallerRunResult = await runInstaller(fixture, [
    { prompt: "是否重新填写？", reply: "y" },
    { prompt: "Telegram bot token", reply: replacementToken, secret: true },
    { prompt: "超级管理员用户 ID", reply: "987654321" },
    { prompt: "现在配置 AI 能力", reply: "n" },
    systemdPrompt(),
  ]);

  assertEqual(result.exitCode, 0, "Telegram 配置原子替换与后续核验必须成功");
  assertContains(await Bun.file(botConfigPath).text(), replacementToken, "提交后必须读取到完整新配置");
  const replacement: { atmosphere?: string; time_zone: string } = await Bun.file(botConfigPath).json() as { atmosphere?: string; time_zone: string };
  assertEqual(replacement.atmosphere, atmosphere, "重新填写身份必须保留显式风格或未配置状态");
  assertEqual(replacement.time_zone, "UTC", "重新填写身份必须保留配置时区");
  const replacementStats: Stats = await Bun.file(botConfigPath).stat();
  assertEqual(replacementStats.mode & 0o777, 0o640, "重新填写既有配置必须沿用原权限");
  assertEqual(replacementStats.uid, originalOwner.uid, "原子替换必须保持既有配置属主");
  assertEqual(replacementStats.gid, originalOwner.gid, "原子替换必须保持既有配置属组");
  const exampleMode: number = (await Bun.file(
    join(fixture.worktree, "config_example", DYNAMIC_CONFIG_DIR_NAME, "stickers.json")
  ).stat()).mode & 0o777;
  const deployedExampleMode: number = (await Bun.file(
    join(fixture.configRoot, DYNAMIC_CONFIG_DIR_NAME, "stickers.json")
  ).stat()).mode & 0o777;
  assertEqual(
    deployedExampleMode,
    exampleMode & (~0o022 & 0o777),
    "新建示例配置必须保持原有 cp 的权限语义"
  );
  assertCondition(!result.output.includes(replacementToken), "安装输出不得回显 Telegram token");
  const calls: string = await Bun.file(fixture.callLog).text();
  const outbound: string = await Bun.file(fixture.outboundLog).text();
  // scripts/install/start.sh 里的 chmod 对应 consts/identityStorage.ts 的权限
  // 常量：建库在夹具里由替身接管，收紧权限的 shell 语句照原样执行，这里核对落到
  // 磁盘的模式；目录带 setgid，按 0o7777 取位。
  assertContains(calls, "database:create", "全新部署必须走建库分支");
  const databaseDirectory: string = join(fixture.runtimeRoot, "database");
  assertEqual(
    (await Bun.file(databaseDirectory).stat()).mode & 0o7777,
    IDENTITY_DATABASE_DIRECTORY_MODE,
    "database/ 权限必须与 IDENTITY_DATABASE_DIRECTORY_MODE 一致"
  );
  assertEqual(
    (await Bun.file(join(databaseDirectory, "storage.sqlite")).stat()).mode & 0o777,
    IDENTITY_DATABASE_FILE_MODE,
    "storage.sqlite 权限必须与 IDENTITY_DATABASE_FILE_MODE 一致"
  );
  assertContains(calls, "systemctl-secret-env=absent", "必须实测 systemd 分支且环境不得含 AI 凭据");
  assertContains(outbound, "systemctl:guarded:start", "只能启动已确认停止的服务");
  assertEqual(readdirSync(fixture.backupRoot).length, 0, "稳定性核验通过后必须清理外部备份");
}

/** 校验首次填写 Telegram 配置（无文件或存在占位配置）时的交互与 0600 权限。 */
async function checkFirstFillMode(): Promise<void> {
  for (const placeholderMode of [undefined, 0o644]) {
    const fixture: InstallerFixture = await createFixture();
    const botConfigPath: string = join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json");
    if (placeholderMode !== undefined) {
      mkdirSync(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME), { recursive: true });
      await writeText(
        botConfigPath,
        await Bun.file(join(fixture.worktree, "config_example", STATIC_CONFIG_DIR_NAME, "bot.json")).text(),
        placeholderMode
      );
    }
    const result: InstallerRunResult = await runInstaller(fixture, [
      { prompt: "Telegram bot token", reply: "987654321:first_fill_test_token", secret: true },
      { prompt: "超级管理员用户 ID", reply: "987654321" },
      { prompt: "现在配置 AI 能力", reply: "n" },
      systemdPrompt(),
    ]);
    assertEqual(result.exitCode, 0, "首次填写 Telegram 配置必须成功");
    assertCondition(!result.output.includes("是否重新填写？"), "占位配置不得询问是否重新填写");
    assertEqual((await Bun.file(botConfigPath).stat()).mode & 0o777, 0o600, "首次填写的 Telegram 配置权限必须为 0600");
  }
}

/** 校验配置文件为软链接时原子替换保持软链接拓扑并更新真实目标文件。 */
async function checkSymlinkTopologyPreserved(): Promise<void> {
  const fixture: InstallerFixture = await createFixture();
  mkdirSync(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME), { recursive: true });
  const linkedDirectory: string = join(fixture.root, "linked-config");
  mkdirSync(linkedDirectory);
  const realBotConfigPath: string = join(linkedDirectory, "bot.json");
  const botConfigPath: string = join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json");
  await writeText(realBotConfigPath, validTelegram(), 0o640);
  symlinkSync(realBotConfigPath, botConfigPath);
  const replacementToken: string = "987654321:symlink_test_token";
  const result: InstallerRunResult = await runInstaller(fixture, [
    { prompt: "是否重新填写？", reply: "y" },
    { prompt: "Telegram bot token", reply: replacementToken, secret: true },
    { prompt: "超级管理员用户 ID", reply: "987654321" },
    { prompt: "现在配置 AI 能力", reply: "n" },
    systemdPrompt(),
  ]);

  assertEqual(result.exitCode, 0, "软链接配置的原子替换必须成功");
  assertCondition(lstatSync(botConfigPath).isSymbolicLink(), "配置软链接拓扑不得被替换");
  assertContains(await Bun.file(realBotConfigPath).text(), replacementToken, "软链接实际目标必须更新");
  assertEqual((await Bun.file(realBotConfigPath).stat()).mode & 0o777, 0o640, "软链接实际目标必须沿用原权限");
  assertCondition(
    !(await Bun.file(fixture.outboundLog).text()).includes(":blocked"),
    "软链接实测不得调用真实外部命令"
  );
}

/** 校验 journal 不可读导致稳定性无法确认时拒绝完成并保留外部备份。 */
async function checkUnverifiedJournalBackupRetention(): Promise<void> {
  const fixture: InstallerFixture = await createFixture();
  mkdirSync(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME), { recursive: true });
  const botConfigPath: string = join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json");
  await writeText(botConfigPath, validTelegram(), 0o600);
  const result: InstallerRunResult = await runInstaller(fixture, [
    { prompt: "是否重新填写？", reply: "y" },
    { prompt: "Telegram bot token", reply: "987654321:journal_test_token", secret: true },
    { prompt: "超级管理员用户 ID", reply: "987654321" },
    { prompt: "现在配置 AI 能力", reply: "n" },
    systemdPrompt(),
  ], { FAKE_JOURNAL_FAIL: "1" });

  assertCondition(result.exitCode !== 0, "journal 不可读时必须拒绝确认稳定");
  const calls: string = await Bun.file(fixture.callLog).text();
  assertContains(calls, "systemctl-secret-env=", "必须进入 systemd 分支");
  assertContains(result.output, "journal 未能核对", "journal 失败必须明确报告");
  assertEqual(readdirSync(fixture.backupRoot).length, 1, "journal 未确认时必须保留外部备份");
}

/** 校验 AI 凭据写入与后续子进程环境变量隔离、终端无回显及外部命令拦截。 */
async function checkCredentialIsolation(): Promise<void> {
  const fixture: InstallerFixture = await createFixture();
  mkdirSync(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME), { recursive: true });
  await writeText(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json"), validTelegram(), 0o600);
  const apiKey: string = "test key with spaces, quote-\" and 日本語";
  const result: InstallerRunResult = await runInstaller(fixture, [
    { prompt: "是否重新填写？", reply: "n" },
    { prompt: "现在配置 AI 能力", reply: "y" },
    { prompt: "配置 ad_detect？", reply: "y" },
    { prompt: "ad_detect 的 provider", reply: "openai" },
    { prompt: "ad_detect 的 api_key", reply: apiKey, secret: true },
    { prompt: "ad_detect 的 model", reply: "mock-model" },
    { prompt: "ad_detect 的 base_url", reply: "" },
    { prompt: "配置 text？", reply: "n" },
    { prompt: "配置 summary？", reply: "n" },
    { prompt: "配置 media？", reply: "n" },
    { prompt: "配置 image？", reply: "n" },
    { prompt: "配置 tts？", reply: "n" },
    { prompt: "配置 web_search？", reply: "n" },
    systemdPrompt(),
  ]);

  assertEqual(result.exitCode, 0, "包含特殊字符的 AI 凭据必须完成配置");
  const agentConfig: string = await Bun.file(join(fixture.configRoot, DYNAMIC_CONFIG_DIR_NAME, "agent.json")).text();
  assertContains(agentConfig, JSON.stringify(apiKey), "AI 凭据必须无损写入 JSON");
  const calls: string = await Bun.file(fixture.callLog).text();
  assertContains(calls, "generator-secret-env=absent", "生成器环境不得继承 AI 凭据");
  assertContains(calls, "validation-secret-env=absent", "校验器环境不得继承 AI 凭据");
  assertContains(calls, "systemctl-secret-env=absent", "必须实测 systemd 分支且环境不得继承 AI 凭据");
  assertCondition(!calls.includes("secret-env=present"), "任何后续子进程都不得继承 AI 凭据");
  assertCondition(!result.output.includes(apiKey), "安装输出不得回显 AI 凭据");
  assertCondition(
    !(await Bun.file(fixture.outboundLog).text()).includes(":blocked"),
    "安装实测不得调用网络、包管理器或提权命令"
  );
}

/** 校验安装测试夹具的所有子路径均位于独立专属临时根目录内。 */
async function checkFixtureRoots(): Promise<void> {
  const fixture: InstallerFixture = await createFixture();
  for (const path of [
    fixture.worktree,
    fixture.configRoot,
    fixture.backupRoot,
    fixture.runtimeRoot,
    fixture.binRoot,
    fixture.callLog,
    fixture.outboundLog,
  ]) {
    assertCondition(path.startsWith(fixture.root + "/"), "夹具路径必须位于独立临时根");
  }
  assertCondition(
    basename(fixture.root).startsWith("copy-ninjia-install-test-"),
    "夹具必须使用专属临时根前缀"
  );
}

try {
  await checkServiceProtection();
  await checkServiceDataRoot();
  await checkServiceObservation();
  await checkStagingPermissionFailureCleanup();
  await checkTelegramRollback();
  await checkInterruptedResume();
  for (const atmosphere of [undefined, "mesugaki", "normal"]) {
    await checkSuccessfulReplacement(atmosphere);
  }
  await checkFirstFillMode();
  await checkSymlinkTopologyPreserved();
  await checkUnverifiedJournalBackupRetention();
  await checkCredentialIsolation();
  await checkFixtureRoots();
  console.log("Install isolation check passed.");
} finally {
  cleanupFixtures();
}

/**
 * 安装器隔离测试夹具的受控命令行替身脚本安装与语法校验（bun、git 与系统/网络命令拦截）。
 */

import { chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runCapturedCommand } from "../fixtures/subprocess";
import type { CapturedCommandResult } from "../fixtures/subprocess";

/** 安装隔离夹具替身脚本所需的最小目录与版本参数。 */
export interface FixtureGuardOptions {
  /** 夹具独占的替身脚本 `bin/` 目录绝对路径。 */
  readonly binRoot: string;
  /** `package.json` 锁定的 Bun 版本号，供替身 `bun --version` 默认返回。 */
  readonly requiredBunVersion: string;
}

/**
 * 将脚本行拼接写入目标路径并赋予 0700 可执行权限。
 * @param path 目标脚本路径。
 * @param lines 脚本内容行列表。
 */
async function writeExecutable(path: string, lines: readonly string[]): Promise<void> {
  await Bun.write(path, lines.join("\n") + "\n");
  chmodSync(path, 0o700);
}

/**
 * 在测试夹具的 bin 目录下安装受控的 bun 替身脚本。
 * @param binRoot 夹具替身脚本目录路径。
 * @param requiredBunVersion 替身 `bun --version` 缺省返回的 Bun 版本号。
 */
async function installBunGuard(binRoot: string, requiredBunVersion: string): Promise<void> {
  await writeExecutable(join(binRoot, "bun"), [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "command_name=\"${1:-}\"",
    "inline_source=\"${2:-}\"",
    "secret_env_state() {",
    "  local label=\"$1\"",
    "  if env | grep -Eq '^CN_.*_API_KEY='; then",
    "    printf '%s-secret-env=present\\n' \"$label\" >> \"$FAKE_CALL_LOG\"",
    "  else",
    "    printf '%s-secret-env=absent\\n' \"$label\" >> \"$FAKE_CALL_LOG\"",
    "  fi",
    "}",
    "case \"$command_name\" in",
    "  --version)",
    `    printf '%s\\n' "\${FAKE_BUN_VERSION-${requiredBunVersion}}"`,
    "    exit 0",
    "    ;;",
    "  install)",
    "    printf 'bun:install\\n' >> \"$FAKE_CALL_LOG\"",
    "    exit 0",
    "    ;;",
    "  run)",
    "    if [ \"${2:-}\" = \"start\" ]; then",
    "      secret_env_state start",
    "      if [ \"$FAKE_REAL_RUNTIME\" = \"1\" ]; then",
    "        printf '%s\\n' 'preload = [\"./test/helpers/installedApplication.ts\"]' > bunfig.toml",
    "        runtime_status=0",
    "        \"$REAL_BUN_PATH\" run --no-orphans start || runtime_status=$?",
    "        rm -- bunfig.toml",
    "        exit \"$runtime_status\"",
    "      fi",
    "      exit 0",
    "    fi",
    "    ;;",
    "esac",
    "if [ \"$command_name\" != \"-e\" ]; then",
    "  printf 'bun:unexpected:%s\\n' \"$*\" >> \"$FAKE_CALL_LOG\"",
    "  exit 91",
    "fi",
    "if [ \"$FAKE_REAL_RUNTIME\" = \"1\" ]; then exec \"$REAL_BUN_PATH\" \"$@\"; fi",
    "if [[ \"$inline_source\" == *\"manifest?.packageManager\"* ]]; then",
    "  printf 'manifest:check\\n' >> \"$FAKE_CALL_LOG\"",
    "  exec \"$REAL_BUN_PATH\" \"$@\"",
    "fi",
    "if [[ \"$inline_source\" == *\"RestartUSec must\"* ]]; then exec \"$REAL_BUN_PATH\" \"$@\"; fi",
    "if [[ \"$inline_source\" == *\"systemd Environment property\"* ]]; then exec \"$REAL_BUN_PATH\" \"$@\"; fi",
    "if [[ \"$inline_source\" == *\"invalid agent config field stream\"* ]]; then",
    "  secret_env_state generator",
    "  exec \"$REAL_BUN_PATH\" \"$@\"",
    "fi",
    "if [[ \"$inline_source\" == *\"assertNoMisplacedConfigFiles\"* ]]; then",
    "  exec \"$REAL_BUN_PATH\" -e 'const runtime = await import(Bun.argv[1]); await runtime.assertNoMisplacedConfigFiles(\"config\");' \"$FAKE_INSTALL_RUNTIME_MODULE\"",
    "fi",
    "if [[ \"$inline_source\" == *\"assertStateFilesMigrated\"* ]]; then",
    "  COPY_NINJIA_DATA_ROOT=\"${COPY_NINJIA_DATA_ROOT:-$FAKE_RUNTIME_ROOT}\" exec \"$REAL_BUN_PATH\" -e 'const runtime = await import(Bun.argv[1]); await runtime.assertStateFilesMigrated();' \"$FAKE_INSTALL_RUNTIME_MODULE\"",
    "fi",
    "if [[ \"$inline_source\" == *\"assertStorageDatabaseMigrated\"* ]]; then",
    "  COPY_NINJIA_DATA_ROOT=\"${COPY_NINJIA_DATA_ROOT:-$FAKE_RUNTIME_ROOT}\" exec \"$REAL_BUN_PATH\" -e 'const runtime = await import(Bun.argv[1]); await runtime.assertStorageDatabaseMigrated();' \"$FAKE_INSTALL_RUNTIME_MODULE\"",
    "fi",
    "if [[ \"$inline_source\" == *\"assertWedMemberFilesMigrated\"* ]]; then",
    "  COPY_NINJIA_DATA_ROOT=\"${COPY_NINJIA_DATA_ROOT:-$FAKE_RUNTIME_ROOT}\" exec \"$REAL_BUN_PATH\" -e 'const runtime = await import(Bun.argv[1]); await runtime.assertWedMemberFilesMigrated();' \"$FAKE_INSTALL_RUNTIME_MODULE\"",
    "fi",
    "if [[ \"$inline_source\" == *\"assertStorageDatabaseTimeZone\"* ]]; then",
    "  COPY_NINJIA_DATA_ROOT=\"${COPY_NINJIA_DATA_ROOT:-$FAKE_RUNTIME_ROOT}\" exec \"$REAL_BUN_PATH\" -e 'const runtime = await import(Bun.argv[1]); const config = await runtime.loadInstallerBotConfig(\"config/static/bot.json\"); runtime.assertStorageDatabaseTimeZone(config.timeZone);' \"$FAKE_INSTALL_RUNTIME_MODULE\"",
    "fi",
    "if [[ \"$inline_source\" == *\"bootstrapStorageDatabase\"* ]]; then",
    "  mkdir -p -- \"$(dirname -- \"$FAKE_IDENTITY_DATABASE\")\"",
    "  : > \"$FAKE_IDENTITY_DATABASE\"",
    "  printf 'database:create\\n' >> \"$FAKE_CALL_LOG\"",
    "  exit 0",
    "fi",
    "if [[ \"$inline_source\" == *\"loadInstallerBotConfig\"* ]]; then",
    "  exec \"$REAL_BUN_PATH\" -e 'const runtime = await import(Bun.argv[1]); const config = await runtime.loadInstallerBotConfig(\"config/static/bot.json\"); console.log(config.atmosphere ?? \"\"); console.log(config.timeZone); console.log(config.logLevel);' \"$FAKE_INSTALL_RUNTIME_MODULE\"",
    "fi",
    "if [[ \"$inline_source\" == *\"carryOverMiniAppConfig\"* ]]; then",
    "  exec \"$REAL_BUN_PATH\" -e 'const runtime = await import(Bun.argv[1]); await runtime.carryOverMiniAppConfig(Bun.argv[2], Bun.argv[3]);' \"$FAKE_INSTALL_RUNTIME_MODULE\" \"${3:?}\" \"${4:?}\"",
    "fi",
    "if [[ \"$inline_source\" == *\"validateStagedBotConfig\"* ]]; then",
    "  printf 'validate:telegram\\n' >> \"$FAKE_CALL_LOG\"",
    "  [ \"${FAKE_TELEGRAM_VALIDATION_FAIL:-0}\" = \"1\" ] && exit 41",
    "  exec \"$REAL_BUN_PATH\" -e 'const runtime = await import(Bun.argv[1]); await runtime.validateStagedBotConfig(Bun.argv[2]);' \"$FAKE_INSTALL_RUNTIME_MODULE\" \"${3:?}\"",
    "fi",
    "if [[ \"$inline_source\" == *\"validateAgentDeploymentConfig\"* ]]; then",
    "  printf 'validate:agent\\n' >> \"$FAKE_CALL_LOG\"",
    "  exec \"$REAL_BUN_PATH\" -e 'const runtime = await import(Bun.argv[1]); await runtime.validateAgentDeploymentConfig(Bun.argv[2]);' \"$FAKE_INSTALL_RUNTIME_MODULE\" \"${3:?}\"",
    "fi",
    "if [[ \"$inline_source\" == *\"IDENTITY_DATABASE_PATH\"* ]]; then",
    "  printf '%s' \"$FAKE_IDENTITY_DATABASE\"",
    "  exit 0",
    "fi",
    "if [[ \"$inline_source\" == *\"RUNTIME_DATA_ROOT\"* ]]; then",
    "  exec \"$REAL_BUN_PATH\" -e 'const paths = await import(Bun.argv[1]); await Bun.write(Bun.stdout, paths.RUNTIME_DATA_ROOT);' \"$FAKE_PATHS_MODULE\"",
    "fi",
    "if [[ \"$inline_source\" == *\"validateExistingDeploymentInputs\"* ]]; then",
    "  secret_env_state validation",
    "  exit 0",
    "fi",
    "printf 'bun:unexpected-inline\\n' >> \"$FAKE_CALL_LOG\"",
    "exit 92",
  ]);
}

/**
 * 在测试夹具的 bin 目录下安装受控的 git 替身脚本。
 * @param binRoot 夹具替身脚本目录路径。
 */
async function installGitGuard(binRoot: string): Promise<void> {
  await writeExecutable(join(binRoot, "git"), [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "if [ \"${1:-}\" = \"describe\" ]; then printf 'test-fixture\\n'; exit 0; fi",
    "if [ \"${1:-}\" = \"-C\" ] && [ \"${3:-}\" = \"rev-parse\" ]; then",
    "  printf '%s\\n' \"$FAKE_WORKTREE\"",
    "  exit 0",
    "fi",
    "printf 'git:blocked:%s\\n' \"$*\" >> \"$FAKE_OUTBOUND_LOG\"",
    "exit 93",
  ]);
}

/**
 * 在测试夹具的 bin 目录下安装网络与系统管理命令（sudo、systemctl、journalctl 等）的拦截替身。
 * @param binRoot 夹具替身脚本目录路径。
 */
async function installSystemGuards(binRoot: string): Promise<void> {
  const blockedCommands: readonly string[] = [
    "curl", "apt-get", "dnf", "yum", "zypper", "pacman", "apk",
  ];
  for (const command of blockedCommands) {
    await writeExecutable(join(binRoot, command), [
      "#!/usr/bin/env bash",
      "printf '" + command + ":blocked\\n' >> \"$FAKE_OUTBOUND_LOG\"",
      "exit 94",
    ]);
  }
  await writeExecutable(join(binRoot, "sudo"), [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "case \"${1:-}\" in",
    "  systemctl|journalctl|tee)",
    "    guarded_command=\"$1\"",
    "    shift",
    "    exec \"$FAKE_BIN_ROOT/$guarded_command\" \"$@\"",
    "    ;;",
    "  chown|chmod)",
    "    privileged_command=\"$1\"",
    "    target_path=\"${@: -1}\"",
    "    case \"$target_path\" in",
    "      \"$FAKE_WORKTREE\"/config/static/.bot.json.install.*)",
    "        shift",
    "        exec \"/bin/$privileged_command\" \"$@\"",
    "        ;;",
    "    esac",
    "    ;;",
    "esac",
    "printf 'sudo:blocked:%s\\n' \"$*\" >> \"$FAKE_OUTBOUND_LOG\"",
    "exit 94",
  ]);
  await writeExecutable(join(binRoot, "id"), [
    "#!/usr/bin/env bash",
    "case \"${1:-}\" in",
    "  -u) printf '1000\\n' ;;",
    "  -un) printf 'fixture-user\\n' ;;",
    "  *) exit 95 ;;",
    "esac",
  ]);
  await writeExecutable(join(binRoot, "chmod"), [
    "#!/usr/bin/env bash",
    "if [ \"${FAKE_STAGING_CHMOD_FAIL:-0}\" = \"1\" ]; then",
    "  for argument in \"$@\"; do",
    "    case \"$argument\" in *.install.*) exit 44 ;; esac",
    "  done",
    "fi",
    "exec /bin/chmod \"$@\"",
  ]);
  await writeExecutable(join(binRoot, "cp"), [
    "#!/usr/bin/env bash",
    "if [ \"${FAKE_BACKUP_PRESERVE_FAIL:-0}\" = \"1\" ] && [ \"${1:-}\" = \"-p\" ]; then",
    "  printf 'cp-preserve=failure\\n' >> \"$FAKE_CALL_LOG\"",
    "  exit 45",
    "fi",
    "exec /bin/cp \"$@\"",
  ]);
  await writeExecutable(join(binRoot, "systemctl"), [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    "printf 'systemctl:guarded:%s\\n' \"$*\" >> \"$FAKE_OUTBOUND_LOG\"",
    "[ \"${FAKE_SYSTEMCTL_FAIL:-0}\" = 1 ] && exit 46",
    "case \"${1:-}\" in start|restart) rm -f -- \"$FAKE_RUNTIME_ROOT/service-observed\"; : > \"$FAKE_RUNTIME_ROOT/service-started\" ;; esac",
    "[ \"${1:-}\" != daemon-reload ] || : > \"$FAKE_BIN_ROOT/service-loaded\"",
    "if [ \"$FAKE_REAL_RUNTIME\" = \"1\" ]; then",
    "  case \"${1:-}\" in start|restart) exec \"$FAKE_BIN_ROOT/bun\" run start ;; esac",
    "fi",
    "if env | grep -Eq '^CN_.*_API_KEY='; then",
    "  printf 'systemctl-secret-env=present\\n' >> \"$FAKE_CALL_LOG\"",
    "else",
    "  printf 'systemctl-secret-env=absent\\n' >> \"$FAKE_CALL_LOG\"",
    "fi",
    "if [ \"${1:-}\" = \"show\" ]; then",
    "  case \"$*\" in",
    "    *LoadState*) if [ -e \"$FAKE_BIN_ROOT/service-loaded\" ]; then printf 'loaded\\n'; else printf '%s\\n' \"${FAKE_SERVICE_LOAD_STATE-loaded}\"; fi ;;",
    "    *ActiveState*) if [ -e \"$FAKE_RUNTIME_ROOT/service-started\" ]; then printf '%s\\n' \"${FAKE_STARTED_STATE-active}\"; else printf '%s\\n' \"${FAKE_SERVICE_STATE-inactive}\"; fi ;;",
    "    *SubState*) if [ -e \"$FAKE_RUNTIME_ROOT/service-started\" ]; then printf 'running\\n'; else printf 'dead\\n'; fi ;;",
    "    *EnvironmentFiles*) printf '%s\\n' \"${FAKE_SERVICE_ENVIRONMENT_FILES-}\" ;;",
    "    *PassEnvironment*) printf '%s\\n' \"${FAKE_SERVICE_PASS_ENVIRONMENT-}\" ;;",
    "    *UnsetEnvironment*) printf '%s\\n' \"${FAKE_SERVICE_UNSET_ENVIRONMENT-}\" ;;",
    "    *Environment*) printf '%s\\n' \"${FAKE_SERVICE_ENVIRONMENT-COPY_NINJIA_DATA_ROOT=$FAKE_RUNTIME_ROOT}\" ;;",
    "    *NRestarts*)",
    "      if [ -e \"$FAKE_RUNTIME_ROOT/service-observed\" ]; then printf '%s\\n' \"${FAKE_RESTARTS_AFTER-${FAKE_RESTARTS_STARTED-0}}\";",
    "      elif [ -e \"$FAKE_RUNTIME_ROOT/service-started\" ]; then printf '%s\\n' \"${FAKE_RESTARTS_STARTED-0}\";",
    "      elif [ \"${FAKE_SERVICE_LOAD_STATE-loaded}\" = not-found ] && [ ! -e \"$FAKE_BIN_ROOT/service-loaded\" ]; then printf '\\n';",
    "      else printf '%s\\n' \"${FAKE_RESTARTS_BEFORE-0}\"; fi ;;",
    "    *WorkingDirectory*) printf '%s\\n' \"${FAKE_SERVICE_WORKDIR-$FAKE_WORKTREE}\" ;;",
    "    *ExecStart*) printf '%s\\n' \"${FAKE_SERVICE_ENTRY-{ path=/guarded/bun ; argv[]=/guarded/bun start ; ignore_errors=no ; }}\" ;;",
    "    *RestartUSec*) printf '%s\\n' \"${FAKE_RESTART_INTERVAL-5s}\" ;;",
    "    *RestartSteps*) printf '%s\\n' \"${FAKE_RESTART_STEPS-0}\" ;;",
    "    *RestartMaxDelayUSec*) printf '%s\\n' \"${FAKE_RESTART_MAX-infinity}\" ;;",
    "    *RestartRandomizedDelayUSec*) printf '%s\\n' \"${FAKE_RESTART_RANDOMIZED-}\" ;;",
    "  esac",
    "fi",
    "exit 0",
  ]);
  await writeExecutable(join(binRoot, "journalctl"), [
    "#!/usr/bin/env bash",
    "[ \"${FAKE_JOURNAL_FAIL:-0}\" = \"1\" ] && exit 43",
    "printf 'journalctl:guarded\\n' >> \"$FAKE_OUTBOUND_LOG\"",
    "case \"$*\" in *--show-cursor*) printf -- '-- cursor: fixture-cursor\\n' ;; esac",
    "printf '%s\\n' \"${FAKE_JOURNAL_BODY-}\"",
  ]);
  await writeExecutable(join(binRoot, "tee"), [
    "#!/usr/bin/env bash",
    "printf 'tee:guarded\\n' >> \"$FAKE_OUTBOUND_LOG\"",
    "while IFS= read -r _; do :; done",
  ]);
  await writeExecutable(join(binRoot, "sleep"), [
    "#!/usr/bin/env bash",
    "printf 'sleep:guarded:%s\\n' \"$*\" >> \"$FAKE_OUTBOUND_LOG\"",
    ": > \"$FAKE_RUNTIME_ROOT/service-observed\"",
  ]);
}

let guardScriptsValidated: boolean = false;

/**
 * 使用 `bash -n` 校验测试夹具 bin 目录下所有替身脚本的语法。
 * 替身脚本模板在进程生命周期内固定不变，首次创建夹具时完成全量校验即可。
 * @param binRoot 夹具替身脚本目录路径。
 */
async function validateGuardScripts(binRoot: string): Promise<void> {
  if (guardScriptsValidated) return;
  for (const name of readdirSync(binRoot)) {
    const path: string = join(binRoot, name);
    const result: CapturedCommandResult = await runCapturedCommand({ cmd: ["/bin/bash", "-n", path] });
    if (result.exitCode !== 0) {
      throw new Error(`invalid guard ${name}: ${result.stderr}`);
    }
  }
  guardScriptsValidated = true;
}

/**
 * 在夹具 `binRoot` 下安装全部受控命令行替身脚本并首次校验其 bash 语法。
 * @param options 夹具 `binRoot` 与默认 Bun 版本号。
 */
export async function installFixtureGuards({
  binRoot,
  requiredBunVersion,
}: FixtureGuardOptions): Promise<void> {
  await installBunGuard(binRoot, requiredBunVersion);
  await installGitGuard(binRoot);
  await installSystemGuards(binRoot);
  await validateGuardScripts(binRoot);
}

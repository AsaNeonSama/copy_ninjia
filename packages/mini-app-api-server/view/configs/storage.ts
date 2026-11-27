import { deploymentConfigWriteChainHolder } from "../../../cache/main/configWrite";
import { miniAppServiceRestartRunnerHolder } from "../../../cache/main/miniApp";
import { deploymentInputExists } from "../../../config/readiness";
import {
  MINI_APP_CONFIG_DEFAULT_FILE_MODE,
  MINI_APP_DYNAMIC_CONFIG_FILES,
  MINI_APP_SERVICE_RESTART_COMMAND,
  MINI_APP_SERVICE_RESTART_STDERR_MAX_BYTES,
  MINI_APP_SERVICE_RESTART_TIMEOUT_MS,
  MINI_APP_STATIC_CONFIG_FILES,
} from "../../../consts/miniAppConfig";
import {
  MINI_APP_CONFIG_VALIDATION_FAILED_CODE,
  MINI_APP_INVALID_CONFIG_TARGET_CODE,
  MINI_APP_SERVICE_RESTART_FAILED_CODE,
} from "../../../consts/miniAppCrypto";
import { atomicWriteText } from "../../../libs/atomicFile";
import { readBoundedResponseText } from "../../../libs/boundedResponse";
import { errorMessage } from "../../../libs/errorMessage";
import { inspectOptionalFile } from "../../../libs/fileAccess";
import { readOptionalRegularTextInput } from "../../../libs/inputValidation";
import { hasExactKeys, isPlainRecord } from "../../../libs/record";
import { runSerialChain } from "../../../libs/serialChain";
import type {
  MiniAppConfigFileItem,
  MiniAppConfigFileResponse,
  MiniAppConfigListResponse,
  MiniAppConfigRestartResponse,
  MiniAppConfigSaveResponse,
  MiniAppServiceRestartResult,
  MiniAppServiceRestartRunner,
} from "../../../types/miniApp/configs";
import {
  resolveMiniAppConfigTarget,
  validateMiniAppConfigContent,
} from "./validate";
import type {
  MiniAppConfigContentValidationResult,
  ResolvedMiniAppConfigTarget,
} from "./validate";

/**
 * 列出 `config/dynamic/` 与 `config/static/` 白名单内全部配置文件及其在磁盘上的存在状态。
 * @returns 动态与静态配置文件列表响应。
 */
export async function listMiniAppConfigFiles(): Promise<
  Readonly<MiniAppConfigListResponse>
> {
  const dynamicFiles: Readonly<MiniAppConfigFileItem>[] = [];
  for (const fileName of MINI_APP_DYNAMIC_CONFIG_FILES) {
    const target: Readonly<ResolvedMiniAppConfigTarget> =
      resolveMiniAppConfigTarget("dynamic", fileName)!;
    const exists: boolean = await deploymentInputExists(target.targetPath);
    dynamicFiles.push({
      scope: "dynamic",
      fileName,
      exists,
    });
  }

  const staticFiles: Readonly<MiniAppConfigFileItem>[] = [];
  for (const fileName of MINI_APP_STATIC_CONFIG_FILES) {
    const target: Readonly<ResolvedMiniAppConfigTarget> =
      resolveMiniAppConfigTarget("static", fileName)!;
    const exists: boolean = await deploymentInputExists(target.targetPath);
    staticFiles.push({
      scope: "static",
      fileName,
      exists,
    });
  }

  return {
    ok: true,
    dynamicFiles,
    staticFiles,
  };
}

/**
 * 按白名单读取单份动态或静态部署配置文件的原始 UTF-8 文本；尚不存在的可选文件返回 `exists: false, content: ""`。
 * @param scope 查询参数中的配置目录作用域。
 * @param fileName 查询参数中的配置文件名。
 * @returns 单份配置文件内容或目标/读取错误响应。
 */
export async function readMiniAppConfigFile(
  scope: string | null,
  fileName: string | null
): Promise<Readonly<MiniAppConfigFileResponse>> {
  const target: Readonly<ResolvedMiniAppConfigTarget> | null =
    resolveMiniAppConfigTarget(scope, fileName);
  if (target === null) {
    return {
      ok: false,
      code: MINI_APP_INVALID_CONFIG_TARGET_CODE,
      error: MINI_APP_INVALID_CONFIG_TARGET_CODE,
    };
  }
  try {
    const content: string | null = await readOptionalRegularTextInput(
      target.targetPath
    );
    return {
      ok: true,
      scope: target.scope,
      fileName: target.fileName,
      exists: content !== null,
      content: content ?? "",
    };
  } catch (error: unknown) {
    return {
      ok: false,
      scope: target.scope,
      fileName: target.fileName,
      code: MINI_APP_CONFIG_VALIDATION_FAILED_CODE,
      error: errorMessage(error),
    };
  }
}

/**
 * 对经会话 256-bit 临时密钥解密后的配置保存请求体执行完整语法与严格字段校验，并原子写入目标配置文件。
 * 校验与落盘整体通过 `runSerialChain` 进入主线程单链串行执行，避免并发保存关联配置时的跨文件校验 TOCTOU 竞态。
 * 动态配置文件落盘至 `DYNAMIC_CONFIG_DIR` 后由目录级 `fs.watch` 热重载协调器感知并重载。
 * @param body 会话密钥解密后的 JSON 请求体对象（期望 `{ scope, fileName, content }`）。
 * @returns 保存结果响应（含静态配置 `requiresRestart: true` 标记或具体错误码）。
 */
export async function saveMiniAppConfigFile(
  body: Readonly<Record<string, unknown>> | null
): Promise<Readonly<MiniAppConfigSaveResponse>> {
  if (
    body === null ||
    !isPlainRecord(body) ||
    !hasExactKeys(body, ["scope", "fileName", "content"]) ||
    typeof body.content !== "string"
  ) {
    return {
      ok: false,
      code: MINI_APP_INVALID_CONFIG_TARGET_CODE,
      error: MINI_APP_INVALID_CONFIG_TARGET_CODE,
    };
  }

  const target: Readonly<ResolvedMiniAppConfigTarget> | null =
    resolveMiniAppConfigTarget(body.scope, body.fileName);
  if (target === null) {
    return {
      ok: false,
      code: MINI_APP_INVALID_CONFIG_TARGET_CODE,
      error: MINI_APP_INVALID_CONFIG_TARGET_CODE,
    };
  }

  const rawContent: string = body.content;
  return runSerialChain(
    deploymentConfigWriteChainHolder,
    async (): Promise<Readonly<MiniAppConfigSaveResponse>> => {
      const validation: Readonly<MiniAppConfigContentValidationResult> =
        await validateMiniAppConfigContent(target, rawContent);
      if (!validation.ok) {
        return {
          ok: false,
          scope: target.scope,
          fileName: target.fileName,
          code: validation.code,
          error: validation.error,
        };
      }

      try {
        inspectOptionalFile(target.targetPath);
        await atomicWriteText(
          target.targetPath,
          validation.normalizedText,
          MINI_APP_CONFIG_DEFAULT_FILE_MODE
        );
      } catch (error: unknown) {
        return {
          ok: false,
          scope: target.scope,
          fileName: target.fileName,
          code: MINI_APP_CONFIG_VALIDATION_FAILED_CODE,
          error: errorMessage(error),
        };
      }

      return {
        ok: true,
        scope: target.scope,
        fileName: target.fileName,
        requiresRestart: target.scope === "static",
      };
    }
  );
}

/**
 * 默认的宿主 systemd 服务重启执行器：通过 `Bun.spawn` 调用 `systemctl restart --no-block copy-ninjia` 入队重启任务。
 * @returns 重启命令退出结果。
 */
async function runSystemctlRestartCopyNinjia(): Promise<
  Readonly<MiniAppServiceRestartResult>
> {
  let subprocess: Bun.Subprocess<"ignore", "ignore", "pipe"> | null = null;
  try {
    subprocess = Bun.spawn({
      cmd: [...MINI_APP_SERVICE_RESTART_COMMAND],
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      timeout: MINI_APP_SERVICE_RESTART_TIMEOUT_MS,
    });
    const stderrText: string | null = await readBoundedResponseText(
      new Response(subprocess.stderr),
      MINI_APP_SERVICE_RESTART_STDERR_MAX_BYTES
    );
    const exitCode: number = await subprocess.exited;
    if (exitCode === 0) {
      return { ok: true };
    }
    const detail: string = stderrText?.trim() ?? "";
    return {
      ok: false,
      error:
        detail.length > 0
          ? detail
          : `systemctl exited with code ${exitCode}.`,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      error: errorMessage(error),
    };
  } finally {
    if (
      subprocess !== null &&
      subprocess.exitCode === null &&
      subprocess.signalCode === null
    ) {
      subprocess.kill();
    }
  }
}

/**
 * 触发宿主 systemd 重启当前项目服务（测试环境通过 `miniAppServiceRestartRunnerHolder` 注入替身）。
 * @returns 面向 Mini App 前端的重启结果响应。
 */
export async function restartMiniAppService(): Promise<
  Readonly<MiniAppConfigRestartResponse>
> {
  const runner: MiniAppServiceRestartRunner =
    miniAppServiceRestartRunnerHolder.current ?? runSystemctlRestartCopyNinjia;
  try {
    const result: Readonly<MiniAppServiceRestartResult> = await runner();
    if (result.ok) {
      return { ok: true };
    }
    return {
      ok: false,
      code: MINI_APP_SERVICE_RESTART_FAILED_CODE,
      error: result.error,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      code: MINI_APP_SERVICE_RESTART_FAILED_CODE,
      error: errorMessage(error),
    };
  }
}

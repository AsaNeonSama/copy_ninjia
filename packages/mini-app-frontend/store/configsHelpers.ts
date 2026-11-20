import { classifyMiniAppAuthError } from "../api/authError";
import type { MiniAppAuthErrorAction } from "../api/authError";
import {
  MINI_APP_DYNAMIC_CONFIG_FILES,
  MINI_APP_STATIC_CONFIG_FILES,
} from "../consts/miniAppConfig";
import { extractServerNoticeParams } from "../i18n";
import type { MiniAppTranslations } from "../i18n";
import { errorMessage } from "../libs/errorMessage";
import { asPayloadRecord } from "../libs/record";
import type {
  MiniAppConfigFileItem,
  MiniAppConfigFileName,
  MiniAppConfigFileResponse,
  MiniAppConfigListResponse,
  MiniAppConfigScope,
  MiniAppDynamicConfigFileName,
  MiniAppStaticConfigFileName,
} from "../types/miniAppConfigs";
import { useMiniAppStore } from "./app";
import type { MiniAppConfigsStoreState } from "./configs";

/**
 * 判断配置编辑页当前是否有保存、重启、还原或格式化等写/长耗时动作在途。
 *
 * @param state 配置仓库动作标志切片
 * @returns 任意互斥动作在进行中时返回 `true`
 */
export function isConfigActionInFlight(
  state: Pick<
    MiniAppConfigsStoreState,
    "saving" | "restarting" | "resetting" | "formatting"
  >
): boolean {
  return state.saving || state.restarting || state.resetting || state.formatting;
}

/**
 * 判断配置文件名是否属于动态热重载配置白名单。
 *
 * @param fileName 待检查文件名
 * @returns 属于动态配置时返回 `true`
 */
export function isDynamicConfigFileName(
  fileName: MiniAppConfigFileName
): fileName is MiniAppDynamicConfigFileName {
  return (MINI_APP_DYNAMIC_CONFIG_FILES as readonly string[]).includes(fileName);
}

/**
 * 判断配置文件名是否属于静态启动配置白名单。
 *
 * @param fileName 待检查文件名
 * @returns 属于静态配置时返回 `true`
 */
export function isStaticConfigFileName(
  fileName: MiniAppConfigFileName
): fileName is MiniAppStaticConfigFileName {
  return (MINI_APP_STATIC_CONFIG_FILES as readonly string[]).includes(fileName);
}

/**
 * 根据分组与文件名常量表生成初始配置文件条目列表。
 *
 * @param scope 配置目录分类
 * @param files 配置文件名只读数组
 * @returns 默认标记 `exists: true` 的条目列表
 */
export function buildInitialConfigItems(
  scope: MiniAppConfigScope,
  files: readonly MiniAppConfigFileName[]
): readonly Readonly<MiniAppConfigFileItem>[] {
  return files.map(
    (fileName: MiniAppConfigFileName): Readonly<MiniAppConfigFileItem> => ({
      scope,
      fileName,
      exists: true,
    })
  );
}

/**
 * 将指定配置文件在目录列表中的 `exists` 状态更新为最新布尔值。
 *
 * @param items 原条目列表
 * @param targetFile 目标配置文件名
 * @param exists 最新存在状态
 * @returns 更新后的只读条目列表
 */
export function updateConfigItemExists(
  items: readonly Readonly<MiniAppConfigFileItem>[],
  targetFile: MiniAppConfigFileName,
  exists: boolean
): readonly Readonly<MiniAppConfigFileItem>[] {
  return items.map(
    (item: Readonly<MiniAppConfigFileItem>): Readonly<MiniAppConfigFileItem> =>
      item.fileName === targetFile
        ? { scope: item.scope, fileName: item.fileName, exists }
        : item
  );
}

/**
 * 从捕获的异常对象与回退错误消息中解析本地化的配置操作错误文案。
 *
 * @param error 捕获到的异常
 * @param t 当前语言翻译字典
 * @param fileName 可选关联的配置文件名
 * @returns 本地化后的诊断错误文案
 */
export function localizeCaughtConfigError(
  error: unknown,
  t: Readonly<MiniAppTranslations>,
  fileName?: MiniAppConfigFileName
): string {
  const rawMessage: string = errorMessage(error);
  const causeRecord: Record<string, unknown> = asPayloadRecord(
    error instanceof Error ? error.cause : undefined
  );
  const baseParams: ReturnType<typeof extractServerNoticeParams> =
    extractServerNoticeParams(error);
  const mergedParams: Readonly<{
    readonly fileName?: string;
    readonly errorDetail?: string;
  }> = {
    ...baseParams,
    ...(fileName !== undefined ? { fileName } : {}),
    errorDetail:
      typeof causeRecord.error === "string" && causeRecord.error.trim().length > 0
        ? causeRecord.error.trim()
        : rawMessage,
  };
  const codeText: string =
    typeof causeRecord.code === "string" ? causeRecord.code.trim() : "";
  if (codeText.length > 0) {
    const byCode: string = t.serverNotice(codeText, mergedParams);
    if (byCode !== codeText) {
      return byCode;
    }
  }
  return t.serverNotice(rawMessage, mergedParams);
}

/**
 * 检查并发拉取配置目录与文件内容两个 settled 结果中是否存在鉴权失效、密钥吊销或门禁拒绝异常；
 * 优先派发 `"accessDenied"` 级别拒绝，其次派发 `"reauth"` 级别重认证，命中时立即通知根仓库并返回 `true`。
 *
 * @param listSettled 配置目录请求的结算结果
 * @param fileSettled 配置文件请求的结算结果
 * @returns 存在并已派发鉴权类异常时返回 `true`
 */
export function notifySettledConfigAuthError(
  listSettled: PromiseSettledResult<MiniAppConfigListResponse>,
  fileSettled: PromiseSettledResult<MiniAppConfigFileResponse>
): boolean {
  const listError: unknown =
    listSettled.status === "rejected" ? listSettled.reason : null;
  const fileError: unknown =
    fileSettled.status === "rejected" ? fileSettled.reason : null;
  const listAction: MiniAppAuthErrorAction | null =
    listError !== null
      ? classifyMiniAppAuthError(errorMessage(listError), listError)
      : null;
  const fileAction: MiniAppAuthErrorAction | null =
    fileError !== null
      ? classifyMiniAppAuthError(errorMessage(fileError), fileError)
      : null;
  const chosenError: unknown =
    listAction === "accessDenied"
      ? listError
      : fileAction === "accessDenied"
        ? fileError
        : fileAction !== null
          ? fileError
          : listAction !== null
            ? listError
            : null;
  if (chosenError === null) {
    return false;
  }
  useMiniAppStore
    .getState()
    .notify(errorMessage(chosenError), "info", chosenError);
  return true;
}

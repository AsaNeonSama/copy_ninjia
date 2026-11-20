import { assetConfigCache } from "../../../cache/main/assets";
import { cronConfigCache } from "../../../cache/main/cron";
import { parseAdDetectConfig } from "../../../config/adDetectConfig";
import {
  agentDeploymentConfigSnapshot,
  loadAgentConfigSnapshots,
  parseAgentConfigSnapshots,
} from "../../../config/agent";
import {
  parseAssetConfig,
  verifyDefaultAvatarFile,
} from "../../../config/assets";
import { parseBotConfig } from "../../../config/botInput";
import {
  assertCronAgentSupported,
  cronAgentShortfall,
  loadCronConfig,
  parseCronConfig,
  verifyCronConfigLocalSources,
} from "../../../config/cron";
import { parseGoogleServiceAccountKey } from "../../../config/googleAuth";
import { parseMoodConfig } from "../../../config/mood";
import { deploymentInputExists } from "../../../config/readiness";
import { parseStickerConfig } from "../../../config/stickers";
import { getTimeZone } from "../../../config/time";
import { MINI_APP_MAX_CONFIG_CONTENT_BYTES } from "../../../consts/miniAppConfig";
import {
  MINI_APP_CONFIG_VALIDATION_FAILED_CODE,
  MINI_APP_INVALID_JSON_SYNTAX_CODE,
} from "../../../consts/miniAppCrypto";
import {
  AD_DETECT_CONFIG_PATH,
  AGENT_CONFIG_PATH,
  ASSETS_CONFIG_PATH,
  BOT_CONFIG_PATH,
  CRON_CONFIG_PATH,
  GOOGLE_AUTH_FILE_PATH,
  IDENTITY_DATABASE_PATH,
  MOOD_CONFIG_PATH,
  STICKERS_CONFIG_PATH,
} from "../../../consts/paths";
import { inspectRandomImageDirectory } from "../../../infra/imageGallery";
import { errorMessage } from "../../../libs/errorMessage";
import {
  InputValidationError,
  invalidInput,
  parseJsonInput,
} from "../../../libs/inputValidation";
import type {
  AgentConfigSnapshots,
  AgentDeploymentConfig,
  AssetConfig,
  BotConfig,
} from "../../../types/config";
import type { CronAgentShortfall, CronConfig } from "../../../types/cron";
import type {
  MiniAppConfigFileName,
  MiniAppConfigScope,
} from "../../../types/miniApp/configs";

/** 已通过严格白名单映射的部署配置文件目标描述符。 */
export interface ResolvedMiniAppConfigTarget {
  /** 配置目录作用域（`"dynamic"` 或 `"static"`）。 */
  readonly scope: MiniAppConfigScope;
  /** 白名单配置文件名。 */
  readonly fileName: MiniAppConfigFileName;
  /** 对应的真实部署配置文件绝对路径（来自 `packages/consts/paths.ts`）。 */
  readonly targetPath: string;
}

/** 部署配置文件文本语法、字段白名单与跨文件依赖校验结果。 */
export type MiniAppConfigContentValidationResult =
  | { readonly ok: true; readonly normalizedText: string }
  | { readonly ok: false; readonly code: string; readonly error: string };

/**
 * 将请求携带的 `(scope, fileName)` 严格映射到 `packages/consts/paths.ts` 中的固定部署配置文件路径；
 * 非字符串、含路径分隔符或不在动态/静态文件白名单闭集内的输入一律返回 `null`。
 * @param scope 候选配置目录作用域。
 * @param fileName 候选配置文件名。
 * @returns 白名单命中时返回目标描述符，否则返回 `null`。
 */
export function resolveMiniAppConfigTarget(
  scope: unknown,
  fileName: unknown
): Readonly<ResolvedMiniAppConfigTarget> | null {
  if (typeof scope !== "string" || typeof fileName !== "string") {
    return null;
  }
  if (scope === "dynamic") {
    switch (fileName) {
      case "ad_detect.json":
        return { scope, fileName, targetPath: AD_DETECT_CONFIG_PATH };
      case "agent.json":
        return { scope, fileName, targetPath: AGENT_CONFIG_PATH };
      case "assets.json":
        return { scope, fileName, targetPath: ASSETS_CONFIG_PATH };
      case "cron.json":
        return { scope, fileName, targetPath: CRON_CONFIG_PATH };
      case "mood.json":
        return { scope, fileName, targetPath: MOOD_CONFIG_PATH };
      case "stickers.json":
        return { scope, fileName, targetPath: STICKERS_CONFIG_PATH };
      default:
        return null;
    }
  }
  if (scope === "static") {
    switch (fileName) {
      case "bot.json":
        return { scope, fileName, targetPath: BOT_CONFIG_PATH };
      case "g-auth.json":
        return { scope, fileName, targetPath: GOOGLE_AUTH_FILE_PATH };
      default:
        return null;
    }
  }
  return null;
}

/**
 * 读取当前用于与 `agent.json` 交叉校验的生效定时任务表：优先加载磁盘上的 `CRON_CONFIG_PATH`（覆盖 `fs.watch` 防抖窗口内刚保存的新配置），
 * 文件不存在或读取失败时回退到主线程 `cronConfigCache.current`。
 * @returns 待核对的定时任务配置或 `null`。
 */
async function resolveEffectiveCronForAgentValidation(): Promise<CronConfig | null> {
  try {
    if (await deploymentInputExists(CRON_CONFIG_PATH)) {
      return await loadCronConfig();
    }
  } catch (_error: unknown) {
    return cronConfigCache.current;
  }
  return cronConfigCache.current;
}

/**
 * 读取当前用于与 `cron.json` 交叉校验的生效 AI 对话配置：优先加载磁盘上的 `AGENT_CONFIG_PATH`（覆盖 `fs.watch` 防抖窗口内刚保存的新配置），
 * 文件不存在或读取失败时回退到主线程 `agentDeploymentConfigSnapshot()`。
 * @returns 待核对的 AI 对话能力配置或 `null`。
 */
async function resolveEffectiveAgentForCronValidation(): Promise<
  Readonly<AgentDeploymentConfig> | null
> {
  try {
    if (await deploymentInputExists(AGENT_CONFIG_PATH)) {
      return (await loadAgentConfigSnapshots(AGENT_CONFIG_PATH)).agent;
    }
  } catch (_error: unknown) {
    return agentDeploymentConfigSnapshot();
  }
  return agentDeploymentConfigSnapshot();
}

/**
 * 按目标配置文件的严格 Schema、顶层/嵌套字段白名单及跨文件依赖核验已解析的 JSON 值；
 * 不合法时抛出 `InputValidationError`（绝不调用 `process.exit` 或回显敏感字段值）。
 * @param target 已通过白名单映射的部署配置文件目标。
 * @param parsed `JSON.parse` 解码得到的未知值。
 */
async function assertParsedMiniAppConfigValid(
  target: Readonly<ResolvedMiniAppConfigTarget>,
  parsed: unknown
): Promise<void> {
  switch (target.fileName) {
    case "ad_detect.json": {
      parseAdDetectConfig(parsed, target.targetPath);
      return;
    }
    case "agent.json": {
      const snapshots: AgentConfigSnapshots = parseAgentConfigSnapshots(
        parsed,
        target.targetPath
      );
      const effectiveCron: CronConfig | null =
        await resolveEffectiveCronForAgentValidation();
      if (effectiveCron !== null) {
        const shortfall: CronAgentShortfall | null = cronAgentShortfall(
          effectiveCron,
          snapshots.agent
        );
        if (shortfall !== null) {
          invalidInput(
            target.targetPath,
            "$.agent",
            shortfall.need === "tts"
              ? "configured with text, summary, media and tts while config/dynamic/cron.json uses send_voice"
              : "configured with text, summary and media while config/dynamic/cron.json uses send_web_digest"
          );
        }
      }
      return;
    }
    case "assets.json": {
      const assetConfig: AssetConfig = parseAssetConfig(
        parsed,
        target.targetPath
      );
      if (assetConfig.botDefaultAvatar.kind === "path") {
        await verifyDefaultAvatarFile(
          assetConfig.botDefaultAvatar.path,
          target.targetPath
        );
      }
      if (
        assetConfig.randomHImageDirectory !==
        assetConfigCache.current.randomHImageDirectory
      ) {
        await inspectRandomImageDirectory(
          assetConfig.randomHImageDirectory
        );
      }
      return;
    }
    case "cron.json": {
      const cronConfig: CronConfig = parseCronConfig(parsed, target.targetPath);
      await verifyCronConfigLocalSources(cronConfig, target.targetPath);
      assertCronAgentSupported(
        cronConfig,
        await resolveEffectiveAgentForCronValidation(),
        target.targetPath
      );
      return;
    }
    case "mood.json": {
      parseMoodConfig(parsed, target.targetPath);
      return;
    }
    case "stickers.json": {
      parseStickerConfig(parsed, target.targetPath);
      return;
    }
    case "bot.json": {
      const botConfig: BotConfig = parseBotConfig(parsed, target.targetPath);
      if (
        (await deploymentInputExists(IDENTITY_DATABASE_PATH)) &&
        botConfig.timeZone !== getTimeZone()
      ) {
        invalidInput(
          target.targetPath,
          "$.time_zone",
          `unchanged from the initialized identity database time zone (${getTimeZone()})`
        );
      }
      return;
    }
    case "g-auth.json": {
      parseGoogleServiceAccountKey(parsed, target.targetPath);
    }
  }
}

/**
 * 校验待保存的部署配置文件文本：依次检查 UTF-8 字节上限、JSON 语法合法性与对应文件的严格 Schema 及字段白名单。
 * @param target 已通过白名单映射的部署配置文件目标。
 * @param rawContent 经一次性 256-bit 密钥解密还原的原始配置文本。
 * @returns 校验通过时返回带末尾换行的规范化文本；失败时返回错误码与不含敏感值的安全诊断。
 */
export async function validateMiniAppConfigContent(
  target: Readonly<ResolvedMiniAppConfigTarget>,
  rawContent: string
): Promise<Readonly<MiniAppConfigContentValidationResult>> {
  if (
    Buffer.byteLength(rawContent, "utf8") > MINI_APP_MAX_CONFIG_CONTENT_BYTES
  ) {
    return {
      ok: false,
      code: MINI_APP_CONFIG_VALIDATION_FAILED_CODE,
      error: new InputValidationError(
        target.targetPath,
        "$",
        `at most ${MINI_APP_MAX_CONFIG_CONTENT_BYTES} UTF-8 bytes`
      ).message,
    };
  }

  let parsed: unknown;
  try {
    parsed = parseJsonInput(rawContent, target.targetPath);
  } catch (error: unknown) {
    return {
      ok: false,
      code: MINI_APP_INVALID_JSON_SYNTAX_CODE,
      error: errorMessage(error),
    };
  }

  try {
    await assertParsedMiniAppConfigValid(target, parsed);
  } catch (error: unknown) {
    return {
      ok: false,
      code: MINI_APP_CONFIG_VALIDATION_FAILED_CODE,
      error:
        error instanceof InputValidationError
          ? error.message
          : errorMessage(error),
    };
  }

  return {
    ok: true,
    normalizedText: `${rawContent.trim()}\n`,
  };
}

import { activeVerificationSnapshots } from "../cache/main/antiRaid/verificationMirror";
import { cronConfigCache } from "../cache/main/cron";
import { activeGagSessionCount } from "../cache/main/gag";
import { qaFormSessions } from "../cache/main/qa";
import { wedChats } from "../cache/main/wed";
import {
  defaultMoodConfigCache,
  defaultStickerConfigCache,
} from "../cache/perThread/config";
import { getAdDetectAgentConfig, getAgentDeploymentConfig } from "../config/agent";
import {
  adDetectConfigReadiness,
  aiChatConfigReadiness,
  translateConfigReadiness,
} from "../config/readiness";
import { TELEGRAM_429_RETRY_QUEUE_MAX } from "../consts/telegram";
import { getIdentityEntryCount } from "../infra/identityStorage";
import {
  readBotProcessStatus,
  readHostOtherMemoryBytes,
} from "../infra/processStatus";
import { getChatStateCache } from "../infra/storage/stateStore";
import { telegramOutboundStats } from "../infra/telegram/outboundLifecycle";
import { isTerminalVerificationPhase } from "../states/verification/shared";
import type { MoodOption } from "../types/aiChat/mood";
import type { BotProcessStatus } from "../types/botStatus";
import type {
  AdDetectAgentConfig,
  AgentDeploymentConfig,
  ConfigReadiness,
  MoodConfig,
  StickerConfig,
} from "../types/config";
import type { CronAction, CronConfig, CronTask } from "../types/cron";
import type {
  MiniAppCapabilityDetailItem,
  MiniAppCapabilityStatus,
  MiniAppStatusView,
} from "../types/miniApp";

/** 构建单个配置槽位状态条目的入参。 */
interface BuildCapabilityStatusParams {
  /** 能力键名。 */
  readonly key: string;
  /** 能力中文标签。 */
  readonly label: string;
  /** 配置可用性判定结论。 */
  readonly readiness: ConfigReadiness;
  /** 可用时展示的模型或说明文本。 */
  readonly activeDetail: string;
  /** 可用时竖向展示的结构化明细项列表。 */
  readonly activeItems: readonly Readonly<MiniAppCapabilityDetailItem>[];
}

/**
 * 格式化单个配置槽位的状态条目。
 * @param params 能力键名、中文标签、可用性结论与可用时的摘要说明及竖向明细项。
 * @returns 结构化的能力状态视图。
 */
function buildCapabilityStatus({
  key,
  label,
  readiness,
  activeDetail,
  activeItems,
}: BuildCapabilityStatusParams): Readonly<MiniAppCapabilityStatus> {
  if (!readiness.ok) {
    return {
      key,
      label,
      ready: false,
      detail: "未就绪",
      items: [{ label: "运行状态", value: "未就绪", sub: "缺少必要配置" }],
    };
  }
  return {
    key,
    label,
    ready: true,
    detail: activeDetail,
    items: activeItems,
  };
}

/**
 * 构建 Agent 能力配置槽位（含群聊与多模态及广告检测）的模型摘要文本。
 * @param aiReady AI 闲聊与多模态配置是否已就绪。
 * @param adReady AI 广告检测配置是否已就绪。
 * @returns 已配置的 Agent 模型摘要字符串。
 */
function describeAgentModels(aiReady: boolean, adReady: boolean): string {
  const parts: string[] = [];
  if (aiReady) {
    const aiConfig: Readonly<AgentDeploymentConfig> = getAgentDeploymentConfig();
    parts.push(
      `text:${aiConfig.text.model}`,
      `summary:${aiConfig.summary.model}`,
      `media:${aiConfig.media.model}`
    );
    if (aiConfig.image !== undefined) parts.push(`image:${aiConfig.image.model}`);
    if (aiConfig.tts !== undefined) {
      parts.push(
        `tts:${aiConfig.tts.speechProtocol === "xai" ? aiConfig.tts.voice : aiConfig.tts.model}`
      );
    }
    if (aiConfig.webSearch !== undefined) parts.push(`search:${aiConfig.webSearch.model}`);
  }
  if (adReady) {
    const adConfig: Readonly<AdDetectAgentConfig> | null = getAdDetectAgentConfig();
    if (adConfig !== null) {
      parts.push(`ad_detect:${adConfig.model}`);
    }
  }
  return parts.length > 0 ? parts.join(" · ") : "未配置";
}

/**
 * 构建 Agent 能力（合并 AI 群聊与多模态及 AI 广告检测）各子能力槽位的竖向结构化明细列表。
 * @param aiReady AI 闲聊与多模态配置是否已就绪。
 * @param adReady AI 广告检测配置是否已就绪。
 * @returns 竖向展示的 Agent 模型明细项只读数组。
 */
function buildAgentDetailItems(
  aiReady: boolean,
  adReady: boolean
): readonly Readonly<MiniAppCapabilityDetailItem>[] {
  const items: Readonly<MiniAppCapabilityDetailItem>[] = [];
  if (aiReady) {
    const aiConfig: Readonly<AgentDeploymentConfig> = getAgentDeploymentConfig();
    items.push(
      {
        label: "对话 text",
        value: aiConfig.text.model,
        sub: aiConfig.text.provider,
      },
      {
        label: "摘要 summary",
        value: aiConfig.summary.model,
        sub: aiConfig.summary.provider,
      },
      {
        label: "多模态 media",
        value: aiConfig.media.model,
        sub: aiConfig.media.provider,
      }
    );
    if (aiConfig.image !== undefined) {
      items.push({
        label: "生图 image",
        value: aiConfig.image.model,
        sub: aiConfig.image.provider,
      });
    }
    if (aiConfig.tts !== undefined) {
      const ttsModel: string =
        aiConfig.tts.speechProtocol === "xai"
          ? aiConfig.tts.voice
          : aiConfig.tts.model;
      items.push({
        label: "语音 tts",
        value: ttsModel,
        sub: `${aiConfig.tts.provider} · 音色 ${aiConfig.tts.voice}`,
      });
    }
    if (aiConfig.webSearch !== undefined) {
      items.push({
        label: "搜索 search",
        value: aiConfig.webSearch.model,
        sub: `${aiConfig.webSearch.provider} · 限 ${aiConfig.webSearch.maxCallsPerUse} 次/轮`,
      });
    }
  }
  if (adReady) {
    const adConfig: Readonly<AdDetectAgentConfig> | null = getAdDetectAgentConfig();
    if (adConfig !== null) {
      items.push({
        label: "广告检测 ad_detect",
        value: adConfig.model,
        sub: adConfig.provider,
      });
    }
  }
  return items;
}

/**
 * 构建贴纸目录的竖向结构化明细列表。
 * @param stickerConfig 当前已加载的贴纸配置。
 * @returns 竖向展示的贴纸包明细项只读数组。
 */
function buildStickerDetailItems(
  stickerConfig: Readonly<StickerConfig> | null
): readonly Readonly<MiniAppCapabilityDetailItem>[] {
  if (stickerConfig === null) {
    return [{ label: "贴纸包", value: "未加载" }];
  }
  return stickerConfig.packs.map(
    (pack: string, idx: number): Readonly<MiniAppCapabilityDetailItem> => ({
      label: `贴纸包 #${idx + 1}`,
      value: pack,
    })
  );
}

/**
 * 构建 AI 情绪池的竖向结构化明细列表。
 * @param moodConfig 当前已加载的情绪配置。
 * @returns 竖向展示的情绪档位明细项只读数组。
 */
function buildMoodDetailItems(
  moodConfig: Readonly<MoodConfig> | null
): readonly Readonly<MiniAppCapabilityDetailItem>[] {
  if (moodConfig === null) {
    return [{ label: "情绪池", value: "未加载" }];
  }
  return moodConfig.moods.map(
    (mood: Readonly<MoodOption>): Readonly<MiniAppCapabilityDetailItem> => ({
      label: mood.name,
      value: `权重 ${mood.weight}`,
    })
  );
}

/**
 * 构建定时任务（Cron）的竖向结构化明细列表。
 * @param cronConfig 当前已加载的定时任务配置。
 * @returns 竖向展示的定时任务明细项只读数组。
 */
function buildCronDetailItems(
  cronConfig: CronConfig | null
): readonly Readonly<MiniAppCapabilityDetailItem>[] {
  if (cronConfig === null) {
    return [{ label: "定时任务", value: "未加载" }];
  }
  if (cronConfig.length === 0) {
    return [{ label: "定时任务", value: "当前无已配置任务" }];
  }
  return cronConfig.map(
    (task: Readonly<CronTask>): Readonly<MiniAppCapabilityDetailItem> => {
      const actionTypes: string = task.actions
        .map((action: Readonly<CronAction>): string => action.type)
        .join(", ");
      const targetDesc: string =
        task.chatTargets.kind === "all"
          ? "全部受管群"
          : task.chatTargets.kind === "except"
            ? `排除 ${task.chatTargets.chatIds.length} 群`
            : `${task.chatTargets.chatIds.length} 个指定会话`;
      return {
        label: task.name,
        value: task.cron,
        sub: `${actionTypes} · ${targetDesc}`,
      };
    }
  );
}

/**
 * 采集主线程实时运行状态快照（供 Mini App 首页展示）。
 * @returns 包含进程资源、出站网关、活跃会话与六项配置槽位状态的只读视图。
 */
export function buildMiniAppStatusView(): Readonly<MiniAppStatusView> {
  const processStatus: Readonly<BotProcessStatus> = readBotProcessStatus();
  const memoryUsage: NodeJS.MemoryUsage = process.memoryUsage();
  const maxRssKb: number = process.resourceUsage().maxRSS;
  const memoryPeakRssBytes: number = maxRssKb * 1024;
  const memoryCurrentRssBytes: number =
    processStatus.memoryFootprintBytes ?? memoryUsage.rss;
  const memoryTotalBytes: number = processStatus.memoryLimitBytes;
  const memoryOtherBytes: number = readHostOtherMemoryBytes(
    memoryCurrentRssBytes,
    memoryTotalBytes
  );

  let managedChatCount: number = 0;
  for (const state of getChatStateCache().values()) {
    if (state.isInitEnabled === true) {
      managedChatCount++;
    }
  }

  let verifyCount: number = 0;
  for (const record of activeVerificationSnapshots.values()) {
    if (!isTerminalVerificationPhase(record.phase)) {
      verifyCount++;
    }
  }

  const gagCount: number = activeGagSessionCount();
  let wedCount: number = 0;
  for (const wedChat of wedChats.values()) {
    wedCount += wedChat.sessions.size;
  }
  const qaSetCount: number = qaFormSessions.size;
  const totalSessions: number = gagCount + wedCount + verifyCount + qaSetCount;

  const outbound: ReturnType<typeof telegramOutboundStats> =
    telegramOutboundStats();
  const aiReadiness: ConfigReadiness = aiChatConfigReadiness();
  const adReadiness: ConfigReadiness = adDetectConfigReadiness();
  const agentReady: boolean = aiReadiness.ok || adReadiness.ok;
  const stickerConfig: Readonly<StickerConfig> | null = defaultStickerConfigCache.current;
  const moodConfig: Readonly<MoodConfig> | null = defaultMoodConfigCache.current;
  const cronConfig: CronConfig | null = cronConfigCache.current;

  const capabilities: readonly Readonly<MiniAppCapabilityStatus>[] = [
    {
      key: "agent",
      label: "Agent 能力",
      ready: agentReady,
      detail: agentReady
        ? describeAgentModels(aiReadiness.ok, adReadiness.ok)
        : "未就绪",
      items: agentReady
        ? buildAgentDetailItems(aiReadiness.ok, adReadiness.ok)
        : [{ label: "运行状态", value: "未就绪", sub: "缺少必要配置" }],
    },
    buildCapabilityStatus({
      key: "translate",
      label: "Google 自动翻译",
      readiness: translateConfigReadiness(),
      activeDetail: "Google Cloud Translation",
      activeItems: [
        {
          label: "翻译服务",
          value: "Google Cloud Translation",
          sub: "已启用",
        },
      ],
    }),
    {
      key: "stickers",
      label: "贴纸目录",
      ready: stickerConfig !== null,
      detail:
        stickerConfig !== null
          ? `已加载 ${stickerConfig.packs.length} 个贴纸包`
          : "未配置",
      items: buildStickerDetailItems(stickerConfig),
    },
    {
      key: "mood",
      label: "AI 情绪池",
      ready: moodConfig !== null,
      detail:
        moodConfig !== null
          ? `已加载 ${moodConfig.moods.length} 档情绪`
          : "未配置",
      items: buildMoodDetailItems(moodConfig),
    },
    {
      key: "cron",
      label: "定时任务 (Cron)",
      ready: cronConfig !== null,
      detail:
        cronConfig !== null
          ? `已加载 ${cronConfig.length} 项任务`
          : "未配置",
      items: buildCronDetailItems(cronConfig),
    },
    {
      key: "hImage",
      label: "随机图库 (/h_image)",
      ready: true,
      detail: "已配置",
      items: [
        {
          label: "图库服务",
          value: "支持 /h_image 抽图与面板管理",
          sub: "SHA-256 去重存储",
        },
      ],
    },
  ];

  return {
    generatedAt: Date.now(),
    uptimeMs: Math.round(processStatus.uptimeSeconds * 1000),
    cpuAveragePercent: Number(processStatus.averageCpuPercent.toFixed(2)),
    memoryPeakRssBytes,
    memoryCurrentRssBytes,
    memoryOtherBytes,
    memoryTotalBytes,
    memoryHeapUsedBytes: memoryUsage.heapUsed,
    memoryHeapTotalBytes: memoryUsage.heapTotal,
    managedChatCount,
    whitelistCount: getIdentityEntryCount("whitelist"),
    blocklistCount: getIdentityEntryCount("blocklist"),
    activeSessions: {
      total: totalSessions,
      gag: gagCount,
      wed: wedCount,
      verify: verifyCount,
      qaSet: qaSetCount,
    },
    telegramOutbound: {
      inFlight: outbound.active,
      maxConcurrency: outbound.capacity,
      waiting: outbound.pending,
      retryQueueSize: outbound.messageRetryPending,
      retryQueueMax: TELEGRAM_429_RETRY_QUEUE_MAX,
    },
    capabilities,
  };
}

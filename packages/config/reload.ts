/**
 * config/dynamic/ 热重载的主线程判定（跨模块约束见 docs/cn/04-invariants.md）：
 * 严格解析可热重载部署文件，与主线程已生效快照比较并整体替换有变更的 holder。
 * 本模块只读盘并改写主线程 holder；可用性重算、cron 调度对账与向 Worker 分发由 app/configReload.ts 负责。
 */

import { adoptAdSampleConfig, loadAdSampleConfig } from "./adSamples";
import { adoptAssetConfig, loadAssetConfig } from "./assets";
import {
  adoptAdDetectAgentConfig,
  adoptAgentDeploymentConfig,
  loadAgentConfigSnapshots,
} from "./agent";
import { adoptCronConfig, assertCronAgentSupported, cronAgentShortfall, loadCronConfig } from "./cron";
import { adoptMoodConfig, loadMoodConfig } from "./mood";
import { deploymentInputExists } from "./readiness";
import { adoptStickerConfig, loadStickerConfig } from "./stickers";
import { assetConfigCache } from "../cache/main/assets";
import { cronConfigCache } from "../cache/main/cron";
import {
  adDetectAgentConfigCache,
  agentDeploymentConfigCache,
  defaultAdSampleConfigCache,
  defaultMoodConfigCache,
  defaultStickerConfigCache,
} from "../cache/perThread/config";
import {
  AD_SAMPLES_CONFIG_PATH,
  AGENT_CONFIG_PATH,
  ASSETS_CONFIG_PATH,
  CRON_CONFIG_PATH,
  MOOD_CONFIG_PATH,
  STICKERS_CONFIG_PATH,
} from "../consts/paths";
import { DEFAULT_ASSET_CONFIG } from "../consts/ui/assets";
import { ensureRandomImageDirectory } from "../infra/randomImage";
import type { CronAgentShortfall, CronConfig } from "../types/cron";
import { InputValidationError } from "../libs/inputValidation";
import type {
  AdSampleConfig,
  AgentConfigSnapshots,
  AgentDeploymentConfig,
  AssetConfig,
  HotConfigRead,
  HotDeploymentConfigChanges,
  HotDeploymentConfigReads,
  MoodConfig,
  StickerConfig,
} from "../types/config";
import { errorMessage } from "../libs/errorMessage";

/** 读取一份可热重载文件；只把 ENOENT 当作缺省，其余失败一律转成拒绝诊断。 */
async function readHotConfig<T>(
  path: string,
  load: (path: string) => Promise<T>
): Promise<HotConfigRead<T>> {
  try {
    if (!await deploymentInputExists(path)) return { kind: "absent" };
    return { kind: "loaded", value: await load(path) };
  } catch (error: unknown) {
    return { kind: "invalid", reason: errorMessage(error) };
  }
}

/**
 * 读取 assets.json；随机图片目录与当前快照不同时，接管之前先准备并严格检查新目录，
 * 失败按拒绝处理。
 */
async function readHotAssetConfig(): Promise<HotConfigRead<AssetConfig>> {
  const read: HotConfigRead<AssetConfig> = await readHotConfig(ASSETS_CONFIG_PATH, loadAssetConfig);
  if (read.kind === "invalid") return read;
  const directory: string = read.kind === "loaded"
    ? read.value.randomHImageDirectory
    : DEFAULT_ASSET_CONFIG.randomHImageDirectory;
  if (directory === assetConfigCache.current.randomHImageDirectory) return read;
  try {
    await ensureRandomImageDirectory(directory);
  } catch (error: unknown) {
    return { kind: "invalid", reason: errorMessage(error) };
  }
  return read;
}

/** 按固定顺序逐份读取可热重载部署文件；不改写任何 holder。 */
export async function readHotDeploymentConfigs(): Promise<HotDeploymentConfigReads> {
  const assets: HotConfigRead<AssetConfig> = await readHotAssetConfig();
  const adSamples: HotConfigRead<AdSampleConfig> = await readHotConfig(AD_SAMPLES_CONFIG_PATH, loadAdSampleConfig);
  const agent: HotConfigRead<AgentConfigSnapshots> = await readHotConfig(AGENT_CONFIG_PATH, loadAgentConfigSnapshots);
  const mood: HotConfigRead<MoodConfig> = await readHotConfig(MOOD_CONFIG_PATH, loadMoodConfig);
  const stickers: HotConfigRead<StickerConfig> = await readHotConfig(STICKERS_CONFIG_PATH, loadStickerConfig);
  const cron: HotConfigRead<CronConfig> = await readHotConfig(CRON_CONFIG_PATH, loadCronConfig);
  return { assets, adSamples, agent, mood, stickers, cron };
}

/** nextFileSnapshot 的入参：本轮读取结果、当前快照与拒绝诊断收集表。 */
interface FileSnapshotOptions<T> {
  readonly read: HotConfigRead<T>;
  readonly current: T | null;
  readonly rejections: string[];
}

/**
 * 判定单份文件要换成的快照：`undefined` 表示保持不变（内容相同、仍然缺省或被拒绝），
 * `null` 表示文件已被删除，其余为新内容。拒绝诊断写入 rejections。
 */
function nextFileSnapshot<T>({ read, current, rejections }: FileSnapshotOptions<T>): T | null | undefined {
  switch (read.kind) {
    case "invalid":
      rejections.push(read.reason);
      return undefined;
    case "absent":
      return current === null ? undefined : null;
    case "loaded":
      return current !== null && Bun.deepEquals(read.value, current) ? undefined : read.value;
  }
}

/** reconcileAgentDependency 的入参：agent.json 与 cron.json 各自判定后的候选。 */
interface AgentDependencyOptions {
  /** agent.json 的候选两段快照；undefined 表示本轮被拒绝，保持当前快照。 */
  readonly agent: AgentConfigSnapshots | undefined;
  /** cron.json 的候选；undefined 保持不变，null 表示文件已删除。 */
  readonly cron: CronConfig | null | undefined;
  readonly rejections: string[];
}

/** 交叉核对后真正生效的两份候选；语义同 AgentDependencyOptions 的同名字段。 */
interface AgentDependencyDecision {
  readonly agent: AgentConfigSnapshots | undefined;
  readonly cron: CronConfig | null | undefined;
}

/** 候选任务表与给定 agent 配置同时生效时的拒绝原因；没有候选（不变或已删除）或可以生效时为 null。 */
function cronAgentRejection(
  cron: CronConfig | null | undefined,
  agent: AgentDeploymentConfig | null
): string | null {
  if (cron === undefined || cron === null) return null;
  try {
    assertCronAgentSupported(cron, agent);
    return null;
  } catch (error: unknown) {
    return errorMessage(error);
  }
}

/**
 * 对账 cron.json 与 agent.json 的跨文件能力依赖：新任务表缺少依赖时拒绝 cron.json 变更；
 * 生效任务表仍在使用的能力在新 agent.json 中缺失时拒绝 agent.json 变更并改按现行 agent 配置核对新任务表。
 */
function reconcileAgentDependency({ agent, cron, rejections }: AgentDependencyOptions): AgentDependencyDecision {
  const currentAgent: AgentDeploymentConfig | null = agentDeploymentConfigCache.current;
  const candidateAgent: AgentDeploymentConfig | null = agent === undefined ? currentAgent : agent.agent;
  const cronRejection: string | null = cronAgentRejection(cron, candidateAgent);
  const effectiveCron: CronConfig | null = cron === undefined || cronRejection !== null
    ? cronConfigCache.current
    : cron;
  const shortfall: CronAgentShortfall | null = agent === undefined || effectiveCron === null
    ? null
    : cronAgentShortfall(effectiveCron, candidateAgent);
  if (shortfall !== null) {
    rejections.push(new InputValidationError(
      AGENT_CONFIG_PATH,
      "$.agent",
      shortfall.need === "tts"
        ? "configured with text, summary, media and tts while config/dynamic/cron.json uses send_voice"
        : "configured with text, summary and media while config/dynamic/cron.json uses send_web_digest"
    ).message);
    // 现行 agent 配置满足生效中的任务表；候选任务表改按现行配置核对。
    const cronWithCurrent: string | null = cronAgentRejection(cron, currentAgent);
    if (cronWithCurrent !== null) {
      rejections.push(cronWithCurrent);
      return { agent: undefined, cron: undefined };
    }
    return { agent: undefined, cron };
  }
  if (cronRejection !== null) {
    rejections.push(cronRejection);
    return { agent, cron: undefined };
  }
  return { agent, cron };
}

/** 一轮热重载里已生效与已删除的文件路径收集表。 */
interface FileOutcomePaths {
  readonly reloadedPaths: string[];
  readonly removedPaths: string[];
}

/** 把一份文件的判定结果记进生效或删除清单；保持不变时不记。 */
function recordFileOutcome<T>(next: T | null | undefined, path: string, paths: FileOutcomePaths): void {
  if (next === undefined) return;
  if (next === null) paths.removedPaths.push(path);
  else paths.reloadedPaths.push(path);
}

/**
 * 把一轮读取结果应用到主线程 holder，返回实际替换了哪些快照。同步执行：判定与
 * 替换之间不让出事件循环，调用方可以紧接着按返回值重算可用性并分发给 Worker。
 */
export function applyHotDeploymentConfigs(reads: HotDeploymentConfigReads): HotDeploymentConfigChanges {
  const rejections: string[] = [];
  const paths: FileOutcomePaths = { reloadedPaths: [], removedPaths: [] };

  let assetsChanged: boolean = false;
  if (reads.assets.kind === "invalid") {
    rejections.push(reads.assets.reason);
  } else {
    const assets: Readonly<AssetConfig> = reads.assets.kind === "absent" ? DEFAULT_ASSET_CONFIG : reads.assets.value;
    if (!Bun.deepEquals(assets, assetConfigCache.current)) {
      adoptAssetConfig(assets);
      assetsChanged = true;
      if (reads.assets.kind === "absent") paths.removedPaths.push(ASSETS_CONFIG_PATH);
      else paths.reloadedPaths.push(ASSETS_CONFIG_PATH);
    }
  }

  const adSamples: AdSampleConfig | null | undefined = nextFileSnapshot({
    read: reads.adSamples,
    current: defaultAdSampleConfigCache.current,
    rejections,
  });
  if (adSamples !== undefined) adoptAdSampleConfig(adSamples);
  recordFileOutcome(adSamples, AD_SAMPLES_CONFIG_PATH, paths);

  // agent.json 与 cron.json 先各自判定、交叉核对 cron 动作对 agent 能力的依赖之后再替换，
  // 见 reconcileAgentDependency。
  let nextAgent: AgentConfigSnapshots | undefined;
  if (reads.agent.kind === "invalid") {
    rejections.push(reads.agent.reason);
  } else {
    // agent.json 缺省时两段都按未配置判定。
    nextAgent = reads.agent.kind === "absent" ? { adDetect: null, agent: null } : reads.agent.value;
  }
  const cronRead: CronConfig | null | undefined = nextFileSnapshot({
    read: reads.cron,
    current: cronConfigCache.current,
    rejections,
  });
  const { agent: acceptedAgent, cron }: AgentDependencyDecision = reconcileAgentDependency({
    agent: nextAgent,
    cron: cronRead,
    rejections,
  });

  let adDetectChanged: boolean = false;
  let aiAgentChanged: boolean = false;
  if (acceptedAgent !== undefined) {
    // 两段各自与当前快照比较、各自替换。
    if (!Bun.deepEquals(acceptedAgent.adDetect, adDetectAgentConfigCache.current)) {
      adoptAdDetectAgentConfig(acceptedAgent.adDetect);
      adDetectChanged = true;
    }
    if (!Bun.deepEquals(acceptedAgent.agent, agentDeploymentConfigCache.current)) {
      adoptAgentDeploymentConfig(acceptedAgent.agent);
      aiAgentChanged = true;
    }
    if (adDetectChanged || aiAgentChanged) {
      if (reads.agent.kind === "absent") paths.removedPaths.push(AGENT_CONFIG_PATH);
      else paths.reloadedPaths.push(AGENT_CONFIG_PATH);
    }
  }

  const mood: MoodConfig | null | undefined = nextFileSnapshot({
    read: reads.mood,
    current: defaultMoodConfigCache.current,
    rejections,
  });
  if (mood !== undefined) adoptMoodConfig(mood);
  recordFileOutcome(mood, MOOD_CONFIG_PATH, paths);

  const stickers: StickerConfig | null | undefined = nextFileSnapshot({
    read: reads.stickers,
    current: defaultStickerConfigCache.current,
    rejections,
  });
  if (stickers !== undefined) adoptStickerConfig(stickers);
  recordFileOutcome(stickers, STICKERS_CONFIG_PATH, paths);

  if (cron !== undefined) adoptCronConfig(cron);
  recordFileOutcome(cron, CRON_CONFIG_PATH, paths);

  return {
    assets: assetsChanged,
    adDetect: adDetectChanged,
    aiAgent: aiAgentChanged,
    adSamples: adSamples !== undefined,
    mood: mood !== undefined,
    stickers: stickers !== undefined,
    cron: cron !== undefined,
    reloadedPaths: paths.reloadedPaths,
    removedPaths: paths.removedPaths,
    rejections,
  };
}

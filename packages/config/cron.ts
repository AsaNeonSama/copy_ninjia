/**
 * config/dynamic/cron.json 的严格解析：定时任务表，缺省即没有任务。
 *
 * parseCronConfig 只做形态、取值与路径的词法判定；loadCronConfig 在读盘后再逐项核对 `payload.path`
 * 指向的文件或目录存在且类型相符（相对路径以 RUNTIME_DATA_ROOT 为基准，固定图片不超过 CRON_MAX_IMAGES 项）。
 * `send_voice` 与 `send_web_digest` 对 agent.json 的依赖由 assertCronAgentSupported 在启动总闸与热重载时核对。
 */

import type { Stats } from "node:fs";
import { cronConfigCache } from "../cache/main/cron";
import {
  CRON_ALL_CHATS,
  CRON_EXCEPT_CHATS,
  CRON_MAX_ACTIONS_PER_TASK,
  CRON_MAX_CHAT_IDS_PER_TASK,
  CRON_MAX_TASKS,
  CRON_TASK_KEYS,
  CRON_TASK_NAME_MAX_CHARS,
} from "../consts/cron";
import { CRON_CONFIG_PATH } from "../consts/paths";
import { agentDeploymentConfigSnapshot } from "./agent";
import {
  boundedText,
  child,
  fail,
  parseAction,
  parseRandomInterval,
} from "./cronAction";
import { getTimeZone } from "./time";
import { parseTimeZone } from "./timeZoneInput";
import { optionalBooleanField, readJsonInput } from "../libs/inputValidation";
import type { InputFieldContext } from "../libs/inputValidation";
import { hasOnlyKeys, isPlainRecord } from "../libs/record";
import type { AgentDeploymentConfig } from "../types/config";
import type {
  CronAction,
  CronAgentShortfall,
  CronChatTargets,
  CronConfig,
  CronFileSource,
  CronImageSource,
  CronRandomInterval,
  CronTask,
} from "../types/cron";

/**
 * `chat_id` 数组：`["all"]`、`["except", ...会话 id]`，或直接列出会话 id。
 *
 * 各种写法都必须是数组，且都至少要有一个元素；`"all"` 只能单独出现，`"except"` 只能作为
 * 首项；字符串标记去掉首尾空白。会话 id 是非零安全整数且不得重复，最多 CRON_MAX_CHAT_IDS_PER_TASK 个。
 * @param value 待校验的 `chat_id` 数组字段值。
 * @param context 字段的来源文件与 JSONPath 上下文。
 * @returns 已校验的目标会话筛选规则。
 */
function parseChatTargets(value: unknown, context: InputFieldContext): CronChatTargets {
  const expected: string =
    `["${CRON_ALL_CHATS}"], ["${CRON_EXCEPT_CHATS}", <chat id>, ...] or a list of at most ` +
    `${CRON_MAX_CHAT_IDS_PER_TASK} unique non-zero safe integer chat ids`;
  if (!Array.isArray(value) || value.length === 0) return fail(context, expected);
  const first: unknown = typeof value[0] === "string" ? value[0].trim() : value[0];
  if (first === CRON_ALL_CHATS) {
    if (value.length !== 1) return fail(context, expected);
    return { kind: "all" };
  }
  const except: boolean = first === CRON_EXCEPT_CHATS;
  const offset: number = except ? 1 : 0;
  if (value.length - offset === 0 || value.length - offset > CRON_MAX_CHAT_IDS_PER_TASK) {
    return fail(context, expected);
  }
  const chatIds: number[] = [];
  for (let index: number = offset; index < value.length; index++) {
    const chatId: unknown = value[index];
    if (typeof chatId !== "number" || !Number.isSafeInteger(chatId) || chatId === 0 || chatIds.includes(chatId)) {
      return fail(
        { source: context.source, path: `${context.path}[${index}]` },
        "a unique non-zero safe integer chat id"
      );
    }
    chatIds.push(chatId);
  }
  return except ? { kind: "except", chatIds } : { kind: "list", chatIds };
}

/** 定时任务条目的 cron 表达式与时区解码结果。 */
interface CronScheduleFields {
  /** 去掉首尾空白且已确认存在未来触发时间的 cron 表达式。 */
  readonly cron: string;
  /** 规范化后的 IANA 时区名称。 */
  readonly timeZone: string;
}

/**
 * 校验时区与表达式（均去掉首尾空白）；缺省时区来自 Bot 启动配置，表达式必须还有将来的触发时间。
 * @param record 任务条目对象记录。
 * @param context 任务条目的来源与 JSONPath 上下文。
 * @returns 去空白后的 cron 表达式与规范化时区名。
 */
function parseSchedule(record: Record<string, unknown>, context: InputFieldContext): CronScheduleFields {
  // 只有键真正缺省才用默认时区；显式写出的非法值（含 null）照常拒绝。
  const timeZone: string = record.time_zone === undefined
    ? getTimeZone()
    : parseTimeZone(record.time_zone, context.source, `${context.path}.time_zone`);
  const expected: string = "a 5-field cron expression or @nickname with a future occurrence";
  if (typeof record.cron !== "string") return fail(child(context, "cron"), expected);
  const cron: string = record.cron.trim();
  let next: Date | null;
  try {
    next = Bun.cron.parse(cron, Date.now(), { tz: timeZone });
  } catch {
    return fail(child(context, "cron"), expected);
  }
  if (next === null) return fail(child(context, "cron"), expected);
  return { cron, timeZone };
}

/**
 * 解码单个定时任务定义。
 * @param value 待校验的任务条目值。
 * @param context 任务条目的来源与 JSONPath 上下文。
 * @returns 已通过校验的定时任务定义。
 */
function parseTask(value: unknown, context: InputFieldContext): CronTask {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, CRON_TASK_KEYS)) {
    return fail(context, "{ name, chat_id, cron, time_zone?, rand_cron?, just_once?, actions }");
  }
  const name: string = boundedText(value.name, child(context, "name"), CRON_TASK_NAME_MAX_CHARS);
  const chatTargets: CronChatTargets = parseChatTargets(value.chat_id, child(context, "chat_id"));
  const { cron, timeZone }: CronScheduleFields = parseSchedule(value, context);
  const randomInterval: CronRandomInterval | undefined = value.rand_cron === undefined
    ? undefined
    : parseRandomInterval(value.rand_cron, child(context, "rand_cron"));
  const justOnce: boolean = optionalBooleanField(value, "just_once", context) === true;
  if (justOnce && randomInterval !== undefined) {
    return fail(child(context, "just_once"), "false or absent when rand_cron is set");
  }
  if (!Array.isArray(value.actions) || value.actions.length === 0 || value.actions.length > CRON_MAX_ACTIONS_PER_TASK) {
    return fail(child(context, "actions"), `a non-empty array with at most ${CRON_MAX_ACTIONS_PER_TASK} actions`);
  }
  const actionsContext: InputFieldContext = child(context, "actions");
  const actions: Readonly<CronAction>[] = [];
  for (let index: number = 0; index < value.actions.length; index++) {
    actions.push(parseAction(value.actions[index], { source: context.source, path: `${actionsContext.path}[${index}]` }));
  }
  return { name, chatTargets, cron, timeZone, randomInterval, justOnce, actions };
}

/**
 * 严格解析 cron.json 的内容；只做形态与词法判定，不访问文件系统。
 * @param value 待校验的顶层 JSON 值。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns 已通过校验的定时任务列表。
 */
export function parseCronConfig(value: unknown, sourcePath: string = CRON_CONFIG_PATH): CronConfig {
  const root: InputFieldContext = { source: sourcePath, path: "$" };
  if (!Array.isArray(value) || value.length > CRON_MAX_TASKS) {
    return fail(root, `an array with at most ${CRON_MAX_TASKS} tasks`);
  }
  const tasks: Readonly<CronTask>[] = [];
  const names: Set<string> = new Set();
  for (let index: number = 0; index < value.length; index++) {
    const task: CronTask = parseTask(value[index], { source: sourcePath, path: `$[${index}]` });
    if (names.has(task.name)) return fail({ source: sourcePath, path: `$[${index}].name` }, "unique across tasks");
    names.add(task.name);
    tasks.push(task);
  }
  return tasks;
}

/**
 * 核对一个本地来源存在且类型相符；跟随符号链接，读不到一律按不存在处理。
 * @param path 本机文件或目录的绝对路径。
 * @param kind 期望的本机条目类型（普通文件或目录）。
 * @param context 字段的来源文件与 JSONPath 上下文。
 */
async function verifyLocalSource(
  path: string,
  kind: "file" | "directory",
  context: InputFieldContext
): Promise<void> {
  let valid: boolean;
  try {
    const stats: Stats = await Bun.file(path).stat();
    valid = kind === "file" ? stats.isFile() : stats.isDirectory();
  } catch {
    valid = false;
  }
  if (!valid) fail(context, kind === "file" ? "an existing regular file" : "an existing directory");
}

/**
 * 核对一个动作来源引用的全部本机文件或目录；url/urls 来源与未指定目录的 random 不访问文件系统。
 * @param source 动作解析出的图片或文件来源。
 * @param context `payload.path` 字段的来源与 JSONPath 上下文。
 */
async function verifyActionLocalSources(
  source: CronImageSource | CronFileSource,
  context: InputFieldContext
): Promise<void> {
  if (source.kind === "path") {
    await verifyLocalSource(source.path, "file", context);
  } else if (source.kind === "paths") {
    for (let index: number = 0; index < source.paths.length; index++) {
      await verifyLocalSource(source.paths[index]!, "file", { source: context.source, path: `${context.path}[${index}]` });
    }
  } else if (source.kind === "random" && source.directory !== null) {
    await verifyLocalSource(source.directory, "directory", context);
  }
}

/**
 * 读取并严格解析 cron.json，再核对全部本地来源；模块 import 本身不访问文件系统。
 * @returns 已通过形态与本机路径存在性校验的定时任务配置。
 */
export async function loadCronConfig(): Promise<CronConfig> {
  const config: CronConfig = parseCronConfig(await readJsonInput(CRON_CONFIG_PATH), CRON_CONFIG_PATH);
  for (let taskIndex: number = 0; taskIndex < config.length; taskIndex++) {
    const actions: readonly Readonly<CronAction>[] = config[taskIndex]!.actions;
    for (let actionIndex: number = 0; actionIndex < actions.length; actionIndex++) {
      const action: Readonly<CronAction> = actions[actionIndex]!;
      if (action.type === "send_message" || action.type === "send_voice" || action.type === "send_web_digest") continue;
      const context: InputFieldContext = { source: CRON_CONFIG_PATH, path: `$[${taskIndex}].actions[${actionIndex}].payload.path` };
      await verifyActionLocalSources(action.source, context);
    }
  }
  return config;
}

/**
 * 任务表与给定 agent 配置同时生效时第一个缺依赖的动作：`send_voice` 要 `agent.tts` 合成语音，
 * `send_web_digest` 要对话核心能力（text 检索与组稿）。都满足时为 null。
 * @param config 待核对的定时任务列表。
 * @param agent 与这份任务表同时生效的对话能力配置；null 表示文件或对话核心能力段缺省。
 * @returns 第一个缺失 AI 能力依赖的动作位置与所需能力；全部满足时返回 null。
 */
export function cronAgentShortfall(
  config: CronConfig,
  agent: Readonly<AgentDeploymentConfig> | null
): CronAgentShortfall | null {
  for (let taskIndex: number = 0; taskIndex < config.length; taskIndex++) {
    const actions: readonly Readonly<CronAction>[] = config[taskIndex]!.actions;
    for (let actionIndex: number = 0; actionIndex < actions.length; actionIndex++) {
      const type: CronAction["type"] = actions[actionIndex]!.type;
      if (type === "send_voice" && agent?.tts === undefined) return { taskIndex, actionIndex, need: "tts" };
      if (type === "send_web_digest" && agent === null) return { taskIndex, actionIndex, need: "text" };
    }
  }
  return null;
}

/**
 * 按第一个缺依赖的动作的字段路径拒绝整份任务表（见 cronAgentShortfall）。
 * @param config 待核对的定时任务列表。
 * @param agent 与这份任务表同时生效的对话能力配置；启动时是刚校验的 agent 配置，热重载时是
 *   本轮对账后生效的那一份。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 */
export function assertCronAgentSupported(
  config: CronConfig,
  agent: Readonly<AgentDeploymentConfig> | null,
  sourcePath: string = CRON_CONFIG_PATH
): void {
  const shortfall: CronAgentShortfall | null = cronAgentShortfall(config, agent);
  if (shortfall === null) return;
  fail(
    { source: sourcePath, path: `$[${shortfall.taskIndex}].actions[${shortfall.actionIndex}].type` },
    shortfall.need === "tts"
      ? "a type other than send_voice unless config/dynamic/agent.json configures $.agent.tts alongside text, summary and media"
      : "a type other than send_web_digest unless config/dynamic/agent.json configures $.agent.text, summary and media"
  );
}

/**
 * 接管已严格校验的任务表：启动总闸或 config/dynamic/ 热重载；null 表示文件已删除或缺省。
 * @param config 已校验的定时任务配置，或表示文件缺省的 null。
 */
export function adoptCronConfig(config: CronConfig | null): void {
  cronConfigCache.current = config;
}

/**
 * 启动总闸：文件存在时加载、核对动作对 agent 能力的依赖后接管。须排在 agent.json 的
 * 校验之后（见 config/readiness.ts 的 validateExistingDeploymentInputs）。
 */
export async function ensureCronConfig(): Promise<void> {
  const config: CronConfig = await loadCronConfig();
  assertCronAgentSupported(config, agentDeploymentConfigSnapshot());
  adoptCronConfig(config);
}

/**
 * 当前生效的任务表；文件缺省时为空表。只读 holder，不读盘。
 * @returns 当前线程生效的定时任务列表。
 */
export function getCronConfig(): CronConfig {
  return cronConfigCache.current ?? [];
}

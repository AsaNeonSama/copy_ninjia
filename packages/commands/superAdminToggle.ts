import type { CommandContext, Context } from "grammy";
import { applyChatFeatureSwitch } from "../infra/chatFeatureSwitch";
import type { ChatFeatureSwitchOutcome } from "../infra/chatFeatureSwitch";
import { replyCommandNotice } from "../infra/telegram";
import type { WhitelistPermissionKey } from "../types/identityPolicy";
import type { CachedUser, ChatToggleFeature } from "../types/chatState";
import type { ToggleAction, ToggleCommandTexts } from "../types/commands";
import { rejectUnlessPermitted, rejectUnlessSuperAdmin } from "./commandActor";
import { parseToggleAction } from "./arguments";

/** `resolveSuperAdminToggleArg` 校验命令权限与参数所用的选项。 */
interface SuperAdminToggleOptions {
  /** 本命令的文案表，取自 consts/atmosphere/（经 chatAtmosphere() 读取）。 */
  readonly texts: ToggleCommandTexts;
  /** 省略时仅允许超级管理员；提供时允许拥有该项白名单权限的身份。 */
  readonly permission?: WhitelistPermissionKey;
}

/** `toggleReplyText` 选择开关命令回执文案的入参。 */
interface ToggleReplyTextParams {
  /** 本次命令写入的目标状态。 */
  readonly isEnabled: boolean;
  /** 写入之前这个群的状态，用来识别同状态重复执行。 */
  readonly wasEnabled: boolean;
  /** 本命令的文案表；这里只取各状态结局的回执文案。 */
  readonly texts: ToggleCommandTexts;
}

/**
 * 按「目标状态」与「原状态」选出开关命令的回执文案。
 *
 * 判定只看这两个布尔值，不看落盘或运行时清理是否执行过：同状态重复执行仍会
 * 落盘并重跑清理，回执说明状态未改变。
 * @param params 目标状态（`isEnabled`）、原状态（`wasEnabled`）与文案表（`texts`）。
 * @returns 对应的开关操作回执文案。
 */
export function toggleReplyText({
  isEnabled,
  wasEnabled,
  texts,
}: ToggleReplyTextParams): string {
  if (isEnabled === wasEnabled) {
    return isEnabled ? texts.alreadyEnabled : texts.alreadyDisabled;
  }
  return isEnabled ? texts.enabled : texts.disabled;
}

/** runChatToggleCommand 的入参；按群开关命令的完整编排都由它描述。 */
export interface ChatToggleCommandParams {
  /** grammY 命令上下文。 */
  readonly ctx: CommandContext<Context>;
  /** 本命令的文案表，取自 consts/atmosphere/（经 chatAtmosphere() 读取）。 */
  readonly texts: ToggleCommandTexts;
  /** 授权用的白名单权限键；超级管理员恒持有全部键。 */
  readonly permission: WhitelistPermissionKey;
  /** 本命令切换的群功能；字段名与落盘原因串查 consts/chatFeatureSwitch.ts 的 CHAT_FEATURE_SWITCHES。 */
  readonly feature: ChatToggleFeature;
  /**
   * 开启方向的配置总闸；返回 true 表示它已经自己回执并拒绝了本次开启。
   * 省略表示开启时不检查部署配置。
   */
  readonly refuseEnable?: (chatId: number, messageId: number | undefined) => Promise<boolean>;
  /** 关闭开关前必须完成的持久化前置操作；失败原样上抛，不确认本条 update。 */
  readonly beforeDisable?: (chatId: number) => Promise<void>;
  /** 关闭方向的运行时拆除；省略表示没有需要就地收掉的运行时状态。 */
  readonly teardown?: (chatId: number) => void | Promise<void>;
  /**
   * 拆除失败时的替代回执。省略表示拆除失败时仍按开关结果回执；状态活在主线程镜像
   * 的开关（/antiraid，见 commands/antiRaid.ts）提供它。
   */
  readonly teardownFailedText?: string;
}

/**
 * 按群开关命令的统一编排：解析授权与参数 → 开启方向的配置总闸 → 经 applyChatFeatureSwitch
 * 执行关闭前置、写入并落盘、关闭方向尽力拆除运行时 → 回执。
 *
 * /ad_detect、/ai_chat、/flood_control、/antiraid 与 /translate 开关共用这一编排；置位、落盘与
 * 拆除的顺序语义见 infra/chatFeatureSwitch.ts。
 * @param params 命令上下文、权限键、群功能及可选的开启闸门/关闭前置与运行时拆除钩子。
 */
export async function runChatToggleCommand({
  ctx,
  texts,
  permission,
  feature,
  refuseEnable,
  beforeDisable,
  teardown,
  teardownFailedText,
}: ChatToggleCommandParams): Promise<void> {
  const arg: ToggleAction | undefined =
    await resolveSuperAdminToggleArg(ctx, { texts, permission });
  if (arg === undefined) return;

  const chatId: number = ctx.chat.id;
  const messageId: number | undefined = ctx.msgId;
  const isEnabled: boolean = arg === "enable";
  if (isEnabled && refuseEnable !== undefined && await refuseEnable(chatId, messageId)) {
    return;
  }

  const { wasEnabled, teardownFailed }: ChatFeatureSwitchOutcome = await applyChatFeatureSwitch({
    chatId,
    feature,
    enabled: isEnabled,
    beforeDisable,
    teardown,
  });
  const replyText: string = teardownFailed && teardownFailedText !== undefined
    ? teardownFailedText
    : toggleReplyText({ isEnabled, wasEnabled, texts });
  await replyCommandNotice(ctx, replyText);
}

/**
 * runChatToggleCommand 的各调用方与 /init 共用的权限与参数校验。
 *
 * 提供 permission 时按该权限键授权，超级管理员恒持有全部权限键（见
 * infra/identityPolicy/whitelist.ts）；省略 permission 时只认超级管理员身份（/init），走
 * rejectUnlessSuperAdmin。ctx.match 还必须是 enable/disable 之一，否则回复
 * texts.usage。
 * @param ctx grammY 命令上下文。
 * @param options 开关文案表与可选白名单权限键。
 * @returns 校验通过时返回 `"enable"` 或 `"disable"`；被拒绝或参数非法时返回 undefined。
 */
export async function resolveSuperAdminToggleArg(
  ctx: CommandContext<Context>,
  { texts, permission }: SuperAdminToggleOptions
): Promise<ToggleAction | undefined> {
  const actor: CachedUser | undefined = permission === undefined
    ? await rejectUnlessSuperAdmin(ctx, texts.rejection)
    : await rejectUnlessPermitted(ctx, permission, texts.rejection);
  if (actor === undefined) return undefined;

  const arg: ToggleAction | undefined = parseToggleAction(ctx.match.trim());
  if (arg === undefined) {
    await replyCommandNotice(ctx, texts.usage);
    return undefined;
  }

  return arg;
}

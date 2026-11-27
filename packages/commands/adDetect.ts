import type { CommandContext, Context } from "grammy";
import { clearAdDetection } from "../antiRaid";
import { adDetectConfigReadiness } from "../config/readiness";
import { chatAtmosphere } from "../infra/atmosphere";
import type { AdPackBlacklistKind } from "../types/adPackBlacklist";

import { handleAdDetectBlacklistCommand } from "./adDetectBlacklist";
import { commandArgumentTokens } from "./arguments";
import { refuseIfConfigBroken } from "./configGate";
import { runChatToggleCommand } from "./superAdminToggle";

/**
 * 大小写不敏感地识别黑名单管理子命令首词（`sticker` 或 `emoji`）。
 *
 * @param token 命令参数的首个分词。
 * @returns 命中时返回规范化后的黑名单种类；否则返回 `undefined`。
 */
function parseAdBlacklistKind(token: string | undefined): AdPackBlacklistKind | undefined {
  const normalized: string | undefined = token?.toLowerCase();
  if (normalized === "sticker" || normalized === "emoji") return normalized;
  return undefined;
}

/**
 * 处理 `/ad_detect` 指令：
 * - `/ad_detect enable|disable`：按群开关广告检测（`ChatState.isAdDetectEnabled`）；
 * - `/ad_detect <sticker|emoji> <list [页码]|add [包名...]|remove [包名...]>`：管理全局贴纸包与自定义表情包黑名单。
 *
 * - **检测与处置**：开启后，本群非豁免成员发出的文本/图注、隐藏链接、贴纸、自定义表情及非白名单引用内容
 *   会交由 Anti-Raid Worker 依次执行贴纸包黑名单、自定义表情包黑名单与模型分类判定：
 *   - 仅引用内容首次命中时，发送临时公开警告并删除警告前涉事消息；
 *   - 命中黑名单、本人正文/姓名直接命中或警告窗口内再次命中时，删除本群涉事消息，并按
 *     `config/dynamic/ad_detect.json` 的处罚配置执行全局拉黑跨群封禁、本群禁言/踢出/封禁或频道仅删消息
 *     （见 `antiRaid/adDetect.ts` 与 `states/adPunishment.ts`）。
 * - **权限要求**：仅持有 `isCanControllAdDetectPermission` 的身份可用；超级管理员恒持有该权限
 *   （见 `infra/identityPolicy/whitelist.ts`），白名单身份可经 `/permission` 单独获授。
 * - **配置与关闭清理**：仅 `/ad_detect enable` 经 `adDetectConfigReadiness` 校验 `config/dynamic/agent.json`
 *   的 `ad_detect` 能力与 `config/dynamic/ad_detect.json`（不要求机器人已是本群管理员）；黑名单子命令直接读写
 *   SQLite `ad_pack_blacklists`，不依赖 `ad_detect.json` 就绪状态；关闭时经 `clearAdDetection` 尽力丢弃
 *   Worker 内该群排队的待检消息（见 `runChatToggleCommand`）。
 *
 * @param ctx grammY 命令上下文。
 */
export async function handleAdDetectCommand(ctx: CommandContext<Context>): Promise<void> {
  const tokens: string[] = commandArgumentTokens(ctx.match);
  const blacklistKind: AdPackBlacklistKind | undefined = parseAdBlacklistKind(tokens[0]);
  if (blacklistKind !== undefined) {
    await handleAdDetectBlacklistCommand(ctx, blacklistKind, tokens.slice(1));
    return;
  }
  await runChatToggleCommand({
    ctx,
    texts: chatAtmosphere().AD_DETECT_TOGGLE_TEXTS,
    permission: "isCanControllAdDetectPermission",
    feature: "adDetect",
    refuseEnable: (chatId: number, messageId: number | undefined): Promise<boolean> =>
      refuseIfConfigBroken({
        readiness: adDetectConfigReadiness(),
        chatId,
        messageId,
        feature: "Ad detection",
        text: (file: string): string => chatAtmosphere().NOTICE_TEXTS.adConfigInvalid(file),
      }),
    teardown: clearAdDetection,
  });
}

import {
  EMPTY_STICKER_MENU,
  MAX_STICKER_PACK_VIEWS_PER_REPLY,
  MAX_STICKERS_PER_REPLY,
  STICKER_CHOOSE_DELAY_BASE_MS,
  STICKER_CHOOSE_DELAY_JITTER_MS,
  STICKER_INTENT_MAX_CHARS,
  STICKER_PACK_SUMMARY_PENDING,
} from "../../../consts/aiChat/stickers";
import type { StickerSet } from "grammy/types";
import type { AiToolDefinition } from "../../../types/aiChat/provider";
import { getStickerConfig } from "../../../config/stickers";
import { sendSticker } from "../../../infra/telegram";
import { logger } from "../../../infra/logger";
import { getCatalogEntry } from "../stickers/catalog";
import { getStickerSet } from "../stickers/sets";
import { describeStickerForContext } from "../stickers/describe";
import { parseIndexField, parseToolArguments } from "../utils/toolArgs";
import { raceAbort } from "../../../libs/abortSignal";
import { sanitizeInline } from "../../../libs/text";
import {
  SEND_STICKER_TOOL_INSTRUCTION,
  STICKER_INTENT_SELECTION_INSTRUCTION,
  VIEW_STICKER_PACK_TOOL_INSTRUCTION,
} from "../../../consts/aiChat/prompts/tools";
import { REPLY_INVALIDATED_TOOL_ERROR, SEND_STICKER_TOOL, VIEW_STICKER_PACK_TOOL } from "../../../consts/tools";
import { toolError } from "../utils/toolResult";
import {
  stickerMenuCache,
  stickerMenuInflight,
  stickerMenuRevision,
} from "../../../cache/workers/aiChat/stickers/menu";
import { packSummaries } from "../../../cache/workers/aiChat/stickers/catalog";
import { aiChatWorkerAbortController } from "../../../cache/workers/aiChat/worker";
import { pauseThenSettle } from "./replyToolset/pacing";
import type { ChatActionControl } from "../../../types/aiChat/chatAction";
import type { ReplyActionPause, ReplyToolExecution } from "../../../types/aiChat/replies";
import type { StickerCatalogEntry } from "../../../types/stickers/catalog";
import type { StickerCandidate, StickerPackCandidate, StickerRoundState } from "../../../types/stickers/tools";

/**
 * 应景贴纸的两层选择工具：
 * - view_sticker_pack：按包编号与表达意图返回包内每枚贴纸的编号与描述；每轮最多查看
 *   MAX_STICKER_PACK_VIEWS_PER_REPLY 个不同包，同一包只能查看一次。
 * - send_sticker：按包编号与贴纸编号发送已查看包内的贴纸；每轮最多发送 MAX_STICKERS_PER_REPLY 枚且不重复。
 * 工具声明与执行器共享同一轮 buildStickerPackMenu() 产出的菜单。
 */

/**
 * 创建单轮回复的贴纸工具状态（跟踪已查看包意图与已接纳贴纸唯一 ID）。
 * @returns 初始化为空的贴纸轮次状态。
 */
export function createStickerRoundState(): StickerRoundState {
  return { viewedPackIntents: new Map(), acceptedStickerUids: new Set() };
}

/**
 * 组装当前可选的贴纸包菜单：收录白名单包中已有画面描述的贴纸与整包简介（未生成简介时使用占位文案）；
 * 拉取失败或无可用贴纸的包跳过。
 * @param signal 调用方可选取消信号。
 * @returns 可选贴纸包候选列表；已取消或无可用包时返回空数组。
 */
export function buildStickerPackMenu(
  signal?: AbortSignal
): Promise<readonly StickerPackCandidate[]> {
  if (signal?.aborted === true) return Promise.resolve(EMPTY_STICKER_MENU);
  const revision: number = stickerMenuRevision.current;
  const cached: typeof stickerMenuCache.current = stickerMenuCache.current;
  if (cached?.revision === revision) return Promise.resolve(cached.menu);
  const inflight: typeof stickerMenuInflight.current = stickerMenuInflight.current;
  if (inflight?.revision === revision) return waitForStickerMenu(inflight.promise, signal);

  const workerSignal: AbortSignal = aiChatWorkerAbortController.current.signal;
  const promise: Promise<readonly StickerPackCandidate[]> = rebuildStickerPackMenu(
    revision,
    workerSignal
  );
  stickerMenuInflight.current = { revision, promise };
  return waitForStickerMenu(promise, signal);
}

/**
 * 重建贴纸包菜单，构建期间目录版本未变时写回缓存。
 * @param revision 构建启动时的贴纸目录版本号。
 * @param signal AI Worker 生命周期取消信号。
 * @returns 构建完成的贴纸包候选列表。
 */
async function rebuildStickerPackMenu(
  revision: number,
  signal: AbortSignal
): Promise<readonly StickerPackCandidate[]> {
  try {
    const menu: readonly StickerPackCandidate[] = await collectStickerPackMenu(signal);
    if (!signal.aborted && stickerMenuRevision.current === revision) {
      stickerMenuCache.current = { revision, menu };
    }
    return menu;
  } finally {
    if (stickerMenuInflight.current?.revision === revision) stickerMenuInflight.current = null;
  }
}

/**
 * 并行拉取白名单贴纸集合并过滤出已有常驻目录描述的候选包列表。
 * @param signal 取消信号。
 * @returns 包含可用贴纸的贴纸包候选列表。
 */
async function collectStickerPackMenu(signal: AbortSignal): Promise<StickerPackCandidate[]> {
  const packs: readonly string[] = getStickerConfig().packs;
  const results: PromiseSettledResult<StickerSet | null>[] = await Promise.allSettled(
    packs.map((pack: string): Promise<StickerSet | null> =>
      getStickerSet(pack, undefined, signal)
    )
  );
  const menu: StickerPackCandidate[] = [];
  for (let i: number = 0; i < packs.length; i++) {
    const pack: string = packs[i]!;
    const result: PromiseSettledResult<StickerSet | null> = results[i]!;
    if (result.status === "rejected") {
      logger.error(`Unexpected sticker menu fetch rejection for pack "${pack}":`, result.reason);
    }
    const set: StickerSet | null = result.status === "fulfilled" ? result.value : null;
    if (!set) continue;
    const stickers: StickerCandidate[] = [];
    for (const sticker of set.stickers) {
      const entry: StickerCatalogEntry | undefined = getCatalogEntry(sticker.file_unique_id);
      if (entry) stickers.push({ sticker, emoji: entry.emoji, description: entry.description });
    }
    if (stickers.length === 0) continue;
    menu.push({ pack, title: set.title, summary: packSummaries.get(pack) ?? STICKER_PACK_SUMMARY_PENDING, stickers });
  }
  return menu;
}

/**
 * 等待共享菜单构建完成；当前回复取消时只中止自身等待。
 * @param request 共享的贴纸包菜单构建 Promise。
 * @param signal 调用方可选取消信号。
 * @returns 贴纸包候选列表；取消或失败时返回空菜单。
 */
function waitForStickerMenu(
  request: Promise<readonly StickerPackCandidate[]>,
  signal?: AbortSignal
): Promise<readonly StickerPackCandidate[]> {
  return raceAbort(request, {
    signal,
    cancelled: EMPTY_STICKER_MENU,
    rejected: EMPTY_STICKER_MENU,
  });
}

/**
 * 格式化包内贴纸的编号清单文本。
 * @param candidate 单个贴纸包候选项。
 * @returns 按 1 起始编号排列的多行贴纸描述清单。
 */
function formatPackStickerList(candidate: StickerPackCandidate): string {
  return candidate.stickers.map((c: StickerCandidate, i: number): string => `${i + 1}. ${c.emoji || "（无 emoji）"} ${c.description}`).join("\n");
}

/**
 * 构造 view_sticker_pack 工具定义；菜单为空时返回 null。
 * @param menu 当前轮次可用的贴纸包菜单。
 * @returns 工具定义对象；菜单为空时返回 null。
 */
export function buildViewStickerPackToolDefinition(menu: readonly StickerPackCandidate[]): AiToolDefinition | null {
  if (menu.length === 0) return null;

  const listText: string = menu.map((p: StickerPackCandidate, i: number): string => `${i + 1}. 「${p.title}」（${p.stickers.length} 枚）：${p.summary}`).join("\n");
  return {
    name: VIEW_STICKER_PACK_TOOL,
    description: VIEW_STICKER_PACK_TOOL_INSTRUCTION + listText,
    parametersJsonSchema: {
      type: "object",
      properties: {
        pack_index: { type: "integer", description: `要查看的贴纸包在清单里的编号，1 到 ${menu.length} 之间。` },
        intent: {
          type: "string",
          description: `希望贴纸产生的回复效果，并说明需要避免的情绪或语气；写成一句具体短句，不超过 ${STICKER_INTENT_MAX_CHARS} 字。`,
          maxLength: STICKER_INTENT_MAX_CHARS,
        },
      },
      required: ["pack_index", "intent"],
    },
  };
}

/**
 * 构造 send_sticker 工具定义；菜单为空时返回 null。
 * @param menu 当前轮次可用的贴纸包菜单。
 * @returns 工具定义对象；菜单为空时返回 null。
 */
export function buildSendStickerToolDefinition(menu: readonly StickerPackCandidate[]): AiToolDefinition | null {
  if (menu.length === 0) return null;

  return {
    name: SEND_STICKER_TOOL,
    description: SEND_STICKER_TOOL_INSTRUCTION,
    parametersJsonSchema: {
      type: "object",
      properties: {
        pack_index: { type: "integer", description: `贴纸包在 view_sticker_pack 清单里的编号，1 到 ${menu.length} 之间。` },
        sticker_index: { type: "integer", description: "贴纸在该包清单（view_sticker_pack 的返回结果）里的编号。" },
      },
      required: ["pack_index", "sticker_index"],
    },
  };
}

/**
 * 解析并清洗查看贴纸包时必填的表达意图；为空或超过 STICKER_INTENT_MAX_CHARS 时返回 null。
 * @param argumentsJson 模型传入的工具参数 JSON 字符串。
 * @returns 清洗后的非空意图短句；缺失、空白或超长时返回 null。
 */
export function parseStickerIntent(argumentsJson: string): string | null {
  const value: unknown = parseToolArguments(argumentsJson)?.intent;
  if (typeof value !== "string") return null;
  const intent: string = sanitizeInline(value);
  if (!intent || intent.length > STICKER_INTENT_MAX_CHARS) return null;
  return intent;
}

/** viewStickerPackTool 的入参。 */
export interface ViewStickerPackToolParams {
  /** 同一轮回复里 buildStickerPackMenu 产出的菜单。 */
  menu: readonly StickerPackCandidate[];
  /** 模型传入的工具参数 JSON 字符串。 */
  argumentsJson: string;
  /** 本轮贴纸工具状态。 */
  state: StickerRoundState;
  /** 可选取消信号。 */
  signal?: AbortSignal;
}

/**
 * 校验查看额度并同步返回目标贴纸包的编号清单。
 * @param params 贴纸包菜单、工具参数 JSON、轮次状态与取消信号。
 * @returns 包含包名、意图、选片说明与贴纸清单的 JSON 字符串，或工具错误 JSON。
 */
export function viewStickerPackTool({
  menu,
  argumentsJson,
  state,
  signal,
}: ViewStickerPackToolParams): string {
  if (signal?.aborted === true) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
  const packIndex: number | null = parseIndexField(argumentsJson, "pack_index", menu.length);
  if (packIndex === null) return toolError("Invalid pack_index");
  const intent: string | null = parseStickerIntent(argumentsJson);
  if (intent === null) return toolError(`Invalid intent: provide a concrete non-empty intent within ${STICKER_INTENT_MAX_CHARS} characters`);
  if (state.viewedPackIntents.has(packIndex)) {
    return toolError(
      "Sticker pack already viewed in this reply; do not view it again. Use its existing list, choose a different unviewed pack, or reply without a sticker"
    );
  }
  if (state.viewedPackIntents.size >= MAX_STICKER_PACK_VIEWS_PER_REPLY) {
    return toolError(
      `Sticker pack view limit reached: at most ${MAX_STICKER_PACK_VIEWS_PER_REPLY} different packs per reply; do not call view_sticker_pack again. Reply with text/reaction or finish`
    );
  }

  const candidate: StickerPackCandidate = menu[packIndex - 1]!;
  state.viewedPackIntents.set(packIndex, intent);
  return JSON.stringify({
    pack: candidate.title,
    intent,
    selection_instruction: STICKER_INTENT_SELECTION_INSTRUCTION,
    stickers: formatPackStickerList(candidate),
  });
}

/** sendStickerTool 的入参。 */
export interface SendStickerToolParams {
  /** 目标群聊 ID。 */
  chatId: number;
  /** 本轮所在的论坛话题；General、非论坛群为 undefined。 */
  messageThreadId: number | undefined;
  /** 同一轮回复里 buildStickerPackMenu 产出的菜单。 */
  menu: readonly StickerPackCandidate[];
  /** 模型传入的工具参数 JSON 字符串。 */
  argumentsJson: string;
  /** 本轮贴纸工具状态。 */
  state: StickerRoundState;
  /** 发送成功后的回调（描述行 + 消息 ID）。 */
  onSent: (stickerDescription: string, messageId: number) => void;
  /** 本轮回复是否仍属当前代际。 */
  isActive: () => boolean;
  /** 可选取消信号。 */
  signal?: AbortSignal;
}

/**
 * 校验已查看清单与贴纸限额，预占贴纸并返回串行发送步骤。
 * @param params 发送贴纸所需的群聊上下文、贴纸菜单、工具参数与轮次状态。
 * @returns 排入串行动作链的工具执行计划或立即失败的错误 JSON。
 */
export function sendStickerTool({
  chatId,
  messageThreadId,
  menu,
  argumentsJson,
  state,
  onSent,
  isActive,
  signal,
}: SendStickerToolParams): ReplyToolExecution {
  if (!isActive()) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
  const packIndex: number | null = parseIndexField(argumentsJson, "pack_index", menu.length);
  if (packIndex === null) return toolError("Invalid pack_index");
  const pack: StickerPackCandidate = menu[packIndex - 1]!;

  const stickerIndex: number | null = parseIndexField(argumentsJson, "sticker_index", pack.stickers.length);
  if (stickerIndex === null) return toolError("Invalid sticker_index");

  if (!state.viewedPackIntents.has(packIndex)) {
    return toolError("Pack not viewed yet: call view_sticker_pack on this pack first");
  }
  if (state.acceptedStickerUids.size >= MAX_STICKERS_PER_REPLY) {
    return toolError(`Sticker limit reached: at most ${MAX_STICKERS_PER_REPLY} stickers per reply`);
  }

  const candidate: StickerCandidate = pack.stickers[stickerIndex - 1]!;
  if (state.acceptedStickerUids.has(candidate.sticker.file_unique_id)) {
    return toolError("Duplicate sticker: already accepted this exact sticker in this reply, pick a different one");
  }

  state.acceptedStickerUids.add(candidate.sticker.file_unique_id);
  return {
    result: JSON.stringify({ success: true, queued: true, actions_used: 1 }),
    run: async (chatAction: ChatActionControl, pause: ReplyActionPause): Promise<string> => {
      if (!isActive() || signal?.aborted === true) return toolError(REPLY_INVALIDATED_TOOL_ERROR);
      const blocked: string | null = await pauseThenSettle({
        isActive,
        chatAction,
        pause,
        phase: "choose_sticker",
        delayMs: STICKER_CHOOSE_DELAY_BASE_MS + Math.random() * STICKER_CHOOSE_DELAY_JITTER_MS,
      });
      if (blocked !== null) return blocked;
      const sentMessageId: number | undefined = await sendSticker({
        chatId,
        fileId: candidate.sticker.file_id,
        signal,
        messageThreadId,
      });
      if (sentMessageId === undefined) {
        return toolError("Failed to send sticker");
      }

      onSent(describeStickerForContext(candidate.sticker, candidate.description), sentMessageId);
      return JSON.stringify({ success: true });
    },
  };
}

/** owner: workers/aiChat。AI 生图工具按群冷却占位状态（packages/aiChat/ai/tools/replyToolset/imageGeneration.ts）。 */

import { IMAGE_GENERATION_COOLDOWN_MS } from "../../../consts/aiChat/imageGeneration";
import {
  claimCooldown,
  cooldownAvailability,
  releaseCooldownClaim,
  sweepCooldownClaims,
} from "../../../libs/cooldownClaim";
import type { CooldownAvailability, CooldownClaim, CooldownClaimStore } from "../../../types/cooldown";

/**
 * 群 ID 到最近一次普通用户生图占位时间戳的映射：发起生图模型请求前由 claimImageGeneration 同步写入，未实际发出请求时由 releaseImageGenerationClaim 按 token 撤销，到期项由周期性 sweepImageGenerationCache 清理。
 * 容量与 IMAGE_GENERATION_COOLDOWN_MS 窗口内触发过生图的群数同阶；Worker 重建或 resetImageGenerationCache 时清空。
 */
export const imageGenerationClaimTimes: Map<number, number> = new Map();

const imageGenerationClaimTokens: Map<number, symbol> = new Map();

const imageGenerationStore: CooldownClaimStore = {
  claimedAt: imageGenerationClaimTimes,
  tokens: imageGenerationClaimTokens,
  cooldownMs: IMAGE_GENERATION_COOLDOWN_MS,
  tokenLabel: "image-generation-claim",
};

/** 生图冷却可用性查询与占位参数。 */
export interface ImageGenerationCooldownParams {
  chatId: number;
  bypassCooldown: boolean;
  now?: number;
}

/** 只读查询指定群当前是否允许发起生图。 */
export function getImageGenerationAvailability({
  chatId,
  bypassCooldown,
  now = Date.now(),
}: ImageGenerationCooldownParams): CooldownAvailability {
  return cooldownAvailability({ store: imageGenerationStore, chatId, bypassCooldown, now });
}

/** 在发起生图请求前同步认领该群冷却占位（bypassCooldown 为 true 时旁路普通用户冷却）。 */
export function claimImageGeneration({
  chatId,
  bypassCooldown,
  now = Date.now(),
}: ImageGenerationCooldownParams): CooldownClaim {
  return claimCooldown({ store: imageGenerationStore, chatId, bypassCooldown, now });
}

/** 按占位 token 撤销指定群的生图冷却占位。 */
export function releaseImageGenerationClaim(chatId: number, token: symbol | null): boolean {
  return releaseCooldownClaim(imageGenerationStore, chatId, token);
}

/** 清理已过 IMAGE_GENERATION_COOLDOWN_MS 或时间戳超前的生图冷却记录。 */
export function sweepImageGenerationCache(now: number = Date.now()): void {
  sweepCooldownClaims(imageGenerationStore, now);
}

/** 清空全部群的生图冷却占位时间戳与 token。 */
export function resetImageGenerationCache(): void {
  imageGenerationClaimTimes.clear();
  imageGenerationClaimTokens.clear();
}

/**
 * 生图宽高比的解析与归一，将任意正数宽高比收敛到最近的官方比例。
 */

import {
  DEFAULT_IMAGE_GENERATION_ASPECT_RATIO,
  IMAGE_GENERATION_ASPECT_RATIOS,
} from "../../../consts/aiChat/imageGeneration";
import type { ImageGenerationAspectRatio } from "../../../types/aiChat/imageGeneration";

/**
 * 将官方比例文本解析为数值宽高比。
 * @param ratio 官方宽高比字符串（如 `"16:9"`）。
 * @returns 宽度除以高度的数值比值。
 */
function aspectRatioValue(ratio: ImageGenerationAspectRatio): number {
  const [width, height]: number[] = ratio.split(":").map(Number);
  return width! / height!;
}

/** 官方比例表对应的数值宽高比。 */
const ASPECT_RATIO_VALUES: readonly number[] = IMAGE_GENERATION_ASPECT_RATIOS.map(aspectRatioValue);

/**
 * 在候选比值中取对数距离最近的一项。
 * @param target 目标数值宽高比。
 * @param candidates 候选数值宽高比列表。
 * @returns 对数距离最近的候选项下标。
 */
function closestRatioIndex(target: number, candidates: readonly number[]): number {
  let closest: number = 0;
  let closestDistance: number = Number.POSITIVE_INFINITY;
  for (let i: number = 0; i < candidates.length; i++) {
    const distance: number = Math.abs(Math.log(target / candidates[i]!));
    if (distance < closestDistance) {
      closest = i;
      closestDistance = distance;
    }
  }
  return closest;
}

/**
 * 解析宽高比字符串并收敛到最近的官方比例；写法不合法或数值无效时返回 null。
 * @param requested 用户或模型请求的宽高比字符串。
 * @returns 收敛后的官方宽高比；输入格式或数值不合法时返回 null。
 */
export function normalizeImageAspectRatio(requested: string): ImageGenerationAspectRatio | null {
  const match: RegExpExecArray | null = /^(\d+(?:\.\d+)?)\s*(?::|\/|x|×)\s*(\d+(?:\.\d+)?)$/i.exec(requested.trim());
  if (!match) return null;
  const width: number = Number(match[1]);
  const height: number = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;

  const index: number = closestRatioIndex(width / height, ASPECT_RATIO_VALUES);
  return IMAGE_GENERATION_ASPECT_RATIOS[index] ?? DEFAULT_IMAGE_GENERATION_ASPECT_RATIO;
}

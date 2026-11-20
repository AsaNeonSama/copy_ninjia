/** 实时状态页顶部四象限不规则直边折线拼块的程序化随机采样、历史滑动排重与预验证兜底布局生成模块。 */

import {
  STATUS_QUAD_DISTINCT_SIGNATURE_ATTEMPTS,
  STATUS_QUAD_HISTORY_MAX,
  STATUS_QUAD_HUB_X_MAX_PX,
  STATUS_QUAD_HUB_X_MIN_PX,
  STATUS_QUAD_HUB_Y_MAX_PX,
  STATUS_QUAD_HUB_Y_MIN_PX,
  STATUS_QUAD_MAX_SAMPLE_ATTEMPTS,
  STATUS_QUAD_MIN_LAYOUT_DELTA_PX,
  STATUS_QUAD_MIN_TOTAL_BENDS,
  STATUS_QUAD_OVERLAP_X_PX,
  STATUS_QUAD_U_MAX_PX,
  STATUS_QUAD_U_MIN_PX,
  STATUS_QUAD_V_MAX_PX,
  STATUS_QUAD_V_MIN_PX,
} from "../consts/statusMosaic";
import type {
  GenerateStatusQuadMosaicOptions,
  StatusQuadMosaicKnot,
  StatusQuadMosaicLayout,
  StatusQuadMosaicSeam,
} from "../types/statusMosaic";
import {
  buildStatusQuadLayout,
  computeGeometryDeltaPx,
  passesAllReferenceBoxes,
  roundTenth,
} from "./statusQuadGeometry";
import type { StatusQuadMosaicGeometry } from "./statusQuadGeometry";

/** 单条接缝随机采样后得到的接缝定义及对应的模式与极性标签。 */
interface SampledSeamResult {
  /** 采样生成的接缝几何参数。 */
  readonly seam: Readonly<StatusQuadMosaicSeam>;
  /** 用于拼接布局签名的模式与极性标识（如 `"0+"`、`"1-"`、`"2+"`）。 */
  readonly mode: string;
}

/** 在指定方向与安全边界内按步长区间采样跨越坐标的配置。 */
interface SampleClampedCrossOptions {
  /** 基准坐标（像素）。 */
  readonly base: number;
  /** 偏移方向系数（`1` 或 `-1`）。 */
  readonly dir: number;
  /** 步长下界（像素）。 */
  readonly minStep: number;
  /** 步长上界（像素）。 */
  readonly maxStep: number;
  /** 安全坐标下界（像素）。 */
  readonly minBound: number;
  /** 安全坐标上界（像素）。 */
  readonly maxBound: number;
}

/** 阶梯双折点接缝（Mode `2`）的共享采样配置。 */
interface SampleStepSeamOptions {
  /** 中心枢纽在当前接缝跨越维度的像素坐标。 */
  readonly hubCross: number;
  /** 偏移方向系数（`1` 或 `-1`）。 */
  readonly dir: number;
  /** 接缝是否以中心枢纽为终点。 */
  readonly hubAtEnd: boolean;
  /** 首个折点百分比下界。 */
  readonly pctMin: number;
  /** 首个折点百分比上界。 */
  readonly pctMax: number;
  /** 两折点沿接缝步距下界（像素）。 */
  readonly stepMinPx: number;
  /** 两折点沿接缝步距上界（像素）。 */
  readonly stepMaxPx: number;
  /** 跨越坐标安全下界（像素）。 */
  readonly minBound: number;
  /** 跨越坐标安全上界（像素）。 */
  readonly maxBound: number;
}

/**
 * 将数值限制在闭合区间 `[minValue, maxValue]` 内。
 *
 * @param value 待限幅的输入数值
 * @param minValue 允许下界
 * @param maxValue 允许上界
 * @returns 限幅后的数值
 */
function clampNumber(value: number, minValue: number, maxValue: number): number {
  return Math.min(maxValue, Math.max(minValue, value));
}

/**
 * 在闭区间 `[minValue, maxValue]` 内均匀采样并量化到十分位。
 *
 * @param rng `[0, 1)` 随机数生成函数
 * @param minValue 采样下界
 * @param maxValue 采样上界
 * @returns 量化到十分位的采样值
 */
function sampleRange(rng: () => number, minValue: number, maxValue: number): number {
  const unit: number = clampNumber(rng(), 0, 1);
  return roundTenth(minValue + (maxValue - minValue) * unit);
}

/**
 * 在指定基准坐标沿给定方向采样步长，并限幅到重叠带安全区间内。
 *
 * @param rng `[0, 1)` 随机数生成函数
 * @param options 基准、方向、步长与边界参数
 * @returns 量化到十分位的跨越像素坐标
 */
function sampleClampedCross(
  rng: () => number,
  options: Readonly<SampleClampedCrossOptions>
): number {
  return roundTenth(
    clampNumber(
      options.base + options.dir * sampleRange(rng, options.minStep, options.maxStep),
      options.minBound,
      options.maxBound
    )
  );
}

/**
 * 为指定基准点在当前轴向安全区间内选择偏移方向；两侧空间均充裕时随机择一侧，否则优先向更宽敞一侧偏移。
 *
 * @param rng `[0, 1)` 随机数生成函数
 * @param hubCross 中心枢纽在当前维度上的坐标
 * @param isVertical 是否为纵向接缝（`true` 使用横向重叠带 `U` 边界，`false` 使用纵向重叠带 `V` 边界）
 * @returns 向正向（`1`）或负向（`-1`）偏移的方向系数
 */
function pickRoomyDirection(
  rng: () => number,
  hubCross: number,
  isVertical: boolean
): number {
  const minBound: number = isVertical ? STATUS_QUAD_U_MIN_PX : STATUS_QUAD_V_MIN_PX;
  const maxBound: number = isVertical ? STATUS_QUAD_U_MAX_PX : STATUS_QUAD_V_MAX_PX;
  const spacePlus: number = maxBound - hubCross;
  const spaceMinus: number = hubCross - minBound;
  if (spacePlus >= 8 && spaceMinus >= 8) {
    return rng() < 0.5 ? -1 : 1;
  }
  return spacePlus >= spaceMinus ? 1 : -1;
}

/**
 * 采样一条阶梯双折点接缝（Mode `2`），供纵向与横向接缝复用。
 *
 * @param rng `[0, 1)` 随机数生成函数
 * @param options 枢纽坐标、方向、位置区间与安全边界配置
 * @returns 采样得到的阶梯接缝与 `"2+"`/`"2-"` 模式标识
 */
function sampleStepSeam(
  rng: () => number,
  options: Readonly<SampleStepSeamOptions>
): SampledSeamResult {
  const pct: number = sampleRange(rng, options.pctMin, options.pctMax);
  const stepPx: number = sampleRange(rng, options.stepMinPx, options.stepMaxPx);
  const offsetCross: number = sampleClampedCross(rng, {
    base: options.hubCross,
    dir: options.dir,
    minStep: 9.5,
    maxStep: 13,
    minBound: options.minBound,
    maxBound: options.maxBound,
  });
  const knots: readonly Readonly<StatusQuadMosaicKnot>[] = options.hubAtEnd
    ? [
      { pct, offsetPx: 0, crossPx: offsetCross },
      { pct, offsetPx: stepPx, crossPx: options.hubCross },
    ]
    : [
      { pct, offsetPx: 0, crossPx: options.hubCross },
      { pct, offsetPx: stepPx, crossPx: offsetCross },
    ];
  return {
    seam: { outerCrossPx: offsetCross, knots },
    mode: offsetCross >= options.hubCross ? "2+" : "2-",
  };
}

/**
 * 随机采样一条纵向接缝（`top` 或 `bottom`）：约 14% 概率为直斜线（Mode `0`），约 46% 概率为单折点折线（Mode `1`），约 40% 概率为阶梯双折点折线（Mode `2`）。
 *
 * @param rng `[0, 1)` 随机数生成函数
 * @param hubX 中心枢纽横向像素坐标
 * @param hubAtEnd 接缝是否以中心枢纽为终点（`top` 为 `true`，`bottom` 为 `false`）
 * @returns 采样得到的纵向接缝与模式极性签名片段
 */
function sampleVerticalSeam(
  rng: () => number,
  hubX: number,
  hubAtEnd: boolean
): SampledSeamResult {
  const dir: number = pickRoomyDirection(rng, hubX, true);
  const modeRoll: number = rng();
  if (modeRoll < 0.14) {
    const outerCrossPx: number = sampleClampedCross(rng, {
      base: hubX,
      dir,
      minStep: 5.5,
      maxStep: 9.5,
      minBound: STATUS_QUAD_U_MIN_PX,
      maxBound: STATUS_QUAD_U_MAX_PX,
    });
    return { seam: { outerCrossPx, knots: [] }, mode: outerCrossPx >= hubX ? "0+" : "0-" };
  }
  if (modeRoll < 0.60) {
    const pct: number = sampleRange(rng, hubAtEnd ? 38 : 54, hubAtEnd ? 46 : 62);
    const crossPx: number = sampleClampedCross(rng, {
      base: hubX,
      dir,
      minStep: 7.2,
      maxStep: 9.8,
      minBound: STATUS_QUAD_U_MIN_PX,
      maxBound: STATUS_QUAD_U_MAX_PX,
    });
    const outerCrossPx: number = sampleClampedCross(rng, {
      base: crossPx,
      dir: -dir,
      minStep: 7.2,
      maxStep: 9.8,
      minBound: STATUS_QUAD_U_MIN_PX,
      maxBound: STATUS_QUAD_U_MAX_PX,
    });
    return {
      seam: { outerCrossPx, knots: [{ pct, offsetPx: 0, crossPx }] },
      mode: crossPx >= hubX ? "1+" : "1-",
    };
  }
  return sampleStepSeam(rng, {
    hubCross: hubX,
    dir,
    hubAtEnd,
    pctMin: hubAtEnd ? 23 : 38,
    pctMax: hubAtEnd ? 31 : 46,
    stepMinPx: 29,
    stepMaxPx: 35,
    minBound: STATUS_QUAD_U_MIN_PX,
    maxBound: STATUS_QUAD_U_MAX_PX,
  });
}

/**
 * 随机采样一条横向接缝（`left` 或 `right`）：约 22% 概率为单折点折线（Mode `1a`/`1b`）、约 46% 概率为阶梯双折点折线（Mode `2`）、约 32% 概率为三折点锯齿凸峰折线（Mode `3`）。
 *
 * @param rng `[0, 1)` 随机数生成函数
 * @param hubY 中心枢纽纵向像素坐标
 * @param hubAtEnd 接缝是否以中心枢纽为终点（`left` 为 `true`，`right` 为 `false`）
 * @returns 采样得到的横向接缝与模式极性签名片段
 */
function sampleHorizontalSeam(
  rng: () => number,
  hubY: number,
  hubAtEnd: boolean
): SampledSeamResult {
  const dir: number = pickRoomyDirection(rng, hubY, false);
  const modeRoll: number = rng();
  if (modeRoll < 0.22) {
    const nearOuter: boolean = rng() < 0.5;
    const distancePx: number = sampleRange(rng, 42, 48);
    const pct: number = hubAtEnd ? (nearOuter ? 0 : 100) : (nearOuter ? 100 : 0);
    const offsetPx: number = hubAtEnd
      ? (nearOuter ? distancePx : roundTenth(-(STATUS_QUAD_OVERLAP_X_PX + distancePx)))
      : (nearOuter ? roundTenth(-distancePx) : roundTenth(STATUS_QUAD_OVERLAP_X_PX + distancePx));
    const crossPx: number = nearOuter
      ? (dir > 0
        ? sampleRange(rng, STATUS_QUAD_V_MAX_PX - 1.8, STATUS_QUAD_V_MAX_PX)
        : sampleRange(rng, STATUS_QUAD_V_MIN_PX, STATUS_QUAD_V_MIN_PX + 1.8))
      : sampleClampedCross(rng, {
        base: hubY,
        dir,
        minStep: 9.6,
        maxStep: 10.6,
        minBound: STATUS_QUAD_V_MIN_PX,
        maxBound: STATUS_QUAD_V_MAX_PX,
      });
    const outerCrossPx: number = sampleClampedCross(rng, {
      base: crossPx,
      dir: -dir,
      minStep: nearOuter ? 9.8 : 6.5,
      maxStep: nearOuter ? 10.6 : 10,
      minBound: STATUS_QUAD_V_MIN_PX,
      maxBound: STATUS_QUAD_V_MAX_PX,
    });
    const sign: string = crossPx >= hubY ? "+" : "-";
    return {
      seam: { outerCrossPx, knots: [{ pct, offsetPx, crossPx }] },
      mode: `${nearOuter ? "1a" : "1b"}${sign}`,
    };
  }
  if (modeRoll < 0.68) {
    return sampleStepSeam(rng, {
      hubCross: hubY,
      dir,
      hubAtEnd,
      pctMin: hubAtEnd ? 20 : 32,
      pctMax: hubAtEnd ? 38 : 50,
      stepMinPx: 29,
      stepMaxPx: 37,
      minBound: STATUS_QUAD_V_MIN_PX,
      maxBound: STATUS_QUAD_V_MAX_PX,
    });
  }
  const basePct: number = sampleRange(rng, hubAtEnd ? 18 : 28, hubAtEnd ? 22 : 34);
  const s1: number = sampleRange(rng, 28, 32);
  const s2: number = sampleRange(rng, 28, 32);
  const peak: number = sampleClampedCross(rng, {
    base: hubY,
    dir,
    minStep: 9.5,
    maxStep: 13,
    minBound: STATUS_QUAD_V_MIN_PX,
    maxBound: STATUS_QUAD_V_MAX_PX,
  });
  return {
    seam: {
      outerCrossPx: hubY,
      knots: [
        { pct: basePct, offsetPx: 0, crossPx: hubY },
        { pct: basePct, offsetPx: s1, crossPx: peak },
        { pct: basePct, offsetPx: roundTenth(s1 + s2), crossPx: hubY },
      ],
    },
    mode: peak >= hubY ? "3+" : "3-",
  };
}

/** 4 套预验证的多原型兜底布局（模块加载时一次性构建并复用；首项与 `styles/status.css` 默认裁剪多边形完全一致，签名严格对齐各接缝极性）。 */
const VERIFIED_FALLBACK_LAYOUTS: readonly Readonly<StatusQuadMosaicLayout>[] = [
  buildStatusQuadLayout({
    hubX: 14,
    hubY: 19.5,
    topSeam: { outerCrossPx: 25, knots: [{ pct: 28, offsetPx: 0, crossPx: 25 }, { pct: 28, offsetPx: 32, crossPx: 14 }] },
    bottomSeam: { outerCrossPx: 25, knots: [{ pct: 42, offsetPx: 0, crossPx: 14 }, { pct: 42, offsetPx: 32, crossPx: 25 }] },
    leftSeam: { outerCrossPx: 8.5, knots: [{ pct: 24, offsetPx: 0, crossPx: 8.5 }, { pct: 24, offsetPx: 34, crossPx: 19.5 }] },
    rightSeam: { outerCrossPx: 8.5, knots: [{ pct: 36, offsetPx: 0, crossPx: 19.5 }, { pct: 36, offsetPx: 34, crossPx: 8.5 }] },
  }, "2+|2+|2-|2-"),
  buildStatusQuadLayout({
    hubX: 22,
    hubY: 12.5,
    topSeam: { outerCrossPx: 11, knots: [{ pct: 26, offsetPx: 0, crossPx: 11 }, { pct: 26, offsetPx: 32, crossPx: 22 }] },
    bottomSeam: { outerCrossPx: 11, knots: [{ pct: 44, offsetPx: 0, crossPx: 22 }, { pct: 44, offsetPx: 32, crossPx: 11 }] },
    leftSeam: { outerCrossPx: 23.5, knots: [{ pct: 26, offsetPx: 0, crossPx: 23.5 }, { pct: 26, offsetPx: 34, crossPx: 12.5 }] },
    rightSeam: { outerCrossPx: 23.5, knots: [{ pct: 38, offsetPx: 0, crossPx: 12.5 }, { pct: 38, offsetPx: 34, crossPx: 23.5 }] },
  }, "2-|2-|2+|2+"),
  buildStatusQuadLayout({
    hubX: 14.5,
    hubY: 19.5,
    topSeam: { outerCrossPx: 25.5, knots: [{ pct: 27, offsetPx: 0, crossPx: 25.5 }, { pct: 27, offsetPx: 32, crossPx: 14.5 }] },
    bottomSeam: { outerCrossPx: 25.5, knots: [{ pct: 43, offsetPx: 0, crossPx: 14.5 }, { pct: 43, offsetPx: 32, crossPx: 25.5 }] },
    leftSeam: { outerCrossPx: 19.5, knots: [{ pct: 18, offsetPx: 0, crossPx: 19.5 }, { pct: 18, offsetPx: 29, crossPx: 8.5 }, { pct: 18, offsetPx: 58, crossPx: 19.5 }] },
    rightSeam: { outerCrossPx: 8.5, knots: [{ pct: 34, offsetPx: 0, crossPx: 19.5 }, { pct: 34, offsetPx: 34, crossPx: 8.5 }] },
  }, "2+|2+|3-|2-"),
  buildStatusQuadLayout({
    hubX: 21.5,
    hubY: 12.5,
    topSeam: { outerCrossPx: 10.5, knots: [{ pct: 27, offsetPx: 0, crossPx: 10.5 }, { pct: 27, offsetPx: 32, crossPx: 21.5 }] },
    bottomSeam: { outerCrossPx: 10.5, knots: [{ pct: 43, offsetPx: 0, crossPx: 21.5 }, { pct: 43, offsetPx: 32, crossPx: 10.5 }] },
    leftSeam: { outerCrossPx: 23.5, knots: [{ pct: 26, offsetPx: 0, crossPx: 23.5 }, { pct: 26, offsetPx: 34, crossPx: 12.5 }] },
    rightSeam: { outerCrossPx: 12.5, knots: [{ pct: 36, offsetPx: 0, crossPx: 12.5 }, { pct: 36, offsetPx: 29, crossPx: 23.5 }, { pct: 36, offsetPx: 58, crossPx: 12.5 }] },
  }, "2-|2-|2+|3+"),
];

/** 预验证的确定性默认四象限拼块布局（与 `styles/status.css` 默认 `--stat-quad-clip` 一致）。 */
export const DEFAULT_STATUS_QUAD_MOSAIC: Readonly<StatusQuadMosaicLayout> =
  VERIFIED_FALLBACK_LAYOUTS[0]!;

/**
 * 检查历史布局列表中是否已包含指定几何签名。
 *
 * @param historyList 最近历史布局列表
 * @param signature 待检查的四象限布局签名
 * @returns 历史中已存在相同签名时返回 `true`
 */
function hasSignatureInHistory(
  historyList: readonly Readonly<StatusQuadMosaicLayout>[],
  signature: string
): boolean {
  for (const entry of historyList) {
    if (entry.signature === signature) return true;
  }
  return false;
}

/**
 * 合并 `previousHistory` 与可选 `previous` 参数，截断为最近 `STATUS_QUAD_HISTORY_MAX` 条历史窗口。
 *
 * @param options 随机生成选项
 * @returns 截断后的按时间升序历史布局列表
 */
function resolveHistoryWindow(
  options: Readonly<GenerateStatusQuadMosaicOptions>
): readonly Readonly<StatusQuadMosaicLayout>[] {
  const baseHistory: readonly Readonly<StatusQuadMosaicLayout>[] = options.previousHistory ?? [];
  const previous: Readonly<StatusQuadMosaicLayout> | undefined = options.previous;
  const tail: Readonly<StatusQuadMosaicLayout> | undefined = baseHistory[baseHistory.length - 1];
  const combined: readonly Readonly<StatusQuadMosaicLayout>[] =
    previous !== undefined &&
    (tail === undefined ||
      (tail !== previous &&
        (tail.signature !== previous.signature || computeGeometryDeltaPx(tail, previous) !== 0)))
      ? [...baseHistory, previous]
      : baseHistory;
  return combined.slice(-STATUS_QUAD_HISTORY_MAX);
}

/**
 * 从预验证的多原型兜底布局中选择首个未在最近历史中出现且相对最新布局位移达标的方案；若均已出现，则选择最久未出现且与最近一轮签名不同的方案。
 *
 * @param historyList 按时间顺序排列的最近历史布局列表
 * @returns 通过全部参考尺寸几何校验的预验证兜底布局
 */
function pickVerifiedFallbackLayout(
  historyList: readonly Readonly<StatusQuadMosaicLayout>[]
): Readonly<StatusQuadMosaicLayout> {
  const latest: Readonly<StatusQuadMosaicLayout> | undefined = historyList[historyList.length - 1];
  let firstUnseen: Readonly<StatusQuadMosaicLayout> | undefined = undefined;
  for (const candidate of VERIFIED_FALLBACK_LAYOUTS) {
    if (hasSignatureInHistory(historyList, candidate.signature)) continue;
    firstUnseen ??= candidate;
    if (
      latest === undefined ||
      computeGeometryDeltaPx(candidate, latest) >= STATUS_QUAD_MIN_LAYOUT_DELTA_PX
    ) {
      return candidate;
    }
  }
  if (firstUnseen !== undefined) return firstUnseen;

  const latestSignature: string | undefined = latest?.signature;
  let chosen: Readonly<StatusQuadMosaicLayout> = VERIFIED_FALLBACK_LAYOUTS[0]!;
  let oldestLastSeenIndex: number = Number.POSITIVE_INFINITY;
  for (const candidate of VERIFIED_FALLBACK_LAYOUTS) {
    if (candidate.signature === latestSignature) continue;
    let lastSeenIndex: number = -1;
    for (let index: number = historyList.length - 1; index >= 0; index -= 1) {
      if (historyList[index]!.signature === candidate.signature) {
        lastSeenIndex = index;
        break;
      }
    }
    if (lastSeenIndex < oldestLastSeenIndex) {
      oldestLastSeenIndex = lastSeenIndex;
      chosen = candidate;
    }
  }
  return chosen;
}

/**
 * 程序化生成一套满足全视口直线折角几何约束（最小内角 `>= 75°`、最小转角 `>= 14°`、最短边 `>= 26px`、总折点数 `>= 4`、内缝均匀 `9px`）且与近期历史布局差异显著的四象限拼块布局。
 *
 * @param options 可选随机数生成器、上一轮布局及最近历史布局滑动窗口
 * @returns 可直接写入 CSS `--stat-quad-clip` 的四象限布局对象
 */
export function generateStatusQuadMosaic(
  options: GenerateStatusQuadMosaicOptions = {}
): StatusQuadMosaicLayout {
  const rng: () => number = options.random ?? Math.random;
  const historyList: readonly Readonly<StatusQuadMosaicLayout>[] = resolveHistoryWindow(options);
  const latest: Readonly<StatusQuadMosaicLayout> | undefined = historyList[historyList.length - 1];
  let distinctRejections: number = 0;

  for (let attempt: number = 0; attempt < STATUS_QUAD_MAX_SAMPLE_ATTEMPTS; attempt += 1) {
    const hubX: number = sampleRange(rng, STATUS_QUAD_HUB_X_MIN_PX, STATUS_QUAD_HUB_X_MAX_PX);
    const hubY: number = sampleRange(rng, STATUS_QUAD_HUB_Y_MIN_PX, STATUS_QUAD_HUB_Y_MAX_PX);
    const top: SampledSeamResult = sampleVerticalSeam(rng, hubX, true);
    const bottom: SampledSeamResult = sampleVerticalSeam(rng, hubX, false);
    const left: SampledSeamResult = sampleHorizontalSeam(rng, hubY, true);
    const right: SampledSeamResult = sampleHorizontalSeam(rng, hubY, false);

    const totalKnots: number =
      top.seam.knots.length +
      bottom.seam.knots.length +
      left.seam.knots.length +
      right.seam.knots.length;
    if (totalKnots < STATUS_QUAD_MIN_TOTAL_BENDS) continue;

    const geometry: StatusQuadMosaicGeometry = {
      hubX,
      hubY,
      topSeam: top.seam,
      bottomSeam: bottom.seam,
      leftSeam: left.seam,
      rightSeam: right.seam,
    };
    const signature: string = `${top.mode}|${bottom.mode}|${left.mode}|${right.mode}`;
    const duplicatesHistory: boolean = hasSignatureInHistory(historyList, signature);
    const tooCloseToLatest: boolean =
      latest !== undefined &&
      computeGeometryDeltaPx(geometry, latest) < STATUS_QUAD_MIN_LAYOUT_DELTA_PX;
    if (duplicatesHistory || tooCloseToLatest) {
      distinctRejections += 1;
      if (distinctRejections >= STATUS_QUAD_DISTINCT_SIGNATURE_ATTEMPTS) break;
      continue;
    }

    if (!passesAllReferenceBoxes(geometry)) continue;
    return buildStatusQuadLayout(geometry, signature);
  }

  return pickVerifiedFallbackLayout(historyList);
}

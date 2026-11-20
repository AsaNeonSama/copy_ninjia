/** 实时状态页顶部四象限拼块的坐标量化、CSS `polygon(...)` 格式化、多边形实体化、几何约束校验与布局位移计算模块。 */

import {
  STATUS_QUAD_CHECK_BOX_HEIGHTS_PX,
  STATUS_QUAD_CHECK_BOX_WIDTHS_PX,
  STATUS_QUAD_HALF_GAP_PX,
  STATUS_QUAD_MIN_BEND_TURN_DEG,
  STATUS_QUAD_MIN_INTERIOR_ANGLE_DEG,
  STATUS_QUAD_MIN_SEGMENT_PX,
  STATUS_QUAD_OVERLAP_X_PX,
  STATUS_QUAD_OVERLAP_Y_PX,
} from "../consts/statusMosaic";
import type {
  StatusQuadMosaicKnot,
  StatusQuadMosaicLayout,
  StatusQuadMosaicPoint,
  StatusQuadMosaicPolygons,
  StatusQuadMosaicSeam,
  StatusQuadPolygonMetrics,
} from "../types/statusMosaic";

/** 未格式化 CSS `polygon(...)` 字符串的四象限核心几何定义。 */
export interface StatusQuadMosaicGeometry {
  /** 中心十字枢纽横向基准像素坐标。 */
  readonly hubX: number;
  /** 中心十字枢纽纵向基准像素坐标。 */
  readonly hubY: number;
  /** 上半部分纵向接缝定义。 */
  readonly topSeam: Readonly<StatusQuadMosaicSeam>;
  /** 下半部分纵向接缝定义。 */
  readonly bottomSeam: Readonly<StatusQuadMosaicSeam>;
  /** 左半部分横向接缝定义。 */
  readonly leftSeam: Readonly<StatusQuadMosaicSeam>;
  /** 右半部分横向接缝定义。 */
  readonly rightSeam: Readonly<StatusQuadMosaicSeam>;
}

/** 接缝中间节点转换为 CSS 顶点或实数像素顶点时的方向配置。 */
interface KnotEmitOptions {
  /** 是否逆序遍历 `knots` 数组。 */
  readonly reverse: boolean;
  /** 是否为横向接缝（`true` 沿 X 轴分布、`crossPx` 在 Y 轴；`false` 反之）。 */
  readonly horizontal: boolean;
  /** 垂直跨越坐标是否从 `100%` 终点侧向内扣减（`true` 用于左/上象限内边界，`false` 用于右/下象限内边界）。 */
  readonly fromEnd: boolean;
}

/** 实体化接缝节点为像素顶点时的尺寸与方向配置。 */
interface KnotMaterializeOptions extends KnotEmitOptions {
  /** 单个象限格的参考像素宽度。 */
  readonly boxWidthPx: number;
  /** 单个象限格的参考像素高度。 */
  readonly boxHeightPx: number;
}

/**
 * 将数值四舍五入到十分位（0.1px / 0.1%），确保 CSS 文本输出与几何校验使用完全一致的量化坐标。
 *
 * @param value 待量化的原始数值
 * @returns 量化到 `0.1` 精度且消除 `-0` 的数值
 */
export function roundTenth(value: number): number {
  const rounded: number = Math.round(value * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

/**
 * 将数值格式化为十分位精度的 CSS 数字文本（整数省略小数位，非整数固定保留一位）。
 *
 * @param value 待格式化的数值
 * @returns CSS 数字字符串
 */
function formatCssNumber(value: number): string {
  const rounded: number = roundTenth(value);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * 将相对 `0` 侧边界的正像素偏移格式化为 CSS 坐标片段。
 *
 * @param offsetPx 相对起始边界的正像素偏移
 * @returns `"<n>px"` 格式的 CSS 坐标片段
 */
function formatFromStartPx(offsetPx: number): string {
  return `${formatCssNumber(offsetPx)}px`;
}

/**
 * 将相对 `100%` 终点边界向内回退的正像素偏移格式化为 CSS `calc(...)` 坐标片段。
 *
 * @param insetPx 相对 `100%` 边界向内收缩的正像素偏移量
 * @returns `"calc(100% - <n>px)"` 格式的 CSS 坐标片段
 */
function formatFromEndPx(insetPx: number): string {
  return `calc(100% - ${formatCssNumber(insetPx)}px)`;
}

/**
 * 将接缝控制点沿接缝主轴方向的坐标格式化为 CSS 百分比、`px` 或 `calc(...)` 表达式。
 *
 * @param knot 接缝控制节点
 * @returns 适用于 CSS `polygon(...)` 的沿接缝坐标字符串
 */
function formatAlongCoord(knot: Readonly<StatusQuadMosaicKnot>): string {
  const pct: number = roundTenth(knot.pct);
  const offsetPx: number = roundTenth(knot.offsetPx);
  if (offsetPx === 0) return `${formatCssNumber(pct)}%`;
  if (pct === 0) return `${formatCssNumber(offsetPx)}px`;
  return offsetPx > 0
    ? `calc(${formatCssNumber(pct)}% + ${formatCssNumber(offsetPx)}px)`
    : `calc(${formatCssNumber(pct)}% - ${formatCssNumber(-offsetPx)}px)`;
}

/**
 * 计算单节点沿所在象限跨度的绝对像素位置。
 *
 * @param knot 接缝控制节点
 * @param spanPx 所在象限沿该方向的像素总跨度
 * @returns 节点在该方向上的像素坐标
 */
function evaluateAlongPx(knot: Readonly<StatusQuadMosaicKnot>, spanPx: number): number {
  return (knot.pct / 100) * spanPx + knot.offsetPx;
}

/**
 * 按正序或逆序将接缝控制点直接追加为 CSS 顶点字符串，避免创建临时反转与映射数组。
 *
 * @param target 待追加 CSS 顶点串的目标数组
 * @param knots 接缝控制节点只读列表
 * @param options 遍历顺序、轴向与内缩方向配置
 */
function pushKnotCssPoints(
  target: string[],
  knots: readonly Readonly<StatusQuadMosaicKnot>[],
  options: Readonly<KnotEmitOptions>
): void {
  const count: number = knots.length;
  const overlap: number = options.horizontal ? STATUS_QUAD_OVERLAP_Y_PX : STATUS_QUAD_OVERLAP_X_PX;
  for (let step: number = 0; step < count; step += 1) {
    const knot: Readonly<StatusQuadMosaicKnot> = knots[options.reverse ? count - 1 - step : step]!;
    const along: string = formatAlongCoord(knot);
    const cross: string = options.fromEnd
      ? formatFromEndPx(overlap - knot.crossPx + STATUS_QUAD_HALF_GAP_PX)
      : formatFromStartPx(knot.crossPx + STATUS_QUAD_HALF_GAP_PX);
    target.push(options.horizontal ? `${along} ${cross}` : `${cross} ${along}`);
  }
}

/**
 * 按正序或逆序将接缝控制点直接实体化为像素多边形顶点，避免创建临时反转与映射数组。
 *
 * @param target 待追加多边形顶点的目标数组
 * @param knots 接缝控制节点只读列表
 * @param options 尺寸、遍历顺序、轴向与内缩方向配置
 */
function pushKnotMaterializedPoints(
  target: StatusQuadMosaicPoint[],
  knots: readonly Readonly<StatusQuadMosaicKnot>[],
  options: Readonly<KnotMaterializeOptions>
): void {
  const count: number = knots.length;
  const overlap: number = options.horizontal ? STATUS_QUAD_OVERLAP_Y_PX : STATUS_QUAD_OVERLAP_X_PX;
  const crossSpan: number = options.horizontal ? options.boxHeightPx : options.boxWidthPx;
  const alongSpan: number = options.horizontal ? options.boxWidthPx : options.boxHeightPx;
  for (let step: number = 0; step < count; step += 1) {
    const knot: Readonly<StatusQuadMosaicKnot> = knots[options.reverse ? count - 1 - step : step]!;
    const alongPx: number = evaluateAlongPx(knot, alongSpan);
    const crossPx: number = options.fromEnd
      ? crossSpan - (overlap - knot.crossPx + STATUS_QUAD_HALF_GAP_PX)
      : knot.crossPx + STATUS_QUAD_HALF_GAP_PX;
    target.push(
      options.horizontal
        ? { x: alongPx, y: crossPx, isBend: true }
        : { x: crossPx, y: alongPx, isBend: true }
    );
  }
}

/**
 * 由四象限几何参数与签名组装完整的 `StatusQuadMosaicLayout`（含 4 段 CSS `polygon(...)` 字符串）。
 *
 * @param geometry 枢纽坐标与四条接缝定义
 * @param signature 四条接缝模式与极性的组合签名
 * @returns 完整的四象限拼块布局对象
 */
export function buildStatusQuadLayout(
  geometry: Readonly<StatusQuadMosaicGeometry>,
  signature: string
): StatusQuadMosaicLayout {
  const overlapX: number = STATUS_QUAD_OVERLAP_X_PX;
  const overlapY: number = STATUS_QUAD_OVERLAP_Y_PX;
  const halfGap: number = STATUS_QUAD_HALF_GAP_PX;
  const { hubX, hubY, topSeam, bottomSeam, leftSeam, rightSeam }: Readonly<StatusQuadMosaicGeometry> = geometry;

  const q1Points: string[] = [
    "0 0",
    `${formatFromEndPx(overlapX - topSeam.outerCrossPx + halfGap)} 0`,
  ];
  pushKnotCssPoints(q1Points, topSeam.knots, { reverse: false, horizontal: false, fromEnd: true });
  q1Points.push(`${formatFromEndPx(overlapX - hubX + halfGap)} ${formatFromEndPx(overlapY - hubY + halfGap)}`);
  pushKnotCssPoints(q1Points, leftSeam.knots, { reverse: true, horizontal: true, fromEnd: true });
  q1Points.push(`0 ${formatFromEndPx(overlapY - leftSeam.outerCrossPx + halfGap)}`);

  const q2Points: string[] = [
    `${formatFromStartPx(topSeam.outerCrossPx + halfGap)} 0`,
    "100% 0",
    `100% ${formatFromEndPx(overlapY - rightSeam.outerCrossPx + halfGap)}`,
  ];
  pushKnotCssPoints(q2Points, rightSeam.knots, { reverse: true, horizontal: true, fromEnd: true });
  q2Points.push(`${formatFromStartPx(hubX + halfGap)} ${formatFromEndPx(overlapY - hubY + halfGap)}`);
  pushKnotCssPoints(q2Points, topSeam.knots, { reverse: true, horizontal: false, fromEnd: false });

  const q3Points: string[] = [
    `0 ${formatFromStartPx(leftSeam.outerCrossPx + halfGap)}`,
  ];
  pushKnotCssPoints(q3Points, leftSeam.knots, { reverse: false, horizontal: true, fromEnd: false });
  q3Points.push(`${formatFromEndPx(overlapX - hubX + halfGap)} ${formatFromStartPx(hubY + halfGap)}`);
  pushKnotCssPoints(q3Points, bottomSeam.knots, { reverse: false, horizontal: false, fromEnd: true });
  q3Points.push(
    `${formatFromEndPx(overlapX - bottomSeam.outerCrossPx + halfGap)} 100%`,
    "0 100%"
  );

  const q4Points: string[] = [
    `${formatFromStartPx(hubX + halfGap)} ${formatFromStartPx(hubY + halfGap)}`,
  ];
  pushKnotCssPoints(q4Points, rightSeam.knots, { reverse: false, horizontal: true, fromEnd: false });
  q4Points.push(
    `100% ${formatFromStartPx(rightSeam.outerCrossPx + halfGap)}`,
    "100% 100%",
    `${formatFromStartPx(bottomSeam.outerCrossPx + halfGap)} 100%`
  );
  pushKnotCssPoints(q4Points, bottomSeam.knots, { reverse: true, horizontal: false, fromEnd: false });

  return {
    q1Clip: `polygon(${q1Points.join(", ")})`,
    q2Clip: `polygon(${q2Points.join(", ")})`,
    q3Clip: `polygon(${q3Points.join(", ")})`,
    q4Clip: `polygon(${q4Points.join(", ")})`,
    hubX,
    hubY,
    topSeam,
    bottomSeam,
    leftSeam,
    rightSeam,
    signature,
  };
}

/**
 * 将四象限核心几何定义按指定单格像素宽高实体化为四个顺时针闭合多边形顶点列表。
 *
 * @param geometry 四象限核心几何定义
 * @param boxWidthPx 单个象限格的参考像素宽度
 * @param boxHeightPx 单个象限格的参考像素高度
 * @returns 四个象限各自的顺时针多边形顶点集合
 */
export function materializeGeometryPolygons(
  geometry: Readonly<StatusQuadMosaicGeometry>,
  boxWidthPx: number,
  boxHeightPx: number
): StatusQuadMosaicPolygons {
  const overlapX: number = STATUS_QUAD_OVERLAP_X_PX;
  const overlapY: number = STATUS_QUAD_OVERLAP_Y_PX;
  const halfGap: number = STATUS_QUAD_HALF_GAP_PX;
  const { hubX, hubY, topSeam, bottomSeam, leftSeam, rightSeam }: Readonly<StatusQuadMosaicGeometry> = geometry;

  const q1: StatusQuadMosaicPoint[] = [
    { x: 0, y: 0, isBend: false },
    { x: boxWidthPx - (overlapX - topSeam.outerCrossPx + halfGap), y: 0, isBend: false },
  ];
  pushKnotMaterializedPoints(q1, topSeam.knots, { boxWidthPx, boxHeightPx, reverse: false, horizontal: false, fromEnd: true });
  q1.push({ x: boxWidthPx - (overlapX - hubX + halfGap), y: boxHeightPx - (overlapY - hubY + halfGap), isBend: false });
  pushKnotMaterializedPoints(q1, leftSeam.knots, { boxWidthPx, boxHeightPx, reverse: true, horizontal: true, fromEnd: true });
  q1.push({ x: 0, y: boxHeightPx - (overlapY - leftSeam.outerCrossPx + halfGap), isBend: false });

  const q2: StatusQuadMosaicPoint[] = [
    { x: topSeam.outerCrossPx + halfGap, y: 0, isBend: false },
    { x: boxWidthPx, y: 0, isBend: false },
    { x: boxWidthPx, y: boxHeightPx - (overlapY - rightSeam.outerCrossPx + halfGap), isBend: false },
  ];
  pushKnotMaterializedPoints(q2, rightSeam.knots, { boxWidthPx, boxHeightPx, reverse: true, horizontal: true, fromEnd: true });
  q2.push({ x: hubX + halfGap, y: boxHeightPx - (overlapY - hubY + halfGap), isBend: false });
  pushKnotMaterializedPoints(q2, topSeam.knots, { boxWidthPx, boxHeightPx, reverse: true, horizontal: false, fromEnd: false });

  const q3: StatusQuadMosaicPoint[] = [
    { x: 0, y: leftSeam.outerCrossPx + halfGap, isBend: false },
  ];
  pushKnotMaterializedPoints(q3, leftSeam.knots, { boxWidthPx, boxHeightPx, reverse: false, horizontal: true, fromEnd: false });
  q3.push({ x: boxWidthPx - (overlapX - hubX + halfGap), y: hubY + halfGap, isBend: false });
  pushKnotMaterializedPoints(q3, bottomSeam.knots, { boxWidthPx, boxHeightPx, reverse: false, horizontal: false, fromEnd: true });
  q3.push(
    { x: boxWidthPx - (overlapX - bottomSeam.outerCrossPx + halfGap), y: boxHeightPx, isBend: false },
    { x: 0, y: boxHeightPx, isBend: false }
  );

  const q4: StatusQuadMosaicPoint[] = [
    { x: hubX + halfGap, y: hubY + halfGap, isBend: false },
  ];
  pushKnotMaterializedPoints(q4, rightSeam.knots, { boxWidthPx, boxHeightPx, reverse: false, horizontal: true, fromEnd: false });
  q4.push(
    { x: boxWidthPx, y: rightSeam.outerCrossPx + halfGap, isBend: false },
    { x: boxWidthPx, y: boxHeightPx, isBend: false },
    { x: bottomSeam.outerCrossPx + halfGap, y: boxHeightPx, isBend: false }
  );
  pushKnotMaterializedPoints(q4, bottomSeam.knots, { boxWidthPx, boxHeightPx, reverse: true, horizontal: false, fromEnd: false });

  return { q1, q2, q3, q4 };
}

/**
 * 按顺时针顶点顺序评估单个多边形在内角、凹角、折点转角与最短边长上的几何合规性。
 *
 * @param points 顺时针排列的多边形顶点列表
 * @returns 各项几何度量极值及是否全部合规的汇总结果
 */
export function evaluateStatusQuadPolygon(
  points: readonly Readonly<StatusQuadMosaicPoint>[]
): StatusQuadPolygonMetrics {
  const count: number = points.length;
  if (count < 3) {
    return {
      valid: false,
      minConvexAngleDeg: 0,
      maxReflexAngleDeg: 360,
      minBendTurnDeg: 0,
      minSegmentPx: 0,
    };
  }
  const fullCircleDeg: number = 360;
  const halfCircleDeg: number = 180;
  const maxInteriorAngleDeg: number = fullCircleDeg - STATUS_QUAD_MIN_INTERIOR_ANGLE_DEG;
  let valid: boolean = true;
  let minConvexAngleDeg: number = fullCircleDeg;
  let maxReflexAngleDeg: number = 0;
  let minBendTurnDeg: number = halfCircleDeg;
  let minSegmentPx: number = Number.POSITIVE_INFINITY;

  for (let index: number = 0; index < count; index += 1) {
    const prev: Readonly<StatusQuadMosaicPoint> = points[index === 0 ? count - 1 : index - 1]!;
    const curr: Readonly<StatusQuadMosaicPoint> = points[index]!;
    const next: Readonly<StatusQuadMosaicPoint> = points[index === count - 1 ? 0 : index + 1]!;
    const ux: number = prev.x - curr.x;
    const uy: number = prev.y - curr.y;
    const vx: number = next.x - curr.x;
    const vy: number = next.y - curr.y;
    let deg: number = (Math.atan2(vx * uy - vy * ux, ux * vx + uy * vy) * halfCircleDeg) / Math.PI;
    if (deg <= 0) deg += fullCircleDeg;
    const segLen: number = Math.hypot(vx, vy);

    minConvexAngleDeg = Math.min(minConvexAngleDeg, deg);
    if (deg > halfCircleDeg) {
      maxReflexAngleDeg = Math.max(maxReflexAngleDeg, deg);
    }
    minSegmentPx = Math.min(minSegmentPx, segLen);

    if (
      !Number.isFinite(deg) ||
      !Number.isFinite(segLen) ||
      deg < STATUS_QUAD_MIN_INTERIOR_ANGLE_DEG ||
      deg > maxInteriorAngleDeg ||
      segLen < STATUS_QUAD_MIN_SEGMENT_PX
    ) {
      valid = false;
    }

    if (curr.isBend) {
      const turnDeg: number = Math.abs(halfCircleDeg - deg);
      minBendTurnDeg = Math.min(minBendTurnDeg, turnDeg);
      if (turnDeg < STATUS_QUAD_MIN_BEND_TURN_DEG) {
        valid = false;
      }
    }
  }

  return {
    valid,
    minConvexAngleDeg,
    maxReflexAngleDeg,
    minBendTurnDeg,
    minSegmentPx,
  };
}

/**
 * 核对候选四象限几何定义在所有参考尺寸盒下的四个多边形是否全部满足几何约束。
 *
 * @param geometry 候选四象限核心几何定义
 * @returns 全部参考尺寸下全部四个象限均合法时返回 `true`
 */
export function passesAllReferenceBoxes(geometry: Readonly<StatusQuadMosaicGeometry>): boolean {
  const pairCount: number = Math.min(
    STATUS_QUAD_CHECK_BOX_WIDTHS_PX.length,
    STATUS_QUAD_CHECK_BOX_HEIGHTS_PX.length
  );
  for (let index: number = 0; index < pairCount; index += 1) {
    const polygons: StatusQuadMosaicPolygons = materializeGeometryPolygons(
      geometry,
      STATUS_QUAD_CHECK_BOX_WIDTHS_PX[index]!,
      STATUS_QUAD_CHECK_BOX_HEIGHTS_PX[index]!
    );
    if (
      !evaluateStatusQuadPolygon(polygons.q1).valid ||
      !evaluateStatusQuadPolygon(polygons.q2).valid ||
      !evaluateStatusQuadPolygon(polygons.q3).valid ||
      !evaluateStatusQuadPolygon(polygons.q4).valid
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 计算两套四象限几何定义之间在中心枢纽位置与四条接缝外端交叉坐标上的累计像素位移。
 *
 * @param first 候选四象限几何定义
 * @param second 对比参照四象限几何定义
 * @returns 中心枢纽欧氏距离与四条接缝外端跨度绝对差之和（像素）
 */
export function computeGeometryDeltaPx(
  first: Readonly<StatusQuadMosaicGeometry>,
  second: Readonly<StatusQuadMosaicGeometry>
): number {
  return (
    Math.hypot(first.hubX - second.hubX, first.hubY - second.hubY) +
    Math.abs(first.topSeam.outerCrossPx - second.topSeam.outerCrossPx) +
    Math.abs(first.bottomSeam.outerCrossPx - second.bottomSeam.outerCrossPx) +
    Math.abs(first.leftSeam.outerCrossPx - second.leftSeam.outerCrossPx) +
    Math.abs(first.rightSeam.outerCrossPx - second.rightSeam.outerCrossPx)
  );
}

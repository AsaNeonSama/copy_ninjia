/** 实时状态页顶部不规则四象限拼块的折线节点、接缝、几何校验与随机布局类型定义。 */

/** 实体化后的单个多边形顶点坐标与折点标记（相对所在象限格的像素坐标）。 */
export interface StatusQuadMosaicPoint {
  /** 顶点相对所在象限格左边缘的横向像素坐标。 */
  readonly x: number;
  /** 顶点相对所在象限格上边缘的纵向像素坐标。 */
  readonly y: number;
  /** 是否为内侧分割线上的中间折点（仅中间折点要求满足最小转角约束）。 */
  readonly isBend: boolean;
}

/** 分割接缝上的单个中间控制节点（沿接缝方向以百分比加像素偏移定位，垂直接缝方向以跨越偏移定位）。 */
export interface StatusQuadMosaicKnot {
  /** 沿接缝主轴方向的百分比坐标（`0` 到 `100`）。 */
  readonly pct: number;
  /** 在百分比坐标基础上的像素微调偏移（正负皆可）。 */
  readonly offsetPx: number;
  /** 垂直于接缝主轴方向的跨越像素位置（落在共享重叠带区间内）。 */
  readonly crossPx: number;
}

/** 四象限之间单条共享分割接缝的几何描述（从外边缘端到中间折点列）。 */
export interface StatusQuadMosaicSeam {
  /** 接缝与拼块外边缘交点处的垂直跨越像素位置。 */
  readonly outerCrossPx: number;
  /** 接缝中段依次经过的中间折点列表（直斜线模式下为空数组）。 */
  readonly knots: readonly Readonly<StatusQuadMosaicKnot>[];
}

/** 给定参考尺寸盒内实体化生成的四个象限多边形顶点序列（顺时针闭合）。 */
export interface StatusQuadMosaicPolygons {
  /** 左上象限（运行时间）的顺时针多边形顶点列表。 */
  readonly q1: readonly Readonly<StatusQuadMosaicPoint>[];
  /** 右上象限（CPU 负载）的顺时针多边形顶点列表。 */
  readonly q2: readonly Readonly<StatusQuadMosaicPoint>[];
  /** 左下象限（受管群统计）的顺时针多边形顶点列表。 */
  readonly q3: readonly Readonly<StatusQuadMosaicPoint>[];
  /** 右下象限（活跃会话）的顺时针多边形顶点列表。 */
  readonly q4: readonly Readonly<StatusQuadMosaicPoint>[];
}

/** 单个象限多边形在锐角、凹角、折点转角与最短边长上的几何校验度量结果。 */
export interface StatusQuadPolygonMetrics {
  /** 是否全部满足四象限拼块的新粗野主义直线几何约束。 */
  readonly valid: boolean;
  /** 全部顶点内角中的最小角度（度）。 */
  readonly minConvexAngleDeg: number;
  /** 全部凹顶点内角（大于 `180°`）中的最大角度（度，无凹顶点时为 `0`）。 */
  readonly maxReflexAngleDeg: number;
  /** 全部中间折点转角（`|180° - 内角|`）中的最小值（度，无中间折点时为 `180`）。 */
  readonly minBendTurnDeg: number;
  /** 全部多边形边长中的最短像素长度。 */
  readonly minSegmentPx: number;
}

/** 可直接注入 CSS `--stat-quad-clip` 的四象限随机折线拼块完整布局与几何签名。 */
export interface StatusQuadMosaicLayout {
  /** 左上象限 `clip-path: polygon(...)` 字符串。 */
  readonly q1Clip: string;
  /** 右上象限 `clip-path: polygon(...)` 字符串。 */
  readonly q2Clip: string;
  /** 左下象限 `clip-path: polygon(...)` 字符串。 */
  readonly q3Clip: string;
  /** 右下象限 `clip-path: polygon(...)` 字符串。 */
  readonly q4Clip: string;
  /** 中心十字枢纽在横向重叠带内的基准像素坐标。 */
  readonly hubX: number;
  /** 中心十字枢纽在纵向重叠带内的基准像素坐标。 */
  readonly hubY: number;
  /** 上半部分纵向接缝定义（分隔左上与右上象限）。 */
  readonly topSeam: Readonly<StatusQuadMosaicSeam>;
  /** 下半部分纵向接缝定义（分隔左下与右下象限）。 */
  readonly bottomSeam: Readonly<StatusQuadMosaicSeam>;
  /** 左半部分横向接缝定义（分隔左上与左下象限）。 */
  readonly leftSeam: Readonly<StatusQuadMosaicSeam>;
  /** 右半部分横向接缝定义（分隔右上与右下象限）。 */
  readonly rightSeam: Readonly<StatusQuadMosaicSeam>;
  /** 四条接缝模式与极性的组合签名（格式：`${topMode}|${botMode}|${leftMode}|${rightMode}`）。 */
  readonly signature: string;
}

/** `generateStatusQuadMosaic` 生成随机四象限拼块布局时的可选配置。 */
export interface GenerateStatusQuadMosaicOptions {
  /** 自定义 `[0, 1)` 随机数生成器（缺省时使用 `Math.random`）。 */
  readonly random?: () => number;
  /** 上一轮已展示的布局快照，用于在重新抽样时避开连续重复的几何签名与过小相邻位移。 */
  readonly previous?: Readonly<StatusQuadMosaicLayout>;
  /** 最近若干轮已展示的四象限布局历史（按时间顺序排列，用于多轮拓扑排重与相邻位移校验）。 */
  readonly previousHistory?: readonly Readonly<StatusQuadMosaicLayout>[];
}

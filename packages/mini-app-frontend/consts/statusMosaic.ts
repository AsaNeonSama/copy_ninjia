/** 实时状态页顶部不规则四象限拼块共享的重叠轨道尺寸、安全边界与随机采样约束常量。 */

/** 四象限 3x3 网格中间共享列的横向重叠轨道宽度（像素）。不变量：正数，与 `styles/status.css` 中 `.stat-quad-mosaic` 中列宽度一致。所属模块：`packages/mini-app-frontend/libs/statusQuadGeometry.ts`、`packages/mini-app-frontend/libs/statusQuadMosaic.ts`。 */
export const STATUS_QUAD_OVERLAP_X_PX: number = 36;

/** 四象限 3x3 网格中间共享行的纵向重叠轨道高度（像素）。不变量：正数，与 `styles/status.css` 中 `.stat-quad-mosaic` 中行高度一致。所属模块：`packages/mini-app-frontend/libs/statusQuadGeometry.ts`。 */
export const STATUS_QUAD_OVERLAP_Y_PX: number = 32;

/** 相邻象限沿共享接缝各自内缩的半缝隙宽度（像素，总留白缝隙为 `2 * STATUS_QUAD_HALF_GAP_PX = 9px`）。不变量：正数且小于 `STATUS_QUAD_U_MIN_PX` 与 `STATUS_QUAD_V_MIN_PX`。所属模块：`packages/mini-app-frontend/libs/statusQuadGeometry.ts`。 */
export const STATUS_QUAD_HALF_GAP_PX: number = 4.5;

/** 纵向接缝控制点在横向重叠带内的最小安全坐标（像素）。不变量：正数且小于 `STATUS_QUAD_U_MAX_PX`，保证左/右内缩后距边界仍有充足描边空间。所属模块：`packages/mini-app-frontend/libs/statusQuadMosaic.ts`。 */
export const STATUS_QUAD_U_MIN_PX: number = 8.5;

/** 纵向接缝控制点在横向重叠带内的最大安全坐标（像素）。不变量：大于 `STATUS_QUAD_U_MIN_PX` 且小于 `STATUS_QUAD_OVERLAP_X_PX - STATUS_QUAD_HALF_GAP_PX`。所属模块：`packages/mini-app-frontend/libs/statusQuadMosaic.ts`。 */
export const STATUS_QUAD_U_MAX_PX: number = 27.5;

/** 横向接缝控制点在纵向重叠带内的最小安全坐标（像素）。不变量：正数且小于 `STATUS_QUAD_V_MAX_PX`。所属模块：`packages/mini-app-frontend/libs/statusQuadMosaic.ts`。 */
export const STATUS_QUAD_V_MIN_PX: number = 8;

/** 横向接缝控制点在纵向重叠带内的最大安全坐标（像素）。不变量：大于 `STATUS_QUAD_V_MIN_PX` 且小于 `STATUS_QUAD_OVERLAP_Y_PX - STATUS_QUAD_HALF_GAP_PX`。所属模块：`packages/mini-app-frontend/libs/statusQuadMosaic.ts`。 */
export const STATUS_QUAD_V_MAX_PX: number = 24;

/** 中心十字枢纽横向基准坐标的采样下界（像素）。不变量：位于 `[STATUS_QUAD_U_MIN_PX, STATUS_QUAD_HUB_X_MAX_PX]` 区间内。所属模块：`packages/mini-app-frontend/libs/statusQuadMosaic.ts`。 */
export const STATUS_QUAD_HUB_X_MIN_PX: number = 13;

/** 中心十字枢纽横向基准坐标的采样上界（像素）。不变量：位于 `[STATUS_QUAD_HUB_X_MIN_PX, STATUS_QUAD_U_MAX_PX]` 区间内。所属模块：`packages/mini-app-frontend/libs/statusQuadMosaic.ts`。 */
export const STATUS_QUAD_HUB_X_MAX_PX: number = 23;

/** 中心十字枢纽纵向基准坐标的采样下界（像素）。不变量：位于 `[STATUS_QUAD_V_MIN_PX, STATUS_QUAD_HUB_Y_MAX_PX]` 区间内。所属模块：`packages/mini-app-frontend/libs/statusQuadMosaic.ts`。 */
export const STATUS_QUAD_HUB_Y_MIN_PX: number = 12;

/** 中心十字枢纽纵向基准坐标的采样上界（像素）。不变量：位于 `[STATUS_QUAD_HUB_Y_MIN_PX, STATUS_QUAD_V_MAX_PX]` 区间内。所属模块：`packages/mini-app-frontend/libs/statusQuadMosaic.ts`。 */
export const STATUS_QUAD_HUB_Y_MAX_PX: number = 20;

/** 多边形任意顶点允许的最小内角度数（对应最大凹角 `360 - 75 = 285°`，防止出现尖刺或过锐内角）。不变量：位于 `(0, 90)` 区间。所属模块：`packages/mini-app-frontend/libs/statusQuadGeometry.ts`。 */
export const STATUS_QUAD_MIN_INTERIOR_ANGLE_DEG: number = 75;

/** 内侧折线中间节点必须达到的最小转角变化度数（`|180 - 内角|`），确保折线拐角清晰可辨。不变量：正数且小于 `90`。所属模块：`packages/mini-app-frontend/libs/statusQuadGeometry.ts`。 */
export const STATUS_QUAD_MIN_BEND_TURN_DEG: number = 14;

/** 多边形任意一条边允许的最短像素长度，避免过短碎边在描边下糊成一团。不变量：正数。所属模块：`packages/mini-app-frontend/libs/statusQuadGeometry.ts`。 */
export const STATUS_QUAD_MIN_SEGMENT_PX: number = 26;

/** 整套四象限布局中四条接缝合计至少包含的中间折点数量，防止退化为折线过少的平庸分割。不变量：非负整数。所属模块：`packages/mini-app-frontend/libs/statusQuadMosaic.ts`。 */
export const STATUS_QUAD_MIN_TOTAL_BENDS: number = 4;

/** 连续采样排重窗口保留的最近历史布局最大条数，避免多轮手动刷新后回落到相近拓扑。不变量：正整数。所属模块：`packages/mini-app-frontend/libs/statusQuadMosaic.ts`、`packages/mini-app-frontend/store/status.ts`。 */
export const STATUS_QUAD_HISTORY_MAX: number = 8;

/** 候选布局相对上一轮最新布局在中心枢纽与四条外端交叉坐标上的最小累计位移像素阈值，防止连续切换变化过小。不变量：正数。所属模块：`packages/mini-app-frontend/libs/statusQuadMosaic.ts`。 */
export const STATUS_QUAD_MIN_LAYOUT_DELTA_PX: number = 10;

/** 单次生成布局时执行几何采样验证的最大尝试次数；全部未通过时回退到预验证多原型兜底布局。不变量：正整数且大于等于 `STATUS_QUAD_DISTINCT_SIGNATURE_ATTEMPTS`。所属模块：`packages/mini-app-frontend/libs/statusQuadMosaic.ts`。 */
export const STATUS_QUAD_MAX_SAMPLE_ATTEMPTS: number = 96;

/** 为避开历史签名重复或相邻位移过小而拒绝候选布局的最大重试计数上限。不变量：正整数且小于等于 `STATUS_QUAD_MAX_SAMPLE_ATTEMPTS`。所属模块：`packages/mini-app-frontend/libs/statusQuadMosaic.ts`。 */
export const STATUS_QUAD_DISTINCT_SIGNATURE_ATTEMPTS: number = 72;

/** 几何约束校验覆盖的一组典型象限盒宽度样本（对应极窄移动端、常规移动端、大屏移动端及桌面端单格宽度，像素）。不变量：长度与 `STATUS_QUAD_CHECK_BOX_HEIGHTS_PX` 相等的正数只读数组。所属模块：`packages/mini-app-frontend/libs/statusQuadGeometry.ts`。 */
export const STATUS_QUAD_CHECK_BOX_WIDTHS_PX: readonly number[] = [
  154,
  168,
  195,
  218,
  330,
  460,
];

/** 几何约束校验覆盖的一组典型象限盒高度样本（与 `STATUS_QUAD_CHECK_BOX_WIDTHS_PX` 一一配对，像素）。不变量：长度与 `STATUS_QUAD_CHECK_BOX_WIDTHS_PX` 相等的正数只读数组。所属模块：`packages/mini-app-frontend/libs/statusQuadGeometry.ts`。 */
export const STATUS_QUAD_CHECK_BOX_HEIGHTS_PX: readonly number[] = [
  120,
  128,
  136,
  154,
  136,
  140,
];

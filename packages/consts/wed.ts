/**
 * /wed 每群已发言成员滑窗的容量，也是启动校验 `memory/wed/<chatId>.json` 的项数上限；满额时新成员
 * 挤出进入时间最早的成员。所属模块：commands/wed/members.ts、libs/wedMemberFile.ts。
 */
export const WED_MEMBER_LIMIT: number = 2048;
/** /wed 成员复核跨群共用的请求起始间隔；全局按该间隔逐个检查 ID，不补发积压。 */
export const WED_MEMBER_REVIEW_INTERVAL_MS: number = 200;
/** /wed 每群保留的已送达结果上限，每位用户只保留一张结果。 */
export const WED_SESSION_LIMIT: number = 512;
/** /wed 主线程交互的全局并发上限，出站等待仍占用原执行槽。 */
export const WED_MAX_CONCURRENT: number = 32;
/**
 * /wed 每群会话表容量（已送达上限 + 执行器并发上限），保证 FifoMap 不会自行淘汰，
 * 滑出只由 commands/wed/chats.ts 的 trimWedSessions 执行。
 */
export const WED_SESSION_CAPACITY: number = WED_SESSION_LIMIT + WED_MAX_CONCURRENT;
/** /wed 尚未开始的交互全局上限；队列只保留交互上下文，不预取头像。 */
export const WED_MAX_PENDING: number = 512;
/** /wed 每轮最多核实的候选用户数；只有确认没有可用头像才计入，限制请求量。 */
export const WED_DRAW_ATTEMPTS: number = 8;
/** /wed 每轮允许的查询未完成次数；不计入 WED_DRAW_ATTEMPTS，累计到上限即放弃本轮。 */
export const WED_DRAW_TRANSIENT_LIMIT: number = 3;
/** /wed 按钮回调所属领域前缀。 */
export const WED_CALLBACK_PREFIX: string = "wed:";
/** /wed 候选查询、头像下载与图片发送/编辑的请求预算；删除和提示复用统一出站生命周期。 */
export const WED_OPERATION_TIMEOUT_MS: number = 30_000;
/** /wed 昵称展示长度上限；双昵称图注总长受 Telegram 图注上限约束。 */
export const WED_NAME_MAX_CHARS: number = 128;

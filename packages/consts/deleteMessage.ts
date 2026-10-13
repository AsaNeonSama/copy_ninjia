/** `/delete_message` command 域的容量常量。 */

/**
 * 主线程待删队列的容量：跨全部群合计、尚未交给 Telegram 删除的目标消息条数上限。
 * 队列已满时新到的目标消息不再入队，消息照常被 ingress 认领。所属模块：commands/deleteMessage/queue.ts。
 */
export const DELETE_MESSAGE_QUEUE_MAX: number = 512;

/**
 * 每个群同时处于删除状态的目标身份数上限；同群同身份只占一个名额，不淘汰已登记目标。
 * 所属模块：commands/deleteMessage.ts。
 */
export const DELETE_MESSAGE_CHAT_TARGET_MAX: number = 15;

/**
 * `/delete_message stop` 的参数结构；stop 不区分大小写，其后可选的用户名或 id 交给共享目标解析器。
 * 不匹配时整段参数都是开始删除的目标。所属模块：commands/deleteMessage.ts。
 */
export const DELETE_MESSAGE_STOP_ARGUMENT_PATTERN: RegExp = /^stop(?:\s+([\s\S]+))?$/iu;

import type { RawApi, Transformer } from "grammy";
import {
  telegramOutboundAbortController,
  telegramOutboundAccepting,
  telegramOutboundGateState,
} from "../../cache/main/telegram";
import type {
  CreateTelegramOutboundJobOptions,
  TelegramCategorizedRequestOptions,
  TelegramOutboundJob,
  TelegramRetryCategory,
} from "../../types/telegramOutbound";
import { TelegramRetryPreconditionChangedError } from "./errors";
import {
  abortJob,
  enqueueOrStart,
  resetRecoveryIfIdle,
} from "./outboundRetryLane";
import { telegramRetryCategoryFor } from "./outboundRetryPolicy";
import {
  abortReason,
  jobAbortReason,
} from "./outboundSettle";
import { admitSendJob } from "./sendScheduler";
import { telegramSignal } from "../../libs/telegramSignal";

export { abortJob, resetRecoveryIfIdle };

type PreviousCall = Parameters<Transformer<RawApi>>[0];
type UnbanChatMemberPayload = Parameters<RawApi["unbanChatMember"]>[0];
/**
 * 判断 Bot API 原始响应是否为携带成员状态字段的成功对象。
 * @param response 待检查的原始响应。
 * @returns 满足成功结构且含字符串 status 时返回 true，否则返回 false。
 */
function isRawSuccess(response: unknown): response is Readonly<{
  ok: true;
  result: Readonly<{ status: string }>;
}> {
  return typeof response === "object" && response !== null &&
    "ok" in response && response.ok === true &&
    "result" in response && typeof response.result === "object" &&
    response.result !== null && "status" in response.result &&
    typeof response.result.status === "string";
}

/**
 * 超级群的纯踢出由不带 only_if_banned 的 unbanChatMember 实现；每次重放前先经
 * getChatMember 确认目标仍在群，目标已是 left 或 kicked 时抛
 * TelegramRetryPreconditionChangedError。
 * @param previous grammY 下游调用函数。
 * @param payload unbanChatMember 的调用参数。
 * @param signal 任务取消信号。
 */
async function revalidateUnbanKickRetry(
  previous: PreviousCall,
  payload: UnbanChatMemberPayload,
  signal: AbortSignal
): Promise<void> {
  const response: unknown = await runTelegramCategorizedRequestInternal({
    category: "query",
    signal,
    execute: (requestSignal: AbortSignal): Promise<unknown> => previous("getChatMember", {
      chat_id: payload.chat_id,
      user_id: payload.user_id,
    }, telegramSignal(requestSignal)),
  }, true);
  if (!isRawSuccess(response)) {
    throw new Error("Telegram kick retry membership revalidation failed.");
  }
  switch (response.result.status) {
    case "creator":
    case "administrator":
    case "member":
    case "restricted":
      return;
    case "left":
    case "kicked":
      throw new TelegramRetryPreconditionChangedError();
    default:
      throw new Error("Telegram kick retry returned an unknown member status.");
  }
}

/**
 * 把调用方取消与当前出站 owner 代际合并，并把生命周期信号传到真实网络层。
 * @param signal 调用方传入的取消信号。
 * @returns 合并当前出站生命周期后的取消信号。
 */
function outboundSignal(signal: AbortSignal | undefined): AbortSignal {
  const lifecycleSignal: AbortSignal =
    telegramOutboundAbortController.current.signal;
  if (signal === undefined || signal === lifecycleSignal) return lifecycleSignal;
  return AbortSignal.any([signal, lifecycleSignal]);
}

/**
 * 出站 job 的唯一构造点：按固定顺序一次初始化全部字段（含递增的接纳序号），
 * 再挂上一次性 abort 监听。每条出站请求都经过这里，字段集合与顺序不得在调用点
 * 各自展开。
 * @param options 出站任务构造选项。
 * @returns 初始化并挂载 abort 监听后的出站任务。
 */
function createOutboundJob({
  signal,
  category,
  beforeRetry,
  call,
  resolve,
  reject,
}: CreateTelegramOutboundJobOptions): TelegramOutboundJob {
  const job: TelegramOutboundJob = {
    signal,
    previous: null,
    next: null,
    admissionSeq: telegramOutboundGateState.nextAdmissionSeq++,
    category,
    state: "created",
    fromRetryQueue: false,
    sendLane: null,
    sendCost: 0,
    abortListener: undefined,
    beforeRetry,
    call,
    resolve,
    reject,
  };
  job.abortListener = (): void => abortJob(job);
  job.signal.addEventListener("abort", job.abortListener, { once: true });
  return job;
}

/**
 * 分类请求的唯一构造点；quiesce 例外只供本文件内已接纳请求的前置复核。
 * @param options 分类请求选项。
 * @param allowDuringQuiesce 是否允许在静默排空阶段接纳。
 * @returns 请求兑现结果。
 */
function runTelegramCategorizedRequestInternal<T>({
  category,
  execute,
  signal,
}: TelegramCategorizedRequestOptions<T>, allowDuringQuiesce: boolean): Promise<T> {
  if (!telegramOutboundAccepting.current && !allowDuringQuiesce) {
    return Promise.reject(abortReason());
  }
  const jobSignal: AbortSignal = outboundSignal(signal);
  if (jobSignal.aborted) return Promise.reject(jobAbortReason(jobSignal));
  return new Promise<T>((
    resolve: (value: T | PromiseLike<T>) => void,
    reject: (reason?: unknown) => void
  ): void => {
    enqueueOrStart(createOutboundJob({
      signal: jobSignal,
      category,
      beforeRetry: undefined,
      call: execute,
      resolve: resolve as (value: unknown) => void,
      reject,
    }));
  });
}

/**
 * 让 Telegram 文件下载（download）与外部抓取（externalFetch）等非 Bot API HTTP 请求
 * 复用同一组分类型退避队列与出站生命周期。execute 只能发起一次尝试；返回限流响应时
 * 调度器会在对应域内重新调用它。
 * @param options 分类请求选项。
 * @returns 请求兑现结果。
 */
export function runTelegramCategorizedRequest<T>(
  options: TelegramCategorizedRequestOptions<T>
): Promise<T> {
  return runTelegramCategorizedRequestInternal(options, false);
}

/**
 * 主线程唯一 Telegram 出站闸门：经 `telegramRetryCategoryFor(method)` 分类后，`message` 类别交给每聊天发送调度器
 * （`./sendScheduler.ts` 的 `admitSendJob`）按公开限额控速与按聊天冻结退避；其余类别交给分类型退避车道
 * （`./outboundRetryLane.ts` 的 `enqueueOrStart`），收到限流响应后仅在该类别内按 `retry_after` 排队并渐进恢复。
 * @returns 安装到 grammY 客户端的出站闸门 transformer。
 */
export function telegramOutboundGate(): Transformer<RawApi> {
  // grammY 的 transformer 固定为四参数泛型回调，参数类型由 Transformer 完整约束。
  // eslint-disable-next-line @typescript-eslint/typedef, @typescript-eslint/explicit-function-return-type, max-params
  const transformer: Transformer<RawApi> = (previous, method, payload, signal) => {
    // getUpdates 是入站长轮询，不属于任何出站退避域。
    if (method === "getUpdates") return previous(method, payload, signal);
    if (!telegramOutboundAccepting.current) return Promise.reject(abortReason());
    const jobSignal: AbortSignal = outboundSignal(signal as AbortSignal | undefined);
    if (jobSignal.aborted) return Promise.reject(jobAbortReason(jobSignal));
    const category: TelegramRetryCategory = telegramRetryCategoryFor(method);
    // resolve 的实际泛型由上面的 Transformer 上下文给出，grammY 未公开 Payload。
    // eslint-disable-next-line @typescript-eslint/typedef
    return new Promise((resolve, reject): void => {
      const job: TelegramOutboundJob = createOutboundJob({
        signal: jobSignal,
        category,
        beforeRetry: method === "unbanChatMember" &&
            (payload as UnbanChatMemberPayload).only_if_banned !== true
          ? (): Promise<void> => revalidateUnbanKickRetry(
            previous,
            payload as UnbanChatMemberPayload,
            jobSignal
          )
          : undefined,
        call: (requestSignal: AbortSignal): Promise<unknown> =>
          previous(method, payload, telegramSignal(requestSignal)),
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      if (category === "message") admitSendJob(job, method, payload);
      else enqueueOrStart(job);
    });
  };
  return transformer;
}

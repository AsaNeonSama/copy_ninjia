import { GrammyError } from "grammy";
import { superviseWorker } from "./supervisedWorker";
import type {
  WorkerDuplexCancel,
  WorkerDuplexInbound,
  WorkerDuplexOutbound,
  WorkerDuplexRequest,
  WorkerDuplexResponse,
} from "../types/workerDuplex";
import type {
  SupervisedWorkerEventContext,
  SupervisedWorkerHandle,
  SupervisedWorkerOptions,
} from "./supervisedWorker";
import { toErrorOr } from "../libs/errorMessage";

/**
 * 判定 Worker 发来的消息是否为反向能力请求信封。
 * @param value 待判定的未知消息载荷。
 * @returns 为合法的 `WorkerDuplexRequest` 时返回 true，否则返回 false。
 */
function isWorkerDuplexRequest<TRequest>(
  value: unknown
): value is WorkerDuplexRequest<TRequest> {
  return value !== null && typeof value === "object" &&
    "__duplex" in value && value.__duplex === "request" &&
    "requestId" in value && typeof value.requestId === "number" &&
    "request" in value;
}

/**
 * 判定 Worker 发来的消息是否为单请求取消信封。
 * @param value 待判定的未知消息载荷。
 * @returns 为合法的 `WorkerDuplexCancel` 时返回 true，否则返回 false。
 */
function isWorkerDuplexCancel(value: unknown): value is WorkerDuplexCancel {
  return value !== null && typeof value === "object" &&
    "__duplex" in value && value.__duplex === "cancel" &&
    "requestId" in value && typeof value.requestId === "number";
}

/** 主线程能力处理器；signal 在 Worker 代际失效或单请求取消时中止。 */
export type WorkerCapabilityHandler<TRequest> = (
  request: TRequest,
  signal: AbortSignal
) => Promise<unknown>;

export interface SupervisedDuplexWorkerOptions<TMessage, TEvent, TRequest>
  extends Omit<
    SupervisedWorkerOptions<WorkerDuplexInbound<TMessage>, WorkerDuplexOutbound<TRequest> | TEvent>,
    "onEvent" | "onRespawn"
  > {
  /** 接收 Worker 回传的非双工业务事件回调。 */
  readonly onEvent?: (event: TEvent) => void;
  /** 新一代 Worker 实例创建后重放业务初始状态的回调。 */
  readonly onRespawn?: (post: (message: TMessage) => boolean) => void;
  /** 处理 Worker 发来的反向能力请求的处理器。 */
  readonly handleRequest: WorkerCapabilityHandler<TRequest>;
  /** 成功回执中可转移的大缓冲；只允许返回 value 自身拥有且主线程不再使用的 buffer。 */
  readonly responseTransfer?: (
    request: TRequest,
    value: unknown
  ) => Bun.Transferable[] | undefined;
}

/**
 * 把 Worker 业务事件与反向能力请求收敛进同一个主线程受监督双工边界。
 * @param options 双工受监督 Worker 的脚本路径、事件回调与能力请求处理器配置。
 * @returns 绑定了双工入站消息类型的受监督 Worker 句柄。
 */
export function superviseDuplexWorker<TMessage, TEvent, TRequest>(
  options: SupervisedDuplexWorkerOptions<TMessage, TEvent, TRequest>
): SupervisedWorkerHandle<WorkerDuplexInbound<TMessage>> {
  const requestMaps: WeakMap<AbortSignal, Map<number, AbortController>> = new WeakMap();
  return superviseWorker<
    WorkerDuplexInbound<TMessage>,
    WorkerDuplexOutbound<TRequest> | TEvent
  >({
    url: options.url,
    label: options.label,
    giveUpConsequence: options.giveUpConsequence,
    onGiveUp: options.onGiveUp,
    onRespawn: options.onRespawn,
    onEvent: (
      data: WorkerDuplexOutbound<TRequest> | TEvent,
      context: SupervisedWorkerEventContext<WorkerDuplexInbound<TMessage>>
    ): void => {
      if (isWorkerDuplexCancel(data)) {
        requestMaps.get(context.signal)?.get(data.requestId)?.abort();
        return;
      }
      if (!isWorkerDuplexRequest<TRequest>(data)) {
        options.onEvent?.(data);
        return;
      }
      let requests: Map<number, AbortController> | undefined =
        requestMaps.get(context.signal);
      if (requests === undefined) {
        requests = new Map();
        requestMaps.set(context.signal, requests);
      }
      const previous: AbortController | undefined = requests.get(data.requestId);
      if (previous !== undefined) previous.abort();
      const controller: AbortController = new AbortController();
      requests.set(data.requestId, controller);
      const signal: AbortSignal = AbortSignal.any([
        context.signal,
        controller.signal,
      ]);
      let execution: Promise<unknown>;
      try {
        execution = options.handleRequest(data.request, signal);
      } catch (error: unknown) {
        execution = Promise.reject(toErrorOr(error, "Worker capability handler threw."));
      }
      void execution.then(
        (value: unknown): void => {
          if (signal.aborted) return;
          const response: WorkerDuplexResponse = {
            __duplex: "response",
            requestId: data.requestId,
            ok: true,
            value,
            error: undefined,
          };
          let transfer: Bun.Transferable[] | undefined;
          try {
            transfer = options.responseTransfer?.(data.request, value);
          } catch (error: unknown) {
            context.post({
              __duplex: "response",
              requestId: data.requestId,
              ok: false,
              value: undefined,
              error: {
                name: error instanceof Error ? error.name : "Error",
                message: "Main-thread capability response transfer failed.",
                telegramErrorCode: undefined,
                telegramDescription: undefined,
              },
            });
            return;
          }
          context.post(response, transfer);
        },
        (error: unknown): void => {
          if (signal.aborted) return;
          const telegramError: GrammyError | undefined =
            error instanceof GrammyError ? error : undefined;
          context.post({
            __duplex: "response",
            requestId: data.requestId,
            ok: false,
            value: undefined,
            error: {
              name: error instanceof Error ? error.name : "Error",
              // 只回传 GrammyError.description（Bot API 返回的诊断字段），不回传普通 Error.message。
              message: telegramError?.description ??
                "Main-thread capability request failed.",
              telegramErrorCode: telegramError?.error_code,
              telegramDescription: telegramError?.description,
            },
          });
        }
      ).finally((): void => {
        if (requests.get(data.requestId) === controller) {
          requests.delete(data.requestId);
        }
      });
    },
  });
}

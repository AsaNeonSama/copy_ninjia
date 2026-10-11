/**
 * `/block enable` 与 `/block disable` 在同一身份黑名单串行区里的执行边界（commands/block.ts、
 * commands/unblock.ts）。
 *
 * handler 完成权限与目标校验后调用：先按命令到达顺序在同一身份的串行区
 * （cache/main/blocklist.ts 的 blocklistIdentityMutationRunner）占位，名单写入与落盘确认
 * （prepare）、跨群封禁或解封与回执（fanOut）都在这个串行位里依次执行，同一身份先后几条命令与
 * 广告处置按到达顺序落定。
 *
 * 串行位空闲时 prepare 在发起 update 内执行完，名单结论先于该 update 结束落定；有更早的同身份
 * 处置在途时 prepare 随扇出一起延后，update 不等它，结束时名单尚未改动。扇出交给延迟命令执行器
 * （./deferredCommands.ts）的 background 档，update runner 不等各群的 Telegram 请求；执行器满额
 * 或已停止接纳时就地执行，也排在仍在执行器里等待的同身份处置之后。任务在开跑前或等串行位
 * 期间被停机撤销时释放串行位并记错误日志，未执行的名单写入与扇出不再执行、回执不再发出；
 * 名单已写入的 `/block enable` 由启动后的全名单补扫按名单封禁。
 */

import { blocklistIdentityMutationRunner } from "../cache/main/blocklist";
import { logger } from "../infra/logger";
import { currentUpdateAbortSignal } from "../infra/updateContext";
import { submitDeferredCommand } from "./deferredCommands";

/** runBlocklistFanOut 的入参。 */
export interface RunBlocklistFanOutParams<T extends object> {
  /** 被拉黑或解除的身份；整条处置在它的黑名单串行区里执行。 */
  readonly identityId: number;
  /** 写进错误日志的英文命令名，如 `/block enable`。 */
  readonly command: string;
  /** 名单写入与落盘确认；结果交给 fanOut。 */
  readonly prepare: () => Promise<T>;
  /** 逐群封禁或解封，并在发起群发回执。 */
  readonly fanOut: (prepared: T) => Promise<void>;
}

/**
 * 占好串行位后依次执行 prepare 与 fanOut。串行位空闲时 prepare 在调用方的 update 内执行完；
 * 扇出交给执行器时立即返回，执行器拒收时就地等到串行位并执行到结束。
 */
export async function runBlocklistFanOut<T extends object>({
  identityId,
  command,
  prepare,
  fanOut,
}: RunBlocklistFanOutParams<T>): Promise<void> {
  // 占位前判定：占位之后链上必有本次。
  const idle: boolean = blocklistIdentityMutationRunner.isIdle(identityId);
  const turn: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  const release: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  // 串行位只负责排序；扇出在执行任务里运行，带执行器的停机信号与发起 update 的上下文。
  void blocklistIdentityMutationRunner.run(identityId, (): Promise<void> => {
    turn.resolve();
    return release.promise;
  });
  let prepared: T | undefined;
  if (idle) {
    await turn.promise;
    try {
      prepared = await prepare();
    } catch (error: unknown) {
      release.resolve();
      throw error;
    }
  }
  const reportCancelled = (): void => {
    logger.error(
      `Cancelled the deferred ${command} for identity ${identityId} before it ran; ` +
      `${prepared === undefined ? "the blocklist was not changed" : "the cross-chat fan-out did not run"} ` +
      "and no receipt was sent."
    );
  };
  const task = async (): Promise<void> => {
    try {
      await turn.promise;
      // 等串行位期间被停机撤销：不再改名单、不发请求。
      if (currentUpdateAbortSignal()?.aborted === true) {
        reportCancelled();
        return;
      }
      await fanOut(prepared ?? await prepare());
    } finally {
      release.resolve();
    }
  };
  if (submitDeferredCommand({
    priority: "background",
    task,
    errorLabel: `Unexpected error while running ${command} for identity ${identityId}:`,
    onSkipped: (): void => {
      release.resolve();
      reportCancelled();
    },
  })) return;
  await task();
}

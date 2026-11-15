/**
 * `/block enable` 与 `/block disable` 在单身份黑名单串行槽内的执行边界（`commands/block.ts`、`commands/unblock.ts`）：
 * - **按身份串行排序**：handler 完成权限与目标校验后，按命令到达顺序在目标身份的串行槽
 *   （`cache/main/blocklist.ts` 的 `blocklistIdentityMutationRunner`）占位；名单写入与落盘确认（`prepare`）、
 *   跨群封禁/解封与回执（`fanOut`）均在该槽位内依次执行，与同身份后续命令及广告处置严格保序。
 * - **空闲同步写入 vs 繁忙延后**：串行槽空闲时，`prepare` 在发起 update 内直接跑完，update 结束前名单结论已落定；
 *   若已有更早的同身份处置在途，`prepare` 随 `fanOut` 一并延后，不阻塞当前 update。
 * - **后台扇出与停机取消**：`fanOut` 提交至延迟命令执行器（`./deferredCommands.ts`）的 `background` 档运行，
 *   执行器满额或已关闭接纳时退回当前上下文等待串行槽就地执行。任务在开跑前或等槽位期间若被停机取消，
 *   立即释放串行槽并记错误日志，不再执行剩余步骤或发回执；名单已写入的 `/block enable` 由下次启动后的全名单补扫兜底封禁。
 */

import { blocklistIdentityMutationRunner } from "../cache/main/blocklist";
import { logger } from "../infra/logger";
import { currentUpdateAbortSignal } from "../infra/updateContext";
import { submitDeferredCommand } from "./deferredCommands";

/** 在单身份黑名单串行槽内依次执行名单持久化与跨群扇出操作的参数。 */
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
 * @param params 目标身份 ID `identityId`、命令标识 `command`、名单写入回调 `prepare` 与跨群扇出回调 `fanOut`。
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

/** owner: main。群标题刷新调度（packages/infra/chatTitle.ts）的内存状态。 */

/**
 * 启动时填充的标题维护 owner：生命周期可先 quiesce，预算到期后再 abort；容量固定为一个，进程重启时
 * 创建新 controller。`controller` 取消在途的 getChat；`absenceConfirmation` 只打断「群不可达」确证
 * 两次重查之间的等待，quiesce 与 abort 都会触发它，在途的 getChat 不受影响。
 */
export const chatTitleRefreshRuntime: {
  accepting: boolean;
  controller: AbortController;
  absenceConfirmation: AbortController;
} = {
  accepting: true,
  controller: new AbortController(),
  absenceConfirmation: new AbortController(),
};

/** owner: main。群标题刷新调度状态（packages/infra/chatTitle.ts）。 */

/**
 * 群标题刷新的准入开关与取消控制器：启动或 initChatTitleRefresh 时初始化，quiesceChatTitleRefresh 关闭准入并中止 absenceConfirmation（打断群不可达复核等待），abortChatTitleRefresh 关闭准入并中止 controller（取消在途 getChat）与 absenceConfirmation。
 * 单例固定字段，不淘汰；进程重启后重新创建。
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

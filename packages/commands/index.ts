/**
 * 指令处理聚合出口：汇总 `packages/commands/` 下各命令处理器、回调处理器与前置消息认领入口，
 * 供 `app/registerHandlers.ts` 与 `app/updatePreamble.ts` 统一导入；
 * 消息观察钩子（`wed/members`）及各领域运行时生命周期入口由 `app/` 直接按子模块导入。
 */
export { handleCjkActionCommand, handleCjkActionUsageCommand } from "./cjkAction";
export { handleCopyCommand } from "./copy";
export { handleIconCommand } from "./icon";
export { handleQuietCommand, handleUnquietCommand } from "./quiet";
export { handleMuteCommand, handleUnmuteCommand } from "./mute";
export {
  handleGagCommand,
  handleGagMessageIngress,
  handleUngagCommand,
} from "./gag";
export {
  handleDeleteMessageCommand,
  handleDeleteMessageIngress,
} from "./deleteMessage";
export {
  handleQaBoardCallback,
  handleQaMessageIngress,
  handleQaCommand,
} from "./qa";
export { handleInlineQuery } from "./inline";
export { handleBlockCommand } from "./block";
export { handleBatchKickCommand } from "./batchKick";
export { handleAiChatCommand } from "./aiChat";
export { handleClearContextCommand } from "./clearContext";
export { handleAdDetectCommand } from "./adDetect";
export { handleFloodControlCommand } from "./floodControl";
export { handleAntiRaidCommand } from "./antiRaid";
export { handleBotStatusCommand } from "./botStatus";
export { handleMoodCommand } from "./mood";
export { handleTranslateCommand } from "./translate";
export { handleInitCommand } from "./init";
export { handleSendCommand } from "./send";
export { handlePermissionCommand } from "./permission";
export { handleWhiteCommand } from "./white";
export { confirmLuckDraw, handleLuckChosenInlineResult, restoreLuckState } from "./luckChallenge/index";

export { dispatchWedCommand, dispatchWedCallback } from "./wed/dispatch";

export { handleHImageCommand } from "./hImage";
export { handleInfoCommand } from "./info";

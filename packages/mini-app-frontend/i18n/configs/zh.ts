import {
  MINI_APP_INVALID_HANDSHAKE_CODE,
  MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE,
} from "../../consts/miniAppCrypto";
import type {
  MiniAppConfigsTranslations,
  MiniAppServerNoticeParams,
} from "../../types/miniAppI18n";

/**
 * 将加密握手与配置编辑相关的服务端状态码格式化为简体中文提示。
 *
 * @param code 去除前缀后的状态码
 * @param params 可选插值参数
 * @returns 命中时返回中文文案，未命中时返回 `null`
 */
export function formatZhConfigServerNotice(
  code: string,
  params?: Readonly<MiniAppServerNoticeParams>
): string | null {
  switch (code) {
    case "INVALID_ENCRYPTED_PAYLOAD":
      return "请求或响应加密载荷校验失败，请重新解锁会话后再试哦，杂鱼♡";
    case MINI_APP_INVALID_HANDSHAKE_CODE:
      return "临时 ECDH 安全握手无效、验签失败或已过期，请刷新后重新验证解锁哦♡";
    case MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE:
      return "当前客户端环境缺失安全上下文或不支持 Ed25519 / X25519 WebCrypto 加密能力，请升级浏览器或 Telegram 客户端后再访问♡";
    case "INVALID_CONFIG_TARGET":
      return "笨蛋杂鱼♡，目标配置文件不在受管白名单里哦！";
    case "INVALID_JSON_SYNTAX":
      return params?.errorDetail !== undefined && params.errorDetail.length > 0
        ? `笨蛋杂鱼♡，JSON 语法写错啦：${params.errorDetail}`
        : "笨蛋杂鱼♡，JSON 语法格式不合法，快修好语法再保存！";
    case "CONFIG_VALIDATION_FAILED":
      return params?.errorDetail !== undefined && params.errorDetail.length > 0
        ? `配置字段校验未通过：${params.errorDetail}`
        : "配置结构校验未通过，请按错误提示修正后再保存哦♡";
    case "CONFIG_SAVED":
      return `哼，本天才已经帮杂鱼把 ${params?.fileName ?? "配置文件"} 校验并落盘保存好啦♡`;
    case "SERVICE_RESTARTED":
      return "哼，已帮杂鱼执行 systemctl restart copy-ninjia 重启指令，等几秒重连就好啦♡";
    case "SERVICE_RESTART_FAILED":
      return params?.errorDetail !== undefined && params.errorDetail.length > 0
        ? `啧，服务重启失败了：${params.errorDetail}`
        : "啧，执行 systemctl restart copy-ninjia 失败，快去检查系统权限或服务状态♡";
    default:
      return null;
  }
}

/**
 * 返回简体中文（杂鱼语气）的配置编辑器专属文案字典。
 *
 * @returns 中文配置编辑界面文案对象
 */
export function getZhConfigsTranslations(): Readonly<MiniAppConfigsTranslations> {
  return {
    dynamicTab: "动态配置",
    staticTab: "静态配置",
    refreshButton: "刷新",
    fileSelectorAria: "切换要编辑的 JSON 配置文件",
    fileExistsBadge: "磁盘就绪",
    fileMissingBadge: "尚未创建",
    dirtyBadge: "未保存修改",
    missingFileHint: (fileName: string): string =>
      `磁盘上当前还没有 ${fileName} 呢，杂鱼可以直接在下方填入合法 JSON 并保存来新建它♡`,
    editorAriaLabel: (fileName: string): string => `${fileName} JSON 代码编辑器`,
    editorPlaceholder: "{\n  \n}",
    lineStatsText: (lineCount: number, byteLength: number): string =>
      `${lineCount} 行 · ${byteLength} B`,
    syntaxValidBadge: "JSON 语法合法",
    syntaxErrorBadge: (line: number, column: number): string =>
      `第 ${line} 行第 ${column} 列语法错误`,
    syntaxErrorDetail: (line: number, column: number, reason: string): string =>
      `JSON 语法错误（第 ${line} 行，第 ${column} 列）：${reason}`,
    emptyJsonError: "笨蛋杂鱼♡，配置内容不能为空白，至少要是一个合法的 JSON 对象！",
    contentTooLargeError: (maxBytes: number): string =>
      `杂鱼♡，配置文件体积超过上限（${maxBytes} 字节），不许塞这么大的文件！`,
    errorBannerTitle: "配置校验与保存诊断",
    formatButton: "格式化",
    resetButton: "还原修改",
    saveButton: "保存",
    confirmDiscardChanges: (fileName: string): string =>
      `杂鱼，当前对 ${fileName} 的修改还没有保存哦，确定要丢弃这些未保存内容直接切换吗？`,
    confirmRestartAfterSave: (fileName: string): string =>
      `静态配置 ${fileName} 已成功写入磁盘，需要重启 copy-ninjia 服务才能生效。现在立即执行 systemctl restart copy-ninjia 重启服务吗？`,
    restartConfirmCancelButton: "暂不执行",
    restartConfirmAcceptButton: "现在执行",
    fileDescriptions: {
      "ad_detect.json": "AI 广告检测模型、提示词与判定阈值",
      "agent.json": "AI 群聊、多模态视觉与自动翻译模型配置",
      "assets.json": "随机图库目录与多媒体静态资源路径",
      "cron.json": "群定时消息、图片与语音播报任务列表",
      "mood.json": "AI 角色情绪池、人设提示词与轮换策略",
      "stickers.json": "AI 可主动发送的 Telegram 贴纸包目录",
      "bot.json": "Bot Token、超管 ID、端口与核心启动参数",
      "g-auth.json": "Google 服务账号密钥与外部鉴权凭据",
    },
  };
}

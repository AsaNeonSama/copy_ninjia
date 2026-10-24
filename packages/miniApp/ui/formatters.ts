import { MINI_APP_BIDI_CONTROL_CHARS_PATTERN } from "../../consts/miniApp";
import type { WhitelistPermissionKey } from "../../types/identityPolicy";
import type {
  MiniAppFeatureDisplayMeta,
  MiniAppFeatureKey,
} from "../../types/miniApp";

/**
 * 清除昵称或用户名中的 Unicode 双向文本控制字符（RLO/LRO/PDF 等），防止单条昵称反转整行 UI 布局。
 *
 * @param raw 原始文本
 * @returns 剥离双向控制字符后的安全展示文本
 */
export function sanitizeBidiText(raw: string): string {
  return raw.replace(MINI_APP_BIDI_CONTROL_CHARS_PATTERN, "");
}

/**
 * 将运行时长毫秒数格式化为易读的中文天/时/分/秒文本。
 *
 * @param uptimeMs 运行时长毫秒数
 * @returns 格式化后的时长字符串
 */
export function formatUptime(uptimeMs: number): string {
  const totalSeconds: number = Math.max(0, Math.floor(uptimeMs / 1000));
  const days: number = Math.floor(totalSeconds / 86_400);
  const hours: number = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes: number = Math.floor((totalSeconds % 3600) / 60);
  const seconds: number = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/**
 * 将字节数格式化为 MiB 文本。
 *
 * @param bytes 字节数
 * @returns 以 MiB 为单位的文本
 */
export function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * 将图库单张图片字节数格式化为 KiB 或 MiB 文本。
 *
 * @param bytes 文件字节数
 * @returns 格式化后的文件体积文本
 */
export function formatGalleryFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * 将 64 位 SHA-256 图库文件名缩略为首尾摘要加扩展名（如 `00493093…12c2.jpg`），便于网格卡片单行展示。
 *
 * @param fileName 原始图库文件名
 * @returns 缩略后的文件名展示文本
 */
export function shortenGalleryFileName(fileName: string): string {
  const dotIndex: number = fileName.lastIndexOf(".");
  if (dotIndex <= 16) return fileName;
  const stem: string = fileName.slice(0, dotIndex);
  const ext: string = fileName.slice(dotIndex);
  return `${stem.slice(0, 8)}…${stem.slice(-6)}${ext}`;
}

/**
 * 将 Unix 毫秒时间戳格式化为本地日期时间字符串。
 *
 * @param timestampMs Unix 毫秒时间戳
 * @returns 本地时间字符串
 */
export function formatTime(timestampMs: number): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "-";
  return new Date(timestampMs).toLocaleString("zh-CN", { hour12: false });
}

/**
 * 根据群功能键返回前端展示标题、命令名与功能描述。
 *
 * @param key 群功能开关枚举键
 * @returns 展示元数据
 */
export function getFeatureDisplayMeta(
  key: MiniAppFeatureKey
): MiniAppFeatureDisplayMeta {
  switch (key) {
    case "init":
      return {
        label: "群受管总开关",
        command: "/init",
        description: "控制该群是否启用 Bot 管理及所有子功能",
      };
    case "aiChat":
      return {
        label: "AI 聊天与主动回复",
        command: "/ai_chat",
        description: "群内 AI 提及回复、主动插话与上下文记忆",
      };
    case "translation":
      return {
        label: "自动翻译",
        command: "/translate",
        description: "按群目标语言自动翻译非目标语言消息",
      };
    case "adDetect":
      return {
        label: "AI 广告检测",
        command: "/ad_detect",
        description: "识别疑似广告并执行警告或封禁",
      };
    case "floodControl":
      return {
        label: "防刷屏限流",
        command: "/flood_control",
        description: "滑动窗口监测高频刷屏并自动禁言",
      };
    case "antiRaid":
      return {
        label: "Anti-Raid 入群验证",
        command: "/antiraid",
        description: "突发入群潮检测与新成员数学题验证",
      };
    case "proxySend":
      return {
        label: "私聊代理发言",
        command: "/send",
        description: "绑定本群为 SuperAdmin 私聊代理转发与复读目标",
      };
  }
}

/**
 * 根据白名单权限键返回中文展示名称。
 *
 * @param key 白名单权限键
 * @returns 中文权限名称
 */
export function getPermissionDisplayLabel(key: WhitelistPermissionKey): string {
  switch (key) {
    case "isCanMute":
      return "/mute 手动禁言";
    case "isCanUnMute":
      return "/unmute 解除禁言";
    case "isCanGag":
      return "/gag 互动口球";
    case "isCanViewBotStatus":
      return "/bot_status 查看状态";
    case "isCanBlock":
      return "/block 加入黑名单";
    case "isCanUnBlock":
      return "/unblock 解除黑名单";
    case "isCanWhiteOther":
      return "/white 代加白名单";
    case "isCanSwitchMood":
      return "/switch_mood 切换心情";
    case "isCanBypassAdDetection":
      return "广告检测免检";
    case "isCanBypassFloodControl":
      return "防刷屏免检";
    case "isCanControllAIPermission":
      return "/ai_chat 开关控制";
    case "isCanClearContext":
      return "/clear 清空上下文";
    case "isCanControllAdDetectPermission":
      return "/ad_detect 开关控制";
    case "isCanControllFloodControlPermission":
      return "/flood_control 开关控制";
    case "isCanControllTranslatePermission":
      return "/translate 开关控制";
    case "isCanControllAntiRaidPermission":
      return "/antiraid 开关控制";
    case "isCanControllQaPermission":
      return "/qa 问答管理";
    case "isCanAddHImage":
      return "/h_image add 收图";
  }
}

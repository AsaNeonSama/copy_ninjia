/** owner: perThread。部署配置快照的逐线程 holder（主线程解析填充权威快照，Worker 经初始化与热重载消息接管副本，崩溃重建时由主线程重放当前快照，每个 holder 为单例且整体替换、不淘汰），跨线程边界见 docs/cn/04-invariants.md。 */

import type {
  AdDetectAgentConfig,
  AdSampleConfig,
  AgentDeploymentConfig,
  MoodConfig,
  StickerConfig,
  BotConfig,
} from "../../types/config";

/** 默认心情配置（mood.json）快照单例：主线程启动预检填充、热重载整体替换；AI 闲聊 Worker 由 init 与 configReload 消息填充，重建后从 null 重新接管。 */
export const defaultMoodConfigCache: { current: MoodConfig | null } = { current: null };
/** 默认贴纸配置（stickers.json）快照单例：填充、热重载替换与 Worker 重建重放同 defaultMoodConfigCache。 */
export const defaultStickerConfigCache: { current: StickerConfig | null } = { current: null };
/** 默认广告示例配置（ad_samples.json）快照单例：主线程启动预检填充、热重载整体替换；Anti-Raid Worker 由 agentConfig 消息填充，重建后从 null 重新接管。 */
export const defaultAdSampleConfigCache: { current: AdSampleConfig | null } = { current: null };
/** AI 人设文本（prompt/persona.md 或内置人设）快照单例：主线程启动预检填充，AI 闲聊 Worker 由 init 消息填充；运行期不热重载，重建后从 null 重新接管。 */
export const personaCache: { current: string | null } = { current: null };
/** 自定义语音工具说明（prompt/voice_tool.md）快照单例：主线程启动预检填充（未放置文件时为 null），AI 闲聊 Worker 由 init 消息填充；运行期不热重载，重建后从 null 重新接管。 */
export const voiceToolPromptCache: { current: string | null } = { current: null };

/** 机器人静态配置（config/static/bot.json）快照单例：主线程启动时读盘填充，Worker 中保持为 null；运行期不热重载，进程重启后从 null 重新加载。 */
export const botConfigCache: { current: BotConfig | null } = { current: null };

/**
 * agent.json 中 `agent.ad_detect` 段配置快照单例：
 * - 主线程启动预检填充、热重载整体替换（未配置或文件删除时置为 null）；
 * - Anti-Raid Worker 由主线程在初始化、热重载与崩溃重建时投递的 agentConfig 消息全量覆盖（null 表示未配置广告检测，判定侧 fail-closed）。
 */
export const adDetectAgentConfigCache: { current: AdDetectAgentConfig | null } = { current: null };

/**
 * agent.json 中 AI 对话能力段配置快照单例：
 * - 主线程启动预检填充、热重载整体替换；
 * - AI 闲聊 Worker 由主线程在 init、configReload 与崩溃重建时投递的消息全量覆盖（null 表示未就绪）。
 */
export const agentDeploymentConfigCache: { current: AgentDeploymentConfig | null } = { current: null };

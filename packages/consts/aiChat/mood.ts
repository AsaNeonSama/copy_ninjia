import type { TimeBucket, WeatherBucket } from "../../types/aiChat/mood";
import { exhaustiveList } from "../exhaustiveList";

/** 单条心情配置必须具有的字段，用于 config/mood.ts 的严格键校验。 */
export const MOOD_ENTRY_REQUIRED_KEYS: readonly string[] = ["name", "weight", "instruction"];
/** 单条心情配置允许额外出现的可选字段。 */
export const MOOD_ENTRY_OPTIONAL_KEYS: readonly string[] = ["weatherMultipliers", "timeMultipliers"];

/** mood.json 全部基础权重之和的固定要求值。所属模块：config/mood.ts。 */
export const MOOD_WEIGHT_TOTAL: number = 100;

/** 单次心情保持时长的随机下界（不落盘）。 */
export const MOOD_REROLL_MIN_MS: number = 2 * 60 * 60_000;
/** 单次心情保持时长的随机上界。 */
export const MOOD_REROLL_MAX_MS: number = 4 * 60 * 60_000;

/** 心情查询/重抽命令等待 Worker 回执的超时及请求截止时长（见 packages/aiChat/index.ts）。 */
export const MOOD_REQUEST_TIMEOUT_MS: number = 5_000;

/**
 * 部署配置中单个天气/时段倍率的硬上限；超过时启动阶段拒绝，权重连乘与总和保持有限。
 */
export const MOOD_MULTIPLIER_MAX: number = 100;

/** 部署配置（config/dynamic/mood.json）倍率表允许使用的全部天气桶，供配置键校验。 */
export const WEATHER_BUCKETS: readonly WeatherBucket[] = exhaustiveList<WeatherBucket>()([
  "clear",
  "cloudy",
  "rain",
  "snow",
  "storm",
  "fog",
]);
/** 部署配置倍率表允许使用的全部配置时区时段桶，供配置键校验。 */
export const TIME_BUCKETS: readonly TimeBucket[] = exhaustiveList<TimeBucket>()([
  "lateNight",
  "morning",
  "daytime",
  "evening",
  "night",
]);

import { currentMoodState } from "../../cache/workers/aiChat/mood";
import { getMoodConfig } from "../../config/mood";
import { MOOD_REROLL_MAX_MS, MOOD_REROLL_MIN_MS } from "../../consts/aiChat/mood";
import { MOOD_LABEL_NAME } from "../../consts/aiChat/prompts/mood";
import { WEATHER_CODE_DESCRIPTIONS } from "../../consts/weather";
import { getLocalHour } from "../../libs/time";
import { weatherCache } from "../../cache/workers/aiChat/weather";
import type { CurrentMood, MoodOption, TimeBucket, WeatherBucket } from "../../types/aiChat/mood";

/** 按当前天气与时段调整过权重的候选心情。 */
interface WeightedMood {
  mood: MoodOption;
  weight: number;
}

/**
 * Worker 级共享心情状态：按配置档位及当前天气与时段倍率加权随机抽选，并在随机寿命到期或收到切换指令时重抽。
 */

/** 天气描述文案到粗粒度天气桶的反查表。 */
const WEATHER_DESCRIPTION_TO_BUCKET: Readonly<Record<string, WeatherBucket>> = Object.fromEntries(
  Object.entries(WEATHER_CODE_DESCRIPTIONS).map(([code, description]: [string, string]): [string, WeatherBucket] => [description, classifyWeatherCodeBucket(Number(code))])
);

/** 将 WMO 天气代码归类到粗粒度天气桶。 */
export function classifyWeatherCodeBucket(code: number): WeatherBucket {
  if (code === 0 || code === 1) return "clear";
  if (code === 2 || code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "rain";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  return "storm";
}

/** 按配置时区的小时数归类到粗粒度时段桶。 */
export function classifyTimeBucket(hour: number): TimeBucket {
  if (hour < 5) return "lateNight";
  if (hour < 9) return "morning";
  if (hour < 18) return "daytime";
  if (hour < 22) return "evening";
  return "night";
}

/** 从 weatherCache 读取当前天气桶；无缓存时返回 null。 */
function currentWeatherBucket(): WeatherBucket | null {
  const condition: string | undefined = weatherCache.current?.currentCondition;
  return condition ? WEATHER_DESCRIPTION_TO_BUCKET[condition] ?? null : null;
}

/** 计算给定天气与时段倍率调整后的心情权重（带正数下限）。 */
export function computeAdjustedWeight(mood: MoodOption, weather: WeatherBucket | null, time: TimeBucket): number {
  const weatherMultiplier: number = weather ? mood.weatherMultipliers?.[weather] ?? 1 : 1;
  const timeMultiplier: number = mood.timeMultipliers?.[time] ?? 1;
  return Math.max(mood.weight * weatherMultiplier * timeMultiplier, 0.01);
}

/** 按当前天气与时段调整后的权重随机抽取一个心情档位。 */
function pickMood(): MoodOption {
  const weather: WeatherBucket | null = currentWeatherBucket();
  const time: TimeBucket = classifyTimeBucket(getLocalHour());
  const weighted: WeightedMood[] = getMoodConfig().moods.map((mood: MoodOption): WeightedMood => ({
    mood,
    weight: computeAdjustedWeight(mood, weather, time),
  }));
  const totalWeight: number = weighted.reduce((sum: number, entry: WeightedMood): number => sum + entry.weight, 0);
  const roll: number = Math.random() * totalWeight;
  let cumulative: number = 0;
  for (const entry of weighted) {
    cumulative += entry.weight;
    if (roll <= cumulative) return entry.mood;
  }
  return weighted[weighted.length - 1]!.mood;
}

/** 立即重抽心情并更新 currentMoodState 及到期时间。 */
export function switchMood(): MoodOption {
  const mood: MoodOption = pickMood();
  currentMoodState.current = {
    mood,
    expiresAt: Date.now() + MOOD_REROLL_MIN_MS + Math.random() * (MOOD_REROLL_MAX_MS - MOOD_REROLL_MIN_MS),
  };
  return mood;
}

/** 读取当前有效心情；缺失或已过期时重抽。 */
export function currentMood(): MoodOption {
  const current: CurrentMood | null = currentMoodState.current;
  if (current === null || Date.now() >= current.expiresAt) return switchMood();
  return current.mood;
}

/** 拼装写入运行时状态区块的当前心情指令。 */
export function currentMoodInstruction(): string {
  const mood: MoodOption = currentMood();
  return `【${MOOD_LABEL_NAME}：${mood.name}】${mood.instruction}`;
}

/**
 * 配置热重载后将当前心情对齐到新快照中的同名档位并保留剩余寿命；同名档位已移除时清空缓存。
 */
export function refreshMood(): void {
  const current: CurrentMood | null = currentMoodState.current;
  if (current === null) return;
  const next: MoodOption | undefined = getMoodConfig().moods.find((option: MoodOption): boolean => option.name === current.mood.name);
  currentMoodState.current = next === undefined ? null : { mood: next, expiresAt: current.expiresAt };
}

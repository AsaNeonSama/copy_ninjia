/** AI 心情系统的领域类型。 */

/** 心情抽取权重倍率使用的天气分类桶（由 WMO 天气码经 aiChat/ai/mood.ts 的 classifyWeatherCodeBucket 归类）。 */
export type WeatherBucket = "clear" | "cloudy" | "rain" | "snow" | "storm" | "fog";
/** 心情抽取权重倍率使用的配置时区时段桶（由当前小时经 aiChat/ai/mood.ts 的 classifyTimeBucket 归类）。 */
export type TimeBucket = "lateNight" | "morning" | "daytime" | "evening" | "night";

/**
 * 一档心情，从 config/dynamic/mood.json 解析得到，字段全部 `readonly`。
 */
export interface MoodOption {
  readonly name: string;
  readonly weight: number;
  readonly instruction: string;
  readonly weatherMultipliers?: Readonly<Partial<Record<WeatherBucket, number>>>;
  readonly timeMultipliers?: Readonly<Partial<Record<TimeBucket, number>>>;
}

/** 当前生效的心情档位与它的到期时刻（epoch 毫秒）；两者总是一起写入。 */
export interface CurrentMood {
  readonly mood: MoodOption;
  readonly expiresAt: number;
}

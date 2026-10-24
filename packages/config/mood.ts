import { defaultMoodConfigCache } from "../cache/perThread/config";
import {
  MOOD_ENTRY_OPTIONAL_KEYS,
  MOOD_ENTRY_REQUIRED_KEYS,
  MOOD_MULTIPLIER_MAX,
  MOOD_WEIGHT_TOTAL,
  TIME_BUCKETS,
  WEATHER_BUCKETS,
} from "../consts/aiChat/mood";
import { MOOD_CONFIG_PATH } from "../consts/paths";
import { cartesianProduct } from "../libs/cartesianProduct";
import { invalidInput, readJsonInput, requiredString } from "../libs/inputValidation";
import { hasExactKeys, hasOnlyKeys, isPlainRecord } from "../libs/record";
import type { MoodOption, TimeBucket, WeatherBucket } from "../types/aiChat/mood";
import type { MoodConfig } from "../types/config";

/** parseMultipliers 的入参：允许的桶名全集，以及报错要点名的字段路径与文件路径。 */
interface MultiplierParseOptions<Bucket extends string> {
  /** 该维度允许的合法桶名全集。 */
  readonly allowedBuckets: readonly Bucket[];
  /** 倍率表字段的 JSONPath，用于构造致命错误诊断。 */
  readonly fieldPath: string;
  /** 配置文件路径，用于构造致命错误诊断。 */
  readonly sourcePath: string;
}

/**
 * 解码倍率表：键必须是对应维度的合法桶名，倍率必须是不超过 MOOD_MULTIPLIER_MAX 的正有限数。
 * 非法键与非法值分别以 `<fieldPath>.<key>`、`<fieldPath>.<value>` 报出。
 * @param value 待校验的倍率表字段值。
 * @param options 允许桶名集合与错误诊断路径。
 * @returns 按合法桶名索引的倍率映射表。
 */
function parseMultipliers<Bucket extends string>(
  value: unknown,
  { allowedBuckets, fieldPath, sourcePath }: MultiplierParseOptions<Bucket>
): Partial<Record<Bucket, number>> {
  if (!isPlainRecord(value)) {
    return invalidInput(sourcePath, fieldPath, "an object keyed by supported buckets");
  }
  const allowed: ReadonlySet<string> = new Set(allowedBuckets);
  const multipliers: Partial<Record<Bucket, number>> = Object.create(null) as Partial<Record<Bucket, number>>;
  for (const [bucket, multiplier] of Object.entries(value)) {
    if (!allowed.has(bucket)) {
      return invalidInput(sourcePath, `${fieldPath}.<key>`, "a supported bucket name");
    }
    if (
      typeof multiplier !== "number" ||
      !Number.isFinite(multiplier) ||
      multiplier <= 0 ||
      multiplier > MOOD_MULTIPLIER_MAX
    ) {
      return invalidInput(
        sourcePath,
        `${fieldPath}.<value>`,
        `a positive finite number no greater than ${MOOD_MULTIPLIER_MAX}`
      );
    }
    multipliers[bucket as Bucket] = multiplier;
  }
  return multipliers;
}

/**
 * 解码单个心情档位；name 与 instruction 去掉首尾空白后返回。必填字段缺失、未知字段和
 * 非法取值都在启动阶段直接报错。
 * @param value 待校验的心情档位条目值。
 * @param index 条目在 `moods` 数组中的下标。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns 已通过校验的心情档位定义。
 */
function parseMoodOption(value: unknown, index: number, sourcePath: string): MoodOption {
  const fieldPath: string = `$.moods[${index}]`;
  if (!isPlainRecord(value)) {
    return invalidInput(sourcePath, fieldPath, "a mood object");
  }
  if (!hasOnlyKeys(value, [...MOOD_ENTRY_REQUIRED_KEYS, ...MOOD_ENTRY_OPTIONAL_KEYS])) {
    return invalidInput(sourcePath, `${fieldPath}.<key>`, "a current mood schema field");
  }
  const name: string = requiredString(value.name, `${fieldPath}.name`, sourcePath);
  if (typeof value.weight !== "number" || !Number.isInteger(value.weight) || value.weight <= 0) {
    return invalidInput(sourcePath, `${fieldPath}.weight`, "a positive integer");
  }
  const instruction: string = requiredString(value.instruction, `${fieldPath}.instruction`, sourcePath);

  const mood: MoodOption = {
    name,
    weight: value.weight,
    instruction,
    ...(value.weatherMultipliers !== undefined
      ? { weatherMultipliers: parseMultipliers<WeatherBucket>(value.weatherMultipliers, {
        allowedBuckets: WEATHER_BUCKETS,
        fieldPath: `${fieldPath}.weatherMultipliers`,
        sourcePath,
      }) }
      : {}),
    ...(value.timeMultipliers !== undefined
      ? { timeMultipliers: parseMultipliers<TimeBucket>(value.timeMultipliers, {
        allowedBuckets: TIME_BUCKETS,
        fieldPath: `${fieldPath}.timeMultipliers`,
        sourcePath,
      }) }
      : {}),
  };
  return mood;
}

/**
 * 穷举全部天气/时段组合，校验每个调整权重为有限正数且累计总权重为有限数。
 * @param moods 已解码的心情档位列表。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 */
function validateAdjustedWeights(moods: readonly MoodOption[], sourcePath: string): void {
  const weatherBuckets: readonly (WeatherBucket | null)[] =
    [null, ...WEATHER_BUCKETS];
  for (const { weather, time } of cartesianProduct({ weather: weatherBuckets, time: TIME_BUCKETS })) {
    let totalWeight: number = 0;
    for (const mood of moods) {
      const weatherMultiplier: number =
        weather === null ? 1 : mood.weatherMultipliers?.[weather] ?? 1;
      const timeMultiplier: number = mood.timeMultipliers?.[time] ?? 1;
      const adjustedWeight: number =
        mood.weight * weatherMultiplier * timeMultiplier;
      if (!Number.isFinite(adjustedWeight) || adjustedWeight <= 0) {
        return invalidInput(sourcePath, "$.moods", "finite positive adjusted weights for every bucket combination");
      }
      totalWeight += adjustedWeight;
    }
    if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
      return invalidInput(sourcePath, "$.moods", "a finite positive total weight for every bucket combination");
    }
  }
}

/**
 * 严格解码 mood.json；base weight 必须是正整数且总和恰好为 MOOD_WEIGHT_TOTAL。
 * @param value 待校验的原始 JSON 值。
 * @param sourcePath 配置文件路径，用于构造致命错误诊断。
 * @returns 已通过校验的心情配置。
 */
export function parseMoodConfig(
  value: unknown,
  sourcePath: string = MOOD_CONFIG_PATH
): MoodConfig {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["moods"]) || !Array.isArray(value.moods)) {
    return invalidInput(sourcePath, "$", "exactly { moods: MoodOption[] }");
  }
  if (value.moods.length === 0) return invalidInput(sourcePath, "$.moods", "a non-empty array");

  const seen: Set<string> = new Set();
  const moods: MoodOption[] = value.moods.map((entry: unknown, index: number): MoodOption => {
    const mood: MoodOption = parseMoodOption(entry, index, sourcePath);
    if (seen.has(mood.name)) return invalidInput(sourcePath, `$.moods[${index}].name`, "unique");
    seen.add(mood.name);
    return mood;
  });

  const weightSum: number = moods.reduce((sum: number, mood: MoodOption): number => sum + mood.weight, 0);
  if (weightSum !== MOOD_WEIGHT_TOTAL) {
    return invalidInput(sourcePath, "$.moods[*].weight", `positive integers summing to ${MOOD_WEIGHT_TOTAL}`);
  }
  validateAdjustedWeights(moods, sourcePath);
  return { moods };
}

/**
 * 从 MOOD_CONFIG_PATH 加载并校验；模块 import 本身不访问文件系统。
 * @returns 已通过校验的心情配置。
 */
export async function loadMoodConfig(): Promise<MoodConfig> {
  return parseMoodConfig(await readJsonInput(MOOD_CONFIG_PATH), MOOD_CONFIG_PATH);
}

/**
 * 接管已经严格校验的心情配置快照：启动预检、Worker 初始化消息或 config/dynamic/ 热重载。
 * null 只来自主线程热重载，表示部署方删除了该文件。
 * @param config 已校验的心情配置，或表示文件已移除的 null。
 */
export function adoptMoodConfig(config: MoodConfig | null): void {
  defaultMoodConfigCache.current = config;
}

/** 启动预检填充默认路径快照；重复调用只读 holder。 */
export async function ensureMoodConfig(): Promise<void> {
  if (defaultMoodConfigCache.current !== null) return;
  adoptMoodConfig(await loadMoodConfig());
}

/**
 * 默认心情配置只读当前线程已校验的快照，不在运行期回退读盘。
 * @returns 当前线程已接管的心情配置。
 */
export function getMoodConfig(): MoodConfig {
  const config: MoodConfig | null = defaultMoodConfigCache.current;
  if (config === null) {
    throw new Error(`Mood configuration was not initialized from ${MOOD_CONFIG_PATH}.`);
  }
  return config;
}

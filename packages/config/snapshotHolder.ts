/**
 * `config/dynamic/*.json` 单例快照的冷路径加载与补齐模板；
 * 各配置模块按单态读取各自快照，不共用泛型读取入口，避免热读发生多态退化。
 */

import { readJsonInput } from "../libs/inputValidation";
import type { ConfigSnapshotHolder } from "../types/config";

/**
 * 从配置文件路径读取 JSON 并用严格解析器解码。
 * @param path 配置文件路径。
 * @param parse 对应领域的严格配置解码函数。
 * @returns 已通过严格校验的配置对象。
 */
export async function loadJsonConfig<T>(
  path: string,
  parse: (value: unknown, sourcePath: string) => T
): Promise<T> {
  return parse(await readJsonInput(path), path);
}

/**
 * 若当前线程快照容器尚未填充，则调用冷路径加载函数并写入默认快照。
 * @param holder 当前线程的可变配置快照容器。
 * @param load 从默认路径加载并严格校验配置的异步函数。
 */
export async function ensureConfigSnapshot<T>(
  holder: ConfigSnapshotHolder<T>,
  load: () => Promise<T>
): Promise<void> {
  if (holder.current !== null) return;
  holder.current = await load();
}

export interface FlushDirtyEntriesParams<K, V> {
  dirty: Set<K>;
  cache: Map<K, V>;
  write: (key: K, snapshot: V) => void;
  describeFailure: (key: K) => string;
}

/** 遍历 dirty 集合逐项写入缓存快照；写成功或缓存已移除时清除 dirty 标记，失败保留标记并记录错误。 */
export function flushDirtyEntries<K, V>({
  dirty,
  cache,
  write,
  describeFailure,
}: FlushDirtyEntriesParams<K, V>): void {
  for (const key of dirty) {
    const snapshot: V | undefined = cache.get(key);
    if (!snapshot) {
      dirty.delete(key);
      continue;
    }
    try {
      write(key, snapshot);
      dirty.delete(key);
    } catch (error: unknown) {
      console.error(describeFailure(key), error);
    }
  }
}

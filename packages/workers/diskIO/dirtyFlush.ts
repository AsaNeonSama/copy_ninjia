/** 遍历脏键集合并将对应缓存快照落盘的参数。 */
export interface FlushDirtyEntriesParams<K, V> {
  /** 待落盘的脏键集合（写成功或缓存已不存在时原地摘除）。 */
  dirty: Set<K>;
  /** 持有最新快照的内存缓存映射。 */
  cache: Map<K, V>;
  /** 将单个键的快照写入磁盘的同步函数。 */
  write: (key: K, snapshot: V) => void;
  /** 构造单键写入失败日志前缀的格式化函数。 */
  describeFailure: (key: K) => string;
}

/**
 * 遍历 dirty 集合逐项写入缓存快照；写成功或缓存已移除时清除 dirty 标记，失败保留标记并记录错误。
 * @param params 脏键集合、快照缓存、写盘回调与错误描述构造器。
 */
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

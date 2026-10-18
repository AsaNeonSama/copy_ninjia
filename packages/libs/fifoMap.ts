/**
 * 固定容量、按插入顺序淘汰的 Map（FIFO）。
 *
 * 条目存成固定 shape 的节点（`key`、`value`、`newer`、`older`），节点另串成一条按插入顺序的侵入式
 * 双向链表，容器单独持有 `oldest`/`newest` 端点：取最早项、满载淘汰都是 O(1)。全仓有界
 * FIFO 一律用本容器；packages/ 内不得在 Map / Set 上用 `keys()`、`values()`、`entries()` 的
 * `.next()` 取最早项（`check:conventions` 拦截）。
 *
 * 语义：
 * - `get` / `has` 不改变顺序。
 * - `set` 写已有键只改值、不移位（与 Map 相同）；写新键时若已达容量，先淘汰最早项再插到最新端。
 *   要把已有键挪到最新端，先 `delete` 再 `set`。
 * - 迭代（`keys` / `values` / `entries` / `forEach` / for...of）从最早到最新；迭代中只允许删除
 *   当前项，删除其它项或写入新键的结果未定义。
 *
 * libs/lruCache.ts 的 LruCache 继承本类，只在命中时额外把节点挪到最新端。
 */

/** 一个条目；`newer` / `older` 为 null 分别表示本节点在最新端 / 最早端。 */
export interface FifoNode<K, V> {
  readonly key: K;
  value: V;
  newer: FifoNode<K, V> | null;
  older: FifoNode<K, V> | null;
}

export class FifoMap<K, V> {
  protected readonly map: Map<K, FifoNode<K, V>> = new Map();
  protected oldest: FifoNode<K, V> | null = null;
  protected newest: FifoNode<K, V> | null = null;

  constructor(protected readonly maxEntries: number) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError("maxEntries must be a positive safe integer");
    }
  }

  get size(): number {
    return this.map.size;
  }

  /** 键是否存在，不影响顺序。 */
  has(key: K): boolean {
    return this.map.has(key);
  }

  /** 读取一个键的值，不影响顺序；未命中返回 undefined（存了 undefined 值的键同样返回 undefined）。 */
  get(key: K): V | undefined {
    return this.map.get(key)?.value;
  }

  /** 已有键只改值不移位；新键在达到容量时先淘汰最早项，再插到最新端。 */
  set(key: K, value: V): void {
    const existing: FifoNode<K, V> | undefined = this.map.get(key);
    if (existing !== undefined) {
      existing.value = value;
      return;
    }
    this.insertNewest(key, value);
  }

  delete(key: K): boolean {
    const node: FifoNode<K, V> | undefined = this.map.get(key);
    if (node === undefined) return false;
    this.map.delete(key);
    this.unlink(node);
    return true;
  }

  /** 清空全部条目。 */
  clear(): void {
    this.map.clear();
    this.oldest = null;
    this.newest = null;
  }

  /** 最早插入（下一个会被淘汰）的键；空表返回 undefined。O(1)。 */
  oldestKey(): K | undefined {
    return this.oldest?.key;
  }

  /** 从最早到最新回调每一项；回调里只允许删除当前项。 */
  forEach(callback: (value: V, key: K) => void): void {
    let node: FifoNode<K, V> | null = this.oldest;
    while (node !== null) {
      const next: FifoNode<K, V> | null = node.newer;
      callback(node.value, node.key);
      node = next;
    }
  }

  /** 从最早到最新的键；迭代中只允许删除当前项。 */
  *keys(): Generator<K, void, undefined> {
    let node: FifoNode<K, V> | null = this.oldest;
    while (node !== null) {
      const next: FifoNode<K, V> | null = node.newer;
      yield node.key;
      node = next;
    }
  }

  /** 从最早到最新的值；迭代中只允许删除当前项。 */
  *values(): Generator<V, void, undefined> {
    let node: FifoNode<K, V> | null = this.oldest;
    while (node !== null) {
      const next: FifoNode<K, V> | null = node.newer;
      yield node.value;
      node = next;
    }
  }

  /** 从最早到最新的 `[键, 值]`；迭代中只允许删除当前项。 */
  *entries(): Generator<[K, V], void, undefined> {
    let node: FifoNode<K, V> | null = this.oldest;
    while (node !== null) {
      const next: FifoNode<K, V> | null = node.newer;
      yield [node.key, node.value];
      node = next;
    }
  }

  [Symbol.iterator](): Generator<[K, V], void, undefined> {
    return this.entries();
  }

  /** 插入一个新键到最新端；已达容量时先淘汰最早项。调用方保证键不存在。 */
  protected insertNewest(key: K, value: V): void {
    if (this.map.size >= this.maxEntries) {
      const oldest: FifoNode<K, V> | null = this.oldest;
      if (oldest !== null) {
        this.map.delete(oldest.key);
        this.unlink(oldest);
      }
    }
    const node: FifoNode<K, V> = { key, value, newer: null, older: null };
    this.map.set(key, node);
    this.linkNewest(node);
  }

  /**
   * 把节点从链上摘下来。
   *
   * 只能对仍在链上的节点调用：对已经摘过的节点再摘一次，会把 `newest` 与 `oldest`
   * 一起置空。调用点（`delete` 先查 Map、容量淘汰摘 `oldest`、LruCache 命中摘下立刻
   * 重新挂上）都保证这一点；新增调用点必须自己先确认节点还在链上，这里不加运行期断言。
   */
  protected unlink(node: FifoNode<K, V>): void {
    const newer: FifoNode<K, V> | null = node.newer;
    const older: FifoNode<K, V> | null = node.older;
    if (newer === null) this.newest = older;
    else newer.older = older;
    if (older === null) this.oldest = newer;
    else older.newer = newer;
    node.newer = null;
    node.older = null;
  }

  protected linkNewest(node: FifoNode<K, V>): void {
    const previousNewest: FifoNode<K, V> | null = this.newest;
    node.newer = null;
    node.older = previousNewest;
    if (previousNewest === null) this.oldest = node;
    else previousNewest.newer = node;
    this.newest = node;
  }
}

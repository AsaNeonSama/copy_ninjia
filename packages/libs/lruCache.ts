/**
 * 固定容量的 LRU 缓存。
 *
 * 继承 libs/fifoMap.ts 的 FifoMap：条目与链表结构、容量淘汰（新增第 maxEntries + 1 项前淘汰
 * 最旧节点）、`has` / `delete` / `clear` / 迭代都沿用基类；本类只在 `get` 命中与覆盖已有键时
 * 把节点挪到最新端（只调整链表指针，不改写底层 Map）。`peek` 读值不影响顺序。
 */

import { FifoMap } from "./fifoMap";
import type { FifoNode } from "./fifoMap";

export class LruCache<K, V> extends FifoMap<K, V> {
  /** 读取一个键；命中时顺带把它标记为最近使用。未命中返回 undefined。
   *  命中判据是「有没有这个 node」，不看取值是否为 undefined：存了 undefined 值的键
   *  同样命中并刷新热度。 */
  override get(key: K): V | undefined {
    const node: FifoNode<K, V> | undefined = this.map.get(key);
    if (node === undefined) return undefined;
    this.touch(node);
    return node.value;
  }

  /** 不影响使用顺序地查看一个键的当前值，用于"这个 key 现在还是不是我
   *  插入的那份"之类的引用比对。 */
  peek(key: K): V | undefined {
    return this.map.get(key)?.value;
  }

  /** 写入一个键（新增或覆盖），视为一次最近使用；超容量时淘汰最久未使用的一项。 */
  override set(key: K, value: V): void {
    const existing: FifoNode<K, V> | undefined = this.map.get(key);
    if (existing !== undefined) {
      existing.value = value;
      this.touch(existing);
      return;
    }
    this.insertNewest(key, value);
  }

  /** 命中续命：已经在最新端时不做无效指针写入。 */
  private touch(node: FifoNode<K, V>): void {
    if (this.newest === node) return;
    this.unlink(node);
    this.linkNewest(node);
  }
}

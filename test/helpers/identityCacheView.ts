import { identityPolicyCache } from "../../packages/cache/main/identityStorage";
import type { IdentityPolicyCacheEntry } from "../../packages/types/identityStorage";

type IdentityCacheField = keyof IdentityPolicyCacheEntry;

/** 某一项已加载时的取值（null 为确证不存在）。 */
type LoadedValue<F extends IdentityCacheField> = Exclude<IdentityPolicyCacheEntry[F], undefined>;

/**
 * 合并身份缓存（cache/main/identityStorage.ts 的 identityPolicyCache）按单个字段的测试视图。
 *
 * 用例按「某一项」预置或断言：has / size 只看该字段是否已加载（不为 undefined），set 在条目不存在
 * 时建三字段条目、其余两项为未加载；delete / clear 只把该字段改回未加载，三项都未加载的条目随之删除。
 * get 与生产读口一样刷新条目热度，peek 不刷新。
 */
export interface IdentityFieldView<F extends IdentityCacheField> {
  readonly size: number;
  set(id: number, value: LoadedValue<F>): void;
  get(id: number): IdentityPolicyCacheEntry[F];
  peek(id: number): IdentityPolicyCacheEntry[F];
  has(id: number): boolean;
  delete(id: number): boolean;
  clear(): void;
}

function emptyEntry(): IdentityPolicyCacheEntry {
  return { whitelist: undefined, blocklist: undefined, temporaryAdBypass: undefined };
}

function isUnloaded(entry: IdentityPolicyCacheEntry): boolean {
  return entry.whitelist === undefined && entry.blocklist === undefined && entry.temporaryAdBypass === undefined;
}

/** 取得合并身份缓存某个字段的测试视图。 */
export function identityFieldView<F extends IdentityCacheField>(field: F): IdentityFieldView<F> {
  return {
    get size(): number {
      let count: number = 0;
      identityPolicyCache.forEach((entry: IdentityPolicyCacheEntry): void => {
        if (entry[field] !== undefined) count++;
      });
      return count;
    },
    set(id: number, value: LoadedValue<F>): void {
      const entry: IdentityPolicyCacheEntry | undefined = identityPolicyCache.get(id);
      if (entry === undefined) {
        const created: IdentityPolicyCacheEntry = emptyEntry();
        created[field] = value;
        identityPolicyCache.set(id, created);
      } else {
        entry[field] = value;
      }
    },
    get(id: number): IdentityPolicyCacheEntry[F] {
      return identityPolicyCache.get(id)?.[field];
    },
    peek(id: number): IdentityPolicyCacheEntry[F] {
      return identityPolicyCache.peek(id)?.[field];
    },
    has(id: number): boolean {
      return identityPolicyCache.peek(id)?.[field] !== undefined;
    },
    delete(id: number): boolean {
      const entry: IdentityPolicyCacheEntry | undefined = identityPolicyCache.peek(id);
      if (entry?.[field] === undefined) return false;
      entry[field] = undefined as IdentityPolicyCacheEntry[F];
      if (isUnloaded(entry)) identityPolicyCache.delete(id);
      return true;
    },
    clear(): void {
      identityPolicyCache.forEach((entry: IdentityPolicyCacheEntry, id: number): void => {
        entry[field] = undefined as IdentityPolicyCacheEntry[F];
        if (isUnloaded(entry)) identityPolicyCache.delete(id);
      });
    },
  };
}

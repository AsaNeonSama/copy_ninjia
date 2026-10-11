import { describe, expect, test } from "bun:test";
import {
  claimCooldown,
  cooldownAvailability,
  releaseCooldownClaim,
  sweepCooldownClaims,
} from "../../packages/libs/cooldownClaim";
import type { CooldownAvailability, CooldownClaim, CooldownClaimStore } from "../../packages/types/cooldown";

/** 夹具冷却时长与群 id；冷却表由测试自己构造，不触碰任何 owner 缓存。 */
const COOLDOWN_MS: number = 1_000;
const CHAT: number = -1001;
const OTHER_CHAT: number = -1002;
const T0: number = 50_000;

function storeOf(): CooldownClaimStore {
  return { claimedAt: new Map(), tokens: new Map(), cooldownMs: COOLDOWN_MS, tokenLabel: "测试冷却" };
}

/** 取出占位 token；被拒时让断言直接失败。 */
function tokenOf(claim: CooldownClaim): symbol {
  if (!claim.allowed || claim.token === null) throw new Error("expected an allowed claim with a token");
  return claim.token;
}

describe("cooldownAvailability：只读检查", () => {
  test("没有占位记录时放行，且不建立占位", () => {
    const store: CooldownClaimStore = storeOf();

    expect(cooldownAvailability({ store, chatId: CHAT, bypassCooldown: false, now: T0 })).toEqual({ allowed: true });
    expect(store.claimedAt.size).toBe(0);
    expect(store.tokens.size).toBe(0);
  });

  test("冷却期内拒绝并给出剩余时长；同一刻占位的剩余时长就是整段冷却", () => {
    const store: CooldownClaimStore = storeOf();
    store.claimedAt.set(CHAT, T0);

    expect(cooldownAvailability({ store, chatId: CHAT, bypassCooldown: false, now: T0 }))
      .toEqual({ allowed: false, retryAfterMs: COOLDOWN_MS });
    expect(cooldownAvailability({ store, chatId: CHAT, bypassCooldown: false, now: T0 + 400 }))
      .toEqual({ allowed: false, retryAfterMs: 600 });
    expect(cooldownAvailability({ store, chatId: CHAT, bypassCooldown: false, now: T0 + COOLDOWN_MS - 1 }))
      .toEqual({ allowed: false, retryAfterMs: 1 });
  });

  test("恰好满一个冷却时长即放行（半开区间右端）", () => {
    const store: CooldownClaimStore = storeOf();
    store.claimedAt.set(CHAT, T0);

    expect(cooldownAvailability({ store, chatId: CHAT, bypassCooldown: false, now: T0 + COOLDOWN_MS }))
      .toEqual({ allowed: true });
  });

  test("时钟回拨后占位落在未来：不按负的已过时长拒绝", () => {
    const store: CooldownClaimStore = storeOf();
    store.claimedAt.set(CHAT, T0);

    expect(cooldownAvailability({ store, chatId: CHAT, bypassCooldown: false, now: T0 - 1 }))
      .toEqual({ allowed: true });
  });

  test("旁路身份不读冷却：即使同群正在冷却也放行", () => {
    const store: CooldownClaimStore = storeOf();
    store.claimedAt.set(CHAT, T0);

    expect(cooldownAvailability({ store, chatId: CHAT, bypassCooldown: true, now: T0 + 1 }))
      .toEqual({ allowed: true });
  });

  test("冷却按群隔离：别的群的占位不影响本群", () => {
    const store: CooldownClaimStore = storeOf();
    store.claimedAt.set(OTHER_CHAT, T0);

    const availability: CooldownAvailability = cooldownAvailability({ store, chatId: CHAT, bypassCooldown: false, now: T0 });
    expect(availability).toEqual({ allowed: true });
  });
});

describe("claimCooldown：同步占位", () => {
  test("放行时写入占位时刻与带标签的 token", () => {
    const store: CooldownClaimStore = storeOf();

    const token: symbol = tokenOf(claimCooldown({ store, chatId: CHAT, bypassCooldown: false, now: T0 }));

    expect(typeof token).toBe("symbol");
    expect(token?.description).toBe(store.tokenLabel);
    expect(store.claimedAt.get(CHAT)).toBe(T0);
    expect(store.tokens.get(CHAT)).toBe(token);
  });

  test("冷却期内的第二次占位被拒，原占位与 token 保持不动", () => {
    const store: CooldownClaimStore = storeOf();
    const first: symbol = tokenOf(claimCooldown({ store, chatId: CHAT, bypassCooldown: false, now: T0 }));

    const second: CooldownClaim = claimCooldown({ store, chatId: CHAT, bypassCooldown: false, now: T0 + 250 });

    expect(second).toEqual({ allowed: false, retryAfterMs: 750 });
    expect(store.claimedAt.get(CHAT)).toBe(T0);
    expect(store.tokens.get(CHAT)).toBe(first);
  });

  test("冷却过后重新占位换发新 token，旧 token 失效", () => {
    const store: CooldownClaimStore = storeOf();
    const first: symbol = tokenOf(claimCooldown({ store, chatId: CHAT, bypassCooldown: false, now: T0 }));

    const second: symbol = tokenOf(
      claimCooldown({ store, chatId: CHAT, bypassCooldown: false, now: T0 + COOLDOWN_MS })
    );

    expect(second).not.toBe(first);
    expect(store.claimedAt.get(CHAT)).toBe(T0 + COOLDOWN_MS);
    expect(store.tokens.get(CHAT)).toBe(second);
  });

  test("旁路占位放行但不产生 token，也不改动冷却表", () => {
    const store: CooldownClaimStore = storeOf();
    const existing: symbol = tokenOf(claimCooldown({ store, chatId: CHAT, bypassCooldown: false, now: T0 }));

    const bypass: CooldownClaim = claimCooldown({ store, chatId: CHAT, bypassCooldown: true, now: T0 + 1 });

    expect(bypass).toEqual({ allowed: true, token: null });
    expect(store.claimedAt.get(CHAT)).toBe(T0);
    expect(store.tokens.get(CHAT)).toBe(existing);
  });
});

describe("releaseCooldownClaim：只允许原占位者撤销", () => {
  test("原 token 撤销成功并同时删掉占位时刻与 token", () => {
    const store: CooldownClaimStore = storeOf();
    const token: symbol = tokenOf(claimCooldown({ store, chatId: CHAT, bypassCooldown: false, now: T0 }));

    expect(releaseCooldownClaim(store, CHAT, token)).toBeTrue();
    expect(store.claimedAt.has(CHAT)).toBeFalse();
    expect(store.tokens.has(CHAT)).toBeFalse();
    // 撤销后同群立即可以再次占位。
    expect(claimCooldown({ store, chatId: CHAT, bypassCooldown: false, now: T0 + 1 }).allowed).toBeTrue();
  });

  test("重复撤销第二次返回 false", () => {
    const store: CooldownClaimStore = storeOf();
    const token: symbol = tokenOf(claimCooldown({ store, chatId: CHAT, bypassCooldown: false, now: T0 }));

    expect(releaseCooldownClaim(store, CHAT, token)).toBeTrue();
    expect(releaseCooldownClaim(store, CHAT, token)).toBeFalse();
  });

  test("迟到的旧 token 不能删掉同群后来建立的新冷却", () => {
    const store: CooldownClaimStore = storeOf();
    const stale: symbol = tokenOf(claimCooldown({ store, chatId: CHAT, bypassCooldown: false, now: T0 }));
    const fresh: symbol = tokenOf(
      claimCooldown({ store, chatId: CHAT, bypassCooldown: false, now: T0 + COOLDOWN_MS })
    );

    expect(releaseCooldownClaim(store, CHAT, stale)).toBeFalse();
    expect(store.claimedAt.get(CHAT)).toBe(T0 + COOLDOWN_MS);
    expect(store.tokens.get(CHAT)).toBe(fresh);
  });

  test("旁路的 null token 与别的群的 token 一律不生效", () => {
    const store: CooldownClaimStore = storeOf();
    const token: symbol = tokenOf(claimCooldown({ store, chatId: CHAT, bypassCooldown: false, now: T0 }));

    expect(releaseCooldownClaim(store, CHAT, null)).toBeFalse();
    expect(releaseCooldownClaim(store, OTHER_CHAT, token)).toBeFalse();
    expect(store.claimedAt.get(CHAT)).toBe(T0);
  });
});

describe("sweepCooldownClaims：清理过期与落在未来的占位", () => {
  test("已满冷却与回拨后落在未来的占位删除，冷却期内的保留，token 同步删除", () => {
    const store: CooldownClaimStore = storeOf();
    const now: number = T0 + COOLDOWN_MS;
    const entries: readonly (readonly [number, number])[] = [
      [1, T0], // 恰好满冷却。
      [2, T0 + 1], // 还差 1 ms。
      [3, now], // 刚占位。
      [4, now + 1], // 落在未来。
      [5, T0 - 10_000], // 早已过期。
    ];
    for (const [chatId, claimedAt] of entries) {
      store.claimedAt.set(chatId, claimedAt);
      store.tokens.set(chatId, Symbol(String(chatId)));
    }

    sweepCooldownClaims(store, now);

    expect([...store.claimedAt.keys()]).toEqual([2, 3]);
    expect([...store.tokens.keys()]).toEqual([2, 3]);
  });
});

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  canBypassAdDetection,
  isProtectedFromAdDisposal,
  readAdCandidateSenderStatus,
} from "../../packages/antiRaid/memberFacts";
import { identityPolicyCache, resetIdentityStorageCache } from "../../packages/cache/main/identityStorage";
import { SUPER_ADMIN_USER_ID } from "../../packages/config/bot";
import { DAY_MS } from "../../packages/consts/time";
import { DEFAULT_WHITELIST_PERMISSIONS } from "../../packages/consts/whitelist";
import { isUserBlocked } from "../../packages/infra/blocklist/membership";
import {
  getEffectiveWhitelistPermissions,
  isWhitelisted,
  readWhitelistPermissionOrBlocked,
} from "../../packages/infra/identityPolicy/whitelist";
import type {
  BlocklistEntryData,
  WhitelistEntryData,
} from "../../packages/types/identityPolicy";
import type { TemporaryAdBypassActivity } from "../../packages/types/states/temporaryAdBypass";

const BASE_NOW_MS: number = Date.parse("2026-06-01T12:00:00Z");

const SAMPLE_META: WhitelistEntryData["meta"] = {
  firstName: "Member",
  lastName: "",
  username: "member",
};

const WHITELIST_WITH_AD_BYPASS: Readonly<WhitelistEntryData> = {
  permissions: DEFAULT_WHITELIST_PERMISSIONS,
  meta: SAMPLE_META,
};

const WHITELIST_WITHOUT_AD_BYPASS: Readonly<WhitelistEntryData> = {
  permissions: {
    ...DEFAULT_WHITELIST_PERMISSIONS,
    isCanBypassAdDetection: false,
  },
  meta: SAMPLE_META,
};

const BLOCKLIST_ENTRY: Readonly<BlocklistEntryData> = {
  blockedAt: "2026/06/01 12:00:00",
  meta: SAMPLE_META,
};

const ACTIVE_TEMP_BYPASS: Readonly<TemporaryAdBypassActivity> = {
  adBypass: true,
  adBypassGrantedAt: BASE_NOW_MS - DAY_MS,
  qualifiedDays: 2,
  sendCount: 8,
  countedAt: BASE_NOW_MS - DAY_MS,
  qualifiedAt: BASE_NOW_MS - DAY_MS,
};

const EXPIRED_TEMP_BYPASS: Readonly<TemporaryAdBypassActivity> = {
  adBypass: true,
  adBypassGrantedAt: BASE_NOW_MS - 3 * DAY_MS,
  qualifiedDays: 1,
  sendCount: 8,
  countedAt: BASE_NOW_MS - 3 * DAY_MS,
  qualifiedAt: BASE_NOW_MS - 3 * DAY_MS,
};

const INACTIVE_TEMP_BYPASS: Readonly<TemporaryAdBypassActivity> = {
  adBypass: false,
  adBypassGrantedAt: null,
  qualifiedDays: 0,
  sendCount: 2,
  countedAt: BASE_NOW_MS,
  qualifiedAt: null,
};

function seedMixedIdentities(ids: readonly number[]): void {
  resetIdentityStorageCache();
  for (let index: number = 0; index < ids.length; index += 1) {
    const id: number = ids[index]!;
    if (id === SUPER_ADMIN_USER_ID) continue;
    const kind: number = index % 12;
    if (kind === 0) continue; // 冷缺失
    const whitelist: Readonly<WhitelistEntryData> | null | undefined =
      kind === 1 ? WHITELIST_WITH_AD_BYPASS
      : kind === 2 ? WHITELIST_WITHOUT_AD_BYPASS
      : kind === 3 ? undefined
      : null;
    const blocklist: Readonly<BlocklistEntryData> | null | undefined =
      kind === 4 || kind === 5 ? BLOCKLIST_ENTRY
      : kind === 6 ? undefined
      : null;
    const temporaryAdBypass: Readonly<TemporaryAdBypassActivity> | null | undefined =
      kind === 7 ? ACTIVE_TEMP_BYPASS
      : kind === 8 ? EXPIRED_TEMP_BYPASS
      : kind === 9 ? INACTIVE_TEMP_BYPASS
      : kind === 10 ? undefined
      : null;
    identityPolicyCache.set(id, { whitelist, blocklist, temporaryAdBypass });
  }
}

afterEach(() => {
  resetIdentityStorageCache();
});

describe("身份策略单次 LRU 合并读取等价与不变量", () => {
  test("随机访问序列下合并读取与分步读取结论及 LRU 顺序逐项一致", () => {
    const ids: number[] = [SUPER_ADMIN_USER_ID];
    for (let index: number = 1; index < 120; index += 1) {
      const candidateId: number = 500_000 + index;
      ids.push(candidateId === SUPER_ADMIN_USER_ID ? candidateId + 10_000 : candidateId);
    }

    const sequence: number[] = [];
    let state: number = 0x1234_5678;
    for (let step: number = 0; step < 4_000; step += 1) {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      sequence.push(ids[state % ids.length]!);
    }

    // 1. 候选构建读取（readAdCandidateSenderStatus vs canBypassAdDetection + isUserBlocked）
    seedMixedIdentities(ids);
    const baselineCandidate: ("allowed" | "blocked" | "none")[] = [];
    for (const id of sequence) {
      if (canBypassAdDetection(id, BASE_NOW_MS)) baselineCandidate.push("allowed");
      else if (isUserBlocked(id)) baselineCandidate.push("blocked");
      else baselineCandidate.push("none");
    }
    const baselineCandidateOrder: number[] = [...identityPolicyCache.keys()];

    seedMixedIdentities(ids);
    const combinedCandidate: ("allowed" | "blocked" | "none")[] = [];
    for (const id of sequence) {
      combinedCandidate.push(readAdCandidateSenderStatus(id, BASE_NOW_MS));
    }
    const combinedCandidateOrder: number[] = [...identityPolicyCache.keys()];

    expect(combinedCandidate).toEqual(baselineCandidate);
    expect(combinedCandidateOrder).toEqual(baselineCandidateOrder);

    // 2. 处置保护读取（isProtectedFromAdDisposal vs canBypassAdDetection || isWhitelisted）
    const nowSpy = spyOn(Date, "now").mockReturnValue(BASE_NOW_MS);
    try {
      seedMixedIdentities(ids);
      const baselineDisposal: boolean[] = [];
      for (const id of sequence) {
        baselineDisposal.push(canBypassAdDetection(id) || isWhitelisted(id));
      }
      const baselineDisposalOrder: number[] = [...identityPolicyCache.keys()];

      seedMixedIdentities(ids);
      const combinedDisposal: boolean[] = [];
      for (const id of sequence) {
        combinedDisposal.push(isProtectedFromAdDisposal(id));
      }
      const combinedDisposalOrder: number[] = [...identityPolicyCache.keys()];

      expect(combinedDisposal).toEqual(baselineDisposal);
      expect(combinedDisposalOrder).toEqual(baselineDisposalOrder);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("单次合并读取最多执行一次 LRU get，超级管理员不触碰缓存", () => {
    const regularId: number = SUPER_ADMIN_USER_ID === 700_001 ? 700_002 : 700_001;
    identityPolicyCache.set(regularId, {
      whitelist: null,
      blocklist: BLOCKLIST_ENTRY,
      temporaryAdBypass: null,
    });

    const getSpy = spyOn(identityPolicyCache, "get");
    try {
      expect(readAdCandidateSenderStatus(regularId, BASE_NOW_MS)).toBe("blocked");
      expect(getSpy).toHaveBeenCalledTimes(1);

      getSpy.mockClear();
      expect(isProtectedFromAdDisposal(regularId)).toBeFalse();
      expect(getSpy).toHaveBeenCalledTimes(1);

      getSpy.mockClear();
      expect(getEffectiveWhitelistPermissions(regularId, BASE_NOW_MS)).toBeUndefined();
      expect(getSpy).toHaveBeenCalledTimes(1);

      getSpy.mockClear();
      expect(readAdCandidateSenderStatus(SUPER_ADMIN_USER_ID, BASE_NOW_MS)).toBe("allowed");
      expect(isProtectedFromAdDisposal(SUPER_ADMIN_USER_ID)).toBeTrue();
      expect(getEffectiveWhitelistPermissions(SUPER_ADMIN_USER_ID)).toBeDefined();
      expect(getSpy).not.toHaveBeenCalled();
    } finally {
      getSpy.mockRestore();
    }
  });

  test("负缓存、冷缺失、永久白名单与未获临时免检条目均不触碰墙钟", () => {
    const idNegative: number = 800_001;
    const idBlocked: number = 800_002;
    const idPermanent: number = 800_003;
    const idInactiveTemp: number = 800_004;
    const idActiveTemp: number = 800_005;
    const idColdMiss: number = 800_006;

    identityPolicyCache.set(idNegative, {
      whitelist: null,
      blocklist: null,
      temporaryAdBypass: null,
    });
    identityPolicyCache.set(idBlocked, {
      whitelist: null,
      blocklist: BLOCKLIST_ENTRY,
      temporaryAdBypass: null,
    });
    identityPolicyCache.set(idPermanent, {
      whitelist: WHITELIST_WITHOUT_AD_BYPASS,
      blocklist: null,
      temporaryAdBypass: ACTIVE_TEMP_BYPASS,
    });
    identityPolicyCache.set(idInactiveTemp, {
      whitelist: null,
      blocklist: null,
      temporaryAdBypass: INACTIVE_TEMP_BYPASS,
    });
    identityPolicyCache.set(idActiveTemp, {
      whitelist: null,
      blocklist: null,
      temporaryAdBypass: ACTIVE_TEMP_BYPASS,
    });

    const clockSpy = spyOn(Date, "now").mockReturnValue(BASE_NOW_MS);
    try {
      for (const id of [
        SUPER_ADMIN_USER_ID,
        idColdMiss,
        idNegative,
        idBlocked,
        idPermanent,
        idInactiveTemp,
      ]) {
        readAdCandidateSenderStatus(id);
        isProtectedFromAdDisposal(id);
        getEffectiveWhitelistPermissions(id);
      }
      expect(clockSpy).not.toHaveBeenCalled();

      // 显式传入 now 时，即使存在已授予的临时免检也不读墙钟。
      expect(readAdCandidateSenderStatus(idActiveTemp, BASE_NOW_MS)).toBe("allowed");
      expect(readWhitelistPermissionOrBlocked(idActiveTemp, "isCanMute", BASE_NOW_MS)).toBe("none");
      expect(clockSpy).not.toHaveBeenCalled();

      // 省略 now 且命中已授予的临时免检时按需读一次墙钟。
      expect(readAdCandidateSenderStatus(idActiveTemp)).toBe("allowed");
      expect(isProtectedFromAdDisposal(idActiveTemp)).toBeTrue();
      expect(clockSpy).toHaveBeenCalledTimes(2);
    } finally {
      clockSpy.mockRestore();
    }
  });
});

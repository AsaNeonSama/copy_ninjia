import { describe, expect, test } from "bun:test";
import {
  MINI_APP_AUTH_CLOCK_SKEW_SECONDS,
  MINI_APP_AUTH_MAX_AGE_SECONDS,
  MINI_APP_SESSION_TTL_MS,
  MINI_APP_WEB_APP_DATA_SECRET_SEED,
} from "../../packages/consts/miniApp";
import {
  verifyMiniAppInitData,
  verifyMiniAppPassword,
} from "../../packages/libs/miniAppAuth";
import type { MiniAppAuthResult } from "../../packages/types/miniApp";

/**
 * 构造已按 Telegram WebApp 规范 HMAC-SHA256 签名的测试用 `initData` 查询字符串。
 * @param params 签名参数。
 * @returns URLSearchParams 编码后的 `initData`。
 */
export function buildSignedTestInitData(params: {
  readonly botToken: string;
  readonly authDate: number;
  readonly user?: Readonly<Record<string, unknown>>;
  readonly extra?: Readonly<Record<string, string>>;
}): string {
  const entries: Map<string, string> = new Map<string, string>();
  entries.set("auth_date", String(params.authDate));
  if (params.user !== undefined) {
    entries.set("user", JSON.stringify(params.user));
  }
  if (params.extra !== undefined) {
    for (const [k, v] of Object.entries(params.extra)) {
      entries.set(k, v);
    }
  }
  const sortedLines: string[] = [...entries.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  const dataCheckString: string = sortedLines.join("\n");
  const secretKey: Uint8Array = new Bun.CryptoHasher(
    "sha256",
    MINI_APP_WEB_APP_DATA_SECRET_SEED
  )
    .update(params.botToken, "utf8")
    .digest();
  const hashHex: string = new Bun.CryptoHasher("sha256", secretKey)
    .update(dataCheckString, "utf8")
    .digest("hex");

  const searchParams: URLSearchParams = new URLSearchParams();
  for (const [k, v] of entries) {
    searchParams.set(k, v);
  }
  searchParams.set("hash", hashHex);
  return searchParams.toString();
}

describe("verifyMiniAppInitData", () => {
  const botToken: string = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
  const superAdminUserId: number = 10001;
  const nowMs: number = 1_700_000_000_000;
  const nowSec: number = Math.floor(nowMs / 1000);

  test("通过合法的 SuperAdmin initData 签名校验并提取用户资料", () => {
    const initData: string = buildSignedTestInitData({
      botToken,
      authDate: nowSec - 10,
      user: {
        id: superAdminUserId,
        first_name: "Kakashi",
        last_name: "Hatake",
        username: "copy_ninja",
      },
      extra: { query_id: "AAHdF6IQAAAAAN0XohDhrOrc" },
    });

    const result: MiniAppAuthResult = verifyMiniAppInitData({
      initData,
      botToken,
      superAdminUserId,
      nowMs,
    });

    expect(result).toEqual({
      ok: true,
      authDate: nowSec - 10,
      user: {
        id: superAdminUserId,
        firstName: "Kakashi",
        lastName: "Hatake",
        username: "copy_ninja",
      },
    });
  });

  test("非 SuperAdmin 用户的合法签名同样被拒绝 (forbidden_user)", () => {
    const initData: string = buildSignedTestInitData({
      botToken,
      authDate: nowSec,
      user: {
        id: superAdminUserId + 1,
        first_name: "Intruder",
      },
    });

    const result: MiniAppAuthResult = verifyMiniAppInitData({
      initData,
      botToken,
      superAdminUserId,
      nowMs,
    });

    expect(result).toEqual({
      ok: false,
      reason: "forbidden_user",
    });
  });

  test("篡改 user.id 或使用错误 botToken 签名时返回 invalid_signature", () => {
    const forgedByOtherBot: string = buildSignedTestInitData({
      botToken: `${botToken}-wrong`,
      authDate: nowSec,
      user: {
        id: superAdminUserId,
        first_name: "Kakashi",
      },
    });

    expect(
      verifyMiniAppInitData({
        initData: forgedByOtherBot,
        botToken,
        superAdminUserId,
        nowMs,
      })
    ).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
  });

  test("过期或超出时钟偏移上限的 auth_date 返回 expired_auth_date，且有效窗口与 90 分钟会话对齐", () => {
    expect(MINI_APP_AUTH_MAX_AGE_SECONDS).toBe(MINI_APP_SESSION_TTL_MS / 1_000);
    const expiredInitData: string = buildSignedTestInitData({
      botToken,
      authDate: nowSec - MINI_APP_AUTH_MAX_AGE_SECONDS - 1,
      user: { id: superAdminUserId, first_name: "Kakashi" },
    });
    expect(
      verifyMiniAppInitData({
        initData: expiredInitData,
        botToken,
        superAdminUserId,
        nowMs,
      })
    ).toEqual({
      ok: false,
      reason: "expired_auth_date",
    });

    const futureInitData: string = buildSignedTestInitData({
      botToken,
      authDate: nowSec + MINI_APP_AUTH_CLOCK_SKEW_SECONDS + 5,
      user: { id: superAdminUserId, first_name: "Kakashi" },
    });
    expect(
      verifyMiniAppInitData({
        initData: futureInitData,
        botToken,
        superAdminUserId,
        nowMs,
      })
    ).toEqual({
      ok: false,
      reason: "expired_auth_date",
    });
  });

  test("缺失 initData、重复参数或格式损坏时返回明确拒绝原因", () => {
    expect(
      verifyMiniAppInitData({
        initData: "",
        botToken,
        superAdminUserId,
        nowMs,
      })
    ).toEqual({
      ok: false,
      reason: "missing_init_data",
    });

    expect(
      verifyMiniAppInitData({
        initData: "auth_date=1700000000&hash=not-a-hex",
        botToken,
        superAdminUserId,
        nowMs,
      })
    ).toEqual({
      ok: false,
      reason: "malformed_init_data",
    });
  });

  test("verifyMiniAppPassword 对密码执行恒定时间 SHA-256 比对并拒绝空密码或错误密码", () => {
    expect(verifyMiniAppPassword("  s3cr3t-pass  ", "s3cr3t-pass")).toBeTrue();
    expect(verifyMiniAppPassword("wrong-pass", "s3cr3t-pass")).toBeFalse();
    expect(verifyMiniAppPassword("", "s3cr3t-pass")).toBeFalse();
    expect(verifyMiniAppPassword("s3cr3t-pass", "")).toBeFalse();
  });
});

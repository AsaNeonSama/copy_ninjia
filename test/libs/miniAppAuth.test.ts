import { describe, expect, test } from "bun:test";
import {
  MINI_APP_AUTH_CLOCK_SKEW_SECONDS,
  MINI_APP_AUTH_MAX_AGE_SECONDS,
  MINI_APP_SESSION_TTL_MS,
} from "../../packages/consts/miniApp";
import { MINI_APP_TOTP_STEP_SECONDS } from "../../packages/consts/miniAppTotp";
import {
  deriveMiniAppInitDataSecretKey,
  verifyMiniAppInitData,
  verifyMiniAppPassword,
} from "../../packages/libs/miniAppAuth";
import {
  buildMiniAppTotpUri,
  computeMiniAppTotpCode,
  computeMiniAppTotpCounter,
  decodeTotpBase32,
  encodeTotpBase32,
  generateMiniAppTotpCodeAt,
  generateMiniAppTotpSecret,
  maskMiniAppTotpSecret,
  verifyMiniAppTotpCode,
} from "../../packages/libs/miniAppTotp";
import { renderQrCodeSvg } from "../../packages/libs/qrcodeSvg";
import type { MiniAppAuthResult } from "../../packages/types/miniApp/auth";
import { buildSignedTestInitData } from "../helpers/miniAppInitData";

describe("verifyMiniAppInitData", () => {
  const botToken: string = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
  const secretKey: Uint8Array = deriveMiniAppInitDataSecretKey(botToken);
  const superAdminUserId: number = 10001;
  const nowMs: number = 1_700_000_000_000;
  const nowSec: number = Math.floor(nowMs / 1000);

  test("通过合法的 SuperAdmin initData 签名校验并提取用户资料（含大写十六进制 hash）", () => {
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
      secretKey,
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

    const upperHashParams: URLSearchParams = new URLSearchParams(initData);
    upperHashParams.set("hash", upperHashParams.get("hash")!.toUpperCase());
    expect(
      verifyMiniAppInitData({
        initData: upperHashParams.toString(),
        secretKey,
        superAdminUserId,
        nowMs,
      })
    ).toEqual(result);
  });

  test("user 缺省可选字段时仍返回固定四字段形状，显式置为 undefined 且 JSON 序列化等价", () => {
    const cases: readonly {
      readonly rawUser: {
        readonly id: number;
        readonly first_name: string;
        readonly last_name?: string;
        readonly username?: string;
      };
      readonly expectedLastName: string | undefined;
      readonly expectedUsername: string | undefined;
      readonly expectedJson: Record<string, unknown>;
    }[] = [
      {
        rawUser: { id: superAdminUserId, first_name: "Kakashi" },
        expectedLastName: undefined,
        expectedUsername: undefined,
        expectedJson: { id: superAdminUserId, firstName: "Kakashi" },
      },
      {
        rawUser: { id: superAdminUserId, first_name: "Kakashi", last_name: "Hatake" },
        expectedLastName: "Hatake",
        expectedUsername: undefined,
        expectedJson: { id: superAdminUserId, firstName: "Kakashi", lastName: "Hatake" },
      },
      {
        rawUser: { id: superAdminUserId, first_name: "Kakashi", username: "copy_ninja" },
        expectedLastName: undefined,
        expectedUsername: "copy_ninja",
        expectedJson: { id: superAdminUserId, firstName: "Kakashi", username: "copy_ninja" },
      },
      {
        rawUser: { id: superAdminUserId, first_name: "Kakashi", last_name: "Hatake", username: "copy_ninja" },
        expectedLastName: "Hatake",
        expectedUsername: "copy_ninja",
        expectedJson: { id: superAdminUserId, firstName: "Kakashi", lastName: "Hatake", username: "copy_ninja" },
      },
    ];

    for (const item of cases) {
      const initData: string = buildSignedTestInitData({
        botToken,
        authDate: nowSec,
        user: item.rawUser,
      });
      const result: MiniAppAuthResult = verifyMiniAppInitData({
        initData,
        secretKey,
        superAdminUserId,
        nowMs,
      });
      expect(result.ok).toBeTrue();
      if (!result.ok) {
        throw new Error("Expected valid initData user.");
      }
      expect(Object.keys(result.user)).toEqual(["id", "firstName", "lastName", "username"]);
      expect(result.user.id).toBe(superAdminUserId);
      expect(result.user.firstName).toBe("Kakashi");
      expect(result.user.lastName).toBe(item.expectedLastName);
      expect(result.user.username).toBe(item.expectedUsername);
      expect(JSON.parse(JSON.stringify(result.user))).toEqual(item.expectedJson);
    }

    for (const invalidUser of [
      { id: superAdminUserId, first_name: "Kakashi", last_name: 123 },
      { id: superAdminUserId, first_name: "Kakashi", username: null },
    ]) {
      const initData: string = buildSignedTestInitData({
        botToken,
        authDate: nowSec,
        user: invalidUser as unknown as { readonly id: number; readonly first_name: string },
      });
      expect(
        verifyMiniAppInitData({
          initData,
          secretKey,
          superAdminUserId,
          nowMs,
        })
      ).toEqual({
        ok: false,
        reason: "malformed_init_data",
      });
    }
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
      secretKey,
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
        secretKey,
        superAdminUserId,
        nowMs,
      })
    ).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
  });

  test("过期或超出时钟偏移上限的 auth_date 返回 expired_auth_date，且有效窗口与 45 分钟会话对齐", () => {
    expect(MINI_APP_AUTH_MAX_AGE_SECONDS).toBe(MINI_APP_SESSION_TTL_MS / 1_000);
    const expiredInitData: string = buildSignedTestInitData({
      botToken,
      authDate: nowSec - MINI_APP_AUTH_MAX_AGE_SECONDS - 1,
      user: { id: superAdminUserId, first_name: "Kakashi" },
    });
    expect(
      verifyMiniAppInitData({
        initData: expiredInitData,
        secretKey,
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
        secretKey,
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
        secretKey,
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
        secretKey,
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

  test("computeMiniAppTotpCounter 按 30 秒步长计算整计数器", () => {
    expect(computeMiniAppTotpCounter(0)).toBe(0);
    expect(computeMiniAppTotpCounter(29_999)).toBe(0);
    expect(computeMiniAppTotpCounter(30_000)).toBe(1);
    expect(computeMiniAppTotpCounter(1_111_111_109_000)).toBe(37_037_036);
    expect(computeMiniAppTotpCounter(1_111_111_111_000)).toBe(37_037_037);
  });

  test("RFC 6238 TOTP 生成、仅当前时间步验证与内联 QR Code SVG 渲染", () => {
    const secret: string = generateMiniAppTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const decoded: Uint8Array | null = decodeTotpBase32(secret);
    expect(decoded).not.toBeNull();
    expect(decoded?.byteLength).toBe(20);
    expect(encodeTotpBase32(decoded!)).toBe(secret);
    expect(decodeTotpBase32("INVALID-SECRET!")).toBeNull();

    const fixedMs: number = 1_700_000_000_000;
    const currentCode: string = generateMiniAppTotpCodeAt(secret, fixedMs);
    expect(currentCode).toMatch(/^\d{6}$/);
    expect(verifyMiniAppTotpCode(currentCode, secret, fixedMs)).toBeTrue();
    expect(verifyMiniAppTotpCode("abc123", secret, fixedMs)).toBeFalse();
    expect(verifyMiniAppTotpCode(currentCode, "bad", fixedMs)).toBeFalse();
    expect(computeMiniAppTotpCode("bad", 1)).toBe("");

    // RFC 6238 附录 B 的 SHA-1 测试向量（ASCII 密钥 "12345678901234567890"，取 8 位码末 6 位），
    // 1111111109 s 与 1111111111 s 分属相邻时间步。
    const rfcSecret: string = encodeTotpBase32(new TextEncoder().encode("12345678901234567890"));
    const earlierStepMs: number = 1_111_111_109_000;
    const laterStepMs: number = 1_111_111_111_000;
    const stepMs: number = MINI_APP_TOTP_STEP_SECONDS * 1000;
    const laterStepStartMs: number = Math.floor(laterStepMs / stepMs) * stepMs;
    expect(generateMiniAppTotpCodeAt(rfcSecret, earlierStepMs)).toBe("081804");
    expect(generateMiniAppTotpCodeAt(rfcSecret, laterStepMs)).toBe("050471");
    expect(verifyMiniAppTotpCode("081804", rfcSecret, laterStepStartMs - 1)).toBeTrue();
    expect(verifyMiniAppTotpCode("081804", rfcSecret, laterStepStartMs)).toBeFalse();
    expect(verifyMiniAppTotpCode("050471", rfcSecret, earlierStepMs)).toBeFalse();

    const uri: string = buildMiniAppTotpUri(secret, superAdminUserId);
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain(`secret=${secret}`);
    expect(maskMiniAppTotpSecret(secret)).toBe(
      `${secret.slice(0, 4)}••••${secret.slice(-4)}`
    );

    const svg: string = renderQrCodeSvg(uri);
    expect(svg.startsWith("<svg")).toBeTrue();
    expect(svg.endsWith("</svg>")).toBeTrue();
    expect(svg).toContain("<path d=\"M");
  });
});

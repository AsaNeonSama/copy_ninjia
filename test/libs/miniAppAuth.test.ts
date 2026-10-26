import { describe, expect, test } from "bun:test";
import {
  MINI_APP_AUTH_CLOCK_SKEW_SECONDS,
  MINI_APP_AUTH_MAX_AGE_SECONDS,
  MINI_APP_SESSION_TTL_MS,
} from "../../packages/consts/miniApp";
import { MINI_APP_TOTP_STEP_SECONDS } from "../../packages/consts/miniAppTotp";
import {
  deriveMiniAppAssetToken,
  verifyMiniAppAssetToken,
  verifyMiniAppInitData,
  verifyMiniAppPassword,
} from "../../packages/libs/miniAppAuth";
import {
  buildMiniAppTotpUri,
  computeMiniAppTotpCode,
  decodeTotpBase32,
  encodeTotpBase32,
  generateMiniAppTotpCodeAt,
  generateMiniAppTotpSecret,
  maskMiniAppTotpSecret,
  verifyMiniAppTotpCode,
} from "../../packages/libs/miniAppTotp";
import { renderQrCodeSvg } from "../../packages/libs/qrcodeSvg";
import type { MiniAppAuthResult } from "../../packages/types/miniApp";
import { buildSignedTestInitData } from "../helpers/miniAppInitData";

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

  test("deriveMiniAppAssetToken 与 verifyMiniAppAssetToken 派生并恒定时间核验受保护资源稳定令牌", () => {
    const token: string = deriveMiniAppAssetToken(botToken, superAdminUserId);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyMiniAppAssetToken(token, botToken, superAdminUserId)).toBeTrue();
    expect(
      verifyMiniAppAssetToken(token.toUpperCase(), botToken, superAdminUserId)
    ).toBeTrue();
    expect(
      verifyMiniAppAssetToken(token, `${botToken}-other`, superAdminUserId)
    ).toBeFalse();
    expect(
      verifyMiniAppAssetToken(token, botToken, superAdminUserId + 1)
    ).toBeFalse();
    expect(verifyMiniAppAssetToken("", botToken, superAdminUserId)).toBeFalse();
    expect(verifyMiniAppAssetToken(null, botToken, superAdminUserId)).toBeFalse();
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

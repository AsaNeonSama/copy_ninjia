/**
 * Mini App 256-bit 会话临时密钥、5 客户端活跃密钥上限、AES-256-GCM 信封与查询串（`?e=`）传输加密及滑动续期「替换成功即失效」专项测试。
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { imageFixture } from "../helpers/image";
import {
  buildSignedTestInitData,
  installMiniAppTestDiskIOMock,
  miniAppTestWhitelistRows,
  resetMiniAppTestDiskIOState,
} from "../helpers/miniAppInitData";

installMiniAppTestDiskIOMock();

const { resetChatStateCache } = await import("../../packages/cache/main/chatState");
const { resetIdentityStorageCache } = await import(
  "../../packages/cache/main/identityStorage"
);
const {
  miniAppAuthHandshakes,
  miniAppAuthSessions,
  miniAppPasswordGuardHolder,
  miniAppTotpRecordHolder,
} = await import("../../packages/cache/main/miniApp");
const { getAssetConfig } = await import("../../packages/config/assets");
const { BOT_TOKEN, SUPER_ADMIN_USER_ID, getBotMiniAppConfig } = await import(
  "../../packages/config/bot"
);
const {
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_MAX_JSON_BODY_BYTES,
  MINI_APP_SESSION_EXPIRES_AT_HEADER,
  MINI_APP_SESSION_HEADER,
  MINI_APP_SESSION_MAX,
  MINI_APP_SESSION_REFRESH_MAX_MS,
  MINI_APP_SESSION_TTL_MS,
} = await import("../../packages/consts/miniApp");
const {
  MINI_APP_AES_GCM_IV_BYTES,
  MINI_APP_AES_GCM_TAG_BITS,
  MINI_APP_ENCRYPTED_QUERY_PARAM,
  MINI_APP_HANDSHAKE_ID_BYTES,
  MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
  MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH,
  MINI_APP_SESSION_KEY_BYTES,
  MINI_APP_SESSION_KEY_HEADER,
} = await import("../../packages/consts/miniAppCrypto");
const {
  MINI_APP_TOTP_RECORD_VERSION,
} = await import("../../packages/consts/miniAppTotp");
const { MINI_APP_TOTP_MEMORY_DIR } = await import("../../packages/consts/paths");
const { DEFAULT_WHITELIST_PERMISSIONS } = await import(
  "../../packages/consts/whitelist"
);
const { generateMiniAppTotpCodeAt } = await import("../../packages/libs/miniAppTotp");
const { storeRandomImage } = await import("../../packages/infra/imageGallery");
const {
  startMiniAppServer,
  stopMiniAppServer,
} = await import("../../packages/mini-app-api-server");
const {
  buildMiniAppEnvelopeAad,
  decryptMiniAppText,
  encryptMiniAppEnvelope,
  importMiniAppAesGcmKey,
  parseMiniAppEncryptedEnvelope,
  unsealMiniAppQuery,
} = await import("../../packages/mini-app-api-server/libs/crypto");
const {
  encodeUtf8Bytes,
  encryptMiniAppBinary,
  encryptMiniAppPayload,
  sealMiniAppQuery,
  unsealRotatedSessionKey,
} = await import("../../packages/mini-app-frontend/libs/crypto");
const {
  dispatchRawMiniAppTestRequest,
  performMiniAppTestEcdhLogin,
} = await import("../helpers/miniAppRequest");
import type { MiniAppLoginSuccessResponse } from "../../packages/types/miniApp/auth";
import type {
  MiniAppConfigFileResponse,
  MiniAppEncryptedEnvelope,
} from "../../packages/types/miniApp/configs";
import type {
  MiniAppGalleryPage,
  MiniAppGalleryUploadResult,
} from "../../packages/types/miniApp/gallery";
import type {
  MiniAppIdentityMutationResult,
  MiniAppWhitelistPage,
} from "../../packages/types/miniApp/identities";
import type { MiniAppStatusView } from "../../packages/types/miniApp/server";

/**
 * 构造当前时刻签名的超级管理员 `initData`。
 * @returns 已签名的 `initData` 查询字符串。
 */
function adminInitData(): string {
  return buildSignedTestInitData({
    botToken: BOT_TOKEN,
    authDate: Math.floor(Date.now() / 1_000),
    user: {
      id: SUPER_ADMIN_USER_ID,
      first_name: "SuperAdmin",
      username: "super_admin",
    },
  });
}

/**
 * 执行完整 TLS 模式 ECDH 握手登录（`GET /api/auth/precheck` 验签临时 X25519 公钥 + `POST /api/auth/login` 双向 ECDH/HKDF 加密交换 45 分钟会话密钥）并返回会话载荷。
 * @param payload 登录 JSON 凭据对象。
 * @returns 解密后的会话临时密钥载荷。
 */
async function completeRawSessionLogin(
  payload: Readonly<Record<string, string>>
): Promise<MiniAppLoginSuccessResponse> {
  const completed = await performMiniAppTestEcdhLogin({
    initData: adminInitData(),
    credentialPayload: payload,
  });
  return completed.payload as unknown as MiniAppLoginSuccessResponse;
}

afterEach(async (): Promise<void> => {
  await stopMiniAppServer();
  rmSync(MINI_APP_TOTP_MEMORY_DIR, { recursive: true, force: true });
  rmSync(getAssetConfig().randomHImageDirectory, { recursive: true, force: true });
  resetMiniAppTestDiskIOState();
  resetIdentityStorageCache();
  resetChatStateCache();
  miniAppAuthSessions.clear();
  miniAppAuthHandshakes.clear();
  miniAppPasswordGuardHolder.current = null;
  miniAppTotpRecordHolder.current = undefined;
  setSystemTime();
});

describe("Mini App 256-bit 会话临时密钥、5 密钥上限与 AES-256-GCM 传输加密", () => {
  test("预检签发 Ed25519 验签通过的临时 X25519 握手公钥并在登录后立即销毁，业务请求与响应全程使用 AES-256-GCM 加密信封，且拒绝明文与篡改载荷", async () => {
    const password: string = getBotMiniAppConfig()!.password;
    const completed = await performMiniAppTestEcdhLogin({
      initData: adminInitData(),
      credentialPayload: { password },
    });
    expect(completed.precheckResponse?.status).toBe(200);
    expect(completed.status).toBe(200);
    expect(Uint8Array.fromHex(completed.handshake.handshakeId).byteLength).toBe(
      MINI_APP_HANDSHAKE_ID_BYTES
    );
    expect(miniAppAuthHandshakes.has(completed.handshake.handshakeId)).toBeFalse();

    const sessionBody: MiniAppLoginSuccessResponse =
      completed.payload as unknown as MiniAppLoginSuccessResponse;
    expect(sessionBody.ok).toBeTrue();
    expect(sessionBody.sessionToken).toMatch(/^[0-9a-f]{64}$/u);
    expect(sessionBody.sessionKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(Uint8Array.fromHex(sessionBody.sessionKey).byteLength).toBe(
      MINI_APP_SESSION_KEY_BYTES
    );

    const clientCryptoKey: CryptoKey = await importMiniAppAesGcmKey(
      sessionBody.sessionKey
    );
    const authHeaders: Record<string, string> = {
      [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
      [MINI_APP_SESSION_HEADER]: sessionBody.sessionToken,
    };

    // 1. GET /api/status 原始网络响应必须是加密信封，不含任何明文状态字段。
    const rawStatusRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/status", { headers: authHeaders })
    );
    expect(rawStatusRes.status).toBe(200);
    const rawStatusText: string = await rawStatusRes.text();
    expect(rawStatusText).not.toContain("uptimeMs");
    expect(rawStatusText).not.toContain("capabilities");
    const statusEnvelope: Readonly<MiniAppEncryptedEnvelope> | null =
      parseMiniAppEncryptedEnvelope(JSON.parse(rawStatusText));
    expect(statusEnvelope).not.toBeNull();
    expect(Uint8Array.fromBase64(statusEnvelope!.iv).byteLength).toBe(
      MINI_APP_AES_GCM_IV_BYTES
    );
    expect(
      Uint8Array.fromBase64(statusEnvelope!.payload).byteLength
    ).toBeGreaterThan(MINI_APP_AES_GCM_TAG_BITS / 8);

    const decryptedStatusText: string | null = await decryptMiniAppText({
      cryptoKey: clientCryptoKey,
      encrypted: statusEnvelope!,
      additionalData: buildMiniAppEnvelopeAad("GET", "/api/status", "res"),
    });
    expect(decryptedStatusText).not.toBeNull();
    const statusView: MiniAppStatusView = JSON.parse(
      decryptedStatusText!
    ) as MiniAppStatusView;
    expect(Array.isArray(statusView.capabilities)).toBeTrue();

    // 2. 加密 POST 路由收到未加密明文 JSON 请求体时必须返回 400 INVALID_ENCRYPTED_PAYLOAD（响应同样加密并绑定 :res AAD）。
    const plainPostRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/identities/whitelist", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ id: 500_001, enabled: true }),
      })
    );
    expect(plainPostRes.status).toBe(400);
    const plainPostEnv: Readonly<MiniAppEncryptedEnvelope> | null =
      parseMiniAppEncryptedEnvelope(await plainPostRes.json());
    expect(plainPostEnv).not.toBeNull();
    expect(
      JSON.parse(
        (await decryptMiniAppText({
          cryptoKey: clientCryptoKey,
          encrypted: plainPostEnv!,
          additionalData: buildMiniAppEnvelopeAad("POST", "/api/identities/whitelist", "res"),
        }))!
      )
    ).toEqual({ error: MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE });

    // 3. 使用会话密钥与 :req AAD 加密请求体后正常执行写入，且篡改密文、错误 IV 长度或跨会话密钥均被 GCM 认证标签拒绝。
    const validReqEnvelope: Readonly<MiniAppEncryptedEnvelope> =
      await encryptMiniAppEnvelope(
        clientCryptoKey,
        JSON.stringify({ id: 500_002, enabled: true }),
        buildMiniAppEnvelopeAad("POST", "/api/identities/whitelist", "req")
      );
    const encryptedPostRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/identities/whitelist", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(validReqEnvelope),
      })
    );
    expect(encryptedPostRes.status).toBe(200);
    const postRespEnv: Readonly<MiniAppEncryptedEnvelope> =
      parseMiniAppEncryptedEnvelope(await encryptedPostRes.json())!;
    const mutationResult: MiniAppIdentityMutationResult = JSON.parse(
      (await decryptMiniAppText({
        cryptoKey: clientCryptoKey,
        encrypted: postRespEnv,
        additionalData: buildMiniAppEnvelopeAad("POST", "/api/identities/whitelist", "res"),
      }))!
    ) as MiniAppIdentityMutationResult;
    expect(mutationResult.ok).toBeTrue();
    expect(mutationResult.id).toBe(500_002);

    const cipherBytes: Uint8Array = Uint8Array.fromBase64(validReqEnvelope.payload);
    cipherBytes[0] = (cipherBytes[0] ?? 0) ^ 0xff;
    const tamperedEnvelope: MiniAppEncryptedEnvelope = {
      encrypted: true,
      iv: validReqEnvelope.iv,
      payload: cipherBytes.toBase64(),
    };
    const tamperedRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/identities/whitelist", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(tamperedEnvelope),
      })
    );
    expect(tamperedRes.status).toBe(400);

    const otherCryptoKey: CryptoKey = await importMiniAppAesGcmKey("f".repeat(64));
    const wrongKeyEnvelope: Readonly<MiniAppEncryptedEnvelope> =
      await encryptMiniAppEnvelope(
        otherCryptoKey,
        JSON.stringify({ id: 500_003, enabled: true }),
        buildMiniAppEnvelopeAad("POST", "/api/identities/whitelist", "req")
      );
    const wrongKeyRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/identities/whitelist", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(wrongKeyEnvelope),
      })
    );
    expect(wrongKeyRes.status).toBe(400);
  });

  test("图片上传请求体保持二进制免加密而响应体加密，图库预览/下载查询串加密（?e=）而图片字节流与静态 HTML/资源保持免加密", async () => {
    const server = startMiniAppServer({
      url: "https://miniapp.example.com",
      host: "127.0.0.1",
      port: 0,
      password: "enc-server-password-123456",
    });
    expect(server).not.toBeNull();
    const baseUrl: string = `http://127.0.0.1:${server!.port}`;

    const { payload: loginRawPayload } = await performMiniAppTestEcdhLogin({
      initData: adminInitData(),
      credentialPayload: { password: "enc-server-password-123456" },
      baseUrl,
      send: (req: Request): Promise<Response> => fetch(req),
    });
    const loginBody: MiniAppLoginSuccessResponse =
      loginRawPayload as unknown as MiniAppLoginSuccessResponse;
    const cryptoKey: CryptoKey = await importMiniAppAesGcmKey(
      loginBody.sessionKey
    );
    const headers: Record<string, string> = {
      [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
      [MINI_APP_SESSION_HEADER]: loginBody.sessionToken,
    };

    // 1. 单页 HTML 保持明文。
    const pageRes: Response = await fetch(`${baseUrl}/`, { headers });
    expect(pageRes.status).toBe(200);
    expect(await pageRes.text()).toContain('id="root"');

    // 2. 图库二进制上传：请求体经会话密钥加密为 [12B IV || 密文+16B 标签]，JSON 响应体经会话密钥加密。
    const galleryDir: string = getAssetConfig().randomHImageDirectory;
    rmSync(galleryDir, { recursive: true, force: true });
    mkdirSync(galleryDir, { recursive: true });
    const pngBytes: Uint8Array = await new Bun.Image(imageFixture(12, 12)).png().bytes();
    const uploadRes: Response = await fetch(`${baseUrl}/api/gallery/upload`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/octet-stream" },
      body: await encryptMiniAppBinary(
        cryptoKey,
        pngBytes,
        buildMiniAppEnvelopeAad("POST", "/api/gallery/upload", "req")
      ),
    });
    expect(uploadRes.status).toBe(200);
    const uploadEnv: Readonly<MiniAppEncryptedEnvelope> | null =
      parseMiniAppEncryptedEnvelope(await uploadRes.json());
    expect(uploadEnv).not.toBeNull();
    const uploadResult: MiniAppGalleryUploadResult = JSON.parse(
      (await decryptMiniAppText({
        cryptoKey,
        encrypted: uploadEnv!,
        additionalData: buildMiniAppEnvelopeAad("POST", "/api/gallery/upload", "res"),
      }))!
    ) as MiniAppGalleryUploadResult;
    expect(uploadResult.ok).toBeTrue();
    expect(uploadResult.fileName).toBeDefined();

    // 3. 图库单张预览与下载强制使用 ?e= 加密查询串或 60s 一次性 ?ticket=，响应保持原始 PNG 二进制免加密，且拒绝遗留 ?token= 绕过。
    const legacyTokenOnlyPreviewRes: Response = await fetch(
      `${baseUrl}/api/gallery/file?token=${"a".repeat(64)}&fileName=${encodeURIComponent(uploadResult.fileName!)}`
    );
    expect(legacyTokenOnlyPreviewRes.status).toBe(401);

    const sealedPreviewQuery: string = await sealMiniAppQuery(
      cryptoKey,
      `fileName=${encodeURIComponent(uploadResult.fileName!)}`,
      "GET /api/gallery/file"
    );
    const previewRes: Response = await fetch(
      `${baseUrl}/api/gallery/file?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(sealedPreviewQuery)}`,
      { headers }
    );
    expect(previewRes.status).toBe(200);
    expect(await previewRes.bytes()).toEqual(pngBytes);

    const sealedDownloadQuery: string = await sealMiniAppQuery(
      cryptoKey,
      `fileName=${encodeURIComponent(uploadResult.fileName!)}`,
      "GET /api/gallery/download"
    );
    const downloadRes: Response = await fetch(
      `${baseUrl}/api/gallery/download?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(sealedDownloadQuery)}`,
      { headers }
    );
    expect(downloadRes.status).toBe(200);
    expect(await downloadRes.bytes()).toEqual(pngBytes);

    const ticketReqEnv = await encryptMiniAppEnvelope(
      cryptoKey,
      JSON.stringify({ fileName: uploadResult.fileName! }),
      buildMiniAppEnvelopeAad("POST", "/api/gallery/download-ticket", "req")
    );
    const ticketIssueRes: Response = await fetch(
      `${baseUrl}/api/gallery/download-ticket`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(ticketReqEnv),
      }
    );
    expect(ticketIssueRes.status).toBe(200);
    const ticketIssuePlain: { readonly ticket: string } = JSON.parse(
      (await decryptMiniAppText({
        cryptoKey,
        encrypted: parseMiniAppEncryptedEnvelope(await ticketIssueRes.json())!,
        additionalData: buildMiniAppEnvelopeAad("POST", "/api/gallery/download-ticket", "res"),
      }))!
    ) as { readonly ticket: string };
    const headTicketDownloadRes: Response = await fetch(
      `${baseUrl}/api/gallery/download?ticket=${encodeURIComponent(ticketIssuePlain.ticket)}`,
      { method: "HEAD" }
    );
    expect(headTicketDownloadRes.status).toBe(200);
    const getTicketDownloadRes: Response = await fetch(
      `${baseUrl}/api/gallery/download?ticket=${encodeURIComponent(ticketIssuePlain.ticket)}`
    );
    expect(getTicketDownloadRes.status).toBe(200);
    expect(await getTicketDownloadRes.bytes()).toEqual(pngBytes);
  });

  test("服务端最多同时缓存 5 个活跃会话密钥：满 5 个后新客户端登录（密码与 TOTP）淘汰签发或轮换距今最久的会话，被淘汰会话随即要求重新登录，登出或过期后释放名额", async () => {
    const baseMs: number = 1_770_000_000_000;
    setSystemTime(new Date(baseMs));
    const password: string = getBotMiniAppConfig()!.password;
    const statusWithToken = (token: string): Promise<Response> =>
      dispatchRawMiniAppTestRequest(
        new Request("http://127.0.0.1:3000/api/status", {
          headers: {
            [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
            [MINI_APP_SESSION_HEADER]: token,
          },
        })
      );

    const activeLogins: MiniAppLoginSuccessResponse[] = [];
    for (let i: number = 0; i < MINI_APP_SESSION_MAX; i += 1) {
      activeLogins.push(await completeRawSessionLogin({ password }));
    }
    expect(miniAppAuthSessions.size).toBe(MINI_APP_SESSION_MAX);
    const uniqueKeys: Set<string> = new Set<string>(
      activeLogins.map((item: MiniAppLoginSuccessResponse): string => item.sessionKey)
    );
    expect(uniqueKeys.size).toBe(MINI_APP_SESSION_MAX);

    // 第 6 个客户端携带正确密码登录：成功签发，最早签发的会话被淘汰，其余会话保留。
    const sixthPassword: MiniAppLoginSuccessResponse = await completeRawSessionLogin({ password });
    expect(miniAppAuthSessions.size).toBe(MINI_APP_SESSION_MAX);
    expect(miniAppAuthSessions.has(activeLogins[0]!.sessionToken)).toBeFalse();
    expect(miniAppAuthSessions.has(sixthPassword.sessionToken)).toBeTrue();
    for (const item of activeLogins.slice(1)) {
      expect(miniAppAuthSessions.has(item.sessionToken)).toBeTrue();
    }
    expect((await statusWithToken(activeLogins[0]!.sessionToken)).status).toBe(401);

    // 轮换把会话挪到最新端：第 2 个会话轮换后，TOTP 模式的下一次登录淘汰的是第 3 个会话。
    const secondSession = miniAppAuthSessions.get(activeLogins[1]!.sessionToken)!;
    setSystemTime(new Date(secondSession.nextRefreshAt + 1));
    const rotateRes: Response = await statusWithToken(activeLogins[1]!.sessionToken);
    expect(rotateRes.status).toBe(200);
    const rotatedSecondToken: string = rotateRes.headers.get(MINI_APP_SESSION_HEADER)!;
    expect(rotatedSecondToken).not.toBe(activeLogins[1]!.sessionToken);

    const totpSecret: string = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    miniAppTotpRecordHolder.current = {
      version: MINI_APP_TOTP_RECORD_VERSION,
      secret: totpSecret,
      createdAt: baseMs,
    };
    const seventhTotp: MiniAppLoginSuccessResponse = await completeRawSessionLogin({
      totpCode: generateMiniAppTotpCodeAt(totpSecret, Date.now()),
    });
    expect(miniAppAuthSessions.size).toBe(MINI_APP_SESSION_MAX);
    expect(miniAppAuthSessions.has(activeLogins[2]!.sessionToken)).toBeFalse();
    expect(miniAppAuthSessions.has(rotatedSecondToken)).toBeTrue();
    expect(miniAppAuthSessions.has(seventhTotp.sessionToken)).toBeTrue();

    // 任一已登录客户端执行登出后立即释放 1 个密钥槽位，下一次登录不再淘汰其它会话。
    const logoutRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/auth/logout", {
        method: "POST",
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: activeLogins[3]!.sessionToken,
        },
      })
    );
    expect(logoutRes.status).toBe(200);
    expect(miniAppAuthSessions.size).toBe(MINI_APP_SESSION_MAX - 1);
    const sessionsBeforeRefill: string[] = [...miniAppAuthSessions.keys()];

    setSystemTime(new Date(Date.now() + 30_000));
    await completeRawSessionLogin({
      totpCode: generateMiniAppTotpCodeAt(totpSecret, Date.now()),
    });
    expect(miniAppAuthSessions.size).toBe(MINI_APP_SESSION_MAX);
    for (const token of sessionsBeforeRefill) {
      expect(miniAppAuthSessions.has(token)).toBeTrue();
    }

    // 45 分钟有效期届满后，过期会话自动清理并释放全部槽位。
    setSystemTime(new Date(Date.now() + MINI_APP_SESSION_TTL_MS + 1_000));
    await completeRawSessionLogin({
      totpCode: generateMiniAppTotpCodeAt(totpSecret, Date.now()),
    });
    expect(miniAppAuthSessions.size).toBe(1);
  });

  test("密钥仅在登录与加密路由滑动续期时签发（precheck/图片不轮换），续期新密钥经旧密钥封装下发且客户端确认新令牌后旧密钥立即失效", async () => {
    const baseMs: number = 1_775_000_000_000;
    setSystemTime(new Date(baseMs));
    const password: string = getBotMiniAppConfig()!.password;

    const loginBody: MiniAppLoginSuccessResponse =
      await completeRawSessionLogin({ password });
    const tokenA: string = loginBody.sessionToken;
    const keyAHex: string = loginBody.sessionKey;
    const cryptoKeyA: CryptoKey = await importMiniAppAesGcmKey(keyAHex);

    // 推进超过 5 分钟最长轮换阈值：precheck 仅只读核验，绝不轮换令牌或签发新密钥。
    const afterThresholdMs: number =
      baseMs + MINI_APP_SESSION_REFRESH_MAX_MS + 2_000;
    setSystemTime(new Date(afterThresholdMs));

    const precheckRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/auth/precheck", {
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: tokenA,
        },
      })
    );
    expect(precheckRes.status).toBe(200);
    expect(precheckRes.headers.get(MINI_APP_SESSION_HEADER)).toBeNull();
    expect(precheckRes.headers.get(MINI_APP_SESSION_KEY_HEADER)).toBeNull();
    expect(miniAppAuthSessions.has(tokenA)).toBeTrue();

    // 访问加密业务路由触发滑动续期：本次响应仍用 keyA 加密，同时通过 X-Mini-App-Session-Key 下发用 keyA + tokenB(AAD) 封装的 keyB。
    const rotateRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: tokenA,
        },
      })
    );
    expect(rotateRes.status).toBe(200);
    const tokenB: string | null = rotateRes.headers.get(MINI_APP_SESSION_HEADER);
    const expiresAtB: string | null = rotateRes.headers.get(
      MINI_APP_SESSION_EXPIRES_AT_HEADER
    );
    const sealedKeyB: string | null = rotateRes.headers.get(
      MINI_APP_SESSION_KEY_HEADER
    );
    expect(tokenB).toMatch(/^[0-9a-f]{64}$/u);
    expect(tokenB).not.toBe(tokenA);
    expect(Number(expiresAtB)).toBe(afterThresholdMs + MINI_APP_SESSION_TTL_MS);
    expect(sealedKeyB).not.toBeNull();

    // 篡改绑定的新 token AAD 时无法解封新密钥。
    await expect(
      unsealRotatedSessionKey(cryptoKeyA, sealedKeyB!, "0".repeat(64))
    ).rejects.toThrow(MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE);

    const keyBHex: string = await unsealRotatedSessionKey(
      cryptoKeyA,
      sealedKeyB!,
      tokenB!
    );
    expect(keyBHex).toMatch(/^[0-9a-f]{64}$/u);
    expect(keyBHex).not.toBe(keyAHex);
    const cryptoKeyB: CryptoKey = await importMiniAppAesGcmKey(keyBHex!);

    const rotateEnvelope: Readonly<MiniAppEncryptedEnvelope> =
      parseMiniAppEncryptedEnvelope(await rotateRes.json())!;
    expect(
      await decryptMiniAppText({
        cryptoKey: cryptoKeyA,
        encrypted: rotateEnvelope,
        additionalData: buildMiniAppEnvelopeAad("GET", "/api/status", "res"),
      })
    ).not.toBeNull();
    expect(miniAppAuthSessions.get(tokenB!)?.pendingSessionKey).toBeUndefined();

    // 在客户端首次发送 tokenB 之前，并发在途的 tokenA + keyA 请求仍可解密与响应。
    const concurrentInFlightRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: tokenA,
        },
      })
    );
    expect(concurrentInFlightRes.status).toBe(200);
    const concurrentEnv: Readonly<MiniAppEncryptedEnvelope> =
      parseMiniAppEncryptedEnvelope(await concurrentInFlightRes.json())!;
    expect(
      await decryptMiniAppText({
        cryptoKey: cryptoKeyA,
        encrypted: concurrentEnv,
        additionalData: buildMiniAppEnvelopeAad("GET", "/api/status", "res"),
      })
    ).not.toBeNull();

    // 客户端首次携带新令牌 tokenB 发起请求：响应由新密钥 keyB 加密，且服务端立即作废旧令牌 tokenA、旧密钥与旧 IV 去重集（续期替换成功即失效）。
    const confirmNewRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: tokenB!,
        },
      })
    );
    expect(confirmNewRes.status).toBe(200);
    const confirmEnv: Readonly<MiniAppEncryptedEnvelope> =
      parseMiniAppEncryptedEnvelope(await confirmNewRes.json())!;
    expect(
      await decryptMiniAppText({
        cryptoKey: cryptoKeyB,
        encrypted: confirmEnv,
        additionalData: buildMiniAppEnvelopeAad("GET", "/api/status", "res"),
      })
    ).not.toBeNull();
    expect(
      await decryptMiniAppText({
        cryptoKey: cryptoKeyA,
        encrypted: confirmEnv,
        additionalData: buildMiniAppEnvelopeAad("GET", "/api/status", "res"),
      })
    ).toBeNull();
    expect(miniAppAuthSessions.get(tokenB!)?.previousToken).toBeUndefined();
    expect(miniAppAuthSessions.get(tokenB!)?.pendingSessionKey).toBeUndefined();
    expect(miniAppAuthSessions.get(tokenB!)?.previousCryptoKey).toBeUndefined();
    expect(miniAppAuthSessions.get(tokenB!)?.previousSeenRequestIvs).toBeUndefined();

    const oldTokenAfterConfirmRes: Response =
      await dispatchRawMiniAppTestRequest(
        new Request("http://127.0.0.1:3000/api/status", {
          headers: {
            [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
            [MINI_APP_SESSION_HEADER]: tokenA,
          },
        })
      );
    expect(oldTokenAfterConfirmRes.status).toBe(401);
  });

  test("严格拒绝畸形信封（多余字段、空白、URL-safe、缺失填充、非零填充残位、错误 IV 长度与过短密文），满 5 会话时原地续期不超限，且真实 HTTP 携带超 32 KiB 外层 Content-Length 时正常解密 30 KiB 明文", async () => {
    const baseMs: number = 1_778_000_000_000;
    setSystemTime(new Date(baseMs));
    const password: string = getBotMiniAppConfig()!.password;

    const logins: MiniAppLoginSuccessResponse[] = [];
    for (let i: number = 0; i < MINI_APP_SESSION_MAX; i += 1) {
      logins.push(await completeRawSessionLogin({ password }));
    }
    const firstLogin: MiniAppLoginSuccessResponse = logins[0]!;
    const cryptoKey: CryptoKey = await importMiniAppAesGcmKey(
      firstLogin.sessionKey
    );
    const headers: Record<string, string> = {
      [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
      [MINI_APP_SESSION_HEADER]: firstLogin.sessionToken,
      "Content-Type": "application/json",
    };

    const validEnv: Readonly<MiniAppEncryptedEnvelope> =
      await encryptMiniAppEnvelope(
        cryptoKey,
        JSON.stringify({ id: 500_010, enabled: true }),
        buildMiniAppEnvelopeAad("POST", "/api/identities/whitelist", "req")
      );
    const badEnvelopes: readonly unknown[] = [
      { ...validEnv, extra: 1 },
      { encrypted: true, iv: ` ${validEnv.iv}`, payload: validEnv.payload },
      { encrypted: true, iv: validEnv.iv, payload: `${validEnv.payload} ` },
      { encrypted: true, iv: "AAAAAAAAAAAAAAAA", payload: "AQI" },
      { encrypted: true, iv: "AAAAAAAAAAAAAAAA", payload: "AQJ=" },
      { encrypted: true, iv: "AAAAAAAAAAAA-AAA", payload: validEnv.payload },
      { encrypted: true, iv: "AAAAAAAAAAAA", payload: validEnv.payload },
      { encrypted: true, iv: validEnv.iv, payload: "AAAAAAAAAAAAAAAAAAAA" },
    ];
    for (const candidate of badEnvelopes) {
      const badRes: Response = await dispatchRawMiniAppTestRequest(
        new Request("http://127.0.0.1:3000/api/identities/whitelist", {
          method: "POST",
          headers,
          body: JSON.stringify(candidate),
        })
      );
      expect(badRes.status).toBe(400);
    }

    // 30 KiB 明文经 AES-GCM + Base64 膨胀至约 40 KiB，显式携带外层 Content-Length 时解密后不得被内层 32 KiB 上限误拒。
    const nearLimitPlain: string = JSON.stringify({
      id: 500_011,
      enabled: true,
      pad: "x".repeat(30_000),
    });
    const nearLimitWire: string = JSON.stringify(
      await encryptMiniAppEnvelope(
        cryptoKey,
        nearLimitPlain,
        buildMiniAppEnvelopeAad("POST", "/api/identities/whitelist", "req")
      )
    );
    const nearLimitWireBytes: number = new TextEncoder().encode(
      nearLimitWire
    ).byteLength;
    expect(nearLimitWireBytes).toBeGreaterThan(MINI_APP_MAX_JSON_BODY_BYTES);
    const nearLimitRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/identities/whitelist", {
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": String(nearLimitWireBytes),
        },
        body: nearLimitWire,
      })
    );
    expect(nearLimitRes.status).toBe(200);

    // 满 5 个活跃会话时触发滑动续期：原地替换不淘汰其余 4 个活跃会话，总数恒为 5。
    setSystemTime(
      new Date(baseMs + MINI_APP_SESSION_REFRESH_MAX_MS + 1_000)
    );
    const rotateAtCapRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/status", { headers })
    );
    expect(rotateAtCapRes.status).toBe(200);
    const rotatedFirstToken: string | null = rotateAtCapRes.headers.get(
      MINI_APP_SESSION_HEADER
    );
    expect(rotatedFirstToken).toMatch(/^[0-9a-f]{64}$/u);
    expect(miniAppAuthSessions.size).toBe(MINI_APP_SESSION_MAX);
    for (let i: number = 1; i < logins.length; i += 1) {
      expect(miniAppAuthSessions.has(logins[i]!.sessionToken)).toBeTrue();
    }
  });

  test("加密 GET 查询参数（?e=）在配置读取、白名单搜索、图库分页与子路径反向代理前缀下完整往返并绑定规范化 AAD", async () => {
    const server = startMiniAppServer({
      url: "https://miniapp.example.com/console",
      host: "127.0.0.1",
      port: 0,
      password: "query-enc-password-123456",
    });
    expect(server).not.toBeNull();
    const baseUrl: string = `http://127.0.0.1:${server!.port}`;

    const { payload: queryLoginPayload } = await performMiniAppTestEcdhLogin({
      initData: adminInitData(),
      credentialPayload: { password: "query-enc-password-123456" },
      baseUrl: `${baseUrl}/console`,
      send: (req: Request): Promise<Response> => fetch(req),
    });
    const loginBody: MiniAppLoginSuccessResponse =
      queryLoginPayload as unknown as MiniAppLoginSuccessResponse;
    const cryptoKey: CryptoKey = await importMiniAppAesGcmKey(
      loginBody.sessionKey
    );
    const headers: Record<string, string> = {
      [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
      [MINI_APP_SESSION_HEADER]: loginBody.sessionToken,
    };

    const decryptJson = async <T>(
      res: Response,
      routePath: string
    ): Promise<T> => {
      const env: Readonly<MiniAppEncryptedEnvelope> | null =
        parseMiniAppEncryptedEnvelope(await res.json());
      expect(env).not.toBeNull();
      const plain: string | null = await decryptMiniAppText({
        cryptoKey,
        encrypted: env!,
        additionalData: buildMiniAppEnvelopeAad("GET", routePath, "res"),
      });
      expect(plain).not.toBeNull();
      return JSON.parse(plain!) as T;
    };

    // 1. /api/configs/file?scope=dynamic&fileName=ad_detect.json 往返及 ${basePath}/api/... 子路径 AAD 兼容。
    const sealedConfigQuery: string = await sealMiniAppQuery(
      cryptoKey,
      "scope=dynamic&fileName=ad_detect.json",
      "GET /api/configs/file"
    );
    expect(
      await unsealMiniAppQuery(
        cryptoKey,
        sealedConfigQuery,
        "GET /api/configs/file"
      )
    ).toBe("scope=dynamic&fileName=ad_detect.json");

    const encodedConfigParam: string = `${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(sealedConfigQuery)}`;
    const rootConfigRes: Response = await fetch(
      `${baseUrl}/api/configs/file?${encodedConfigParam}`,
      { headers }
    );
    expect(rootConfigRes.status).toBe(200);
    const rootConfigBody: MiniAppConfigFileResponse =
      await decryptJson<MiniAppConfigFileResponse>(rootConfigRes, "/api/configs/file");
    expect(rootConfigBody.ok).toBeTrue();
    expect(rootConfigBody.fileName).toBe("ad_detect.json");

    const subPathSealedConfigQuery: string = await sealMiniAppQuery(
      cryptoKey,
      "scope=dynamic&fileName=ad_detect.json",
      "GET /api/configs/file"
    );
    const subPathConfigRes: Response = await fetch(
      `${baseUrl}/console/api/configs/file?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(subPathSealedConfigQuery)}`,
      { headers }
    );
    expect(subPathConfigRes.status).toBe(200);
    const subPathConfigBody: MiniAppConfigFileResponse =
      await decryptJson<MiniAppConfigFileResponse>(subPathConfigRes, "/api/configs/file");
    expect(subPathConfigBody).toEqual(rootConfigBody);

    // 2. /api/identities/whitelist?page=1&pageSize=10&q=doro 加密查询往返并精确命中过滤词。
    miniAppTestWhitelistRows.set(
      500_201,
      JSON.stringify({
        permissions: DEFAULT_WHITELIST_PERMISSIONS,
        meta: { firstName: "Doro", lastName: "Pink", username: "doro_chan" },
      })
    );
    miniAppTestWhitelistRows.set(
      500_202,
      JSON.stringify({
        permissions: DEFAULT_WHITELIST_PERMISSIONS,
        meta: { firstName: "Other", lastName: "Member", username: "someone" },
      })
    );
    const sealedWhitelistQuery: string = await sealMiniAppQuery(
      cryptoKey,
      "page=1&pageSize=10&q=doro",
      "GET /api/identities/whitelist"
    );
    const whitelistRes: Response = await fetch(
      `${baseUrl}/console/api/identities/whitelist?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(sealedWhitelistQuery)}`,
      { headers }
    );
    expect(whitelistRes.status).toBe(200);
    const whitelistPage: MiniAppWhitelistPage =
      await decryptJson<MiniAppWhitelistPage>(whitelistRes, "/api/identities/whitelist");
    expect(whitelistPage.page).toBe(1);
    expect(whitelistPage.pageSize).toBe(10);
    expect(whitelistPage.items.map((item) => item.id)).toEqual([500_201]);

    // 3. /api/gallery?page=1&pageSize=10 加密查询往返。
    const galleryDir: string = getAssetConfig().randomHImageDirectory;
    rmSync(galleryDir, { recursive: true, force: true });
    mkdirSync(galleryDir, { recursive: true });
    const pngBytes: Uint8Array = await new Bun.Image(imageFixture(8, 8))
      .png()
      .bytes();
    await storeRandomImage(galleryDir, pngBytes);

    const sealedGalleryQuery: string = await sealMiniAppQuery(
      cryptoKey,
      "page=1&pageSize=10",
      "GET /api/gallery"
    );
    const galleryRes: Response = await fetch(
      `${baseUrl}/api/gallery?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(sealedGalleryQuery)}`,
      { headers }
    );
    expect(galleryRes.status).toBe(200);
    const galleryPage: MiniAppGalleryPage =
      await decryptJson<MiniAppGalleryPage>(galleryRes, "/api/gallery");
    expect(galleryPage.page).toBe(1);
    expect(galleryPage.pageSize).toBe(10);
    expect(galleryPage.total).toBe(1);
  });

  test("加密路由严格拒绝明文查询参数、裸 ?、混合参数、空/超长/畸形/篡改 ?e= 以及跨路由或跨方法 AAD 重放", async () => {
    const password: string = getBotMiniAppConfig()!.password;
    const loginBody: MiniAppLoginSuccessResponse =
      await completeRawSessionLogin({ password });
    const cryptoKey: CryptoKey = await importMiniAppAesGcmKey(
      loginBody.sessionKey
    );
    const headers: Record<string, string> = {
      [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
      [MINI_APP_SESSION_HEADER]: loginBody.sessionToken,
    };

    const assertInvalidEncryptedPayload = async (
      response: Response,
      method: string = "GET",
      routePath: string = "/api/configs/file"
    ): Promise<void> => {
      expect(response.status).toBe(400);
      const env: Readonly<MiniAppEncryptedEnvelope> | null =
        parseMiniAppEncryptedEnvelope(await response.json());
      expect(env).not.toBeNull();
      const plain: string | null = await decryptMiniAppText({
        cryptoKey,
        encrypted: env!,
        additionalData: buildMiniAppEnvelopeAad(method, routePath, "res"),
      });
      expect(plain).not.toBeNull();
      expect(JSON.parse(plain!)).toEqual({
        error: MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
      });
    };

    // unsealMiniAppQuery 底层边界核验：空串、超长、缺分割点、多分割点、错误 AAD 与含空白 Base64 一律返回 null。
    const validGallerySealed: string = await sealMiniAppQuery(
      cryptoKey,
      "page=1&pageSize=10",
      "GET /api/gallery"
    );
    expect(await unsealMiniAppQuery(cryptoKey, "", "GET /api/gallery")).toBeNull();
    expect(
      await unsealMiniAppQuery(
        cryptoKey,
        "A".repeat(MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH + 1),
        "GET /api/gallery"
      )
    ).toBeNull();
    expect(
      await unsealMiniAppQuery(cryptoKey, "nodotatall", "GET /api/gallery")
    ).toBeNull();
    expect(
      await unsealMiniAppQuery(cryptoKey, "AAAA.", "GET /api/gallery")
    ).toBeNull();
    expect(
      await unsealMiniAppQuery(cryptoKey, `a.${validGallerySealed}`, "GET /api/gallery")
    ).toBeNull();
    expect(
      await unsealMiniAppQuery(cryptoKey, ` ${validGallerySealed}`, "GET /api/gallery")
    ).toBeNull();
    expect(
      await unsealMiniAppQuery(
        cryptoKey,
        validGallerySealed,
        "GET /api/identities/whitelist"
      )
    ).toBeNull();

    const validConfigSealed: string = await sealMiniAppQuery(
      cryptoKey,
      "scope=dynamic&fileName=ad_detect.json",
      "GET /api/configs/file"
    );
    const dotIdx: number = validConfigSealed.indexOf(".");
    const cipherBytes: Uint8Array = Uint8Array.fromBase64(
      validConfigSealed.slice(dotIdx + 1)
    );
    cipherBytes[0] = (cipherBytes[0] ?? 0) ^ 0xff;
    const tamperedConfigSealed: string = `${validConfigSealed.slice(0, dotIdx)}.${cipherBytes.toBase64()}`;

    const emptyPlainPayload = await encryptMiniAppPayload(
      cryptoKey,
      "",
      encodeUtf8Bytes("GET /api/configs/file")
    );
    const encryptedEmptyPlainQuery: string =
      `${emptyPlainPayload.iv}.${emptyPlainPayload.payload}`;
    const encryptedTabNewlineQuery: string = await sealMiniAppQuery(
      cryptoKey,
      "\t\r\n",
      "GET /api/configs/file"
    );
    const oversizedToken: string = "A".repeat(
      MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH + 1
    );

    const rejectedGetUrls: readonly string[] = [
      // 明文查询串
      "http://127.0.0.1:3000/api/configs/file?scope=dynamic&fileName=ad_detect.json",
      "http://127.0.0.1:3000/api/gallery?page=1",
      "http://127.0.0.1:3000/api/chats/detail?chatId=-1001",
      "http://127.0.0.1:3000/api/chats/messages?chatId=-1001&page=1",
      "http://127.0.0.1:3000/api/chats/targets?chatId=-1001",
      // 裸 ? 空查询分隔符
      "http://127.0.0.1:3000/api/configs/file?",
      "http://127.0.0.1:3000/api/configs/file?#frag",
      // 混合查询参数、尾随 & 与重复 e 参数
      `http://127.0.0.1:3000/api/configs/file?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(validConfigSealed)}&page=1`,
      `http://127.0.0.1:3000/api/configs/file?page=1&${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(validConfigSealed)}`,
      `http://127.0.0.1:3000/api/configs/file?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(validConfigSealed)}&`,
      `http://127.0.0.1:3000/api/configs/file?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(validConfigSealed)}&${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(validConfigSealed)}`,
      // 空 e、解密为空明文、解密为纯控制空白及超出 4096 字符上限
      `http://127.0.0.1:3000/api/configs/file?${MINI_APP_ENCRYPTED_QUERY_PARAM}=`,
      `http://127.0.0.1:3000/api/configs/file?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(encryptedEmptyPlainQuery)}`,
      `http://127.0.0.1:3000/api/configs/file?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(encryptedTabNewlineQuery)}`,
      `http://127.0.0.1:3000/api/configs/file?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${oversizedToken}`,
      // 篡改密文与跨路由重放（/api/gallery 令牌重放到 /api/identities/whitelist）
      `http://127.0.0.1:3000/api/configs/file?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(tamperedConfigSealed)}`,
      `http://127.0.0.1:3000/api/identities/whitelist?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(validGallerySealed)}`,
    ];

    for (const badUrl of rejectedGetUrls) {
      const badRes: Response = await dispatchRawMiniAppTestRequest(
        new Request(badUrl, { headers })
      );
      const badRoutePath: string = new URL(badUrl).pathname;
      await assertInvalidEncryptedPayload(badRes, "GET", badRoutePath);
    }

    // 非 GET 方法同样校验查询参数与方法级 AAD：POST 携带明文查询或携带 GET AAD 密文查询均被拒绝。
    const postEnvelope: Readonly<MiniAppEncryptedEnvelope> =
      await encryptMiniAppEnvelope(
        cryptoKey,
        JSON.stringify({ id: 500_301, enabled: true }),
        buildMiniAppEnvelopeAad("POST", "/api/identities/whitelist", "req")
      );
    const plainQueryOnPostRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/identities/whitelist?page=1", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(postEnvelope),
      })
    );
    await assertInvalidEncryptedPayload(
      plainQueryOnPostRes,
      "POST",
      "/api/identities/whitelist"
    );

    const getAadSealedForWhitelist: string = await sealMiniAppQuery(
      cryptoKey,
      "page=1",
      "GET /api/identities/whitelist"
    );
    const wrongMethodAadOnPostRes: Response = await dispatchRawMiniAppTestRequest(
      new Request(
        `http://127.0.0.1:3000/api/identities/whitelist?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(getAadSealedForWhitelist)}`,
        { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(postEnvelope) }
      )
    );
    await assertInvalidEncryptedPayload(wrongMethodAadOnPostRes, "POST", "/api/identities/whitelist");
  });
});

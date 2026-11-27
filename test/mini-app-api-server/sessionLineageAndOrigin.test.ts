/**
 * Mini App TOTP 变更按谱系保留调用者、轮换密文共享 `sealedSessionKeyPromise` 补发窗口、
 * 完整 Origin 协议校验及严格单查询参数解析专项测试。
 */

import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import type {
  MiniAppAccessDiagnostics,
  MiniAppAuthSession,
  MiniAppLoginSuccessResponse,
} from "../../packages/types/miniApp/auth";
import type {
  MiniAppTotpMutationResponse,
  MiniAppTotpSetupResponse,
} from "../../packages/types/miniAppTotp";
import {
  buildSignedTestInitData,
  buildSuperAdminHeaders,
  installMiniAppTestDiskIOMock,
  resetMiniAppTestDiskIOState,
} from "../helpers/miniAppInitData";

installMiniAppTestDiskIOMock();

const {
  miniAppActiveUrlPartsHolder,
  miniAppAuthHandshakes,
  miniAppAuthSessions,
  miniAppGalleryDownloadTickets,
  miniAppPasswordGuardHolder,
  miniAppPendingTotpSetupHolder,
  miniAppTotpRecordHolder,
} = await import("../../packages/cache/main/miniApp");
const { BOT_TOKEN, SUPER_ADMIN_USER_ID, getBotMiniAppConfig } = await import(
  "../../packages/config/bot"
);
const {
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_SESSION_HEADER,
  MINI_APP_SESSION_PREVIOUS_GRACE_MS,
} = await import("../../packages/consts/miniApp");
const {
  MINI_APP_ENCRYPTED_QUERY_PARAM,
  MINI_APP_SESSION_KEY_HEADER,
} = await import("../../packages/consts/miniAppCrypto");
const { MINI_APP_TOTP_FILE_PATH, MINI_APP_TOTP_MEMORY_DIR } = await import(
  "../../packages/consts/paths"
);
const { generateMiniAppTotpCodeAt } = await import("../../packages/libs/miniAppTotp");
const {
  issueMiniAppAuthSession,
  stopMiniAppServer,
} = await import("../../packages/mini-app-api-server");
const {
  commitMiniAppSessionAccess,
  lookupMiniAppSessionState,
} = await import("../../packages/mini-app-api-server/auth/session");
const {
  buildMiniAppEnvelopeAad,
  decryptMiniAppText,
  importMiniAppAesGcmKey,
  parseMiniAppEncryptedEnvelope,
} = await import("../../packages/mini-app-api-server/libs/crypto");
const { parseStrictSingleQueryParam } = await import(
  "../../packages/mini-app-api-server/libs/request"
);
const { deriveMiniAppPublicUrlParts } = await import(
  "../../packages/mini-app-api-server/libs/routePath"
);
const { isAllowedRequestOriginUrl } = await import(
  "../../packages/mini-app-api-server/middleware/headerGuard"
);
const { unsealRotatedSessionKey: frontendUnsealRotatedSessionKey } = await import(
  "../../packages/mini-app-frontend/libs/crypto"
);
const {
  dispatchMiniAppTestRequest,
  dispatchRawMiniAppTestRequest,
  performMiniAppTestEcdhLogin,
} = await import("../helpers/miniAppRequest");

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

afterEach(async (): Promise<void> => {
  await stopMiniAppServer();
  rmSync(MINI_APP_TOTP_MEMORY_DIR, { recursive: true, force: true });
  resetMiniAppTestDiskIOState();
  miniAppAuthSessions.clear();
  miniAppAuthHandshakes.clear();
  miniAppGalleryDownloadTickets.clear();
  miniAppPasswordGuardHolder.current = null;
  miniAppPendingTotpSetupHolder.current = null;
  miniAppTotpRecordHolder.current = undefined;
  miniAppActiveUrlPartsHolder.current = null;
  setSystemTime();
});

describe("Mini App TOTP 变更按谱系保留调用者与轮换密文共享 Promise 补发窗口", () => {
  test("TOTP 启用与删除在写盘/删盘 await 期间发生会话轮换并确认时，仍按 lineageId 保留调用者会话并吊销其他会话", async () => {
    const baseMs: number = 1_787_300_000_000;
    setSystemTime(new Date(baseMs));
    const callerSession: Readonly<MiniAppAuthSession> =
      issueMiniAppAuthSession(baseMs);
    const otherBeforeEnable: Readonly<MiniAppAuthSession> =
      issueMiniAppAuthSession(baseMs);

    const setupRes: Response = await dispatchMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/totp/setup", {
        method: "POST",
        headers: buildSuperAdminHeaders({
          botToken: BOT_TOKEN,
          superAdminUserId: SUPER_ADMIN_USER_ID,
          sessionToken: callerSession.token,
        }),
      })
    );
    expect(setupRes.status).toBe(200);
    const setupBody: MiniAppTotpSetupResponse =
      (await setupRes.json()) as MiniAppTotpSetupResponse;
    const validCode: string = generateMiniAppTotpCodeAt(setupBody.secret, baseMs);

    // 1. 拦截 POST /api/totp/enable 写盘，暂停期间轮换并确认调用者会话，恢复后调用者最新会话存活、其他会话被吊销。
    const writeEntered: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const releaseWrite: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const realWrite: typeof Bun.write = Bun.write.bind(Bun);
    let interceptedEnableWrite: boolean = false;
    const writeSpy = spyOn(Bun, "write").mockImplementation(
      (async (target: unknown, input: unknown): Promise<number> => {
        if (!interceptedEnableWrite) {
          interceptedEnableWrite = true;
          writeEntered.resolve();
          await releaseWrite.promise;
        }
        return realWrite(
          target as Parameters<typeof Bun.write>[0],
          input as Parameters<typeof Bun.write>[1]
        );
      }) as typeof Bun.write
    );

    let rotatedAfterEnable: string;
    try {
      const enablePromise: Promise<Response> = dispatchMiniAppTestRequest(
        new Request("http://127.0.0.1:3000/api/totp/enable", {
          method: "POST",
          headers: buildSuperAdminHeaders({
            botToken: BOT_TOKEN,
            superAdminUserId: SUPER_ADMIN_USER_ID,
            sessionToken: callerSession.token,
            contentType: "application/json",
          }),
          body: JSON.stringify({ code: validCode }),
        })
      );
      await writeEntered.promise;

      setSystemTime(new Date(callerSession.nextRefreshAt + 1));
      const rotateRes: Response = await dispatchMiniAppTestRequest(
        new Request("http://127.0.0.1:3000/api/status", {
          headers: buildSuperAdminHeaders({
            botToken: BOT_TOKEN,
            superAdminUserId: SUPER_ADMIN_USER_ID,
            sessionToken: callerSession.token,
          }),
        })
      );
      rotatedAfterEnable = rotateRes.headers.get(MINI_APP_SESSION_HEADER)!;
      expect(rotatedAfterEnable).not.toBe(callerSession.token);
      expect(
        (
          await dispatchMiniAppTestRequest(
            new Request("http://127.0.0.1:3000/api/status", {
              headers: buildSuperAdminHeaders({
                botToken: BOT_TOKEN,
                superAdminUserId: SUPER_ADMIN_USER_ID,
                sessionToken: rotatedAfterEnable,
              }),
            })
          )
        ).status
      ).toBe(200);
      expect(
        miniAppAuthSessions.get(rotatedAfterEnable)?.previousToken
      ).toBeUndefined();

      releaseWrite.resolve();
      const enableRes: Response = await enablePromise;
      expect(enableRes.status).toBe(200);
      expect(((await enableRes.json()) as MiniAppTotpMutationResponse).ok).toBeTrue();
    } finally {
      releaseWrite.resolve();
      writeSpy.mockRestore();
    }

    expect(miniAppAuthSessions.has(otherBeforeEnable.token)).toBeFalse();
    expect(miniAppAuthSessions.has(rotatedAfterEnable)).toBeTrue();

    // 2. 拦截 POST /api/totp/delete 删盘，暂停期间再次轮换并确认调用者会话，恢复后调用者最新会话存活、其他会话被吊销。
    const otherBeforeDelete: Readonly<MiniAppAuthSession> =
      issueMiniAppAuthSession(Date.now());
    const currentBeforeDelete: Readonly<MiniAppAuthSession> =
      miniAppAuthSessions.get(rotatedAfterEnable)!;
    const deleteEntered: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const releaseDelete: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const realBunFile: typeof Bun.file = Bun.file.bind(Bun);
    let interceptedDelete: boolean = false;
    const deleteFileSpy = spyOn(Bun, "file").mockImplementation(
      ((path: string | URL, options?: unknown): ReturnType<typeof Bun.file> => {
        const bf = realBunFile(path as string, options as never);
        if (path === MINI_APP_TOTP_FILE_PATH && !interceptedDelete) {
          interceptedDelete = true;
          const origDelete = bf.delete.bind(bf);
          return new Proxy(bf, {
            get(target, prop, receiver): unknown {
              if (prop === "delete") {
                return async (): Promise<void> => {
                  deleteEntered.resolve();
                  await releaseDelete.promise;
                  await origDelete();
                };
              }
              return Reflect.get(target, prop, receiver);
            },
          });
        }
        return bf;
      }) as typeof Bun.file
    );

    let rotatedAfterDelete: string;
    try {
      const deletePromise: Promise<Response> = dispatchMiniAppTestRequest(
        new Request("http://127.0.0.1:3000/api/totp/delete", {
          method: "POST",
          headers: buildSuperAdminHeaders({
            botToken: BOT_TOKEN,
            superAdminUserId: SUPER_ADMIN_USER_ID,
            sessionToken: rotatedAfterEnable,
          }),
        })
      );
      await deleteEntered.promise;

      setSystemTime(new Date(currentBeforeDelete.nextRefreshAt + 1));
      const rotateRes2: Response = await dispatchMiniAppTestRequest(
        new Request("http://127.0.0.1:3000/api/status", {
          headers: buildSuperAdminHeaders({
            botToken: BOT_TOKEN,
            superAdminUserId: SUPER_ADMIN_USER_ID,
            sessionToken: rotatedAfterEnable,
          }),
        })
      );
      rotatedAfterDelete = rotateRes2.headers.get(MINI_APP_SESSION_HEADER)!;
      expect(rotatedAfterDelete).not.toBe(rotatedAfterEnable);
      expect(
        (
          await dispatchMiniAppTestRequest(
            new Request("http://127.0.0.1:3000/api/status", {
              headers: buildSuperAdminHeaders({
                botToken: BOT_TOKEN,
                superAdminUserId: SUPER_ADMIN_USER_ID,
                sessionToken: rotatedAfterDelete,
              }),
            })
          )
        ).status
      ).toBe(200);

      releaseDelete.resolve();
      const deleteRes: Response = await deletePromise;
      expect(deleteRes.status).toBe(200);
    } finally {
      releaseDelete.resolve();
      deleteFileSpy.mockRestore();
    }

    expect(miniAppAuthSessions.has(otherBeforeDelete.token)).toBeFalse();
    expect(miniAppAuthSessions.has(rotatedAfterDelete)).toBeTrue();
  });

  test("轮换密文封装在途窗口内并发 previousToken 请求等待同一 sealedSessionKeyPromise 并收到一致轮换头，且宽限期满同步清理", async () => {
    const baseMs: number = 1_787_400_000_000;
    setSystemTime(new Date(baseMs));
    const password: string = getBotMiniAppConfig()!.password;
    const login: MiniAppLoginSuccessResponse = (
      await performMiniAppTestEcdhLogin({
        initData: adminInitData(),
        credentialPayload: { password },
      })
    ).payload as unknown as MiniAppLoginSuccessResponse;
    const firstKey: CryptoKey = await importMiniAppAesGcmKey(login.sessionKey);
    const firstSession: Readonly<MiniAppAuthSession> =
      miniAppAuthSessions.get(login.sessionToken)!;

    setSystemTime(new Date(firstSession.nextRefreshAt + 1));

    const sealEntered: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const releaseSeal: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const originalEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let sealEncryptCount: number = 0;
    const encryptSpy = spyOn(crypto.subtle, "encrypt").mockImplementation(
      async (
        ...args: Parameters<SubtleCrypto["encrypt"]>
      ): Promise<ArrayBuffer> => {
        const algo = args[0] as { readonly additionalData?: ArrayBuffer | ArrayBufferView };
        const aadBytes: Uint8Array = algo.additionalData
          ? new Uint8Array(
            ArrayBuffer.isView(algo.additionalData)
              ? algo.additionalData.buffer.slice(
                algo.additionalData.byteOffset,
                algo.additionalData.byteOffset + algo.additionalData.byteLength
              )
              : algo.additionalData
          )
          : new Uint8Array(0);
        const aadText: string = new TextDecoder().decode(aadBytes);
        // 轮换封装的 AAD 为 64 位十六进制新令牌，不含空格与冒号。
        if (/^[0-9a-f]{64}$/u.test(aadText)) {
          sealEncryptCount += 1;
          sealEntered.resolve();
          await releaseSeal.promise;
        }
        return originalEncrypt(...args);
      }
    );

    let r1Res: Response;
    let r2Res: Response;
    try {
      const r1Promise: Promise<Response> = dispatchRawMiniAppTestRequest(
        new Request("http://127.0.0.1:3000/api/status", {
          headers: {
            [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
            [MINI_APP_SESSION_HEADER]: login.sessionToken,
          },
        })
      );
      await sealEntered.promise;

      expect(miniAppAuthSessions.size).toBe(1);
      const inFlightSession: Readonly<MiniAppAuthSession> = [
        ...miniAppAuthSessions.values(),
      ][0]!;
      expect(inFlightSession.previousToken).toBe(login.sessionToken);
      expect(inFlightSession.pendingSessionKey).toBeUndefined();
      expect(inFlightSession.sealedSessionKey).toBeUndefined();
      expect(inFlightSession.sealedSessionKeyPromise).toBeDefined();

      const r2Promise: Promise<Response> = dispatchRawMiniAppTestRequest(
        new Request("http://127.0.0.1:3000/api/status", {
          headers: {
            [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
            [MINI_APP_SESSION_HEADER]: login.sessionToken,
          },
        })
      );
      const nonRotatingCommit = commitMiniAppSessionAccess({
        session: inFlightSession,
        requestToken: login.sessionToken,
        matchedViaPrevious: true,
        allowRotation: false,
        nowMs: Date.now(),
      });
      expect(nonRotatingCommit.ok).toBeTrue();
      if (nonRotatingCommit.ok) {
        expect(nonRotatingCommit.sealedSessionKeyPromise).toBeUndefined();
        expect(nonRotatingCommit.redeliveredSealedSessionKey).toBeUndefined();
      }

      releaseSeal.resolve();
      const settled = await Promise.allSettled([r1Promise, r2Promise]);
      expect(settled[0]?.status).toBe("fulfilled");
      expect(settled[1]?.status).toBe("fulfilled");
      r1Res = (settled[0] as PromiseFulfilledResult<Response>).value;
      r2Res = (settled[1] as PromiseFulfilledResult<Response>).value;
    } finally {
      releaseSeal.resolve();
      encryptSpy.mockRestore();
    }

    expect(sealEncryptCount).toBe(1);
    expect(r1Res.status).toBe(200);
    expect(r2Res.status).toBe(200);
    const newToken: string = r1Res.headers.get(MINI_APP_SESSION_HEADER)!;
    const sealedHeader: string = r1Res.headers.get(MINI_APP_SESSION_KEY_HEADER)!;
    expect(newToken).toMatch(/^[0-9a-f]{64}$/u);
    expect(r2Res.headers.get(MINI_APP_SESSION_HEADER)).toBe(newToken);
    expect(r2Res.headers.get(MINI_APP_SESSION_KEY_HEADER)).toBe(sealedHeader);

    const unsealedKeyHex: string | null = await frontendUnsealRotatedSessionKey(
      firstKey,
      sealedHeader,
      newToken
    );
    expect(unsealedKeyHex).toMatch(/^[0-9a-f]{64}$/u);
    for (const res of [r1Res, r2Res]) {
      const env = parseMiniAppEncryptedEnvelope(await res.json());
      expect(env).not.toBeNull();
      const plain = await decryptMiniAppText({
        cryptoKey: firstKey,
        encrypted: env!,
        additionalData: buildMiniAppEnvelopeAad("GET", "/api/status", "res"),
      });
      expect(plain).not.toBeNull();
    }

    const settledSession: Readonly<MiniAppAuthSession> =
      miniAppAuthSessions.get(newToken)!;
    expect(settledSession.pendingSessionKey).toBeUndefined();
    expect(settledSession.sealedSessionKey).toBe(sealedHeader);
    expect(settledSession.sealedSessionKeyPromise).toBeUndefined();

    const afterGraceMs: number =
      settledSession.createdAt + MINI_APP_SESSION_PREVIOUS_GRACE_MS + 1;
    expect(lookupMiniAppSessionState(newToken, afterGraceMs)).not.toBeNull();
    const cleanedSession: Readonly<MiniAppAuthSession> =
      miniAppAuthSessions.get(newToken)!;
    expect(cleanedSession.previousToken).toBeUndefined();
    expect(cleanedSession.sealedSessionKey).toBeUndefined();
    expect(cleanedSession.sealedSessionKeyPromise).toBeUndefined();
  });
});

describe("Mini App 完整 Origin 协议校验与严格单查询参数解析", () => {
  test("deriveMiniAppPublicUrlParts 与 isAllowedRequestOriginUrl 严格核验完整源站协议，不信任 X-Forwarded-Proto", async () => {
    expect(deriveMiniAppPublicUrlParts(undefined)).toEqual({
      basePath: "/",
      host: "",
      origin: "",
    });
    expect(
      deriveMiniAppPublicUrlParts({
        url: "not a valid url",
        host: "127.0.0.1",
        port: 3000,
        password: "valid-password-123456",
      })
    ).toEqual({
      basePath: "/",
      host: "",
      origin: "",
    });
    expect(
      deriveMiniAppPublicUrlParts({
        url: "http://insecure.example.com/sub/",
        host: "127.0.0.1",
        port: 3000,
        password: "valid-password-123456",
      })
    ).toEqual({
      basePath: "/sub",
      host: "insecure.example.com",
      origin: "",
    });
    expect(
      deriveMiniAppPublicUrlParts({
        url: "https://MiniApp.Example.com:8443/sub/",
        host: "127.0.0.1",
        port: 3000,
        password: "valid-password-123456",
      })
    ).toEqual({
      basePath: "/sub",
      host: "miniapp.example.com:8443",
      origin: "https://miniapp.example.com:8443",
    });

    miniAppActiveUrlPartsHolder.current = {
      basePath: "/sub",
      host: "miniapp.example.com",
      origin: "https://miniapp.example.com",
    };

    const loopbackHttpReq: Request = new Request("http://127.0.0.1:3000/api/status", {
      headers: { "X-Forwarded-Proto": "https" },
    });
    expect(
      isAllowedRequestOriginUrl("https://miniapp.example.com", loopbackHttpReq)
    ).toBeTrue();
    expect(
      isAllowedRequestOriginUrl("https://miniapp.example.com/sub/page?q=1", loopbackHttpReq)
    ).toBeTrue();
    expect(
      isAllowedRequestOriginUrl("https://miniapp.example.com?q=1", loopbackHttpReq)
    ).toBeTrue();
    expect(
      isAllowedRequestOriginUrl("https://miniapp.example.com#hash", loopbackHttpReq)
    ).toBeTrue();
    expect(
      isAllowedRequestOriginUrl("https://miniapp.example.com:443/sub/", loopbackHttpReq)
    ).toBeTrue();
    expect(
      isAllowedRequestOriginUrl("https://miniapp.example.com.evil.com/sub/", loopbackHttpReq)
    ).toBeFalse();
    expect(
      isAllowedRequestOriginUrl("https://miniapp.example.com@evil.com/sub/", loopbackHttpReq)
    ).toBeFalse();
    expect(
      isAllowedRequestOriginUrl("https://miniapp.example.com:444/sub/", loopbackHttpReq)
    ).toBeFalse();
    expect(
      isAllowedRequestOriginUrl("http://miniapp.example.com", loopbackHttpReq)
    ).toBeFalse();
    expect(
      isAllowedRequestOriginUrl("https://miniapp.example.com:8443", loopbackHttpReq)
    ).toBeFalse();

    expect(
      isAllowedRequestOriginUrl("http://127.0.0.1:3000", loopbackHttpReq)
    ).toBeTrue();
    expect(
      isAllowedRequestOriginUrl("https://127.0.0.1:3000", loopbackHttpReq)
    ).toBeFalse();
    expect(
      isAllowedRequestOriginUrl("http://127.0.0.1:4000", loopbackHttpReq)
    ).toBeFalse();
    expect(
      isAllowedRequestOriginUrl("http://localhost:3000", loopbackHttpReq)
    ).toBeFalse();

    const loopbackHttpsIpv6Req: Request = new Request("https://[::1]:8443/api/status");
    expect(
      isAllowedRequestOriginUrl("https://[::1]:8443", loopbackHttpsIpv6Req)
    ).toBeTrue();
    expect(
      isAllowedRequestOriginUrl("http://[::1]:8443", loopbackHttpsIpv6Req)
    ).toBeFalse();

    const nonLoopbackReq: Request = new Request("http://internal.lan:3000/api/status");
    expect(
      isAllowedRequestOriginUrl("http://internal.lan:3000", nonLoopbackReq)
    ).toBeFalse();
    expect(
      isAllowedRequestOriginUrl("https://miniapp.example.com", nonLoopbackReq)
    ).toBeTrue();
    expect(
      isAllowedRequestOriginUrl("http://miniapp.example.com", nonLoopbackReq)
    ).toBeFalse();

    const session: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession();
    const downgradedRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: session.token,
          Origin: "http://miniapp.example.com",
        },
      })
    );
    expect(downgradedRes.status).toBe(403);
    expect(((await downgradedRes.json()) as MiniAppAccessDiagnostics).code).toBe(
      "CROSS_SITE_FORBIDDEN"
    );
  });

  test("parseStrictSingleQueryParam 严格校验唯一参数键并拒绝多参、重复键与缺键", () => {
    expect(
      parseStrictSingleQueryParam(
        new URL("http://127.0.0.1:3000/api/gallery/download?ticket=abc123"),
        "ticket"
      )
    ).toBe("abc123");
    expect(
      parseStrictSingleQueryParam(
        new URL("http://127.0.0.1:3000/api/gallery/download?ticket="),
        "ticket"
      )
    ).toBe("");
    for (const rejectedUrl of [
      "http://127.0.0.1:3000/api/gallery/download",
      "http://127.0.0.1:3000/api/gallery/download?",
      "http://127.0.0.1:3000/api/gallery/download?other=1",
      "http://127.0.0.1:3000/api/gallery/download?ticket=abc&extra=1",
      "http://127.0.0.1:3000/api/gallery/download?ticket=abc&ticket=def",
      "http://127.0.0.1:3000/api/gallery/download?ticket=abc&",
    ]) {
      expect(parseStrictSingleQueryParam(new URL(rejectedUrl), "ticket")).toBeNull();
    }
    expect(
      parseStrictSingleQueryParam(
        new URL(
          `http://127.0.0.1:3000/api/status?${MINI_APP_ENCRYPTED_QUERY_PARAM}=iv.cipher`
        ),
        MINI_APP_ENCRYPTED_QUERY_PARAM
      )
    ).toBe("iv.cipher");
  });
});

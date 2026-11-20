/**
 * Mini App `/api/gallery/file` 与 `/api/gallery/download` 加密查询串、`?ticket=` 一次性票据及 `HEAD` 严格 AAD 校验测试。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import type { MiniAppAuthSession } from "../../packages/types/miniApp/auth";
import type { MiniAppGalleryUploadResult } from "../../packages/types/miniApp/gallery";
import { imageFixture } from "../helpers/image";
import {
  buildSuperAdminHeaders,
  installMiniAppTestDiskIOMock,
  resetMiniAppTestDiskIOState,
} from "../helpers/miniAppInitData";

installMiniAppTestDiskIOMock();

const {
  miniAppAuthHandshakes,
  miniAppAuthSessions,
  miniAppGalleryDownloadTickets,
  miniAppServiceRestartRunnerHolder,
} = await import("../../packages/cache/main/miniApp");
const { getAssetConfig } = await import("../../packages/config/assets");
const { BOT_TOKEN, SUPER_ADMIN_USER_ID } = await import("../../packages/config/bot");
const { MINI_APP_MAX_INIT_DATA_LENGTH } = await import("../../packages/consts/miniApp");
const {
  MINI_APP_ENCRYPTED_QUERY_PARAM,
  MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
  MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH,
} = await import("../../packages/consts/miniAppCrypto");
const {
  issueMiniAppAuthSession,
  stopMiniAppServer,
} = await import("../../packages/mini-app-api-server");
const {
  dispatchMiniAppTestRequest: handleMiniAppHttpRequest,
  dispatchRawMiniAppTestRequest,
} = await import("../helpers/miniAppRequest");
const {
  encryptMiniAppEnvelope,
  encodeUtf8Bytes,
  sealMiniAppQuery,
} = await import("../../packages/mini-app-frontend/libs/crypto");
const { buildMiniAppEnvelopeAad } = await import(
  "../../packages/mini-app-api-server/libs/crypto"
);

afterEach(async (): Promise<void> => {
  miniAppServiceRestartRunnerHolder.current = null;
  await stopMiniAppServer();
  rmSync(getAssetConfig().randomHImageDirectory, { recursive: true, force: true });
  resetMiniAppTestDiskIOState();
  miniAppAuthSessions.clear();
  miniAppAuthHandshakes.clear();
  miniAppGalleryDownloadTickets.clear();
});

describe("Mini App 图库媒体路由查询加密、ticket 票据与 HEAD AAD 校验", () => {
  test("严格拒绝裸 ?、明文业务参数、未授权 query auth 参数与超长密文，并验证 HEAD 与 GET 的严格方法 AAD 绑定", async () => {
    const session: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession();
    const cryptoKey: CryptoKey = await session.cryptoKey;
    const headers: Record<string, string> = buildSuperAdminHeaders({
      botToken: BOT_TOKEN,
      superAdminUserId: SUPER_ADMIN_USER_ID,
      sessionToken: session.token,
    });
    const fakeToken: string = "a".repeat(64);
    const validGetFileSealed: string = await sealMiniAppQuery(
      cryptoKey,
      "fileName=missing.png",
      "GET /api/gallery/file"
    );
    const validGetDownloadSealed: string = await sealMiniAppQuery(
      cryptoKey,
      "fileName=missing.png",
      "GET /api/gallery/download"
    );
    const validHeadDownloadSealed: string = await sealMiniAppQuery(
      cryptoKey,
      "fileName=missing.png",
      "HEAD /api/gallery/download"
    );
    const startsWithQuestionSealed: string = await sealMiniAppQuery(
      cryptoKey,
      "?fileName=missing.png",
      "GET /api/gallery/download"
    );
    const emptyDecryptedSealed: string = await encryptMiniAppEnvelope(
      cryptoKey,
      "",
      encodeUtf8Bytes("GET /api/gallery/download")
    ).then((env): string => `${env.iv}.${env.payload}`);
    const wrongAadDownloadSealed: string = await sealMiniAppQuery(
      cryptoKey,
      "fileName=missing.png",
      "GET /api/gallery/file"
    );
    const oversizedSealed: string = `${"a".repeat(MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH - 1)}.b`;

    // 无效 query ?initData= 长串走请求头鉴权直接返回 401 MISSING_INIT_DATA（绝不在未带头时读取查询参数）
    const oversizedInitDataRes: Response = await dispatchRawMiniAppTestRequest(
      new Request(
        `http://127.0.0.1:3000/api/gallery/download?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(validGetDownloadSealed)}&initData=${"a".repeat(MINI_APP_MAX_INIT_DATA_LENGTH + 1)}`
      )
    );
    expect(oversizedInitDataRes.status).toBe(401);

    const rejectedQueryUrls: readonly string[] = [
      // /api/gallery/file 拒绝明文、混传、多余参数与解密后以 ? 开头
      "http://127.0.0.1:3000/api/gallery/file?fileName=missing.png",
      `http://127.0.0.1:3000/api/gallery/file?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(validGetFileSealed)}&token=${fakeToken}`,
      `http://127.0.0.1:3000/api/gallery/file?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(await sealMiniAppQuery(cryptoKey, "?fileName=missing.png", "GET /api/gallery/file"))}`,
      // /api/gallery/download（已带请求头会话）同样只允许单一 e= 参数，拒绝 token/initData/session 混传、重复键、空解密、以 ? 开头、超长与错 AAD
      "http://127.0.0.1:3000/api/gallery/download?",
      "http://127.0.0.1:3000/api/gallery/download?fileName=missing.png",
      `http://127.0.0.1:3000/api/gallery/download?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(validGetDownloadSealed)}&token=${fakeToken}`,
      `http://127.0.0.1:3000/api/gallery/download?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(validGetDownloadSealed)}&extra=1`,
      `http://127.0.0.1:3000/api/gallery/download?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(validGetDownloadSealed)}&${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(validGetDownloadSealed)}`,
      `http://127.0.0.1:3000/api/gallery/download?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(emptyDecryptedSealed)}`,
      `http://127.0.0.1:3000/api/gallery/download?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(startsWithQuestionSealed)}`,
      `http://127.0.0.1:3000/api/gallery/download?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(oversizedSealed)}`,
      `http://127.0.0.1:3000/api/gallery/download?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(wrongAadDownloadSealed)}`,
    ];
    for (const url of rejectedQueryUrls) {
      const res: Response = await dispatchRawMiniAppTestRequest(new Request(url, { headers }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
      });
    }

    // HEAD /api/gallery/file 与 HEAD /api/gallery/download 均严格绑定 HEAD AAD（不再向 GET AAD 回退）。
    const headFileWithGetAadRes: Response = await dispatchRawMiniAppTestRequest(
      new Request(
        `http://127.0.0.1:3000/api/gallery/file?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(validGetFileSealed)}`,
        { method: "HEAD", headers }
      )
    );
    expect(headFileWithGetAadRes.status).toBe(400);

    const headDownloadWithGetAadRes: Response = await dispatchRawMiniAppTestRequest(
      new Request(
        `http://127.0.0.1:3000/api/gallery/download?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(validGetDownloadSealed)}`,
        { method: "HEAD", headers }
      )
    );
    expect(headDownloadWithGetAadRes.status).toBe(400);

    const headDownloadOkRes: Response = await dispatchRawMiniAppTestRequest(
      new Request(
        `http://127.0.0.1:3000/api/gallery/download?${MINI_APP_ENCRYPTED_QUERY_PARAM}=${encodeURIComponent(validHeadDownloadSealed)}`,
        { method: "HEAD", headers }
      )
    );
    expect(headDownloadOkRes.status).toBe(404);

    // 确认 POST /api/gallery/download-ticket 对空或缺失图片严格返回绑定 :res AAD 的 encrypted 404
    const ticketMissEnv = await encryptMiniAppEnvelope(
      cryptoKey,
      JSON.stringify({ fileName: "missing.png" }),
      buildMiniAppEnvelopeAad("POST", "/api/gallery/download-ticket", "req")
    );
    const ticketMissRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/gallery/download-ticket", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(ticketMissEnv),
      })
    );
    expect(ticketMissRes.status).toBe(404);
  });

  test("#7 POST /api/gallery/download-ticket 签发 60 秒一次性票据：HEAD 探测不消耗、GET 消费即焚、混参拒绝且删图同步吊销", async () => {
    mkdirSync(getAssetConfig().randomHImageDirectory, { recursive: true });
    const validPng: Uint8Array<ArrayBuffer> = new Uint8Array(
      await new Bun.Image(imageFixture(8, 8)).png().bytes()
    );
    const session: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession();
    const headers: Record<string, string> = buildSuperAdminHeaders({
      botToken: BOT_TOKEN,
      superAdminUserId: SUPER_ADMIN_USER_ID,
      sessionToken: session.token,
    });

    const uploadRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/gallery/upload", {
        method: "POST",
        headers: { ...headers, "Content-Type": "image/png" },
        body: validPng,
      })
    );
    expect(uploadRes.status).toBe(200);
    const uploaded = (await uploadRes.json()) as MiniAppGalleryUploadResult;
    const uploadedFileName: string = uploaded.fileName!;

    const issueTicketRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/gallery/download-ticket", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: uploadedFileName }),
      })
    );
    expect(issueTicketRes.status).toBe(200);
    const issuedTicketBody = (await issueTicketRes.json()) as {
      readonly ok: true;
      readonly ticket: string;
      readonly expiresAt: number;
      readonly downloadFileName: string;
    };
    expect(issuedTicketBody.ok).toBeTrue();
    expect(issuedTicketBody.ticket).toMatch(/^[0-9a-f]{64}$/u);

    const headTicketRes: Response = await dispatchRawMiniAppTestRequest(
      new Request(
        `http://127.0.0.1:3000/api/gallery/download?ticket=${encodeURIComponent(issuedTicketBody.ticket)}`,
        { method: "HEAD" }
      )
    );
    expect(headTicketRes.status).toBe(200);
    expect(await headTicketRes.bytes()).toEqual(new Uint8Array(0));

    const getTicketRes: Response = await dispatchRawMiniAppTestRequest(
      new Request(
        `http://127.0.0.1:3000/api/gallery/download?ticket=${encodeURIComponent(issuedTicketBody.ticket)}`
      )
    );
    expect(getTicketRes.status).toBe(200);
    expect(getTicketRes.headers.get("Content-Disposition")).toBe(
      `attachment; filename="${issuedTicketBody.downloadFileName}"`
    );
    expect(await getTicketRes.bytes()).toEqual(validPng);

    // 同一票据第二次 GET 立即失效，携带额外参数也拒绝。
    const replayTicketRes: Response = await dispatchRawMiniAppTestRequest(
      new Request(
        `http://127.0.0.1:3000/api/gallery/download?ticket=${encodeURIComponent(issuedTicketBody.ticket)}`
      )
    );
    expect(replayTicketRes.status).toBe(401);

    const extraParamTicketRes: Response = await dispatchRawMiniAppTestRequest(
      new Request(
        `http://127.0.0.1:3000/api/gallery/download?ticket=${encodeURIComponent(issuedTicketBody.ticket)}&extra=1`
      )
    );
    expect(extraParamTicketRes.status).toBe(401);

    // 文件删除时同步吊销关联的未消费下载票据。
    const ticketBeforeDeleteRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/gallery/download-ticket", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: uploadedFileName }),
      })
    );
    const ticketBeforeDelete = (await ticketBeforeDeleteRes.json()) as {
      readonly ticket: string;
    };
    const deleteRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/gallery/delete", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: uploadedFileName }),
      })
    );
    expect(deleteRes.status).toBe(200);
    const deadAfterDeleteRes: Response = await dispatchRawMiniAppTestRequest(
      new Request(
        `http://127.0.0.1:3000/api/gallery/download?ticket=${encodeURIComponent(ticketBeforeDelete.ticket)}`
      )
    );
    expect(deadAfterDeleteRes.status).toBe(401);
  });
});

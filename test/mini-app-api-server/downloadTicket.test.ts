/**
 * Mini App 图库 60 秒一次性下载票据按会话谱系绑定与生命周期测试：
 * - 单元覆盖签发、非 64-hex 拒绝、过期清扫、`HEAD` 不消耗/`GET` 消费即焚、`isSessionActive` 谱系核验及按谱系/按文件批量吊销；
 * - 集成覆盖跨滑动轮换持续有效（含读盘/写体 `await` 窗口内轮换并确认）、登出/满额淘汰/超时过期/验证器变更与 `cap_exceeded` 按谱系吊销。
 */

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  MiniAppAuthSession,
  MiniAppLoginSuccessResponse,
} from "../../packages/types/miniApp/auth";
import type { MiniAppGalleryDownloadTicketRecord } from "../../packages/types/miniApp/gallery";
import { imageFixture } from "../helpers/image";
import {
  buildSignedTestInitData,
  buildSuperAdminHeaders,
  installMiniAppTestDiskIOMock,
  resetMiniAppTestDiskIOState,
} from "../helpers/miniAppInitData";

installMiniAppTestDiskIOMock();

const {
  miniAppAuthHandshakes,
  miniAppAuthSessions,
  miniAppGalleryDownloadTickets,
  miniAppPasswordGuardHolder,
} = await import("../../packages/cache/main/miniApp");
const { getAssetConfig } = await import("../../packages/config/assets");
const { BOT_TOKEN, SUPER_ADMIN_USER_ID, getBotMiniAppConfig } = await import(
  "../../packages/config/bot"
);
const {
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_SESSION_HEADER,
  MINI_APP_SESSION_MAX,
  MINI_APP_SESSION_TTL_MS,
} = await import("../../packages/consts/miniApp");
const {
  MINI_APP_DOWNLOAD_TICKET_MAX,
  MINI_APP_DOWNLOAD_TICKET_TTL_MS,
  MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS,
  MINI_APP_SESSION_ROTATE_AT_SEEN_IVS,
} = await import("../../packages/consts/miniAppCrypto");
const {
  issueMiniAppAuthSession,
  stopMiniAppServer,
} = await import("../../packages/mini-app-api-server");
const {
  clearAllMiniAppGalleryDownloadTickets,
  issueMiniAppGalleryDownloadTicket,
  resolveMiniAppGalleryDownloadTicket,
  revokeMiniAppGalleryDownloadTicketsForFile,
  revokeMiniAppGalleryDownloadTicketsForSession,
} = await import("../../packages/mini-app-api-server/auth/downloadTicket");
const {
  hasActiveMiniAppAuthSessionByLineage,
  revokeMiniAppAuthSession,
  revokeMiniAppAuthSessionByLineage,
  revokeOtherMiniAppAuthSessions,
} = await import("../../packages/mini-app-api-server/auth/session");
const { handlePostGalleryDownloadTicketRoute } = await import(
  "../../packages/mini-app-api-server/handlers/gallery"
);
const {
  buildMiniAppEnvelopeAad,
  encryptMiniAppEnvelope,
  importMiniAppAesGcmKey,
} = await import("../../packages/mini-app-api-server/libs/crypto");
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
  rmSync(getAssetConfig().randomHImageDirectory, { recursive: true, force: true });
  resetMiniAppTestDiskIOState();
  miniAppAuthSessions.clear();
  miniAppAuthHandshakes.clear();
  miniAppGalleryDownloadTickets.clear();
  miniAppPasswordGuardHolder.current = null;
  setSystemTime();
});

describe("Mini App 下载票据按谱系绑定与生命周期测试", () => {
  test("下载票据签发、消费、非 64-hex 拒绝、过期清理、会话失效剔除与按谱系/按文件批量吊销", () => {
    const baseMs: number = 1_787_000_000_000;
    const lineageA: string = "a".repeat(32);
    const lineageB: string = "b".repeat(32);

    // 缓存为空或入参为空串时吊销操作安全返回无副作用。
    revokeMiniAppGalleryDownloadTicketsForSession(lineageA);
    revokeMiniAppGalleryDownloadTicketsForSession("");
    revokeMiniAppGalleryDownloadTicketsForFile("sample.png");
    revokeMiniAppGalleryDownloadTicketsForFile("");

    const ticketA1: Readonly<MiniAppGalleryDownloadTicketRecord> =
      issueMiniAppGalleryDownloadTicket({
        sessionLineageId: lineageA,
        fileName: "alpha.png",
        downloadFileName: "1787000000.png",
        nowMs: baseMs,
      });
    expect(ticketA1.ticket).toMatch(/^[0-9a-f]{64}$/u);
    expect(ticketA1.sessionLineageId).toBe(lineageA);
    expect(ticketA1.createdAt).toBe(baseMs);
    expect(ticketA1.expiresAt).toBe(baseMs + MINI_APP_DOWNLOAD_TICKET_TTL_MS);

    // 拒绝非 64-hex 与未知 64-hex 票据。
    for (const invalidTicket of [
      "",
      "   ",
      "a".repeat(63),
      "a".repeat(65),
      "g".repeat(64),
      "0".repeat(64),
    ]) {
      expect(
        resolveMiniAppGalleryDownloadTicket({
          ticket: invalidTicket,
          consume: false,
          nowMs: baseMs,
        })
      ).toBeNull();
    }

    // 合法 64-hex 支持首尾空白规范化，HEAD（consume: false）不消耗，边界前 1ms 仍有效。
    expect(
      resolveMiniAppGalleryDownloadTicket({
        ticket: `  ${ticketA1.ticket}  `,
        consume: false,
        nowMs: ticketA1.expiresAt - 1,
      })
    ).toEqual(ticketA1);
    expect(miniAppGalleryDownloadTickets.has(ticketA1.ticket)).toBeTrue();

    // 回调判定会话谱系失效时立即删除票据并返回 null。
    let checkedLineage: string | undefined;
    expect(
      resolveMiniAppGalleryDownloadTicket({
        ticket: ticketA1.ticket,
        consume: false,
        isSessionActive: (lineageId: string): boolean => {
          checkedLineage = lineageId;
          return false;
        },
        nowMs: baseMs + 100,
      })
    ).toBeNull();
    expect(checkedLineage).toBe(lineageA);
    expect(miniAppGalleryDownloadTickets.has(ticketA1.ticket)).toBeFalse();

    // 到期清理：record.expiresAt <= nowMs 时在解析或新签发前自动清扫。
    const expiringTicket: Readonly<MiniAppGalleryDownloadTicketRecord> =
      issueMiniAppGalleryDownloadTicket({
        sessionLineageId: lineageA,
        fileName: "expiring.png",
        downloadFileName: "expiring.png",
        nowMs: baseMs,
      });
    expect(
      resolveMiniAppGalleryDownloadTicket({
        ticket: expiringTicket.ticket,
        consume: true,
        nowMs: expiringTicket.expiresAt,
      })
    ).toBeNull();
    expect(miniAppGalleryDownloadTickets.has(expiringTicket.ticket)).toBeFalse();

    // 签发新票据时一并清扫已过期条目；按谱系吊销只删目标谱系，按文件吊销只删目标文件。
    const expiredBeforeIssue: Readonly<MiniAppGalleryDownloadTicketRecord> =
      issueMiniAppGalleryDownloadTicket({
        sessionLineageId: lineageA,
        fileName: "stale.png",
        downloadFileName: "stale.png",
        nowMs: baseMs,
      });
    const laterMs: number = baseMs + MINI_APP_DOWNLOAD_TICKET_TTL_MS + 10;
    const ticketA2: Readonly<MiniAppGalleryDownloadTicketRecord> =
      issueMiniAppGalleryDownloadTicket({
        sessionLineageId: lineageA,
        fileName: "shared.png",
        downloadFileName: "shared.png",
        nowMs: laterMs,
      });
    const ticketA3: Readonly<MiniAppGalleryDownloadTicketRecord> =
      issueMiniAppGalleryDownloadTicket({
        sessionLineageId: lineageA,
        fileName: "only-a.png",
        downloadFileName: "only-a.png",
        nowMs: laterMs,
      });
    const ticketB1: Readonly<MiniAppGalleryDownloadTicketRecord> =
      issueMiniAppGalleryDownloadTicket({
        sessionLineageId: lineageB,
        fileName: "shared.png",
        downloadFileName: "shared.png",
        nowMs: laterMs,
      });
    const ticketB2: Readonly<MiniAppGalleryDownloadTicketRecord> =
      issueMiniAppGalleryDownloadTicket({
        sessionLineageId: lineageB,
        fileName: "only-b.png",
        downloadFileName: "only-b.png",
        nowMs: laterMs,
      });
    expect(miniAppGalleryDownloadTickets.has(expiredBeforeIssue.ticket)).toBeFalse();

    revokeMiniAppGalleryDownloadTicketsForSession("");
    expect(miniAppGalleryDownloadTickets.size).toBe(4);
    revokeMiniAppGalleryDownloadTicketsForSession(lineageA);
    expect(miniAppGalleryDownloadTickets.has(ticketA2.ticket)).toBeFalse();
    expect(miniAppGalleryDownloadTickets.has(ticketA3.ticket)).toBeFalse();
    expect(miniAppGalleryDownloadTickets.has(ticketB1.ticket)).toBeTrue();
    expect(miniAppGalleryDownloadTickets.has(ticketB2.ticket)).toBeTrue();

    revokeMiniAppGalleryDownloadTicketsForFile("");
    expect(miniAppGalleryDownloadTickets.size).toBe(2);
    revokeMiniAppGalleryDownloadTicketsForFile("shared.png");
    expect(miniAppGalleryDownloadTickets.has(ticketB1.ticket)).toBeFalse();
    expect(miniAppGalleryDownloadTickets.has(ticketB2.ticket)).toBeTrue();

    // 单次 GET 消费即焚，二次消费返回 null；clearAll 清空余量。
    expect(
      resolveMiniAppGalleryDownloadTicket({
        ticket: ticketB2.ticket,
        consume: true,
        nowMs: laterMs + 50,
      })
    ).toEqual(ticketB2);
    expect(
      resolveMiniAppGalleryDownloadTicket({
        ticket: ticketB2.ticket,
        consume: true,
        nowMs: laterMs + 60,
      })
    ).toBeNull();

    issueMiniAppGalleryDownloadTicket({
      sessionLineageId: lineageB,
      fileName: "clear-me.png",
      downloadFileName: "clear-me.png",
      nowMs: laterMs + 100,
    });
    expect(miniAppGalleryDownloadTickets.size).toBe(1);
    clearAllMiniAppGalleryDownloadTickets();
    expect(miniAppGalleryDownloadTickets.size).toBe(0);
  });

  test("下载票据表达到 MINI_APP_DOWNLOAD_TICKET_MAX 上限时按 FIFO 淘汰最早签发的未过期票据", () => {
    const baseMs: number = 1_787_050_000_000;
    const lineage: string = "c".repeat(32);
    const issued: Readonly<MiniAppGalleryDownloadTicketRecord>[] = [];
    for (let index: number = 0; index < MINI_APP_DOWNLOAD_TICKET_MAX + 2; index += 1) {
      issued.push(
        issueMiniAppGalleryDownloadTicket({
          sessionLineageId: lineage,
          fileName: `file-${index}.png`,
          downloadFileName: `file-${index}.png`,
          nowMs: baseMs + index,
        })
      );
    }

    expect(miniAppGalleryDownloadTickets.size).toBe(MINI_APP_DOWNLOAD_TICKET_MAX);
    // 最早签发的 2 张票据按 FIFO 被淘汰，其余最新 MINI_APP_DOWNLOAD_TICKET_MAX 张仍有效。
    for (let index: number = 0; index < 2; index += 1) {
      const evicted: Readonly<MiniAppGalleryDownloadTicketRecord> = issued[index]!;
      expect(miniAppGalleryDownloadTickets.has(evicted.ticket)).toBeFalse();
      expect(
        resolveMiniAppGalleryDownloadTicket({
          ticket: evicted.ticket,
          consume: false,
          nowMs: baseMs + MINI_APP_DOWNLOAD_TICKET_MAX + 10,
        })
      ).toBeNull();
    }
    for (let index: number = 2; index < issued.length; index += 1) {
      const kept: Readonly<MiniAppGalleryDownloadTicketRecord> = issued[index]!;
      expect(miniAppGalleryDownloadTickets.has(kept.ticket)).toBeTrue();
      expect(
        resolveMiniAppGalleryDownloadTicket({
          ticket: kept.ticket,
          consume: false,
          nowMs: baseMs + MINI_APP_DOWNLOAD_TICKET_MAX + 10,
        })
      ).toEqual(kept);
    }
  });

  test("下载票据跨滑动轮换持续有效（含处理 await 窗口内轮换并确认），并在登出、满额淘汰、过期与验证器变更时按谱系即时吊销", async () => {
    const baseMs: number = 1_787_100_000_000;
    setSystemTime(new Date(baseMs));
    const galleryDir: string = getAssetConfig().randomHImageDirectory;
    mkdirSync(galleryDir, { recursive: true });
    const pngBytes: Uint8Array<ArrayBuffer> = new Uint8Array(
      await new Bun.Image(imageFixture(8, 8)).png().bytes()
    );
    const fileName: string = `${Bun.SHA256.hash(pngBytes, "hex")}.png`;
    await Bun.write(join(galleryDir, fileName), pngBytes);

    // 1. 处理器 await 期间并发轮换并确认旧令牌：按已提交 lineageId 签出的票据在再次轮换后仍可下载。
    const session: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession(baseMs);
    const bodyBytes: Uint8Array<ArrayBuffer> = new TextEncoder().encode(
      JSON.stringify({ fileName })
    );
    const readEntered: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const releaseRead: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const slowBodyStream: ReadableStream<Uint8Array> =
      new ReadableStream<Uint8Array>({
        async start(controller): Promise<void> {
          readEntered.resolve();
          await releaseRead.promise;
          controller.enqueue(bodyBytes);
          controller.close();
        },
      });
    const slowTicketPromise: Promise<Response> = handlePostGalleryDownloadTicketRoute(
      new Request("http://127.0.0.1:3000/api/gallery/download-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: slowBodyStream,
      }),
      session.lineageId
    );
    await readEntered.promise;

    // 暂停期间推进时间触发轮换并确认新令牌，使旧令牌彻底失效。
    setSystemTime(new Date(session.nextRefreshAt + 1));
    const rotateRes: Response = await dispatchMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: buildSuperAdminHeaders({
          botToken: BOT_TOKEN,
          superAdminUserId: SUPER_ADMIN_USER_ID,
          sessionToken: session.token,
        }),
      })
    );
    expect(rotateRes.status).toBe(200);
    const rotatedToken: string = rotateRes.headers.get(MINI_APP_SESSION_HEADER)!;
    expect(rotatedToken).not.toBe(session.token);
    expect(
      (
        await dispatchMiniAppTestRequest(
          new Request("http://127.0.0.1:3000/api/status", {
            headers: buildSuperAdminHeaders({
              botToken: BOT_TOKEN,
              superAdminUserId: SUPER_ADMIN_USER_ID,
              sessionToken: rotatedToken,
            }),
          })
        )
      ).status
    ).toBe(200);
    expect(miniAppAuthSessions.get(rotatedToken)?.previousToken).toBeUndefined();

    releaseRead.resolve();
    const slowTicketRes: Response = await slowTicketPromise;
    expect(slowTicketRes.status).toBe(200);
    const slowTicketBody = (await slowTicketRes.json()) as {
      readonly ticket: string;
    };

    // 经完整路由签出第二张票据后，会话再次轮换并确认：两张票据均跨轮换有效。
    const routeTicketRes: Response = await dispatchMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/gallery/download-ticket", {
        method: "POST",
        headers: buildSuperAdminHeaders({
          botToken: BOT_TOKEN,
          superAdminUserId: SUPER_ADMIN_USER_ID,
          sessionToken: rotatedToken,
          contentType: "application/json",
        }),
        body: JSON.stringify({ fileName }),
      })
    );
    expect(routeTicketRes.status).toBe(200);
    const routeTicketBody = (await routeTicketRes.json()) as {
      readonly ticket: string;
    };

    const secondSession: Readonly<MiniAppAuthSession> =
      miniAppAuthSessions.get(rotatedToken)!;
    // 在 60 秒下载票据有效期内借 IV 水位立即触发第二次滑动轮换并确认新令牌。
    for (
      let i: number = secondSession.seenRequestIvs.size;
      i < MINI_APP_SESSION_ROTATE_AT_SEEN_IVS;
      i += 1
    ) {
      secondSession.seenRequestIvs.add(`ticket-rotate-iv-${i}`);
    }
    setSystemTime(new Date(Date.now() + 1_000));
    const secondRotateRes: Response = await dispatchMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: buildSuperAdminHeaders({
          botToken: BOT_TOKEN,
          superAdminUserId: SUPER_ADMIN_USER_ID,
          sessionToken: rotatedToken,
        }),
      })
    );
    const thirdToken: string = secondRotateRes.headers.get(MINI_APP_SESSION_HEADER)!;
    expect(thirdToken).not.toBe(rotatedToken);
    expect(
      (
        await dispatchMiniAppTestRequest(
          new Request("http://127.0.0.1:3000/api/status", {
            headers: buildSuperAdminHeaders({
              botToken: BOT_TOKEN,
              superAdminUserId: SUPER_ADMIN_USER_ID,
              sessionToken: thirdToken,
            }),
          })
        )
      ).status
    ).toBe(200);

    for (const ticket of [slowTicketBody.ticket, routeTicketBody.ticket]) {
      const downloadRes: Response = await dispatchRawMiniAppTestRequest(
        new Request(
          `http://127.0.0.1:3000/api/gallery/download?ticket=${encodeURIComponent(ticket)}`
        )
      );
      expect(downloadRes.status).toBe(200);
      expect(await downloadRes.bytes()).toEqual(pngBytes);
    }

    // 2. 登出、满额淘汰、超时过期与验证器变更按谱系吊销关联下载票据且不误伤其他会话。
    const nowMs: number = Date.now();
    const keepSession: Readonly<MiniAppAuthSession> =
      miniAppAuthSessions.get(thirdToken)!;
    const logoutSession: Readonly<MiniAppAuthSession> =
      issueMiniAppAuthSession(nowMs);
    const keepTicket = issueMiniAppGalleryDownloadTicket({
      sessionLineageId: keepSession.lineageId,
      fileName,
      downloadFileName: "keep.png",
      nowMs,
    });
    const logoutTicket = issueMiniAppGalleryDownloadTicket({
      sessionLineageId: logoutSession.lineageId,
      fileName,
      downloadFileName: "logout.png",
      nowMs,
    });
    expect(revokeMiniAppAuthSession(logoutSession.token, nowMs)).toBeTrue();
    expect(miniAppGalleryDownloadTickets.has(logoutTicket.ticket)).toBeFalse();
    expect(miniAppGalleryDownloadTickets.has(keepTicket.ticket)).toBeTrue();

    const newerSessions: Readonly<MiniAppAuthSession>[] = [];
    for (let i: number = miniAppAuthSessions.size; i < MINI_APP_SESSION_MAX; i += 1) {
      newerSessions.push(issueMiniAppAuthSession(nowMs + i + 1));
    }
    const survivingNewerTicket = issueMiniAppGalleryDownloadTicket({
      sessionLineageId: newerSessions[0]!.lineageId,
      fileName,
      downloadFileName: "newer.png",
      nowMs: nowMs + 10,
    });
    issueMiniAppAuthSession(nowMs + 20);
    expect(miniAppAuthSessions.has(keepSession.token)).toBeFalse();
    expect(miniAppGalleryDownloadTickets.has(keepTicket.ticket)).toBeFalse();
    expect(miniAppGalleryDownloadTickets.has(survivingNewerTicket.ticket)).toBeTrue();

    const victimTicket = issueMiniAppGalleryDownloadTicket({
      sessionLineageId: newerSessions[1]!.lineageId,
      fileName,
      downloadFileName: "victim.png",
      nowMs: nowMs + 25,
    });
    revokeOtherMiniAppAuthSessions(newerSessions[0]!.lineageId, nowMs + 30);
    expect(miniAppGalleryDownloadTickets.has(survivingNewerTicket.ticket)).toBeTrue();
    expect(miniAppGalleryDownloadTickets.has(victimTicket.ticket)).toBeFalse();

    const expiredMs: number = nowMs + MINI_APP_SESSION_TTL_MS + 1_000;
    expect(
      hasActiveMiniAppAuthSessionByLineage(newerSessions[0]!.lineageId, expiredMs)
    ).toBeFalse();
    expect(miniAppGalleryDownloadTickets.has(survivingNewerTicket.ticket)).toBeFalse();
    expect(hasActiveMiniAppAuthSessionByLineage("", expiredMs)).toBeFalse();
    expect(revokeMiniAppAuthSessionByLineage("", expiredMs)).toBeFalse();

    // 缺失已提交谱系标识直接调用 handler 必须 fail-closed 返回 401（绝不回退读请求头）。
    const fallbackSession: Readonly<MiniAppAuthSession> =
      issueMiniAppAuthSession(expiredMs);
    const missingLineageRes: Response = await handlePostGalleryDownloadTicketRoute(
      new Request("http://127.0.0.1:3000/api/gallery/download-ticket", {
        method: "POST",
        headers: {
          [MINI_APP_SESSION_HEADER]: fallbackSession.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fileName }),
      })
    );
    expect(missingLineageRes.status).toBe(401);
  });

  test("cap_exceeded 在请求解封窗口内会话被轮换并确认后仍按谱系吊销最新会话与关联下载票据", async () => {
    const baseMs: number = 1_787_200_000_000;
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
    const lineageId: string = firstSession.lineageId;
    const ticket = issueMiniAppGalleryDownloadTicket({
      sessionLineageId: lineageId,
      fileName: "cap.png",
      downloadFileName: "cap.png",
      nowMs: baseMs,
    });

    for (let i: number = 0; i < MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS; i += 1) {
      firstSession.seenRequestIvs.add(`cap-iv-${i}`);
    }
    const slowBodyEnvelope = await encryptMiniAppEnvelope(
      firstKey,
      "{}",
      buildMiniAppEnvelopeAad("POST", "/api/totp/setup", "req")
    );
    const bodyBytes: Uint8Array<ArrayBuffer> = new TextEncoder().encode(
      JSON.stringify(slowBodyEnvelope)
    );
    const streamEntered: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const releaseStream: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const slowStream: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
      async start(controller): Promise<void> {
        streamEntered.resolve();
        await releaseStream.promise;
        controller.enqueue(bodyBytes);
        controller.close();
      },
    });

    const capRequestPromise: Promise<Response> = dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/totp/setup", {
        method: "POST",
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: login.sessionToken,
          "Content-Type": "application/json",
        },
        body: slowStream,
      })
    );
    await streamEntered.promise;

    const rotRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/status", {
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
          [MINI_APP_SESSION_HEADER]: login.sessionToken,
        },
      })
    );
    expect(rotRes.status).toBe(200);
    const rotatedToken: string = rotRes.headers.get(MINI_APP_SESSION_HEADER)!;
    expect(rotatedToken).not.toBe(login.sessionToken);
    expect(
      (
        await dispatchRawMiniAppTestRequest(
          new Request("http://127.0.0.1:3000/api/status", {
            headers: {
              [MINI_APP_INIT_DATA_HEADER]: adminInitData(),
              [MINI_APP_SESSION_HEADER]: rotatedToken,
            },
          })
        )
      ).status
    ).toBe(200);
    expect(miniAppAuthSessions.get(rotatedToken)?.previousToken).toBeUndefined();

    releaseStream.resolve();
    const capRes: Response = await capRequestPromise;
    expect(capRes.status).toBe(401);
    expect(miniAppAuthSessions.size).toBe(0);
    expect(miniAppGalleryDownloadTickets.has(ticket.ticket)).toBeFalse();

    const strayTicket = issueMiniAppGalleryDownloadTicket({
      sessionLineageId: lineageId,
      fileName: "stray.png",
      downloadFileName: "stray.png",
      nowMs: baseMs,
    });
    expect(revokeMiniAppAuthSessionByLineage(lineageId, baseMs)).toBeFalse();
    expect(miniAppGalleryDownloadTickets.has(strayTicket.ticket)).toBeFalse();
  });
});

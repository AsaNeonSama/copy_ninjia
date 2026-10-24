import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import type { Message } from "grammy/types";
import type {
  DiskBusinessMessage,
  DomainFlushOutcome,
  IdentityPolicyPersistedRevision,
  IdentityStoragePersistedReply,
} from "../../packages/types/diskIO";
import type { IdentityPolicyRawReadResult } from "../../packages/types/identityStorage";
import { diskIOReplyStub, diskIOStub } from "../helpers/diskIOMock";
import { imageFixture } from "../helpers/image";
import { buildSignedTestInitData } from "../libs/miniAppAuth.test";

const diskMessages: DiskBusinessMessage[] = [];
const persistedListeners: ((reply: IdentityStoragePersistedReply) => void)[] = [];
const whitelistDbRows: Map<number, string> = new Map<number, string>();
const blocklistDbRows: Map<number, string> = new Map<number, string>();

mock.module(
  "../../packages/infra/diskIO",
  () =>
    diskIOStub({
      isDiskIOInitialized: (): boolean => true,
      flushDiskIODomain: async (): Promise<DomainFlushOutcome> => {
        const identityWrites: IdentityPolicyPersistedRevision[] = [];
        for (const msg of diskMessages) {
          if (msg.type === "identityPolicyWrite") {
            identityWrites.push({
              table: msg.table,
              id: msg.id,
              revision: msg.revision,
            });
            const targetMap: Map<number, string> =
              msg.table === "whitelist" ? whitelistDbRows : blocklistDbRows;
            if (msg.data === null) {
              targetMap.delete(msg.id);
            } else {
              targetMap.set(msg.id, msg.data);
            }
          }
        }
        for (const listener of persistedListeners) {
          listener({
            type: "identityStoragePersisted",
            writes: identityWrites,
            temporaryAdBypassWrites: [],
            chatStateWrites: [],
            chatQaWrites: [],
            removalWrites: [],
          });
        }
        return { result: "flushed" };
      },
      onDiskIOReply: diskIOReplyStub({
        identityStoragePersisted: (
          listener: (reply: IdentityStoragePersistedReply) => void
        ): void => {
          persistedListeners.push(listener);
        },
      }),
      postDiskIO: (message: DiskBusinessMessage): boolean => {
        diskMessages.push(message);
        return true;
      },
      readIdentityPolicies: async (
        ids: readonly number[]
      ): Promise<IdentityPolicyRawReadResult> => {
        const whitelist: [number, string][] = [];
        const blocklist: [number, string][] = [];
        for (const id of ids) {
          const wRow: string | undefined = whitelistDbRows.get(id);
          if (wRow !== undefined) whitelist.push([id, wRow]);
          const bRow: string | undefined = blocklistDbRows.get(id);
          if (bRow !== undefined) blocklist.push([id, bRow]);
        }
        return {
          whitelist,
          blocklist,
          temporaryAdBypass: [],
        };
      },
      relayLogMessage: (): boolean => true,
    })
);

const { resetIdentityStorageCache } = await import(
  "../../packages/cache/main/identityStorage"
);
const { BOT_TOKEN, SUPER_ADMIN_USER_ID } = await import("../../packages/config/bot");
const { getAssetConfig } = await import("../../packages/config/assets");
const {
  MINI_APP_FEATURE_KEYS,
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_SESSION_HEADER,
} = await import("../../packages/consts/miniApp");
const { WHITELIST_PERMISSION_KEYS } = await import("../../packages/consts/whitelist");
const {
  configureSuperAdminMenuButton,
  saveMiniAppPreparedKeyboardButton,
} = await import("../../packages/infra/telegram/actions/miniApp");
const {
  getMiniAppPickerResult,
  handleMiniAppHttpRequest,
  handleMiniAppSharedMessage,
  issueMiniAppAuthSession,
  prepareMiniAppPicker,
  startMiniAppServer,
  stopMiniAppServer,
} = await import("../../packages/miniApp");
const {
  formatBytes,
  formatGalleryFileSize,
  formatTime,
  formatUptime,
  getFeatureDisplayMeta,
  getPermissionDisplayLabel,
  sanitizeBidiText,
  shortenGalleryFileName,
} = await import("../../packages/miniApp/ui/formatters");
const {
  buildMiniAppGalleryImageUrl,
  clearMiniAppSessionToken,
  confirmMiniAppAction,
  getTelegramWebApp,
  readMiniAppInitData,
  readMiniAppSessionToken,
  setMiniAppSessionToken,
} = await import("../../packages/miniApp/ui/api");
import type {
  MiniAppGalleryPage,
  MiniAppGalleryUploadResult,
  MiniAppPickerResultEvent,
} from "../../packages/types/miniApp";

/**
 * 构造携带当前 `BOT_TOKEN`、`SUPER_ADMIN_USER_ID` 签名与 90 分钟密码会话的测试请求头。
 * @returns 包含 `X-Telegram-Init-Data` 与 `X-Mini-App-Session` 的请求头。
 */
function superAdminHeaders(): Record<string, string> {
  const initData: string = buildSignedTestInitData({
    botToken: BOT_TOKEN,
    authDate: Math.floor(Date.now() / 1000),
    user: {
      id: SUPER_ADMIN_USER_ID,
      first_name: "SuperAdmin",
      username: "super_admin",
    },
  });
  const session = issueMiniAppAuthSession();
  return {
    [MINI_APP_INIT_DATA_HEADER]: initData,
    [MINI_APP_SESSION_HEADER]: session.token,
  };
}

afterEach(async (): Promise<void> => {
  await stopMiniAppServer();
  diskMessages.length = 0;
  whitelistDbRows.clear();
  blocklistDbRows.clear();
  resetIdentityStorageCache();
});

describe("Mini App Picker, Gallery & Bun.serve integration", () => {
  test("prepareMiniAppPicker 与 handleMiniAppSharedMessage 支持好友/联系人与频道选择器导入", async () => {
    const prepUsers = await prepareMiniAppPicker({
      targetList: "whitelist",
      subjectKind: "users",
      api: {
        savePreparedKeyboardButton: async () => ({ id: "prep-btn-users-1" }),
      },
    });
    expect(prepUsers.ok).toBeTrue();
    if (!prepUsers.ok) throw new Error("expected prepared picker");

    const sharedUsersMsg: Message = {
      message_id: 10,
      date: 1_700_000_000,
      chat: { id: SUPER_ADMIN_USER_ID, type: "private", first_name: "Admin" },
      from: { id: SUPER_ADMIN_USER_ID, is_bot: false, first_name: "Admin" },
      users_shared: {
        request_id: prepUsers.requestId,
        users: [
          {
            user_id: 77001,
            first_name: "Naruto",
            last_name: "Uzumaki",
            username: "naruto",
          },
        ],
      },
    };
    const eventUsers: Readonly<MiniAppPickerResultEvent> | null =
      await handleMiniAppSharedMessage(sharedUsersMsg);
    expect(eventUsers?.addedIds).toEqual([77001]);
    expect(getMiniAppPickerResult(prepUsers.requestId)?.addedIds).toEqual([77001]);

    const prepChannel = await prepareMiniAppPicker({
      targetList: "blocklist",
      subjectKind: "channel",
      api: {
        savePreparedKeyboardButton: async () => ({ id: "prep-btn-channel-2" }),
      },
    });
    expect(prepChannel.ok).toBeTrue();
    if (!prepChannel.ok) throw new Error("expected prepared channel picker");

    const mismatchedUsersOnChannelSession: Message = {
      message_id: 12,
      date: 1_700_000_002,
      chat: { id: SUPER_ADMIN_USER_ID, type: "private", first_name: "Admin" },
      from: { id: SUPER_ADMIN_USER_ID, is_bot: false, first_name: "Admin" },
      users_shared: {
        request_id: prepChannel.requestId,
        users: [{ user_id: 77009, first_name: "WrongKind" }],
      },
    };
    expect(await handleMiniAppSharedMessage(mismatchedUsersOnChannelSession)).toBeNull();

    const nonPrivateSharedMsg: Message = {
      message_id: 13,
      date: 1_700_000_003,
      chat: { id: -100123, type: "supergroup", title: "Group" },
      from: { id: SUPER_ADMIN_USER_ID, is_bot: false, first_name: "Admin" },
      chat_shared: {
        request_id: prepChannel.requestId,
        chat_id: -10077002,
      },
    };
    expect(await handleMiniAppSharedMessage(nonPrivateSharedMsg)).toBeNull();

    const sharedChannelMsg: Message = {
      message_id: 11,
      date: 1_700_000_001,
      chat: { id: SUPER_ADMIN_USER_ID, type: "private", first_name: "Admin" },
      from: { id: SUPER_ADMIN_USER_ID, is_bot: false, first_name: "Admin" },
      chat_shared: {
        request_id: prepChannel.requestId,
        chat_id: -10077002,
        title: "Spam Channel",
        username: "spam_ch",
      },
    };
    const eventChannel: Readonly<MiniAppPickerResultEvent> | null =
      await handleMiniAppSharedMessage(sharedChannelMsg);
    expect(eventChannel?.addedIds).toEqual([-10077002]);
  });

  test("UI 格式化与辅助纯函数覆盖全枚举分支", () => {
    expect(formatUptime(90_061_000)).toBe("1d 1h 1m");
    expect(formatUptime(3_661_000)).toBe("1h 1m 1s");
    expect(formatUptime(65_000)).toBe("1m 5s");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10.0 MiB");
    expect(formatTime(0)).toBe("-");
    expect(formatTime(1_700_000_000_000).length).toBeGreaterThan(0);

    for (const featureKey of MINI_APP_FEATURE_KEYS) {
      const meta = getFeatureDisplayMeta(featureKey);
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.command.startsWith("/")).toBeTrue();
    }
    for (const permKey of WHITELIST_PERMISSION_KEYS) {
      expect(getPermissionDisplayLabel(permKey).length).toBeGreaterThan(0);
    }

    expect(getTelegramWebApp()).toBeUndefined();
    expect(readMiniAppInitData()).toBe("");
    expect(confirmMiniAppAction("确认测试？")).toBeTrue();
    expect(sanitizeBidiText("\u202EDoro\u202C")).toBe("Doro");
    expect(formatGalleryFileSize(2_048)).toBe("2.0 KiB");
    expect(formatGalleryFileSize(2 * 1024 * 1024)).toBe("2.00 MiB");
    expect(
      shortenGalleryFileName(
        "004930939ef37baed630e1bbfbc07fadf546783159d874e83f22a592b1a112c2.jpg"
      )
    ).toBe("00493093…a112c2.jpg");
    expect(shortenGalleryFileName("short.png")).toBe("short.png");
    expect(buildMiniAppGalleryImageUrl("abc.jpg")).toBe("./api/gallery/file/abc.jpg");
    expect(readMiniAppSessionToken()).toBe("");
    setMiniAppSessionToken("a".repeat(64));
    expect(readMiniAppSessionToken()).toBe("a".repeat(64));
    clearMiniAppSessionToken();
    expect(readMiniAppSessionToken()).toBe("");
  });

  test("图库 API 支持目录缺失处理、按 SHA-256 与图片协议上传入库及受保护预览读取", async () => {
    const galleryDir: string = getAssetConfig().randomHImageDirectory;
    rmSync(galleryDir, { recursive: true, force: true });

    const missingDirRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/gallery?page=1&pageSize=10", {
        headers: superAdminHeaders(),
      })
    );
    expect(missingDirRes.status).toBe(200);
    const missingDirBody: MiniAppGalleryPage =
      (await missingDirRes.json()) as MiniAppGalleryPage;
    expect(missingDirBody.exists).toBeFalse();
    expect(missingDirBody.total).toBe(0);
    expect(missingDirBody.items).toEqual([]);

    const validPng: Uint8Array = await new Bun.Image(imageFixture(8, 8)).png().bytes();
    const uploadMissingDirRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/gallery/upload", {
        method: "POST",
        headers: superAdminHeaders(),
        body: validPng,
      })
    );
    expect(uploadMissingDirRes.status).toBe(400);
    const uploadMissingDirBody: MiniAppGalleryUploadResult =
      (await uploadMissingDirRes.json()) as MiniAppGalleryUploadResult;
    expect(uploadMissingDirBody.outcome).toBe("missingDirectory");

    mkdirSync(galleryDir, { recursive: true });

    const emptyUploadRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/gallery/upload", {
        method: "POST",
        headers: superAdminHeaders(),
        body: new Uint8Array(0),
      })
    );
    expect(emptyUploadRes.status).toBe(400);
    expect(
      ((await emptyUploadRes.json()) as MiniAppGalleryUploadResult).outcome
    ).toBe("empty");

    const invalidFormatRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/gallery/upload", {
        method: "POST",
        headers: superAdminHeaders(),
        body: new Uint8Array([1, 2, 3, 4]),
      })
    );
    expect(invalidFormatRes.status).toBe(400);
    expect(
      ((await invalidFormatRes.json()) as MiniAppGalleryUploadResult).outcome
    ).toBe("unsupportedFormat");

    const skewedPng: Uint8Array = await new Bun.Image(imageFixture(2_100, 100))
      .png()
      .bytes();
    const invalidDimRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/gallery/upload", {
        method: "POST",
        headers: superAdminHeaders(),
        body: skewedPng,
      })
    );
    expect(invalidDimRes.status).toBe(400);
    expect(
      ((await invalidDimRes.json()) as MiniAppGalleryUploadResult).outcome
    ).toBe("invalidDimensions");

    const addRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/gallery/upload", {
        method: "POST",
        headers: superAdminHeaders(),
        body: validPng,
      })
    );
    expect(addRes.status).toBe(200);
    const addBody: MiniAppGalleryUploadResult =
      (await addRes.json()) as MiniAppGalleryUploadResult;
    expect(addBody.ok).toBeTrue();
    expect(addBody.outcome).toBe("added");
    const expectedFileName: string = `${Bun.SHA256.hash(validPng, "hex")}.png`;
    expect(addBody.fileName).toBe(expectedFileName);

    const dupRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/gallery/upload", {
        method: "POST",
        headers: superAdminHeaders(),
        body: validPng,
      })
    );
    expect(dupRes.status).toBe(200);
    const dupBody: MiniAppGalleryUploadResult =
      (await dupRes.json()) as MiniAppGalleryUploadResult;
    expect(dupBody.ok).toBeTrue();
    expect(dupBody.outcome).toBe("existing");
    expect(dupBody.fileName).toBe(expectedFileName);

    const listRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/gallery?page=1&pageSize=10", {
        headers: superAdminHeaders(),
      })
    );
    expect(listRes.status).toBe(200);
    const listBody: MiniAppGalleryPage =
      (await listRes.json()) as MiniAppGalleryPage;
    expect(listBody.exists).toBeTrue();
    expect(listBody.total).toBe(1);
    expect(listBody.items[0]?.fileName).toBe(expectedFileName);
    expect(listBody.items[0]?.mimeType).toBe("image/png");

    const headers: Record<string, string> = superAdminHeaders();
    const initData: string = headers[MINI_APP_INIT_DATA_HEADER]!;
    const sessionToken: string = headers[MINI_APP_SESSION_HEADER]!;
    const queryOnJsonRes: Response = await handleMiniAppHttpRequest(
      new Request(
        `http://127.0.0.1:3000/api/status?initData=${encodeURIComponent(initData)}&session=${encodeURIComponent(sessionToken)}`
      )
    );
    expect(queryOnJsonRes.status).toBe(401);

    const navigateFileRes: Response = await handleMiniAppHttpRequest(
      new Request(
        `http://127.0.0.1:3000/api/gallery/file/${expectedFileName}?initData=${encodeURIComponent(initData)}&session=${encodeURIComponent(sessionToken)}`,
        {
          headers: {
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
          },
        }
      )
    );
    expect(navigateFileRes.status).toBe(403);

    const fileRes: Response = await handleMiniAppHttpRequest(
      new Request(
        `http://127.0.0.1:3000/api/gallery/file/${expectedFileName}?initData=${encodeURIComponent(initData)}&session=${encodeURIComponent(sessionToken)}`
      )
    );
    expect(fileRes.status).toBe(200);
    expect(fileRes.headers.get("Content-Type")).toBe("image/png");
    const fetchedBytes: Uint8Array = await fileRes.bytes();
    expect(fetchedBytes).toEqual(validPng);

    const traversalRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/gallery/file/..%2Fsecret.png", {
        headers: superAdminHeaders(),
      })
    );
    expect(traversalRes.status).toBe(404);

    rmSync(galleryDir, { recursive: true, force: true });
  });

  test("Bun.serve 原生路由服务可启动并响应 /healthz 与 /", async () => {
    const server = startMiniAppServer({
      url: "https://miniapp.example.com",
      host: "127.0.0.1",
      port: 0,
      password: "test-mini-app-password",
    });
    expect(server).not.toBeNull();
    const port: number = server!.port ?? 0;
    expect(port).toBeGreaterThan(0);

    const healthRes: Response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ ok: true });

    const htmlRes: Response = await fetch(`http://127.0.0.1:${port}/`);
    expect(htmlRes.status).toBe(200);
    const htmlText: string = await htmlRes.text();
    expect(htmlText).toContain("id=\"root\"");

    const menuOk: boolean = await configureSuperAdminMenuButton({
      superAdminUserId: SUPER_ADMIN_USER_ID,
      buttonText: "控制台",
      webAppUrl: "https://miniapp.example.com",
      api: {
        setChatMenuButton: async () => true,
      },
    });
    expect(menuOk).toBeTrue();

    const prepBtnId: string | undefined = await saveMiniAppPreparedKeyboardButton({
      userId: SUPER_ADMIN_USER_ID,
      button: {
        text: "选择联系人",
        request_users: {
          request_id: 42,
        },
      },
      api: {
        savePreparedKeyboardButton: async () => ({ id: "btn-42" }),
      },
    });
    expect(prepBtnId).toBe("btn-42");
  });
});

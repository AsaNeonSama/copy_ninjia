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
  MINI_APP_ASSET_CACHE_CONTROL,
  MINI_APP_BUTTON_TEXT,
  MINI_APP_CSP_HEADER_VALUE,
  MINI_APP_FEATURE_KEYS,
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_LANGUAGES,
  MINI_APP_SESSION_HEADER,
  MINI_APP_TAB_KEYS,
  MINI_APP_X_FRAME_OPTIONS_VALUE,
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
  buildMiniAppGalleryDownloadUrl,
  buildMiniAppGalleryImageUrl,
  buildMiniAppSvgResourceUrl,
  clearMiniAppAssetToken,
  clearMiniAppSessionToken,
  confirmMiniAppAction,
  getTelegramWebApp,
  readMiniAppAssetToken,
  readMiniAppInitData,
  readMiniAppSessionToken,
  setMiniAppAssetToken,
  setMiniAppSessionToken,
} = await import("../../packages/miniApp/ui/api");
const { deriveMiniAppAssetToken } = await import("../../packages/libs/miniAppAuth");
const {
  detectBrowserDefaultLanguage,
  detectInitialMiniAppLanguage,
  getMiniAppTranslations,
} = await import("../../packages/miniApp/ui/i18n");
const {
  applyMiniAppThemeToDocument,
  detectInitialMiniAppTheme,
  resetMiniAppStoreForTest,
  useMiniAppStore,
} = await import("../../packages/miniApp/ui/store");
const {
  ChatsSvgIcon,
  DownloadSvgIcon,
  GallerySvgIcon,
  IdentitiesSvgIcon,
  MenuSvgIcon,
  SearchSvgIcon,
  StatusSvgIcon,
  TabSvgIcon,
  TrashSvgIcon,
} = await import("../../packages/miniApp/miniAppResoures");
import type {
  MiniAppGalleryDeleteResult,
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
    expect(eventUsers?.duplicateIds).toEqual([]);
    expect(getMiniAppPickerResult(prepUsers.requestId)?.addedIds).toEqual([77001]);

    const prepUsersDup = await prepareMiniAppPicker({
      targetList: "whitelist",
      subjectKind: "users",
      api: {
        savePreparedKeyboardButton: async () => ({ id: "prep-btn-users-dup" }),
      },
    });
    expect(prepUsersDup.ok).toBeTrue();
    if (!prepUsersDup.ok) throw new Error("expected prepared duplicate picker");
    const dupUsersEvent: Readonly<MiniAppPickerResultEvent> | null =
      await handleMiniAppSharedMessage({
        ...sharedUsersMsg,
        message_id: 14,
        users_shared: {
          request_id: prepUsersDup.requestId,
          users: [{ user_id: 77001, first_name: "Naruto" }],
        },
      });
    expect(dupUsersEvent?.addedIds).toEqual([]);
    expect(dupUsersEvent?.duplicateIds).toEqual([77001]);

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

  test("UI 格式化与辅助纯函数覆盖全枚举分支", async () => {
    expect(formatUptime(90_061_000)).toBe("1d 1h 1m");
    expect(formatUptime(3_661_000)).toBe("1h 1m 1s");
    expect(formatUptime(65_000)).toBe("1m 5s");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10.0 MiB");
    expect(formatTime(0)).toBe("-");
    expect(formatTime(1_700_000_000_000).length).toBeGreaterThan(0);

    for (const lang of MINI_APP_LANGUAGES) {
      const dict = getMiniAppTranslations(lang);
      expect(dict.appTitle).toContain("♡");
      expect(dict.identities.duplicateBannerTitle.length).toBeGreaterThan(0);
      for (const tabKey of MINI_APP_TAB_KEYS) {
        expect(dict.tabs[tabKey].length).toBeGreaterThan(0);
        expect(TabSvgIcon({ tabKey })).toBeDefined();
      }
      for (const featureKey of MINI_APP_FEATURE_KEYS) {
        const meta = getFeatureDisplayMeta(featureKey, lang);
        expect(meta.label.length).toBeGreaterThan(0);
        expect(meta.command.startsWith("/")).toBeTrue();
      }
      for (const permKey of WHITELIST_PERMISSION_KEYS) {
        expect(getPermissionDisplayLabel(permKey, lang).length).toBeGreaterThan(0);
      }
      expect(
        dict.gate.deniedPolicyReason("MISSING_INIT_DATA", "fallback").length
      ).toBeGreaterThan(0);
      expect(dict.gate.deniedNodeGatewayState(403).length).toBeGreaterThan(0);
      expect(dict.identities.whitelistTab.length).toBeGreaterThan(0);
      expect(dict.identities.blocklistTab.length).toBeGreaterThan(0);
      expect(dict.gallery.sectionTitle.length).toBeGreaterThan(0);
      expect(dict.gallery.downloadButton.length).toBeGreaterThan(0);
      expect(dict.gallery.downloadingButton.length).toBeGreaterThan(0);
      expect(dict.gallery.downloadedToast("abc.png").length).toBeGreaterThan(0);
    }

    expect(["zh", "ja", "en"]).toContain(detectBrowserDefaultLanguage());
    expect(["zh", "ja", "en"]).toContain(detectInitialMiniAppLanguage());
    expect(detectInitialMiniAppTheme()).toBe("light");
    applyMiniAppThemeToDocument("light");

    resetMiniAppStoreForTest();
    expect(useMiniAppStore.getState().theme).toBe("light");
    expect(useMiniAppStore.getState().sidebarOpen).toBeFalse();
    useMiniAppStore.getState().toggleSidebar();
    expect(useMiniAppStore.getState().sidebarOpen).toBeTrue();
    useMiniAppStore.getState().setActiveTab("identities");
    expect(useMiniAppStore.getState().activeTab).toBe("identities");
    expect(useMiniAppStore.getState().sidebarOpen).toBeFalse();
    useMiniAppStore.getState().toggleTheme();
    expect(useMiniAppStore.getState().theme).toBe("dark");
    useMiniAppStore.getState().setLanguage("ja");
    expect(useMiniAppStore.getState().language).toBe("ja");
    useMiniAppStore.getState().showToast("笨蛋杂鱼♡", "danger");
    expect(useMiniAppStore.getState().toastText).toBe("笨蛋杂鱼♡");
    expect(useMiniAppStore.getState().toastTone).toBe("danger");
    useMiniAppStore.getState().clearToast();
    expect(useMiniAppStore.getState().toastText).toBe("");
    const confirmPromise: Promise<boolean> = useMiniAppStore
      .getState()
      .requestConfirm("确认删除？", "danger");
    expect(useMiniAppStore.getState().confirmModal?.message).toBe("确认删除？");
    useMiniAppStore.getState().resolveConfirm(true);
    expect(await confirmPromise).toBeTrue();
    expect(useMiniAppStore.getState().confirmModal).toBeNull();
    resetMiniAppStoreForTest();

    expect(MenuSvgIcon({})).toBeDefined();
    expect(StatusSvgIcon({})).toBeDefined();
    expect(ChatsSvgIcon({})).toBeDefined();
    expect(IdentitiesSvgIcon({})).toBeDefined();
    expect(GallerySvgIcon({})).toBeDefined();
    expect(DownloadSvgIcon({})).toBeDefined();
    expect(SearchSvgIcon({})).toBeDefined();
    expect(TrashSvgIcon({})).toBeDefined();

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
    expect(buildMiniAppSvgResourceUrl("status.svg")).toBe(
      "./api/resources/svg/status.svg"
    );
    expect(readMiniAppAssetToken()).toBe("");
    setMiniAppAssetToken("b".repeat(64));
    expect(readMiniAppAssetToken()).toBe("b".repeat(64));
    expect(buildMiniAppGalleryImageUrl("abc.jpg")).toBe(
      `./api/gallery/file/abc.jpg?token=${"b".repeat(64)}`
    );
    expect(buildMiniAppSvgResourceUrl("status.svg")).toBe(
      `./api/resources/svg/status.svg?token=${"b".repeat(64)}`
    );
    setMiniAppSessionToken("a".repeat(64));
    expect(buildMiniAppGalleryDownloadUrl("abc.jpg")).toBe(
      `./api/gallery/download/abc.jpg?token=${"b".repeat(64)}&session=${"a".repeat(64)}`
    );
    clearMiniAppAssetToken();
    expect(readMiniAppAssetToken()).toBe("");
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
    expect(fileRes.headers.get("Cache-Control")).toBe(MINI_APP_ASSET_CACHE_CONTROL);
    expect(fileRes.headers.get("CDN-Cache-Control")).toBe(MINI_APP_ASSET_CACHE_CONTROL);
    const imageEtag: string | null = fileRes.headers.get("ETag");
    expect(imageEtag !== null && imageEtag.length > 0).toBeTrue();
    const fetchedBytes: Uint8Array = await fileRes.bytes();
    expect(fetchedBytes).toEqual(validPng);

    const assetToken: string = deriveMiniAppAssetToken(
      BOT_TOKEN,
      SUPER_ADMIN_USER_ID
    );
    const tokenImageRes: Response = await handleMiniAppHttpRequest(
      new Request(
        `http://127.0.0.1:3000/api/gallery/file/${expectedFileName}?token=${encodeURIComponent(assetToken)}`
      )
    );
    expect(tokenImageRes.status).toBe(200);
    expect(tokenImageRes.headers.get("CDN-Cache-Control")).toBe(
      MINI_APP_ASSET_CACHE_CONTROL
    );

    const cachedImageRes: Response = await handleMiniAppHttpRequest(
      new Request(
        `http://127.0.0.1:3000/api/gallery/file/${expectedFileName}?initData=${encodeURIComponent(initData)}&session=${encodeURIComponent(sessionToken)}`,
        { headers: { "if-none-match": imageEtag! } }
      )
    );
    expect(cachedImageRes.status).toBe(304);

    const unauthCachedImageRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/gallery/file/${expectedFileName}`, {
        headers: { "if-none-match": imageEtag! },
      })
    );
    expect(unauthCachedImageRes.status).toBe(401);

    const unauthImageRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/gallery/file/${expectedFileName}`)
    );
    expect(unauthImageRes.status).toBe(401);

    const nonAdminInitData: string = buildSignedTestInitData({
      botToken: BOT_TOKEN,
      authDate: Math.floor(Date.now() / 1000),
      user: {
        id: SUPER_ADMIN_USER_ID + 777,
        first_name: "NonAdmin",
      },
    });
    const nonAdminImageRes: Response = await handleMiniAppHttpRequest(
      new Request(
        `http://127.0.0.1:3000/api/gallery/file/${expectedFileName}?initData=${encodeURIComponent(nonAdminInitData)}`
      )
    );
    expect(nonAdminImageRes.status).toBe(403);

    const unauthSvgRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/resources/svg/status.svg")
    );
    expect(unauthSvgRes.status).toBe(401);

    const unauthStaticSvgRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/miniAppResoures/status.svg")
    );
    expect(unauthStaticSvgRes.status).toBe(401);

    const nonAdminSvgRes: Response = await handleMiniAppHttpRequest(
      new Request(
        `http://127.0.0.1:3000/api/resources/svg/status.svg?initData=${encodeURIComponent(nonAdminInitData)}`
      )
    );
    expect(nonAdminSvgRes.status).toBe(403);

    const navigateSvgRes: Response = await handleMiniAppHttpRequest(
      new Request(
        `http://127.0.0.1:3000/api/resources/svg/status.svg?initData=${encodeURIComponent(initData)}`,
        {
          headers: {
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
          },
        }
      )
    );
    expect(navigateSvgRes.status).toBe(403);

    const okSvgRes: Response = await handleMiniAppHttpRequest(
      new Request(
        `http://127.0.0.1:3000/api/resources/svg/status.svg?initData=${encodeURIComponent(initData)}`
      )
    );
    expect(okSvgRes.status).toBe(200);
    expect(okSvgRes.headers.get("Content-Type")).toBe(
      "image/svg+xml; charset=utf-8"
    );
    expect(okSvgRes.headers.get("Cache-Control")).toBe(MINI_APP_ASSET_CACHE_CONTROL);
    expect(okSvgRes.headers.get("CDN-Cache-Control")).toBe(MINI_APP_ASSET_CACHE_CONTROL);
    const svgEtag: string | null = okSvgRes.headers.get("ETag");
    expect(svgEtag !== null && svgEtag.length > 0).toBeTrue();
    expect(await okSvgRes.text()).toContain("<svg");

    const tokenSvgRes: Response = await handleMiniAppHttpRequest(
      new Request(
        `http://127.0.0.1:3000/api/resources/svg/status.svg?token=${encodeURIComponent(assetToken)}`
      )
    );
    expect(tokenSvgRes.status).toBe(200);
    expect(await tokenSvgRes.text()).toContain("<svg");

    const faviconRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/favicon.ico")
    );
    expect(faviconRes.status).toBe(200);
    expect(faviconRes.headers.get("Content-Type")).toBe("image/x-icon");
    expect(faviconRes.headers.get("Cache-Control")).toBe(
      MINI_APP_ASSET_CACHE_CONTROL
    );
    expect(faviconRes.headers.get("CDN-Cache-Control")).toBe(
      MINI_APP_ASSET_CACHE_CONTROL
    );
    const faviconEtag: string | null = faviconRes.headers.get("ETag");
    expect(faviconEtag !== null && faviconEtag.length > 0).toBeTrue();
    const faviconBytes: Uint8Array = await faviconRes.bytes();
    expect(faviconBytes[0]).toBe(0);
    expect(faviconBytes[1]).toBe(0);
    expect(faviconBytes[2]).toBe(1);
    expect(faviconBytes[3]).toBe(0);

    const favicon304Res: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/favicon.ico", {
        headers: { "if-none-match": faviconEtag! },
      })
    );
    expect(favicon304Res.status).toBe(304);

    const cachedSvgRes: Response = await handleMiniAppHttpRequest(
      new Request(
        `http://127.0.0.1:3000/api/resources/svg/status.svg?initData=${encodeURIComponent(initData)}`,
        { headers: { "if-none-match": svgEtag! } }
      )
    );
    expect(cachedSvgRes.status).toBe(304);

    const unauthCachedSvgRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/resources/svg/status.svg", {
        headers: { "if-none-match": svgEtag! },
      })
    );
    expect(unauthCachedSvgRes.status).toBe(401);

    const okLegacySvgRes: Response = await handleMiniAppHttpRequest(
      new Request(
        `http://127.0.0.1:3000/miniAppResoures/chats.svg?initData=${encodeURIComponent(initData)}`
      )
    );
    expect(okLegacySvgRes.status).toBe(200);
    expect(await okLegacySvgRes.text()).toContain("<svg");

    const traversalSvgRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/resources/svg/..%2Fsecret.svg", {
        headers: superAdminHeaders(),
      })
    );
    expect(traversalSvgRes.status).toBe(404);

    const traversalRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/gallery/file/..%2Fsecret.png", {
        headers: superAdminHeaders(),
      })
    );
    expect(traversalRes.status).toBe(404);

    const unauthDownloadRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/gallery/download/${expectedFileName}`)
    );
    expect(unauthDownloadRes.status).toBe(401);

    const noSessionDownloadRes: Response = await handleMiniAppHttpRequest(
      new Request(
        `http://127.0.0.1:3000/api/gallery/download/${expectedFileName}?token=${encodeURIComponent(assetToken)}`,
        {
          headers: {
            [MINI_APP_INIT_DATA_HEADER]: initData,
          },
        }
      )
    );
    expect(noSessionDownloadRes.status).toBe(401);

    const downloadRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/gallery/download/${expectedFileName}`, {
        headers: superAdminHeaders(),
      })
    );
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("Content-Type")).toBe("image/png");
    expect(downloadRes.headers.get("Content-Disposition")).toBe(
      `attachment; filename="${expectedFileName}"`
    );
    expect(await downloadRes.bytes()).toEqual(validPng);

    const queryDownloadRes: Response = await handleMiniAppHttpRequest(
      new Request(
        `http://127.0.0.1:3000/api/gallery/download/${expectedFileName}?token=${encodeURIComponent(assetToken)}&session=${encodeURIComponent(sessionToken)}`
      )
    );
    expect(queryDownloadRes.status).toBe(200);
    expect(queryDownloadRes.headers.get("Content-Disposition")).toBe(
      `attachment; filename="${expectedFileName}"`
    );
    expect(await queryDownloadRes.bytes()).toEqual(validPng);

    const headDownloadRes: Response = await handleMiniAppHttpRequest(
      new Request(
        `http://127.0.0.1:3000/api/gallery/download/${expectedFileName}?token=${encodeURIComponent(assetToken)}&session=${encodeURIComponent(sessionToken)}`,
        { method: "HEAD" }
      )
    );
    expect(headDownloadRes.status).toBe(200);
    expect(headDownloadRes.headers.get("Content-Disposition")).toBe(
      `attachment; filename="${expectedFileName}"`
    );
    expect(await headDownloadRes.bytes()).toEqual(new Uint8Array(0));

    const missingDownloadRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/gallery/download/..%2Fsecret.png", {
        headers: superAdminHeaders(),
      })
    );
    expect(missingDownloadRes.status).toBe(404);

    const invalidDeleteRes: Response = await handleMiniAppHttpRequest(
      new Request("http://127.0.0.1:3000/api/gallery/delete", {
        method: "POST",
        headers: {
          ...superAdminHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ fileName: "../evil.png" }),
      })
    );
    expect(invalidDeleteRes.status).toBe(400);
    expect(
      ((await invalidDeleteRes.json()) as MiniAppGalleryDeleteResult).outcome
    ).toBe("invalidFileName");

    const deleteRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/gallery/file/${expectedFileName}`, {
        method: "DELETE",
        headers: superAdminHeaders(),
      })
    );
    expect(deleteRes.status).toBe(200);
    const deleteBody: MiniAppGalleryDeleteResult =
      (await deleteRes.json()) as MiniAppGalleryDeleteResult;
    expect(deleteBody.ok).toBeTrue();
    expect(deleteBody.outcome).toBe("deleted");
    expect(deleteBody.fileName).toBe(expectedFileName);

    const deleteAgainRes: Response = await handleMiniAppHttpRequest(
      new Request(`http://127.0.0.1:3000/api/gallery/file/${expectedFileName}`, {
        method: "DELETE",
        headers: superAdminHeaders(),
      })
    );
    expect(deleteAgainRes.status).toBe(404);
    expect(
      ((await deleteAgainRes.json()) as MiniAppGalleryDeleteResult).outcome
    ).toBe("notFound");

    rmSync(galleryDir, { recursive: true, force: true });
  });

  test("Bun.serve 原生路由服务可启动并响应 /healthz 与 /（携带严格 CSP 与 X-Frame-Options）", async () => {
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
    expect(htmlRes.headers.get("Content-Security-Policy")).toBe(
      MINI_APP_CSP_HEADER_VALUE
    );
    expect(htmlRes.headers.get("X-Frame-Options")).toBe(
      MINI_APP_X_FRAME_OPTIONS_VALUE
    );
    const htmlText: string = await htmlRes.text();
    expect(htmlText).toContain("id=\"root\"");
    expect(htmlText).not.toContain("./main.tsx");

    const menuOk: boolean = await configureSuperAdminMenuButton({
      superAdminUserId: SUPER_ADMIN_USER_ID,
      buttonText: MINI_APP_BUTTON_TEXT,
      webAppUrl: "https://miniapp.example.com",
      api: {
        setChatMenuButton: async () => true,
      },
    });
    expect(menuOk).toBeTrue();
    expect(MINI_APP_BUTTON_TEXT).toBe("App");

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

/**
 * `packages/mini-app-frontend/` 不得依赖目录外的文件，与服务端重合的常量、类型、函数和 favicon 在前端
 * 单独复制。本文件逐项核对这些副本与服务端定义（含 `index.html` 内联脚本 SHA-256 与服务端 CSP 头）一致，
 * 任何一侧改动而另一侧未同步时失败：类型在编译期按 TypeScript 恒等关系核对（含 readonly 与可选修饰），
 * 常量、函数与文件在运行期核对。
 */

import { describe, expect, test } from "bun:test";
import * as serverMemoryConsts from "../../packages/consts/aiChat/memory";
import * as serverMiniAppConsts from "../../packages/consts/miniApp";
import { MINI_APP_FAVICON_PATH } from "../../packages/consts/paths";
import * as serverTimeConsts from "../../packages/consts/time";
import * as serverWhitelistConsts from "../../packages/consts/whitelist";
import { errorMessage as serverErrorMessage } from "../../packages/libs/errorMessage";
import * as frontendMemoryConsts from "../../packages/mini-app-frontend/consts/memory";
import * as frontendMiniAppConsts from "../../packages/mini-app-frontend/consts/miniApp";
import * as frontendTimeConsts from "../../packages/mini-app-frontend/consts/time";
import * as frontendWhitelistConsts from "../../packages/mini-app-frontend/consts/whitelist";
import { errorMessage as frontendErrorMessage } from "../../packages/mini-app-frontend/libs/errorMessage";
import { buildMiniAppGalleryDownloadFileName as buildFrontendDownloadFileName } from "../../packages/mini-app-frontend/libs/formatters";
import type * as FrontendIdentityPolicy from "../../packages/mini-app-frontend/types/identityPolicy";
import type * as FrontendMiniApp from "../../packages/mini-app-frontend/types/miniApp";
import type * as FrontendMiniAppTotp from "../../packages/mini-app-frontend/types/miniAppTotp";
import { buildMiniAppGalleryDownloadFileName as buildServerDownloadFileName } from "../../packages/mini-app-api-server/libs/downloadFileName";
import type * as ServerIdentityPolicy from "../../packages/types/identityPolicy";
import type * as ServerMiniApp from "../../packages/types/miniApp";
import type * as ServerMiniAppTotp from "../../packages/types/miniAppTotp";

/** 两个类型在恒等关系下完全一致时为 true。 */
type Exact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

/** 每一项不一致时 `true satisfies false` 在 typecheck 阶段报错，错误行即不一致的类型。 */
const contractTypeParity: Readonly<Record<string, true>> = {
  MiniAppAccessDiagnostics: true satisfies Exact<FrontendMiniApp.MiniAppAccessDiagnostics, ServerMiniApp.MiniAppAccessDiagnostics>,
  MiniAppLoginSuccessResponse: true satisfies Exact<FrontendMiniApp.MiniAppLoginSuccessResponse, ServerMiniApp.MiniAppLoginSuccessResponse>,
  MiniAppCapabilityDetailItem: true satisfies Exact<FrontendMiniApp.MiniAppCapabilityDetailItem, ServerMiniApp.MiniAppCapabilityDetailItem>,
  MiniAppCapabilityStatus: true satisfies Exact<FrontendMiniApp.MiniAppCapabilityStatus, ServerMiniApp.MiniAppCapabilityStatus>,
  MiniAppMoodView: true satisfies Exact<FrontendMiniApp.MiniAppMoodView, ServerMiniApp.MiniAppMoodView>,
  MiniAppMoodMutationResult: true satisfies Exact<FrontendMiniApp.MiniAppMoodMutationResult, ServerMiniApp.MiniAppMoodMutationResult>,
  MiniAppActiveSessionCounts: true satisfies Exact<FrontendMiniApp.MiniAppActiveSessionCounts, ServerMiniApp.MiniAppActiveSessionCounts>,
  MiniAppStatusView: true satisfies Exact<FrontendMiniApp.MiniAppStatusView, ServerMiniApp.MiniAppStatusView>,
  MiniAppToggleableFeatureKey: true satisfies Exact<FrontendMiniApp.MiniAppToggleableFeatureKey, ServerMiniApp.MiniAppToggleableFeatureKey>,
  MiniAppFeatureKey: true satisfies Exact<FrontendMiniApp.MiniAppFeatureKey, ServerMiniApp.MiniAppFeatureKey>,
  MiniAppChatFeatureFlags: true satisfies Exact<FrontendMiniApp.MiniAppChatFeatureFlags, ServerMiniApp.MiniAppChatFeatureFlags>,
  MiniAppChatSummary: true satisfies Exact<FrontendMiniApp.MiniAppChatSummary, ServerMiniApp.MiniAppChatSummary>,
  MiniAppChatBotPermissionsView: true satisfies Exact<FrontendMiniApp.MiniAppChatBotPermissionsView, ServerMiniApp.MiniAppChatBotPermissionsView>,
  BatchKickTriggerSource: true satisfies Exact<FrontendMiniApp.BatchKickTriggerSource, ServerMiniApp.BatchKickTriggerSource>,
  MiniAppBatchKickCompletion: true satisfies Exact<FrontendMiniApp.MiniAppBatchKickCompletion, ServerMiniApp.MiniAppBatchKickCompletion>,
  MiniAppChatDetail: true satisfies Exact<FrontendMiniApp.MiniAppChatDetail, ServerMiniApp.MiniAppChatDetail>,
  MiniAppFeatureToggleResult: true satisfies Exact<FrontendMiniApp.MiniAppFeatureToggleResult, ServerMiniApp.MiniAppFeatureToggleResult>,
  MiniAppBatchKickOutcome: true satisfies Exact<FrontendMiniApp.MiniAppBatchKickOutcome, ServerMiniApp.MiniAppBatchKickOutcome>,
  MiniAppBatchKickResult: true satisfies Exact<FrontendMiniApp.MiniAppBatchKickResult, ServerMiniApp.MiniAppBatchKickResult>,
  MiniAppChatTargetKind: true satisfies Exact<FrontendMiniApp.MiniAppChatTargetKind, ServerMiniApp.MiniAppChatTargetKind>,
  MiniAppTranslateLanguage: true satisfies Exact<FrontendMiniApp.MiniAppTranslateLanguage, ServerMiniApp.MiniAppTranslateLanguage>,
  MiniAppChatQaItem: true satisfies Exact<FrontendMiniApp.MiniAppChatQaItem, ServerMiniApp.MiniAppChatQaItem>,
  MiniAppChatDeleteTargetItem: true satisfies Exact<FrontendMiniApp.MiniAppChatDeleteTargetItem, ServerMiniApp.MiniAppChatDeleteTargetItem>,
  MiniAppChatTranslateTargetItem: true satisfies Exact<FrontendMiniApp.MiniAppChatTranslateTargetItem, ServerMiniApp.MiniAppChatTranslateTargetItem>,
  MiniAppChatTargetsView: true satisfies Exact<FrontendMiniApp.MiniAppChatTargetsView, ServerMiniApp.MiniAppChatTargetsView>,
  MiniAppChatTargetsMutationAction: true satisfies Exact<FrontendMiniApp.MiniAppChatTargetsMutationAction, ServerMiniApp.MiniAppChatTargetsMutationAction>,
  MiniAppChatTargetsMutationRequest: true satisfies Exact<FrontendMiniApp.MiniAppChatTargetsMutationRequest, ServerMiniApp.MiniAppChatTargetsMutationRequest>,
  MiniAppChatTargetsMutationResult: true satisfies Exact<FrontendMiniApp.MiniAppChatTargetsMutationResult, ServerMiniApp.MiniAppChatTargetsMutationResult>,
  MiniAppMessageItem: true satisfies Exact<FrontendMiniApp.MiniAppMessageItem, ServerMiniApp.MiniAppMessageItem>,
  MiniAppMessagePage: true satisfies Exact<FrontendMiniApp.MiniAppMessagePage, ServerMiniApp.MiniAppMessagePage>,
  MiniAppWhitelistEntryView: true satisfies Exact<FrontendMiniApp.MiniAppWhitelistEntryView, ServerMiniApp.MiniAppWhitelistEntryView>,
  MiniAppBlocklistEntryView: true satisfies Exact<FrontendMiniApp.MiniAppBlocklistEntryView, ServerMiniApp.MiniAppBlocklistEntryView>,
  MiniAppPermissionDescriptor: true satisfies Exact<FrontendMiniApp.MiniAppPermissionDescriptor, ServerMiniApp.MiniAppPermissionDescriptor>,
  MiniAppWhitelistPage: true satisfies Exact<FrontendMiniApp.MiniAppWhitelistPage, ServerMiniApp.MiniAppWhitelistPage>,
  MiniAppBlocklistPage: true satisfies Exact<FrontendMiniApp.MiniAppBlocklistPage, ServerMiniApp.MiniAppBlocklistPage>,
  MiniAppIdentityMutationResult: true satisfies Exact<FrontendMiniApp.MiniAppIdentityMutationResult, ServerMiniApp.MiniAppIdentityMutationResult>,
  MiniAppPickerTargetList: true satisfies Exact<FrontendMiniApp.MiniAppPickerTargetList, ServerMiniApp.MiniAppPickerTargetList>,
  MiniAppPickerSubjectKind: true satisfies Exact<FrontendMiniApp.MiniAppPickerSubjectKind, ServerMiniApp.MiniAppPickerSubjectKind>,
  MiniAppPickerResultEvent: true satisfies Exact<FrontendMiniApp.MiniAppPickerResultEvent, ServerMiniApp.MiniAppPickerResultEvent>,
  MiniAppGalleryItem: true satisfies Exact<FrontendMiniApp.MiniAppGalleryItem, ServerMiniApp.MiniAppGalleryItem>,
  MiniAppGalleryPage: true satisfies Exact<FrontendMiniApp.MiniAppGalleryPage, ServerMiniApp.MiniAppGalleryPage>,
  MiniAppGalleryUploadOutcome: true satisfies Exact<FrontendMiniApp.MiniAppGalleryUploadOutcome, ServerMiniApp.MiniAppGalleryUploadOutcome>,
  MiniAppGalleryUploadResult: true satisfies Exact<FrontendMiniApp.MiniAppGalleryUploadResult, ServerMiniApp.MiniAppGalleryUploadResult>,
  MiniAppGalleryDeleteOutcome: true satisfies Exact<FrontendMiniApp.MiniAppGalleryDeleteOutcome, ServerMiniApp.MiniAppGalleryDeleteOutcome>,
  MiniAppGalleryDeleteResult: true satisfies Exact<FrontendMiniApp.MiniAppGalleryDeleteResult, ServerMiniApp.MiniAppGalleryDeleteResult>,
  PrepareMiniAppPickerResult: true satisfies Exact<FrontendMiniApp.PrepareMiniAppPickerResult, ServerMiniApp.PrepareMiniAppPickerResult>,
  MiniAppAuthMode: true satisfies Exact<FrontendMiniAppTotp.MiniAppAuthMode, ServerMiniAppTotp.MiniAppAuthMode>,
  MiniAppTotpStatusView: true satisfies Exact<FrontendMiniAppTotp.MiniAppTotpStatusView, ServerMiniAppTotp.MiniAppTotpStatusView>,
  MiniAppTotpSetupResponse: true satisfies Exact<FrontendMiniAppTotp.MiniAppTotpSetupResponse, ServerMiniAppTotp.MiniAppTotpSetupResponse>,
  MiniAppTotpMutationResponse: true satisfies Exact<FrontendMiniAppTotp.MiniAppTotpMutationResponse, ServerMiniAppTotp.MiniAppTotpMutationResponse>,
  WhitelistPermissions: true satisfies Exact<FrontendIdentityPolicy.WhitelistPermissions, ServerIdentityPolicy.WhitelistPermissions>,
  WhitelistPermissionKey: true satisfies Exact<FrontendIdentityPolicy.WhitelistPermissionKey, ServerIdentityPolicy.WhitelistPermissionKey>,
};

describe("Mini App 前端副本与服务端定义一致", () => {
  test("接口契约类型副本逐项与服务端声明恒等（编译期核对）", () => {
    expect(Object.values(contractTypeParity).every((matched: boolean): boolean => matched)).toBeTrue();
  });

  test("前端复制的字面量常量与服务端同名常量取值一致", () => {
    expect(frontendMiniAppConsts.MINI_APP_INIT_DATA_HEADER).toBe(serverMiniAppConsts.MINI_APP_INIT_DATA_HEADER);
    expect(frontendMiniAppConsts.MINI_APP_SESSION_HEADER).toBe(serverMiniAppConsts.MINI_APP_SESSION_HEADER);
    expect(frontendMiniAppConsts.MINI_APP_SESSION_EXPIRES_AT_HEADER).toBe(serverMiniAppConsts.MINI_APP_SESSION_EXPIRES_AT_HEADER);
    expect(frontendMiniAppConsts.MINI_APP_SESSION_TTL_MS).toBe(serverMiniAppConsts.MINI_APP_SESSION_TTL_MS);
    expect(frontendMiniAppConsts.MINI_APP_SESSION_REFRESH_THRESHOLD_MS).toBe(serverMiniAppConsts.MINI_APP_SESSION_REFRESH_THRESHOLD_MS);
    expect(frontendMiniAppConsts.MINI_APP_TMA_AUTH_PREFIX).toBe(serverMiniAppConsts.MINI_APP_TMA_AUTH_PREFIX);
    expect(frontendMiniAppConsts.MINI_APP_GALLERY_DEFAULT_PAGE_SIZE).toBe(serverMiniAppConsts.MINI_APP_GALLERY_DEFAULT_PAGE_SIZE);
    expect(frontendMiniAppConsts.MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE).toBe(serverMiniAppConsts.MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE);
    expect(frontendMiniAppConsts.MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE).toBe(serverMiniAppConsts.MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE);
    expect(frontendMiniAppConsts.MINI_APP_BATCH_KICK_MIN_HOURS).toBe(serverMiniAppConsts.MINI_APP_BATCH_KICK_MIN_HOURS);
    expect(frontendMiniAppConsts.MINI_APP_BATCH_KICK_MAX_HOURS).toBe(serverMiniAppConsts.MINI_APP_BATCH_KICK_MAX_HOURS);
    expect(frontendMiniAppConsts.MINI_APP_FEATURE_KEYS).toEqual(serverMiniAppConsts.MINI_APP_FEATURE_KEYS);
    expect(frontendMiniAppConsts.MINI_APP_CHAT_TARGET_KINDS).toEqual(serverMiniAppConsts.MINI_APP_CHAT_TARGET_KINDS);
    expect(frontendMiniAppConsts.MINI_APP_TRANSLATE_LANGUAGES).toEqual(serverMiniAppConsts.MINI_APP_TRANSLATE_LANGUAGES);
    expect(frontendWhitelistConsts.WHITELIST_PERMISSION_KEYS).toEqual(serverWhitelistConsts.WHITELIST_PERMISSION_KEYS);
    expect(frontendMemoryConsts.VERBATIM_CONTEXT_MAX).toBe(serverMemoryConsts.VERBATIM_CONTEXT_MAX);
    expect(frontendTimeConsts.MINUTE_MS).toBe(serverTimeConsts.MINUTE_MS);
  });

  test("前端复制的正则与服务端同名正则的模式和标志一致", () => {
    const pairs: readonly (readonly [RegExp, RegExp])[] = [
      [frontendMiniAppConsts.MINI_APP_SHA256_HEX_PATTERN, serverMiniAppConsts.MINI_APP_SHA256_HEX_PATTERN],
      [frontendMiniAppConsts.MINI_APP_BIDI_CONTROL_CHARS_PATTERN, serverMiniAppConsts.MINI_APP_BIDI_CONTROL_CHARS_PATTERN],
    ];
    for (const [frontend, server] of pairs) {
      expect(frontend.source).toBe(server.source);
      expect(frontend.flags).toBe(server.flags);
    }
  });

  test("服务端单页上限等于前端每页档位的最大档，前端缺省页大小落在档位内", () => {
    const tables: readonly (readonly [readonly number[], number, number])[] = [
      [
        frontendMiniAppConsts.MINI_APP_GALLERY_PAGE_SIZE_OPTIONS,
        serverMiniAppConsts.MINI_APP_GALLERY_MAX_PAGE_SIZE,
        frontendMiniAppConsts.MINI_APP_GALLERY_DEFAULT_PAGE_SIZE,
      ],
      [
        frontendMiniAppConsts.MINI_APP_MESSAGES_PAGE_SIZE_OPTIONS,
        serverMiniAppConsts.MINI_APP_MESSAGES_MAX_PAGE_SIZE,
        frontendMiniAppConsts.MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE,
      ],
      [
        frontendMiniAppConsts.MINI_APP_IDENTITY_PAGE_SIZE_OPTIONS,
        serverMiniAppConsts.MINI_APP_IDENTITY_MAX_PAGE_SIZE,
        frontendMiniAppConsts.MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE,
      ],
    ];
    for (const [options, serverMax, frontendDefault] of tables) {
      expect(Math.max(...options)).toBe(serverMax);
      expect(options).toContain(frontendDefault);
    }
  });

  test("前端打包引用的 favicon 与服务端 `/favicon.ico` 路由返回的文件逐字节一致", async () => {
    const frontendIcon: Uint8Array = await Bun.file(
      new URL("../../packages/mini-app-frontend/resource/favicon.ico", import.meta.url)
    ).bytes();
    const serverIcon: Uint8Array = await Bun.file(MINI_APP_FAVICON_PATH).bytes();
    expect(frontendIcon).toEqual(serverIcon);
  });

  test("前端入口 index.html 内联首屏语言初始化脚本的 SHA-256 哈希与服务端 CSP 头一致", async () => {
    const htmlText: string = await Bun.file(
      new URL("../../packages/mini-app-frontend/index.html", import.meta.url)
    ).text();
    const inlineScriptMatch: RegExpMatchArray | null = htmlText.match(/<script>([\s\S]*?)<\/script>/u);
    expect(inlineScriptMatch).not.toBeNull();
    const scriptBody: string = inlineScriptMatch?.[1] ?? "";
    const scriptSha256Base64: string = new Bun.CryptoHasher("sha256")
      .update(scriptBody, "utf8")
      .digest("base64");
    expect(serverMiniAppConsts.MINI_APP_CSP_HEADER_VALUE).toContain(
      `'sha256-${scriptSha256Base64}'`
    );
  });

  test("前后端各自的图库下载文件名构造对同一输入给出相同结果", () => {
    const nowMs: number = 1_792_934_567_890;
    const fileNames: readonly string[] = [
      `${"a".repeat(64)}.PNG`,
      `${"b".repeat(64)}.webp`,
      "no-extension",
      "multi.part.name.JPEG",
    ];
    for (const fileName of fileNames) {
      expect(buildFrontendDownloadFileName(fileName, nowMs)).toBe(buildServerDownloadFileName(fileName, nowMs));
    }
    expect(buildFrontendDownloadFileName("c.png", -1)).toBe(buildServerDownloadFileName("c.png", -1));
  });

  test("前后端各自的异常文案归一化对同一输入给出相同结果", () => {
    const inputs: readonly unknown[] = [new Error("boom"), new TypeError("type"), "text", 42, null, undefined, { reason: "x" }];
    for (const input of inputs) {
      expect(frontendErrorMessage(input)).toBe(serverErrorMessage(input));
    }
  });
});

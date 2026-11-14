/**
 * `packages/mini-app-frontend/` 不得依赖目录外的文件，与服务端重合的常量、类型、函数、favicon 及
 * 未授权独立拒绝页 `reject.html` 的样式和三语文案各自维护副本。本文件逐项核对这些副本与服务端定义
 * （含 `index.html` 与 `reject.html` 内联脚本 SHA-256 与服务端 CSP 头）一致，
 * 任何一侧改动而另一侧未同步时失败：类型在编译期按 TypeScript 恒等关系核对（含 readonly 与可选修饰），
 * 常量、函数与文件在运行期核对。
 */

import { describe, expect, test } from "bun:test";
import * as serverMemoryConsts from "../../packages/consts/aiChat/memory";
import * as serverDeleteMessageConsts from "../../packages/consts/deleteMessage";
import { WHITELIST_PERMISSION_HELP as teasingWhitelistPermissionHelp } from "../../packages/consts/atmosphere/teasing/whitelist";
import * as serverMiniAppConsts from "../../packages/consts/miniApp";
import { MINI_APP_FAVICON_PATH, MINI_APP_REJECT_HTML_PATH } from "../../packages/consts/paths";
import * as serverQaConsts from "../../packages/consts/qa";
import * as serverTextConsts from "../../packages/consts/text";
import * as serverTimeConsts from "../../packages/consts/time";
import * as serverTranslateConsts from "../../packages/consts/translate";
import * as serverWhitelistConsts from "../../packages/consts/whitelist";
import { errorMessage as serverErrorMessage } from "../../packages/libs/errorMessage";
import * as frontendMemoryConsts from "../../packages/mini-app-frontend/consts/memory";
import * as frontendMiniAppConsts from "../../packages/mini-app-frontend/consts/miniApp";
import * as frontendTimeConsts from "../../packages/mini-app-frontend/consts/time";
import * as frontendWhitelistConsts from "../../packages/mini-app-frontend/consts/whitelist";
import { getEnTranslations } from "../../packages/mini-app-frontend/i18n/languages/en";
import { getJaTranslations } from "../../packages/mini-app-frontend/i18n/languages/ja";
import { getZhTranslations } from "../../packages/mini-app-frontend/i18n/languages/zh";
import { errorMessage as frontendErrorMessage } from "../../packages/mini-app-frontend/libs/errorMessage";
import { buildMiniAppGalleryDownloadFileName as buildFrontendDownloadFileName } from "../../packages/mini-app-frontend/libs/formatters";
import type * as FrontendIdentityPolicy from "../../packages/mini-app-frontend/types/identityPolicy";
import type * as FrontendMiniApp from "../../packages/mini-app-frontend/types/miniApp";
import type { MiniAppTranslations } from "../../packages/mini-app-frontend/types/miniAppI18n";
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
  MiniAppAuthPrecheckResponse: true satisfies Exact<FrontendMiniApp.MiniAppAuthPrecheckResponse, ServerMiniApp.MiniAppAuthPrecheckResponse>,
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
  MiniAppBatchKickCompletion: true satisfies Exact<FrontendMiniApp.MiniAppBatchKickCompletion, ServerMiniApp.MiniAppBatchKickCompletion>,
  MiniAppChatDetail: true satisfies Exact<FrontendMiniApp.MiniAppChatDetail, ServerMiniApp.MiniAppChatDetail>,
  MiniAppFeatureToggleResult: true satisfies Exact<FrontendMiniApp.MiniAppFeatureToggleResult, ServerMiniApp.MiniAppFeatureToggleResult>,
  MiniAppBatchKickOutcome: true satisfies Exact<FrontendMiniApp.MiniAppBatchKickOutcome, ServerMiniApp.MiniAppBatchKickOutcome>,
  MiniAppBatchKickResult: true satisfies Exact<FrontendMiniApp.MiniAppBatchKickResult, ServerMiniApp.MiniAppBatchKickResult>,
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
    expect(frontendMiniAppConsts.MINI_APP_TMA_AUTH_PREFIX).toBe(serverMiniAppConsts.MINI_APP_TMA_AUTH_PREFIX);
    expect(frontendMiniAppConsts.MINI_APP_GALLERY_DEFAULT_PAGE_SIZE).toBe(serverMiniAppConsts.MINI_APP_GALLERY_DEFAULT_PAGE_SIZE);
    expect(frontendMiniAppConsts.MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE).toBe(serverMiniAppConsts.MINI_APP_MESSAGES_DEFAULT_PAGE_SIZE);
    expect(frontendMiniAppConsts.MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE).toBe(serverMiniAppConsts.MINI_APP_IDENTITY_DEFAULT_PAGE_SIZE);
    expect(frontendMiniAppConsts.MINI_APP_BATCH_KICK_MIN_HOURS).toBe(serverMiniAppConsts.MINI_APP_BATCH_KICK_MIN_HOURS);
    expect(frontendMiniAppConsts.MINI_APP_BATCH_KICK_MAX_HOURS).toBe(serverMiniAppConsts.MINI_APP_BATCH_KICK_MAX_HOURS);
    expect(frontendMiniAppConsts.MINI_APP_FEATURE_KEYS).toEqual(serverMiniAppConsts.MINI_APP_FEATURE_KEYS);
    expect(frontendMiniAppConsts.MINI_APP_TRANSLATE_LANGUAGES).toEqual(serverMiniAppConsts.MINI_APP_TRANSLATE_LANGUAGES);
    expect(frontendMiniAppConsts.CHAT_QA_MAX_PER_CHAT).toBe(serverQaConsts.CHAT_QA_MAX_PER_CHAT);
    expect(frontendMiniAppConsts.CHAT_QA_QUESTION_MAX_CHARS).toBe(serverQaConsts.CHAT_QA_QUESTION_MAX_CHARS);
    expect(frontendMiniAppConsts.CHAT_QA_ANSWER_MAX_CHARS).toBe(serverQaConsts.CHAT_QA_ANSWER_MAX_CHARS);
    expect(frontendMiniAppConsts.DELETE_MESSAGE_CHAT_TARGET_MAX).toBe(serverDeleteMessageConsts.DELETE_MESSAGE_CHAT_TARGET_MAX);
    expect(frontendMiniAppConsts.TRANSLATE_CHAT_USER_LIMIT).toBe(serverTranslateConsts.TRANSLATE_CHAT_USER_LIMIT);
    expect(frontendWhitelistConsts.WHITELIST_PERMISSION_KEYS).toEqual(serverWhitelistConsts.WHITELIST_PERMISSION_KEYS);
    expect(getZhTranslations().permissionDrawer.descriptions).toEqual(teasingWhitelistPermissionHelp);
    for (const key of frontendWhitelistConsts.WHITELIST_PERMISSION_KEYS) {
      expect(getEnTranslations().permissionDrawer.descriptions[key].trim().length).toBeGreaterThan(0);
      expect(getJaTranslations().permissionDrawer.descriptions[key].trim().length).toBeGreaterThan(0);
    }
    expect(frontendMemoryConsts.VERBATIM_CONTEXT_MAX).toBe(serverMemoryConsts.VERBATIM_CONTEXT_MAX);
    expect(frontendTimeConsts.MINUTE_MS).toBe(serverTimeConsts.MINUTE_MS);
  });

  test("前端复制的正则与服务端对应正则的模式和标志一致", () => {
    const pairs: readonly (readonly [RegExp, RegExp])[] = [
      [frontendMiniAppConsts.MINI_APP_SHA256_HEX_PATTERN, serverMiniAppConsts.MINI_APP_SHA256_HEX_PATTERN],
      [frontendMiniAppConsts.MINI_APP_SIGNED_INTEGER_PATTERN, serverMiniAppConsts.MINI_APP_SIGNED_INTEGER_PATTERN],
      [frontendMiniAppConsts.MINI_APP_BIDI_CONTROL_CHARS_PATTERN, serverTextConsts.BIDI_CONTROL_PATTERN],
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
    const scriptSha256Base64: string = Bun.SHA256.hash(scriptBody, "base64");
    expect(serverMiniAppConsts.MINI_APP_CSP_HEADER_VALUE).toContain(
      `'sha256-${scriptSha256Base64}'`
    );
  });

  test("未授权拒绝页 reject.html 唯一内联脚本的 SHA-256 哈希与服务端 CSP 头一致", async () => {
    const rejectHtml: string = await Bun.file(MINI_APP_REJECT_HTML_PATH).text();
    const allInlineScripts: RegExpMatchArray[] = Array.from(
      rejectHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gu)
    );
    expect(allInlineScripts.length).toBe(1);
    const inlineScriptMatch: RegExpMatchArray | null = rejectHtml.match(/<script>([\s\S]*?)<\/script>/u);
    expect(inlineScriptMatch).not.toBeNull();
    const scriptBody: string = inlineScriptMatch?.[1] ?? "";
    const scriptSha256Base64: string = Bun.SHA256.hash(scriptBody, "base64");
    expect(serverMiniAppConsts.MINI_APP_CSP_HEADER_VALUE).toContain(
      `'sha256-${scriptSha256Base64}'`
    );
  });

  test("未授权拒绝页 reject.html 不包含主包入口引用，且样式令牌、反斜切规则与三语文案同前端一致", async () => {
    const rejectHtml: string = await Bun.file(MINI_APP_REJECT_HTML_PATH).text();
    expect(rejectHtml).not.toContain("./chunk-");
    expect(rejectHtml).not.toContain("./main.tsx");
    expect(rejectHtml).not.toContain("id=\"root\"");
    expect(rejectHtml).not.toContain("innerHTML");
    expect(rejectHtml).toContain("href=\"./favicon.ico\"");
    expect(rejectHtml).not.toMatch(/<script\b[^>]*\bsrc=/iu);
    expect(rejectHtml).not.toContain("telegram-web-app.js");
    expect(rejectHtml).toContain("<div class=\"cf-error-page\" id=\"cf-error-page\" hidden>");

    const styleMatch: RegExpMatchArray | null = rejectHtml.match(/<style>([\s\S]*?)<\/style>/u);
    expect(styleMatch).not.toBeNull();
    const rejectStyleBody: string = styleMatch?.[1] ?? "";
    expect(rejectStyleBody).toContain(".cf-error-page[hidden]");

    const baseCss: string = await Bun.file(
      new URL("../../packages/mini-app-frontend/styles/base.css", import.meta.url)
    ).text();
    const baseTokensStart: number = baseCss.indexOf(":root,");
    const baseTokensEnd: number = baseCss.indexOf("* {");
    expect(baseTokensStart).toBeGreaterThanOrEqual(0);
    expect(baseTokensEnd).toBeGreaterThan(baseTokensStart);
    const baseTokensBlock: string = baseCss.slice(baseTokensStart, baseTokensEnd).trim();
    expect(rejectStyleBody).toContain(baseTokensBlock);

    const authCss: string = await Bun.file(
      new URL("../../packages/mini-app-frontend/styles/auth.css", import.meta.url)
    ).text();
    const cfStart: number = authCss.indexOf(".cf-error-page {");
    const cfEnd: number = authCss.indexOf(".auth-gate-wrap {");
    expect(cfStart).toBeGreaterThanOrEqual(0);
    expect(cfEnd).toBeGreaterThan(cfStart);
    const cfAuthBlock: string = authCss.slice(cfStart, cfEnd).trim();
    expect(rejectStyleBody).toContain(cfAuthBlock);

    for (const cfCounterPattern of [
      /(?:^|\n)\.cf-title-row\s*\{([^}]*)\}/u,
      /(?:^|\n)\.cf-subtitle\s*\{([^}]*)\}/u,
      /(?:^|\n)\.cf-timestamp\s*\{([^}]*)\}/u,
      /(?:^|\n)\.cf-node-content\s*\{([^}]*)\}/u,
      /\.cf-detail-col\s*>\s*h2\s*\{([^}]*)\}/u,
      /\.cf-detail-col\s*>\s*p\s*\{([^}]*)\}/u,
      /(?:^|\n)\.cf-reason-content\s*\{([^}]*)\}/u,
      /\.cf-footer\s*>\s*span\s*\{([^}]*)\}/u,
    ]) {
      expect(cfCounterPattern.exec(rejectStyleBody)?.[1] ?? "").toContain("skewX(calc(var(--cf-card-skew) * -1))");
    }

    const localeCases: readonly (readonly [string, string, Readonly<MiniAppTranslations>])[] = [
      ["zh-CN", "zh-CN", getZhTranslations()],
      ["ja-JP", "ja", getJaTranslations()],
      ["en-US", "en-US", getEnTranslations()],
      ["fr-FR", "zh-CN", getZhTranslations()],
    ];
    for (const [, , dict] of localeCases) {
      expect(rejectHtml).toContain(dict.appTitle);
      expect(rejectHtml).toContain(dict.gate.deniedTitle);
      expect(rejectHtml).toContain(dict.gate.deniedDescription);
      expect(rejectHtml).toContain(dict.gate.deniedNodeClientSub);
      expect(rejectHtml).toContain(dict.gate.deniedNodeClientTitle);
      expect(rejectHtml).toContain(dict.gate.deniedNodeClientState);
      expect(rejectHtml).toContain(dict.gate.deniedNodeGatewaySub);
      expect(rejectHtml).toContain(dict.gate.deniedNodeGatewayTitle);
      expect(rejectHtml).toContain(dict.gate.deniedNodeOriginSub);
      expect(rejectHtml).toContain(dict.gate.deniedNodeOriginState);
      expect(rejectHtml).toContain(dict.gate.deniedWhatHappenedTitle);
      expect(rejectHtml).toContain(dict.gate.deniedWhatHappenedDesc);
      expect(rejectHtml).toContain(dict.gate.deniedWhatCanIDoTitle);
      expect(rejectHtml).toContain(dict.gate.deniedWhatCanIDoDesc);
      expect(rejectHtml).toContain(dict.serverNotice("FORBIDDEN_USER"));
      expect(rejectHtml).toContain(dict.serverNotice("DIRECT_NAVIGATION_FORBIDDEN"));
    }

    const scriptBody: string = rejectHtml.match(/<script>([\s\S]*?)<\/script>/u)?.[1] ?? "";
    const runner: (env: Record<string, unknown>) => Promise<void> | undefined = new Function(
      "env",
      `const { window, document, navigator, location, fetch } = env;\nreturn ${scriptBody.trim()}`
    ) as (env: Record<string, unknown>) => Promise<void> | undefined;

    const denyCodes: readonly (readonly [string, number, number | undefined])[] = [
      ["MISSING_INIT_DATA", 401, undefined],
      ["MALFORMED_INIT_DATA", 401, undefined],
      ["MISSING_HASH", 401, undefined],
      ["MISSING_USER", 401, undefined],
      ["INVALID_SIGNATURE", 401, undefined],
      ["EXPIRED_AUTH_DATE", 401, undefined],
      ["FORBIDDEN_USER", 403, undefined],
      ["CROSS_SITE_FORBIDDEN", 403, undefined],
      ["DIRECT_NAVIGATION_FORBIDDEN", 403, undefined],
      ["PASSWORD_REQUIRED", 401, undefined],
      ["SESSION_EXPIRED", 401, undefined],
      ["PASSWORD_LOCKED", 403, 29],
      ["PASSWORD_LOCKED", 403, undefined],
      ["ACCESS_DENIED", 403, undefined],
      ["constructor", 403, undefined],
    ];

    interface MockDomNode {
      textContent: string;
      hidden: boolean;
      removeAttribute: (attr: string) => void;
    }

    for (const [browserLocale, expectedHtmlLang, dict] of localeCases) {
      for (const [code, status, remainingMinutes] of denyCodes) {
        const nodes: Map<string, MockDomNode> = new Map<string, MockDomNode>();
        const getOrCreate = (id: string): MockDomNode => {
          const existing: MockDomNode | undefined = nodes.get(id);
          if (existing !== undefined) return existing;
          const created: MockDomNode = {
            textContent: "",
            hidden: id === "cf-error-page",
            removeAttribute: (attr: string): void => {
              if (attr === "hidden") created.hidden = false;
            },
          };
          nodes.set(id, created);
          return created;
        };
        let themeParamsAccessed: boolean = false;
        let fetchCalls: number = 0;
        const removedKeys: string[] = [];
        const webAppMock: Record<string, unknown> = {
          initData: "",
          ready: (): void => {},
          expand: (): void => {},
          setHeaderColor: (): void => {},
          setBackgroundColor: (): void => {},
        };
        Object.defineProperty(webAppMock, "themeParams", {
          get: (): Record<string, string> => {
            themeParamsAccessed = true;
            return {};
          },
        });
        const docElement: { lang: string } = { lang: "en-US" };
        const dataset: Record<string, string> = {
          status: String(status),
          code,
          error: dict.gate.deniedDescription,
          requestId: "req-parity-01",
          timestamp: "2026-11-13 02:30:00 UTC",
          clientIp: "198.51.100.7",
          host: "console.example.test",
          path: "/",
          ...(remainingMinutes !== undefined ? { remainingMinutes: String(remainingMinutes) } : {}),
        };
        const mockDoc: Record<string, unknown> = {
          readyState: "complete",
          title: "Zaako Console♡",
          documentElement: docElement,
          body: { dataset },
          getElementById: (id: string): unknown => getOrCreate(id),
        };
        const mockLoc: Record<string, unknown> = {
          search: "",
          hash: "",
          host: "console.example.test",
          pathname: "/",
          reload: (): void => {},
        };
        const storageMock: Record<string, unknown> = {
          getItem: (): null => null,
          setItem: (): void => {},
          removeItem: (key: string): void => { removedKeys.push(key); },
        };
        const mockWin: Record<string, unknown> = {
          Telegram: { WebApp: webAppMock },
          localStorage: storageMock,
          sessionStorage: storageMock,
          location: mockLoc,
        };
        await runner({
          window: mockWin,
          document: mockDoc,
          navigator: { languages: [browserLocale], language: browserLocale },
          location: mockLoc,
          fetch: async (): Promise<Response> => {
            fetchCalls += 1;
            return new Response(null, { status: 500 });
          },
        });
        expect(fetchCalls).toBe(0);
        expect(themeParamsAccessed).toBeFalse();
        expect(removedKeys.length).toBe(2);
        expect(docElement.lang).toBe(expectedHtmlLang);
        expect(mockDoc.title).toBe(dict.appTitle);
        expect(getOrCreate("cf-error-page").hidden).toBeFalse();
        expect(getOrCreate("cf-denied-title").textContent).toBe(dict.gate.deniedTitle);
        expect(getOrCreate("cf-code-pill-text").textContent).toBe(`HTTP ${status} · ${code}`);
        expect(getOrCreate("cf-node-gateway-state").textContent).toBe(dict.gate.deniedNodeGatewayState(status));
        expect(getOrCreate("cf-policy-label").textContent).toBe(`${dict.gate.deniedPolicyDetailLabel(code)}:`);
        expect(getOrCreate("cf-policy-reason").textContent).toBe(
          dict.gate.deniedPolicyReason(code, dict.gate.deniedDescription, {
            ...(remainingMinutes !== undefined ? { remainingMinutes } : {}),
          })
        );
      }
    }

    interface RejectInitDataRunResult {
      readonly reloaded: boolean;
      readonly savedGuardTs: string | null;
      readonly storedSessionAfter: string | null;
      readonly pageHidden: boolean;
      readonly pillText: string;
      readonly reasonText: string;
    }

    interface RunRejectWithInitDataOptions {
      readonly search?: string;
      readonly hash?: string;
      readonly telegramInitParamsRaw?: string | null;
      readonly reloadGuardTs: string | null;
      readonly storedSessionRaw: string | null;
      readonly fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
    }

    const validSessionToken: string = "a".repeat(64);
    const rotatedSessionToken: string = "b".repeat(64);
    const runWithInitData = async (
      options: Readonly<RunRejectWithInitDataOptions>
    ): Promise<RejectInitDataRunResult> => {
      const nodes: Map<string, MockDomNode> = new Map<string, MockDomNode>();
      const getNode = (id: string): MockDomNode => {
        const existing: MockDomNode | undefined = nodes.get(id);
        if (existing !== undefined) return existing;
        const created: MockDomNode = {
          textContent: "",
          hidden: id === "cf-error-page",
          removeAttribute: (attr: string): void => {
            if (attr === "hidden") created.hidden = false;
          },
        };
        nodes.set(id, created);
        return created;
      };
      let reloaded: boolean = false;
      let savedGuardTs: string | null = options.reloadGuardTs;
      const localStore: Map<string, string> = new Map<string, string>();
      const sessionStore: Map<string, string> = new Map<string, string>();
      if (options.reloadGuardTs !== null) {
        sessionStore.set("copy_ninja_mini_app_gate_reload_ts", options.reloadGuardTs);
      }
      if (options.telegramInitParamsRaw !== undefined && options.telegramInitParamsRaw !== null) {
        sessionStore.set("__telegram__initParams", options.telegramInitParamsRaw);
      }
      if (options.storedSessionRaw !== null) {
        localStore.set(frontendMiniAppConsts.MINI_APP_SESSION_STORAGE_KEY, options.storedSessionRaw);
        sessionStore.set(frontendMiniAppConsts.MINI_APP_SESSION_STORAGE_KEY, options.storedSessionRaw);
      }
      const localStorageMock: Record<string, unknown> = {
        getItem: (key: string): string | null => localStore.get(key) ?? null,
        setItem: (key: string, val: string): void => { localStore.set(key, val); },
        removeItem: (key: string): void => { localStore.delete(key); },
      };
      const sessionStorageMock: Record<string, unknown> = {
        getItem: (key: string): string | null => sessionStore.get(key) ?? null,
        setItem: (key: string, val: string): void => {
          sessionStore.set(key, val);
          if (key === "copy_ninja_mini_app_gate_reload_ts") savedGuardTs = val;
        },
        removeItem: (key: string): void => { sessionStore.delete(key); },
      };
      const mockLoc: Record<string, unknown> = {
        search: options.search ?? "",
        hash: options.hash ?? "",
        host: "console.example.test",
        pathname: "/",
        reload: (): void => { reloaded = true; },
      };
      const mockDoc: Record<string, unknown> = {
        readyState: "complete",
        title: "Zaako Console♡",
        documentElement: { lang: "en-US" },
        body: {
          dataset: {
            status: "401",
            code: "MISSING_INIT_DATA",
            error: "MISSING_INIT_DATA",
            requestId: "req-server-init",
            timestamp: "2026-11-13 02:30:00 UTC",
            clientIp: "198.51.100.8",
            host: "console.example.test",
            path: "/",
          },
        },
        getElementById: (id: string): unknown => getNode(id),
      };
      await runner({
        window: {
          Telegram: { WebApp: { initData: "" } },
          localStorage: localStorageMock,
          sessionStorage: sessionStorageMock,
          location: mockLoc,
        },
        document: mockDoc,
        navigator: { languages: ["zh-CN"], language: "zh-CN" },
        location: mockLoc,
        fetch: options.fetchImpl,
      });
      return {
        reloaded,
        savedGuardTs,
        storedSessionAfter:
          localStore.get(frontendMiniAppConsts.MINI_APP_SESSION_STORAGE_KEY) ?? null,
        pageHidden: getNode("cf-error-page").hidden,
        pillText: getNode("cf-code-pill-text").textContent,
        reasonText: getNode("cf-policy-reason").textContent,
      };
    };

    let capturedHeaders: Record<string, string> = {};
    const rotatedExpiresAt: number = Date.now() + 2_600_000;
    const okRun: RejectInitDataRunResult = await runWithInitData({
      hash: "#tgWebAppData=user%3D1%26hash%3Dabc",
      reloadGuardTs: null,
      storedSessionRaw: JSON.stringify({
        token: validSessionToken,
        expiresAt: Date.now() + frontendTimeConsts.MINUTE_MS,
      }),
      fetchImpl: async (_url: string, init: RequestInit): Promise<Response> => {
        capturedHeaders = (init.headers as Record<string, string> | undefined) ?? {};
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            [frontendMiniAppConsts.MINI_APP_SESSION_HEADER]: rotatedSessionToken,
            [frontendMiniAppConsts.MINI_APP_SESSION_EXPIRES_AT_HEADER]: String(rotatedExpiresAt),
          },
        });
      },
    });
    expect(okRun.reloaded).toBeTrue();
    expect(okRun.pageHidden).toBeTrue();
    expect(okRun.savedGuardTs).not.toBeNull();
    expect(capturedHeaders["X-Telegram-Init-Data"]).toBe("user=1&hash=abc");
    expect(capturedHeaders["X-Mini-App-Session"]).toBe(validSessionToken);
    expect(JSON.parse(okRun.storedSessionAfter ?? "{}")).toEqual({
      token: rotatedSessionToken,
      expiresAt: rotatedExpiresAt,
    });

    let queryCapturedHeaders: Record<string, string> = {};
    const queryOkRun: RejectInitDataRunResult = await runWithInitData({
      search: "?tgWebAppData=user%3D7%26hash%3Dqry",
      reloadGuardTs: null,
      storedSessionRaw: null,
      fetchImpl: async (_url: string, init: RequestInit): Promise<Response> => {
        queryCapturedHeaders = (init.headers as Record<string, string> | undefined) ?? {};
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(queryOkRun.reloaded).toBeTrue();
    expect(queryCapturedHeaders["X-Telegram-Init-Data"]).toBe("user=7&hash=qry");
    expect(queryCapturedHeaders["X-Mini-App-Session"]).toBeUndefined();

    let sessionParamsHeaders: Record<string, string> = {};
    const sessionParamsOkRun: RejectInitDataRunResult = await runWithInitData({
      telegramInitParamsRaw: JSON.stringify({ tgWebAppData: "user=9&hash=cached" }),
      reloadGuardTs: null,
      storedSessionRaw: validSessionToken,
      fetchImpl: async (_url: string, init: RequestInit): Promise<Response> => {
        sessionParamsHeaders = (init.headers as Record<string, string> | undefined) ?? {};
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    expect(sessionParamsOkRun.reloaded).toBeTrue();
    expect(sessionParamsHeaders["X-Telegram-Init-Data"]).toBe("user=9&hash=cached");
    expect(sessionParamsHeaders["X-Mini-App-Session"]).toBeUndefined();
    expect(sessionParamsOkRun.storedSessionAfter).toBeNull();

    const loopGuardedRun: RejectInitDataRunResult = await runWithInitData({
      hash: "#tgWebAppData=user%3D1%26hash%3Dabc",
      reloadGuardTs: String(Date.now()),
      storedSessionRaw: null,
      fetchImpl: async (): Promise<Response> =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    expect(loopGuardedRun.reloaded).toBeFalse();
    expect(loopGuardedRun.pageHidden).toBeFalse();
    expect(loopGuardedRun.pillText).toBe("HTTP 403 · ACCESS_DENIED");

    const zhDict: Readonly<MiniAppTranslations> = getZhTranslations();
    const forbiddenRun: RejectInitDataRunResult = await runWithInitData({
      hash: "#tgWebAppData=user%3D2%26hash%3Ddef",
      reloadGuardTs: null,
      storedSessionRaw: JSON.stringify({ token: validSessionToken, expiresAt: Date.now() + 60_000 }),
      fetchImpl: async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            status: 403,
            code: "FORBIDDEN_USER",
            error: "FORBIDDEN_USER",
            requestId: "req-precheck-403",
            timestamp: "2026-11-13 02:31:00 UTC",
            clientIp: "198.51.100.9",
            host: "console.example.test",
            path: "/api/auth/precheck",
          }),
          { status: 403 }
        ),
    });
    expect(forbiddenRun.reloaded).toBeFalse();
    expect(forbiddenRun.pageHidden).toBeFalse();
    expect(forbiddenRun.pillText).toBe("HTTP 403 · FORBIDDEN_USER");
    expect(forbiddenRun.reasonText).toBe(zhDict.serverNotice("FORBIDDEN_USER"));

    const netErrRun: RejectInitDataRunResult = await runWithInitData({
      hash: "#tgWebAppData=user%3D1%26hash%3Dabc",
      reloadGuardTs: null,
      storedSessionRaw: null,
      fetchImpl: async (): Promise<Response> => {
        throw new Error("network down");
      },
    });
    expect(netErrRun.reloaded).toBeFalse();
    expect(netErrRun.pageHidden).toBeFalse();
    expect(netErrRun.pillText).toBe("HTTP 401 · MISSING_INIT_DATA");
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

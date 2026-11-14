/**
 * Mini App 前端全局灰度字体抗锯齿、按钮主层驻留与零 `transform` 悬停过渡、弹窗/折叠面板常驻合成层、
 * 问答编辑壳层语言浮层堆叠上下文及切角控件禁用态级联特异性门禁核验。
 */

import { describe, expect, test } from "bun:test";
import {
  MINI_APP_INLINE_NOTICE_GRID_CLASS_NAME,
  MINI_APP_INLINE_NOTICE_INNER_CLASS_NAME,
} from "../../packages/mini-app-frontend/consts/animation";

/** 单条平铺 CSS 规则块的选择器与声明体切片。 */
interface CssFlatRule {
  /** 去除注释与多余空白后的选择器文本。 */
  readonly selector: string;
  /** 花括号内的声明体原文。 */
  readonly body: string;
}

/** 允许在 `transition` 中声明 `transform` 的空间位移动画选择器匹配模式。 */
const ALLOWED_TRANSFORM_TRANSITION_SELECTOR_PATTERN: RegExp =
  /(?:\.chevron-icon\b|\.slider:before\b|\.sidebar-drawer\b|\.gallery-thumb\b)/u;

/**
 * 提取匹配指定选择器头部的单条 CSS 规则声明体。
 */
function extractRuleBody(css: string, selectorPattern: RegExp): string {
  const match: RegExpExecArray | null = selectorPattern.exec(css);
  return match?.[1] ?? "";
}

/**
 * 剥离块注释后提取样式表内全部最内层 `selector { body }` 规则切片。
 */
function extractFlatRules(css: string): readonly Readonly<CssFlatRule>[] {
  const stripped: string = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const rules: CssFlatRule[] = [];
  const pattern: RegExp = /([^{}]+)\{([^{}]*)\}/gu;
  let match: RegExpExecArray | null = pattern.exec(stripped);
  while (match !== null) {
    const rawSelector: string | undefined = match[1];
    const body: string | undefined = match[2];
    if (rawSelector !== undefined && body !== undefined) {
      rules.push({
        selector: rawSelector.trim().replace(/\s+/gu, " "),
        body,
      });
    }
    match = pattern.exec(stripped);
  }
  return rules;
}

describe("Mini App 按钮悬停稳定性与弹窗字体渲染一致性", () => {
  test("全局灰度抗锯齿、按钮主层静态驻留、弹窗与折叠抽屉合成层常驻及级联特异性符合约定", async (): Promise<void> => {
    const baseCss: string = await Bun.file("packages/mini-app-frontend/styles/base.css").text();
    const primitivesCss: string = await Bun.file("packages/mini-app-frontend/styles/primitives.css").text();
    const shellCss: string = await Bun.file("packages/mini-app-frontend/styles/shell.css").text();
    const overlaysCss: string = await Bun.file("packages/mini-app-frontend/styles/overlays.css").text();
    const paginationCss: string = await Bun.file("packages/mini-app-frontend/styles/pagination.css").text();
    const authCss: string = await Bun.file("packages/mini-app-frontend/styles/auth.css").text();
    const chatsCss: string = await Bun.file("packages/mini-app-frontend/styles/chats.css").text();
    const chatsDetailCss: string = await Bun.file("packages/mini-app-frontend/styles/chats-detail.css").text();
    const chatsTargetsCss: string = await Bun.file("packages/mini-app-frontend/styles/chats-targets.css").text();
    const identitiesCss: string = await Bun.file("packages/mini-app-frontend/styles/identities.css").text();
    const statusCss: string = await Bun.file("packages/mini-app-frontend/styles/status.css").text();
    const galleryCss: string = await Bun.file("packages/mini-app-frontend/styles/gallery.css").text();
    const skeletonsCss: string = await Bun.file("packages/mini-app-frontend/styles/skeletons.css").text();

    // 1. 全局 `body` 统一启用灰度抗锯齿，且位于 `* {` 之后（处于 `reject.html` 内联头部镜像区间之外）。
    const bodyRuleBody: string = extractRuleBody(baseCss, /(?:^|\n)body\s*\{([^}]*)\}/u);
    expect(bodyRuleBody).toContain("-webkit-font-smoothing: antialiased;");
    expect(bodyRuleBody).toContain("-moz-osx-font-smoothing: grayscale;");
    expect(baseCss.slice(0, baseCss.indexOf("* {"))).not.toContain("-webkit-font-smoothing");

    // 2. 全量样式表 `transition` 边界门禁：禁止过渡 `filter`，禁止伪元素过渡颜色，仅空间位移动画允许过渡 `transform`。
    const allStylesheets: readonly (readonly [string, string])[] = [
      ["base.css", baseCss],
      ["primitives.css", primitivesCss],
      ["shell.css", shellCss],
      ["overlays.css", overlaysCss],
      ["pagination.css", paginationCss],
      ["auth.css", authCss],
      ["chats.css", chatsCss],
      ["chats-detail.css", chatsDetailCss],
      ["chats-targets.css", chatsTargetsCss],
      ["identities.css", identitiesCss],
      ["status.css", statusCss],
      ["gallery.css", galleryCss],
      ["skeletons.css", skeletonsCss],
    ];
    for (const [name, css] of allStylesheets) {
      const rules: readonly Readonly<CssFlatRule>[] = extractFlatRules(css);
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) {
        const transitionMatch: RegExpExecArray | null =
          /(?<![\w-])transition\s*:\s*([^;}]+);/u.exec(rule.body);
        if (transitionMatch === null) continue;
        const transitionValue: string = (transitionMatch[1] ?? "").trim();
        expect(`${name} [${rule.selector}] -> ${transitionValue}`).not.toMatch(/\bfilter\b/u);
        if (/\btransform\b/u.test(transitionValue)) {
          expect(`${name} [${rule.selector}]`).toMatch(
            ALLOWED_TRANSFORM_TRANSITION_SELECTOR_PATTERN
          );
        }
        if (rule.selector.includes("::before") || rule.selector.includes("::after")) {
          expect(`${name} [${rule.selector}] -> ${transitionValue}`).toBe(
            `${name} [${rule.selector}] -> none`
          );
        }
      }
    }

    // 开关轨道裁剪内部滑块 `.slider:before` 的水平位移动画并留驻父绘制层。
    const sliderBody: string = extractRuleBody(primitivesCss, /(?:^|\n)\.slider\s*\{([^}]*)\}/u);
    expect(sliderBody).toContain("overflow: hidden;");
    expect(sliderBody).toContain("will-change: auto;");
    expect(sliderBody).toContain("backface-visibility: visible;");
    expect(sliderBody).not.toContain("translate3d(");

    // 3. 核心与壳层样式表的悬停媒体查询统一限定 `@media (hover: hover) and (pointer: fine)`。
    for (const [name, css] of [
      ["primitives.css", primitivesCss],
      ["shell.css", shellCss],
      ["overlays.css", overlaysCss],
      ["pagination.css", paginationCss],
    ] as const) {
      expect(`${name} media`).not.toMatch(/@media\s*\(\s*hover\s*:\s*hover\s*\)\s*\{/u);
      expect(css).toContain("@media (hover: hover) and (pointer: fine)");
    }

    // 4. 全部斜切按钮、正交圆角按钮与独立菜单/输入交互项统一留驻父级主绘制层，使用 2D 微位移且无 3D 合成提升。
    const mainLayerControlRules: readonly (readonly [string, string, RegExp])[] = [
      ["primitives.css .subtab-btn", primitivesCss, /(?:^|\n)\.subtab-btn\s*\{([^}]*)\}/u],
      ["primitives.css .btn,.icon-btn", primitivesCss, /(?:^|\n)\.btn,\s*\.icon-btn\s*\{([^}]*)\}/u],
      ["primitives.css .btn.primary,.btn.danger", primitivesCss, /\.btn\.primary,\s*\.btn\.danger\s*\{([^}]*)\}/u],
      ["status.css .btn.mood-switch-btn", statusCss, /\.btn\.mood-switch-btn\s*\{([^}]*)\}/u],
      [
        "gallery.css .gallery-upload-btn",
        galleryCss,
        /\.gallery-upload-btn,\s*\.btn\.primary\.icon-btn\.gallery-upload-btn\s*\{([^}]*)\}/u,
      ],
      [
        "auth.css .auth-gate-submit",
        authCss,
        /\.auth-gate-submit,\s*\.btn\.primary\.auth-gate-submit\s*\{([^}]*)\}/u,
      ],
      ["auth.css .auth-gate-input", authCss, /(?:^|\n)\.auth-gate-input\s*\{([^}]*)\}/u],
      ["shell.css .lang-menu-item", shellCss, /(?:^|\n)\.lang-menu-item\s*\{([^}]*)\}/u],
      ["shell.css .sidebar-nav-item", shellCss, /(?:^|\n)\.sidebar-nav-item\s*\{([^}]*)\}/u],
      ["overlays.css .toast-close", overlaysCss, /(?:^|\n)\.toast-close\s*\{([^}]*)\}/u],
      ["chats-detail.css .chat-targets-menu-item", chatsDetailCss, /(?:^|\n)\.chat-targets-menu-item\s*\{([^}]*)\}/u],
      ["chats-targets.css .chat-targets-lang-option", chatsTargetsCss, /(?:^|\n)\.chat-targets-lang-option\s*\{([^}]*)\}/u],
      ["identities.css .search-clear-btn", identitiesCss, /(?:^|\n)\.search-clear-btn\s*\{([^}]*)\}/u],
    ];
    for (const [label, css, pattern] of mainLayerControlRules) {
      const body: string = extractRuleBody(css, pattern);
      expect(`${label}: ${body}`).toContain("will-change: auto;");
      expect(`${label}: ${body}`).toContain("backface-visibility: visible;");
      expect(`${label}: ${body}`).toContain("-webkit-font-smoothing: antialiased;");
      expect(`${label}: ${body}`).toContain("-moz-osx-font-smoothing: grayscale;");
      expect(`${label}: ${body}`).not.toContain("translate3d(");
    }

    // `.subtab-btn` 将省略号裁剪下沉到反斜切文本 `> span`，按钮本体与门控提交按钮常态不设 `overflow: hidden`。
    const subtabBtnBody: string = extractRuleBody(primitivesCss, /(?:^|\n)\.subtab-btn\s*\{([^}]*)\}/u);
    expect(subtabBtnBody).not.toContain("overflow: hidden");
    const subtabSpanEllipsisBody: string = extractRuleBody(
      primitivesCss,
      /(?:^|\n)\.subtab-btn\s*>\s*span:not\(\.loading-dots-wave\)\s*\{([^}]*)\}/u
    );
    expect(subtabSpanEllipsisBody).toContain("overflow: hidden;");
    expect(subtabSpanEllipsisBody).toContain("text-overflow: ellipsis;");
    expect(
      extractRuleBody(authCss, /\.auth-gate-submit,\s*\.btn\.primary\.auth-gate-submit\s*\{([^}]*)\}/u)
    ).not.toContain("overflow: hidden");
    expect(extractRuleBody(authCss, /(?:^|\n)\.totp-start-submit\s*\{([^}]*)\}/u)).not.toContain("overflow: hidden");
    expect(extractRuleBody(authCss, /(?:^|\n)\.totp-verify-submit\s*\{([^}]*)\}/u)).not.toContain("overflow: hidden");
    expect(
      extractRuleBody(authCss, /\.auth-gate-submit\.is-loading,[\s\S]*?\.totp-verify-submit\.is-loading:disabled\s*\{([^}]*)\}/u)
    ).toContain("overflow: hidden;");

    // 5. 异形多边形切角 + `drop-shadow` 按钮组留驻主层局部堆叠上下文，仅过渡文字颜色且使用 2D `translate(0, 0)`。
    const cutCornerRules: readonly (readonly [string, string, RegExp])[] = [
      [
        "primitives.css .subtabs-bar > .btn.icon-btn",
        primitivesCss,
        /\.subtabs-bar\s*>\s*\.btn\.icon-btn\s*\{([^}]*)\}/u,
      ],
      [
        "shell.css topbar chamfer buttons",
        shellCss,
        /\.sidebar-toggle-btn,\s*\.lang-menu-btn,\s*\.btn\.lang-menu-btn,\s*\.theme-toggle-btn,\s*\.btn\.theme-toggle-btn\s*\{([^}]*)\}/u,
      ],
      ["overlays.css .confirm-actions .btn", overlaysCss, /\.confirm-actions\s+\.btn\s*\{([^}]*)\}/u],
      ["pagination.css .page-size-pill", paginationCss, /(?:^|\n)\.page-size-pill\s*\{([^}]*)\}/u],
      ["pagination.css .page-btn", paginationCss, /(?:^|\n)\.page-btn\s*\{([^}]*)\}/u],
      [
        "chats.css cut-corner buttons",
        chatsCss,
        /\.join-clean-step-btn,[\s\S]*?\.btn\.chat-targets-qa-action-btn:not\(\.danger\)\s*\{([^}]*)\}/u,
      ],
      [
        "identities.css cut-corner buttons",
        identitiesCss,
        /\.btn\.primary\.add-fold-trigger,[\s\S]*?\.identity-row-actions\s+\.btn:not\(\.icon-btn\)\s*\{([^}]*)\}/u,
      ],
      [
        "gallery.css floating cut-corner buttons",
        galleryCss,
        /\.gallery-card-download-btn,\s*\.gallery-card-delete-btn\s*\{([^}]*)\}/u,
      ],
    ];
    for (const [label, css, pattern] of cutCornerRules) {
      const body: string = extractRuleBody(css, pattern);
      expect(`${label}: ${body}`).toContain("isolation: isolate;");
      expect(`${label}: ${body}`).toContain("will-change: auto;");
      expect(`${label}: ${body}`).toContain("backface-visibility: visible;");
      expect(`${label}: ${body}`).toContain("transform: translate(0, 0);");
      expect(`${label}: ${body}`).toContain("filter: drop-shadow(");
      const transitionVal: string = /transition\s*:\s*([^;]+);/u.exec(body)?.[1] ?? "";
      expect(`${label} transition: ${transitionVal}`).toBe(
        `${label} transition: color var(--press-duration) var(--ease-brutal)`
      );
    }

    expect(extractRuleBody(paginationCss, /(?:^|\n)\.page-size-pill\s*\{([^}]*)\}/u)).toContain(
      "filter: drop-shadow(0 0 0 transparent);"
    );
    expect(extractRuleBody(paginationCss, /(?:^|\n)\.page-size-pill\.active\s*\{([^}]*)\}/u)).toContain(
      "filter: drop-shadow(2px 2px 0 var(--btn-shadow-color));"
    );

    // 6. 弹窗遮罩叶子伪元素隔离与弹窗/浮层/折叠抽屉常驻合成层门禁。
    const confirmBackdropBody: string = extractRuleBody(overlaysCss, /(?:^|\n)\.confirm-backdrop\s*\{([^}]*)\}/u);
    expect(confirmBackdropBody).toContain("background: transparent;");
    expect(confirmBackdropBody).not.toContain("animation:");
    const confirmBackdropBeforeBody: string = extractRuleBody(
      overlaysCss,
      /(?:^|\n)\.confirm-backdrop::before\s*\{([^}]*)\}/u
    );
    expect(confirmBackdropBeforeBody).toContain("background: var(--backdrop);");
    expect(confirmBackdropBeforeBody).toContain("will-change: opacity;");
    expect(confirmBackdropBeforeBody).toContain("animation: miniapp-backdrop-fade-in");
    expect(
      extractRuleBody(chatsTargetsCss, /(?:^|\n)\.confirm-backdrop\.chat-targets-backdrop\s*\{([^}]*)\}/u)
    ).not.toContain("animation:");

    const popupLayerRules: readonly (readonly [string, string, RegExp])[] = [
      ["overlays.css .toast.show", overlaysCss, /(?:^|\n)\.toast\.show\s*\{([^}]*)\}/u],
      ["overlays.css .confirm-dialog", overlaysCss, /(?:^|\n)\.confirm-dialog\s*\{([^}]*)\}/u],
      ["shell.css .lang-menu-popover", shellCss, /(?:^|\n)\.lang-menu-popover\s*\{([^}]*)\}/u],
      ["chats-detail.css .chat-targets-menu-popover", chatsDetailCss, /(?:^|\n)\.chat-targets-menu-popover\s*\{([^}]*)\}/u],
      ["chats-targets.css .chat-targets-modal", chatsTargetsCss, /(?:^|\n)\.chat-targets-modal\s*\{([^}]*)\}/u],
      ["chats-targets.css .chat-targets-lang-popover", chatsTargetsCss, /(?:^|\n)\.chat-targets-lang-popover\s*\{([^}]*)\}/u],
      [
        "chats-targets.css .chat-targets-tab-content slide",
        chatsTargetsCss,
        /\.chat-targets-tab-pane\.tab-slide-forward\s*>\s*\.chat-targets-tab-content,\s*\.chat-targets-tab-pane\.tab-slide-backward\s*>\s*\.chat-targets-tab-content\s*\{([^}]*)\}/u,
      ],
    ];
    for (const [label, css, pattern] of popupLayerRules) {
      const body: string = extractRuleBody(css, pattern);
      expect(`${label}: ${body}`).toContain("will-change: transform, opacity;");
      expect(`${label}: ${body}`).toContain("transform: translate3d(0, 0, 0);");
      expect(`${label}: ${body}`).toContain("backface-visibility: hidden;");
    }
    expect(extractRuleBody(overlaysCss, /(?:^|\n)\.toast\.closing\s*\{([^}]*)\}/u)).toContain(
      "will-change: transform, opacity;"
    );

    const collapseInnerLayerRules: readonly (readonly [string, string, RegExp])[] = [
      [
        "primitives.css inline-notice",
        primitivesCss,
        new RegExp(
          `\\.${MINI_APP_INLINE_NOTICE_GRID_CLASS_NAME}\\.expanded\\s*>\\s*\\.${MINI_APP_INLINE_NOTICE_INNER_CLASS_NAME},[\\s\\S]*?\\.${MINI_APP_INLINE_NOTICE_INNER_CLASS_NAME}\\s*\\{([^}]*)\\}`,
          "u"
        ),
      ],
      [
        "identities.css fold/perm drawers",
        identitiesCss,
        /\.add-fold-collapse-grid\.expanded\s*>\s*\.add-fold-collapse-inner,[\s\S]*?\.perm-drawer-collapse-inner\s*\{([^}]*)\}/u,
      ],
      [
        "status.css cap-collapse-inner",
        statusCss,
        /\.cap-collapse-wrap\.expanded\s*>\s*\.cap-collapse-inner,[\s\S]*?\.cap-collapse-inner\s*\{([^}]*)\}/u,
      ],
      [
        "chats.css bot-perm-collapse-inner",
        chatsCss,
        /\.bot-perm-collapse-grid\.expanded\s*>\s*\.bot-perm-collapse-inner,[\s\S]*?\.bot-perm-collapse-inner\s*\{([^}]*)\}/u,
      ],
      [
        "chats-targets.css qa-collapse-inner",
        chatsTargetsCss,
        /\.chat-targets-qa-trigger-collapse:not\(\.collapsed\)\s*>\s*\.chat-targets-qa-collapse-inner,[\s\S]*?\.chat-targets-qa-collapse-inner\s*\{([^}]*)\}/u,
      ],
      [
        "auth.css totp-collapse-inner",
        authCss,
        /\.totp-trigger-collapse-grid:not\(\.collapsed\)\s*>\s*\.totp-collapse-inner,[\s\S]*?\.totp-collapse-inner\s*\{([^}]*)\}/u,
      ],
      [
        "gallery.css gallery-preview-collapse-inner",
        galleryCss,
        /\.gallery-preview-collapse-grid\.expanded\s*>\s*\.gallery-preview-collapse-inner,[\s\S]*?\.gallery-preview-collapse-inner\s*\{([^}]*)\}/u,
      ],
    ];
    for (const [label, css, pattern] of collapseInnerLayerRules) {
      const body: string = extractRuleBody(css, pattern);
      expect(`${label}: ${body}`).toContain("will-change: transform");
      expect(`${label}: ${body}`).toContain("transform: translate3d(0, 0, 0);");
      expect(`${label}: ${body}`).toContain("backface-visibility: hidden;");
    }

    // 7. 级联特异性与 `:hover`/`:active` 并发命中权重门禁。
    const prefsHoverBody: string = extractRuleBody(
      shellCss,
      /\.lang-menu-btn:hover:not\(:disabled\):not\(\.is-disabled\):not\(\.active\),[\s\S]*?\.btn\.theme-toggle-btn:hover:not\(:disabled\):not\(\.is-disabled\)\s*\{([^}]*)\}/u
    );
    expect(prefsHoverBody).toContain("transform: translate(-1px, -1px);");
    expect(prefsHoverBody).toContain("background: transparent;");
    expect(prefsHoverBody).toContain("box-shadow: none;");

    const langActiveHoverBody: string = extractRuleBody(
      shellCss,
      /\.lang-menu-btn\.active,\s*\.btn\.lang-menu-btn\.active,\s*\.btn\.icon-btn\.lang-menu-btn\.active:hover:not\(:disabled\):not\(\.is-disabled\)\s*\{([^}]*)\}/u
    );
    expect(langActiveHoverBody).toContain("transform: translate(2px, 2px);");
    expect(langActiveHoverBody).toContain("background: transparent;");
    expect(langActiveHoverBody).toContain("box-shadow: none;");

    const confirmPrimaryHoverBody: string = extractRuleBody(
      overlaysCss,
      /\.confirm-actions\s+\.btn\.primary:hover:not\(:disabled\):not\(\.is-disabled\)\s*\{([^}]*)\}/u
    );
    expect(confirmPrimaryHoverBody).toContain("transform: translate(-1px, -1px);");
    expect(confirmPrimaryHoverBody).toContain("background: transparent;");
    expect(confirmPrimaryHoverBody).toContain("box-shadow: none;");

    const confirmDangerHoverBody: string = extractRuleBody(
      overlaysCss,
      /\.confirm-actions\s+\.btn\.danger:hover:not\(:disabled\):not\(\.is-disabled\)\s*\{([^}]*)\}/u
    );
    expect(confirmDangerHoverBody).toContain("transform: translate(-1px, -1px);");
    expect(confirmDangerHoverBody).toContain("background: transparent;");
    expect(confirmDangerHoverBody).toContain("box-shadow: none;");

    const activeParitySelectors: readonly (readonly [string, string])[] = [
      [shellCss, ".sidebar-toggle-btn:active:not(:disabled):not(.active)"],
      [shellCss, '[data-theme="dark"] .sidebar-toggle-btn:active:not(:disabled):not(.active)'],
      [shellCss, ".btn.lang-menu-btn:active:not(:disabled):not(.is-disabled):not(.active)"],
      [shellCss, '[data-theme="dark"] .btn.lang-menu-btn:active:not(:disabled):not(.is-disabled):not(.active)'],
      [shellCss, '[data-theme="dark"] .btn.theme-toggle-btn:active:not(:disabled):not(.is-disabled)'],
      [shellCss, ".lang-menu-item:active:not(:disabled):not(.active)"],
      [shellCss, ".sidebar-nav-item:active:not(:disabled):not(.active)"],
      [primitivesCss, ".subtab-btn:active:not(.active)"],
      [primitivesCss, '[data-theme="dark"] .subtabs-bar > .btn.icon-btn:active:not(:disabled):not(.is-disabled)'],
      [paginationCss, ".page-size-pill:active:not(:disabled):not(.active)"],
      [paginationCss, ".page-btn:active:not(:disabled):not(.active)"],
      [paginationCss, '[data-theme="dark"] .page-btn:active:not(:disabled):not(.active)'],
      [overlaysCss, '[data-theme="dark"] .confirm-actions .btn.primary:active:not(:disabled):not(.is-disabled)'],
      [overlaysCss, '[data-theme="dark"] .confirm-actions .btn.danger:active:not(:disabled):not(.is-disabled)'],
      [chatsCss, ".join-clean-preset-btn:active:not(:disabled):not(.active)"],
      [chatsCss, '[data-theme="dark"] .join-clean-preset-btn:active:not(:disabled):not(.active)'],
      [chatsCss, '[data-theme="dark"] .btn.primary.chat-targets-qa-open-btn:active:not(:disabled):not(.is-disabled)'],
      [chatsCss, '[data-theme="dark"] .btn.chat-targets-qa-action-btn:not(.danger):active:not(:disabled):not(.is-disabled)'],
      [chatsTargetsCss, ".chat-targets-tab:active:not(.active)"],
      [identitiesCss, '[data-theme="dark"] .btn.primary.add-fold-trigger:active:not(:disabled):not(.is-disabled)'],
      [chatsTargetsCss, ".chat-targets-lang-option:active:not(:disabled)"],
    ];
    for (const [css, selector] of activeParitySelectors) {
      expect(css).toContain(selector);
    }

    // 8. 问答编辑壳层语言下拉局部堆叠上下文与切角控件暗色/`.active`/`.open` 禁用态门禁。
    const qaEditorLangShellBody: string = extractRuleBody(
      chatsTargetsCss,
      /\.chat-targets-qa-editor-shell:has\(\.chat-targets-lang-popover\)\s*\{([^}]*)\}/u
    );
    expect(qaEditorLangShellBody).toContain("position: relative;");
    expect(qaEditorLangShellBody).toContain("z-index: 5;");

    const langOptionBody: string = extractRuleBody(
      chatsTargetsCss,
      /(?:^|\n)\.chat-targets-lang-option\s*\{([^}]*)\}/u
    );
    expect(langOptionBody).toContain("box-shadow var(--press-duration) var(--ease-brutal)");

    const disabledGuardedShadowSelectors: readonly (readonly [string, string])[] = [
      [overlaysCss, '[data-theme="dark"] .confirm-actions .btn.primary:not(:disabled):not(.is-disabled)'],
      [overlaysCss, '[data-theme="dark"] .confirm-actions .btn.danger:not(:disabled):not(.is-disabled)'],
      [overlaysCss, ".confirm-actions .btn.is-disabled"],
      [identitiesCss, '[data-theme="dark"] .btn.primary.add-fold-trigger:not(:disabled):not(.is-disabled)'],
      [identitiesCss, '[data-theme="dark"] .id-add-inline-row .btn.primary:not(:disabled):not(.is-disabled)'],
      [identitiesCss, '[data-theme="dark"] .identity-row-actions .btn.primary:not(.icon-btn):not(:disabled):not(.is-disabled)'],
      [identitiesCss, ".btn.primary.add-fold-trigger.open:not(:disabled):not(.is-disabled)"],
      [identitiesCss, '[data-theme="dark"] .add-mode-card.active:not(:disabled)'],
      [chatsCss, ".join-clean-preset-btn.active:not(:disabled)"],
      [chatsCss, '[data-theme="dark"] .join-clean-preset-btn.active:not(:disabled)'],
      [chatsTargetsCss, '[data-theme="dark"] .btn.primary.chat-targets-qa-open-btn:not(:disabled):not(.is-disabled)'],
      [paginationCss, '[data-theme="dark"] .page-size-pill.active:not(:disabled)'],
    ];
    for (const [css, selector] of disabledGuardedShadowSelectors) {
      expect(css).toContain(selector);
    }
  });
});

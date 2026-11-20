/**
 * Mini App 部署配置校验模块（`view/configs/validate.ts`）UTF-8 字节上限边界与 `TextEncoder` 口径等价性测试。
 */

import { describe, expect, test } from "bun:test";
import { MINI_APP_MAX_CONFIG_CONTENT_BYTES } from "../../packages/consts/miniAppConfig";
import {
  MINI_APP_CONFIG_VALIDATION_FAILED_CODE,
  MINI_APP_INVALID_JSON_SYNTAX_CODE,
} from "../../packages/consts/miniAppCrypto";
import {
  resolveMiniAppConfigTarget,
  validateMiniAppConfigContent,
} from "../../packages/mini-app-api-server/view/configs/validate";
import type {
  MiniAppConfigContentValidationResult,
  ResolvedMiniAppConfigTarget,
} from "../../packages/mini-app-api-server/view/configs/validate";

describe("validateMiniAppConfigContent UTF-8 字节上限", () => {
  test("含多字节汉字、代理对与孤立代理的边界文本与 TextEncoder 字节口径逐字节一致", async (): Promise<void> => {
    const target: Readonly<ResolvedMiniAppConfigTarget> | null =
      resolveMiniAppConfigTarget("dynamic", "mood.json");
    expect(target).not.toBeNull();

    const encoder: TextEncoder = new TextEncoder();
    const mixedChunk: string = "杂鱼😀\uD800";
    const chunkBytes: number = encoder.encode(mixedChunk).byteLength;
    expect(chunkBytes).toBe(13);

    const exactRepeat: number = Math.floor(MINI_APP_MAX_CONFIG_CONTENT_BYTES / chunkBytes);
    const remainderBytes: number = MINI_APP_MAX_CONFIG_CONTENT_BYTES - exactRepeat * chunkBytes;
    const atLimitRaw: string = mixedChunk.repeat(exactRepeat) + "a".repeat(remainderBytes);
    expect(encoder.encode(atLimitRaw).byteLength).toBe(MINI_APP_MAX_CONFIG_CONTENT_BYTES);

    // 恰等于上限时通过字节长度检查，进入后续 JSON 语法校验并报语法错而非超限错。
    const atLimitResult: Readonly<MiniAppConfigContentValidationResult> =
      await validateMiniAppConfigContent(target!, atLimitRaw);
    expect(atLimitResult.ok).toBeFalse();
    if (!atLimitResult.ok) {
      expect(atLimitResult.code).toBe(MINI_APP_INVALID_JSON_SYNTAX_CODE);
    }

    const overLimitRaw: string = `${atLimitRaw}x`;
    expect(encoder.encode(overLimitRaw).byteLength).toBe(MINI_APP_MAX_CONFIG_CONTENT_BYTES + 1);
    const overLimitResult: Readonly<MiniAppConfigContentValidationResult> =
      await validateMiniAppConfigContent(target!, overLimitRaw);
    expect(overLimitResult.ok).toBeFalse();
    if (!overLimitResult.ok) {
      expect(overLimitResult.code).toBe(MINI_APP_CONFIG_VALIDATION_FAILED_CODE);
      expect(overLimitResult.error).toContain(`at most ${MINI_APP_MAX_CONFIG_CONTENT_BYTES} UTF-8 bytes`);
    }
  });
});

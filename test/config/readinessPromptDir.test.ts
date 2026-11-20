/**
 * 启动总闸对 `prompt/` 父目录状态的校验：`prompt/` 真正缺省时回落默认人设；
 * 若 `prompt/` 为悬空软链或普通文件则拒绝启动，而指向真实目录的软链按目录读取。
 */

import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_AI_PERSONA } from "../../packages/consts/aiChat/prompts/persona";
import { getTimeZone } from "../../packages/config/time";
import { InputValidationError } from "../../packages/libs/inputValidation";
import type { BotConfig } from "../../packages/types/config";
import { TEST_DATA_ROOT } from "../preloadEnv";

const testRoot: string = mkdtempSync(join(TEST_DATA_ROOT, "copy-ninjia-prompt-dir-"));
const promptDir: string = join(testRoot, "prompt");
const personaPath: string = join(promptDir, "persona.md");
const voiceToolPromptPath: string = join(promptDir, "voice_tool.md");
const realTargetDir: string = join(testRoot, "prompt-target");

afterAll((): void => {
  rmSync(testRoot, { recursive: true, force: true });
});

/** 测试夹具跳过的可选加载器。 */
async function noopLoader(): Promise<void> {}

mock.module("../../packages/consts/paths", () => ({
  GOOGLE_AUTH_FILE_PATH: join(testRoot, "absent-g-auth.json"),
  BOT_CONFIG_PATH: join(testRoot, "bot.json"),
  AGENT_CONFIG_PATH: join(testRoot, "absent-agent.json"),
  ASSETS_CONFIG_PATH: join(testRoot, "absent-assets.json"),
  STICKERS_CONFIG_PATH: join(testRoot, "absent-stickers.json"),
  MOOD_CONFIG_PATH: join(testRoot, "absent-mood.json"),
  AD_DETECT_CONFIG_PATH: join(testRoot, "absent-ad-detect.json"),
  CRON_CONFIG_PATH: join(testRoot, "absent-cron.json"),
  PERSONA_PATH: personaPath,
  VOICE_TOOL_PROMPT_PATH: voiceToolPromptPath,
}));
mock.module("../../packages/config/bot", () => ({
  getBotConfig: (): BotConfig => ({
    timeZone: getTimeZone(),
    atmosphere: "mesugaki",
    logLevel: "operation",
    botToken: "telegram-token",
    superAdminUserId: 1,
  }),
}));
mock.module("../../packages/config/stickers", () => ({ ensureStickerConfig: noopLoader }));
mock.module("../../packages/config/mood", () => ({ ensureMoodConfig: noopLoader }));
mock.module("../../packages/config/adDetectConfig", () => ({ ensureAdDetectConfig: noopLoader }));
mock.module("../../packages/config/agent", () => ({ validateAgentDeploymentConfig: noopLoader }));
mock.module("../../packages/config/assets", () => ({ ensureAssetConfig: noopLoader }));
mock.module("../../packages/config/cron", () => ({ ensureCronConfig: noopLoader }));
mock.module("../../packages/config/googleAuth", () => ({ validateGoogleServiceAccountKey: noopLoader }));

const { validateExistingDeploymentInputs } = await import("../../packages/config/readiness");
const { botAtmosphereState } = await import("../../packages/cache/main/atmosphere");
const {
  adDetectConfigReadinessCache,
  aiChatConfigReadinessCache,
  translateConfigReadinessCache,
} = await import("../../packages/cache/main/configReadiness");
const { personaCache, voiceToolPromptCache } = await import("../../packages/cache/perThread/config");

beforeEach((): void => {
  rmSync(promptDir, { recursive: true, force: true });
  rmSync(realTargetDir, { recursive: true, force: true });
  botAtmosphereState.current = null;
  personaCache.current = null;
  voiceToolPromptCache.current = null;
  aiChatConfigReadinessCache.current = null;
  adDetectConfigReadinessCache.current = null;
  translateConfigReadinessCache.current = null;
});

test("prompt 目录真正缺省时正常放行并接管内置默认人设", async () => {
  expect(dirname(personaPath)).toBe(promptDir);
  await validateExistingDeploymentInputs();
  expect(personaCache.current).toBe(DEFAULT_AI_PERSONA);
  expect(voiceToolPromptCache.current).toBeNull();
});

test("prompt 为悬空软链接时拒绝启动，不静默回落内置人设", async () => {
  symlinkSync(join(testRoot, "missing-prompt-dir"), promptDir);
  await expect(validateExistingDeploymentInputs()).rejects.toThrow(
    new InputValidationError(promptDir, "$", "an existing directory")
  );
  expect(personaCache.current).toBeNull();
});

test("prompt 为普通文件时拒绝启动并点名期望 existing directory", async () => {
  await Bun.write(promptDir, "not a directory");
  await expect(validateExistingDeploymentInputs()).rejects.toThrow(
    `${promptDir}: $ must be an existing directory.`
  );
  expect(personaCache.current).toBeNull();
});

test("prompt 为指向真实目录的软链接时正常读取自定义人设", async () => {
  mkdirSync(realTargetDir, { recursive: true });
  await Bun.write(join(realTargetDir, "persona.md"), "自定义软链目录人设");
  symlinkSync(realTargetDir, promptDir);
  await validateExistingDeploymentInputs();
  expect(personaCache.current).toBe("自定义软链目录人设");
  expect(voiceToolPromptCache.current).toBeNull();
});

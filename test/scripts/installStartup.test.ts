import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, symlinkSync } from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";
import {
  AGENT_CAPABILITY_NAMES,
  AGENT_CREDENTIAL_HEADER_NAMES,
  AGENT_HEADERS_MAX_ENTRIES,
} from "../../packages/consts/agent";
import { DYNAMIC_CONFIG_DIR_NAME, STATIC_CONFIG_DIR_NAME } from "../../packages/consts/configLayout";
import { Database } from "bun:sqlite";
import { openStorageDatabase } from "../../packages/database/interact/connection";
import { storageMetadataRows } from "../../packages/database/interact/initialization";
import { seedStorageDatabase } from "../../scripts/fixtures/storageDatabase";
import {
  cleanupFixtures,
  createFixture,
  runInstaller,
  systemdPrompt,
  writeText,
} from "../../scripts/installIsolation/fixture";
import type { InstallerFixture, InstallerRunResult, PromptReply } from "../../scripts/installIsolation/fixture";
import type { StorageDatabase } from "../../packages/types/storageDatabase";

afterEach(cleanupFixtures);

function firstInstallPrompts(ai: boolean): PromptReply[] {
  const prompts: PromptReply[] = [
    { prompt: "Telegram bot token", reply: "123456789:installation_test_token", secret: true },
    { prompt: "超级管理员用户 ID", reply: "123456789" },
    { prompt: "现在配置 AI 能力", reply: ai ? "y" : "n" },
  ];
  if (ai) {
    for (const capability of AGENT_CAPABILITY_NAMES) {
      const enabled: boolean = ["text", "summary", "media", "tts"].includes(capability);
      prompts.push({ prompt: `配置 ${capability}？`, reply: enabled ? "y" : "n" });
      if (capability === "tts") {
        // xai 语音协议：问 speech_protocol、不问 model，再问可留空的 base_url。
        prompts.push(
          { prompt: "tts 的 provider", reply: "openai" },
          { prompt: "tts 的 api_key", reply: "installation-test-api-key", secret: true },
          { prompt: "tts 的 speech_protocol", reply: "xai" },
          { prompt: "tts 的 base_url", reply: "" },
          { prompt: "tts 的 voice", reply: "ara" }
        );
      } else if (enabled) {
        prompts.push(
          { prompt: `${capability} 的 provider`, reply: "google" },
          { prompt: `${capability} 的 api_key`, reply: "installation-test-api-key", secret: true },
          { prompt: `${capability} 的 model`, reply: "installation-test-model" },
          { prompt: `${capability} 的 base_url`, reply: "" }
        );
      }
    }
  }
  prompts.push(systemdPrompt());
  return prompts;
}

async function assertInstalledStartup(fixture: InstallerFixture, output: string, ai: boolean): Promise<void> {
  expect(output).toContain("配置校验通过");
  expect(output).toContain("Bot started as @installation_test_bot");
  expect(output).toContain("INSTALL_API getUpdates");
  expect(output).toContain("Received SIGTERM; beginning graceful shutdown.");
  expect(output).not.toContain("Unhandled error");
  expect(output).not.toContain("Shutdown drain/flush results:");
  expect(output).not.toContain("INSTALL_NETWORK_BLOCKED");
  expect(output.match(/^INSTALL_WORKER_NETWORK_GUARD\r?$/gm)?.length).toBe(ai ? 3 : 2);
  if (ai) expect(output).toContain("INSTALL_WEATHER_MOCK");
  else expect(output).not.toContain("INSTALL_WEATHER_MOCK");
  expect(output).toContain(`INSTALL_WORKERS ${JSON.stringify(
    (ai ? ["aiChatWorker.ts", "antiRaidWorker.ts", "diskIOWorker.ts"] : ["antiRaidWorker.ts", "diskIOWorker.ts"])
  )}`);
  if (ai) {
    const agent: { readonly agent: Readonly<Record<string, Readonly<Record<string, unknown>>>> } =
      await Bun.file(join(fixture.configRoot, DYNAMIC_CONFIG_DIR_NAME, "agent.json")).json();
    expect(agent.agent.tts).toEqual({
      provider: "openai",
      api_key: "installation-test-api-key",
      speech_protocol: "xai",
      voice: "ara",
    });
    expect(output).not.toContain("tts 的 model");
  }
  expect(await Bun.file(join(fixture.runtimeRoot, "database/storage.sqlite")).exists()).toBe(true);
  // 全新部署没有需要持久化的全局状态，启动不写状态文件。
  expect(await Bun.file(join(fixture.runtimeRoot, "state.json")).exists()).toBe(false);
  expect(await Bun.file(join(fixture.runtimeRoot, "bot.lock")).exists()).toBe(false);
  expect(await Bun.file(join(fixture.worktree, "state.json")).exists()).toBe(false);
  expect(await Bun.file(fixture.outboundLog).text()).not.toContain(":blocked");
}

describe("install.sh 到真实应用启动", () => {
  test("重填 Bot 身份时保留外部配置链接、权限、普通语气与默认时区", async (): Promise<void> => {
    const fixture: InstallerFixture = await createFixture(true);
    mkdirSync(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME), { recursive: true });
    const external: string = join(fixture.root, "external-secrets");
    mkdirSync(external);
    const target: string = join(external, "telegram.json");
    const entry: string = join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json");
    await writeText(target, JSON.stringify({
      bot_token: "123456789:existing_test_token", super_admin_user_id: 123456789, atmosphere: "normal", time_zone: "UTC",
    }), 0o640);
    symlinkSync(target, entry);
    const original: Stats = await Bun.file(target).stat();
    const result: InstallerRunResult = await runInstaller(fixture, [
      { prompt: "是否重新填写？", reply: "y" },
      { prompt: "Telegram bot token", reply: "987654321:replacement_test_token", secret: true },
      { prompt: "超级管理员用户 ID", reply: "987654321" },
      { prompt: "现在配置 AI 能力", reply: "n", optional: true },
      systemdPrompt(),
    ]);
    expect(result.exitCode, result.output).toBe(0);
    await assertInstalledStartup(fixture, result.output, false);
    // 新库绑定 bot.json 的时区，真实启动按同一时区通过时区闸。
    const client: Database = new Database(join(fixture.runtimeRoot, "database/storage.sqlite"), { readonly: true });
    try {
      expect<readonly unknown[]>(client.query("SELECT key, json(data) AS data FROM storage_metadata ORDER BY key").all())
        .toEqual(storageMetadataRows("UTC"));
    } finally { client.close(true); }
    expect(lstatSync(entry).isSymbolicLink()).toBeTrue();
    expect(await Bun.file(target).json()).toEqual({
      bot_token: "987654321:replacement_test_token", super_admin_user_id: 987654321, atmosphere: "normal", time_zone: "UTC",
    });
    const replaced: Stats = await Bun.file(target).stat();
    expect(replaced.mode).toBe(original.mode);
    expect(replaced.uid).toBe(original.uid);
    expect(replaced.gid).toBe(original.gid);
  }, 30_000);

  test.each([false, true])("新安装、正常配置与重启（AI=%s）", async (ai: boolean): Promise<void> => {
    const fixture: InstallerFixture = await createFixture(true);
    const first: InstallerRunResult = await runInstaller(fixture, firstInstallPrompts(ai));
    expect(first.exitCode, first.output).toBe(0);
    await assertInstalledStartup(fixture, first.output, ai);

    const telegram: string = await Bun.file(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json")).text();
    const database: StorageDatabase = openStorageDatabase({ path: join(fixture.runtimeRoot, "database/storage.sqlite") });
    try {
      seedStorageDatabase(database, {
        metadata: [], whitelist: [], blocklist: [], removals: [],
        chatStates: [{ chatId: -1001, data: JSON.stringify({ isInitEnabled: true, isAIChatEnabled: ai }) }],
      });
    } finally { database.$client.close(true); }
    const prompts: PromptReply[] = [{ prompt: "是否重新填写？", reply: "n" }];
    if (!ai) prompts.push({ prompt: "现在配置 AI 能力", reply: "n" });
    prompts.push(systemdPrompt());
    const second: InstallerRunResult = await runInstaller(fixture, prompts);
    expect(second.exitCode, second.output).toBe(0);
    await assertInstalledStartup(fixture, second.output, ai);
    expect(second.output).toContain("Restored state for 1 chat(s).");
    expect(second.output).toContain("INSTALL_API getChat");
    expect(await Bun.file(join(fixture.configRoot, STATIC_CONFIG_DIR_NAME, "bot.json")).text()).toBe(telegram);
  }, 60_000);

  test("google 网关鉴权请求头与 anthropic 网关 BYOK 经问卷落盘且不回显秘密值，真实启动通过", async (): Promise<void> => {
    const fixture: InstallerFixture = await createFixture(true);
    const googleGatewayUrl: string = "https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio";
    const anthropicGatewayUrl: string = "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic";
    const gatewayHeaderValue: string = "Bearer cf-aig-secret-installation-token";
    const prompts: PromptReply[] = [
      { prompt: "Telegram bot token", reply: "123456789:installation_test_token", secret: true },
      { prompt: "超级管理员用户 ID", reply: "123456789" },
      { prompt: "现在配置 AI 能力", reply: "y" },
      { prompt: "配置 ad_detect？", reply: "n" },
      { prompt: "配置 text？", reply: "y" },
      { prompt: "text 的 provider", reply: "google" },
      { prompt: "text 的 api_key", reply: "installation-test-api-key", secret: true },
      { prompt: "text 的 model", reply: "gemini-3-flash-preview" },
      { prompt: "text 的 base_url", reply: googleGatewayUrl },
      { prompt: "为 text 添加附加请求头", reply: "y" },
      { prompt: "请求头名（直接回车结束）", reply: "cf-aig-authorization" },
      { prompt: "cf-aig-authorization 的值", reply: gatewayHeaderValue, secret: true },
      { prompt: "请求头名（直接回车结束）", reply: "" },
      { prompt: "配置 summary？", reply: "y" },
      { prompt: "summary 的 provider", reply: "anthropic" },
      { prompt: "summary 的 api_key", reply: "installation-test-cf-byok-token", secret: true },
      { prompt: "summary 的 model", reply: "claude-haiku-4-5" },
      { prompt: "summary 的 base_url", reply: anthropicGatewayUrl },
      { prompt: "为 summary 添加附加请求头", reply: "n" },
      { prompt: "配置 media？", reply: "y" },
      { prompt: "media 的 provider", reply: "google" },
      { prompt: "media 的 api_key", reply: "installation-test-api-key", secret: true },
      { prompt: "media 的 model", reply: "gemini-3-flash-preview" },
      { prompt: "media 的 base_url", reply: "" },
      { prompt: "配置 image？", reply: "n" },
      { prompt: "配置 tts？", reply: "y" },
      { prompt: "tts 的 provider", reply: "openai" },
      { prompt: "tts 的 api_key", reply: "installation-test-api-key", secret: true },
      { prompt: "tts 的 speech_protocol", reply: "xai" },
      { prompt: "tts 的 base_url", reply: "" },
      { prompt: "tts 的 voice", reply: "ara" },
      { prompt: "配置 web_search？", reply: "n" },
      systemdPrompt(),
    ];
    const result: InstallerRunResult = await runInstaller(fixture, prompts);
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).not.toContain(gatewayHeaderValue);
    expect(result.output).not.toContain("cf-aig-secret-installation-token");
    await assertInstalledStartup(fixture, result.output, true);
    const agent: { readonly agent: Readonly<Record<string, Readonly<Record<string, unknown>>>> } =
      await Bun.file(join(fixture.configRoot, DYNAMIC_CONFIG_DIR_NAME, "agent.json")).json();
    expect(agent.agent.text).toEqual({
      provider: "google",
      api_key: "installation-test-api-key",
      base_url: googleGatewayUrl,
      headers: { "cf-aig-authorization": gatewayHeaderValue },
      model: "gemini-3-flash-preview",
    });
    expect(agent.agent.summary).toEqual({
      provider: "anthropic",
      api_key: "installation-test-cf-byok-token",
      base_url: anthropicGatewayUrl,
      model: "claude-haiku-4-5",
    });
    expect(Object.hasOwn(agent.agent.summary ?? {}, "headers")).toBe(false);
  }, 30_000);

  test.each([
    [
      "凭据请求头名",
      [
        { prompt: "请求头名（直接回车结束）", reply: AGENT_CREDENTIAL_HEADER_NAMES.google },
        { prompt: `${AGENT_CREDENTIAL_HEADER_NAMES.google} 的值`, reply: "secret-credential-header-value", secret: true },
        { prompt: "请求头名（直接回车结束）", reply: "" },
      ],
    ],
    [
      "重复请求头名",
      [
        { prompt: "请求头名（直接回车结束）", reply: "cf-aig-authorization" },
        { prompt: "cf-aig-authorization 的值", reply: "secret-header-value-1", secret: true },
        { prompt: "请求头名（直接回车结束）", reply: "cf-aig-authorization" },
        { prompt: "cf-aig-authorization 的值", reply: "secret-header-value-2", secret: true },
        { prompt: "请求头名（直接回车结束）", reply: "" },
      ],
    ],
    [
      "超过条数上限",
      [
        ...Array.from({ length: AGENT_HEADERS_MAX_ENTRIES + 1 }, (_unused: unknown, index: number): readonly PromptReply[] => {
          const name: string = `x-custom-header-${index + 1}`;
          return [
            { prompt: "请求头名（直接回车结束）", reply: name },
            { prompt: `${name} 的值`, reply: `secret-header-value-${index + 1}`, secret: true },
          ];
        }).flat(),
        { prompt: "请求头名（直接回车结束）", reply: "" },
      ],
    ],
  ])("网关请求头非法（%s）时严格校验拒绝，不建立 agent.json 且不回显请求头值", async (
    _label: string,
    headerPrompts: readonly PromptReply[]
  ): Promise<void> => {
    const fixture: InstallerFixture = await createFixture();
    const prompts: PromptReply[] = [
      { prompt: "Telegram bot token", reply: "123456789:installation_test_token", secret: true },
      { prompt: "超级管理员用户 ID", reply: "123456789" },
      { prompt: "现在配置 AI 能力", reply: "y" },
      { prompt: "配置 ad_detect？", reply: "y" },
      { prompt: "ad_detect 的 provider", reply: "google" },
      { prompt: "ad_detect 的 api_key", reply: "installation-test-api-key", secret: true },
      { prompt: "ad_detect 的 model", reply: "gemini-3-flash-preview" },
      { prompt: "ad_detect 的 base_url", reply: "https://gateway.ai.cloudflare.com/v1/account/gateway/google-ai-studio" },
      { prompt: "为 ad_detect 添加附加请求头", reply: "y" },
      ...headerPrompts,
      { prompt: "配置 text？", reply: "n" },
      { prompt: "配置 summary？", reply: "n" },
      { prompt: "配置 media？", reply: "n" },
      { prompt: "配置 image？", reply: "n" },
      { prompt: "配置 tts？", reply: "n" },
      { prompt: "配置 web_search？", reply: "n" },
    ];
    const result: InstallerRunResult = await runInstaller(fixture, prompts);
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("$.agent.ad_detect.headers");
    expect(result.output).not.toContain("secret-credential-header-value");
    expect(result.output).not.toContain("secret-header-value-");
    expect(await Bun.file(join(fixture.configRoot, DYNAMIC_CONFIG_DIR_NAME, "agent.json")).exists()).toBe(false);
    expect(await Bun.file(fixture.callLog).text()).toContain("validate:agent\n");
  }, 30_000);

  test("存在但非法的可选配置在启动之前拒绝", async (): Promise<void> => {
    const fixture: InstallerFixture = await createFixture(true);
    await writeText(join(fixture.configRoot, DYNAMIC_CONFIG_DIR_NAME, "stickers.json"), "{}\n");
    const result: InstallerRunResult = await runInstaller(fixture, firstInstallPrompts(false));
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("stickers.json: $ must be");
    expect(result.output).not.toContain("INSTALL_API");
    expect(result.output).not.toContain("Bot started");
    expect(await Bun.file(join(fixture.runtimeRoot, "state.json")).exists()).toBe(false);
    expect(await Bun.file(join(fixture.configRoot, DYNAMIC_CONFIG_DIR_NAME, "stickers.json")).text()).toBe("{}\n");
  }, 30_000);
});

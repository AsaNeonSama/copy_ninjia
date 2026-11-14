import { afterEach, describe, expect, test } from "bun:test";
import { parseWebSearchCapability } from "../../packages/config/agentCapability";
import { parseAssetConfig } from "../../packages/config/assets";
import { parseBotConfig } from "../../packages/config/botInput";
import { parseAction } from "../../packages/config/cronAction";
import { parseConfigUrl } from "../../packages/config/urlPolicy";
import { botConfigCache } from "../../packages/cache/perThread/config";
import {
  AGENT_BASE_URL_POLICY,
  HTTP_OR_HTTPS_CONFIG_URL_POLICY,
  HTTPS_CONFIG_URL_POLICY,
} from "../../packages/consts/configUrl";
import { ASSET_ONLY_URL_GROUP, ASSET_PATH_OR_URL_GROUP } from "../../packages/consts/ui/assets";
import type { CronAction } from "../../packages/types/cron";
import type {
  AgentWebSearchCapabilityConfig,
  AssetConfig,
  BotConfig,
  ConfigUrlPolicy,
} from "../../packages/types/config";

interface UrlPolicyCase {
  readonly name: string;
  readonly policy: Readonly<ConfigUrlPolicy>;
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
}

const URL_POLICY_CASES: readonly UrlPolicyCase[] = [
  {
    name: "AGENT_BASE_URL_POLICY",
    policy: AGENT_BASE_URL_POLICY,
    accepted: [
      "https://api.example.com/v1",
      "https://example.com",
      "http://localhost:8080/v1",
      "http://127.0.0.1:11434",
      "http://[::1]:8000/api",
    ],
    rejected: [
      "http://api.example.com/v1",
      "https://user:pass@api.example.com/v1",
      "https://user@api.example.com/v1",
      "https://api.example.com/v1#frag",
      "ftp://api.example.com/v1",
      "/relative/path",
      "not a url",
    ],
  },
  {
    name: "HTTPS_CONFIG_URL_POLICY",
    policy: HTTPS_CONFIG_URL_POLICY,
    accepted: [
      "https://miniapp.example.com",
      "https://miniapp.example.com:8443/app",
      "https://user:pass@miniapp.example.com/app#sec",
    ],
    rejected: [
      "http://localhost:3000",
      "http://127.0.0.1:8080",
      "http://example.com/app",
      "ftp://example.com/app",
      "relative/path",
    ],
  },
  {
    name: "HTTP_OR_HTTPS_CONFIG_URL_POLICY",
    policy: HTTP_OR_HTTPS_CONFIG_URL_POLICY,
    accepted: [
      "https://example.com/a.jpg",
      "http://example.com/a.jpg",
      "http://localhost:8080/h.png",
      "https://user:pass@example.com/x#h",
    ],
    rejected: [
      "ftp://example.com/a.jpg",
      "javascript:alert(1)",
      "data:image/png;base64,abc",
      "/local/path",
    ],
  },
];

describe("parseConfigUrl 策略表", () => {
  for (const policyCase of URL_POLICY_CASES) {
    test(`${policyCase.name} 按策略接受合法 URL 并拒绝越界输入`, () => {
      for (const raw of policyCase.accepted) {
        const parsed: URL | null = parseConfigUrl(raw, policyCase.policy);
        expect(parsed).not.toBeNull();
      }
      for (const raw of policyCase.rejected) {
        expect(parseConfigUrl(raw, policyCase.policy)).toBeNull();
      }
    });
  }
});

describe("调用方 URL 形态保留语义", () => {
  afterEach((): void => {
    botConfigCache.current = null;
  });

  test("AI base_url 保留首尾去空白后的原串（不补尾斜杠），而 bot/assets/cron 返回标准化 href", () => {
    const capability: AgentWebSearchCapabilityConfig = parseWebSearchCapability(
      {
        provider: "openai",
        api_key: "key",
        base_url: "  https://api.example.com  ",
        model: "gpt-test",
      },
      "agent.json"
    );
    expect(capability.baseUrl).toBe("https://api.example.com");

    const botConfig: BotConfig = parseBotConfig({
      bot_token: "secret",
      super_admin_user_id: 7,
      mini_app: {
        url: "  https://miniapp.example.com  ",
        port: 3000,
        password: "s3cr3t-pass-123456",
      },
    });
    expect(botConfig.miniApp?.url).toBe("https://miniapp.example.com/");

    const assetConfig: AssetConfig = parseAssetConfig(
      {
        [ASSET_ONLY_URL_GROUP]: { fortune_thumbnail_url: "  https://cdn.example.com  " },
        [ASSET_PATH_OR_URL_GROUP]: { bot_default_avatar: "  http://assets.example.com  " },
      },
      "assets.json"
    );
    expect(assetConfig.fortuneThumbnailUrl).toBe("https://cdn.example.com/");
    expect(assetConfig.botDefaultAvatar).toEqual({
      kind: "url",
      url: "http://assets.example.com/",
    });

    const action: CronAction = parseAction(
      {
        type: "send_image",
        payload: { url: ["  http://cron.example.com  "] },
      },
      { source: "cron.json", path: "$.jobs[0].action" }
    );
    expect(action).toEqual({
      type: "send_image",
      content: undefined,
      isBlurred: false,
      source: { kind: "urls", urls: ["http://cron.example.com/"] },
    });
  });
});

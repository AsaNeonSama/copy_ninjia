/**
 * Mini App 部署配置管理（列表、读取、会话临时密钥直接加密保存、8 份动态/静态配置严格校验、
 * 动态配置写盘后由 `configReload` `fs.watch` 热重载、静态配置服务重启与审计脱敏）端到端测试。
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { lstatSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { rsaPrivateKeyPemFixture } from "../../scripts/fixtures/googleAuth";
import {
  buildSignedTestInitData,
  buildSuperAdminHeaders,
  installMiniAppTestDiskIOMock,
  resetMiniAppTestDiskIOState,
} from "../helpers/miniAppInitData";
import { waitUntil } from "../helpers/waitUntil";

installMiniAppTestDiskIOMock();

const { quiesceConfigReload, startConfigReload } = await import(
  "../../packages/app/configReload"
);
const { assetConfigCache } = await import("../../packages/cache/main/assets");
const {
  randomImageDirectoryCache,
  randomImageGalleryCache,
} = await import("../../packages/cache/main/hImage");
const { configReloadRuntime } = await import(
  "../../packages/cache/main/configReload"
);
const {
  adDetectConfigReadinessCache,
  aiChatConfigReadinessCache,
  translateConfigReadinessCache,
} = await import("../../packages/cache/main/configReadiness");
const { cronConfigCache } = await import("../../packages/cache/main/cron");
const {
  miniAppAuthSessions,
  miniAppServiceRestartRunnerHolder,
} = await import("../../packages/cache/main/miniApp");
const {
  adDetectAgentConfigCache,
  agentDeploymentConfigCache,
  defaultAdDetectConfigCache,
  defaultMoodConfigCache,
  defaultStickerConfigCache,
} = await import("../../packages/cache/perThread/config");
const { BOT_TOKEN, SUPER_ADMIN_USER_ID } = await import(
  "../../packages/config/bot"
);
const { validateExistingDeploymentInputs } = await import(
  "../../packages/config/readiness"
);
const {
  MINI_APP_INIT_DATA_HEADER,
  MINI_APP_SESSION_HEADER,
  MINI_APP_SESSION_REFRESH_MAX_MS,
} = await import("../../packages/consts/miniApp");
const {
  MINI_APP_CONFIG_VALIDATION_FAILED_CODE,
  MINI_APP_INVALID_CONFIG_TARGET_CODE,
  MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE,
  MINI_APP_INVALID_JSON_SYNTAX_CODE,
  MINI_APP_MAX_ENCRYPTED_JSON_BODY_BYTES,
  MINI_APP_SERVICE_RESTART_FAILED_CODE,
  MINI_APP_SESSION_KEY_HEADER,
} = await import("../../packages/consts/miniAppCrypto");
const {
  MINI_APP_DYNAMIC_CONFIG_FILES,
  MINI_APP_SERVICE_RESTART_COMMAND,
  MINI_APP_STATIC_CONFIG_FILES,
} = await import("../../packages/consts/miniAppConfig");
const {
  AGENT_CONFIG_PATH,
  ASSETS_CONFIG_PATH,
  BOT_CONFIG_PATH,
  CRON_CONFIG_PATH,
  GOOGLE_AUTH_FILE_PATH,
  IDENTITY_DATABASE_PATH,
  MOOD_CONFIG_PATH,
  RUNTIME_DATA_ROOT,
  STICKERS_CONFIG_PATH,
  AD_DETECT_CONFIG_PATH,
} = await import("../../packages/consts/paths");
const { ASSET_ONLY_PATH_GROUP } = await import("../../packages/consts/ui/assets");
const {
  adoptRandomImageDirectory,
  inspectRandomImageDirectory,
  storeRandomImage,
} = await import("../../packages/infra/imageGallery");
const { logger } = await import("../../packages/infra/logger");
const {
  issueMiniAppAuthSession,
  stopMiniAppServer,
} = await import("../../packages/mini-app-api-server");
const {
  buildMiniAppEnvelopeAad,
  decryptMiniAppText,
  encryptMiniAppEnvelope,
  importMiniAppAesGcmKey,
  parseMiniAppEncryptedEnvelope,
} = await import("../../packages/mini-app-api-server/libs/crypto");
const { unsealRotatedSessionKey } = await import(
  "../../packages/mini-app-frontend/libs/crypto"
);
const {
  dispatchMiniAppTestRequest,
  dispatchRawMiniAppTestRequest,
} = await import("../helpers/miniAppRequest");
import type { MiniAppAuthSession } from "../../packages/types/miniApp/auth";
import type {
  MiniAppConfigFileItem,
  MiniAppConfigFileResponse,
  MiniAppConfigListResponse,
  MiniAppConfigRestartResponse,
  MiniAppConfigSaveRequest,
  MiniAppConfigSaveResponse,
  MiniAppConfigScope,
  MiniAppEncryptedEnvelope,
} from "../../packages/types/miniApp/configs";

/** 全部受测部署配置文件路径清单（测试前后完整备份并恢复原状）。 */
const ALL_CONFIG_PATHS: readonly string[] = [
  AD_DETECT_CONFIG_PATH,
  AGENT_CONFIG_PATH,
  ASSETS_CONFIG_PATH,
  CRON_CONFIG_PATH,
  MOOD_CONFIG_PATH,
  STICKERS_CONFIG_PATH,
  BOT_CONFIG_PATH,
  GOOGLE_AUTH_FILE_PATH,
];

const rsaPemFixture: string = await rsaPrivateKeyPemFixture();

/** 每次测试前的磁盘文件与内存配置快照备份。 */
let fileBackups: Map<string, Uint8Array | null> = new Map<
  string,
  Uint8Array | null
>();
let hadIdentityDbBefore: boolean = false;
let savedMoodCache = defaultMoodConfigCache.current;
let savedStickerCache = defaultStickerConfigCache.current;
let savedAdDetectCache = defaultAdDetectConfigCache.current;
let savedAdDetectAgentCache = adDetectAgentConfigCache.current;
let savedAgentCache = agentDeploymentConfigCache.current;
let savedAssetCache = assetConfigCache.current;
let savedCronCache = cronConfigCache.current;
let savedAiReadiness = aiChatConfigReadinessCache.current;
let savedAdReadiness = adDetectConfigReadinessCache.current;
let savedTranslateReadiness = translateConfigReadinessCache.current;

/**
 * 为给定的测试会话构造超级管理员鉴权请求头。
 * @param session 活跃测试会话。
 * @returns 请求头字典。
 */
function headersForSession(
  session: Readonly<MiniAppAuthSession>
): Record<string, string> {
  return buildSuperAdminHeaders({
    botToken: BOT_TOKEN,
    superAdminUserId: SUPER_ADMIN_USER_ID,
    sessionToken: session.token,
    contentType: "application/json",
  });
}

/**
 * 直接在会话临时密钥加密下提交 `POST /api/configs/save`。
 * @param options 会话、目标文件与待保存原始 JSON 文本。
 * @returns HTTP 状态码与解析后的保存响应。
 */
async function submitEncryptedConfigSave(options: {
  readonly session: Readonly<MiniAppAuthSession>;
  readonly scope: MiniAppConfigScope;
  readonly fileName: string;
  readonly rawContent: string;
}): Promise<{
  readonly status: number;
  readonly body: MiniAppConfigSaveResponse;
}> {
  const requestPayload: MiniAppConfigSaveRequest = {
    scope: options.scope,
    fileName: options.fileName,
    content: options.rawContent,
  };
  const res: Response = await dispatchMiniAppTestRequest(
    new Request("http://127.0.0.1:3000/api/configs/save", {
      method: "POST",
      headers: headersForSession(options.session),
      body: JSON.stringify(requestPayload),
    })
  );
  return {
    status: res.status,
    body: (await res.json()) as MiniAppConfigSaveResponse,
  };
}

beforeEach(async (): Promise<void> => {
  fileBackups = new Map<string, Uint8Array | null>();
  for (const path of ALL_CONFIG_PATHS) {
    if (await Bun.file(path).exists()) {
      fileBackups.set(path, await Bun.file(path).bytes());
    } else {
      fileBackups.set(path, null);
    }
  }
  hadIdentityDbBefore = await Bun.file(IDENTITY_DATABASE_PATH).exists();
  savedMoodCache = defaultMoodConfigCache.current;
  savedStickerCache = defaultStickerConfigCache.current;
  savedAdDetectCache = defaultAdDetectConfigCache.current;
  savedAdDetectAgentCache = adDetectAgentConfigCache.current;
  savedAgentCache = agentDeploymentConfigCache.current;
  savedAssetCache = assetConfigCache.current;
  savedCronCache = cronConfigCache.current;
  savedAiReadiness = aiChatConfigReadinessCache.current;
  savedAdReadiness = adDetectConfigReadinessCache.current;
  savedTranslateReadiness = translateConfigReadinessCache.current;
});

afterEach(async (): Promise<void> => {
  quiesceConfigReload();
  await configReloadRuntime.runner?.push(null);
  await stopMiniAppServer();
  resetMiniAppTestDiskIOState();
  miniAppAuthSessions.clear();
  miniAppServiceRestartRunnerHolder.current = null;
  setSystemTime();

  for (const [path, backup] of fileBackups.entries()) {
    if (backup === null) {
      rmSync(path, { force: true });
    } else {
      await Bun.write(path, backup);
    }
  }
  if (!hadIdentityDbBefore && (await Bun.file(IDENTITY_DATABASE_PATH).exists())) {
    rmSync(IDENTITY_DATABASE_PATH, { force: true });
  }

  defaultMoodConfigCache.current = savedMoodCache;
  defaultStickerConfigCache.current = savedStickerCache;
  defaultAdDetectConfigCache.current = savedAdDetectCache;
  adDetectAgentConfigCache.current = savedAdDetectAgentCache;
  agentDeploymentConfigCache.current = savedAgentCache;
  assetConfigCache.current = savedAssetCache;
  cronConfigCache.current = savedCronCache;
  randomImageDirectoryCache.current = null;
  randomImageGalleryCache.current = null;
  aiChatConfigReadinessCache.current = savedAiReadiness;
  adDetectConfigReadinessCache.current = savedAdReadiness;
  translateConfigReadinessCache.current = savedTranslateReadiness;
});

describe("Mini App 配置管理、会话临时密钥直接加密保存与热重载/服务重启", () => {
  test("GET /api/configs 与 GET /api/configs/file 严格按白名单列出并读取存在/缺省配置，拒绝越界文件名且只读请求不记 operation 日志", async () => {
    const operationSpy = spyOn(logger, "operation");
    try {
      const session: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession();
      const listRes: Response = await dispatchMiniAppTestRequest(
        new Request("http://127.0.0.1:3000/api/configs", {
          headers: headersForSession(session),
        })
      );
      expect(listRes.status).toBe(200);
      const listBody: MiniAppConfigListResponse =
        (await listRes.json()) as MiniAppConfigListResponse;
      expect(listBody.ok).toBeTrue();
      expect(
        listBody.dynamicFiles.map(
          (item: Readonly<MiniAppConfigFileItem>): string => item.fileName
        )
      ).toEqual([...MINI_APP_DYNAMIC_CONFIG_FILES]);
      expect(
        listBody.staticFiles.map(
          (item: Readonly<MiniAppConfigFileItem>): string => item.fileName
        )
      ).toEqual([...MINI_APP_STATIC_CONFIG_FILES]);

      // bot.json 存在，g-auth.json 在隔离测试根默认缺省。
      const botFileRes: Response = await dispatchMiniAppTestRequest(
        new Request(
          "http://127.0.0.1:3000/api/configs/file?scope=static&fileName=bot.json",
          { headers: headersForSession(session) }
        )
      );
      expect(botFileRes.status).toBe(200);
      const botFileBody: MiniAppConfigFileResponse =
        (await botFileRes.json()) as MiniAppConfigFileResponse;
      expect(botFileBody.ok).toBeTrue();
      expect(botFileBody.exists).toBeTrue();
      expect(botFileBody.content).toBe(await Bun.file(BOT_CONFIG_PATH).text());

      const absentGAuthRes: Response = await dispatchMiniAppTestRequest(
        new Request(
          "http://127.0.0.1:3000/api/configs/file?scope=static&fileName=g-auth.json",
          { headers: headersForSession(session) }
        )
      );
      expect(absentGAuthRes.status).toBe(200);
      const absentGAuthBody: MiniAppConfigFileResponse =
        (await absentGAuthRes.json()) as MiniAppConfigFileResponse;
      expect(absentGAuthBody.ok).toBeTrue();
      expect(absentGAuthBody.exists).toBeFalse();
      expect(absentGAuthBody.content).toBe("");

      // 路径穿越、错误作用域或非白名单文件名一律返回 400 INVALID_CONFIG_TARGET。
      for (const badQuery of [
        "scope=dynamic&fileName=../static/bot.json",
        "scope=static&fileName=mood.json",
        "scope=dynamic&fileName=bot.json",
        "scope=other&fileName=bot.json",
        "scope=dynamic&fileName=unknown.json",
      ]) {
        const badRes: Response = await dispatchMiniAppTestRequest(
          new Request(`http://127.0.0.1:3000/api/configs/file?${badQuery}`, {
            headers: headersForSession(session),
          })
        );
        expect(badRes.status).toBe(400);
        const badBody: MiniAppConfigFileResponse =
          (await badRes.json()) as MiniAppConfigFileResponse;
        expect(badBody.ok).toBeFalse();
        expect(badBody.code).toBe(MINI_APP_INVALID_CONFIG_TARGET_CODE);
      }

      expect(operationSpy).not.toHaveBeenCalled();
    } finally {
      operationSpy.mockRestore();
    }
  });

  test("POST /api/configs/save 直接在会话临时密钥加密信封下交互、严格校验请求字段，且未注册配置子路由返回 404", async () => {
    const session: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession();
    const sessionCryptoKey: CryptoKey = await session.cryptoKey;
    const validStickersJson: string = JSON.stringify(
      { packs: ["ValidPack_by_bot"] },
      null,
      2
    );

    // 1. 未注册的配置子路由返回 404。
    const unknownSubrouteRes: Response = await dispatchMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/configs/write-key", {
        method: "POST",
        headers: headersForSession(session),
      })
    );
    expect(unknownSubrouteRes.status).toBe(404);

    // 2. 未经会话密钥加密的明文请求体或使用错误密钥加密的请求体一律返回 400 INVALID_ENCRYPTED_PAYLOAD。
    const plainSaveRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/configs/save", {
        method: "POST",
        headers: headersForSession(session),
        body: JSON.stringify({
          scope: "dynamic",
          fileName: "stickers.json",
          content: validStickersJson,
        }),
      })
    );
    expect(plainSaveRes.status).toBe(400);
    const plainErrEnv: Readonly<MiniAppEncryptedEnvelope> | null =
      parseMiniAppEncryptedEnvelope(await plainSaveRes.json());
    expect(plainErrEnv).not.toBeNull();
    expect(
      JSON.parse(
        (await decryptMiniAppText({
          cryptoKey: sessionCryptoKey,
          encrypted: plainErrEnv!,
          additionalData: buildMiniAppEnvelopeAad("POST", "/api/configs/save", "res"),
        }))!
      )
    ).toEqual({ error: MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE });

    const wrongCryptoKey: CryptoKey = await importMiniAppAesGcmKey("a".repeat(64));
    const wrongKeyEnv: Readonly<MiniAppEncryptedEnvelope> =
      await encryptMiniAppEnvelope(
        wrongCryptoKey,
        JSON.stringify({
          scope: "dynamic",
          fileName: "stickers.json",
          content: validStickersJson,
        }),
        buildMiniAppEnvelopeAad("POST", "/api/configs/save", "req")
      );
    const wrongKeyRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/configs/save", {
        method: "POST",
        headers: headersForSession(session),
        body: JSON.stringify(wrongKeyEnv),
      })
    );
    expect(wrongKeyRes.status).toBe(400);

    // 3. 含有未知/多余字段（如 keyId、encryptedContent）或非字符串 content 一律返回 400 INVALID_CONFIG_TARGET。
    for (const malformedInner of [
      {
        scope: "dynamic",
        fileName: "stickers.json",
        content: validStickersJson,
        keyId: "0".repeat(32),
      },
      {
        scope: "dynamic",
        fileName: "stickers.json",
        encryptedContent: { iv: "AAAAAAAAAAAAAAAA", payload: "BBBB" },
      },
      {
        scope: "dynamic",
        fileName: "stickers.json",
        content: { packs: ["ValidPack_by_bot"] },
      },
    ]) {
      const badRes: Response = await dispatchMiniAppTestRequest(
        new Request("http://127.0.0.1:3000/api/configs/save", {
          method: "POST",
          headers: headersForSession(session),
          body: JSON.stringify(malformedInner),
        })
      );
      expect(badRes.status).toBe(400);
      const badBody: MiniAppConfigSaveResponse =
        (await badRes.json()) as MiniAppConfigSaveResponse;
      expect(badBody.code).toBe(MINI_APP_INVALID_CONFIG_TARGET_CODE);
    }

    // 4. 在同一会话临时密钥加密下直接连续多次保存均成功，且原始网络响应体全程为加密信封。
    const firstEnvelope: Readonly<MiniAppEncryptedEnvelope> =
      await encryptMiniAppEnvelope(
        sessionCryptoKey,
        JSON.stringify({
          scope: "dynamic",
          fileName: "stickers.json",
          content: validStickersJson,
        }),
        buildMiniAppEnvelopeAad("POST", "/api/configs/save", "req")
      );
    const rawSaveRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/configs/save", {
        method: "POST",
        headers: headersForSession(session),
        body: JSON.stringify(firstEnvelope),
      })
    );
    expect(rawSaveRes.status).toBe(200);
    const rawSaveText: string = await rawSaveRes.text();
    expect(rawSaveText).not.toContain("stickers.json");
    const rawSaveEnv: Readonly<MiniAppEncryptedEnvelope> | null =
      parseMiniAppEncryptedEnvelope(JSON.parse(rawSaveText));
    expect(rawSaveEnv).not.toBeNull();
    expect(
      JSON.parse(
        (await decryptMiniAppText({
          cryptoKey: sessionCryptoKey,
          encrypted: rawSaveEnv!,
          additionalData: buildMiniAppEnvelopeAad("POST", "/api/configs/save", "res"),
        }))!
      )
    ).toEqual({
      ok: true,
      scope: "dynamic",
      fileName: "stickers.json",
      requiresRestart: false,
    });

    const secondStickersJson: string = JSON.stringify(
      { packs: ["SecondPack_by_bot"] },
      null,
      2
    );
    const secondSave = await submitEncryptedConfigSave({
      session,
      scope: "dynamic",
      fileName: "stickers.json",
      rawContent: secondStickersJson,
    });
    expect(secondSave.status).toBe(200);
    expect(secondSave.body).toEqual({
      ok: true,
      scope: "dynamic",
      fileName: "stickers.json",
      requiresRestart: false,
    });
    expect(await Bun.file(STICKERS_CONFIG_PATH).text()).toBe(
      `${secondStickersJson}\n`
    );
  });

  test("全部 8 份动态与静态配置文件均执行 JSON 语法、字段白名单与跨文件依赖校验，非法内容返回 400 且绝不写坏磁盘或令进程退出", async () => {
    await validateExistingDeploymentInputs();
    const session: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession();

    // 1. 非法 JSON 语法 → 400 INVALID_JSON_SYNTAX，磁盘原文件字节丝毫未变。
    const originalMoodBytes: Uint8Array<ArrayBuffer> =
      await Bun.file(MOOD_CONFIG_PATH).bytes();
    const syntaxRes = await submitEncryptedConfigSave({
      session,
      scope: "dynamic",
      fileName: "mood.json",
      rawContent: '{ "moods": [ invalid json ',
    });
    expect(syntaxRes.status).toBe(400);
    expect(syntaxRes.body.code).toBe(MINI_APP_INVALID_JSON_SYNTAX_CODE);
    expect(await Bun.file(MOOD_CONFIG_PATH).bytes()).toEqual(originalMoodBytes);

    // 2. 逐份验证未知字段/越界值被严格拒绝（400 CONFIG_VALIDATION_FAILED）。
    const invalidCases: readonly {
      readonly scope: MiniAppConfigScope;
      readonly fileName: string;
      readonly payload: unknown;
    }[] = [
      {
        scope: "dynamic",
        fileName: "ad_detect.json",
        payload: {
          punishment: { mute: { permanent: true } },
          samples: ["spam sample"],
          unknownField: 1,
        },
      },
      {
        scope: "dynamic",
        fileName: "agent.json",
        payload: {
          agent: {
            unknown_capability: {},
          },
        },
      },
      {
        scope: "dynamic",
        fileName: "assets.json",
        payload: {
          onlyUrl: {
            fortune_thumbnail_url: "http://insecure.example.com/a.png",
          },
        },
      },
      {
        scope: "dynamic",
        fileName: "cron.json",
        payload: [
          {
            name: "bad-task",
            chat_id: ["all"],
            cron: "not-a-cron",
            actions: [{ type: "send_message", payload: { text: "hi" } }],
          },
        ],
      },
      {
        scope: "dynamic",
        fileName: "mood.json",
        payload: {
          moods: [{ name: "only-50", weight: 50, instruction: "权重不足一百" }],
        },
      },
      {
        scope: "dynamic",
        fileName: "stickers.json",
        payload: {
          packs: ["valid_pack"],
          extra: true,
        },
      },
      {
        scope: "static",
        fileName: "bot.json",
        payload: {
          bot_token: "123456:valid-token",
          super_admin_user_id: SUPER_ADMIN_USER_ID,
          extra_unknown: "nope",
        },
      },
      {
        scope: "static",
        fileName: "g-auth.json",
        payload: {
          type: "service_account",
          client_email: "bot@test.iam.gserviceaccount.com",
          private_key: "not-a-valid-pem",
        },
      },
    ];

    for (const item of invalidCases) {
      const res = await submitEncryptedConfigSave({
        session,
        scope: item.scope,
        fileName: item.fileName,
        rawContent: JSON.stringify(item.payload),
      });
      expect(`${item.fileName} status:${res.status}`).toBe(
        `${item.fileName} status:400`
      );
      expect(res.body.code).toBe(MINI_APP_CONFIG_VALIDATION_FAILED_CODE);
    }

    // 3. 跨文件与数据库不变量校验：
    // - cron.json 启用 send_voice 后，禁止把 agent.json 的 tts 段删掉；
    const validVoiceCron: string = JSON.stringify([
      {
        name: "morning-voice",
        chat_id: ["all"],
        cron: "0 9 * * *",
        actions: [{ type: "send_voice", payload: { content: "早安喵" } }],
      },
    ]);
    const cronSave = await submitEncryptedConfigSave({
      session,
      scope: "dynamic",
      fileName: "cron.json",
      rawContent: validVoiceCron,
    });
    expect(cronSave.status).toBe(200);
    cronConfigCache.current = null;

    const parsedAgent = JSON.parse(
      await Bun.file(AGENT_CONFIG_PATH).text()
    ) as { agent: Record<string, unknown> };
    delete parsedAgent.agent.tts;
    const dropTtsSave = await submitEncryptedConfigSave({
      session,
      scope: "dynamic",
      fileName: "agent.json",
      rawContent: JSON.stringify(parsedAgent),
    });
    expect(dropTtsSave.status).toBe(400);
    expect(dropTtsSave.body.code).toBe(MINI_APP_CONFIG_VALIDATION_FAILED_CODE);

    // - storage.sqlite 已存在时，禁止修改 bot.json 的 time_zone；
    mkdirSync(dirname(IDENTITY_DATABASE_PATH), { recursive: true });
    await Bun.write(IDENTITY_DATABASE_PATH, "sqlite-placeholder");
    const parsedBot = JSON.parse(
      await Bun.file(BOT_CONFIG_PATH).text()
    ) as Record<string, unknown>;
    parsedBot.time_zone = "UTC";
    const tzChangeSave = await submitEncryptedConfigSave({
      session,
      scope: "static",
      fileName: "bot.json",
      rawContent: JSON.stringify(parsedBot),
    });
    expect(tzChangeSave.status).toBe(400);
    expect(tzChangeSave.body.code).toBe(MINI_APP_CONFIG_VALIDATION_FAILED_CODE);

    // 4. 合法静态配置 g-auth.json 保存成功并返回 requiresRestart: true。
    const validGAuth: string = JSON.stringify(
      {
        type: "service_account",
        project_id: "copy-ninjia-test",
        private_key_id: "key-id-01",
        private_key: rsaPemFixture,
        client_email: "bot@copy-ninjia-test.iam.gserviceaccount.com",
        client_id: "100200300",
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
        client_x509_cert_url:
          "https://www.googleapis.com/robot/v1/metadata/x509/bot",
        universe_domain: "googleapis.com",
        custom_sdk_hint: "allowed-for-sdk",
      },
      null,
      2
    );
    const gAuthSave = await submitEncryptedConfigSave({
      session,
      scope: "static",
      fileName: "g-auth.json",
      rawContent: validGAuth,
    });
    expect(gAuthSave.status).toBe(200);
    expect(gAuthSave.body).toEqual({
      ok: true,
      scope: "static",
      fileName: "g-auth.json",
      requiresRestart: true,
    });
    expect(await Bun.file(GOOGLE_AUTH_FILE_PATH).text()).toBe(`${validGAuth}\n`);
  });

  test("并发保存 agent.json 与 cron.json 严格串行校验与写盘（无 TOCTOU），且 assets.json 校验不覆写期间上传的图片缓存", async () => {
    await validateExistingDeploymentInputs();
    const session: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession();

    // 1. 并发保存删去 tts 的 agent.json 与依赖 send_voice 的 cron.json：第二份必须在前一份落盘后重新校验并被 400 拒绝。
    const parsedAgent = JSON.parse(await Bun.file(AGENT_CONFIG_PATH).text()) as { agent: Record<string, unknown> };
    delete parsedAgent.agent.tts;
    const voiceCron: string = JSON.stringify([
      { name: "concurrent-voice", chat_id: ["all"], cron: "0 9 * * *", actions: [{ type: "send_voice", payload: { content: "hi" } }] },
    ]);
    const writeStarted: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const releaseWrite: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const realWrite: typeof Bun.write = Bun.write.bind(Bun);
    let heldFirstWrite: boolean = false;
    const writeSpy = spyOn(Bun, "write").mockImplementation(
      (async (target: unknown, input: unknown): Promise<number> => {
        if (typeof target === "object" && target !== null && !heldFirstWrite) {
          heldFirstWrite = true;
          writeStarted.resolve();
          await releaseWrite.promise;
        }
        return realWrite(target as Parameters<typeof Bun.write>[0], input as Parameters<typeof Bun.write>[1]);
      }) as typeof Bun.write
    );
    try {
      const saveAgent = submitEncryptedConfigSave({
        session, scope: "dynamic", fileName: "agent.json", rawContent: JSON.stringify(parsedAgent),
      });
      await writeStarted.promise;
      const saveCron = submitEncryptedConfigSave({
        session, scope: "dynamic", fileName: "cron.json", rawContent: voiceCron,
      });
      await Promise.resolve();
      releaseWrite.resolve();
      const [agentRes, cronRes] = await Promise.allSettled([saveAgent, saveCron]);
      expect(agentRes.status === "fulfilled" && agentRes.value.status).toBe(200);
      expect(cronRes.status === "fulfilled" && cronRes.value.status).toBe(400);
      if (cronRes.status === "fulfilled") {
        expect(cronRes.value.body.code).toBe(MINI_APP_CONFIG_VALIDATION_FAILED_CODE);
      }
    } finally {
      releaseWrite.resolve();
      writeSpy.mockRestore();
    }

    // 2. 保存 assets.json 切到新目录并暂停在目录检查期间，并发上传一张图片到当前目录，保存结束后缓存仍保留该新图。
    const activeDir: string = join(RUNTIME_DATA_ROOT, "miniapp-active-gallery");
    const candidateDir: string = join(RUNTIME_DATA_ROOT, "miniapp-candidate-gallery");
    const validPng: Uint8Array = Uint8Array.fromBase64(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    );
    mkdirSync(activeDir, { recursive: true });
    mkdirSync(candidateDir, { recursive: true });
    adoptRandomImageDirectory(activeDir, await inspectRandomImageDirectory(activeDir));
    const statGate: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const candidateReached: PromiseWithResolvers<void> = Promise.withResolvers<void>();
    const realBunFile: typeof Bun.file = Bun.file.bind(Bun);
    let interceptedCandidate: boolean = false;
    const fileSpy = spyOn(Bun, "file").mockImplementation(
      ((path: string | URL, options?: unknown): ReturnType<typeof Bun.file> => {
        const bf = realBunFile(path as string, options as never);
        if (path === candidateDir && !interceptedCandidate) {
          interceptedCandidate = true;
          const origStat = bf.stat.bind(bf);
          return new Proxy(bf, {
            get(target, prop, receiver): unknown {
              if (prop === "stat") {
                return async (): Promise<Awaited<ReturnType<typeof origStat>>> => {
                  candidateReached.resolve();
                  await statGate.promise;
                  return await origStat();
                };
              }
              return Reflect.get(target, prop, receiver);
            },
          });
        }
        return bf;
      }) as typeof Bun.file
    );
    try {
      const saveAssets = submitEncryptedConfigSave({
        session,
        scope: "dynamic",
        fileName: "assets.json",
        rawContent: JSON.stringify({ [ASSET_ONLY_PATH_GROUP]: { random_h_image_dir: "./miniapp-candidate-gallery" } }),
      });
      await candidateReached.promise;
      const uploaded = await storeRandomImage(activeDir, validPng);
      expect(uploaded.status).toBe("stored");
      statGate.resolve();
      const assetsRes = await saveAssets;
      expect(assetsRes.status).toBe(200);
      if (uploaded.status === "stored") {
        expect(randomImageDirectoryCache.current?.directory).toBe(activeDir);
        expect(randomImageDirectoryCache.current?.names).toEqual([uploaded.fileName]);
        expect(randomImageGalleryCache.current?.directory).toBe(activeDir);
        expect(randomImageGalleryCache.current?.entries.map((e): string => e.fileName)).toEqual([uploaded.fileName]);
      }
    } finally {
      statGate.resolve();
      fileSpy.mockRestore();
      rmSync(activeDir, { recursive: true, force: true });
      rmSync(candidateDir, { recursive: true, force: true });
    }
  });

  test("动态配置保存仅修改 DYNAMIC_CONFIG_DIR 文件，由 configReload fs.watch 自动热重载内存快照；POST /api/configs/restart 支持成功与失败回执且审计日志零敏感泄露", async () => {
    await validateExistingDeploymentInputs();
    startConfigReload();
    await configReloadRuntime.runner?.push(null);

    const operationSpy = spyOn(logger, "operation");
    try {
      const session: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession();

      const secretMarkerMood: string = "热重载专属心情档位_AutoWatch";
      const updatedMoodJson: string = JSON.stringify(
        {
          moods: [
            {
              name: secretMarkerMood,
              weight: 100,
              instruction: "热重载自动生效测试指令。",
            },
          ],
        },
        null,
        2
      );

      const saveRes = await submitEncryptedConfigSave({
        session,
        scope: "dynamic",
        fileName: "mood.json",
        rawContent: updatedMoodJson,
      });
      expect(saveRes.status).toBe(200);
      expect(saveRes.body).toEqual({
        ok: true,
        scope: "dynamic",
        fileName: "mood.json",
        requiresRestart: false,
      });

      // 等待 `configReload.ts` 的目录级 `fs.watch` 监听触发并自动更新主线程快照。
      await waitUntil(
        (): boolean =>
          defaultMoodConfigCache.current?.moods[0]?.name === secretMarkerMood,
        4_000
      );
      expect(defaultMoodConfigCache.current?.moods[0]?.name).toBe(
        secretMarkerMood
      );

      // 测试 POST /api/configs/restart（通过可注入执行器模拟成功与失败，绝不触发宿主机真实 systemctl）。
      let restartCalls: number = 0;
      miniAppServiceRestartRunnerHolder.current = async () => {
        restartCalls += 1;
        return { ok: true };
      };
      const okRestartRes: Response = await dispatchMiniAppTestRequest(
        new Request("http://127.0.0.1:3000/api/configs/restart", {
          method: "POST",
          headers: headersForSession(session),
        })
      );
      expect(okRestartRes.status).toBe(200);
      expect((await okRestartRes.json()) as MiniAppConfigRestartResponse).toEqual(
        { ok: true }
      );
      expect(restartCalls).toBe(1);

      miniAppServiceRestartRunnerHolder.current = async () => ({
        ok: false,
        error: "Access denied by polkit",
      });
      const failRestartRes: Response = await dispatchMiniAppTestRequest(
        new Request("http://127.0.0.1:3000/api/configs/restart", {
          method: "POST",
          headers: headersForSession(session),
        })
      );
      expect(failRestartRes.status).toBe(500);
      const failRestartBody: MiniAppConfigRestartResponse =
        (await failRestartRes.json()) as MiniAppConfigRestartResponse;
      expect(failRestartBody.ok).toBeFalse();
      expect(failRestartBody.code).toBe(MINI_APP_SERVICE_RESTART_FAILED_CODE);

      // 重启命令目标服务名须与安装器 install.sh 的 SERVICE_NAME 保持一致。
      const installScript: string = await Bun.file(
        join(import.meta.dir, "../../install.sh")
      ).text();
      const serviceNameMatch: RegExpMatchArray | null = installScript.match(
        /^readonly SERVICE_NAME="([^"]+)"/m
      );
      expect(serviceNameMatch).not.toBeNull();
      expect(MINI_APP_SERVICE_RESTART_COMMAND.at(-1)).toBe(serviceNameMatch![1]!);

      // 核对审计日志仅记录 configs.save 与 configs.restart，绝不回显 sessionKey 或配置正文内容。
      const serializedLogs: string = JSON.stringify(operationSpy.mock.calls);
      expect(serializedLogs).toContain("[MiniApp] configs.save");
      expect(serializedLogs).toContain("[MiniApp] configs.restart");
      expect(serializedLogs).not.toContain(session.pendingSessionKey!);
      expect(serializedLogs).not.toContain(secretMarkerMood);
    } finally {
      operationSpy.mockRestore();
    }
  });

  test("外层加密信封同样允许最多 4 MiB 的大型合法配置保存（如多样本 ad_detect.json）", async () => {
    const session: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession();
    const largeSamples: string[] = [];
    for (let i: number = 0; i < 160; i += 1) {
      largeSamples.push(
        `广告样本编号_${i}_${"推广引流加微测试内容".repeat(30)}`
      );
    }
    const largeAdDetectJson: string = JSON.stringify(
      {
        punishment: { mute: { permanent: true } },
        samples: largeSamples,
      },
      null,
      2
    );

    const outerPlain: string = JSON.stringify({
      scope: "dynamic",
      fileName: "ad_detect.json",
      content: largeAdDetectJson,
    });
    const outerEnvelope = await encryptMiniAppEnvelope(
      await session.cryptoKey,
      outerPlain,
      buildMiniAppEnvelopeAad("POST", "/api/configs/save", "req")
    );
    const outerWireBody: string = JSON.stringify(outerEnvelope);
    expect(new TextEncoder().encode(outerWireBody).byteLength).toBeGreaterThan(
      MINI_APP_MAX_ENCRYPTED_JSON_BODY_BYTES
    );

    const rawRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/configs/save", {
        method: "POST",
        headers: headersForSession(session),
        body: outerWireBody,
      })
    );
    expect(rawRes.status).toBe(200);
  });

  test("前序请求触发滑动续期时紧随其后的新令牌与新密钥直接加密保存配置；拒绝覆写符号链接目标", async () => {
    const baseMs: number = 1_785_000_000_000;
    setSystemTime(new Date(baseMs));
    const sessionT1: Readonly<MiniAppAuthSession> =
      issueMiniAppAuthSession(baseMs);
    const cryptoKey1: CryptoKey = await sessionT1.cryptoKey;

    // 1. 超过 5 分钟刷新阈值后请求 GET /api/configs：响应轮换为 T2 + K2，紧接着用 T2 + K2 直接加密提交 save 正常成功并使 T1 失效。
    setSystemTime(new Date(baseMs + MINI_APP_SESSION_REFRESH_MAX_MS + 2_000));
    const initData: string = buildSignedTestInitData({
      botToken: BOT_TOKEN,
      authDate: Math.floor(Date.now() / 1_000),
      user: { id: SUPER_ADMIN_USER_ID, first_name: "SuperAdmin" },
    });
    const rawListRes: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/configs", {
        headers: { [MINI_APP_INIT_DATA_HEADER]: initData, [MINI_APP_SESSION_HEADER]: sessionT1.token },
      })
    );
    expect(rawListRes.status).toBe(200);
    const tokenT2: string = rawListRes.headers.get(MINI_APP_SESSION_HEADER)!;
    const sealedKey2: string = rawListRes.headers.get(MINI_APP_SESSION_KEY_HEADER)!;
    expect(tokenT2).not.toBe(sessionT1.token);
    const key2Hex: string = await unsealRotatedSessionKey(cryptoKey1, sealedKey2, tokenT2);
    const cryptoKey2: CryptoKey = await importMiniAppAesGcmKey(key2Hex);
    const outerSaveEnv: Readonly<MiniAppEncryptedEnvelope> = await encryptMiniAppEnvelope(
      cryptoKey2,
      JSON.stringify({
        scope: "dynamic",
        fileName: "stickers.json",
        content: JSON.stringify({ packs: ["RotatedPack_by_bot"] }),
      }),
      buildMiniAppEnvelopeAad("POST", "/api/configs/save", "req")
    );
    const saveWithT2Res: Response = await dispatchRawMiniAppTestRequest(
      new Request("http://127.0.0.1:3000/api/configs/save", {
        method: "POST",
        headers: {
          [MINI_APP_INIT_DATA_HEADER]: initData,
          [MINI_APP_SESSION_HEADER]: tokenT2,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(outerSaveEnv),
      })
    );
    expect(saveWithT2Res.status).toBe(200);
    expect(miniAppAuthSessions.get(tokenT2)?.previousToken).toBeUndefined();

    // 2. 目标配置文件路径为符号链接时拒绝覆写。
    const cleanSession: Readonly<MiniAppAuthSession> = issueMiniAppAuthSession();
    rmSync(STICKERS_CONFIG_PATH, { force: true });
    symlinkSync(MOOD_CONFIG_PATH, STICKERS_CONFIG_PATH);
    const symlinkSave = await submitEncryptedConfigSave({
      session: cleanSession,
      scope: "dynamic",
      fileName: "stickers.json",
      rawContent: JSON.stringify({ packs: ["NoSymlinkOverwrite_by_bot"] }),
    });
    expect(symlinkSave.status).toBe(400);
    expect(symlinkSave.body.code).toBe(MINI_APP_CONFIG_VALIDATION_FAILED_CODE);
    expect(lstatSync(STICKERS_CONFIG_PATH).isSymbolicLink()).toBeTrue();
    rmSync(STICKERS_CONFIG_PATH, { force: true });
  });
});

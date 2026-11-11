import { describe, expect, test } from "bun:test";
import { AI_MEMORY_HYDRATE_BUFFER_MAX } from "../../packages/consts/aiChat/memory";
import { MINI_APP_BATCH_KICK_MAX_HOURS } from "../../packages/consts/miniApp";
import { HOT_PATH_PROFILE_SCENARIOS } from "../../packages/consts/performance";
import { CHAT_QA_MAX_PER_CHAT } from "../../packages/consts/qa";
import { STATE_MANAGED_CHAT_LIMIT } from "../../packages/consts/storage";
import { createStorageChain } from
  "../../scripts/perf/fullSuite/storageChains";
import { createMiniAppChain } from "../../scripts/perf/fullSuite/miniAppChains";
import type { MiniAppChainDependencies } from "../../scripts/perf/fullSuite/miniAppChains";
import { benchmarkEntryCopy } from "../../scripts/perf/fullSuite/markdownEntryCopy";
import type { BenchmarkEntryCopy } from "../../scripts/perf/fullSuite/markdownEntryCopy";
import {
  CHAIN_NAMES,
  PRODUCTION_HOT_PATH_SCENARIOS,
} from "../../scripts/perf/fullSuite/sections";
import type { StorageChainDependencies } from
  "../../scripts/perf/fullSuite/storageChains";
import type { ChainDefinition } from
  "../../scripts/perf/fullSuite/chainDefinition";
import type { StoredTemporaryAdBypassActivity } from
  "../../packages/types/temporaryAdBypass";
import type { AdDetectionMessageContext } from
  "../../packages/types/antiRaid/adDetect";
import type { ChatState } from "../../packages/types/chatState";
import type { DiskIOMessage } from "../../packages/types/diskIO";
import type { MiniAppAuthSession } from "../../packages/types/miniApp/auth";
import type { MiniAppChatDetail } from "../../packages/types/miniApp/chats";
import type { BotChatPermissions } from "../../packages/types/telegram";
import { botPermissions } from "../helpers/botPermissions";
import { chatStateOf } from "../helpers/chatState";
import { createCommandChain } from "../../scripts/perf/fullSuite/commandChains";
import type { CommandChainDependencies } from "../../scripts/perf/fullSuite/commandChains";
import {
  AI_REPLY_SEED_MESSAGES,
  MINI_APP_API_SEED_JOIN_EVENTS_PER_CHAT,
} from "../../scripts/perf/fullSuite/constants";
import type { DeliverCronActionOptions } from "../../packages/cron/delivery";
import type { CronDeliveryOutcome } from "../../packages/types/cron";
import type { IdentityPolicyCacheEntry } from "../../packages/types/identityStorage";
import type { EncodedVoiceMessage, VoiceSynthesisResult } from "../../packages/types/aiChat/voiceMessage";

describe("全量性能链路编排", () => {
  test("临时广告免检与 Mini App 前后端热路径及 API 链路均已登记且不重名", () => {
    expect(PRODUCTION_HOT_PATH_SCENARIOS)
      .toContain("temporary-whitelist-activity");
    expect(PRODUCTION_HOT_PATH_SCENARIOS)
      .toContain("mini-app-status-route");
    expect(PRODUCTION_HOT_PATH_SCENARIOS)
      .toContain("mini-app-frontend-render");
    expect(HOT_PATH_PROFILE_SCENARIOS)
      .toContain("mini-app-status-route");
    expect(HOT_PATH_PROFILE_SCENARIOS)
      .toContain("mini-app-frontend-render");
    expect(CHAIN_NAMES).toContain("temporary-whitelist-write");
    expect(CHAIN_NAMES).toContain("mini-app-api-request");
    expect(new Set(PRODUCTION_HOT_PATH_SCENARIOS).size)
      .toBe(PRODUCTION_HOT_PATH_SCENARIOS.length);
    expect(new Set(CHAIN_NAMES).size).toBe(CHAIN_NAMES.length);
    for (const language of ["zh", "en", "ja"] as const) {
      const copy: BenchmarkEntryCopy = benchmarkEntryCopy(language);
      expect(copy.labels["mini-app-status-route"]?.length).toBeGreaterThan(0);
      expect(copy.labels["mini-app-frontend-render"]?.length).toBeGreaterThan(0);
      expect(copy.labels["mini-app-api-request"]?.length).toBeGreaterThan(0);
    }
  });

  test("durable 场景从资格入口等到精确 ACK，并核验最终记录数", async () => {
    const identities: Map<number, IdentityPolicyCacheEntry> = new Map<number, IdentityPolicyCacheEntry>();
    const unacknowledged: Set<number> = new Set<number>();
    const rows: StoredTemporaryAdBypassActivity[] = [];
    let readinessCalls: number = 0;
    const dependencies: StorageChainDependencies = {
      chainWarmupOperations: 0,
      chainTemporaryAdBypassWrites: 1,
      benchmarkChatId: (index: number): number => -1_000 - index,
      benchmarkUserId: (index: number): number => 10_000 + index,
      validateAgentDeploymentConfig: (): never => {
        readinessCalls++;
        return undefined as never;
      },
      hydrateIdentityStorageCounts: (): void => {},
      identityPolicyCache: identities as never,
      unacknowledgedTemporaryAdBypassWrites: unacknowledged as never,
      recordEligibleTemporaryAdBypassActivity: ({
        message,
      }: AdDetectionMessageContext): boolean => {
        expect(message.text).toBe("性能基准普通群发言");
        const id: number = message.from!.id;
        unacknowledged.add(id);
        rows.push({
          id,
          adBypass: false,
          adBypassGrantedAt: null,
          qualifiedDays: 0,
          sendCount: 1,
          countedAt: 1_800_000_000_000,
          qualifiedAt: null,
        });
        return true;
      },
      flushDiskIODomain: async (): Promise<{ result: "flushed" }> => {
        unacknowledged.clear();
        return { result: "flushed" };
      },
      readIdentityPolicies: async (): Promise<{
        readonly whitelist: readonly [];
        readonly blocklist: readonly [];
        readonly temporaryAdBypass: readonly StoredTemporaryAdBypassActivity[];
      }> => ({ whitelist: [], blocklist: [], temporaryAdBypass: rows }),
    } as unknown as StorageChainDependencies;
    const definition: ChainDefinition = createStorageChain(
      "temporary-whitelist-write",
      dependencies
    )!;

    await definition.prepare?.();
    await definition.run(0);
    await definition.verify?.();

    expect(readinessCalls).toBe(1);
    // 预热按整条写入三项负缓存。
    expect(identities.get(10_000)).toEqual({ whitelist: null, blocklist: null, temporaryAdBypass: null });
    expect(unacknowledged.size).toBe(0);
    expect(rows).toHaveLength(1);
  });
});

test.each(["complete", "missing", "stale"])("AI 快照链路先持久化群行，并拒绝未落盘或旧内容：%s", async (outcome: string): Promise<void> => {
  const states: Map<number, ChatState> = new Map<number, ChatState>();
  const durableStates: Set<number> = new Set<number>();
  const snapshots: Map<number, string> = new Map<number, string>();
  const writes: string[] = [];
  let pending: Readonly<{ chatId: number; snapshot: string }> | undefined;
  const dependencies: StorageChainDependencies = {
    stateManagedChatLimit: 2,
    chainWarmupOperations: 2,
    chainAiMemorySnapshots: 4,
    benchmarkChatId: (index: number): number => -1_000 - index,
    buildAiMemorySnapshot: (sequence: number): string => `snapshot-${sequence}`,
    getOrCreateChatState: (chatId: number): ChatState => {
      let state: ChatState | undefined = states.get(chatId);
      if (state === undefined) {
        state = chatStateOf();
        states.set(chatId, state);
      }
      return state;
    },
    persistChatState: async (chatId: number): Promise<void> => {
      await Promise.resolve();
      expect(states.get(chatId)).toMatchObject({ isInitEnabled: true, isAIChatEnabled: true });
      durableStates.add(chatId);
    },
    postDiskIO: (message: DiskIOMessage): boolean => {
      if (message.type !== "aiMemory") throw new Error("Unexpected benchmark message");
      expect(durableStates.has(message.chatId)).toBeTrue();
      pending = { chatId: message.chatId, snapshot: message.snapshot };
      return true;
    },
    flushDiskIODomain: async (domain: string): Promise<{ result: "flushed" }> => {
      expect(domain).toBe("aiMemory");
      if (pending === undefined) throw new Error("Missing pending write");
      snapshots.set(pending.chatId, pending.snapshot);
      writes.push(pending.snapshot);
      pending = undefined;
      return { result: "flushed" };
    },
    readBenchmarkAiMemories: (): ReadonlyMap<number, string> => snapshots,
  } as unknown as StorageChainDependencies;
  const definition: ChainDefinition = createStorageChain("ai-memory-snapshot", dependencies)!;
  await definition.prepare!();
  for (let sequence: number = 0; sequence < 6; sequence++) await definition.run(sequence);
  expect(writes).toEqual(["snapshot-0", "snapshot-1", "snapshot-2", "snapshot-3", "snapshot-4", "snapshot-5"]);
  if (outcome === "missing") snapshots.delete(-1_000);
  if (outcome === "stale") snapshots.set(-1_000, "snapshot-2");
  if (outcome === "complete") expect((): void => { definition.verify!(); }).not.toThrow();
  else expect((): void => { definition.verify!(); }).toThrow(outcome === "missing" ? "persisted 1 of 2" : "final snapshot");
});

describe("cron 语音链路", () => {
  const ENCODED: EncodedVoiceMessage = { bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53]), durationSeconds: 11, fileName: "voice.ogg" };
  const VOICE: VoiceSynthesisResult = { ok: true, voice: ENCODED };

  function voiceChain(overrides: Partial<CommandChainDependencies>): {
    definition: ChainDefinition;
    calls: Map<string, number>;
    geminiClients: { current: unknown };
  } {
    const calls: Map<string, number> = new Map<string, number>();
    const geminiClients: { current: unknown } = { current: null };
    const dependencies: CommandChainDependencies = {
      chainCronVoiceCommands: 1,
      cronVoiceWarmupOperations: 0,
      cronVoicePcmBytes: 480,
      benchmarkChatId: (index: number): number => -1_000 - index,
      validateAgentDeploymentConfig: async (): Promise<void> => {},
      geminiClientCache: geminiClients as never,
      ttsDailyUsage: { current: { windowStartedAt: Date.now(), agentCount: 100, reserveCount: 0 } },
      cannedTelegramCalls: calls,
      resolveSpeechSynthesizer: () => ({ ok: true, synthesize: async () => null }),
      synthesizeVoiceMessage: async (): Promise<VoiceSynthesisResult> => VOICE,
      deliverCronAction: async (options: DeliverCronActionOptions): Promise<CronDeliveryOutcome> => {
        expect(options.voices.get(options.action)).toEqual({ voice: ENCODED, fileId: undefined });
        calls.set("sendVoice", (calls.get("sendVoice") ?? 0) + 1);
        return { kind: "sent" };
      },
      ...overrides,
    } as unknown as CommandChainDependencies;
    return { definition: createCommandChain("cron-send-voice", dependencies)!, calls, geminiClients };
  }

  test("罐头 WAV 装进 tts 客户端，合成结果登记进本轮语音表后经 cron 边界发出", async () => {
    const { definition, calls, geminiClients } = voiceChain({});
    await definition.prepare?.();
    const client = (geminiClients.current as Map<string, { interactions: { create(): Promise<unknown> } }>).get("tts")!;
    const response = await client.interactions.create() as { output_audio: { data: string; mime_type: string } };
    expect(response.output_audio.mime_type).toBe("audio/wav");
    expect(new TextDecoder().decode(Uint8Array.fromBase64(response.output_audio.data).subarray(0, 4))).toBe("RIFF");
    await definition.run(0);
    expect(calls.get("sendVoice")).toBe(1);
  });

  test("合成失败、投递未成功或没有真正发出语音都使基准失败", async () => {
    const failed = voiceChain({ synthesizeVoiceMessage: async () => ({ ok: false, reason: "synthesis failed" }) });
    await failed.definition.prepare?.();
    await expect(failed.definition.run(0)).rejects.toThrow("produced no voice: synthesis failed");

    const undelivered = voiceChain({ deliverCronAction: async () => ({ kind: "permanent", detail: "403" }) });
    await undelivered.definition.prepare?.();
    await expect(undelivered.definition.run(0)).rejects.toThrow("was not delivered: permanent");

    const silent = voiceChain({ deliverCronAction: async () => ({ kind: "sent" }) });
    await silent.definition.prepare?.();
    await expect(silent.definition.run(0)).rejects.toThrow("produced no outgoing voice message");

    const unavailable = voiceChain({ resolveSpeechSynthesizer: () => ({ ok: false, reason: "tts unconfigured", providerName: undefined }) });
    await expect(unavailable.definition.prepare?.()).rejects.toThrow("speech synthesis is unavailable: tts unconfigured");
  });

  test("链路登记进出数顺序", () => {
    expect(CHAIN_NAMES).toContain("cron-send-voice");
  });
});

describe("广告检测命令链路", () => {
  interface CannedCompletion {
    readonly choices: readonly { readonly message: { readonly content: string } }[];
  }
  interface CannedOpenAiClient {
    readonly chat: { readonly completions: { create(): Promise<CannedCompletion> } };
  }

  function adDetectChain(overrides: Partial<CommandChainDependencies>): {
    definition: ChainDefinition;
    calls: Map<string, number>;
    openAiClient: { current: unknown };
    candidates: unknown[];
  } {
    const calls: Map<string, number> = new Map<string, number>();
    const openAiClient: { current: unknown } = { current: null };
    const publishHolder: { current: unknown } = { current: null };
    const candidates: unknown[] = [];
    const state: ChatState = chatStateOf();
    const handleAdDetected = (): void => {
      calls.set("sendMessage", (calls.get("sendMessage") ?? 0) + 1);
    };
    const dependencies: CommandChainDependencies = {
      chainAdDetectCommands: 1,
      adDetectDrainBudgetMs: 1_000,
      benchmarkChatId: (index: number): number => -1_000 - index,
      benchmarkUserId: (index: number): number => 10_000 + index,
      validateAgentDeploymentConfig: async (): Promise<void> => {},
      handleAdDetected: handleAdDetected as never,
      drainAdDisposals: async (): Promise<"flushed" | "timedOut"> => "flushed",
      botChatPermissionsIn: async (): Promise<BotChatPermissions | undefined> => {
        const permissions: BotChatPermissions = botPermissions({
          canRestrictMembers: true,
          canDeleteMessages: true,
        });
        state.botPermissions = permissions;
        return permissions;
      },
      getOrCreateChatState: (): ChatState => state,
      cacheAdminIds: (): void => {},
      enqueueAdCandidate: (candidate: unknown): void => {
        candidates.push(candidate);
      },
      runAdDetectBatch: async (): Promise<void> => {
        const publish: (() => void) | null = publishHolder.current as (() => void) | null;
        publish?.();
      },
      adDetectOpenAiClientHolder: openAiClient as never,
      adDetectPublishHolder: publishHolder as never,
      cannedTelegramCalls: calls,
      ...overrides,
    } as unknown as CommandChainDependencies;
    return {
      definition: createCommandChain("ad-detect-command", dependencies)!,
      calls,
      openAiClient,
      candidates,
    };
  }

  test("罐头 OpenAI 客户端与发布回调装入后，完整跑完批次并发出处置播报", async (): Promise<void> => {
    const { definition, calls, openAiClient, candidates }: ReturnType<typeof adDetectChain> = adDetectChain({});
    await definition.prepare?.();
    const client: CannedOpenAiClient = openAiClient.current as CannedOpenAiClient;
    const completion: CannedCompletion = await client.chat.completions.create();
    expect(JSON.parse(completion.choices[0]!.message.content)).toEqual({
      ad: true,
      reason: "performance benchmark",
    });
    await definition.run(0);
    expect(candidates).toHaveLength(1);
    expect(calls.get("sendMessage")).toBe(1);
    expect(CHAIN_NAMES).toContain("ad-detect-command");
  });

  test("管理员权限未就绪、处置排空超时或未发出播报都使基准失败", async (): Promise<void> => {
    const notAdmin: ReturnType<typeof adDetectChain> = adDetectChain({
      botChatPermissionsIn: async (): Promise<BotChatPermissions | undefined> => undefined,
    });
    await expect(notAdmin.definition.prepare?.()).rejects.toThrow("never resolved to administrator");

    const timedOut: ReturnType<typeof adDetectChain> = adDetectChain({
      drainAdDisposals: async (): Promise<"flushed" | "timedOut"> => "timedOut",
    });
    await timedOut.definition.prepare?.();
    await expect(timedOut.definition.run(0)).rejects.toThrow("did not settle within the drain budget");

    const silent: ReturnType<typeof adDetectChain> = adDetectChain({
      runAdDetectBatch: async (): Promise<void> => {},
    });
    await silent.definition.prepare?.();
    await expect(silent.definition.run(0)).rejects.toThrow("produced no outgoing announcement");
  });
});

describe("AI 回复命令链路", () => {
  interface CannedGeminiClient {
    readonly models: { generateContent(): Promise<{ readonly text: string }> };
  }

  function aiReplyChain(overrides: Partial<CommandChainDependencies>): {
    definition: ChainDefinition;
    calls: Map<string, number>;
    geminiClients: { current: unknown };
    recordedMessages: number[];
  } {
    const calls: Map<string, number> = new Map<string, number>();
    const callTimes: Map<string, number> = new Map<string, number>();
    const geminiClients: { current: unknown } = { current: null };
    const recordedMessages: number[] = [];
    const tasks: Map<number, Set<Promise<void>>> = new Map<number, Set<Promise<void>>>();
    const states: Map<number, ChatState> = new Map<number, ChatState>();
    const dependencies: CommandChainDependencies = {
      chainAiReplyCommands: 1,
      aiReplyWarmupOperations: 0,
      aiReplySettleAttempts: 2,
      stateManagedChatLimit: 2,
      benchmarkChatId: (index: number): number => -1_000 - index,
      benchmarkUserId: (index: number): number => 10_000 + index,
      validateAgentDeploymentConfig: async (): Promise<void> => {},
      getOrCreateChatState: (chatId: number): ChatState => {
        let state: ChatState | undefined = states.get(chatId);
        if (state === undefined) {
          state = chatStateOf();
          states.set(chatId, state);
        }
        return state;
      },
      botInfoState: { current: null },
      geminiClientCache: geminiClients as never,
      replyGenerationTasks: tasks as never,
      cannedTelegramCalls: calls,
      cannedTelegramCallTimes: callTimes,
      recordChatMessage: ({ messageId }: { readonly messageId: number }): void => {
        recordedMessages.push(messageId);
      },
      generateAndSendReply: ({ chatId }: { readonly chatId: number }): void => {
        const task: Promise<void> = Promise.resolve().then((): void => {
          callTimes.set("sendChatAction", 100);
          callTimes.set("sendMessage", 450);
          calls.set("sendMessage", (calls.get("sendMessage") ?? 0) + 1);
          tasks.delete(chatId);
        });
        tasks.set(chatId, new Set<Promise<void>>([task]));
      },
      ...overrides,
    } as unknown as CommandChainDependencies;
    return {
      definition: createCommandChain("ai-reply-command", dependencies)!,
      calls,
      geminiClients,
      recordedMessages,
    };
  }

  test("罐头 Gemini 客户端装入后播种上下文、等待生成结算并记录打字停顿", async (): Promise<void> => {
    const { definition, calls, geminiClients, recordedMessages }: ReturnType<typeof aiReplyChain> = aiReplyChain({});
    await definition.prepare?.();
    const client: CannedGeminiClient = (geminiClients.current as Map<string, CannedGeminiClient>).get("text")!;
    const response: { readonly text: string } = await client.models.generateContent();
    expect(response.text).toBe("性能基准回复。");
    expect(recordedMessages).toHaveLength(2 * AI_REPLY_SEED_MESSAGES);
    await definition.run(0);
    expect(calls.get("sendMessage")).toBe(1);
    expect(definition.excludedNanoseconds?.()).toBe(350);
    expect(CHAIN_NAMES).toContain("ai-reply-command");
  });

  test("生成任务未排空或模型无输出未发出消息时使基准失败", async (): Promise<void> => {
    const stuckTasks: Map<number, Set<Promise<void>>> = new Map<number, Set<Promise<void>>>();
    const unsettled: ReturnType<typeof aiReplyChain> = aiReplyChain({
      replyGenerationTasks: stuckTasks as never,
      generateAndSendReply: ({ chatId }: { readonly chatId: number }): void => {
        stuckTasks.set(chatId, new Set<Promise<void>>([Promise.resolve()]));
      },
    });
    await unsettled.definition.prepare?.();
    await expect(unsettled.definition.run(0)).rejects.toThrow("never settled");

    const silent: ReturnType<typeof aiReplyChain> = aiReplyChain({
      generateAndSendReply: (): void => {},
    });
    await silent.definition.prepare?.();
    await expect(silent.definition.run(0)).rejects.toThrow("produced no outgoing message");
  });
});

describe("Mini App API 请求链路", () => {
  function miniAppChain(overrides: Partial<MiniAppChainDependencies>): {
    definition: ChainDefinition;
    seededJoinLogs: number;
    sessions: Map<string, unknown>;
    aiMemories: Map<number, { bufferedCount: number; summaryCount: number }>;
    qaEntries: Map<number, Map<string, string>>;
  } {
    const states: Map<number, ChatState> = new Map<number, ChatState>();
    const aiMemories: Map<number, { bufferedCount: number; summaryCount: number }> =
      new Map<number, { bufferedCount: number; summaryCount: number }>();
    const qaEntries: Map<number, Map<string, string>> = new Map<number, Map<string, string>>();
    const sessions: Map<string, unknown> = new Map<string, unknown>();
    let seededJoinLogs: number = 0;
    const dependencies: MiniAppChainDependencies = {
      chainMiniAppApiRequests: 2,
      botToken: "123456789:benchmark-token",
      superAdminUserId: 900_001,
      benchmarkChatId: (index: number): number => -1_000 - index,
      benchmarkUserId: (index: number): number => 10_000 + index,
      getOrCreateChatState: (chatId: number): ChatState => {
        let state: ChatState | undefined = states.get(chatId);
        if (state === undefined) {
          state = chatStateOf();
          states.set(chatId, state);
        }
        return state;
      },
      aiMemoryUsages: aiMemories as never,
      chatQaEntries: qaEntries as never,
      recordJoinLog: (): boolean => {
        seededJoinLogs += 1;
        return true;
      },
      flushDiskIODomain: async (): Promise<{ result: "flushed" }> => ({ result: "flushed" }),
      issueMiniAppAuthSession: (): Readonly<MiniAppAuthSession> => {
        const session: MiniAppAuthSession = {
          token: "bench-session-token",
          previousToken: undefined,
          createdAt: 1_000,
          expiresAt: 2_000,
        };
        sessions.set(session.token, session);
        return session;
      },
      miniAppAuthSessions: sessions as never,
      loadChatsBunRoutes: async () => ({
        "/api/chats": { GET: async (): Promise<Response> => Response.json({ items: [] }) },
        "/api/chats/:chatId": {
          GET: async (
            req: Request & { readonly params: Readonly<{ readonly chatId: string }> }
          ): Promise<Response> => {
            const chatId: number = Number(req.params.chatId);
            const joinedCountsByHour: number[] = new Array<number>(
              MINI_APP_BATCH_KICK_MAX_HOURS
            ).fill(0);
            joinedCountsByHour[0] = MINI_APP_API_SEED_JOIN_EVENTS_PER_CHAT;
            const detail: MiniAppChatDetail = {
              chatId,
              title: states.get(chatId)?.title ?? "",
              features: {
                init: true,
                aiChat: true,
                translation: false,
                adDetect: true,
                floodControl: true,
                antiRaid: true,
                proxySend: false,
              },
              hotMessageCount: aiMemories.get(chatId)?.bufferedCount ?? 0,
              hotMessageMax: AI_MEMORY_HYDRATE_BUFFER_MAX,
              qaPairCount: qaEntries.get(chatId)?.size ?? 0,
              isLockdownActive: false,
              quietRemainingMs: 0,
              lockdownRemainingMs: 0,
              botPermissions: null,
              translateTargetCount: 0,
              deleteMessageTargetCount: 0,
              joinedCountsByHour,
              batchKickRunning: false,
              lastBatchKickCompletion: null,
              activeSessions: {
                gag: 0,
                wed: false,
                verify: 0,
                qaSet: false,
              },
            };
            return Response.json({ detail });
          },
        },
      }) as never,
      ...overrides,
    };
    return {
      definition: createMiniAppChain("mini-app-api-request", dependencies)!,
      get seededJoinLogs(): number {
        return seededJoinLogs;
      },
      sessions,
      aiMemories,
      qaEntries,
    };
  }

  test("满规格受管群与入群日志播种后，从路由入口跑完请求并在 cleanup 清空会话与夹具缓存", async (): Promise<void> => {
    const built = miniAppChain({});
    expect(createMiniAppChain("join-log-append", {} as never)).toBeUndefined();
    await expect(built.definition.run(0)).rejects.toThrow("route was not prepared");
    await built.definition.prepare?.();
    expect(built.seededJoinLogs).toBe(
      STATE_MANAGED_CHAT_LIMIT * MINI_APP_API_SEED_JOIN_EVENTS_PER_CHAT
    );
    await built.definition.run(0);
    await built.definition.run(1);
    built.definition.cleanup?.();
    expect({
      sessions: built.sessions.size,
      aiMemories: built.aiMemories.size,
      qaEntries: built.qaEntries.size,
    }).toEqual({ sessions: 0, aiMemories: 0, qaEntries: 0 });
  });

  test("入群日志播种被拒、flush 失败、路由缺失、非 200 响应或详情载荷残缺均使基准失败", async (): Promise<void> => {
    const rejectedSeed = miniAppChain({
      recordJoinLog: (): boolean => false,
    });
    await expect(rejectedSeed.definition.prepare?.()).rejects.toThrow("join-log seed");

    const failedFlush = miniAppChain({
      flushDiskIODomain: async (): Promise<{ result: "timedOut" }> => ({ result: "timedOut" }),
    });
    await expect(failedFlush.definition.prepare?.()).rejects.toThrow("failed to flush seeded join logs");

    const missingRoute = miniAppChain({
      loadChatsBunRoutes: async () => ({}) as never,
    });
    await expect(missingRoute.definition.prepare?.()).rejects.toThrow("route is missing");

    const httpError = miniAppChain({
      loadChatsBunRoutes: async () => ({
        "/api/chats": { GET: async (): Promise<Response> => Response.json({ items: [] }) },
        "/api/chats/:chatId": {
          GET: async (): Promise<Response> => new Response("unauthorized", { status: 401 }),
        },
      }) as never,
    });
    await httpError.definition.prepare?.();
    await expect(httpError.definition.run(0)).rejects.toThrow("returned HTTP 401");

    const incompleteDetail = miniAppChain({
      loadChatsBunRoutes: async () => ({
        "/api/chats": { GET: async (): Promise<Response> => Response.json({ items: [] }) },
        "/api/chats/:chatId": {
          GET: async (
            req: Request & { readonly params: Readonly<{ readonly chatId: string }> }
          ): Promise<Response> =>
            Response.json({
              detail: {
                chatId: Number(req.params.chatId),
                qaPairCount: CHAT_QA_MAX_PER_CHAT,
                hotMessageCount: AI_MEMORY_HYDRATE_BUFFER_MAX,
                joinedCountsByHour: new Array<number>(
                  MINI_APP_BATCH_KICK_MAX_HOURS
                ).fill(0),
              },
            }),
        },
      }) as never,
    });
    await incompleteDetail.definition.prepare?.();
    await expect(incompleteDetail.definition.run(0)).rejects.toThrow("incomplete chat detail payload");
  });
});

import type { User } from "grammy/types";
import { WED_DRAW_ATTEMPTS, WED_DRAW_TRANSIENT_LIMIT } from "../../consts/wed";
import { readCurrentAvatar } from "../../infra/telegram/avatar/read";
import type { AvatarIdentity, CurrentAvatarResult } from "../../types/telegram";
import { wedAvatarProbes } from "../../cache/main/wed";
import type { WedAvatarProbe, WedCandidate, WedChat, WedSession } from "../../types/wed";
import { removeWedMemberFromAllChats } from "./persistence";

/**
 * getChat 以私聊资料核实过的候选转成图注与提及实体要用的 User；其它身份返回 undefined。
 * 候选 ID 只来自以个人身份发言的非机器人用户（commands/wed/members.ts），is_bot 恒为 false。
 * @param identity 读取头像时获取到的身份资料。
 * @returns 私聊用户对象；非私聊身份时返回 undefined。
 */
function privateChatUser(identity: AvatarIdentity): User | undefined {
  if (!("type" in identity) || identity.type !== "private") return undefined;
  return {
    id: identity.id,
    is_bot: false,
    first_name: identity.first_name,
    last_name: identity.last_name,
    username: identity.username,
  };
}

/**
 * 在群成员快照中无放回随机抽取带可用头像的候选人（更换按钮触发时排除当前已抽中目标；失败不改写会话）：
 * - **候选来源与头像读取**：候选仅取自 `memory/wed` 的已发言成员滑窗。抽中后按用户 ID 读取当前头像，
 *   图注与公开头像兜底所需的身份资料直接取自同一次 `getChat` 返回的私聊信息（不调用 `getChatMember`，不要求机器人为群管理员）。
 * - **不可达清理与离群边界**：`getChat` 明确返回找不到该私聊时，将该 ID 从全部群成员池移除（后续重新发言可再次加入）；
 *   常规离群清理由退群事件（`commands/wed/members.ts`）与每日复核（`commands/wed/memberReview.ts`）负责（非管理员群边界见 `docs/cn/04-invariants.md`）。
 * - **配额与预算**：仅当确认无可用头像或非私聊身份时消耗 `WED_DRAW_ATTEMPTS` 配额；瞬态查询失败不扣减该配额，
 *   但累计达 `WED_DRAW_TRANSIENT_LIMIT` 次即放弃本轮。`signal` 为抽取阶段独立预算（见 `commands/wed.ts` 的 `operationSignal`），
 *   超时、群 teardown 或停机取消均返回 `undefined`。
 *
 * @param session 当前 `/wed` 会话。
 * @param chat 所在群的 `/wed` 交互状态。
 * @param signal 抽取阶段中止信号。
 * @returns 抽中的带头像候选；未命中或被取消时返回 undefined。
 */
export async function drawWedCandidate(
  session: WedSession,
  chat: WedChat,
  signal: AbortSignal
): Promise<WedCandidate | undefined> {
  const candidates: number[] = [];
  for (const id of chat.members.keys()) {
    if (id !== session.actor.id && id !== session.targetId) candidates.push(id);
  }
  let examined: number = 0;
  let unfinished: number = 0;
  while (examined < WED_DRAW_ATTEMPTS && candidates.length > 0) {
    if (signal.aborted) return undefined;
    const index: number = Math.floor(Math.random() * candidates.length);
    const userId: number = candidates[index]!;
    candidates[index] = candidates[candidates.length - 1]!;
    candidates.pop();
    let probes: Set<WedAvatarProbe> | undefined = wedAvatarProbes.get(userId);
    if (probes === undefined) {
      probes = new Set<WedAvatarProbe>();
      wedAvatarProbes.set(userId, probes);
    }
    const probe: WedAvatarProbe = { observedChats: new Set<number>() };
    probes.add(probe);
    let avatar: CurrentAvatarResult;
    try {
      avatar = await readCurrentAvatar(userId, signal);
    } finally {
      probes.delete(probe);
      if (probes.size === 0) wedAvatarProbes.delete(userId);
    }
    if (avatar.status === "chat-not-found" && !signal.aborted && !chat.controller.signal.aborted) {
      removeWedMemberFromAllChats(userId, probe.observedChats);
    }
    if (avatar.status === "ok") {
      const identity: User | undefined = privateChatUser(avatar.identity);
      if (identity !== undefined) return signal.aborted ? undefined : { identity, photo: avatar.photo };
    } else if (avatar.status === "transient-failure") {
      if (++unfinished >= WED_DRAW_TRANSIENT_LIMIT) return undefined;
      continue;
    }
    examined++;
  }
  return undefined;
}

import { mkdir } from "node:fs/promises";
import {
  miniAppPendingTotpSetupHolder,
  miniAppTotpRecordHolder,
} from "../../cache/main/miniApp";
import { MINI_APP_PASSWORD_MAX_ATTEMPTS } from "../../consts/miniApp";
import {
  MINI_APP_TOTP_PENDING_TTL_MS,
  MINI_APP_TOTP_RECORD_VERSION,
} from "../../consts/miniAppTotp";
import {
  MINI_APP_TOTP_FILE_PATH,
  MINI_APP_TOTP_MEMORY_DIR,
} from "../../consts/paths";
import { RUNTIME_DATA_ROOT_MAX_MODE } from "../../consts/storage";
import { atomicWriteText, syncDirectory } from "../../libs/atomicFile";
import { isErrno } from "../../libs/errno";
import {
  buildMiniAppTotpUri,
  generateMiniAppTotpSecret,
  maskMiniAppTotpSecret,
  verifyMiniAppTotpCode,
} from "../../libs/miniAppTotp";
import { readMiniAppTotpFile } from "../../libs/miniAppTotpFile";
import { renderQrCodeSvg } from "../../libs/qrcodeSvg";
import type {
  MiniAppPendingTotpSetup,
  MiniAppTotpMutationResponse,
  MiniAppTotpRecord,
  MiniAppTotpSetupResponse,
  MiniAppTotpStatusView,
} from "../../types/miniAppTotp";

/**
 * 将内部 TOTP 记录转换为脱敏的前端状态视图。
 * @param record 内部持久化记录或 `null`。
 * @returns 前端可安全展示的状态摘要。
 */
function toMiniAppTotpStatusView(
  record: Readonly<MiniAppTotpRecord> | null
): Readonly<MiniAppTotpStatusView> {
  if (record === null) {
    return {
      enabled: false,
      createdAt: null,
      maskedSecret: null,
    };
  }
  return {
    enabled: true,
    createdAt: record.createdAt,
    maskedSecret: maskMiniAppTotpSecret(record.secret),
  };
}

/**
 * 从 `memory/mini-app-totp/totp.json` 读取并严格校验单条 TOTP 验证器记录（命中主线程缓存时直接返回）。
 * @param filePath 持久化文件路径（缺省为 `MINI_APP_TOTP_FILE_PATH`）。
 * @returns 已绑定的 TOTP 记录；尚未绑定时返回 `null`。
 */
export async function loadMiniAppTotpRecord(
  filePath: string = MINI_APP_TOTP_FILE_PATH
): Promise<Readonly<MiniAppTotpRecord> | null> {
  if (
    filePath === MINI_APP_TOTP_FILE_PATH &&
    miniAppTotpRecordHolder.current !== undefined
  ) {
    return miniAppTotpRecordHolder.current;
  }
  const record: Readonly<MiniAppTotpRecord> | null = await readMiniAppTotpFile(filePath);
  if (filePath === MINI_APP_TOTP_FILE_PATH) {
    miniAppTotpRecordHolder.current = record;
  }
  return record;
}

/**
 * 查询当前 TOTP 验证器的启用状态与脱敏摘要。
 * @returns 前端可安全展示的状态摘要。
 */
export async function getMiniAppTotpStatus(): Promise<
  Readonly<MiniAppTotpStatusView>
> {
  const record: Readonly<MiniAppTotpRecord> | null =
    await loadMiniAppTotpRecord();
  return toMiniAppTotpStatusView(record);
}

/**
 * 在前端控制台发起添加或修改验证器请求时，生成新的待确认 Base32 密钥与二维码 SVG 并暂存主线程。
 * @param superAdminUserId 超级管理员 Telegram 用户 ID。
 * @param nowMs 当前毫秒时间戳（缺省取 `Date.now()`）。
 * @returns 待绑定密钥、标准 `otpauth://` URI 与内联二维码 SVG。
 */
export function createPendingMiniAppTotpSetup(
  superAdminUserId: number,
  nowMs: number = Date.now()
): Readonly<MiniAppTotpSetupResponse> {
  const secret: string = generateMiniAppTotpSecret();
  const otpauthUri: string = buildMiniAppTotpUri(secret, superAdminUserId);
  const qrSvg: string = renderQrCodeSvg(otpauthUri);
  const expiresAt: number = nowMs + MINI_APP_TOTP_PENDING_TTL_MS;
  const pending: Readonly<MiniAppPendingTotpSetup> = {
    secret,
    otpauthUri,
    qrSvg,
    createdAt: nowMs,
    expiresAt,
    failedAttempts: 0,
  };
  miniAppPendingTotpSetupHolder.current = pending;
  return {
    ok: true,
    secret,
    otpauthUri,
    qrSvg,
    expiresAt,
  };
}

/**
 * 校验前端提交的 6 位动态码，通过后将待绑定密钥原子持久化到 `memory/mini-app-totp/totp.json`（覆盖已有单条记录）；
 * 若连续输错达到 `MINI_APP_PASSWORD_MAX_ATTEMPTS` 次则立即销毁待绑定密钥并返回过期状态。
 * @param code 用户在前端输入的 6 位 Google Authenticator 动态码。
 * @param nowMs 当前毫秒时间戳（缺省取 `Date.now()`）。
 * @returns 绑定/修改结果与最新验证器状态。
 */
export async function enableMiniAppTotpFromPending(
  code: string,
  nowMs: number = Date.now()
): Promise<Readonly<MiniAppTotpMutationResponse>> {
  const existing: Readonly<MiniAppTotpRecord> | null =
    await loadMiniAppTotpRecord();
  const pending: Readonly<MiniAppPendingTotpSetup> | null =
    miniAppPendingTotpSetupHolder.current;
  if (pending === null || nowMs > pending.expiresAt) {
    miniAppPendingTotpSetupHolder.current = null;
    return {
      ok: false,
      message: "TOTP_SETUP_EXPIRED",
      status: toMiniAppTotpStatusView(existing),
    };
  }
  if (!verifyMiniAppTotpCode(code, pending.secret, nowMs)) {
    const nextAttempts: number = pending.failedAttempts + 1;
    if (nextAttempts >= MINI_APP_PASSWORD_MAX_ATTEMPTS) {
      miniAppPendingTotpSetupHolder.current = null;
      return {
        ok: false,
        message: "TOTP_SETUP_EXPIRED",
        status: toMiniAppTotpStatusView(existing),
      };
    }
    miniAppPendingTotpSetupHolder.current = {
      ...pending,
      failedAttempts: nextAttempts,
    };
    return {
      ok: false,
      message: "INVALID_TOTP_CODE",
      status: toMiniAppTotpStatusView(existing),
    };
  }

  miniAppPendingTotpSetupHolder.current = null;
  const nextRecord: Readonly<MiniAppTotpRecord> = {
    version: MINI_APP_TOTP_RECORD_VERSION,
    secret: pending.secret,
    createdAt: nowMs,
  };
  await mkdir(MINI_APP_TOTP_MEMORY_DIR, {
    recursive: true,
    mode: RUNTIME_DATA_ROOT_MAX_MODE,
  });
  await atomicWriteText(
    MINI_APP_TOTP_FILE_PATH,
    `${JSON.stringify(nextRecord, null, 2)}\n`
  );
  miniAppTotpRecordHolder.current = nextRecord;
  return {
    ok: true,
    message: existing === null ? "TOTP_ENABLED" : "TOTP_UPDATED",
    status: toMiniAppTotpStatusView(nextRecord),
  };
}

/**
 * 删除 `memory/mini-app-totp/totp.json` 中的唯一验证器记录并清空内存缓存，恢复访问密码验证。
 * @returns 删除结果与最新验证器状态。
 */
export async function deleteMiniAppTotpRecord(): Promise<
  Readonly<MiniAppTotpMutationResponse>
> {
  miniAppPendingTotpSetupHolder.current = null;
  miniAppTotpRecordHolder.current = null;
  try {
    await Bun.file(MINI_APP_TOTP_FILE_PATH).delete();
    await syncDirectory(MINI_APP_TOTP_FILE_PATH);
  } catch (error: unknown) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  return {
    ok: true,
    message: "TOTP_DELETED",
    status: toMiniAppTotpStatusView(null),
  };
}

/**
 * 清空主线程中的 TOTP 记录与待确认绑定状态（供服务停止或测试隔离重置调用）。
 */
export function resetMiniAppTotpMemoryCache(): void {
  miniAppTotpRecordHolder.current = undefined;
  miniAppPendingTotpSetupHolder.current = null;
}

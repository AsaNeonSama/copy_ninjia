/**
 * Mini App 登录阶段临时 X25519 握手与每次启动内存 Ed25519 签名签发/核销管理：
 * - `ensureMiniAppRuntimeSigningKeyPair` / `clearMiniAppRuntimeSigningKeyPair`：管理本次服务启动在内存中生成的不可导出 Ed25519 签名密钥对；
 * - `issueMiniAppAuthHandshake`：在 `GET /api/auth/precheck` 核验超管 `initData` 后生成临时 X25519 公私钥并用本次启动 Ed25519 私钥签名；
 * - `acquireMiniAppAuthHandshake` / `releaseMiniAppAuthHandshakeInFlight` / `consumeMiniAppAuthHandshake`：
 *   为 `POST /api/auth/login` 提供防并发重放锁定与用完即焚的一次性消费语义。
 */

import {
  miniAppAuthHandshakes,
  miniAppInFlightHandshakeIds,
  miniAppRuntimeSigningKeyHolder,
} from "../../cache/main/miniApp";
import {
  MINI_APP_HANDSHAKE_ID_BYTES,
  MINI_APP_HANDSHAKE_ID_HEX_PATTERN,
  MINI_APP_HANDSHAKE_TTL_MS,
} from "../../consts/miniAppCrypto";
import type {
  MiniAppAuthHandshakeOffer,
  MiniAppAuthHandshakeRecord,
  MiniAppRuntimeSigningKeyPair,
} from "../../types/miniApp/auth";
import { generateMiniAppRandomHex } from "../libs/crypto";
import {
  generateMiniAppEd25519KeyPair,
  generateMiniAppX25519KeyPair,
  signMiniAppHandshakeOffer,
} from "../libs/handshakeCrypto";

/**
 * 清理已超过 `MINI_APP_HANDSHAKE_TTL_MS` 有效期的未消费临时 X25519 登录握手记录。
 * @param nowMs 当前毫秒时间戳。
 */
function purgeExpiredMiniAppAuthHandshakes(nowMs: number): void {
  if (miniAppAuthHandshakes.size === 0) {
    return;
  }
  miniAppAuthHandshakes.forEach(
    (record: Readonly<MiniAppAuthHandshakeRecord>, handshakeId: string): void => {
      if (record.expiresAt <= nowMs) {
        miniAppAuthHandshakes.delete(handshakeId);
      }
    }
  );
}

/**
 * 获取或触发生成主线程本次启动独占的内存 Ed25519 签名密钥对（并发调用共享同一生成 `Promise`，不落盘、不可导出私钥）。
 * @returns 本次启动内存生成的 Ed25519 私钥句柄与 32 字节原始公钥标准 Base64。
 */
export function ensureMiniAppRuntimeSigningKeyPair(): Promise<
  Readonly<MiniAppRuntimeSigningKeyPair>
> {
  if (miniAppRuntimeSigningKeyHolder.current !== null) {
    return miniAppRuntimeSigningKeyHolder.current;
  }
  const pending: Promise<Readonly<MiniAppRuntimeSigningKeyPair>> =
    generateMiniAppEd25519KeyPair().catch((error: unknown): never => {
      if (miniAppRuntimeSigningKeyHolder.current === pending) {
        miniAppRuntimeSigningKeyHolder.current = null;
      }
      throw error;
    });
  miniAppRuntimeSigningKeyHolder.current = pending;
  return pending;
}

/**
 * 清空主线程当前持有的启动 Ed25519 签名密钥对句柄，使下次启动或按需访问重新生成全新密钥对（停机或测试隔离重置时调用）。
 */
export function clearMiniAppRuntimeSigningKeyPair(): void {
  miniAppRuntimeSigningKeyHolder.current = null;
}

/**
 * 生成一把临时 X25519 公私钥，使用本次启动内存 Ed25519 私钥对握手抄本签名后写入主线程缓存并返回公开凭据。
 * @param nowMs 当前毫秒时间戳。
 * @returns 带 `handshakeId`、`serverPublicKey`、`expiresAt` 与 64 字节 Ed25519 `signature` 的握手凭据。
 */
export async function issueMiniAppAuthHandshake(
  nowMs: number = Date.now()
): Promise<Readonly<MiniAppAuthHandshakeOffer>> {
  purgeExpiredMiniAppAuthHandshakes(nowMs);
  const handshakeId: string = generateMiniAppRandomHex(MINI_APP_HANDSHAKE_ID_BYTES);
  const expiresAt: number = nowMs + MINI_APP_HANDSHAKE_TTL_MS;
  const x25519KeyPair: Readonly<{ privateKey: CryptoKey; publicKeyBase64: string }> =
    await generateMiniAppX25519KeyPair();
  const runtimeSigningKey: Readonly<MiniAppRuntimeSigningKeyPair> =
    await ensureMiniAppRuntimeSigningKeyPair();
  const unsignedOffer: Omit<MiniAppAuthHandshakeOffer, "signature"> = {
    handshakeId,
    serverPublicKey: x25519KeyPair.publicKeyBase64,
    expiresAt,
  };
  const signature: string = await signMiniAppHandshakeOffer(
    runtimeSigningKey.privateKey,
    unsignedOffer
  );
  const record: Readonly<MiniAppAuthHandshakeRecord> = {
    handshakeId,
    serverPrivateKey: x25519KeyPair.privateKey,
    serverPublicKey: x25519KeyPair.publicKeyBase64,
    createdAt: nowMs,
    expiresAt,
  };
  miniAppAuthHandshakes.set(handshakeId, record);
  return {
    ...unsignedOffer,
    signature,
  };
}

/**
 * 按 `handshakeId` 查找未过期且未处于并发登录中的临时 X25519 握手记录，并同步登记在途锁。
 * 调用方在 `finally` 中必须调用 `releaseMiniAppAuthHandshakeInFlight`，并在进入凭据校验与会话签发时调用 `consumeMiniAppAuthHandshake`。
 * @param handshakeId 请求提交的 32 位十六进制握手 ID。
 * @param nowMs 当前毫秒时间戳。
 * @returns 命中且锁定成功时返回握手记录；格式非法、过期、已消费或正在并发消费时返回 `null`。
 */
export function acquireMiniAppAuthHandshake(
  handshakeId: string,
  nowMs: number = Date.now()
): Readonly<MiniAppAuthHandshakeRecord> | null {
  const normalizedId: string = handshakeId.trim().toLowerCase();
  if (!MINI_APP_HANDSHAKE_ID_HEX_PATTERN.test(normalizedId)) {
    return null;
  }
  purgeExpiredMiniAppAuthHandshakes(nowMs);
  if (miniAppInFlightHandshakeIds.has(normalizedId)) {
    return null;
  }
  const record: Readonly<MiniAppAuthHandshakeRecord> | undefined =
    miniAppAuthHandshakes.get(normalizedId);
  if (record === undefined || record.expiresAt <= nowMs) {
    return null;
  }
  miniAppInFlightHandshakeIds.add(normalizedId);
  return record;
}

/**
 * 释放指定登录握手 `handshakeId` 的在途并发锁。
 * @param handshakeId 32 位十六进制握手 ID。
 */
export function releaseMiniAppAuthHandshakeInFlight(handshakeId: string): void {
  miniAppInFlightHandshakeIds.delete(handshakeId.trim().toLowerCase());
}

/**
 * 在提交二次认证校验或会话签发前核销并删除指定临时 X25519 握手记录，同时清除在途并发锁（用完即焚）。
 * 若异步 ECDH 派生与解密窗口内记录已被吊销（如 TOTP 变更、锁定或过期淘汰），则返回 `false`。
 * @param handshakeId 待核销的 32 位十六进制握手 ID。
 * @returns 原记录仍存在并由本次调用删除时返回 `true`，否则返回 `false`。
 */
export function consumeMiniAppAuthHandshake(handshakeId: string): boolean {
  const normalizedId: string = handshakeId.trim().toLowerCase();
  miniAppInFlightHandshakeIds.delete(normalizedId);
  return miniAppAuthHandshakes.delete(normalizedId);
}

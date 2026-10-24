import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LUCK_RECEIPT_SECRET_PATTERN } from "../../consts/luckReceipt";
import { LUCK_RECEIPT_SECRET_PATH } from "../../consts/paths";
import { PERSISTED_FILE_MODE } from "../../consts/diskIO/common";
import { atomicWriteTextSync } from "../../libs/atomicFile";
import { invalidInput, readJsonInput } from "../../libs/inputValidation";
import { inspectOptionalFile } from "../../libs/fileAccess";
import { hasExactKeys, isPlainRecord } from "../../libs/record";
import { isCanonicalDateKey } from "../../libs/time";
import type { LuckReceiptSecret } from "../../types/diskIO/storage";

/** 运势回执密钥文件的随机生成与写盘 I/O 抽象。 */
export interface LuckSecretFileIO {
  /** 生成 32 字节密码学安全随机密钥的回调。 */
  generateKey: () => Uint8Array;
  /** 以指定权限模式原子写入文本文件的回调。 */
  writeText: (path: string, content: string, mode: number) => void;
}

/**
 * 用 Bun 支持的 Web Crypto CSPRNG 生成日级密钥字节。
 * @returns 32 字节的密码学安全随机字节数组。
 */
function generateLuckReceiptKey(): Uint8Array {
  const key: Uint8Array = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

const DEFAULT_IO: LuckSecretFileIO = {
  generateKey: generateLuckReceiptKey,
  writeText: atomicWriteTextSync,
};

/**
 * 严格解码运势回执密钥对象。
 * @param value JSON.parse 产出的候选值。
 * @param path 密钥文件路径（用于构造错误消息）。
 * @returns 校验通过的日级运势回执密钥记录。
 */
function decodeLuckReceiptSecret(value: unknown, path: string): LuckReceiptSecret {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["version", "day", "key"])) {
    return invalidInput(path, "$", "exactly { version, day, key }");
  }
  if (value.version !== 1) return invalidInput(path, "$.version", "1");
  if (
    typeof value.day !== "string" ||
    !isCanonicalDateKey(value.day)
  ) return invalidInput(path, "$.day", "a canonical YYYY-MM-DD date");
  const expectedKey: string = "a canonical base64url encoding of 32 bytes";
  if (typeof value.key !== "string" || !LUCK_RECEIPT_SECRET_PATTERN.test(value.key)) {
    return invalidInput(path, "$.key", expectedKey);
  }
  const decoded: Uint8Array = Uint8Array.fromBase64(value.key, { alphabet: "base64url" });
  if (
    decoded.length !== 32 ||
    decoded.toBase64({ alphabet: "base64url", omitPadding: true }) !== value.key
  ) {
    return invalidInput(path, "$.key", expectedKey);
  }
  return { version: 1, day: value.day, key: value.key };
}

/**
 * 生成指定日期的新运势回执密钥并原子写入磁盘。
 * @param day 目标 `YYYY-MM-DD` 日期键。
 * @param path 密钥文件写入路径。
 * @param io 密钥生成与原子写入接口。
 * @returns 新生成并落盘的运势回执密钥记录。
 */
function newSecret(day: string, path: string, io: LuckSecretFileIO): LuckReceiptSecret {
  const generated: Uint8Array = io.generateKey();
  if (generated.length !== 32) throw new Error("Luck receipt key generator must return exactly 32 bytes");
  const secret: LuckReceiptSecret = {
    version: 1,
    day,
    key: generated.toBase64({ alphabet: "base64url", omitPadding: true }),
  };
  io.writeText(path, `${JSON.stringify(secret, null, 2)}\n`, PERSISTED_FILE_MODE);
  return secret;
}

/** 恢复日级运势密钥所需的目标日期、已确认结果数与可替换 I/O。 */
export interface RecoverLuckReceiptSecretParams {
  /** 目标 `YYYY-MM-DD` 日期键。 */
  day: string;
  /** 当日已确认的运势抽签结果条数。 */
  confirmedResultCount: number;
  /** 密钥文件路径；缺省为 `LUCK_RECEIPT_SECRET_PATH`。 */
  path?: string;
  /** 可替换的密钥生成与写盘 I/O 实现。 */
  io?: LuckSecretFileIO;
}

/** 运势回执密钥启动只读探测结果。 */
export interface LuckSecretRecoveryInspection {
  /** 目标日期键（`YYYY-MM-DD`）。 */
  readonly day: string;
  /** 密钥文件绝对路径。 */
  readonly path: string;
  /** 已存在的当日有效密钥记录；需要新建或轮换时为 `null`。 */
  readonly secret: LuckReceiptSecret | null;
}

/**
 * 已有确认结果时，密钥缺失或属于旧日代表备份不一致：拒绝创建并保留现场，
 * 要求人工恢复一致备份。
 * @param confirmedResultCount 当日已确认的运势抽签结果条数。
 * @param path 密钥文件路径（用于构造错误消息）。
 */
function assertSecretCanBeCreated(
  confirmedResultCount: number,
  path: string
): void {
  if (confirmedResultCount === 0) return;
  return invalidInput(path, "$", "present for the same day as the confirmed luck state");
}

/**
 * 加载当天密钥；仅在当天尚无确认结果时允许首次创建或从旧日原子轮换。
 * 损坏、未来日期、字段异常及“已有结果但密钥缺失/过期”一律拒绝，不覆盖现有密钥。
 * @param params 目标日期、当日已确认结果数与可选密钥路径。
 * @returns 只读探测结果；需新建或轮换当日密钥时 `secret` 为 null。
 */
export async function inspectLuckReceiptSecret(
  {
    day,
    confirmedResultCount,
    path = LUCK_RECEIPT_SECRET_PATH,
  }: RecoverLuckReceiptSecretParams
): Promise<LuckSecretRecoveryInspection> {
  if (!isCanonicalDateKey(day)) {
    throw new Error("Luck receipt target day must be a canonical YYYY-MM-DD date.");
  }
  if (!Number.isSafeInteger(confirmedResultCount) || confirmedResultCount < 0) {
    throw new Error(`Invalid confirmed luck result count for ${day}: ${confirmedResultCount}`);
  }
  if (!inspectOptionalFile(path)) {
    assertSecretCanBeCreated(confirmedResultCount, path);
    return { day, path, secret: null };
  }

  const secret: LuckReceiptSecret = decodeLuckReceiptSecret(await readJsonInput(path), path);
  if (secret.day > day) {
    return invalidInput(path, "$.day", "no later than the current configured local day");
  }
  if (secret.day < day) {
    assertSecretCanBeCreated(confirmedResultCount, path);
    return { day, path, secret: null };
  }
  return { day, path, secret };
}

/**
 * 全域严格 inspect 成功后接管已有密钥，或按首次创建语义生成当天密钥。
 * @param inspection 只读探测阶段产出的密钥状态。
 * @param io 密钥生成与写盘 I/O 实现；缺省为生产实现。
 * @returns 接管或新生成的当日运势回执密钥。
 */
export function adoptLuckReceiptSecret(
  inspection: LuckSecretRecoveryInspection,
  io: LuckSecretFileIO = DEFAULT_IO
): LuckReceiptSecret {
  if (inspection.secret !== null) return inspection.secret;
  mkdirSync(dirname(inspection.path), { recursive: true });
  return newSecret(inspection.day, inspection.path, io);
}

/**
 * 单领域恢复入口；跨域启动编排使用 inspect/adopt 两阶段 API。
 * @param params 目标日期、当日已确认结果数与可选路径/I/O。
 * @returns 恢复或新生成的当日运势回执密钥。
 */
export async function recoverLuckReceiptSecret(
  params: RecoverLuckReceiptSecretParams
): Promise<LuckReceiptSecret> {
  return adoptLuckReceiptSecret(
    await inspectLuckReceiptSecret(params),
    params.io ?? DEFAULT_IO
  );
}

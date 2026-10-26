import { MINI_APP_WEB_APP_DATA_SECRET_SEED } from "../../packages/consts/miniApp";

/**
 * 构造已按 Telegram WebApp 规范 HMAC-SHA256 签名的测试用 `initData` 查询字符串。
 * @param params 签名参数。
 * @returns URLSearchParams 编码后的 `initData`。
 */
export function buildSignedTestInitData(params: {
  readonly botToken: string;
  readonly authDate: number;
  readonly user?: Readonly<Record<string, unknown>>;
  readonly extra?: Readonly<Record<string, string>>;
}): string {
  const entries: Map<string, string> = new Map<string, string>();
  entries.set("auth_date", String(params.authDate));
  if (params.user !== undefined) {
    entries.set("user", JSON.stringify(params.user));
  }
  if (params.extra !== undefined) {
    for (const [k, v] of Object.entries(params.extra)) {
      entries.set(k, v);
    }
  }
  const sortedLines: string[] = [...entries.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  const dataCheckString: string = sortedLines.join("\n");
  const secretKey: Uint8Array = new Bun.CryptoHasher(
    "sha256",
    MINI_APP_WEB_APP_DATA_SECRET_SEED
  )
    .update(params.botToken, "utf8")
    .digest();
  const hashHex: string = new Bun.CryptoHasher("sha256", secretKey)
    .update(dataCheckString, "utf8")
    .digest("hex");

  const searchParams: URLSearchParams = new URLSearchParams();
  for (const [k, v] of entries) {
    searchParams.set(k, v);
  }
  searchParams.set("hash", hashHex);
  return searchParams.toString();
}

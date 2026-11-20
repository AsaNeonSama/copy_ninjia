/**
 * 基准测试构造 Telegram WebApp HMAC-SHA256 签名 `initData` 的纯辅助函数。
 * 保持零 `packages/` 运行时导入，以便 `hotPaths` 与 `fullSuite` 共用。
 */

/**
 * 构造已按 Telegram WebApp 规范 HMAC-SHA256 签名的超管 `initData` 查询字符串。
 *
 * @param secretKey 已派生的 `initData` HMAC-SHA256 密钥
 * @param superAdminUserId 超管 Telegram 用户 ID
 * @param authDate 秒级签发时间戳
 * @returns URLSearchParams 编码后的 `initData`
 */
export function buildBenchmarkSignedInitData(
  secretKey: Uint8Array,
  superAdminUserId: number,
  authDate: number
): string {
  const userJson: string = JSON.stringify({
    id: superAdminUserId,
    first_name: "SuperAdmin",
    username: "super_admin",
  });
  const dataCheckString: string = `auth_date=${authDate}\nuser=${userJson}`;
  const hashHex: string = new Bun.CryptoHasher("sha256", secretKey)
    .update(dataCheckString, "utf8")
    .digest("hex");
  const searchParams: URLSearchParams = new URLSearchParams();
  searchParams.set("auth_date", String(authDate));
  searchParams.set("user", userJson);
  searchParams.set("hash", hashHex);
  return searchParams.toString();
}

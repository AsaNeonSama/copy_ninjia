/**
 * 把可导出的私钥编码成 PKCS#8 PEM 文本，供隔离测试构造凭据样本。
 *
 * @param privateKey 以 extractable 生成的私钥
 * @returns PEM 格式的 PKCS#8 私钥字符串
 */
export async function pkcs8PrivateKeyPem(privateKey: CryptoKey): Promise<string> {
  const bytes: Uint8Array = new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey));
  return `-----BEGIN PRIVATE KEY-----\n${bytes.toBase64().match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

/**
 * 生成只供隔离测试使用的 PKCS#8 RSA 私钥 PEM 文本，不读取任何部署凭据。
 *
 * @returns PEM 格式的 2048 位 RSA 私钥字符串
 */
export async function rsaPrivateKeyPemFixture(): Promise<string> {
  const key: CryptoKeyPair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5", modulusLength: 2_048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256",
  }, true, ["sign", "verify"]);
  return pkcs8PrivateKeyPem(key.privateKey);
}

/**
 * 生成只供隔离测试使用的 RSA 服务账号文档，不读取任何部署凭据。
 *
 * @returns 序列化后的 `g-auth.json` 测试夹具文本
 */
export async function googleAuthFixture(): Promise<string> {
  const pem: string = await rsaPrivateKeyPemFixture();
  return JSON.stringify({ type: "service_account", client_email: "migration@example.invalid", private_key: pem, project_id: "migration-test" }, null, 2) + "\n";
}

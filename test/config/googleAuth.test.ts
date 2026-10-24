import { expect, test } from "bun:test";
import { parseGoogleServiceAccountKey } from "../../packages/config/googleAuth";
import type { GoogleServiceAccountKey } from "../../packages/types/config";
import { pkcs8PrivateKeyPem, rsaPrivateKeyPemFixture } from "../../scripts/fixtures/googleAuth";

const privateKey: string = await rsaPrivateKeyPemFixture();
const minimal: Readonly<{ client_email: string; private_key: string }> = {
  client_email: "bot@example.iam.gserviceaccount.com",
  private_key: privateKey,
};
const source: string = "/fixture/g-auth.json";

test("最小凭据缺省 type，完整服务账号元数据均无损保留", (): void => {
  expect(parseGoogleServiceAccountKey(minimal, source)).toEqual(minimal);
  const full: GoogleServiceAccountKey & Readonly<{ client_id: string; auth_uri: string }> = {
    ...minimal, type: "service_account", private_key_id: "key", project_id: "project",
    quota_project_id: "quota", universe_domain: "googleapis.com", client_id: "123", auth_uri: "https://accounts.google.com/o/oauth2/auth",
  };
  expect(parseGoogleServiceAccountKey(full, source)).toEqual(full);
});

test("已知字符串字段按首尾空白规范化返回；PEM 私钥按原文交给 SDK", (): void => {
  const padded = {
    ...minimal, type: " service_account ", client_email: `  ${minimal.client_email}\n`,
    project_id: " project ", auth_uri: " https://accounts.google.com/o/oauth2/auth ",
  };
  expect(parseGoogleServiceAccountKey(padded, source)).toEqual({
    ...padded, type: "service_account", client_email: minimal.client_email, project_id: "project",
  });
});

test("可解析的 EC 与 Ed25519 密钥不满足 RS256", async (): Promise<void> => {
  const keys: readonly CryptoKeyPair[] = [
    await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
    await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair,
  ];
  for (const key of keys) {
    const pem: string = await pkcs8PrivateKeyPem(key.privateKey);
    expect(() => parseGoogleServiceAccountKey({ ...minimal, private_key: pem }, source))
      .toThrow(`${source}: $.private_key must be an RSA PEM private key for RS256.`);
  }
});

test("RSA-PSS 算法标识的 PEM 不作为 RS256 凭据接受", (): void => {
  const der: Uint8Array = Uint8Array.fromBase64(privateKey.replace(/-----[^-]+-----|\s/gu, ""));
  const rsaOid: string = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]).toHex();
  const hexOffset: number = der.toHex().indexOf(rsaOid);
  expect(hexOffset).toBeGreaterThan(0);
  expect(hexOffset % 2).toBe(0);
  // 相同 RSA 私钥材料使用 id-RSASSA-PSS 算法标识；Bun 不支持时在解析阶段拒绝。
  der[(hexOffset + rsaOid.length) / 2 - 1] = 0x0a;
  const pem: string = `-----BEGIN PRIVATE KEY-----\n${der.toBase64()}\n-----END PRIVATE KEY-----`;
  expect(() => parseGoogleServiceAccountKey({ ...minimal, private_key: pem }, source)).toThrow(`${source}: $.private_key must be`);
});

const assertReadonly = (): void => {
  const parsed: GoogleServiceAccountKey = parseGoogleServiceAccountKey(minimal, source);
  // @ts-expect-error 部署解析结果对调用方只读。
  parsed.private_key = "changed";
};
void assertReadonly;

for (const field of ["private_key_id", "project_id", "quota_project_id", "universe_domain"]) {
  for (const value of [null, false, 123, {}, [], "", "   "]) {
    test(`${field} 存在时严格校验类型与空值`, (): void => {
      expect((): GoogleServiceAccountKey => parseGoogleServiceAccountKey({ ...minimal, [field]: value }, source))
        .toThrow(`${source}: $.${field} must be a non-empty string.`);
    });
  }
}

test("错误只包含路径、字段与期望，不包含密钥或错误类型原值", (): void => {
  expect((): GoogleServiceAccountKey => parseGoogleServiceAccountKey({ ...minimal, type: "private_marker" }, source))
    .toThrow(`${source}: $.type must be "service_account".`);
  expect((): GoogleServiceAccountKey => parseGoogleServiceAccountKey({ ...minimal, private_key: "private_marker" }, source))
    .toThrow(`${source}: $.private_key must be a parseable non-empty PEM private key.`);
});

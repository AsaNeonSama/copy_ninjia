import { describe, expect, test } from "bun:test";
import { parseAllowedHttpsUrl, parseHttpsUrlWithoutCredentials } from "../../packages/libs/httpUrlPolicy";
import type { AllowedHttpsUrlPolicy } from "../../packages/libs/httpUrlPolicy";

describe("parseHttpsUrlWithoutCredentials", () => {
  test("仅接受不含凭据的 HTTPS URL，拒绝非 https、带凭据与非法地址", () => {
    expect(parseHttpsUrlWithoutCredentials("https://example.com/a?b=1")?.href)
      .toBe("https://example.com/a?b=1");
    const input: URL = new URL("https://example.com/x");
    const parsed: URL | null = parseHttpsUrlWithoutCredentials(input);
    expect(parsed?.href).toBe(input.href);
    expect(parsed).not.toBe(input);
    expect(parseHttpsUrlWithoutCredentials("http://example.com/a")).toBeNull();
    expect(parseHttpsUrlWithoutCredentials("https://user@example.com/a")).toBeNull();
    expect(parseHttpsUrlWithoutCredentials("https://:pass@example.com/a")).toBeNull();
    expect(parseHttpsUrlWithoutCredentials("not-a-url")).toBeNull();
  });
});

describe("HTTPS URL allowlist", () => {
  test("origin 精确匹配并拒绝协议、凭据和近似主机", () => {
    const policy: AllowedHttpsUrlPolicy = { allowedOrigins: ["https://api.example.com"] };
    expect(parseAllowedHttpsUrl({ input: "https://api.example.com/data", policy })?.href)
      .toBe("https://api.example.com/data");
    expect(parseAllowedHttpsUrl({ input: "http://api.example.com/data", policy })).toBeNull();
    expect(parseAllowedHttpsUrl({ input: "https://user:pass@api.example.com/data", policy })).toBeNull();
    expect(parseAllowedHttpsUrl({ input: "https://api.example.com.evil.test/data", policy })).toBeNull();
  });

  test("域后缀按 DNS label 边界匹配且不开放自定义端口", () => {
    const policy: AllowedHttpsUrlPolicy = { allowedHostnameSuffixes: ["telesco.pe"] };
    expect(parseAllowedHttpsUrl({ input: "https://cdn1.telesco.pe/file/avatar.jpg", policy })?.hostname)
      .toBe("cdn1.telesco.pe");
    expect(parseAllowedHttpsUrl({ input: "https://telesco.pe/file/avatar.jpg", policy })?.hostname)
      .toBe("telesco.pe");
    expect(parseAllowedHttpsUrl({ input: "https://eviltelesco.pe/file/avatar.jpg", policy })).toBeNull();
    expect(parseAllowedHttpsUrl({ input: "https://telesco.pe.evil.test/file/avatar.jpg", policy })).toBeNull();
    expect(parseAllowedHttpsUrl({ input: "https://cdn1.telesco.pe:444/file/avatar.jpg", policy })).toBeNull();
  });

  test("解析不了的地址返回 null；传入 URL 对象时返回同址的新对象", () => {
    const policy: AllowedHttpsUrlPolicy = { allowedOrigins: ["https://api.example.com"] };
    expect(parseAllowedHttpsUrl({ input: "not a url", policy })).toBeNull();
    expect(parseAllowedHttpsUrl({ input: "https://[::1", policy })).toBeNull();
    const input: URL = new URL("https://api.example.com/data?q=1");
    const parsed: URL | null = parseAllowedHttpsUrl({ input, policy });
    expect(parsed?.href).toBe(input.href);
    expect(parsed).not.toBe(input);
  });
});

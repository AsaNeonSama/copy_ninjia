import { describe, expect, test } from "bun:test";
import { parseAllowedHttpsUrl } from "../../packages/libs/httpUrlPolicy";
import type { AllowedHttpsUrlPolicy } from "../../packages/libs/httpUrlPolicy";

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

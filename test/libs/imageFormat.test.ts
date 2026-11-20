import { describe, expect, test } from "bun:test";
import { sniffImageFormat } from "../../packages/libs/imageFormat";

describe("libs/imageFormat sniffImageFormat", () => {
  test("识别 jpeg/png/webp/gif87a/gif89a 的文件头魔数", () => {
    expect(sniffImageFormat(new Uint8Array([0xff, 0xd8, 0xff]))).toBe("jpeg");
    expect(sniffImageFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(sniffImageFormat(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("webp");
    expect(sniffImageFormat(new TextEncoder().encode("GIF87a"))).toBe("gif");
    expect(sniffImageFormat(new TextEncoder().encode("GIF89a"))).toBe("gif");
  });

  test("未知字节与过短输入返回 unknown，子视图只读可见范围", () => {
    expect(sniffImageFormat(new Uint8Array(0))).toBe("unknown");
    expect(sniffImageFormat(new Uint8Array([0xff, 0xd8]))).toBe("unknown");
    expect(sniffImageFormat(new TextEncoder().encode("GIF88a"))).toBe("unknown");
    const padded: Uint8Array = new Uint8Array([0, 0xff, 0xd8, 0xff, 0]);
    expect(sniffImageFormat(padded)).toBe("unknown");
    expect(sniffImageFormat(padded.subarray(1, 4))).toBe("jpeg");
  });
});

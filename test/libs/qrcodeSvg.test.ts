import { describe, expect, test } from "bun:test";
import { QR_L_MAX_BYTES } from "../../packages/consts/miniAppTotp";
import { renderQrCodeSvg } from "../../packages/libs/qrcodeSvg";

const MAX_BYTES: number = QR_L_MAX_BYTES[QR_L_MAX_BYTES.length - 1]!;

describe("libs/qrcodeSvg", () => {
  test("容量上限内（含 192 字节边界）正常输出内联 SVG", () => {
    const svg: string = renderQrCodeSvg("a".repeat(MAX_BYTES));
    expect(svg.startsWith("<svg")).toBeTrue();
    expect(svg.endsWith("</svg>")).toBeTrue();
    expect(svg).toContain('<path d="M');
  });

  test("UTF-8 负载超过最大支持容量时 fail-fast 抛出 RangeError", () => {
    expect((): string => renderQrCodeSvg("a".repeat(MAX_BYTES + 1))).toThrow(RangeError);
    // 多字节 UTF-8 字符数未超上限但字节数超限时同样拒绝。
    const multibyte: string = "中".repeat(Math.floor(MAX_BYTES / 3) + 1);
    expect(multibyte.length).toBeLessThan(MAX_BYTES);
    expect((): string => renderQrCodeSvg(multibyte)).toThrow(RangeError);
    expect((): string => renderQrCodeSvg("x".repeat(400))).toThrow(RangeError);
  });
});

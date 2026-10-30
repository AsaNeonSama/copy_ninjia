import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MINI_APP_TOTP_RECORD_VERSION,
  MINI_APP_TOTP_SECRET_PATTERN,
} from "../../packages/consts/miniAppTotp";
import { InputValidationError } from "../../packages/libs/inputValidation";
import {
  decodeMiniAppTotpFile,
  readMiniAppTotpFile,
} from "../../packages/libs/miniAppTotpFile";

describe("Mini App TOTP 持久化文件严格解析", () => {
  const validSecret: string = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  let dir: string;
  let totpPath: string;

  beforeEach((): void => {
    dir = mkdtempSync(join(tmpdir(), "mini-app-totp-file-"));
    totpPath = join(dir, "totp.json");
  });

  afterEach((): void => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("文件不存在时返回 null，合法文件返回规范化记录", async (): Promise<void> => {
    expect(await readMiniAppTotpFile(totpPath)).toBeNull();

    await Bun.write(
      totpPath,
      JSON.stringify({
        version: MINI_APP_TOTP_RECORD_VERSION,
        secret: `  ${validSecret}  `,
        createdAt: 1_700_000_000_000,
      })
    );
    expect(await readMiniAppTotpFile(totpPath)).toEqual({
      version: MINI_APP_TOTP_RECORD_VERSION,
      secret: validSecret,
      createdAt: 1_700_000_000_000,
    });
  });

  test("符号链接（含悬空符号链接）与目录均抛出 InputValidationError", async (): Promise<void> => {
    const targetPath: string = join(dir, "real-totp.json");
    symlinkSync(targetPath, totpPath);
    await expect(readMiniAppTotpFile(totpPath)).rejects.toThrow(
      new InputValidationError(totpPath, "$", "a regular file, not a symbolic link")
    );

    rmSync(totpPath, { force: true });
    mkdirSync(totpPath);
    await expect(readMiniAppTotpFile(totpPath)).rejects.toThrow(
      new InputValidationError(totpPath, "$", "a regular file, not a symbolic link")
    );
  });

  test("非法 UTF-8 与非法 JSON 抛出 InputValidationError", async (): Promise<void> => {
    await Bun.write(totpPath, new Uint8Array([0xff, 0xfe]));
    await expect(readMiniAppTotpFile(totpPath)).rejects.toThrow(
      new InputValidationError(totpPath, "$", "a regular file readable as strictly valid UTF-8 text")
    );

    await Bun.write(totpPath, "{broken");
    await expect(readMiniAppTotpFile(totpPath)).rejects.toThrow(
      new InputValidationError(totpPath, "$", "valid JSON")
    );
  });

  test("顶层非对象、未知键及字段非法均抛出精确 InputValidationError 且不回显密钥", (): void => {
    expect((): unknown => decodeMiniAppTotpFile([], totpPath)).toThrow(
      new InputValidationError(totpPath, "$", "an object with only version, secret, and createdAt")
    );

    expect((): unknown =>
      decodeMiniAppTotpFile(
        {
          version: MINI_APP_TOTP_RECORD_VERSION,
          secret: validSecret,
          createdAt: 1,
          extra: true,
        },
        totpPath
      )
    ).toThrow(
      new InputValidationError(totpPath, "$", "an object with only version, secret, and createdAt")
    );

    expect((): unknown =>
      decodeMiniAppTotpFile(
        {
          version: MINI_APP_TOTP_RECORD_VERSION + 1,
          secret: validSecret,
          createdAt: 1,
        },
        totpPath
      )
    ).toThrow(new InputValidationError(totpPath, "$.version", `${MINI_APP_TOTP_RECORD_VERSION}`));

    const invalidSecret: string = "SENSITIVE_SECRET_VALUE_LEAK_CHECK";
    expect(MINI_APP_TOTP_SECRET_PATTERN.test(invalidSecret)).toBeFalse();
    let caughtError: unknown;
    try {
      decodeMiniAppTotpFile(
        {
          version: MINI_APP_TOTP_RECORD_VERSION,
          secret: invalidSecret,
          createdAt: 1,
        },
        totpPath
      );
    } catch (error: unknown) {
      caughtError = error;
    }
    expect(caughtError).toEqual(
      new InputValidationError(
        totpPath,
        "$.secret",
        "a 32-character RFC 4648 Base32 secret"
      )
    );
    expect((caughtError as Error).message).not.toContain(invalidSecret);

    expect((): unknown =>
      decodeMiniAppTotpFile(
        {
          version: MINI_APP_TOTP_RECORD_VERSION,
          secret: validSecret,
          createdAt: 0,
        },
        totpPath
      )
    ).toThrow(new InputValidationError(totpPath, "$.createdAt", "a positive safe integer timestamp"));
  });
});

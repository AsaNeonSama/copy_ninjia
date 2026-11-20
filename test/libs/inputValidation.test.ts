import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InputValidationError,
  assertLocalTimestamp,
  readJsonInput,
  readUtf8TextInput,
} from "../../packages/libs/inputValidation";

/** 各用例独占的临时目录；afterEach 整棵删掉。 */
const tempDirs: string[] = [];

afterEach((): void => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Bun 原生不可信输入读取", () => {
  test("JSON 读取拒绝非法 UTF-8，不把替换字符交给解析器", async () => {
    const directory: string = mkdtempSync(join(tmpdir(), "copy-ninjia-json-input-"));
    tempDirs.push(directory);
    const path: string = join(directory, "input.json");
    await Bun.write(path, new Uint8Array([0x5b, 0x22, 0xff, 0x22, 0x5d]));

    await expect(readJsonInput(path)).rejects.toThrow(
      `${path}: $ must be a readable valid JSON document.`
    );
  });

  test("读取前被删除的文件明确失败，不返回旧 Blob 内容", async () => {
    const directory: string = mkdtempSync(join(tmpdir(), "copy-ninjia-text-input-"));
    tempDirs.push(directory);
    const path: string = join(directory, "input.txt");
    await Bun.write(path, "ready");
    await Bun.file(path).delete();

    await expect(readUtf8TextInput(path)).rejects.toThrow(/ENOENT.*input\.txt/);
  });
});

describe("assertLocalTimestamp", () => {
  test("接受合法公历本地时间并拒绝非法形态与不存在的公历日期时间", () => {
    expect((): void => assertLocalTimestamp("2026/01/15 12:34:56", "fixture", "$.at")).not.toThrow();
    expect((): void => assertLocalTimestamp("2024/02/29 23:59:59", "fixture", "$.at")).not.toThrow();
    for (const invalid of [
      123,
      "",
      "2026-01-15T12:34:56Z",
      "2026/02/29 00:00:00",
      "2026/02/30 00:00:00",
      "2026/13/45 00:00:00",
      "2026/01/01 24:00:00",
    ]) {
      expect((): void => assertLocalTimestamp(invalid, "fixture", "$.at")).toThrow(InputValidationError);
      expect((): void => assertLocalTimestamp(invalid, "fixture", "$.at"))
        .toThrow("fixture: $.at must be a valid local calendar time in YYYY/MM/DD HH:mm:ss format.");
    }
  });
});

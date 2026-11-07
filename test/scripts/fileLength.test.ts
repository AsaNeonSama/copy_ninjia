import { expect, test } from "bun:test";
import {
  MAX_FRONTEND_SOURCE_LINES,
  MAX_SOURCE_LINES,
  collectFileLengthProblems,
} from "../../scripts/conventions/fileLength";

test.each(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "css", "sh"])(
  "%s 文件超过硬上限行数必须拆分",
  (extension: string): void => {
    const path: string = `scripts/source.${extension}`;
    expect(collectFileLengthProblems(path, "line\n".repeat(MAX_SOURCE_LINES))).toEqual([]);
    expect(collectFileLengthProblems(path, "line\r\n".repeat(MAX_SOURCE_LINES - 1) + "tail")).toEqual([]);
    expect(collectFileLengthProblems(path, "line\n".repeat(MAX_SOURCE_LINES) + "tail")).toEqual([
      `${path} has ${MAX_SOURCE_LINES + 1} lines; split source files exceeding ${MAX_SOURCE_LINES} lines`,
    ]);
  }
);

test.each(["tsx", "css"])(
  "Mini App 前端 .%s 文件按 1536 行上限判定，前端 .ts 仍按 1024 行判定",
  (extension: string): void => {
    const frontendPath: string = `packages/mini-app-frontend/view.${extension}`;
    expect(collectFileLengthProblems(frontendPath, "line\n".repeat(MAX_FRONTEND_SOURCE_LINES))).toEqual([]);
    expect(collectFileLengthProblems(frontendPath, "line\n".repeat(MAX_FRONTEND_SOURCE_LINES) + "tail")).toEqual([
      `${frontendPath} has ${MAX_FRONTEND_SOURCE_LINES + 1} lines; split source files exceeding ${MAX_FRONTEND_SOURCE_LINES} lines`,
    ]);
    const frontendTsPath: string = "packages/mini-app-frontend/libs/helper.ts";
    expect(collectFileLengthProblems(frontendTsPath, "line\n".repeat(MAX_SOURCE_LINES))).toEqual([]);
    expect(collectFileLengthProblems(frontendTsPath, "line\n".repeat(MAX_SOURCE_LINES) + "tail")).toEqual([
      `${frontendTsPath} has ${MAX_SOURCE_LINES + 1} lines; split source files exceeding ${MAX_SOURCE_LINES} lines`,
    ]);
  }
);

test("空源码与非源码文档不触发长度硬门禁", (): void => {
  expect(collectFileLengthProblems("empty.ts", "")).toEqual([]);
  expect(collectFileLengthProblems("guide.md", "line\n".repeat(MAX_FRONTEND_SOURCE_LINES + 1))).toEqual([]);
});

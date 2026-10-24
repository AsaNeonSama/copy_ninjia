/**
 * consts/paths.ts 加载时的进程环境核对：SDK_REQUEST_HEADER_ENVS 中的变量出现（含空串）即拒绝启动，
 * 错误只写变量名、不回显取值。各用例在独立子进程里加载模块，进程环境由用例给定。
 */

import { describe, expect, test } from "bun:test";
import { SDK_REQUEST_HEADER_ENVS } from "../../packages/consts/environment";

const PATHS_MODULE: string = new URL("../../packages/consts/paths.ts", import.meta.url).pathname;

/** 子进程加载 consts/paths.ts 的结果。 */
interface PathsModuleLoad {
  readonly exitCode: number;
  readonly stderr: string;
}

/**
 * 在给定进程环境的子进程里加载 consts/paths.ts。
 * @param env 子进程的完整进程环境。
 * @returns 子进程退出码与 stderr 全文。
 */
async function loadPathsModule(env: Readonly<Record<string, string | undefined>>): Promise<PathsModuleLoad> {
  const child: Bun.Subprocess<"ignore", "ignore", "pipe"> = Bun.spawn(
    [Bun.argv[0]!, "-e", `await import(${JSON.stringify(PATHS_MODULE)});`],
    { env, stdin: "ignore", stdout: "ignore", stderr: "pipe" }
  );
  const stderr: Promise<string> = child.stderr.text();
  return { exitCode: await child.exited, stderr: await stderr };
}

describe("consts/paths.ts 加载时的进程环境核对", () => {
  test("SDK 请求头环境变量都未设置时正常加载", async () => {
    expect((await loadPathsModule({ ...process.env })).exitCode).toBe(0);
  });

  test.each([...SDK_REQUEST_HEADER_ENVS])("%s 出现即拒绝启动，空串同样拒绝，错误不回显取值", async (name: string) => {
    for (const value of ["", "authorization: Bearer secret-header-value"]) {
      const { exitCode, stderr }: PathsModuleLoad = await loadPathsModule({ ...process.env, [name]: value });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain(`environment: ${name} must not be set.`);
      expect(stderr).not.toContain("secret-header-value");
    }
  });
});

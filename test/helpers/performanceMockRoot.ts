import { afterAll } from "bun:test";
import { existsSync, readdirSync, rmdirSync } from "node:fs";
import { PERFORMANCE_MOCK_ROOT } from "../../scripts/perf/fullSuite/mockRoot";

/**
 * 在测试文件顶层调用：记录调用时仓库根的 `performance/` mock 根是否已存在，并登记 afterAll，
 * 把本文件运行期间新建、跑完已为空的 mock 根删掉。建目录的入口落点固定为这一常量
 * （assertInsidePerformanceMockRoot 不接受注入根路径，见 scripts/perf/fullSuite/mockRoot.ts）。
 *
 * removeMockPath 拒绝删除 mock 根本身，这里用非递归 rmdirSync：每条用例都在 finally 里撤掉
 * 自己的 run-* 子树；目录非空（另有基准在写）时保留，不删对方的运行目录。
 */
export function removeCreatedPerformanceMockRootAfterAll(): void {
  const existedBefore: boolean = existsSync(PERFORMANCE_MOCK_ROOT);
  afterAll((): void => {
    if (existedBefore || !existsSync(PERFORMANCE_MOCK_ROOT)) return;
    if (readdirSync(PERFORMANCE_MOCK_ROOT).length === 0) {
      rmdirSync(PERFORMANCE_MOCK_ROOT);
    }
  });
}

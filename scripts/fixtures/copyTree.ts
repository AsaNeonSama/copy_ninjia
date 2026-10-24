/** 脚本共用的目录树复制边界：发行包暂存与测试夹具都用它。 */

import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 把目录树复制到隔离目标；文件内容统一交给 Bun 原生 I/O，目录语义使用
 * Node 兼容接口并以 0755 权限建目录。调用方必须先把目标约束在自己的临时根内。
 *
 * @param source 源文件或源目录路径
 * @param destination 目标文件或目标目录路径
 * @param assertDestination 每个落点在建目录或写文件之前过一次的校验，调用方据此
 *   逐段拒绝越界落点。缺省时不做额外校验，仅用于调用方已经完全掌控目标树的场景。
 */
export async function copyFixtureTree(
  source: string,
  destination: string,
  assertDestination?: (path: string) => void
): Promise<void> {
  assertDestination?.(destination);
  if (!(await Bun.file(source).stat()).isDirectory()) {
    await Bun.write(destination, Bun.file(source));
    return;
  }
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  for (const name of readdirSync(source)) {
    await copyFixtureTree(join(source, name), join(destination, name), assertDestination);
  }
}

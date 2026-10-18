/** 在无系统 Bun、无配置的临时目录真实执行发行包携带的全部冷迁移。 */
import { join } from "node:path";
import { prepareMigratedDeployment } from "./fixtures/migrationDeployment";
import type { MigratedDeployment } from "./fixtures/migrationDeployment";

/** 执行二进制发行包的冷迁移验证，返回供安装检查使用的迁移后部署夹具。 */
export async function checkBinaryMigrations(packageRoot: string): Promise<MigratedDeployment> {
  return prepareMigratedDeployment({
    packageRoot, root: join(packageRoot, "cold-migration-check"), binary: true,
  });
}

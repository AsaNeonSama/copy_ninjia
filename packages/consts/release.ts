import { PROMPT_EXAMPLE_DIR_NAME } from "./promptLayout";

/** 发行汇总结算与校验支持的平台名；发布 CLI 逐项核对显式 --platforms，所属模块：scripts/release/assets.ts。 */
export const RELEASE_PLATFORMS: readonly string[] = ["linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl"];

/**
 * 发行包必须完整拷贝并校验的源码树相对文件与目录清单；打包与资产核验共用，
 * 所属模块：scripts/build.ts、scripts/release/assets.ts。
 */
export const RELEASE_BUNDLED_PATHS: readonly string[] = [
  "install.sh",
  "config_example",
  PROMPT_EXAMPLE_DIR_NAME,
  "LICENSES",
  "packages/database/schema/migrations",
  "packages/mini-app-api-server/resource",
];

/**
 * 随发行包分发的壳层安装脚本匹配模式（相对仓库根与包根），
 * 所属模块：scripts/build.ts、scripts/release/assets.ts。
 */
export const RELEASE_INSTALL_SCRIPT_GLOB: string = "scripts/install/*.sh";

/**
 * 发行包必须唯一包含的包根构建产物文件（位于 RELEASE_BUNDLED_PATHS 与安装脚本之外）；
 * 主程序另需属主执行位，所属模块：scripts/release/assets.ts。
 */
export const RELEASE_REQUIRED_FILES: readonly string[] = [
  "copy-ninjia/binary.json",
  "copy-ninjia/package.json",
  "copy-ninjia/copy-ninjia",
  "copy-ninjia/scripts/install/runtime.js",
];

/** Release tag 与包内清单共用的无前缀版本形态，所属模块：scripts/release.ts、scripts/build.ts、scripts/release/assets.ts 与 scripts/release/github.ts。 */
export const RELEASE_VERSION_PATTERN: Readonly<RegExp> = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

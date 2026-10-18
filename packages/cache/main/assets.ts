/** owner: main。素材配置快照（packages/config/assets.ts）的内存状态。 */

import { DEFAULT_ASSET_CONFIG } from "../../consts/ui/assets";
import type { AssetConfig } from "../../types/config";

/**
 * config/dynamic/assets.json 的已生效素材快照。
 *
 * 初值为 DEFAULT_ASSET_CONFIG；启动总闸在文件存在时整体替换，热重载每轮按读取结果整体替换，
 * 文件被删除时重置为 DEFAULT_ASSET_CONFIG。容量恒为一个对象，不设淘汰；主线程独占，
 * 进程重启后从默认值重新填充。
 */
export const assetConfigCache: { current: Readonly<AssetConfig> } = { current: DEFAULT_ASSET_CONFIG };

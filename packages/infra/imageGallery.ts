/**
 * 图库管理与随机图片统一入口：`/h_image` 与 Mini App 图库的目录预检/接管、抽取、列表分页、删除与收图写盘。
 *
 * 具体实现按职责拆分在 `./imageGallery/cache.ts`（双结构内存缓存维护）、
 * `./imageGallery/inspection.ts`（只读巡检与接管建目录）与 `./imageGallery/operations.ts`（运行时读写操作）。
 */

export {
  adoptRandomImageDirectory,
  inspectRandomImageDirectory,
} from "./imageGallery/inspection";
export {
  deleteRandomImageFile,
  isRandomImageDirectory,
  listRandomImageGalleryEntries,
  pickRandomImage,
  readRandomImageLibrary,
  statRandomImageFile,
  storeRandomImage,
} from "./imageGallery/operations";

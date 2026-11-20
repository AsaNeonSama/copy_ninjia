/** 魔数嗅探得到的图片格式；unknown 表示不属于 jpeg、png、webp、gif 中任何一种。 */
export type SniffedImageFormat = "jpeg" | "png" | "webp" | "gif" | "unknown";

/**
 * 按文件头魔数嗅探格式，不依赖 Telegram 的 file_path 扩展名。
 * @param bytes 待嗅探的图片原始字节。
 * @returns 识别出的图片格式；不匹配已知魔数时返回 `"unknown"`。
 */
export function sniffImageFormat(bytes: Uint8Array): SniffedImageFormat {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 &&
    bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d &&
    bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "png";
  if (
    bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 &&
    bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 &&
    bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "webp";
  if (
    bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 &&
    bytes[2] === 0x46 && bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) return "gif";
  return "unknown";
}

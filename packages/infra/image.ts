import { logger } from "./logger";
import {
  RIFF_CHUNK_HEADER_BYTES,
  VISION_TRANSCODE_MAX_EDGE,
  VISION_TRANSCODE_MAX_PIXELS,
  WEBP_ANMF_HEADER_BYTES,
  WEBP_ANMF_SIZE_OFFSET,
  WEBP_CONTAINER_HEADER_BYTES,
  WEBP_FOURCC_ALPH,
  WEBP_FOURCC_ANMF,
  WEBP_FOURCC_RIFF,
  WEBP_FOURCC_VP8,
  WEBP_FOURCC_VP8L,
  WEBP_FOURCC_VP8X,
  WEBP_FOURCC_WEBP,
  WEBP_FRAME_IMAGE_FOURCCS,
  WEBP_MAX_SCANNED_CHUNKS,
  WEBP_VP8X_ALPHA_FLAG,
  WEBP_VP8X_PAYLOAD_BYTES,
  WEBP_VP8X_SIZE_OFFSET,
} from "../consts/image";
import type { VisionImage } from "../types/media";
import type { ImageDimensions } from "../types/hImage";

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

/** RIFF 容器里的一个块：四字符码（小端 uint32）、载荷起点与载荷长度（不含奇数长度的补齐字节）。 */
interface RiffChunk {
  readonly fourcc: number;
  readonly start: number;
  readonly length: number;
}

/** 在字节数组里扫描 RIFF 块的半开区间 [start, end)。 */
interface RiffSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * 在 span 内按 RIFF 规则顺序查找第一个四字符码属于 accept 的块。只读块头、不收集块列表，
 * 最多检查 WEBP_MAX_SCANNED_CHUNKS 个块；某个块的载荷越过 span.end、超过块数上限或扫到末尾
 * 仍未找到时返回 null。
 * @param bytes RIFF 容器的完整字节数组。
 * @param span 待扫描的半开字节区间 `[start, end)`。
 * @param accept 允许命中的四字符码（小端 uint32）列表。
 * @returns 第一个匹配的 RIFF 块信息；未找到或结构越界时返回 null。
 */
function findRiffChunk(bytes: Uint8Array, span: RiffSpan, accept: readonly number[]): RiffChunk | null {
  const view: DataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let scanned: number = 0;
  for (let offset: number = span.start; offset + RIFF_CHUNK_HEADER_BYTES <= span.end;) {
    if (++scanned > WEBP_MAX_SCANNED_CHUNKS) return null;
    const fourcc: number = view.getUint32(offset, true);
    const length: number = view.getUint32(offset + 4, true);
    const payload: number = offset + RIFF_CHUNK_HEADER_BYTES;
    if (payload + length > span.end) return null;
    if (accept.includes(fourcc)) return { fourcc, start: payload, length };
    offset = payload + length + (length & 1);
  }
  return null;
}

/**
 * 把若干 `[四字符码, 载荷]` 依次写成 RIFF 块（奇数长度按偶数字节对齐补齐），外层封装 `RIFF…WEBP` 头。
 * @param chunks 按序写入的 `[fourcc, payload]` 块列表。
 * @returns 封装好的完整 WebP 容器字节数组。
 */
function writeWebpContainer(chunks: readonly (readonly [number, Uint8Array])[]): Uint8Array {
  let body: number = WEBP_CONTAINER_HEADER_BYTES - RIFF_CHUNK_HEADER_BYTES;
  for (const [, payload] of chunks) body += RIFF_CHUNK_HEADER_BYTES + payload.length + (payload.length & 1);
  const output: Uint8Array = new Uint8Array(RIFF_CHUNK_HEADER_BYTES + body);
  const view: DataView = new DataView(output.buffer);
  view.setUint32(0, WEBP_FOURCC_RIFF, true);
  view.setUint32(4, body, true);
  view.setUint32(8, WEBP_FOURCC_WEBP, true);
  let offset: number = WEBP_CONTAINER_HEADER_BYTES;
  for (const [fourcc, payload] of chunks) {
    view.setUint32(offset, fourcc, true);
    view.setUint32(offset + 4, payload.length, true);
    output.set(payload, offset + RIFF_CHUNK_HEADER_BYTES);
    offset += RIFF_CHUNK_HEADER_BYTES + payload.length + (payload.length & 1);
  }
  return output;
}

/**
 * 把动态 WebP 的第一帧（首个 ANMF 块里的 VP8L，或 VP8 加可选 ALPH）重新封装成一张静态
 * WebP，按该帧自身宽高输出、不合成到画布偏移。不是动态 WebP 或容器结构不合法时返回
 * null，调用方按原字节解码。只做容器层的切片与拼接，不解码像素；帧尺寸与码流内容由
 * `Bun.Image` 解码时校验。
 * @param bytes 原始 WebP 字节数组。
 * @returns 重新封装的首帧静态 WebP 字节数组；非动态 WebP 或结构不合法时返回 null。
 */
export function firstAnimatedWebpFrame(bytes: Uint8Array): Uint8Array | null {
  const frame: RiffChunk | null = findRiffChunk(
    bytes, { start: WEBP_CONTAINER_HEADER_BYTES, end: bytes.length }, [WEBP_FOURCC_ANMF]
  );
  if (frame === null || frame.length < WEBP_ANMF_HEADER_BYTES) return null;
  const frameImages: RiffSpan = { start: frame.start + WEBP_ANMF_HEADER_BYTES, end: frame.start + frame.length };
  const image: RiffChunk | null = findRiffChunk(bytes, frameImages, WEBP_FRAME_IMAGE_FOURCCS);
  if (image === null) return null;
  const imageBytes: Uint8Array = bytes.subarray(image.start, image.start + image.length);
  if (image.fourcc === WEBP_FOURCC_VP8L) return writeWebpContainer([[WEBP_FOURCC_VP8L, imageBytes]]);
  // 有损帧用扩展格式封装：VP8X 声明画布与 alpha 标志，ALPH 在前、VP8 在后。
  const alpha: RiffChunk | null = findRiffChunk(bytes, frameImages, [WEBP_FOURCC_ALPH]);
  const header: Uint8Array = new Uint8Array(WEBP_VP8X_PAYLOAD_BYTES);
  header[0] = alpha === null ? 0 : WEBP_VP8X_ALPHA_FLAG;
  const size: number = frame.start + WEBP_ANMF_SIZE_OFFSET;
  header.set(bytes.subarray(size, size + WEBP_VP8X_PAYLOAD_BYTES - WEBP_VP8X_SIZE_OFFSET), WEBP_VP8X_SIZE_OFFSET);
  return writeWebpContainer(alpha === null
    ? [[WEBP_FOURCC_VP8X, header], [WEBP_FOURCC_VP8, imageBytes]]
    : [
      [WEBP_FOURCC_VP8X, header],
      [WEBP_FOURCC_ALPH, bytes.subarray(alpha.start, alpha.start + alpha.length)],
      [WEBP_FOURCC_VP8, imageBytes],
    ]);
}

/**
 * 将支持格式的图片字节转为视觉接口可用的 `jpeg`/`png`：
 * `jpeg`/`png` 原样直通；`webp`/`gif`（含动态首帧）经 `Bun.Image` 限制在 `VISION_TRANSCODE_MAX_PIXELS` 内解码，
 * 超过 `VISION_TRANSCODE_MAX_EDGE` 时等比降采样（不放大）后转为 `png`；
 * 不支持的格式、超限或转码失败返回 null。
 * @param bytes 原始图片字节数组。
 * @returns 可供视觉模型消费的图片字节与 MIME 类型；不支持或转码失败时返回 null。
 */
export async function prepareVisionImage(bytes: Uint8Array): Promise<VisionImage | null> {
  const format: SniffedImageFormat = sniffImageFormat(bytes);
  if (format === "jpeg") return { bytes, mime: "image/jpeg" };
  if (format === "png") return { bytes, mime: "image/png" };
  if (format !== "webp" && format !== "gif") return null;

  try {
    const source: Uint8Array = format === "webp" ? firstAnimatedWebpFrame(bytes) ?? bytes : bytes;
    const png: Uint8Array = await new Bun.Image(source, { maxPixels: VISION_TRANSCODE_MAX_PIXELS })
      .resize(VISION_TRANSCODE_MAX_EDGE, VISION_TRANSCODE_MAX_EDGE, { fit: "inside", withoutEnlargement: true })
      .png()
      .bytes();
    return { bytes: png, mime: "image/png" };
  } catch (error: unknown) {
    logger.error(`Failed to transcode ${format} image to png for vision API:`, error);
    return null;
  }
}

/**
 * 只读一张图的像素尺寸，不解码像素、不转码。`Bun.Image` 的 `metadata()` 只解码到
 * 能读出宽高与格式为止。
 *
 * 任何解码失败（不认识的格式、截断的头等）都返回 null，不抛出、不记日志；
 * 调用方把「读不出尺寸」与「读出来不合规」分开处置。
 * @param bytes 完整的图片字节。
 * @returns 像素宽高；读不出时为 null。
 */
export async function readImageDimensions(bytes: Uint8Array): Promise<ImageDimensions | null> {
  try {
    const metadata: Bun.Image.Metadata = await new Bun.Image(bytes).metadata();
    return { width: metadata.width, height: metadata.height };
  } catch {
    return null;
  }
}

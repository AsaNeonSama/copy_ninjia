/** 脚本子进程输出的共用 UTF-8 解码辅助模块。 */

/** 复用单一 UTF-8 解码器解码子进程 stdout/stderr 字节缓冲。 */
const UTF8_DECODER: TextDecoder = new TextDecoder();

/**
 * 将子进程输出的字节缓冲解码为 UTF-8 字符串；未捕获输出时返回空串。
 *
 * @param bytes 子进程输出的字节缓冲。
 * @returns 解码后的 UTF-8 文本。
 */
export function decodeUtf8(bytes: Uint8Array | undefined): string {
  return bytes === undefined ? "" : UTF8_DECODER.decode(bytes);
}

import {
  QR_ALIGNMENT_CENTERS_V4_TO_V8,
  QR_FORMAT_BCH_GENERATOR,
  QR_FORMAT_BCH_MASK,
  QR_FORMAT_ECC_L_BITS,
  QR_GF256_PRIMITIVE_POLY,
  QR_L_DATA_CODEWORDS_PER_BLOCK,
  QR_L_EC_CODEWORDS_PER_BLOCK,
  QR_L_MAX_BYTES,
  QR_L_NUM_BLOCKS,
  QR_L_VERSIONS,
  QR_PAD_BYTES,
  QR_SVG_QUIET_ZONE_MODULES,
  QR_VERSION_BCH_GENERATOR,
} from "../consts/miniAppTotp";

const UTF8_ENCODER: TextEncoder = new TextEncoder();

/** QR 矩阵可变构建上下文。 */
interface QrMatrixBuffer {
  /** 矩阵边长模块数（`version * 4 + 17`）。 */
  readonly size: number;
  /** 模块深浅数组（`0` 为浅色，`1` 为深色）。 */
  readonly modules: Uint8Array;
  /** 功能图形掩码（`1` 表示功能模块，`0` 表示数据/纠错模块）。 */
  readonly isFunction: Uint8Array;
}

/**
 * 在有限域 $\text{GF}(2^8)$（本原多项式 `0x11D`）下计算两个字节的乘积。
 * @param a 左操作数字节（`0..255`）。
 * @param b 右操作数字节（`0..255`）。
 * @returns 有限域乘积字节（`0..255`）。
 */
function gfMultiply(a: number, b: number): number {
  let result: number = 0;
  let multiplicand: number = a & 0xff;
  let multiplier: number = b & 0xff;
  for (let i: number = 0; i < 8; i += 1) {
    if ((multiplier & 1) !== 0) {
      result ^= multiplicand;
    }
    const highBit: number = multiplicand & 0x80;
    multiplicand = (multiplicand << 1) & 0xff;
    if (highBit !== 0) {
      multiplicand ^= QR_GF256_PRIMITIVE_POLY & 0xff;
    }
    multiplier >>>= 1;
  }
  return result;
}

/**
 * 生成指定纠错码字长度的 Reed-Solomon 生成多项式系数数组（不含首项 `1`）。
 * @param degree 纠错码字字节数。
 * @returns 长度为 `degree` 的生成多项式系数数组。
 */
function buildReedSolomonGenerator(degree: number): Uint8Array {
  let poly: Uint8Array = new Uint8Array(1);
  poly[0] = 1;
  let root: number = 1;
  for (let i: number = 0; i < degree; i += 1) {
    const next: Uint8Array = new Uint8Array(poly.byteLength + 1);
    for (let j: number = 0; j < poly.byteLength; j += 1) {
      const coeff: number = poly[j] ?? 0;
      next[j] = (next[j] ?? 0) ^ coeff;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMultiply(coeff, root);
    }
    poly = next;
    root = gfMultiply(root, 2);
  }
  return poly.subarray(1);
}

/**
 * 计算单个数据分块的 Reed-Solomon 纠错码字。
 * @param dataBlock 数据码字分块。
 * @param generator 长度为 `ecLen` 的生成多项式系数（不含首项 `1`）。
 * @returns 纠错码字字节数组。
 */
function computeReedSolomonRemainder(
  dataBlock: Uint8Array,
  generator: Uint8Array
): Uint8Array {
  const ecLen: number = generator.byteLength;
  const remainder: Uint8Array = new Uint8Array(ecLen);
  for (let i: number = 0; i < dataBlock.byteLength; i += 1) {
    const factor: number = (dataBlock[i] ?? 0) ^ (remainder[0] ?? 0);
    remainder.copyWithin(0, 1);
    remainder[ecLen - 1] = 0;
    for (let j: number = 0; j < ecLen; j += 1) {
      remainder[j] =
        (remainder[j] ?? 0) ^ gfMultiply(generator[j] ?? 0, factor);
    }
  }
  return remainder;
}

/**
 * 将 UTF-8 字节负载编码并交织为指定版本（Level-L）的完整码字序列。
 * @param payload UTF-8 字节数组。
 * @param versionIndex `QR_L_VERSIONS` 中的版本下标。
 * @returns 交织后的数据与纠错码字数组。
 */
function encodeQrCodewords(
  payload: Uint8Array,
  versionIndex: number
): Uint8Array {
  const numBlocks: number = QR_L_NUM_BLOCKS[versionIndex] ?? 1;
  const dataPerBlock: number =
    QR_L_DATA_CODEWORDS_PER_BLOCK[versionIndex] ?? 108;
  const ecPerBlock: number = QR_L_EC_CODEWORDS_PER_BLOCK[versionIndex] ?? 26;
  const totalDataCodewords: number = numBlocks * dataPerBlock;
  const dataCodewords: Uint8Array = new Uint8Array(totalDataCodewords);

  let bitLength: number = 0;
  const appendBits = (value: number, count: number): void => {
    for (let i: number = count - 1; i >= 0; i -= 1) {
      const bit: number = (value >>> i) & 1;
      const bytePos: number = bitLength >>> 3;
      const bitOffset: number = 7 - (bitLength & 7);
      dataCodewords[bytePos] =
        (dataCodewords[bytePos] ?? 0) | (bit << bitOffset);
      bitLength += 1;
    }
  };

  appendBits(0b0100, 4);
  appendBits(payload.byteLength, 8);
  for (let i: number = 0; i < payload.byteLength; i += 1) {
    appendBits(payload[i] ?? 0, 8);
  }
  const capacityBits: number = totalDataCodewords * 8;
  const terminatorBits: number = Math.min(4, capacityBits - bitLength);
  appendBits(0, terminatorBits);
  const remainderBits: number = (8 - (bitLength & 7)) & 7;
  appendBits(0, remainderBits);

  let padIndex: number = 0;
  for (
    let byteIdx: number = bitLength >>> 3;
    byteIdx < totalDataCodewords;
    byteIdx += 1
  ) {
    dataCodewords[byteIdx] =
      QR_PAD_BYTES[padIndex % QR_PAD_BYTES.length] ?? 0xec;
    padIndex += 1;
  }

  const generator: Uint8Array = buildReedSolomonGenerator(ecPerBlock);
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  for (let b: number = 0; b < numBlocks; b += 1) {
    const start: number = b * dataPerBlock;
    const block: Uint8Array = dataCodewords.subarray(
      start,
      start + dataPerBlock
    );
    dataBlocks.push(block);
    ecBlocks.push(computeReedSolomonRemainder(block, generator));
  }

  const interleaved: Uint8Array = new Uint8Array(
    totalDataCodewords + numBlocks * ecPerBlock
  );
  let outPos: number = 0;
  for (let col: number = 0; col < dataPerBlock; col += 1) {
    for (let b: number = 0; b < numBlocks; b += 1) {
      interleaved[outPos] = dataBlocks[b]?.[col] ?? 0;
      outPos += 1;
    }
  }
  for (let col: number = 0; col < ecPerBlock; col += 1) {
    for (let b: number = 0; b < numBlocks; b += 1) {
      interleaved[outPos] = ecBlocks[b]?.[col] ?? 0;
      outPos += 1;
    }
  }
  return interleaved;
}

/**
 * 在矩阵指定位置设置功能模块深浅并标记为非数据区。
 * @param matrix 矩阵上下文。
 * @param row 行坐标。
 * @param col 列坐标。
 */
function setFunctionModuleDark(
  matrix: QrMatrixBuffer,
  row: number,
  col: number
): void {
  const idx: number = row * matrix.size + col;
  matrix.modules[idx] = 1;
  matrix.isFunction[idx] = 1;
}

/**
 * 在矩阵指定位置设置浅色功能模块并标记为非数据区。
 * @param matrix 矩阵上下文。
 * @param row 行坐标。
 * @param col 列坐标。
 */
function setFunctionModuleLight(
  matrix: QrMatrixBuffer,
  row: number,
  col: number
): void {
  const idx: number = row * matrix.size + col;
  matrix.modules[idx] = 0;
  matrix.isFunction[idx] = 1;
}

/**
 * 在矩阵左上、右上或左下角绘制 7×7 寻像图形及其 1 模块白色分隔区。
 * @param matrix 矩阵上下文。
 * @param top 7×7 寻像图形左上角行坐标。
 * @param left 7×7 寻像图形左上角列坐标。
 */
function drawFinderPattern(
  matrix: QrMatrixBuffer,
  top: number,
  left: number
): void {
  for (let dy: number = -1; dy <= 7; dy += 1) {
    for (let dx: number = -1; dx <= 7; dx += 1) {
      const r: number = top + dy;
      const c: number = left + dx;
      if (r < 0 || r >= matrix.size || c < 0 || c >= matrix.size) continue;
      const inOuter: boolean = dy >= 0 && dy <= 6 && dx >= 0 && dx <= 6;
      const onBorder: boolean = dy === 0 || dy === 6 || dx === 0 || dx === 6;
      const inInner: boolean = dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4;
      if (inOuter && (onBorder || inInner)) {
        setFunctionModuleDark(matrix, r, c);
      } else {
        setFunctionModuleLight(matrix, r, c);
      }
    }
  }
}

/**
 * 绘制全部功能图形（寻像图形、定位图形、校正图形、格式预留区与版本信息区）。
 * @param matrix 矩阵上下文。
 * @param versionIndex `QR_L_VERSIONS` 中的版本下标。
 */
function drawFunctionPatterns(
  matrix: QrMatrixBuffer,
  versionIndex: number
): void {
  const size: number = matrix.size;
  const version: number = QR_L_VERSIONS[versionIndex] ?? 5;

  drawFinderPattern(matrix, 0, 0);
  drawFinderPattern(matrix, 0, size - 7);
  drawFinderPattern(matrix, size - 7, 0);

  for (let i: number = 8; i <= size - 9; i += 1) {
    if (i % 2 === 0) {
      setFunctionModuleDark(matrix, 6, i);
      setFunctionModuleDark(matrix, i, 6);
    } else {
      setFunctionModuleLight(matrix, 6, i);
      setFunctionModuleLight(matrix, i, 6);
    }
  }

  const centers: readonly number[] =
    QR_ALIGNMENT_CENTERS_V4_TO_V8[versionIndex] ?? [];
  for (const cr of centers) {
    for (const cc of centers) {
      const overlapsFinder: boolean =
        (cr <= 8 && cc <= 8) ||
        (cr <= 8 && cc >= size - 9) ||
        (cr >= size - 9 && cc <= 8);
      if (overlapsFinder) continue;
      for (let dy: number = -2; dy <= 2; dy += 1) {
        for (let dx: number = -2; dx <= 2; dx += 1) {
          const dist: number = Math.max(Math.abs(dy), Math.abs(dx));
          if (dist === 1) {
            setFunctionModuleLight(matrix, cr + dy, cc + dx);
          } else {
            setFunctionModuleDark(matrix, cr + dy, cc + dx);
          }
        }
      }
    }
  }

  setFunctionModuleDark(matrix, size - 8, 8);

  for (let i: number = 0; i <= 8; i += 1) {
    if (matrix.isFunction[8 * size + i] === 0) {
      setFunctionModuleLight(matrix, 8, i);
    }
    if (matrix.isFunction[i * size + 8] === 0) {
      setFunctionModuleLight(matrix, i, 8);
    }
  }
  for (let i: number = 0; i < 8; i += 1) {
    setFunctionModuleLight(matrix, 8, size - 1 - i);
  }
  for (let i: number = 0; i < 7; i += 1) {
    setFunctionModuleLight(matrix, size - 1 - i, 8);
  }

  if (version >= 7) {
    let rem: number = version;
    for (let i: number = 0; i < 12; i += 1) {
      rem = (rem << 1) ^ ((rem >>> 11) * QR_VERSION_BCH_GENERATOR);
    }
    const versionBits: number = (version << 12) | rem;
    for (let i: number = 0; i < 18; i += 1) {
      const bit: number = (versionBits >>> i) & 1;
      const a: number = size - 11 + (i % 3);
      const b: number = Math.floor(i / 3);
      if (bit === 1) {
        setFunctionModuleDark(matrix, a, b);
        setFunctionModuleDark(matrix, b, a);
      } else {
        setFunctionModuleLight(matrix, a, b);
        setFunctionModuleLight(matrix, b, a);
      }
    }
  }
}

/**
 * 按 ISO/IEC 18004 双列蛇形顺序写入交织码字位，并应用掩码 0（`(row + col) % 2 === 0`）与格式信息。
 * @param matrix 矩阵上下文。
 * @param codewords 交织后的数据与纠错码字。
 */
function placeCodewordsAndFormatInfo(
  matrix: QrMatrixBuffer,
  codewords: Uint8Array
): void {
  const size: number = matrix.size;
  const totalBits: number = codewords.byteLength * 8;
  let bitIdx: number = 0;

  for (let right: number = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward: boolean = ((right + 1) & 2) === 0;
    for (let v: number = 0; v < size; v += 1) {
      const row: number = upward ? size - 1 - v : v;
      for (let dx: number = 0; dx < 2; dx += 1) {
        const col: number = right - dx;
        const pos: number = row * size + col;
        if (matrix.isFunction[pos] !== 0) continue;
        let bit: number = 0;
        if (bitIdx < totalBits) {
          const byteVal: number = codewords[bitIdx >>> 3] ?? 0;
          bit = (byteVal >>> (7 - (bitIdx & 7))) & 1;
          bitIdx += 1;
        }
        if ((row + col) % 2 === 0) {
          bit ^= 1;
        }
        matrix.modules[pos] = bit;
      }
    }
  }

  const formatData: number = (QR_FORMAT_ECC_L_BITS << 3) | 0;
  let rem: number = formatData;
  for (let i: number = 0; i < 10; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 9) * QR_FORMAT_BCH_GENERATOR);
  }
  const formatBits: number = ((formatData << 10) | rem) ^ QR_FORMAT_BCH_MASK;

  for (let i: number = 0; i < 15; i += 1) {
    const dark: boolean = ((formatBits >>> i) & 1) === 1;
    let r1: number;
    let c1: number;
    if (i <= 5) {
      r1 = i;
      c1 = 8;
    } else if (i === 6) {
      r1 = 7;
      c1 = 8;
    } else if (i === 7) {
      r1 = 8;
      c1 = 8;
    } else if (i === 8) {
      r1 = 8;
      c1 = 7;
    } else {
      r1 = 8;
      c1 = 14 - i;
    }
    matrix.modules[r1 * size + c1] = dark ? 1 : 0;

    let r2: number;
    let c2: number;
    if (i <= 7) {
      r2 = 8;
      c2 = size - 1 - i;
    } else {
      r2 = size - 15 + i;
      c2 = 8;
    }
    matrix.modules[r2 * size + c2] = dark ? 1 : 0;
  }
}

/**
 * 将给定文本（如 `otpauth://totp/...` URI）编码并渲染为标准 ISO/IEC 18004 内联 `<svg>` 矢量二维码字符串。
 * @param text 待编码的 UTF-8 文本（不超过 192 字节）。
 * @returns 完整的 `<svg ...>...</svg>` 字符串。
 */
export function renderQrCodeSvg(text: string): string {
  const payload: Uint8Array = UTF8_ENCODER.encode(text);
  let versionIndex: number = -1;
  for (let i: number = 0; i < QR_L_MAX_BYTES.length; i += 1) {
    if (payload.byteLength <= (QR_L_MAX_BYTES[i] ?? 0)) {
      versionIndex = i;
      break;
    }
  }
  if (versionIndex < 0) {
    versionIndex = QR_L_VERSIONS.length - 1;
  }
  const version: number = QR_L_VERSIONS[versionIndex] ?? 5;
  const size: number = version * 4 + 17;
  const matrix: QrMatrixBuffer = {
    size,
    modules: new Uint8Array(size * size),
    isFunction: new Uint8Array(size * size),
  };

  drawFunctionPatterns(matrix, versionIndex);
  const codewords: Uint8Array = encodeQrCodewords(payload, versionIndex);
  placeCodewordsAndFormatInfo(matrix, codewords);

  const viewSize: number = size + QR_SVG_QUIET_ZONE_MODULES * 2;
  const pathParts: string[] = [];
  for (let r: number = 0; r < size; r += 1) {
    for (let c: number = 0; c < size; c += 1) {
      if (matrix.modules[r * size + c] === 1) {
        const x: number = c + QR_SVG_QUIET_ZONE_MODULES;
        const y: number = r + QR_SVG_QUIET_ZONE_MODULES;
        pathParts.push(`M${x},${y}h1v1h-1z`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" shape-rendering="crispEdges" role="img" aria-label="TOTP QR Code"><rect width="${viewSize}" height="${viewSize}" fill="#ffffff"/><path d="${pathParts.join("")}" fill="#0f172a"/></svg>`;
}

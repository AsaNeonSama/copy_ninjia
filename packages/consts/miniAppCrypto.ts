import type { MiniAppAuthPolicy } from "../types/miniApp/server";
import { MINI_APP_MAX_UPLOAD_BODY_BYTES } from "./miniApp/http";
import { MINUTE_MS } from "./time";

/**
 * Mini App 会话临时密钥与临时 ECDH 派生对称密钥的位宽（256 bits）。
 * 不变量：固定使用 AES-256-GCM 算法，与前端 `packages/mini-app-frontend/consts/miniAppCrypto.ts` 一致。
 * 所属模块：`packages/mini-app-api-server/libs/crypto.ts`。
 */
export const MINI_APP_SESSION_KEY_BITS: number = 256;

/**
 * Mini App 会话临时密钥的原始字节长度（32 字节 = 256 bits）。
 * 不变量：`MINI_APP_SESSION_KEY_BITS / 8`，编码为 64 位小写十六进制传输。
 * 所属模块：`packages/mini-app-api-server/libs/crypto.ts`、`packages/mini-app-api-server/auth/sessionLifecycle.ts`
 * 与 `packages/mini-app-api-server/auth/sessionCommit.ts`。
 */
export const MINI_APP_SESSION_KEY_BYTES: number = 32;

/**
 * Mini App 会话内部谱系标识的随机字节长度（16 字节 = 32 位十六进制）。
 * 不变量：正整数；谱系标识在登录签发时生成、历次滑动轮换原样继承且不下发客户端。
 * 所属模块：`packages/mini-app-api-server/auth/sessionLifecycle.ts`。
 */
export const MINI_APP_SESSION_LINEAGE_ID_BYTES: number = 16;

/**
 * Mini App AES-256-GCM 每次加密随机生成的初始向量（IV / Nonce）字节长度（12 字节 = 96 bits）。
 * 不变量：遵循 NIST SP 800-38D 推荐的 96-bit GCM IV 长度。
 * 所属模块：`packages/mini-app-api-server/libs/crypto.ts`。
 */
export const MINI_APP_AES_GCM_IV_BYTES: number = 12;

/**
 * Mini App AES-256-GCM 认证标签位宽（128 bits = 16 字节）。
 * 不变量：Web Crypto `AES-GCM` 标准全长完整性校验标签。
 * 所属模块：`packages/mini-app-api-server/libs/crypto.ts`。
 */
export const MINI_APP_AES_GCM_TAG_BITS: number = 128;

/**
 * Web Crypto 对称认证加密算法名称常量。
 * 不变量：恒为 `"AES-GCM"`。所属模块：`packages/mini-app-api-server/libs/crypto.ts`。
 */
export const MINI_APP_AES_GCM_ALGORITHM: string = "AES-GCM";

/**
 * Web Crypto 临时密钥协商（ECDH）椭圆曲线算法名称常量。
 * 不变量：恒为 `"X25519"`，与前端 `packages/mini-app-frontend/consts/miniAppCrypto.ts` 一致。
 * 所属模块：`packages/mini-app-api-server/libs/handshakeCrypto.ts`。
 */
export const MINI_APP_X25519_ALGORITHM: string = "X25519";

/**
 * Web Crypto 源站本次启动 Ed25519 验签公钥数字签名算法名称常量。
 * 不变量：恒为 `"Ed25519"`，与前端 `packages/mini-app-frontend/consts/miniAppCrypto.ts` 一致。
 * 所属模块：`packages/mini-app-api-server/libs/handshakeCrypto.ts`。
 */
export const MINI_APP_ED25519_ALGORITHM: string = "Ed25519";

/**
 * Web Crypto 密钥派生函数算法名称常量。
 * 不变量：恒为 `"HKDF"`，与前端 `packages/mini-app-frontend/consts/miniAppCrypto.ts` 一致。
 * 所属模块：`packages/mini-app-api-server/libs/handshakeCrypto.ts`。
 */
export const MINI_APP_HKDF_ALGORITHM: string = "HKDF";

/**
 * HKDF 密钥派生函数使用的哈希算法名称常量。
 * 不变量：恒为 `"SHA-256"`，与前端 `packages/mini-app-frontend/consts/miniAppCrypto.ts` 一致。
 * 所属模块：`packages/mini-app-api-server/libs/handshakeCrypto.ts`。
 */
export const MINI_APP_HKDF_HASH: string = "SHA-256";

/**
 * X25519 临时公钥原始字节长度（32 字节 = 256 bits）。
 * 不变量：固定为 `32`，以标准 Base64 编码在握手响应与登录请求中传输，与前端 `packages/mini-app-frontend/consts/miniAppCrypto.ts` 一致。
 * 所属模块：`packages/mini-app-api-server/libs/handshakeCrypto.ts`。
 */
export const MINI_APP_X25519_PUBLIC_KEY_BYTES: number = 32;

/**
 * Ed25519 验签公钥原始字节长度（32 字节 = 256 bits）。
 * 不变量：固定为 `32`，编码为 44 位标准 Base64 注入前端打包产物，与前端 `packages/mini-app-frontend/consts/miniAppCrypto.ts` 一致。
 * 所属模块：`packages/mini-app-api-server/libs/handshakeCrypto.ts` 与 `packages/mini-app-api-server/handlers/page.ts`。
 */
export const MINI_APP_ED25519_PUBLIC_KEY_BYTES: number = 32;

/**
 * 会话滑动续期时，服务端下发由上一把会话密钥加密的新会话 256-bit 密钥密文的 HTTP 响应头名（小写）。
 * 不变量：仅在滑动续期轮换会话时与刷新后的 `X-Mini-App-Session` 同步下发，绝不明文传输密钥。
 * 所属模块：`packages/mini-app-api-server/auth/sessionLifecycle.ts` 与 `packages/mini-app-api-server/middleware/pipeline.ts`。
 */
export const MINI_APP_SESSION_KEY_HEADER: string = "x-mini-app-session-key";

/**
 * 临时 ECDH 登录握手标识的随机字节长度（16 字节 = 32 位十六进制），同时作为 HKDF-SHA256 的 salt。
 * 不变量：正整数，供 `crypto.getRandomValues` 生成唯一 `handshakeId`。
 * 所属模块：`packages/mini-app-api-server/auth/handshake.ts`。
 */
export const MINI_APP_HANDSHAKE_ID_BYTES: number = 16;

/**
 * 32 位十六进制临时 ECDH 登录握手 ID 的格式校验正则。
 * 不变量：不带全局标志 `g`，无状态复用，与前端 `packages/mini-app-frontend/consts/miniAppCrypto.ts` 一致。
 * 所属模块：`packages/mini-app-api-server/auth/handshake.ts`。
 */
export const MINI_APP_HANDSHAKE_ID_HEX_PATTERN: RegExp = /^[0-9a-f]{32}$/i;

/**
 * 服务端对临时 X25519 登录握手公钥抄本执行 Ed25519 签名时使用的域分离前缀。
 * 不变量：恒为 `"CopyNinjaMiniAppEcdhV1"`，与前端 `packages/mini-app-frontend/consts/miniAppCrypto.ts` 一致。
 * 所属模块：`packages/mini-app-api-server/libs/handshakeCrypto.ts`。
 */
export const MINI_APP_HANDSHAKE_SIGNATURE_DOMAIN: string =
  "CopyNinjaMiniAppEcdhV1";

/**
 * 客户端到服务端（c2s）登录请求方向经 HKDF-SHA256 派生 AES-256-GCM 密钥时的 `info` 域分离前缀。
 * 不变量：与 `MINI_APP_HANDSHAKE_HKDF_S2C_INFO_PREFIX` 严格区分方向，与前端 `packages/mini-app-frontend/consts/miniAppCrypto.ts` 一致。
 * 所属模块：`packages/mini-app-api-server/libs/handshakeCrypto.ts`。
 */
export const MINI_APP_HANDSHAKE_HKDF_C2S_INFO_PREFIX: string =
  "CopyNinjaMiniAppEcdhV1:c2s";

/**
 * 服务端到客户端（s2c）登录响应方向经 HKDF-SHA256 派生 AES-256-GCM 密钥时的 `info` 域分离前缀。
 * 不变量：与 `MINI_APP_HANDSHAKE_HKDF_C2S_INFO_PREFIX` 严格区分方向，与前端 `packages/mini-app-frontend/consts/miniAppCrypto.ts` 一致。
 * 所属模块：`packages/mini-app-api-server/libs/handshakeCrypto.ts`。
 */
export const MINI_APP_HANDSHAKE_HKDF_S2C_INFO_PREFIX: string =
  "CopyNinjaMiniAppEcdhV1:s2c";

/**
 * 使用临时 ECDH 派生对称密钥加密 `POST /api/auth/login` 登录请求时绑定的 AEAD 附加认证数据文本。
 * 不变量：恒为 `"POST /api/auth/login:request"`，与前端 `packages/mini-app-frontend/consts/miniAppCrypto.ts` 一致。
 * 所属模块：`packages/mini-app-api-server/handlers/auth.ts`。
 */
export const MINI_APP_LOGIN_REQUEST_AAD: string =
  "POST /api/auth/login:request";

/**
 * 使用临时 ECDH 派生对称密钥加密 `POST /api/auth/login` 响应信封时绑定的 AEAD 附加认证数据文本。
 * 不变量：恒为 `"POST /api/auth/login:response"`，与前端 `packages/mini-app-frontend/consts/miniAppCrypto.ts` 一致。
 * 所属模块：`packages/mini-app-api-server/handlers/auth.ts`。
 */
export const MINI_APP_LOGIN_RESPONSE_AAD: string =
  "POST /api/auth/login:response";

/**
 * 物化打包前端 JS 产物前写入前端常量的源站本次启动 Ed25519 验签公钥编译占位标记。
 * 不变量：含下划线非 Base64 字符，运行时未替换为当次启动内存生成的 32 字节 Ed25519 原始公钥 Base64 即验签失败；与前端 `packages/mini-app-frontend/consts/miniAppCrypto.ts` 的 `MINI_APP_SERVER_SIGNING_PUBLIC_KEY_BASE64` 一致。
 * 所属模块：`packages/mini-app-api-server/handlers/page.ts`。
 */
export const MINI_APP_SERVER_SIGNING_PUBLIC_KEY_PLACEHOLDER: string =
  "__COPY_NINJA_MINI_APP_ED25519_PUBLIC_KEY_V1__";

/**
 * 启用请求加密的业务 API 路由承载 AES-256-GCM 加密查询串的 URL 查询参数名。
 * 不变量：恒为 `"e"`；仅允许携带单个该参数，拒绝明文业务参数、重复键或裸 `?`，与前端 `packages/mini-app-frontend/consts/miniAppCrypto.ts` 一致。
 * 所属模块：`packages/mini-app-api-server/middleware/pipeline.ts` 与 `test/helpers/miniAppRequest.ts`。
 */
export const MINI_APP_ENCRYPTED_QUERY_PARAM: string = "e";

/**
 * `GET|HEAD /api/gallery/download` 通过一次性下载票据完成原生文件下载时使用的唯一查询参数名。
 * 不变量：固定为 `"ticket"`，仅在 `POST /api/gallery/download-ticket` 签发后于 60 秒内一次性消费，绝不承载会话令牌或密钥。
 * 所属模块：`packages/mini-app-api-server/routes/gallery.ts` 与 `packages/mini-app-frontend/api/galleryDownload.ts`。
 */
export const MINI_APP_DOWNLOAD_TICKET_PARAM: string = "ticket";

/**
 * Mini App 一次性图库文件下载票据的有效期毫秒数（60 秒）。
 * 不变量：到期或被成功 `GET` 下载消费后立即失效，不参与滑动续期。
 * 所属模块：`packages/mini-app-api-server/auth/downloadTicket.ts`。
 */
export const MINI_APP_DOWNLOAD_TICKET_TTL_MS: number = MINUTE_MS;

/**
 * 主线程内存中允许同时缓存的未消费 Mini App 一次性下载票据最大条目数。
 * 不变量：容量受限为正整数，超出时优先清理过期条目并按 FIFO 淘汰最早票据，防止内存无限增长。
 * 所属模块：`packages/cache/main/miniApp.ts` 与 `packages/mini-app-api-server/auth/downloadTicket.ts`。
 */
export const MINI_APP_DOWNLOAD_TICKET_MAX: number = 64;

/**
 * 单个 Mini App 会话密钥周期内最多记录的加密请求 12 字节 IV 去重集合硬上限（4,096）。
 * 不变量：严格大于 `MINI_APP_SESSION_ROTATE_AT_SEEN_IVS`；每个密钥纪元重置，防止同一会话密钥下重复 IV 重放；达到硬上限后拒绝新加密请求并吊销会话。
 * 所属模块：`packages/mini-app-api-server/middleware/pipeline.ts` 与 `packages/mini-app-api-server/auth/sessionLookup.ts`。
 */
export const MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS: number = 4_096;

/**
 * 单个 Mini App 会话密钥周期内触发主动滑动密钥轮换的已受理请求 IV 水位阈值（3,072，占 `MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS` 的 75%）。
 * 不变量：正整数且严格小于 `MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS`；启用加密响应的业务请求提交后若当前密钥纪元 `seenRequestIvs.size` 达到该阈值，即使尚未到达 `nextRefreshAt` 也立即轮换会话令牌与 256-bit 密钥、重置新纪元 IV 集合并重新随机采样 `[MINI_APP_SESSION_REFRESH_MIN_MS, MINI_APP_SESSION_REFRESH_MAX_MS]` 轮换冷却时间，同时在旧纪元保留余量供并发在途旧令牌请求与非轮换二进制路由平滑过渡。
 * 所属模块：`packages/mini-app-api-server/auth/sessionCommit.ts`。
 */
export const MINI_APP_SESSION_ROTATE_AT_SEEN_IVS: number = 3_072;

/**
 * 加密 URL 查询参数 `e` 解码后的密文令牌字符串（`<ivBase64>.<cipherBase64>`）允许的最大字符长度（4096 字符）。
 * 不变量：正整数上界，超出该长度的加密查询参数在进入 Base64 解码与 AES-GCM 解密前直接拒绝，与前端 `packages/mini-app-frontend/consts/miniAppCrypto.ts` 一致。
 * 所属模块：`packages/mini-app-api-server/libs/crypto.ts` 与 `packages/mini-app-api-server/middleware/pipeline.ts`。
 */
export const MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH: number = 4_096;

/**
 * 普通业务加密请求信封允许的最大 HTTP 请求体字节数（64 KiB，覆盖 32 KiB 明文 JSON 经 AES-GCM Base64 膨胀后的上界）。
 * 不变量：大于 `MINI_APP_MAX_JSON_BODY_BYTES`。所属模块：`packages/mini-app-api-server/middleware/pipeline.ts`。
 */
export const MINI_APP_MAX_ENCRYPTED_JSON_BODY_BYTES: number = 65_536;

/**
 * 配置保存接口（会话密钥 AES-256-GCM Base64 封装，覆盖最大 2 MiB 合法 JSON 配置文件）允许的最大请求体字节数（4 MiB）。
 * 不变量：大于 `MINI_APP_MAX_CONFIG_CONTENT_BYTES` 且小于 `MINI_APP_MAX_UPLOAD_BODY_BYTES`。
 * 所属模块：`packages/mini-app-api-server/handlers/configs.ts`。
 */
export const MINI_APP_MAX_CONFIG_BODY_BYTES: number = 4 * 1_024 * 1_024;

/**
 * `GET /api/auth/precheck` 动态签发的临时 X25519 登录握手公钥的最大存活毫秒数（5 分钟）。
 * 不变量：正整数毫秒数；完成一次 `POST /api/auth/login` 尝试后立即消费销毁，超时未消费亦自动淘汰。
 * 所属模块：`packages/mini-app-api-server/auth/handshake.ts`。
 */
export const MINI_APP_HANDSHAKE_TTL_MS: number = 5 * MINUTE_MS;

/**
 * 主线程同时保留的待消费临时 ECDH 登录握手记录数量上限。
 * 不变量：有界 `FifoMap` 容量上界。所属模块：`packages/cache/main/miniApp.ts`。
 */
export const MINI_APP_HANDSHAKE_MAX: number = 16;

/**
 * 加密请求信封或加密 URL 查询参数缺失、畸形、超限或 AES-256-GCM 认证标签解密失败时返回的错误码。
 * 不变量：非空大写下划线状态码。所属模块：`packages/mini-app-api-server/middleware/pipeline.ts`。
 */
export const MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE: string =
  "INVALID_ENCRYPTED_PAYLOAD";

/**
 * 临时 ECDH 登录握手不存在、已过期、并发重放、Ed25519 验签失败或密文/绑定校验失败时返回的错误码。
 * 不变量：非空大写下划线状态码，与前端 `packages/mini-app-frontend/consts/miniAppCrypto.ts` 一致。
 * 所属模块：`packages/mini-app-api-server/handlers/auth.ts`。
 */
export const MINI_APP_INVALID_HANDSHAKE_CODE: string = "INVALID_HANDSHAKE";

/**
 * 配置读取或保存请求携带非白名单目录作用域或文件名时返回的错误码。
 * 不变量：非空大写下划线状态码。所属模块：`packages/mini-app-api-server/view/configs/storage.ts`。
 */
export const MINI_APP_INVALID_CONFIG_TARGET_CODE: string = "INVALID_CONFIG_TARGET";

/**
 * 提交保存的配置文本不是合法 JSON 语法时返回的错误码。
 * 不变量：非空大写下划线状态码。所属模块：`packages/mini-app-api-server/view/configs/validate.ts`。
 */
export const MINI_APP_INVALID_JSON_SYNTAX_CODE: string = "INVALID_JSON_SYNTAX";

/**
 * 提交保存的配置 JSON 未通过严格字段白名单、类型或跨文件依赖校验时返回的错误码。
 * 不变量：非空大写下划线状态码。所属模块：`packages/mini-app-api-server/view/configs/validate.ts`。
 */
export const MINI_APP_CONFIG_VALIDATION_FAILED_CODE: string =
  "CONFIG_VALIDATION_FAILED";

/**
 * 执行宿主 systemd 服务重启命令失败或超时时返回的错误码。
 * 不变量：非空大写下划线状态码。所属模块：`packages/mini-app-api-server/view/configs/storage.ts`。
 */
export const MINI_APP_SERVICE_RESTART_FAILED_CODE: string =
  "SERVICE_RESTART_FAILED";

/**
 * 图库单张预览图片读取路由（`GET|HEAD /api/gallery/file`）的完整双层鉴权与加密查询策略：
 * - 请求头快路径 + Telegram WebApp 超管签名 + 二次认证会话（禁止查询参数凭据与 `?token=` 免会话放行）；
 * - 业务查询参数须通过 `?e=` 进行 AES-256-GCM 加密，图片二进制流响应体不加密；
 * - `encryptResponse` 为 `false`，并发图片拉取不触发会话密钥滑动轮换。
 * 不变量：供 `packages/mini-app-api-server/routes/gallery.ts` 使用。
 * 所属模块：`packages/mini-app-api-server/routes/gallery.ts`。
 */
export const MINI_APP_GALLERY_FILE_AUTH_POLICY: Readonly<MiniAppAuthPolicy> = {
  requireSession: true,
  encryptRequest: true,
  encryptResponse: false,
};

/**
 * 图库单图二进制上传路由（`POST /api/gallery/upload`）的鉴权与加密策略：
 * 请求体须为当前会话 256-bit AES-GCM 密钥加密的原始二进制帧（`[12B IV || 密文+16B 标签]`，绑定 `POST /api/gallery/upload:req` AAD，允许最大 `MINI_APP_MAX_UPLOAD_BODY_BYTES`），响应体为经会话密钥加密的业务 JSON。
 * 不变量：校验会话密钥持有性并执行同纪元 IV 防重放，拒绝未加密原始二进制上传；供 `packages/mini-app-api-server/routes/gallery.ts` 使用。
 * 所属模块：`packages/mini-app-api-server/middleware/pipeline.ts` 与 `packages/mini-app-api-server/routes/gallery.ts`。
 */
export const MINI_APP_GALLERY_UPLOAD_AUTH_POLICY: Readonly<MiniAppAuthPolicy> = {
  requireSession: true,
  encryptRequest: true,
  encryptBinaryRequest: true,
  encryptResponse: true,
  maxBodyBytes: MINI_APP_MAX_UPLOAD_BODY_BYTES,
};

/**
 * 部署配置保存路由（`POST /api/configs/save`）的完整双层鉴权与加密策略（放宽会话加密请求体上限至 4 MiB）。
 * 不变量：请求体与响应体均直接经会话 256-bit 临时密钥进行 AES-256-GCM 加密交互。
 * 所属模块：`packages/mini-app-api-server/routes/configs.ts`。
 */
export const MINI_APP_CONFIG_SAVE_AUTH_POLICY: Readonly<MiniAppAuthPolicy> = {
  requireSession: true,
  encryptRequest: true,
  encryptResponse: true,
  maxBodyBytes: MINI_APP_MAX_CONFIG_BODY_BYTES,
};

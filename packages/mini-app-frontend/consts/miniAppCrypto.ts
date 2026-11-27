/**
 * Mini App 前端 AES-256-GCM 会话加密传输与临时 X25519 ECDH / Ed25519 验签常量。
 * 与服务端重合的常量取值保持一致（由 `test/mini-app-frontend/frontendParity.test.ts` 核对）。
 */

/** Mini App 会话临时密钥与 ECDH 派生对称密钥的位宽（256 位）。不变量：固定为 `256`，对应 `MINI_APP_SESSION_KEY_BYTES * 8`。所属模块：`packages/mini-app-frontend/libs/crypto.ts`。 */
export const MINI_APP_SESSION_KEY_BITS: number = 256;

/** Mini App 会话临时密钥的原始字节长度（32 字节 = 64 位十六进制字符）。不变量：固定为 `32`。所属模块：`packages/mini-app-frontend/libs/crypto.ts` 与 `packages/mini-app-frontend/libs/credentials.ts`。 */
export const MINI_APP_SESSION_KEY_BYTES: number = 32;

/** Mini App AES-256-GCM 每次加密随机生成的初始化向量（IV / Nonce）字节数（12 字节 = 96 位）。不变量：固定为 `12`。所属模块：`packages/mini-app-frontend/libs/crypto.ts`。 */
export const MINI_APP_AES_GCM_IV_BYTES: number = 12;

/** Mini App AES-256-GCM 附加在密文尾部的认证标签位宽（128 位 = 16 字节）。不变量：固定为 `128`。所属模块：`packages/mini-app-frontend/libs/crypto.ts`。 */
export const MINI_APP_AES_GCM_TAG_BITS: number = 128;

/** Mini App AES-256-GCM 附加在密文尾部的认证标签字节数（16 字节）。不变量：等于 `MINI_APP_AES_GCM_TAG_BITS / 8`。所属模块：`packages/mini-app-frontend/libs/crypto.ts`。 */
export const MINI_APP_AES_GCM_TAG_BYTES: number = 16;

/** Web Crypto 临时密钥协商（ECDH）椭圆曲线算法名称常量。不变量：恒为 `"X25519"`，与 `packages/consts/miniAppCrypto.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/libs/handshakeCrypto.ts`。 */
export const MINI_APP_X25519_ALGORITHM: string = "X25519";

/** Web Crypto 源站静态验签公钥数字签名算法名称常量。不变量：恒为 `"Ed25519"`，与 `packages/consts/miniAppCrypto.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/libs/handshakeCrypto.ts`。 */
export const MINI_APP_ED25519_ALGORITHM: string = "Ed25519";

/** Web Crypto 密钥派生函数算法名称常量。不变量：恒为 `"HKDF"`，与 `packages/consts/miniAppCrypto.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/libs/handshakeCrypto.ts`。 */
export const MINI_APP_HKDF_ALGORITHM: string = "HKDF";

/** HKDF 密钥派生函数使用的哈希算法名称常量。不变量：恒为 `"SHA-256"`，与 `packages/consts/miniAppCrypto.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/libs/handshakeCrypto.ts`。 */
export const MINI_APP_HKDF_HASH: string = "SHA-256";

/** X25519 临时公钥原始字节长度（32 字节 = 256 位）。不变量：固定为 `32`，与 `packages/consts/miniAppCrypto.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/libs/handshakeCrypto.ts`。 */
export const MINI_APP_X25519_PUBLIC_KEY_BYTES: number = 32;

/** Ed25519 静态验签公钥原始字节长度（32 字节 = 256 位）。不变量：固定为 `32`，与 `packages/consts/miniAppCrypto.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/libs/handshakeCrypto.ts`。 */
export const MINI_APP_ED25519_PUBLIC_KEY_BYTES: number = 32;

/** Ed25519 签名原始字节长度（64 字节 = 512 位）。不变量：固定为 `64`。所属模块：`packages/mini-app-frontend/libs/handshakeCrypto.ts`。 */
export const MINI_APP_ED25519_SIGNATURE_BYTES: number = 64;

/** 服务端每次启动在内存中生成并注入前端静态 JS 产物的 Ed25519 验签公钥（44 位标准 Base64）；源码内保留编译占位符并在源站物化打包产物时替换为当次启动公钥。不变量：仅被 `packages/mini-app-frontend/libs/signingKey.ts` 直接读取；未替换时包含下划线，严格验签直接拒绝。所属模块：`packages/mini-app-frontend/libs/signingKey.ts`。 */
export const MINI_APP_SERVER_SIGNING_PUBLIC_KEY_BASE64: string =
  "__COPY_NINJA_MINI_APP_ED25519_PUBLIC_KEY_V1__";

/** Mini App 滑动续期旋转会话时，以当前会话密钥封装下发新 256 位会话密钥（`<ivBase64>.<cipherBase64>`）的 HTTP 响应头名（小写）。不变量：仅响应头出现，客户端绝不在请求头回传该头；与 `packages/consts/miniAppCrypto.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/api/request.ts`。 */
export const MINI_APP_SESSION_KEY_HEADER: string = "x-mini-app-session-key";

/** Mini App 加密载荷格式非法或 AES-256-GCM 解密校验失败时的错误代码。不变量：非空大写下划线错误代码。所属模块：`packages/mini-app-frontend/libs/crypto.ts` 与 `packages/mini-app-frontend/api/request.ts`。 */
export const MINI_APP_INVALID_ENCRYPTED_PAYLOAD_CODE: string = "INVALID_ENCRYPTED_PAYLOAD";

/** 临时 ECDH 登录握手缺失、已过期、Ed25519 验签失败或密文/绑定校验失败时的错误代码。不变量：非空大写下划线错误代码，与 `packages/consts/miniAppCrypto.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/api/authLogin.ts` 与 `packages/mini-app-frontend/libs/handshakeCrypto.ts`。 */
export const MINI_APP_INVALID_HANDSHAKE_CODE: string = "INVALID_HANDSHAKE";

/** 当前 WebView / 浏览器环境缺失 Web Crypto 安全上下文或不支持 `Ed25519` / `X25519` 密码学算法时的错误代码。不变量：非空大写下划线错误代码，仅前端识别并在不支持的宿主页提示升级客户端，不触发刷新重连循环。所属模块：`packages/mini-app-frontend/libs/signingKey.ts`、`packages/mini-app-frontend/libs/handshakeCrypto.ts` 与 `packages/mini-app-frontend/i18n/configs/`。 */
export const MINI_APP_WEBCRYPTO_UNSUPPORTED_CODE: string = "WEBCRYPTO_UNSUPPORTED";

/** 32 位十六进制临时 ECDH 登录握手 ID 的格式匹配规则。不变量：不带全局标志 `g`，与 `packages/consts/miniAppCrypto.ts` 同名常量一致（由 `test/mini-app-frontend/frontendParity.test.ts` 核对）。所属模块：`packages/mini-app-frontend/libs/handshakeCrypto.ts`。 */
export const MINI_APP_HANDSHAKE_ID_HEX_PATTERN: Readonly<RegExp> = /^[0-9a-f]{32}$/i;

/** 服务端对临时 X25519 登录握手公钥抄本执行 Ed25519 签名时使用的域分离前缀。不变量：恒为 `"CopyNinjaMiniAppEcdhV1"`，与 `packages/consts/miniAppCrypto.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/libs/handshakeCrypto.ts`。 */
export const MINI_APP_HANDSHAKE_SIGNATURE_DOMAIN: string =
  "CopyNinjaMiniAppEcdhV1";

/** 客户端到服务端（c2s）登录请求方向经 HKDF-SHA256 派生 AES-256-GCM 密钥时的 `info` 域分离前缀。不变量：与 `MINI_APP_HANDSHAKE_HKDF_S2C_INFO_PREFIX` 严格区分方向，与 `packages/consts/miniAppCrypto.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/libs/handshakeCrypto.ts`。 */
export const MINI_APP_HANDSHAKE_HKDF_C2S_INFO_PREFIX: string =
  "CopyNinjaMiniAppEcdhV1:c2s";

/** 服务端到客户端（s2c）登录响应方向经 HKDF-SHA256 派生 AES-256-GCM 密钥时的 `info` 域分离前缀。不变量：与 `MINI_APP_HANDSHAKE_HKDF_C2S_INFO_PREFIX` 严格区分方向，与 `packages/consts/miniAppCrypto.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/libs/handshakeCrypto.ts`。 */
export const MINI_APP_HANDSHAKE_HKDF_S2C_INFO_PREFIX: string =
  "CopyNinjaMiniAppEcdhV1:s2c";

/** 使用临时 ECDH 派生密钥加密 `POST /api/auth/login` 登录请求时绑定的 AEAD 附加认证数据文本。不变量：恒为 `"POST /api/auth/login:request"`，与 `packages/consts/miniAppCrypto.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/api/authLogin.ts`。 */
export const MINI_APP_LOGIN_REQUEST_AAD: string =
  "POST /api/auth/login:request";

/** 使用临时 ECDH 派生密钥解密 `POST /api/auth/login` 响应信封时绑定的 AEAD 附加认证数据文本。不变量：恒为 `"POST /api/auth/login:response"`，与 `packages/consts/miniAppCrypto.ts` 同名常量一致。所属模块：`packages/mini-app-frontend/api/authLogin.ts`。 */
export const MINI_APP_LOGIN_RESPONSE_AAD: string =
  "POST /api/auth/login:response";

/** Mini App 已认证加密路由承载 AES-256-GCM 封装查询串（`<ivBase64>.<cipherBase64>`）的唯一 URL 查询参数名。不变量：固定为 `"e"`，与 `packages/consts/miniAppCrypto.ts` 同名常量一致（由 `test/mini-app-frontend/frontendParity.test.ts` 核对）。所属模块：`packages/mini-app-frontend/api/request.ts`。 */
export const MINI_APP_ENCRYPTED_QUERY_PARAM: string = "e";

/** Mini App 已认证加密路由 URL 查询参数 `e` 解码后的封装密文最大字符长度上限。不变量：正整数 `4_096`，与 `packages/consts/miniAppCrypto.ts` 同名常量一致（由 `test/mini-app-frontend/frontendParity.test.ts` 核对）。所属模块：`packages/mini-app-frontend/libs/crypto.ts`。 */
export const MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH: number = 4_096;

/** `GET|HEAD /api/gallery/download` 通过一次性下载票据完成原生文件下载时使用的唯一 URL 查询参数名。不变量：固定为 `"ticket"`，与 `packages/consts/miniAppCrypto.ts` 同名常量一致（由 `test/mini-app-frontend/frontendParity.test.ts` 核对）。所属模块：`packages/mini-app-frontend/api/galleryDownload.ts`。 */
export const MINI_APP_DOWNLOAD_TICKET_PARAM: string = "ticket";

/** 标准 RFC 4648 Base64 编码的 64 字符字母表。不变量：长度固定为 64。所属模块：`packages/mini-app-frontend/libs/crypto.ts`。 */
export const MINI_APP_BASE64_ALPHABET: string =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

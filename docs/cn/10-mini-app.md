# 10 Mini App 设置与推荐配置

<p align="center">
  <b>简体中文</b> · <a href="../en/10-mini-app.md">English</a> · <a href="../ja/10-mini-app.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="09-commands.md">← 上一页：09 命令与行为参考</a> · <a href="11-performance.md">下一页：11 性能基准 →</a>
</p>

---

本页介绍如何在 `config/static/bot.json` 中启用超级管理员专属 Telegram Mini App 管理控制台、使用推荐的 Cloudflare Tunnel（`cloudflared`）将本地 HTTP 服务暴露为公网 HTTPS 入口，以及控制台的打开方式、双层认证与 256-bit 临时密钥 AES-256-GCM 传输加密、Google Authenticator TOTP 绑定、在线高亮 JSON 配置编辑与日常运维要点。完整 JSON 字段约束请参阅 [部署配置说明](../../config_example/README/zh.md#botjson)，控制台 HTTP API 路由与权限边界请参阅 [09 命令参考](09-commands.md#mini-app-console)。

## 配置 `bot.json` 启用 Mini App

在 `config/static/bot.json` 中添加可选的 `mini_app` 配置对象：

```json
{
  "bot_token": "replace-with-telegram-bot-token",
  "super_admin_user_id": 123456789,
  "atmosphere": "mesugaki",
  "log_level": "operation",
  "time_zone": "Asia/Tokyo",
  "mini_app": {
    "url": "https://app.example.com",
    "port": 3000,
    "host": "127.0.0.1",
    "password": "your-secure-password-123456"
  }
}
```

| 字段 | 必填/可选 | 约束与说明 |
| :--- | :---: | :--- |
| `url` | **必填** | Telegram 客户端打开 WebApp 的公网 `https://` 绝对地址；支持配置子路径前缀（如 `https://app.example.com/sub`），服务端同时兼容保留或剥离路径前缀的反向代理 |
| `port` | **必填** | 本地 `Bun.serve` HTTP 监听端口，取值为 `MINI_APP_PORT_MIN`～`MINI_APP_PORT_MAX`（`1`～`65535`）的安全整数，推荐设为 `3000` 并与隧道转发端口一致 |
| `host` | 可选 | 非空本地 `Bun.serve` HTTP 监听地址，缺省为 `MINI_APP_DEFAULT_HOST`（`"127.0.0.1"`）；仅监听本机回环地址，无需向公网直接开放防火墙端口 |
| `password` | **必填** | 首屏访问密码，必须为至少包含 6 位数字（`0-9`，匹配 `MINI_APP_PASSWORD_AT_LEAST_SIX_DIGITS_PATTERN`）的非空字符串，且不得保留示例占位值 `MINI_APP_PASSWORD_PLACEHOLDER`（`"replace-with-mini-app-password"`） |

- **可选启用**：`mini_app` 整节缺省时，机器人不会启动本地 `Bun.serve` HTTP 服务、不注册任何路由，也不会在超级管理员私聊挂载 `MenuButtonWebApp`；启用时下属 `url`、`port`、`password` 必填，`host` 可选（缺省为 `MINI_APP_DEFAULT_HOST`），且禁止保留遗留 `signing_private_key` / `signing_public_key` 字段。手工从 `config_example/static/bot.json` 复制模板且不使用 Mini App 时，请删除 `mini_app` 节（保留示例占位密码会在启动校验阶段直接拒绝；运行 `install.sh` 交互式配置时会自动剥离仍为占位密码的 `mini_app` 节，并在重跑安装脚本时保留已填写真实密码的 `mini_app` 配置）。
- **生效方式**：`config/static/bot.json` 属于静态配置，修改 `mini_app` 后必须重启机器人服务生效。

---

## 推荐配置方式：使用 Cloudflare Tunnel

Telegram Mini App 强制要求使用公网 `https://` 地址。推荐使用 **Cloudflare Tunnel（`cloudflared`）**：按上例配置时机器人只监听本机 `127.0.0.1:3000`（`host` 缺省为 `MINI_APP_DEFAULT_HOST`，`port` 取配置值），无需在服务器开放公网入站端口，也无需自行申请与续期 TLS 证书；由 `cloudflared` 在本机建立出站加密隧道，将固定子域名（如 `https://app.example.com`）的流量安全转发至本地 `http://localhost:3000`。

### 安装 `cloudflared`

```shell
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
rm -f cloudflared.deb
```

### 登录和配置域名路由

```shell
# 1. 登录授权（会弹出浏览器让你选择要授权的 Cloudflare 域名，生成 cert.pem）
cloudflared tunnel login

# 2. 创建一条名为 my-app 的隧道（会生成对应的凭证 JSON 文件和 Tunnel UUID）
cloudflared tunnel create my-app

# 3. 将你的固定子域名自动添加 CNAME 路由到该隧道
cloudflared tunnel route dns my-app app.example.com

# 4. 直接把固定域名流量转发到本地端口（如 3000 端口）并启动
cloudflared tunnel run --url http://localhost:3000 my-app
```

### 配置隧道服务

在前台验证转发无误后，可将隧道配置安装为 systemd 常驻服务并设置开机自启：

```shell
# 获取 <Tunnel-UUID>
cloudflared tunnel list
cd ~/.cloudflared
# 编辑配置文件
vim config.yml
```

```yaml
tunnel: <Tunnel-UUID>
credentials-file: /root/.cloudflared/<Tunnel-UUID>.json # 注意：如果是普通用户或 macOS，请改为对应的绝对路径（如 /home/ubuntu/.cloudflared/...）

ingress:
  - hostname: app.example.com
    service: http://localhost:3000
  - service: http_status:404
```

```shell
# 启动
# 将配置安装为 systemd 服务（会自动将 ~/.cloudflared/config.yml 复制到 /etc/cloudflared/）
sudo cloudflared --config ~/.cloudflared/config.yml service install

# 启动并设置开机自启
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

### 卸载服务并删除隧道

如需停用并清理隧道服务，可按顺序执行：

```shell
sudo cloudflared service uninstall
cloudflared tunnel cleanup <隧道名>
cloudflared tunnel delete -f <隧道名>
```

---

## 打开控制台与双层认证

### 1. 私聊入口按钮

配置 `mini_app` 并启动机器人后，系统在注册命令菜单时会自动向超级管理员（`SUPER_ADMIN_USER_ID`）与机器人的私聊窗口挂载左下角 `MenuButtonWebApp`（按钮文字为 `MINI_APP_BUTTON_TEXT`，即 `App`）。超级管理员在私聊窗口点击左下角 **`App`** 按钮即可在 Telegram 内置 WebView 中打开管理控制台。

### 2. 双层安全认证与锁定保护

- **单页入口与前端包门禁（`MINI_APP_REJECT_HTML_PATH` / `MINI_APP_PAGE_GATE_COOKIE_NAME`）**：
  - **门禁核验条件**：单页路由（`/`、`/index.html` 及其子路径别名）先核验同源请求头与超级管理员门禁凭据（`X-Telegram-Init-Data` / `Authorization: tma <initData>` 请求头，或由 `BOT_TOKEN` 与 `MINI_APP_PAGE_GATE_SECRET_SEED` 派生密钥签名并绑定 `SUPER_ADMIN_USER_ID` 的 `MINI_APP_PAGE_GATE_COOKIE_NAME` 门禁 Cookie：`HttpOnly; SameSite=Lax`，HTTPS 下附带 `Secure`，有效期 `MINI_APP_PAGE_GATE_COOKIE_MAX_AGE_SECONDS` 即 45 分钟），同时确认未处于密码锁定状态。
  - **未授权隔离与打包块保护**：非 Telegram 外部访问、非超级管理员账号、凭据无效或处于锁定期的单页请求，一律返回独立的 [`packages/mini-app-api-server/resource/reject.html`](../../packages/mini-app-api-server/resource/reject.html)（`MINI_APP_REJECT_HTML_PATH`；模板按唯一 `<body>` 标签预切分缓存在主线程 `miniAppRejectHtmlHolder` 中，响应时将当次诊断字段转义拼接为 `<body>` 的 `data-*` 属性，零外部网络请求），不返回完整前端 HTML 或打包产物。前端打包块（`/chunk-*` 等，匹配 `MINI_APP_BUNDLE_ASSET_ROUTE_PATTERN`）按需物化于 `miniAppBundledAssetsHolder`，同样强制门禁校验并拦截跨站与地址栏直接导航，未授权返回 `401`/`403` JSON。
  - **WebView 冷启动自动换票**：在 Telegram WebView 冷启动打开单页时，`reject.html` 内联脚本从本地提取 `initData`（`window.Telegram.WebApp.initData`、`?tgWebAppData`、`#tgWebAppData` 或 `sessionStorage.__telegram__initParams`）向 `./api/auth/precheck` 发起预检；`GET /api/auth/precheck` 与 `POST /api/auth/login` 返回 `200` 时通过 `Set-Cookie` 签发或刷新门禁 Cookie，随后页面单次重载进入完整控制台（带 5 秒 `sessionStorage` 重载防环保护）。预检被拒或携带失效门禁 Cookie 访问时，立即下发 `Max-Age=0` 清除门禁 Cookie。
  - **打包产物按需注入与防重放**：`startMiniAppServer` 每次启动在主线程内存中生成私钥不可导出的 Web Crypto `Ed25519` 签名密钥对（`ensureMiniAppRuntimeSigningKeyPair`，停机时随 `clearMiniAppRuntimeSigningKeyPair` 清空）。`handlers/page.ts` 在物化前端打包 JS 时将编译期占位符 `MINI_APP_SERVER_SIGNING_PUBLIC_KEY_PLACEHOLDER` 替换为本次启动生成的 32 字节原始公钥 Base64 并重算 `ETag`（保留 `MINI_APP_BUNDLE_CACHE_CONTROL` 协商语义）；前端遇到未替换或非法公钥时直接 fail-closed 拒绝握手（`INVALID_HANDSHAKE`）。
  - **第一层（前置请求头守卫与 Telegram WebApp `initData` 签名核验）**：
    - 每个 API 请求按路由静态鉴权策略（`MiniAppAuthPolicy`）由同步鉴权管道（`authorizeMiniAppRequest`）先经 `headerGuard` 执行同源（`isAllowedRequestOriginUrl` 仅信任与配置 `mini_app.url` 完全同源（`https:` 协议、主机与端口一致）的来源，以及请求 URL 为回环地址时与请求 URL 自身同源的来源，忽略 `Host` / `X-Forwarded-Host` / `X-Forwarded-Proto`）与凭据头形态快路径校验（一次提取请求头 `initData`），再核验 Telegram 客户端签发的原始查询串（`X-Telegram-Init-Data` 或 `Authorization: tma <initData>`，长度上限 `MINI_APP_MAX_INIT_DATA_LENGTH`）。
    - 服务端使用 `BOT_TOKEN` 与种子 `MINI_APP_WEB_APP_DATA_SECRET_SEED`（`"WebAppData"`）核验 HMAC-SHA256 签名、`MINI_APP_AUTH_MAX_AGE_SECONDS`（45 分钟）时效（活跃会话期间放行至 `2 小时 + 45 分钟`），并严格校验 `user.id === SUPER_ADMIN_USER_ID`；非超级管理员账号在任何情况下均直接拒绝。
- **第二层（每次启动 Ed25519 + 临时 X25519 ECDH 登录、256-bit 临时密钥与 45 分钟/2 小时生命周期）**：
  - **首屏解锁与 5 会话硬上限**：未绑定验证器时输入 `mini_app.password` 解锁；已绑定验证器时优先校验当前 30 秒时间步的 6 位 TOTP 动态码（单步校验通过且会话签发成功后才记录 `miniAppLastConsumedTotpStepHolder` 防同时间步重放）。主线程最多同时缓存 `MINI_APP_SESSION_MAX`（`5`）个未过期活跃会话与密钥；若已满 5 个未过期会话，凭据校验通过的新登录照常签发，并淘汰签发或最近一次轮换距今最久的会话（同步吊销其下载票据），被淘汰的客户端下一次请求即需重新登录。
  - **临时 X25519 握手与本地非导出密钥隔离存储**：尚未解锁活跃会话时，`GET /api/auth/precheck` 生成一对临时 `X25519` 公私钥并用本次启动内存 `Ed25519` 私钥对 `{ domain, handshakeId, serverPublicKey, expiresAt }` 签名下发（容量 `MINI_APP_HANDSHAKE_MAX` = 16，TTL `MINI_APP_HANDSHAKE_TTL_MS` = 5 分钟），并刷新 `MINI_APP_PAGE_GATE_COOKIE_NAME` 门禁 Cookie；已解锁会话访问预检仅返回只读状态（`sessionValid`、`sessionExpiresAt`，不轮换令牌或签发密钥）。客户端以静态注入公钥验签（`signatureMismatch` 在存在 `sessionStorage` 时带 10 秒防环窗触发单次 `location.reload()`；`crypto.subtle` 缺失或不支持时归一为 `WEBCRYPTO_UNSUPPORTED` 且不重载），生成客户端临时 `X25519` 密钥对经 ECDH + HKDF-SHA256（`salt` 为 `handshakeId` 原始字节，`info` 严格区分 `c2s` / `s2c` 方向并绑定双方临时公钥）派生方向隔离密钥，以 `c2sKey`（AEAD `additionalData = MINI_APP_LOGIN_REQUEST_AAD`）加密提交 `{ handshakeId, password }` 或 `{ handshakeId, totpCode }` 至 `POST /api/auth/login`。服务端通过 `miniAppInFlightHandshakeIds` 拦截并发重放并用完即焚，直接以 `s2cKey`（AEAD `additionalData = MINI_APP_LOGIN_RESPONSE_AAD`）加密封装下发有效期 `MINI_APP_SESSION_TTL_MS`（45 分钟）的 `sessionToken`（经 `X-Mini-App-Session` 请求头携带）与 256-bit（`MINI_APP_SESSION_KEY_BITS`，64 位十六进制）会话临时密钥 `sessionKey`，序列化完成后立即清除 `pendingSessionKey`；所有握手通过后的 `200`/`403` 登录响应均加密返回，客户端拒绝明文的成功与凭据裁决降级响应。`sessionKey` 仅在 `POST /api/auth/login` 与加密业务路由滑动续期时下发；客户端将令牌与不可导出的 `CryptoKey` 作为同代 `{ token, cryptoKey }` 配对存于 IndexedDB、将 `{ token, expiresAt }` 令牌元数据存于 `sessionStorage`（拒绝 `localStorage` 与 `globalThis` 全局变量；水合以 IndexedDB 配对为准，`sessionStorage` 令牌已更新而新密钥尚未落盘时恢复上一代配对并回写元数据，缺一或形态不符即自毁清理），**绝不在 HTTP 请求中发送 `sessionKey`**。客户端按响应 `Date` 头换算服务端过期时间，预检失败仅清除发出预检时的本地令牌，点击顶栏「锁定」时清除本地存储并经 `POST /api/auth/logout` 异步吊销会话、密钥及关联下载票据。
  - **随机冷却滑动轮换、2 小时绝对寿命封顶与旧凭据即时作废**：单次登录会话允许滑动续期的最长绝对寿命为 `MINI_APP_SESSION_MAX_LIFETIME_MS`（2 小时）。每代密钥签发或轮换时在 `[MINI_APP_SESSION_REFRESH_MIN_MS, MINI_APP_SESSION_REFRESH_MAX_MS]`（5 秒～5 分钟）闭区间内均匀随机抽取下一次触发轮换的冷却时间点；超过该随机冷却点或本代 `seenRequestIvs.size` 达到 `MINI_APP_SESSION_ROTATE_AT_SEEN_IVS`（3,072）水位后（在 45 分钟窗口有效期内且未达 2 小时封顶）任意访问启用加密响应的业务路由都会触发服务端原地轮换新 `sessionToken` 与新 256-bit `sessionKey`、重置新纪元 `seenRequestIvs` 与随机轮换冷却时间，并顺延 45 分钟有效期，经 `X-Mini-App-Session`、`X-Mini-App-Session-Expires-At` 与 `X-Mini-App-Session-Key`（以本次请求匹配的会话密钥按 AES-256-GCM 封装 `<ivBase64>.<cipherBase64>`，附加认证数据 `additionalData = UTF8(newToken)`）响应头同步下发；客户端并发请求按 `(sentSessionToken, cryptoKeyAtSend)` 快照加解密，仅当活跃令牌仍等于 `sentSessionToken` 时写入轮换后的新凭据，并忽略缺失合法 `X-Mini-App-Session-Key` 的轮换头。服务端轮换提交时同步启动共享封装句柄 `sealedSessionKeyPromise`（仅解析为密文，不写入 `pendingSessionKey`），封装落定后记入 `sealedSessionKey` 并保留至新令牌被确认或宽限期到期；在此之前携带 `previousToken` 访问加密响应路由不会再次轮换，而是等待同一 `sealedSessionKeyPromise` 或直接取回已落定的 `sealedSessionKey`，原样重新附带同一新令牌与同一 `X-Mini-App-Session-Key` 密文，使轮换响应丢失的客户端仍能切换到新一代。上一轮 `previousToken` / `previousCryptoKey` 享有独立的 5 分钟并发宽限期（`MINI_APP_SESSION_PREVIOUS_GRACE_MS`）供在途请求过渡，并在客户端首次携带新令牌成功提交请求时**立即作废**（登出、验证器变更吊销或锁定时同样立即清除）。
- **AES-256-GCM 传输加密（`MiniAppEncryptedEnvelope`、二进制上传帧、`?e=`）、两阶段原子提交与免加密边界**：
  - **业务 JSON 信封、二进制加密上传与 URL 查询串端到端加密**：受会话保护的业务 JSON 路由均启用 Web Crypto `AES-GCM`（256-bit `sessionKey`、12 字节随机 IV `MINI_APP_AES_GCM_IV_BYTES`、128-bit 认证标签 `MINI_APP_AES_GCM_TAG_BITS`），请求体与 JSON 响应体封装为 `{ encrypted: true, iv, payload }`（默认外层请求体上限 `MINI_APP_MAX_ENCRYPTED_JSON_BODY_BYTES` 即 64 KiB，`POST /api/configs/save` 放宽至 `MINI_APP_MAX_CONFIG_BODY_BYTES` 即 4 MiB），图库上传（`POST /api/gallery/upload`）强制使用 `[12B IV || 密文+16B 标签]` 原始二进制加密帧（上限 `MINI_APP_MAX_UPLOAD_BODY_BYTES`），方向 AAD 统一由 `buildMiniAppEnvelopeAad` 绑定 `"${method} ${routePath}:req"` / `":res"`；非 `GET`/`HEAD` 加密路由拒绝 `0` 字节空正文（无载荷 POST/DELETE 发送加密 `"{}"`）。全部 `encryptRequest: true` 路由均通过 `?e=<ivBase64>.<cipherBase64>`（`MINI_APP_ENCRYPTED_QUERY_PARAM`，密文上限 `MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH` 即 4096 字符）传递加密查询串，严格仅允许单一 `e` 参数且 AEAD `additionalData` 绑定 `"${method} ${routePath}"`；裸 `?`、明文或越权/重复查询参数、空串或 `?` 开头的解密结果、信封/`?e=`/`[12B IV || 密文]` 畸形或验签失败以及同密钥纪元 IV 重放统一返回 `400 INVALID_ENCRYPTED_PAYLOAD`（`seenRequestIvs` 达 `MINI_APP_SESSION_ROTATE_AT_SEEN_IVS` = 3,072 水位时由加密响应路由主动触发轮换并重置 IV 集合与冷却时间，超 `MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS` = 4,096 硬上限返回 `401 SESSION_EXPIRED` 并吊销会话）。`runMiniAppAuthorized` 严格按「只读 `authorizeMiniAppRequest` -> 异步解密与初筛 -> `commitMiniAppSessionAccess` 原子复核活跃状态、提交同纪元 IV 与推进轮换」两阶段提交执行，消除异步解密窗口内的 TOCTOU 竞态（失败解密 `400` 绝不抹除 `previousToken` 或触发轮换，窗口期内会话被吊销返回 `401 SESSION_EXPIRED`；只读查找通过后令牌在解密窗口内被并发轮换并确认时，按登录内不变的会话谱系 `lineageId` 定位存活会话，在查找时所属密钥纪元的 IV 集合上提交且不轮换）；客户端在加密响应路由上先校验并解密响应体再同步轮换头，同样拒绝加密响应路由上的明文 `2xx` 响应，本地缺少会话令牌或密钥时，加密 JSON、查询与二进制上传请求一律在发出前拦截并要求重新解锁；各业务页面、配置编辑、多图上传、选择器轮询、图库预览与后台轮询统一经 `packages/mini-app-frontend/api/authError.ts` 结合传输层绑定的私有发包会话令牌（`sentSessionToken`）上下文归类：遇到会话失效、密钥吊销/解密失败（`MINI_APP_SESSION_REAUTH_ERROR_CODES` 或裸 `401`）时按发包令牌一致性清理凭据并重定向回登录门禁（`AuthGatePage`），遇到一层网关、锁定或 WebCrypto 拒绝（`MINI_APP_ACCESS_DENIED_ERROR_CODES` 中非会话依赖项）时无条件清凭据并经 `checking` 重新预检进入拦截页（`AccessDeniedPage`），依赖活跃会话延展窗口的 `MINI_APP_EXPIRED_AUTH_DATE_CODE`（`EXPIRED_AUTH_DATE`）同样按发包令牌一致性防误清；已被更新一代活跃会话取代的滞后旧令牌重认证与 `EXPIRED_AUTH_DATE` 响应会被同时抑制清理、锁定重定向、全局 Toast 与配置错误横幅，且当前会话的重定向不被过时请求序号守卫吞掉、也不被滞后 `401` 退回 `password`。
  - **下载双轨与免加密边界**：首屏预检与登出（`GET /api/auth/precheck`、`POST /api/auth/logout`）、单页/打包资源与存活探针（`/`、`/index.html`、`reject.html`、`/chunk-*`、`/favicon.ico`、`/healthz`）全链免加密，`POST /api/auth/login` 使用临时 ECDH（`c2sKey`/`s2cKey`）；在受会话保护的 `/api/*` 路由中，仅 `GET|HEAD /api/gallery/file`（`MINI_APP_GALLERY_FILE_AUTH_POLICY`）与 `GET|HEAD /api/gallery/download`（`MINI_APP_GALLERY_DOWNLOAD_AUTH_POLICY`）免加密二进制响应体（`encryptResponse: false`，且不触发会话密钥轮换；图库原图下载浏览器降级路径走请求头 + 加密 `?e=` + `blob:` 保存，Telegram 原生 `WebApp.downloadFile` 路径先以加密 `POST /api/gallery/download-ticket` 换取 60 秒单次一次性 64-hex `?ticket=` 票据，`HEAD` 不消费、`GET` 消费即焚、上限 64，按会话谱系 `sessionLineageId` 绑定——会话轮换期间自然保持有效，登出/锁定/过期/淘汰/IV 超限/验证器变更/删图按谱系即时吊销）；`POST /api/gallery/upload` 请求与响应双端均使用 `sessionKey` 加密；图库删除统一经 `POST /api/gallery/delete` 的加密 JSON 请求体 `{ fileName }` 执行。
- **防爆破锁定**：
  - 连续输错密码或动态码达到 `MINI_APP_PASSWORD_MAX_ATTEMPTS`（3 次）时，超级管理员 ID 锁定 `MINI_APP_PASSWORD_LOCKOUT_MS`（30 分钟），清空所有已认证会话、会话密钥、待消费临时 X25519 握手与一次性下载票据，并通过 `Max-Age=0` 清除 `MINI_APP_PAGE_GATE_COOKIE_NAME` 门禁 Cookie（锁定期内的单页与打包资源请求同样拒绝并清除门禁 Cookie）。
  - 锁定生效时仍在处理中的并发登录请求不再比对凭据，一律按失败计数并将锁定期顺延 30 分钟；由未锁定转入锁定时向超级管理员私聊发送一次含解锁时间与来源 IP 的告警，锁定顺延不重复发送。

### 3. 绑定 Google Authenticator (TOTP) 动态码（推荐）

首次使用访问密码进入控制台后，推荐在控制台「验证器」标签页绑定唯一 Google Authenticator 动态口令：

1. 在「验证器」页面点击生成待绑定密钥与二维码（待确认密钥在主线程内存中的有效期为 `MINI_APP_TOTP_PENDING_TTL_MS`，即 10 分钟，连续输错 `MINI_APP_PASSWORD_MAX_ATTEMPTS` 次立即作废）。
2. 使用 Google Authenticator 等兼容应用扫描二维码（或手动输入 32 位 Base32 密钥），输入当前 `MINI_APP_TOTP_STEP_SECONDS`（30 秒）时间步的 `MINI_APP_TOTP_DIGITS`（6 位）动态验证码完成绑定。
3. 验证通过后，由 `runSerialChain` 经 `miniAppTotpMutationChainHolder` 串行执行写入或删除（避免并发变更时磁盘与内存状态交错）：密钥以原子写（权限 `0o600`）持久化至运行时数据根目录下的 `memory/mini-app-totp/totp.json`（Schema 版本 `MINI_APP_TOTP_RECORD_VERSION`）。启用后，控制台首屏登录将自动切换为优先校验 6 位 TOTP 动态码（且只接受当前 30 秒时间步的动态码）；启用、替换或在「验证器」页面删除验证器时，服务端会自动吊销除当前请求会话以外的其余已登录活跃会话及其密钥，删除验证器后即恢复校验 `mini_app.password`。

### 4. 内容黑名单（「内容黑名单」标签页）

控制台在侧边栏「权限控制」下方、「配置编辑」上方提供「内容黑名单」标签页（导航键 `adBlacklists`，禁用 SVG 图标仅在左侧菜单展示；实现在 `packages/mini-app-frontend/pages/AdBlacklistsPage.tsx`，对应受 `MINI_APP_API_AUTH_POLICY` 双向会话加密保护的 `GET|POST /api/ad-blacklists` 与 `GET /api/ad-blacklists/preview`），直接管理持久化在 SQLite `ad_pack_blacklists` 表中的全局贴纸包与自定义表情包黑名单：

- **双子页签与冷读隔离**：顶部展示「贴纸包黑名单」（`sticker`）与「表情包黑名单」（`emoji`）两个子页签（页内子页签与搜索栏上方不展示条数角标与禁止图标，总条数由底部分页栏展示）；列表与搜索经 SQLite 游标冷读返回，不污染主线程 768 条广告包黑名单热查询 LRU 缓存，也不设单类条数硬上限。
- **搜索、折叠添加（支持链接自动归类）与分页**：搜索框与折叠添加按钮并排放置，支持 `MINI_APP_SEARCH_DEBOUNCE_MS`（0.5 秒）防抖、大小写不敏感子串搜索（上限 `MINI_APP_AD_BLACKLIST_QUERY_MAX_LENGTH` = 128 字符，关键字变更时两类列表均回到第 1 页）与全站统一的分页切换（默认每页 `MINI_APP_AD_BLACKLIST_DEFAULT_PAGE_SIZE` = 10 条，可选 `MINI_APP_AD_BLACKLIST_PAGE_SIZE_OPTIONS` 即 10 / 15 / 20 条，服务端上限 `MINI_APP_AD_BLACKLIST_MAX_PAGE_SIZE` = 20 条）；添加输入框默认收起，经 `CollapseGrid` 上拉/下拉逐帧动画展开与收起（正常添加成功后自动清空并收起）。输入解析由 `parseAdBlacklistPackInput` 处理，支持纯 short name（沿用当前子页签种类）、Telegram 网页分享链接（`t.me`、`telegram.me`、`telegram.dog` 域名下的 `addstickers/<pack>` 或 `addemoji/<pack>`，协议头与尾部斜杠均可选）与原生深链（`tg://addstickers?set=<pack>` 或 `tg://addemoji?set=<pack>`），保留包名原始大小写并按链接类型自动归类为 `"sticker"` 或 `"emoji"`；发生跨页签实际变更时自动切换至目标子页签并单次刷新列表。
- **页内贴纸/表情包预览弹窗（`AdBlacklistPreviewModal`）**：点击列表中的包名按钮在当前页内弹出预览弹窗，经加密 `GET /api/ad-blacklists/preview` 分两阶段加载——第一阶段通过 `metaOnly=1` 展示紧凑加载点并快速确认包标题、包类型、总枚数与每枚 `hasImage` 标志，第二阶段按精确枚数渲染网格（含静态预览图的格位播放 `GalleryImageSkeleton`，无图格位直接显示 Emoji 占位与 `TGS`/`WEBM` 角标）并原地注水静态缩略图；大包按已知剩余枚数追加精确格数骨架执行「加载更多」（每页 `MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE` = 16 枚）。弹窗底部提供复制链接与经 `Telegram.WebApp.openTelegramLink`（非 Telegram 环境回退 `window.open`）在 Telegram 打开入口；关闭弹窗、切换子页签或离开页面时立即中止在途预览请求。
- **校验、二次确认移除与审计**：添加表单在前端预先校验包名与分享链接（归约后的 short name 均须满足 `STICKER_PACK_NAME_PATTERN` 即 `1–64` 位 `[A-Za-z0-9_]`），服务端同样校验格式、拦截机器人自身 `config/dynamic/stickers.json` 贴纸包（`409 AD_BLACKLIST_BOT_OWN_PACK`）与重复添加（`200 AD_BLACKLIST_DUPLICATE` 并展示页内提示横幅）；移除条目须先通过危险操作确认框，成功后同步更新主线程 768 LRU 缓存与条数统计、推送条数同步至 Anti-Raid Worker 并等待 SQLite `"adPackBlacklist"` 领域落盘确认（持久化失败或未确认返回 `503 AD_BLACKLIST_STORAGE_UNAVAILABLE`），每次 `POST /api/ad-blacklists` 写入均记录 `logger.operation("[MiniApp] adBlacklists.mutate", ...)` 审计日志。

### 5. 在线 JSON 配置编辑器（「配置编辑」标签页）

控制台在「内容黑名单」下方提供「配置编辑」标签页（`ConfigsPage`，对应 `/api/configs/*` 路由），支持在线查看、语法高亮编辑与严格校验保存受管部署 JSON 配置：

- **受管文件白名单**：严格对齐 `packages/config/layout.ts` 白名单，分为「动态配置」（`config/dynamic/` 下的 `ad_detect.json`、`agent.json`、`assets.json`、`cron.json`、`mood.json`、`stickers.json`）与「静态配置」（`config/static/` 下的 `bot.json`、`g-auth.json`）。文件下拉选择器单屏收敛展示 `MINI_APP_CONFIG_SELECTOR_VISIBLE_OPTIONS`（3）个选项并配纵向平行四边形高度滑条；编辑器提供纵横平行四边形滑条、行号、JSON 语法着色、一键格式化、精确到行/列的语法错误定位与尚不存在的可选配置文件直接新建能力。未产生修改时仅展示「格式化」按钮（加载骨架 `ConfigEditorSkeleton` 同样仅占位「格式化」按钮）；「还原修改」与「保存」按钮仅在草稿产生修改时显现，并在显现及因删改草稿或格式化对齐基准内容导致被动消失时各自播放 `MINI_APP_MIN_LOADING_MS` 骨架过渡占位动画；点击「格式化」、「还原修改」或「保存」（含静态配置保存后的服务重启）在途期间对应按钮播放电流扫光与三点波浪加载动画，还原、保存或重启完成直接退场不播骨架。
- **会话临时密钥直接加密保存**：点击「保存」时，客户端直接在当前活跃会话 256-bit `sessionKey` 的 AES-256-GCM 信封保护下向 `POST /api/configs/save` 提交 `{ scope, fileName, content }`（外层密文上限 `MINI_APP_MAX_CONFIG_BODY_BYTES` 即 4 MiB，UTF-8 明文上限 `MINI_APP_MAX_CONFIG_CONTENT_BYTES` 即 2 MiB）。
- **严格校验与原子落盘**：`saveMiniAppConfigFile` 通过 `runSerialChain` 经主线程写链 `deploymentConfigWriteChainHolder`（`packages/cache/main/configWrite.ts`）将校验与原子写入串行化，消除并发保存关联配置（`agent.json` ↔ `cron.json`）时的竞态。服务端依次校验白名单目标（`INVALID_CONFIG_TARGET`）、JSON 语法（`INVALID_JSON_SYNTAX`）与各领域严格解析器（`CONFIG_VALIDATION_FAILED`，其中 `g-auth.json` 与启动阶段共用 `parseGoogleServiceAccountKey`：必填 `client_email` 与可解析的 RSA PEM `private_key`，可选 `type` 固定为 `"service_account"`，可选 `private_key_id`/`project_id`/`quota_project_id`/`universe_domain` 去空白后非空，其余字段原样保留）；当 `database/storage.sqlite` 已存在时拒绝修改 `bot.json` 的 `time_zone`；`agent.json` 与 `cron.json` 执行双向跨文件能力依赖核对（优先读取磁盘最新对端文件）；目标路径须为非符号链接的普通文件或待建文件（`inspectOptionalFile`）。校验通过后以 `atomicWriteText` 原子写入规范化文本（已有文件保留原权限位，新建可选文件使用 `MINI_APP_CONFIG_DEFAULT_FILE_MODE` 即 `0o600`）。
- **动态热重载与静态配置重启确认**：`config/dynamic/` 文件落盘后自动触发目录级 `fs.watch` 防抖热重载生效；`config/static/` 文件（`bot.json`、`g-auth.json`）落盘成功后返回 `requiresRestart: true`，前端弹出重启确认框（「暂不执行」/「现在执行」），确认后调用 `POST /api/configs/restart` 执行 `systemctl restart --no-block copy-ninjia`（`MINI_APP_SERVICE_RESTART_COMMAND`，超时 `MINI_APP_SERVICE_RESTART_TIMEOUT_MS` 即 5 秒）。

---

## 验证与运维注意事项

- **启动日志确认**：机器人启动后，检查控制台或运行日志中是否输出 `Mini App HTTP server listening on http://127.0.0.1:3000 (public URL: https://app.example.com/).`，并确认 `cloudflared` 服务处于 `active (running)` 状态。
- **边缘缓存与安全头**：
  - **动态页面与业务 JSON API**：`index.html`、`reject.html` 及全部业务 JSON API 响应均附带 `MINI_APP_NO_STORE_CACHE_CONTROL`（`no-store, no-cache, must-revalidate, max-age=0`）及 `CDN-Cache-Control: no-store`、`Cloudflare-CDN-Cache-Control: no-store`，禁止 Cloudflare 边缘节点与浏览器缓存实时状态。
  - **受门禁保护的前端打包块**：已通过超级管理员门禁校验的前端打包静态资源（`/chunk-*` 等）返回 `MINI_APP_BUNDLE_CACHE_CONTROL`（`private, no-cache, must-revalidate`）、`CDN-Cache-Control: no-store`、`Cloudflare-CDN-Cache-Control: no-store`、`Vary: Cookie, X-Telegram-Init-Data, Authorization`（`MINI_APP_BUNDLE_VARY_HEADER_VALUE`）及 `ETag` `304` 协商，禁止公共代理与 CDN 缓存完整前端包并在每次重用前向源站复核门禁与锁定状态。
  - **受保护图库预览图片（`GET|HEAD /api/gallery/file`，`serveGalleryFileResponse`）**：经请求头 `initData`、`X-Mini-App-Session` 与加密 `?e=` 核验后（禁止查询参数凭据），返回 7 天 `MINI_APP_GALLERY_FILE_CACHE_CONTROL`（`private, no-cache, max-age=604800, must-revalidate`）、`CDN-Cache-Control: no-store`、`Cloudflare-CDN-Cache-Control: no-store`、`Vary: MINI_APP_GALLERY_FILE_VARY_HEADER_VALUE`（`X-Telegram-Init-Data, Authorization, X-Mini-App-Session`）、含 `sizeBytes` 与 `mtimeMs` 的强校验 `ETag`（支持弱比较及多值 `If-None-Match` 的 `304` 与 `HEAD` 请求）及安全响应头；前端由 `galleryImageCache.ts` 在浏览器 `CacheStorage`（桶名 `MINI_APP_GALLERY_CACHE_NAME`，有效期 `MINI_APP_GALLERY_CACHE_TTL_MS` 即 7 天）与有界内存缓存表维护按文件名索引的二进制 `Blob` 与 `ETag`，经 `fetchMiniAppGalleryImageObjectUrl` / `useGalleryImageUrls` 以 `cache: "no-store"` 附带 `If-None-Match` 向源站复核并在命中 `304` 时直接复用本地缓存生成 `blob:` URL（删图或 `404` 时即时驱逐对应缓存条目，满 7 天后强制重拉）。`GET|HEAD /api/gallery/download` 则以 `no-store` 与 `Content-Disposition: attachment` 下发原图下载流（支持请求头 + `?e=` 降级路径与 60 秒单次 `?ticket=` 原生下载路径）。
  - **公开静态图标（`/favicon.ico`，`serveCachedAssetResponse`）**：返回 7 天持久化 `MINI_APP_ASSET_CACHE_CONTROL`（`public, max-age=604800, s-maxage=604800, immutable`）、弱比较/多值 `If-None-Match` `ETag` `304` 协商、`HEAD` 支持与安全响应头。
  - **统一 CSP 与防嵌套响应头**：全部响应均附带 `MINI_APP_CSP_HEADER_VALUE`（仅放行同源脚本、`https://telegram.org` 及 `index.html` 与 `reject.html` 内联脚本的静态 SHA-256 哈希）与 `X-Frame-Options: DENY`。
- **在线配置编辑与服务重启权限**：`config/` 目录默认可保持只读；仅在使用「配置编辑」在线保存配置时，须为运行服务的系统账号开放 `config/dynamic/` 和/或 `config/static/` 目录的写入、创建临时文件与原子 `rename` 权限。静态配置保存后的在线重启固定调用 `systemctl restart --no-block copy-ninjia`（与 `install.sh` 注册的 `copy-ninjia.service` 一致；以非 `root` 服务账号启用在线重启时，通过 polkit 授权该服务账号重启 `copy-ninjia.service` 即可）。
- **持久化文件备份**：若已绑定 TOTP 验证器，备份数据根目录时请保留 `memory/mini-app-totp/totp.json`。服务启动与 `install.sh` 预检均会按相同严格口径校验该文件（文件不存在视作未绑定，非普通文件或内容格式非法时直接拒绝启动，详见 [07 运维手册](07-operations.md) 与 [04 运行时权威约束](04-invariants.md)）。

---

<div align="center">

[← 上一页：09 命令与行为参考](09-commands.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#10-mini-app-设置与推荐配置) · [下一页：11 性能基准 →](11-performance.md)

</div>

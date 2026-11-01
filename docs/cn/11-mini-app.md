# 11 Mini App 设置与推荐配置

<p align="center">
  <b>简体中文</b> · <a href="../en/11-mini-app.md">English</a> · <a href="../ja/11-mini-app.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 开发者文档首页</a> · <a href="10-performance.md">← 上一页：10 性能基准</a> · <a href="12-faq.md">下一页：12 常见问题 →</a>
</p>

---

本页介绍如何在 `config/static/bot.json` 中启用超级管理员专属 Telegram Mini App 管理控制台、使用推荐的 Cloudflare Tunnel（`cloudflared`）将本地 HTTP 服务暴露为公网 HTTPS 入口，以及控制台的打开方式、二次验证（密码 / Google Authenticator TOTP）与日常运维要点。完整 JSON 字段约束请参阅 [部署配置说明](../../config_example/README/zh.md#botjson)，控制台 HTTP API 路由与权限边界请参阅 [09 命令参考](09-commands.md#mini-app-console)。

## 配置 `bot.json` 启用 Mini App

在 `config/static/bot.json` 中添加可选的 `mini_app` 配置对象：

```json
{
  "bot_token": "replace-with-telegram-bot-token",
  "super_admin_user_id": 123456789,
  "atmosphere": "mesugaki",
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
| `host` | 可选 | 本地 `Bun.serve` HTTP 监听地址，缺省为 `MINI_APP_DEFAULT_HOST`（`"127.0.0.1"`）；仅监听本机回环地址，无需向公网直接开放防火墙端口 |
| `password` | **必填** | 首屏访问密码，必须为至少包含 6 位数字（`0-9`，匹配 `MINI_APP_PASSWORD_AT_LEAST_SIX_DIGITS_PATTERN`）的非空字符串，且不得保留示例占位值 `MINI_APP_PASSWORD_PLACEHOLDER`（`"replace-with-mini-app-password"`） |

- **可选启用**：`mini_app` 整节缺省时，机器人不会启动本地 `Bun.serve` HTTP 服务、不注册任何路由，也不会在超级管理员私聊挂载 `MenuButtonWebApp`。手工从 `config_example/static/bot.json` 复制模板且不使用 Mini App 时，请删除 `mini_app` 节（保留示例占位密码会在启动校验阶段直接拒绝；运行 `install.sh` 交互式配置时会自动剥离仍为占位密码的 `mini_app` 节，并在重跑安装脚本时保留已填写真实密码的 `mini_app` 配置）。
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
#启动
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

- **第一层（前置请求头守卫与 Telegram WebApp `initData` 签名核验）**：每个 API 请求先由统一前置中间件链（`headerGuard`）执行同源与凭据头形态快路径校验，再通过 `X-Telegram-Init-Data`（或 `Authorization: tma <initData>`，长度上限 `MINI_APP_MAX_INIT_DATA_LENGTH`）读取 Telegram 客户端签发的原始查询串。服务端使用 `BOT_TOKEN` 与种子 `MINI_APP_WEB_APP_DATA_SECRET_SEED`（`"WebAppData"`）校验 HMAC-SHA256 签名、`MINI_APP_AUTH_MAX_AGE_SECONDS`（45 分钟）时效，并严格校验 `user.id === SUPER_ADMIN_USER_ID`。非超级管理员账号在任何情况下均会被直接拒绝。
- **第二层（首屏凭据与 45 分钟会话续期）**：
  - 未绑定验证器时，首屏输入 `mini_app.password` 完成解锁；
  - 认证通过后，服务端签发有效期为 `MINI_APP_SESSION_TTL_MS`（45 分钟）的 `sessionToken`（通过 `X-Mini-App-Session` 请求头携带）及确定性图库资源令牌 `assetToken`，客户端将其持久化在 Mini App Web Storage 中并在 `GET /api/auth/precheck` 核验续接，使 45 分钟窗口内刷新或重开无需重复输入凭据，到期或主动锁定时立即清除；点击顶栏「锁定」时还会经 `POST /api/auth/logout` 通知服务端吊销该会话（不等待结果）。服务端返回的会话到期时刻由客户端按响应 `Date` 头换算为本机时刻后再用于到期判定与自动锁定；
  - 当携带有效会话令牌访问且距签发时刻超过 `MINI_APP_SESSION_REFRESH_THRESHOLD_MS`（5 分钟）时，服务端会自动轮换签发新令牌并将有效期顺延 45 分钟（通过 `X-Mini-App-Session` 与 `X-Mini-App-Session-Expires-At` 响应头及 `/api/auth/precheck` 响应体下发，同时在会话续期期间持续放行静态 `initData.auth_date`；旧令牌在 5 分钟并发宽限期内仍有效），主线程最多保留 `MINI_APP_SESSION_MAX`（8）个活跃会话。
- **防爆破锁定**：连续输错密码或动态码达到 `MINI_APP_PASSWORD_MAX_ATTEMPTS`（3 次）时，超级管理员 ID 将被锁定 `MINI_APP_PASSWORD_LOCKOUT_MS`（30 分钟）并清空所有已认证会话；锁定生效时仍在处理中的并发登录请求不再比对凭据，一律按失败计数并将锁定从当时起顺延 30 分钟；由未锁定转入锁定时向超级管理员私聊发送一条含解锁时间与来源 IP 的告警通知，锁定顺延不重复发送。

### 3. 绑定 Google Authenticator (TOTP) 动态码（推荐）

首次使用访问密码进入控制台后，推荐在控制台「验证器」标签页绑定唯一 Google Authenticator 动态口令：

1. 在「验证器」页面点击生成待绑定密钥与二维码（待确认密钥在主线程内存中的有效期为 `MINI_APP_TOTP_PENDING_TTL_MS`，即 10 分钟，连续输错 `MINI_APP_PASSWORD_MAX_ATTEMPTS` 次立即作废）。
2. 使用 Google Authenticator 等兼容应用扫描二维码（或手动输入 32 位 Base32 密钥），输入当前 `MINI_APP_TOTP_STEP_SECONDS`（30 秒）时间步的 `MINI_APP_TOTP_DIGITS`（6 位）动态验证码完成绑定。
3. 验证通过后，密钥以原子写（权限 `0o600`）持久化至运行时数据根目录下的 `memory/mini-app-totp/totp.json`（Schema 版本 `MINI_APP_TOTP_RECORD_VERSION`）。启用后，控制台首屏登录将自动切换为优先校验 6 位 TOTP 动态码（且只接受当前 30 秒时间步的动态码）；在「验证器」页面删除验证器后即恢复校验 `mini_app.password`。

---

## 验证与运维注意事项

- **启动日志确认**：机器人启动后，检查控制台或运行日志中是否输出 `Mini App HTTP server listening on http://127.0.0.1:3000 (public URL: https://app.example.com/).`，并确认 `cloudflared` 服务处于 `active (running)` 状态。
- **边缘缓存与安全头**：所有动态页面与业务 JSON API 响应均附带 `MINI_APP_NO_STORE_CACHE_CONTROL`（`no-store, no-cache, must-revalidate, max-age=0`），防止 Cloudflare 边缘节点缓存实时状态；已通过 `assetToken` 鉴权的图库预览图片与静态 `/favicon.ico` 图标资源返回 `MINI_APP_ASSET_CACHE_CONTROL`（7 天不可变缓存）与 `ETag` 304 协商。全部响应均附带 `MINI_APP_CSP_HEADER_VALUE` 与 `X-Frame-Options: DENY`。
- **持久化文件备份**：若已绑定 TOTP 验证器，备份数据根目录时请保留 `memory/mini-app-totp/totp.json`。服务启动与 `install.sh` 预检均会按相同严格口径校验该文件（文件不存在视作未绑定，非普通文件或内容格式非法时直接拒绝启动，详见 [07 运维手册](07-operations.md) 与 [04 运行时权威约束](04-invariants.md)）。

---

<div align="center">

[← 上一页：10 性能基准](10-performance.md) · [📚 开发者文档首页](content-table.md) · [⬆️ 回到顶部](#11-mini-app-设置与推荐配置) · [下一页：12 常见问题 →](12-faq.md)

</div>

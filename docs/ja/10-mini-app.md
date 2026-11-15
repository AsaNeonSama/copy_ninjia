# 10 Mini App の設定方法と推奨構成

<p align="center">
  <a href="../cn/10-mini-app.md">简体中文</a> · <a href="../en/10-mini-app.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 開発者ドキュメント TOP</a> · <a href="09-commands.md">← 前のページ：09 コマンドと挙動リファレンス</a> · <a href="11-performance.md">次のページ：11 パフォーマンスベンチマーク →</a>
</p>

---

このガイドでは、`config/static/bot.json` でスーパー管理者専用の Telegram Mini App 管理コンソールを有効化する手順、推奨構成である Cloudflare Tunnel（`cloudflared`）でローカル HTTP サーバーを公開 HTTPS エンドポイントとして公開する方法、およびコンソールの起動・二段階認証（パスワード／Google Authenticator TOTP）・運用上の注意点を解説します。JSON フィールドの完全な仕様は [デプロイ設定説明](../../config_example/README/ja.md#botjson)、HTTP API ルートと権限境界は [09 コマンドリファレンス](09-commands.md#mini-app-console) を参照してください。

## `bot.json` で Mini App を有効化する

`config/static/bot.json` に任意の `mini_app` オブジェクトを追加します：

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

| フィールド | 必須 / 任意 | 制約と説明 |
| :--- | :---: | :--- |
| `url` | **必須** | Telegram クライアントが WebApp を開く公開 `https://` URL。サブパスプレフィックス（例：`https://app.example.com/sub`）に対応し、パスプレフィックスを保持するプロキシと除去するプロキシの両方で動作します |
| `port` | **必須** | ローカル `Bun.serve` HTTP 待ち受けポート。`MINI_APP_PORT_MIN`〜`MINI_APP_PORT_MAX`（`1`〜`65535`）の安全な整数（トンネル転送先と合わせて `3000` を推奨） |
| `host` | 任意 | ローカル `Bun.serve` HTTP 待ち受けアドレス。省略時は `MINI_APP_DEFAULT_HOST`（`"127.0.0.1"`）となり、ローカルループバックのみをリッスンするため受信ファイアウォールの開放は不要です |
| `password` | **必須** | 初回画面のアクセスパスワード。6 桁以上の数字（`0-9`、`MINI_APP_PASSWORD_AT_LEAST_SIX_DIGITS_PATTERN`）を含む非空文字列である必要があり、サンプルプレースホルダー `MINI_APP_PASSWORD_PLACEHOLDER`（`"replace-with-mini-app-password"`）のままでは起動を拒否します |

- **任意の有効化**：
  - `mini_app` セクション全体を省略した場合、ローカル `Bun.serve` HTTP サーバーやルートは一切起動せず、スーパー管理者の個人チャットに `MenuButtonWebApp` も配置されません。
  - `config_example/static/bot.json` を手動コピーして Mini App を使わない場合は、`mini_app` セクションごと削除してください（プレースホルダーパスワードが残っていると起動検証で停止します。`install.sh` の対話ウィザードはプレースホルダーのままの `mini_app` を自動除去し、実パスワード設定済みの `mini_app` は再実行時も保持します）。
- **反映には再起動が必要**：`config/static/bot.json` は静的設定ファイルのため、`mini_app` を変更した後は Bot サービスの再起動が必要です。

---

## 推奨構成：Cloudflare Tunnel の使用

Telegram Mini App には公開 `https://` URL が必須です。推奨構成は **Cloudflare Tunnel（`cloudflared`）** です。上記設定では Bot 本体はローカルループバック `127.0.0.1:3000`（`host` 既定値 `MINI_APP_DEFAULT_HOST`、`port` は設定値）のみをリッスンするため、サーバーの受信ポート開放や TLS 証明書の個別管理を行うことなく、`cloudflared` のアウトバウンド暗号化トンネル経由で固定サブドメイン（例：`https://app.example.com`）の通信を `http://localhost:3000` へ安全に転送できます。

### `cloudflared` のインストール

```shell
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
rm -f cloudflared.deb
```

### ログインとドメインルーティングの設定

```shell
# 1. ログイン認可（ブラウザで対象の Cloudflare ドメインを選択すると cert.pem が生成されます）
cloudflared tunnel login

# 2. my-app という名前のトンネルを作成（認証情報 JSON ファイルと Tunnel UUID が生成されます）
cloudflared tunnel create my-app

# 3. 固定サブドメインの CNAME レコードを該当トンネルへ自動追加
cloudflared tunnel route dns my-app app.example.com

# 4. サブドメインの通信をローカルポート（例：3000 番）へ転送してフォアグラウンドで動作確認
cloudflared tunnel run --url http://localhost:3000 my-app
```

### トンネルサービスの設定

フォアグラウンドで疎通を確認したら、設定ファイルを作成して systemd サービスとして常駐化・自動起動を有効化します：

```shell
# <Tunnel-UUID> を確認
cloudflared tunnel list
cd ~/.cloudflared
# 設定ファイルを作成・編集
vim config.yml
```

```yaml
tunnel: <Tunnel-UUID>
credentials-file: /root/.cloudflared/<Tunnel-UUID>.json # 注意：一般ユーザーや macOS の場合は対応する絶対パス（例：/home/ubuntu/.cloudflared/...）に変更してください

ingress:
  - hostname: app.example.com
    service: http://localhost:3000
  - service: http_status:404
```

```shell
# systemd サービスとしてインストール（~/.cloudflared/config.yml が自動的に /etc/cloudflared/ へコピーされます）
sudo cloudflared --config ~/.cloudflared/config.yml service install

# サービス起動と自動起動の有効化
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

### サービスのアンインストールとトンネルの削除

トンネルサービスを停止して削除する場合は、以下の順に実行します：

```shell
sudo cloudflared service uninstall
cloudflared tunnel cleanup <トンネル名>
cloudflared tunnel delete -f <トンネル名>
```

---

## コンソールの起動と二段階認証

### 1. 個人チャットの起動ボタン

`mini_app` を設定して Bot を起動すると、コマンドメニュー登録時にスーパー管理者（`SUPER_ADMIN_USER_ID`）と Bot の個人チャット左下へ自動的に `MenuButtonWebApp`（ボタン表記は `MINI_APP_BUTTON_TEXT` の `App`）が配置されます。左下の **`App`** ボタンをタップすると、Telegram 内蔵 WebView で管理コンソールが開きます。

### 2. 二段階セキュリティ認証とロック保護

- **単一ページ入口とフロントエンドバンドルゲート（`MINI_APP_REJECT_HTML_PATH` / `MINI_APP_PAGE_GATE_COOKIE_NAME`）**：
  - **HTML エントリゲート**：
    - 単一ページルート（`/`・`/index.html` およびサブパスエイリアス）は、同一オリジンヘッダー・非ロック状態・スーパー管理者ゲート資格情報（`X-Telegram-Init-Data` / `Authorization: tma <initData>` ヘッダー、または `BOT_TOKEN` と `MINI_APP_PAGE_GATE_SECRET_SEED` から派生した鍵で HMAC-SHA256 署名し `SUPER_ADMIN_USER_ID` に紐付けた `MINI_APP_PAGE_GATE_COOKIE_NAME` の `HttpOnly; SameSite=Lax` Cookie。HTTPS 時は `; Secure` 付与、有効期間 `MINI_APP_PAGE_GATE_COOKIE_MAX_AGE_SECONDS` = 45 分）を検証します。
    - Telegram 外からのアクセス、非スーパー管理者、無効な資格情報、ロック期間中のアクセスには独立ページの `packages/mini-app-api-server/resource/reject.html`（`MINI_APP_REJECT_HTML_PATH`。唯一の `<body>` タグ位置で事前分割して `miniAppRejectHtmlHolder` にキャッシュし、HTML エスケープ済み診断 `data-*` 属性を連結して外部通信ゼロで返却）のみを返し、SPA HTML やバンドルチャンクは一切返しません。
  - **バンドルチャンクゲート**：フロントエンドのバンドルチャンク（`/chunk-*` 等、`MINI_APP_BUNDLE_ASSET_ROUTE_PATTERN`、`miniAppBundledAssetsHolder` にオンデマンド実体化）も同一ゲートに加えクロスサイト・アドレスバー直接遷移の遮断を行い、未認可時は `401`/`403` JSON を返します。
  - **WebView 初回起動ハンドシェイク**：Telegram 内蔵 WebView のコールドスタート時は、`reject.html` のインラインスクリプトがローカルから `initData`（`window.Telegram.WebApp.initData`、`?tgWebAppData`、`#tgWebAppData`、または `sessionStorage.__telegram__initParams`）を取り出して `GET ./api/auth/precheck` を呼び出します。`GET /api/auth/precheck` または `POST /api/auth/login` の `200` 応答が `Set-Cookie` でゲート Cookie を発行・更新した後、5 秒間の `sessionStorage` ループ防止ガード付きで 1 回リロードしてコンソール本体へ入ります（プリチェック拒否時や無効なゲート Cookie 送信時は `Max-Age=0` で即座に消去）。
- **第 1 層 — リクエストヘッダーガードと Telegram WebApp `initData` 署名検証**：
  - 全 API リクエストは静的ポリシー（`MiniAppAuthPolicy`）に基づく同期認証パイプライン（`authorizeMiniAppRequest`）を通過し、まず `headerGuard` で同一オリジンと資格情報ヘッダー形式を高速検査（ヘッダー `initData` を 1 回抽出）したうえで、`X-Telegram-Init-Data` または `Authorization: tma <initData>`（最大長 `MINI_APP_MAX_INIT_DATA_LENGTH`）の `initData` クエリ文字列を検証します。
  - サーバーは `BOT_TOKEN` とシード `MINI_APP_WEB_APP_DATA_SECRET_SEED`（`"WebAppData"`）から派生した鍵で HMAC-SHA256 署名および `MINI_APP_AUTH_MAX_AGE_SECONDS`（45 分）の鮮度を検証し、`user.id === SUPER_ADMIN_USER_ID` を厳格に照合します。スーパー管理者以外は即座に拒否されます。
- **第 2 層 — 初回画面の資格情報と 45 分セッション自動更新**：
  - **初回ロック解除**：認証器が未バインドの場合は初回画面で `mini_app.password` を入力して解除し、Google Authenticator（TOTP）バインド済みの場合は `mini_app.password` の代わりに現在の 30 秒ステップの 6 桁 TOTP コードで解除します。
  - **セッション保持とロック操作**：ログイン成功時、`MINI_APP_SESSION_TTL_MS`（45 分）有効な `sessionToken`（`X-Mini-App-Session`）と画像庫用の決定論的 `assetToken` を発行し、ゲート Cookie も更新します。クライアントは Web Storage に保存して `GET /api/auth/precheck` で再開するため 45 分以内の再読込・再起動では再入力不要で、レスポンスの `Date` ヘッダーから端末時刻へ換算した期限で自動ロックします。プリチェック失敗時はそのリクエストで送ったトークンのみを消去し（通信中に新しく保存されたトークンは維持）、上部バーの「ロック」操作時はストレージ消去に加えて `POST /api/auth/logout` でサーバー側の失効も非同期依頼します。
  - **自動トークンローテーション**：有効なセッショントークンの発行から `MINI_APP_SESSION_REFRESH_THRESHOLD_MS`（5 分）を超えている場合、自動的に新トークンへローテーションして有効期限を 45 分延長します（`X-Mini-App-Session`・`X-Mini-App-Session-Expires-At` ヘッダーおよび `/api/auth/precheck` ボディで返却し、更新中は静的な `initData.auth_date` を継続許可）。旧トークンも並行リクエスト向けに 5 分間有効で、メインスレッドは最大 `MINI_APP_SESSION_MAX`（8）件を保持します。
- **ブルートフォースロック**：
  - パスワードまたは TOTP コードを連続 `MINI_APP_PASSWORD_MAX_ATTEMPTS`（3）回誤入力すると、スーパー管理者 ID は `MINI_APP_PASSWORD_LOCKOUT_MS`（30 分）ロックされ、全セッションの消去と `Max-Age=0` によるゲート Cookie 消去が行われます（ロック中の単一ページ・バンドルチャンク要求もすべて拒否・Cookie 消去）。
  - ロック発動時点で処理中だった並行ログイン要求は資格情報を照合せずに失敗として計上し、その時点からロックを 30 分間延長します。
  - 未ロック状態からロックへ入った際に解除時刻と送信元 IP を記したアラートを個人チャットへ 1 通送信します（ロック延長時は再送しません）。

### 3. Google Authenticator (TOTP) のバインド（推奨）

アクセスパスワードで初回ログインした後、コンソールの **「認証器」** タブで Google Authenticator のワンタイムパスワードをバインドすることを推奨します：

1. **「認証器」** タブでバインド用の Base32 シークレットと QR コードを生成します（確認待ちシークレットはメインスレッドのメモリ上で `MINI_APP_TOTP_PENDING_TTL_MS` = 10 分間有効で、`MINI_APP_PASSWORD_MAX_ATTEMPTS` 回連続で誤入力すると即座に破棄されます）。
2. Google Authenticator などの RFC 6238 互換アプリで QR コードを読み取り（または 32 文字の Base32 シークレットを手入力）、現在の `MINI_APP_TOTP_STEP_SECONDS`（30 秒）ステップの `MINI_APP_TOTP_DIGITS`（6 桁）コードを入力して確定します。
3. 検証通過後、シークレットは実行時データルート配下の `memory/mini-app-totp/totp.json`（スキーマバージョン `MINI_APP_TOTP_RECORD_VERSION`）へアトミック書き込み（権限 `0o600`）で永続化されます。以降は初回ログインで現在の 30 秒ステップの 6 桁 TOTP コードが優先検証されます。認証器の有効化・置換・削除時には現在のセッションを除く他のすべてのアクティブセッションが自動失効し、削除すると `mini_app.password` 検証へ戻ります。

---

## 動作確認と運用上の注意点

- **起動ログの確認**：Bot 起動後、ログに `Mini App HTTP server listening on http://127.0.0.1:3000 (public URL: https://app.example.com/).` が出力されていること、および `cloudflared` サービスが `active (running)` であることを確認してください。
- **エッジキャッシュとセキュリティヘッダー**：
  - **動的 HTML と業務 JSON API**：`index.html`、`reject.html`、およびすべての業務 JSON API 応答には `MINI_APP_NO_STORE_CACHE_CONTROL`（`no-store, no-cache, must-revalidate, max-age=0`）、`CDN-Cache-Control: no-store`、`Cloudflare-CDN-Cache-Control: no-store` が付与され、Cloudflare エッジやブラウザによる動的状態のキャッシュを防止します。
  - **ゲート保護されたバンドルチャンク**：ゲート通過後の `/chunk-*` アセットは `MINI_APP_BUNDLE_CACHE_CONTROL`（`private, no-cache, must-revalidate`）、`CDN-Cache-Control: no-store`、`Cloudflare-CDN-Cache-Control: no-store`、`Vary: Cookie, X-Telegram-Init-Data, Authorization`（`MINI_APP_BUNDLE_VARY_HEADER_VALUE`）、および `ETag` `304` 再検証を返し、公開プロキシや CDN でのキャッシュを禁止しつつ再利用ごとにゲート・ロック状態をオリジンへ再確認します。
  - **画像庫プレビューと静的アイコン**：`assetToken` 認証済みの画像庫プレビュー（`sizeBytes` と `mtimeMs` から導出した `ETag` 付き）と `/favicon.ico` は、`MINI_APP_ASSET_CACHE_CONTROL`（7 日間不変キャッシュ）と弱 ETag・複数値 `If-None-Match` 対応の `ETag` `304` 再検証を返します。
  - **共通セキュリティヘッダー**：すべてのレスポンスに `MINI_APP_CSP_HEADER_VALUE`（`'self'`、`https://telegram.org`、および `index.html`・`reject.html` インラインスクリプトの静的 SHA-256 ハッシュのみ許可）と `X-Frame-Options: DENY` が付与されます。
- **永続化 TOTP ファイルのバックアップ**：TOTP 認証器をバインドしている場合は、データルートのバックアップ対象に `memory/mini-app-totp/totp.json` を含めてください。サービス起動時と `install.sh` の事前検査はいずれも同一の厳格な基準でこのファイルを検証します（未存在は未バインド扱い、通常ファイル以外または形式不正は起動拒否。詳細は [07 運用マニュアル](07-operations.md) と [04 実行時の正式な不変条件](04-invariants.md) を参照）。

---

<div align="center">

[← 前のページ：09 コマンドと挙動リファレンス](09-commands.md) · [📚 開発者ドキュメント TOP](content-table.md) · [⬆️ トップへ戻る](#10-mini-app-の設定方法と推奨構成) · [次のページ：11 パフォーマンスベンチマーク →](11-performance.md)

</div>

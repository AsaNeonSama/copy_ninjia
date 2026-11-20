# 10 Mini App の設定方法と推奨構成

<p align="center">
  <a href="../cn/10-mini-app.md">简体中文</a> · <a href="../en/10-mini-app.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 開発者ドキュメント TOP</a> · <a href="09-commands.md">← 前のページ：09 コマンドと挙動リファレンス</a> · <a href="11-performance.md">次のページ：11 パフォーマンスベンチマーク →</a>
</p>

---

このガイドでは、`config/static/bot.json` でスーパー管理者専用の Telegram Mini App 管理コンソールを有効化する手順、推奨構成である Cloudflare Tunnel（`cloudflared`）でローカル HTTP サーバーを公開 HTTPS エンドポイントとして公開する方法、およびコンソールの起動・二段階認証と 256-bit 一時セッション鍵による AES-256-GCM 通信暗号化・Google Authenticator TOTP バインド・オンライン JSON 設定エディタ・運用上の注意点を解説します。JSON フィールドの完全な仕様は [デプロイ設定説明](../../config_example/README/ja.md#botjson)、HTTP API ルートと権限境界は [09 コマンドリファレンス](09-commands.md#mini-app-console) を参照してください。

## `bot.json` で Mini App を有効化する

`config/static/bot.json` に任意の `mini_app` オブジェクトを追加します：

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

| フィールド | 必須 / 任意 | 制約と説明 |
| :--- | :---: | :--- |
| `url` | **必須** | Telegram クライアントが WebApp を開く公開 `https://` URL。サブパスプレフィックス（例：`https://app.example.com/sub`）に対応し、パスプレフィックスを保持するプロキシと除去するプロキシの両方で動作します |
| `port` | **必須** | ローカル `Bun.serve` HTTP 待ち受けポート。`MINI_APP_PORT_MIN`〜`MINI_APP_PORT_MAX`（`1`〜`65535`）の安全な整数（トンネル転送先と合わせて `3000` を推奨） |
| `host` | 任意 | 非空のローカル `Bun.serve` HTTP 待ち受けアドレス。省略時は `MINI_APP_DEFAULT_HOST`（`"127.0.0.1"`）となり、ローカルループバックのみをリッスンするため受信ファイアウォールの開放は不要です |
| `password` | **必須** | 初回画面のアクセスパスワード。6 桁以上の数字（`0-9`、`MINI_APP_PASSWORD_AT_LEAST_SIX_DIGITS_PATTERN`）を含む非空文字列である必要があり、サンプルプレースホルダー `MINI_APP_PASSWORD_PLACEHOLDER`（`"replace-with-mini-app-password"`）のままでは起動を拒否します |

- **任意の有効化**：
  - `mini_app` セクション全体を省略した場合、ローカル `Bun.serve` HTTP サーバーやルートは一切起動せず、スーパー管理者の個人チャットに `MenuButtonWebApp` も配置されません。セクションを指定する場合は `url`・`port`・`password` が必須、`host` は任意（省略時は `MINI_APP_DEFAULT_HOST`）で、旧形式の `signing_private_key` / `signing_public_key` フィールドは起動時に拒否されます。
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
  - **起動時 Ed25519 注入とリプレイ対策**：`startMiniAppServer` は起動ごとにメインスレッドのメモリ内でエクスポート不可の Web Crypto `Ed25519` 署名鍵ペアを生成し（`ensureMiniAppRuntimeSigningKeyPair`、停止時 `clearMiniAppRuntimeSigningKeyPair` で破棄）、`handlers/page.ts` がフロントエンド JS チャンク実体化時にプレースホルダー `MINI_APP_SERVER_SIGNING_PUBLIC_KEY_PLACEHOLDER` を 32 バイト生公開鍵 Base64 へ置換して `ETag` を再計算します（未置換や不正公開鍵は fail-closed で `INVALID_HANDSHAKE`）。
- **第 1 層 — リクエストヘッダーガードと Telegram WebApp `initData` 署名検証**：
  - 全 API リクエストは静的ポリシー（`MiniAppAuthPolicy`）に基づく同期認証パイプライン（`authorizeMiniAppRequest`）を通過し、まず `headerGuard` で同一オリジン（設定済み `mini_app.url` と `https:` スキーム・ホスト・ポートまで完全一致するオリジン、またはリクエスト URL がループバックの場合はリクエスト URL 自身と同一のオリジンのみを許可し、`Host` / `X-Forwarded-Host` / `X-Forwarded-Proto` は無視）と資格情報ヘッダー形式を高速検査したうえで、`X-Telegram-Init-Data` または `Authorization: tma <initData>`（最大長 `MINI_APP_MAX_INIT_DATA_LENGTH`）の `initData` クエリ文字列を検証します。
  - サーバーは `BOT_TOKEN` とシード `MINI_APP_WEB_APP_DATA_SECRET_SEED`（`"WebAppData"`）から派生した鍵で HMAC-SHA256 署名および `MINI_APP_AUTH_MAX_AGE_SECONDS`（45 分、アクティブセッション中は `2 時間 + 45 分` まで許容）を検証し、`user.id === SUPER_ADMIN_USER_ID` を厳格に照合します。スーパー管理者以外は即座に拒否されます。
- **第 2 層 — 起動時 Ed25519＋一時 X25519 ECDH・256-bit 一時鍵と 45 分／2 時間ライフサイクル**：
  - **初回ロック解除と同時 5 セッション上限**：認証器が未バインドの場合は初回画面で `mini_app.password`、Google Authenticator（TOTP）バインド済みの場合は現在の 30 秒ステップの 6 桁コードで解除します（検証・セッション発行成功後にのみ `miniAppLastConsumedTotpStepHolder` を記録し同ステップリプレイを遮断）。メインスレッドの未期限切れアクティブセッション上限は `MINI_APP_SESSION_MAX`（`5`）件で、満杯時も正当なログインはそのまま成功し、発行または直近の更新から最も時間が経ったセッションを追い出します（そのダウンロード票も失効し、追い出された端末は次の要求で再ログイン）。
  - **一時 X25519 交渉とエクスポート不可鍵分離ストレージ**：未認証時の `GET /api/auth/precheck` は起動時 `Ed25519` 秘密鍵で署名した一時 `X25519` 公開鍵オファー（`handshakeId`・`serverPublicKey`・`expiresAt`、上限 `MINI_APP_HANDSHAKE_MAX` = 16、TTL `MINI_APP_HANDSHAKE_TTL_MS` = 5 分）を発行して `MINI_APP_PAGE_GATE_COOKIE_NAME` ゲート Cookie を更新し、認証済みセッションには読み取り専用状態（`sessionValid`・`sessionExpiresAt`、トークン更新・鍵発行なし）のみ返します。クライアントは注入された `Ed25519` 公開鍵で署名検証後（`signatureMismatch` 時は 10 秒ループ防止付き単発 `location.reload()`、Web Crypto 非対応時はリロードせず `WEBCRYPTO_UNSUPPORTED` へ正規化）、一時 `X25519` 鍵ペアを生成して `ECDH + HKDF-SHA256`（`salt` は生 `handshakeId` バイト、`info` は `c2s`/`s2c` 方向と双方公開鍵に束縛）で `c2sKey` / `s2cKey` を派生し、`POST /api/auth/login` へ `{ handshakeId, password }` または `{ handshakeId, totpCode }` を `c2sKey`（`MINI_APP_LOGIN_REQUEST_AAD`）で暗号化送信します。`miniAppInFlightHandshakeIds` が並行リプレイを遮断し、`handshakeId` は消費・失敗と同時に即破棄され、`200`/`403` 応答はすべて `s2cKey`（`MINI_APP_LOGIN_RESPONSE_AAD`、平文の成功・資格判定ダウングレード拒否）で返却して 45 分 `sessionToken` と 256-bit `sessionKey` を直接発行（直列化直後に `pendingSessionKey` 消去）します。`sessionKey` は `POST /api/auth/login` と暗号化応答スライディング更新時のみ発行され、クライアントは IndexedDB（同世代の `{ token, cryptoKey }` 組、`cryptoKey` はエクスポート不可）と `sessionStorage`（`{ token, expiresAt }`、他ストレージや `globalThis` は禁止）のみに保持し（復元は IndexedDB の組を正とし、`sessionStorage` だけが新トークンで新鍵が未保存なら前世代の組に戻してメタデータを書き直し、欠落・形式不一致時は自己削除）、**HTTP 送信を一切行いません**。ロック操作時はローカル消去に加え `POST /api/auth/logout` でセッション・鍵・ダウンロードチケットを非同期失効します。
  - **ランダムクールダウン更新・2 時間寿命上限と旧鍵即時失効**：1 ログインあたりの更新最長寿命は `MINI_APP_SESSION_MAX_LIFETIME_MS`（2 時間）です。各世代の鍵発行・更新時に `[MINI_APP_SESSION_REFRESH_MIN_MS, MINI_APP_SESSION_REFRESH_MAX_MS]`（5 秒～5 分）の範囲で一様ランダムな次回更新時刻を決定し、その時刻以降または `seenRequestIvs.size` が `MINI_APP_SESSION_ROTATE_AT_SEEN_IVS`（3,072）水位へ達した時点で 45 分有効期限内かつ 2 時間上限内で暗号化応答ルートへ到達したリクエストで新 `sessionToken` と新 256-bit `sessionKey` へ更新し、新世代の IV 集合とランダム更新間隔をリセットして 45 分延長し、`X-Mini-App-Session`・`X-Mini-App-Session-Expires-At`・`X-Mini-App-Session-Key`（当該リクエスト鍵で `additionalData = UTF8(newToken)` 付き AES-256-GCM 封印）を返却します（並行要求は送信時スナップショット `(sentSessionToken, cryptoKeyAtSend)` で照合し一致時のみ保存）。`previousToken` / `previousCryptoKey` は独立した 5 分間（`MINI_APP_SESSION_PREVIOUS_GRACE_MS`）のみ有効で、新トークンでの最初のコミット時に**即座に失効**します。更新コミット時にサーバーは共有の封印ハンドル `sealedSessionKeyPromise`（封印済み暗号文のみへ解決し `pendingSessionKey` には書き込まない）を同期起動して確定後に `sealedSessionKey` へ格納し、新トークン確認または猶予満了まで保持します。それまでに `previousToken` で暗号化応答ルートへ来たリクエストは再更新せず、同一の `sealedSessionKeyPromise` を待機するか確定済み `sealedSessionKey` を参照して同じ新トークンと同じ `X-Mini-App-Session-Key` 暗号文を付け直すため、更新応答を取りこぼしたクライアントも新世代へ追従できます。
- **AES-256-GCM 通信暗号化（`MiniAppEncryptedEnvelope`・バイナリフレーム・`?e=`）・二段階確定と非暗号化境界**：
  - **JSON 封筒・バイナリアップロード・`?e=` と二段階アトミック確定**：セッション必須業務 JSON ルートは 256-bit `sessionKey`（12 バイト IV・128-bit タグ）で `{ encrypted: true, iv, payload }`（上限既定 `64 KiB`、`POST /api/configs/save` は `4 MiB`）、`POST /api/gallery/upload` は `[12B IV || 暗号文+16B タグ]` 生バイナリフレーム（上限 `MINI_APP_MAX_UPLOAD_BODY_BYTES` = `11 MiB`）を用い、方向 AAD `"${method} ${routePath}:req"` / `":res"` に束縛します（`GET`/`HEAD` 以外の `0` バイト空ボディは拒否）。全 `encryptRequest: true` ルートの非空クエリ文字列は単一の `?e=<ivBase64>.<cipherBase64>`（最大長 `4096` 文字、`additionalData = "${method} ${routePath}"`）のみを許可し、裸 `?`・平文/重複引数・空/`?` 始まり復号結果・封筒/`?e=` 不正・同鍵エポック内 IV 重複は `400 INVALID_ENCRYPTED_PAYLOAD`（`seenRequestIvs` が `MINI_APP_SESSION_ROTATE_AT_SEEN_IVS` = `3_072` 水位に達すると暗号化応答ルートで能動更新して IV 集合と更新間隔をリセット、ハード上限 `MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS` = `4_096` 超過時は `401 SESSION_EXPIRED`＋セッション失効）。`authorizeMiniAppRequest` → 非同期復号 → `commitMiniAppSessionAccess` の二段階確定で TOCTOU 競合を遮断し（`400` 失敗時は `previousToken` 維持・非更新。復号中に並行要求でトークンが更新・確認された場合は、ログイン中不変の `lineageId` で生存セッションを特定し、照会時の鍵世代の IV 集合で更新なしに確定）、クライアントも暗号化応答ルートで本文の復号・検証を完了してからローテーションヘッダーを取り込み、平文 `2xx` を拒否し、ローカルにセッショントークンか鍵がなければ暗号化 JSON・クエリ・バイナリアップロード要求を送信前に止めて再ロック解除を求めます。各ページ・設定編集・複数画像アップロード・ピッカーポーリング・画像プレビュー・バックグラウンドポーリングでセッション失効や鍵失効・復号失敗（`MINI_APP_SESSION_REAUTH_ERROR_CODES` または裸 `401`）を検知した場合は一致する資格情報を消去して `AuthGatePage` へ遷移し、第 1 層ゲート・`initData` 期限切れ・ロック・WebCrypto 非対応拒否（`MINI_APP_ACCESS_DENIED_ERROR_CODES`）では無条件で資格情報を消去して再プリチェック経由で `AccessDeniedPage` へ遷移します（古い要求番号ガードでも握り潰しません）。
  - **ダウンロード二経路と非暗号化境界**：`/api/auth/{precheck,logout}` と単一ページ/バンドル/`/favicon.ico`/`/healthz` は全工程非暗号化、`POST /api/auth/login` は一時 ECDH（`c2sKey`/`s2cKey`）；セッション保護 `/api/*` で `encryptResponse: false`（鍵更新なし）は `GET|HEAD /api/gallery/file` と `GET|HEAD /api/gallery/download` のみ（ブラウザフォールバックは認証ヘッダー＋`?e=`＋`blob:` 保存、Telegram ネイティブ `WebApp.downloadFile` は暗号化 `POST /api/gallery/download-ticket` が発行する 60 秒単回限定 64-hex `?ticket=`、上限 64・`HEAD` 非消費・`GET` 即消費・セッション系譜 `sessionLineageId` に紐付け（ローテーションを跨いで有効を維持し、ログアウト/ロック/期限切れ/追い出し/IV 上限/認証器変更/削除時に系譜単位で即時失効））；`POST /api/gallery/upload` はリクエスト（バイナリ）と応答（JSON）双方を `sessionKey` 暗号化します。
- **ブルートフォースロック**：
  - パスワードまたは TOTP コードを連続 `MINI_APP_PASSWORD_MAX_ATTEMPTS`（3）回誤入力すると、スーパー管理者 ID は `MINI_APP_PASSWORD_LOCKOUT_MS`（30 分）ロックされ、全アクティブセッション・セッション鍵・一時ハンドシェイク・ダウンロードチケットの消去と `Max-Age=0` によるゲート Cookie 消去が行われます（ロック中の単一ページ・バンドルチャンク要求もすべて拒否・Cookie 消去）。
  - ロック発動時点で処理中だった並行ログイン要求は資格情報を照合せずに失敗として計上し、その時点からロックを 30 分間延長します。
  - 未ロック状態からロックへ入った際に解除時刻と送信元 IP を記したアラートを個人チャットへ 1 通送信します（ロック延長時は再送しません）。

### 3. Google Authenticator (TOTP) のバインド（推奨）

アクセスパスワードで初回ログインした後、コンソールの **「認証システム」** タブで Google Authenticator のワンタイムパスワードをバインドすることを推奨します：

1. **「認証システム」** タブでバインド用の Base32 シークレットと QR コードを生成します（確認待ちシークレットはメインスレッドのメモリ上で `MINI_APP_TOTP_PENDING_TTL_MS` = 10 分間有効で、`MINI_APP_PASSWORD_MAX_ATTEMPTS` 回連続で誤入力すると即座に破棄されます）。
2. Google Authenticator などの RFC 6238 互換アプリで QR コードを読み取り（または 32 文字の Base32 シークレットを手入力）、現在の `MINI_APP_TOTP_STEP_SECONDS`（30 秒）ステップの `MINI_APP_TOTP_DIGITS`（6 桁）コードを入力して確定します。
3. 検証通過後、有効化・置換・削除は `runSerialChain`（`miniAppTotpMutationChainHolder`）で直列に実行され（ディスクとメインスレッドメモリの不整合を防止）、シークレットは実行時データルート配下の `memory/mini-app-totp/totp.json`（スキーマバージョン `MINI_APP_TOTP_RECORD_VERSION`）へアトミック書き込み（権限 `0o600`）で永続化されます。以降は初回ログインで現在の 30 秒ステップの 6 桁 TOTP コードが優先検証されます。認証器の有効化・置換・削除時には現在のセッションを除く他のすべてのアクティブセッションと鍵が自動失効し、削除すると `mini_app.password` 検証へ戻ります。

### 4. オンライン JSON 設定エディタ（「設定編集」タブ）

コンソール内の **「設定編集」** タブ（`ConfigsPage`、`/api/configs/*` ルート）では、管理対象のデプロイ JSON 設定ファイルをシンタックスハイライト付きで閲覧・編集し、厳格なスキーマ検証を経て保存できます：

- **編集対象ホワイトリスト**：`packages/config/layout.ts` と一致する **「動的設定」**（`config/dynamic/` 配下の `ad_detect.json`、`agent.json`、`assets.json`、`cron.json`、`mood.json`、`stickers.json`）と **「静的設定」**（`config/static/` 配下の `bot.json`、`g-auth.json`）のみを許可します。ファイル選択ドロップダウンは 1 画面あたり `MINI_APP_CONFIG_SELECTOR_VISIBLE_OPTIONS`（3）件表示と縦方向の平行四辺形スクロールバーを備え、エディタ本体は縦横の平行四辺形スクロールバー、行番号表示、JSON 構文ハイライト、一括整形、行・列単位のリアルタイム構文エラー表示、および未作成の任意設定ファイルの新規作成に対応します。未変更時は **「整形」** ボタンのみを表示し（`ConfigEditorSkeleton` も未変更初期状態に合わせて整形ボタン 1 枠のみを配置）、**「変更破棄」** と **「保存」** ボタンは変更発生時に表示され、出現時および編集削除や整形による基準内容一致での受動的な非表示時のみ `MINI_APP_MIN_LOADING_MS` のスケルトン遷移プレースホルダーを再生します。**「整形」**・**「変更破棄」**・**「保存」**（静的設定保存後のサービス再起動を含む）押下中は対象ボタンで電流シマー付き 3 点ウェーブアニメーションを再生し、破棄・保存・再起動完了時はスケルトンを挟まず即座に終了します。
- **セッション一時鍵による直接暗号化保存**：**「保存」** を押すと、現在の有効セッション `sessionKey` の AES-256-GCM 封筒内で直接 `{ scope, fileName, content }` を `POST /api/configs/save` へ送信します（外層上限 `MINI_APP_MAX_CONFIG_BODY_BYTES` = `4 MiB`、UTF-8 平文上限 `MINI_APP_MAX_CONFIG_CONTENT_BYTES` = `2 MiB`）。
- **厳格な検証とアトミック保存**：`saveMiniAppConfigFile` は `runSerialChain`（`miniAppConfigSaveChainHolder`）内で検証とアトミック書き込みを直列化し、関連設定（`agent.json` ↔ `cron.json`）の並行保存によるファイル間検証の TOCTOU 競合を排除します。対象ホワイトリスト（`INVALID_CONFIG_TARGET`）、JSON 構文（`INVALID_JSON_SYNTAX`）、各ドメインの厳密パーサー（`CONFIG_VALIDATION_FAILED`、`g-auth.json` は起動時と共通の `parseGoogleServiceAccountKey` を使用し、`client_email` と有効な RSA PEM `private_key` が必須、任意の `type` は `"service_account"` 固定、任意の `private_key_id`・`project_id`・`quota_project_id`・`universe_domain` はトリム後非空文字列必須でその他フィールドはそのまま保持）に加え、`database/storage.sqlite` 存在時の `bot.json` `time_zone` 変更禁止、`agent.json` ↔ `cron.json` の双方向依存検査（ディスク上の最新対向ファイルを優先参照）、および非シンボリックリンク検査（`inspectOptionalFile`）を実行し、`atomicWriteText` でアトミックに保存します（既存ファイルの権限を維持し、新規作成の任意設定ファイルは `MINI_APP_CONFIG_DEFAULT_FILE_MODE` = `0o600`）。
- **動的ホットリロードと静的設定の再起動確認**：`config/dynamic/` の保存後は `fs.watch` により自動ホットリロードされます。`config/static/`（`bot.json`、`g-auth.json`）の保存成功時は `requiresRestart: true` が返り、確認モーダル（**「後で実行」**／**「今すぐ実行」**）で承認すると `POST /api/configs/restart` が `systemctl restart --no-block copy-ninjia`（`MINI_APP_SERVICE_RESTART_COMMAND`、タイムアウト `MINI_APP_SERVICE_RESTART_TIMEOUT_MS` = 5 秒）を実行します。

---

## 動作確認と運用上の注意点

- **起動ログの確認**：Bot 起動後、ログに `Mini App HTTP server listening on http://127.0.0.1:3000 (public URL: https://app.example.com/).` が出力されていること、および `cloudflared` サービスが `active (running)` であることを確認してください。
- **エッジキャッシュとセキュリティヘッダー**：
  - **動的 HTML と業務 JSON API**：`index.html`、`reject.html`、およびすべての業務 JSON API 応答には `MINI_APP_NO_STORE_CACHE_CONTROL`（`no-store, no-cache, must-revalidate, max-age=0`）、`CDN-Cache-Control: no-store`、`Cloudflare-CDN-Cache-Control: no-store` が付与され、Cloudflare エッジやブラウザによる動的状態のキャッシュを防止します。
  - **ゲート保護されたバンドルチャンク**：ゲート通過後の `/chunk-*` アセットは `MINI_APP_BUNDLE_CACHE_CONTROL`（`private, no-cache, must-revalidate`）、`CDN-Cache-Control: no-store`、`Cloudflare-CDN-Cache-Control: no-store`、`Vary: Cookie, X-Telegram-Init-Data, Authorization`（`MINI_APP_BUNDLE_VARY_HEADER_VALUE`）、および `ETag` `304` 再検証を返し、公開プロキシや CDN でのキャッシュを禁止しつつ再利用ごとにゲート・ロック状態をオリジンへ再確認します。
  - **保護された画像庫プレビュー（`GET|HEAD /api/gallery/file`、`serveGalleryFileResponse`）**：スーパー管理者 `initData` ヘッダー、`X-Mini-App-Session`、および暗号化 `?e=` で検証したうえで（クエリ資格情報は禁止）、7 日間 `MINI_APP_GALLERY_FILE_CACHE_CONTROL`（`private, no-cache, max-age=604800, must-revalidate`）、`CDN-Cache-Control: no-store`、`Cloudflare-CDN-Cache-Control: no-store`、`Vary: MINI_APP_GALLERY_FILE_VARY_HEADER_VALUE`（`X-Telegram-Init-Data, Authorization, X-Mini-App-Session`）、`sizeBytes` と `mtimeMs` から導出した強い `ETag`（弱 ETag・複数値 `If-None-Match` `304` と `HEAD` 対応）、およびセキュリティヘッダーを返します。フロントエンドでは `galleryImageCache.ts` がブラウザ `CacheStorage`（バケット `MINI_APP_GALLERY_CACHE_NAME`、有効期間 7 日 `MINI_APP_GALLERY_CACHE_TTL_MS`）と有界メモリマップにファイル名キーのバイナリ `Blob` と `ETag` を保持し、`fetchMiniAppGalleryImageObjectUrl` / `useGalleryImageUrls` が `cache: "no-store"`＋`If-None-Match` で再検証して `304` ヒットをインメモリ `blob:` URL として描画します（削除や `404` 時は即時破棄、7 日経過後は強制再取得）。`GET|HEAD /api/gallery/download` は `no-store` 添付配信を行います（ヘッダー＋`?e=` フォールバックまたは 60 秒単回 `?ticket=` ネイティブ配信の二経路）。
  - **公開静的アイコン（`/favicon.ico`、`serveCachedAssetResponse`）**：`MINI_APP_ASSET_CACHE_CONTROL`（7 日間不変キャッシュ）と弱 ETag・複数値 `If-None-Match` 対応の `ETag` `304` 再検証、`HEAD`、およびセキュリティヘッダーを返します。
  - **共通セキュリティヘッダー**：すべてのレスポンスに `MINI_APP_CSP_HEADER_VALUE`（`'self'`、`https://telegram.org`、および `index.html`・`reject.html` インラインスクリプトの静的 SHA-256 ハッシュのみ許可）と `X-Frame-Options: DENY` が付与されます。
- **オンライン設定編集とサービス再起動の権限要件**：`config/` は既定で読み取り専用のまま運用できます。オンライン設定保存を使用する場合は、サービス実行アカウントに `config/dynamic/` および／または `config/static/` への書き込み・一時ファイル作成・アトミック `rename` 権限を付与してください。また静的設定保存後のオンライン再起動は `systemctl restart --no-block copy-ninjia` を呼び出します（`install.sh` が登録する `copy-ninjia.service` と一致しており、非 `root` アカウントでオンライン再起動を行う場合は、サービスアカウントに `copy-ninjia.service` の再起動を許可する polkit ルールのみが必要です）。
- **永続化 TOTP ファイルのバックアップ**：TOTP 認証器をバインドしている場合は、データルートのバックアップ対象に `memory/mini-app-totp/totp.json` を含めてください。サービス起動時と `install.sh` の事前検査はいずれも同一の厳格な基準でこのファイルを検証します（未存在は未バインド扱い、通常ファイル以外または形式不正は起動拒否。詳細は [07 運用マニュアル](07-operations.md) と [04 実行時の正式な不変条件](04-invariants.md) を参照）。

---

<div align="center">

[← 前のページ：09 コマンドと挙動リファレンス](09-commands.md) · [📚 開発者ドキュメント TOP](content-table.md) · [⬆️ トップへ戻る](#10-mini-app-の設定方法と推奨構成) · [次のページ：11 パフォーマンスベンチマーク →](11-performance.md)

</div>

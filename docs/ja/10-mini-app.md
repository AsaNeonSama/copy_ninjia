# 10 Mini App の設定方法と推奨構成

<p align="center">
  <a href="../cn/10-mini-app.md">简体中文</a> · <a href="../en/10-mini-app.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 開発者ドキュメント TOP</a> · <a href="09-commands.md">← 前のページ：09 コマンドと挙動リファレンス</a> · <a href="11-performance.md">次のページ：11 パフォーマンスベンチマーク →</a>
</p>

---

このガイドでは、`config/static/bot.json` でスーパー管理者専用の Telegram Mini App 管理コンソールを有効化する手順、推奨構成である Cloudflare Tunnel（`cloudflared`）を用いてローカル HTTP サーバーを公開 HTTPS エンドポイントとして公開する方法、およびコンソールの開き方・二段階認証（パスワード / Google Authenticator TOTP）・運用上の注意点を解説します。JSON フィールドの完全な仕様は [デプロイ設定説明](../../config_example/README/ja.md#botjson)、HTTP API ルートと権限境界は [09 コマンドリファレンス](09-commands.md#mini-app-console) を参照してください。

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
| `url` | **必須** | Telegram クライアントが WebApp を開く公開 `https://` URL。サブパスプレフィックス（例：`https://app.example.com/sub`）に対応し、パスプレフィックスを保持または除去するリバースプロキシの双方と互換性があります |
| `port` | **必須** | ローカル `Bun.serve` HTTP 待ち受けポート。`MINI_APP_PORT_MIN`〜`MINI_APP_PORT_MAX`（`1`〜`65535`）の安全な整数を指定します（トンネル転送先に合わせて `3000` を推奨） |
| `host` | 任意 | ローカル `Bun.serve` HTTP 待ち受けアドレス。省略時は `MINI_APP_DEFAULT_HOST`（`"127.0.0.1"`）となり、ローカルループバックのみをリッスンするためファイアウォールの受信ポート開放は不要です |
| `password` | **必須** | 初回画面のアクセスパスワード。6 桁以上の数字（`0-9`、`MINI_APP_PASSWORD_AT_LEAST_SIX_DIGITS_PATTERN`）を含む非空文字列である必要があり、サンプルプレースホルダー `MINI_APP_PASSWORD_PLACEHOLDER`（`"replace-with-mini-app-password"`）のままでは起動を拒否します |

- **任意の有効化**：`mini_app` セクション全体を省略した場合、ローカル `Bun.serve` HTTP サーバーやルートは一切起動せず、スーパー管理者の個人チャットに `MenuButtonWebApp` も設定されません。`config_example/static/bot.json` から手動でコピーして Mini App を使用しない場合は、`mini_app` セクションを削除してください（プレースホルダーパスワードが残っていると起動検証で拒否されます。`install.sh` の対話型ウィザードはプレースホルダーのままの `mini_app` を自動的に除外し、すでに実パスワードが設定されている場合は再実行時もそのまま保持します）。
- **反映方法**：`config/static/bot.json` は静的設定ファイルであるため、`mini_app` を変更した後は Bot サービスの再起動が必要です。

---

## 推奨構成：Cloudflare Tunnel の使用

Telegram Mini App には公開 `https://` URL が必須です。推奨構成は **Cloudflare Tunnel（`cloudflared`）** の利用です。上記の設定例では Bot 本体はローカルの `127.0.0.1:3000`（`host` の既定値は `MINI_APP_DEFAULT_HOST`、`port` は設定値）のみをリッスンし、サーバーの受信ポート開放や TLS 証明書の個別管理を行うことなく、`cloudflared` の送信暗号化トンネル経由で固定サブドメイン（例：`https://app.example.com`）のトラフィックを `http://localhost:3000` へ安全に転送できます。

### `cloudflared` のインストール

```shell
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
rm -f cloudflared.deb
```

### ログインとドメインルーティングの設定

```shell
# 1. ログイン認可（ブラウザが開き、認可する Cloudflare ドメインを選択すると cert.pem が生成されます）
cloudflared tunnel login

# 2. my-app という名前のトンネルを作成（対応する認証情報 JSON ファイルと Tunnel UUID が生成されます）
cloudflared tunnel create my-app

# 3. 固定サブドメインの CNAME ルートを該当トンネルへ自動追加
cloudflared tunnel route dns my-app app.example.com

# 4. 固定ドメインのトラフィックをローカルポート（例：3000 番ポート）へ転送してフォアグラウンド起動
cloudflared tunnel run --url http://localhost:3000 my-app
```

### トンネルサービスの設定

フォアグラウンドでの疎通確認後、設定ファイルを作成して systemd サービスとして常駐化・自動起動設定を行います：

```shell
# <Tunnel-UUID> を確認
cloudflared tunnel list
cd ~/.cloudflared
# 設定ファイルを編集
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
# 起動
# 設定を systemd サービスとしてインストール（~/.cloudflared/config.yml が自動的に /etc/cloudflared/ へコピーされます）
sudo cloudflared --config ~/.cloudflared/config.yml service install

# 起動および自動起動の有効化
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

`mini_app` を設定して Bot を起動すると、コマンドメニュー登録時にスーパー管理者（`SUPER_ADMIN_USER_ID`）と Bot の個人チャット左下へ自動的に `MenuButtonWebApp`（表示テキストは `MINI_APP_BUTTON_TEXT`、すなわち `App`）が設定されます。個人チャット左下の **`App`** ボタンをタップすると、Telegram 内蔵 WebView で管理コンソールが開きます。

### 2. 二段階セキュリティ認証とロック保護

- **第 1 層（リクエストヘッダーガードと Telegram WebApp `initData` 署名検証）**：すべての API リクエストはまず統一ミドルウェアチェーン（`headerGuard`）で同一オリジンと資格情報ヘッダー形式のファストパス検証を通過し、次に `X-Telegram-Init-Data`（または `Authorization: tma <initData>`、最大長 `MINI_APP_MAX_INIT_DATA_LENGTH`）で Telegram クライアント署名付きの `initData` を検証します。サーバーは `BOT_TOKEN` とシード `MINI_APP_WEB_APP_DATA_SECRET_SEED`（`"WebAppData"`）から派生した鍵で HMAC-SHA256 署名と `MINI_APP_AUTH_MAX_AGE_SECONDS`（45 分）の鮮度を検証し、`user.id === SUPER_ADMIN_USER_ID` を厳格に照合します。スーパー管理者以外のアカウントは第 1 層で即座に拒否されます。
- **第 2 層（初回画面の資格情報と 45 分セッション自動更新）**：
  - 認証器が未バインドの場合は、初回画面で `mini_app.password` を入力してロックを解除します。
  - 認証成功後、サーバーは `MINI_APP_SESSION_TTL_MS`（45 分）有効な `sessionToken`（`X-Mini-App-Session`）と画像庫アセット用の決定論的 `assetToken` を発行します。クライアントはこれを Web Storage に保存し `GET /api/auth/precheck` で検証・再開するため、45 分以内の画面リロードや再起動では再入力が不要であり、期限切れまたは手動ロック時に即座に消去されます。上部バーの「ロック」では `POST /api/auth/logout` でサーバー側のセッション失効も依頼します（結果は待ちません）。サーバーが返すセッション期限は、クライアントがレスポンスの `Date` ヘッダーで端末時刻に換算してから期限判定と自動ロックに使います。
  - 有効なセッショントークンが発行から `MINI_APP_SESSION_REFRESH_THRESHOLD_MS`（5 分）を超えている場合、サーバーは自動的に新しいトークンへローテーションして有効期限を 45 分延長します（`X-Mini-App-Session` と `X-Mini-App-Session-Expires-At` レスポンスヘッダーおよび `/api/auth/precheck` のレスポンスボディで返却し、セッション更新中は静的な `initData.auth_date` を継続許可。旧トークンも並行リクエスト向けに 5 分間有効）。メインスレッドは最大 `MINI_APP_SESSION_MAX`（8）件のセッションを保持します。
- **ブルートフォースロック**：パスワードまたは TOTP コードを連続 `MINI_APP_PASSWORD_MAX_ATTEMPTS`（3）回誤入力すると、スーパー管理者 ID は `MINI_APP_PASSWORD_LOCKOUT_MS`（30 分）ロックされ全セッションが消去されます。ロック発動時点でまだ処理中の同時ログイン要求は資格情報を照合せずに失敗として数え、ロックをその時点から 30 分間に延長します。未ロックからロックに入った時点で解除時刻と送信元 IP を記したアラートが個人チャットへ 1 通送信され、ロックの延長では再送されません。

### 3. Google Authenticator (TOTP) のバインド（推奨）

アクセスパスワードでログインした後、コンソールの「認証器」タブから単一の Google Authenticator ワンタイムパスワードをバインドすることを推奨します：

1. 「認証器」タブでバインド用の Base32 シークレットと QR コードを生成します（確認待ちシークレットの有効期限は `MINI_APP_TOTP_PENDING_TTL_MS` の 10 分間で、`MINI_APP_PASSWORD_MAX_ATTEMPTS` 回連続で誤入力すると即座に破棄されます）。
2. Google Authenticator 等の RFC 6238 互換アプリで QR コードを読み取り（または 32 文字の Base32 シークレットを手入力）、現在の `MINI_APP_TOTP_STEP_SECONDS`（30 秒）ステップの `MINI_APP_TOTP_DIGITS`（6 桁）コードを入力して有効化します。
3. 検証通過後、シークレットはデータルート配下の `memory/mini-app-totp/totp.json`（スキーマバージョン `MINI_APP_TOTP_RECORD_VERSION`）へアトミック書き込み（権限 `0o600`）で永続化されます。有効化後はログイン時に 6 桁の TOTP コードが優先検証され（現在の 30 秒タイムステップのコードのみを受け付けます）、「認証器」タブで削除すると `mini_app.password` による検証へ戻ります。

---

## 動作確認と運用上の注意点

- **起動ログの確認**：Bot 起動後、ログに `Mini App HTTP server listening on http://127.0.0.1:3000 (public URL: https://app.example.com/).` と出力されていること、および `cloudflared` サービスが `active (running)` であることを確認してください。
- **エッジキャッシュとセキュリティヘッダー**：すべての動的ページおよび業務 JSON API 応答には `MINI_APP_NO_STORE_CACHE_CONTROL`（`no-store, no-cache, must-revalidate, max-age=0`）が付与され、Cloudflare エッジでの動的状態のキャッシュを防止します。`assetToken` で認証された画像庫プレビュー画像と静的な `/favicon.ico` アイコンアセットは `MINI_APP_ASSET_CACHE_CONTROL`（7 日間の不変キャッシュ）と `ETag` 304 再検証を返します。全レスポンスに `MINI_APP_CSP_HEADER_VALUE` と `X-Frame-Options: DENY` が付与されます。
- **永続化ファイルのバックアップ**：TOTP 認証器をバインドしている場合は、データルートのバックアップに `memory/mini-app-totp/totp.json` を含めてください。サービス起動時および `install.sh` の事前検査はいずれも同一の厳格な基準でこのファイルを検証します（ファイル未存在は未バインド扱い、通常ファイル以外またはフォーマット不正時は起動拒否。詳細は [07 運用マニュアル](07-operations.md) と [04 実行時の正式な不変条件](04-invariants.md) を参照）。

---

<div align="center">

[← 前のページ：09 コマンドと挙動リファレンス](09-commands.md) · [📚 開発者ドキュメント TOP](content-table.md) · [⬆️ トップへ戻る](#10-mini-app-の設定方法と推奨構成) · [次のページ：11 パフォーマンスベンチマーク →](11-performance.md)

</div>

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../public/tagline_ja_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../../public/tagline_ja_light.svg">
  <img alt="Copy Ninjia Tagline" src="../../public/tagline_ja_light.svg" width="820">
</picture>

# 📚 Copy Ninjia 開発者ドキュメント

<p align="center">
  <a href="../cn/content-table.md">简体中文</a> · <a href="../en/content-table.md">English</a> · <b>日本語</b> · <a href="README.md">🏠 日本語 README</a>
</p>

開発者向けマルチページガイド：環境構築、アーキテクチャ設計、コーディング規約から機能拡張・運用保守まで網羅。

</div>

---

## 🧭 開発者クイックナビゲーション

<table width="100%">
<thead>
  <tr>
    <th width="24%" align="left">シナリオ</th>
    <th width="44%" align="left">おすすめパス</th>
    <th width="32%" align="center">直接リンク</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>🚀 <b>初回実行</b></nobr></td>
    <td>環境構築、デプロイ設定、Telegram API 権限と初回起動</td>
    <td align="center"><nobr><a href="01-getting-started.md">📖 01 環境構築</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🏗️ <b>アーキテクチャ理解</b></nobr></td>
    <td>メインスレッドと 3 つの Worker モデル、メッセージ処理のライフサイクルと復元</td>
    <td align="center"><nobr><a href="02-architecture.md">📖 02 アーキテクチャ</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🗺️ <b>コード検索</b></nobr></td>
    <td>モジュール役割分担、ソース構造マップおよび配置規約</td>
    <td align="center"><nobr><a href="03-directory-map.md">📖 03 ディレクトリマップ</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>⚡ <b>不変条件</b></nobr></td>
    <td>モジュール横断の正式な制約、並行性保護と状態規約</td>
    <td align="center"><nobr><a href="04-invariants.md">📖 04 正式な不変条件</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🧪 <b>開発とテスト</b></nobr></td>
    <td><code>bun run check</code> 品質ゲート、テスト隔離機構とカバレッジ</td>
    <td align="center"><nobr><a href="05-dev-workflow.md">📖 05 開発フロー</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🛠️ <b>機能の追加・変更</b></nobr></td>
    <td>コマンド追加、パラメータ調整、AI ツール追加およびスキーマ変更のレシピ</td>
    <td align="center"><nobr><a href="06-modification-guide.md">📖 06 変更レシピ</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🛡️ <b>本番運用</b></nobr></td>
    <td>systemd デプロイ、ハードウェアの目安、<code>COPY_NINJIA_DATA_ROOT</code>、バックアップと障害対応</td>
    <td align="center"><nobr><a href="07-operations.md">📖 07 運用マニュアル</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🖼️ <b>画像庫と定時タスク</b></nobr></td>
    <td>画像収集・内容重複判定・アルバム・定時ボイス・タイムゾーン・パス基準</td>
    <td align="center"><nobr><a href="08-images-and-cron.md">📖 08 画像ライブラリと定時タスク</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🎮 <b>コマンドを調べる</b></nobr></td>
    <td>全コマンド、権限の読み方、挙動の詳細（ルート README には概要だけ）</td>
    <td align="center"><nobr><a href="09-commands.md">📖 09 コマンドリファレンス</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🖥️ <b>Mini App コンソール</b></nobr></td>
    <td><code>mini_app</code> の設定、Cloudflare Tunnel による推奨公開構成、二段階認証と TOTP バインド</td>
    <td align="center"><nobr><a href="10-mini-app.md">📖 10 Mini App の設定方法と推奨構成</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>📊 <b>計測値を見る</b></nobr></td>
    <td>コールド/ホットパス、総スループットと総 I/O、エンドツーエンドのチェーン遅延のリリースベンチマーク</td>
    <td align="center"><nobr><a href="11-performance.md">📖 11 パフォーマンス</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>❓ <b>返信がないとき</b></nobr></td>
    <td>Bot が動いているのに反応しないときの確認リスト</td>
    <td align="center"><nobr><a href="12-faq.md">📖 12 よくある質問</a></nobr></td>
  </tr>
</tbody>
</table>

---

## 📑 ページ一覧と概要

1. **[01 環境構築と初回起動](01-getting-started.md)**
   - 動作要件（`/proc` を備えた Linux、Bun、Bot Token、各 AI プロバイダの API Key）
   - `install.sh` によるワンショット導入（バイナリ配布版またはソースクローン）と手動ソース導入
   - `config/static/bot.json` や動的設定 JSON のスキーマ検証ルール
   - @BotFather 設定（Privacy Mode、グループ管理者権限、Inline Mode、Bot-to-Bot 通信）
   - 初回起動と `/init enable` によるグループ有効化

2. **[02 アーキテクチャ概要](02-architecture.md)**
   - メインスレッド（Telegram runner・送信ゲート・任意の Mini App HTTP サーバー）+ 3 つの専用 Worker（AI・Anti-Raid・Disk I/O）のマルチスレッド構成
   - Telegram update の受信から前処理・コマンド振り分け・自動応答までの経路
   - 起動シーケンス、非同期状態復元、および直列ドレインバリアによる安全な停止手順

3. **[03 ディレクトリ構成とコード配置](03-directory-map.md)**
   - `packages/` 配下の各パッケージ（`mini-app-api-server/` や独立境界の `mini-app-frontend/` を含む）の責務
   - 定数・型・スレッド別キャッシュ・純粋状態マシン・Worker 実装の配置判断ルール
   - `packages/cache/` のスレッド所有権境界と互換エントリ（barrel）の運用規約

4. **[04 実行時の正式な不変条件](04-invariants.md)**
   - モジュール間・ライフサイクル間の正式な制約（ソース内の `@see` コメントの参照先）
   - 起動と import の境界：起動順序、任意の資格情報の縮退、データルート検査、外部リクエストと送信安全性
   - Worker と状態の所有権：スレッド帰属、ステートマシン契約、AI チャット実行時制御、参加認証と終端処置、連投ミュートと権限キャッシュ
   - 永続化契約：SQLite Write-Through、JSONB 検証、アトミック置換、グループ状態 `chat_states`、ブラックリストと広告検出、停止確認境界、ファイル権限

5. **[05 開発フローと品質ゲート](05-dev-workflow.md)**
   - `bun run check` 直列パイプライン：インストーラー検査、規約チェック、ESLint、TypeScript 型検査、ランダム順カバレッジ付き全テスト、ホットパスゲート
   - 一時データルートによるテストサンドボックス分離
   - コミット規約、障害注入テスト（`bun run test:fault-injection`）、およびリリース手順

6. **[06 よくある変更レシピ](06-modification-guide.md)**
   - Telegram スラッシュコマンド（漢字アクションコマンドを含む）の実装と安全な MarkdownV2 整形
   - 動作定数の調整、プロンプト差し替え、新しいデプロイ設定 JSON の登録
   - AI ツール、任意のプロバイダ能力、安全な外部 JSON API 呼び出しの追加
   - 実行時キャッシュの追加、Worker 間メッセージプロトコルの更新、オフラインでのデータベースコールド移行
   - 非目標：多言語 UI（i18n）は行わず、文言変更は fork で対応

7. **[07 運用と障害対応](07-operations.md)**
   - デプロイ形態、規模別のハードウェア目安、systemd サービス登録とバイナリ配布運用
   - データルート構造と `COPY_NINJIA_DATA_ROOT` のファイルシステム機能検査（fsync / hard link / アトミック rename）
   - 永続データの移行：新規データベース作成、`/wed` メンバーウィンドウのコールド移行（`migrate:wed-member-window`）、`ad_detect.json` への設定移行、段階的アップグレード
   - 起動時フェイルファスト診断：`bot.lock` 競合、スキーマ不一致、`memory/luck/receipt-secret.json` 鍵検証の切り分け

8. **[08 画像ライブラリと定時タスク](08-images-and-cron.md)**
   - 専用ライブラリの準備、画像収集と内容の重複判定
   - 定時の単画像・アルバム・ランダム画像・音声の設定
   - タイムゾーン、対象グループと相対パスの基準

9. **[09 コマンドと挙動リファレンス](09-commands.md)**
   - Copy モードと対象の指定方法
   - 全コマンドの権限段階（権限キー / スーパー管理者 / グループメンバー）
   - `/gag`、`/delete_message`、`/block`、`/batch_kick`、広告検出、参加認証などの挙動の詳細

10. **[10 Mini App の設定方法と推奨構成](10-mini-app.md)**
    - `config/static/bot.json` の `mini_app` セクションの設定と有効化条件
    - Cloudflare Tunnel（`cloudflared`）による公開 HTTPS エンドポイントの構成、ドメインルーティングと systemd サービス登録手順
    - 個人チャット左下の `App` ボタン、二段階認証、Google Authenticator (TOTP) のバインド手順

11. **[11 パフォーマンスベンチマーク](11-performance.md)**
    - `bun run perf:full` の各セクションの計測対象：コールドスタート、本番ホットパス、エンドツーエンドの永続化チェーン、SQLite とメインスレッドキャッシュ、コンテナとアルゴリズム、参加ログ容量線
    - 各項目を既定のラウンド数で実行し、平均・最小・最大・変動係数を報告
    - 1 ラウンドあたりの総スループット、総 I/O、モックデータルートの使用量

12. **[12 よくある質問](12-faq.md)**
    - Bot が動いているのに返信しない場合の順次確認：初期化、プライバシーモード、AI の反応条件、個人チャット、通知の自動削除、Inline Mode、Bot-to-Bot、既定で無効な保護機能、プロセスの状態
    - 通知の口調、画像ライブラリによる起動拒否、定時タスクの再送、定時ボイスと `/send` のボイス、ボイスの長さとメモリ設定、サードパーティゲートウェイ経由の Google モデル呼び出し、Cloudflare AI Gateway 経由の Anthropic モデル呼び出し

---

## 📝 ドキュメント保守規約

- **3 言語同期**：中国語版は `docs/cn/`、英語版は `docs/en/`、日本語版は `docs/ja/` に配置。構成や数値変更時は 3 言語を同時に更新。
- **一元管理**：モジュール横断の制約は [04 正式な不変条件](04-invariants.md) でのみ保守し、他のドキュメントからはリンクで参照します。
- **定数参照**：数値の信頼できる唯一の情報源は `packages/consts/` です。ドキュメントでは数値の直接記述を避け、定数名を記載します。

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../public/footer_ja_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../../public/footer_ja_light.svg">
  <img alt="Copy Ninjia Footer" src="../../public/footer_ja_light.svg" width="750">
</picture>

</div>

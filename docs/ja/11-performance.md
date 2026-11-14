# 11 パフォーマンスベンチマーク

<p align="center">
  <a href="../cn/11-performance.md">简体中文</a> · <a href="../en/11-performance.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 ドキュメントホーム</a> · <a href="10-mini-app.md">← 前のページ：10 Mini App の設定方法と推奨構成</a> · <a href="12-faq.md">次のページ：12 よくある質問 →</a>
</p>

---

本ページの計測値は `bun run perf:full -- --write-doc` によって自動生成され、リリースごとに一括更新されます。
**下の 2 つのマーカーに挟まれた内容は手動で編集しないでください**。リリーススクリプトによって 3 言語のドキュメントが同一バッチで同期されます。

ベンチマークを実行すると、**構造化レポート全文**（実行環境、テストセクション、各項目の平均時間と変動係数）がリポジトリルートの `performance-result.json` 内 `fullSuite.lastRun` に書き込まれます。本ページのテーブルと JSON レポートは、単一の `--write-doc` スイッチによってアトミックに出力されます。

全量ベンチマークスイートはリリース時および明示的な指示があった場合のみ実行され、日常的な `bun run check` 門禁には含まれません。本番ホットパスの GC/RSS/JIT ハードゲートは `bun run perf:hot-path-gate` が独立して担当します（詳細は [05 開発フローと品質ゲート](05-dev-workflow.md) を参照）。

個別シナリオおよび `bun run perf:disk-transport` の実行手順・測定境界については、[05 開発フロー](05-dev-workflow.md#個別シナリオと伝送ストレス検証) を参照してください。個別検証の出力とホットパス門禁の結果は個別に記録され、以下の全量ベンチマーク生成ブロックを上書きすることはありません。

<!-- performance-benchmark:start -->

**直近の全量ベンチマーク** · Bun 1.4.4 · 3 ラウンドの平均 · 2026-11-14T16:49:00Z · プロセス起動からローカル復元完了まで 358.6 ms · グループメッセージ 1 件を基本ディスパッチする 113.9 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 191.7 µs / 4,414 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 1.72 ms / 453 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.4 (`38afee6c84fcf48c0edb2466aa4b27d287a59c30`) |
| カーネル | linux 6.8.0-149-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-11-14T16:49:00Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 394,548,253 |
| プロセス読み込み | 183.35 MiB |
| プロセス書き込み | 186.14 MiB |
| ブロックデバイス読み込み | 650.67 KiB |
| ブロックデバイス書き込み | 235.36 MiB |
| 読み込みシステムコール | 49,976 |
| 書き込みシステムコール | 245,813 |
| モックルート使用量 | 14.84 MiB |
| モックルートファイル数 | 142 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 114.0 ms | ±2.5% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 10.84 ms | ±5.7% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 700.9 µs | ±2.5% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.33 ms | ±3.4% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 4.89 ms | ±3.9% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 655.2 µs | ±2.1% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 212.7 ms | ±0.8% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 349.8 µs | ±4.8% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 358.6 ms | ±1.5% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 116.13 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 113.9 ns | 8,812,114 回/s | 92.49 MiB | 18.00 KiB | ±6.2% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 72.8 ns | 13,737,935 回/s | 93.66 MiB | 20.92 KiB | ±1.7% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 1.2 ns | 864,575,427 回/s | 81.26 MiB | 28.06 KiB | ±2.0% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 13.5 ns | 74,152,680 回/s | 81.41 MiB | 28.82 KiB | ±1.4% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 32.2 ns | 31,024,718 回/s | 82.50 MiB | 28.96 KiB | ±1.0% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,165,334,218 回/s | 80.09 MiB | 28.66 KiB | ±0.6% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 41.5 ns | 24,240,429 回/s | 81.57 MiB | 29.03 KiB | ±8.1% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.2 ns | 238,489,720 回/s | 80.19 MiB | 27.76 KiB | ±1.7% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 9.7 ns | 103,314,761 回/s | 80.36 MiB | 26.88 KiB | ±1.0% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 34.3 ns | 29,250,816 回/s | 85.29 MiB | 28.62 KiB | ±5.9% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 1.171 µs | 853,990 回/s | 105.63 MiB | 24.60 KiB | ±0.7% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 57.5 ns | 17,388,327 回/s | 87.28 MiB | 28.69 KiB | ±1.6% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 42.2 ns | 23,731,120 回/s | 90.55 MiB | 28.50 KiB | ±3.3% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 47.8 ns | 20,926,595 回/s | 83.80 MiB | 28.30 KiB | ±1.7% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 166.0 ns | 6,038,208 回/s | 96.67 MiB | 20.96 KiB | ±5.0% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 303.5 ns | 3,321,698 回/s | 140.35 MiB | 20.93 KiB | ±9.2% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.8 ns | 209,670,018 回/s | 81.00 MiB | 26.71 KiB | ±5.6% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 2.456 µs | 407,175 回/s | 91.29 MiB | 23.61 KiB | ±0.4% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 30.6 ns | 32,688,801 回/s | 90.88 MiB | 19.55 KiB | ±2.7% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 228.7 ns | 4,372,087 回/s | 91.32 MiB | 22.60 KiB | ±0.7% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 37.70 µs | 26,530 回/s | 102.26 MiB | 22.78 KiB | ±1.3% |
| 返信参照を抽出する<br><code>reply-reference</code> | 25.2 ns | 39,756,921 回/s | 91.70 MiB | 23.89 KiB | ±1.5% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 40.6 ns | 24,638,181 回/s | 101.56 MiB | 30.19 KiB | ±2.0% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.0 ns | 248,749,990 回/s | 81.70 MiB | 26.70 KiB | ±0.4% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 37.6 ns | 26,654,956 回/s | 88.61 MiB | 28.92 KiB | ±4.2% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 19.9 ns | 50,217,820 回/s | 80.48 MiB | 27.45 KiB | ±0.8% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 14.9 ns | 66,964,824 回/s | 80.18 MiB | 28.11 KiB | ±0.7% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 84.0 ns | 11,898,852 回/s | 80.53 MiB | 28.45 KiB | ±0.8% |
| Mini App バックエンド：二層認証を検証し管理対象グループ状態一覧を集計する<br><code>mini-app-status-route</code> | 7.611 µs | 131,485 回/s | 92.81 MiB | 25.59 KiB | ±2.6% |
| Mini App フロントエンド：ステータス比較・指標整形・FLIP/スプリング補間を計算する<br><code>mini-app-frontend-render</code> | 544.0 ns | 1,838,987 回/s | 100.84 MiB | 34.10 KiB | ±1.9% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。cron 音声の行も音声合成モデルと Telegram を固定応答（約 11 秒の WAV）に置き換え、Base64 デコード、WAV 解析、Opus エンコードと送信境界を含む。本番では合成は AI Worker 上で動くが、この行は同一プロセス内で両側をつなぎ、スレッド間の受け渡しは含まない。cron.json の行は途中変更の費用だけを測り、タスクは実行しない。タスク表は本番の上限（128 タスク、各 16 アクション、ローカルソースはデータルート相対）とし、1 タスクを変更するたびに本番と同じ順序でホットリロード対象の 6 ファイルを読み取って厳密に解析し（ローカルソースを 1 件ずつ確認）、スナップショットを置き換えてタスク名でスケジューラを突き合わせる。書き換えと保存はデプロイ側の作業なので計測せず、ファイル監視のデバウンス待ち、その後の広告検出と AI チャットの可用性の再判定、ホットリロードのログも含まない。Mini App の 5 行は `Bun.serve` ルートハンドラ入口からの主要経路を個別に計測する。API リクエスト行は同期認証パイプライン（ヘッダーガード、Telegram WebApp `initData` の HMAC-SHA256 署名と特権管理者チェック、45 分パスワードセッション検証）、管理対象グループ状態および Q&A・ホットメッセージ件数の集計、実際の Disk I/O Worker 経由での過去 24 時間参加ログ取得と 1～24 時間スライディングウィンドウ集計、および HTTP JSON レスポンスの直列化と解析を通しで実行する。残る 4 行は未認可拒否ページの事前分割属性注入、ページゲート Cookie 通過、ログイン検証とセッション/Cookie 発行、保護付きギャラリー画像（`?token=`）配信のローカル処理を計測する。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 923 回/s | 1.08 ms | 1.02 ms | 1.34 ms | 7.20 ms | 923 レコード/s | 3.91 MiB | ±2.2% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 350 回/s | 2.86 ms | 2.79 ms | 4.92 ms | 14.86 ms | 44,747 レコード/s | 21.42 MiB | ±3.9% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 715 回/s | 1.42 ms | 1.20 ms | 2.55 ms | 10.72 ms | 715 レコード/s | 3.15 MiB | ±13.3% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 787 回/s | 1.28 ms | 1.16 ms | 1.96 ms | 5.43 ms | 787 レコード/s | 3.13 MiB | ±8.0% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 750 回/s | 1.33 ms | 1.28 ms | 1.64 ms | 7.56 ms | 750 レコード/s | 3.13 MiB | ±2.1% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 404 回/s | 2.48 ms | 2.24 ms | 3.40 ms | 14.37 ms | 404 レコード/s | 5.55 MiB | ±3.6% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 877 回/s | 1.14 ms | 1.06 ms | 1.48 ms | 11.33 ms | 877 レコード/s | 4.16 MiB | ±2.7% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 453 回/s | 2.31 ms | 1.72 ms | 4.60 ms | 16.54 ms | 453 レコード/s | 1.82 MiB | ±23.4% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 4,414 回/s | 224.1 µs | 191.7 µs | 457.3 µs | 562.7 µs | 4,414 レコード/s | 0 B | ±2.9% |
| cron send_voice：音声 1 件を合成・エンコードして送信する（通信を除く）<br><code>cron-send-voice</code> | 5 回/s | 214.8 ms | 214.5 ms | 218.8 ms | 222.0 ms | 5 レコード/s | 0 B | ±2.3% |
| cron.json のタスク 1 件を途中変更：ホットリロードと再スケジュール（上限規模のタスク表）<br><code>cron-config-reload</code> | 9 回/s | 117.0 ms | 115.9 ms | 128.7 ms | 145.8 ms | 9 レコード/s | 7.31 MiB | ±0.7% |
| Mini App API リクエスト：同期認証パイプライン・グループ詳細集計・参加ログ 24h クエリ（GET /api/chats/:chatId）<br><code>mini-app-api-request</code> | 6,361 回/s | 175.1 µs | 132.3 µs | 384.0 µs | 1.99 ms | 6,361 レコード/s | 0 B | ±29.0% |
| Mini App 未認可拒否ページ：診断情報構築と reject.html 属性注入（serveMiniAppRejectHtml）<br><code>mini-app-reject-page</code> | 21,996 回/s | 45.25 µs | 28.49 µs | 76.88 µs | 1.86 ms | 21,996 レコード/s | 0 B | ±3.0% |
| Mini App 単一ページゲート許可：Cookie HMAC-SHA256 検証とロック検査（evaluateMiniAppPageGateRequest）<br><code>mini-app-page-gate-allow</code> | 201,855 回/s | 4.941 µs | 3.238 µs | 7.563 µs | 1.92 ms | 201,855 レコード/s | 28.00 KiB | ±24.3% |
| Mini App ログイン API：initData 検証・パスワード照合・セッションとゲート Cookie 発行（POST /api/auth/login）<br><code>mini-app-auth-login</code> | 26,907 回/s | 36.77 µs | 28.87 µs | 57.17 µs | 2.65 ms | 26,907 レコード/s | 0 B | ±1.8% |
| Mini App 保護ギャラリー画像：?token= トークン検証とキャッシュ応答読込（GET /api/gallery/file/:fileName）<br><code>mini-app-gallery-asset</code> | 15,203 回/s | 65.35 µs | 57.89 µs | 92.78 µs | 920.2 µs | 15,203 レコード/s | 0 B | ±1.4% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 37,640,795 回/s | 214.1 ns | 0 B | 12.75 KiB | ±8.3% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 45,744 回/s | 2.80 ms | 56.55 MiB | 23.59 KiB | ±3.0% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 347,885 回/s | 23.07 µs | 5.30 MiB | -11.04 KiB | ±5.6% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 10,953 回/s | 730.4 µs | 34.02 MiB | 206.13 KiB | ±0.7% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 63,966 回/s | 2.01 ms | 73.15 MiB | 129.93 KiB | ±5.4% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 20,586 回/s | 6.22 ms | 12.60 MiB | 424.02 KiB | ±2.1% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 17.6 ns | 57,026,584 回/s | 91.33 MiB | 23.08 KiB | ±6.5% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 28.6 ns | 35,083,495 回/s | 83.07 MiB | 28.72 KiB | ±5.1% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 15.7 ns | 64,269,681 回/s | 91.25 MiB | 28.32 KiB | ±10.6% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 197.6 ms | 2.56 MiB | 6.45 KiB | ±4.1% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 3.64 ms | 0 B | -4.76 KiB | ±2.3% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：10 Mini App の設定方法と推奨構成](10-mini-app.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#11-パフォーマンスベンチマーク) · [次のページ：12 よくある質問 →](12-faq.md)

</div>

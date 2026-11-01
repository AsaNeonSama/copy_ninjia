# 10 パフォーマンスベンチマーク

<p align="center">
  <a href="../cn/10-performance.md">简体中文</a> · <a href="../en/10-performance.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 ドキュメントホーム</a> · <a href="09-commands.md">← 前のページ：09 コマンドと挙動リファレンス</a> · <a href="11-mini-app.md">次のページ：11 Mini App の設定方法と推奨構成 →</a>
</p>

---

本ページの計測値は `bun run perf:full -- --write-doc` によって自動生成され、リリースごとに一括更新されます。
**下の 2 つのマーカーに挟まれた内容は手動で編集しないでください**。リリーススクリプトによって 3 言語のドキュメントが同一バッチで同期されます。

ベンチマークを実行すると、**構造化レポート全文**（実行環境、テストセクション、各項目の平均時間と変動係数）がリポジトリルートの `performance-result.json` 内 `fullSuite.lastRun` に書き込まれます。本ページのテーブルと JSON レポートは、単一の `--write-doc` スイッチによってアトミックに出力されます。

全量ベンチマークスイートはリリース時および明示的な指示があった場合のみ実行され、日常的な `bun run check` 門禁には含まれません。本番ホットパスの GC/RSS/JIT ハードゲートは `bun run perf:hot-path-gate` が独立して担当します（詳細は [05 開発フローと品質ゲート](05-dev-workflow.md) を参照）。

個別シナリオおよび `bun run perf:disk-transport` の実行手順・測定境界については、[05 開発フロー](05-dev-workflow.md#個別シナリオと伝送ストレス検証) を参照してください。個別検証の出力とホットパス門禁の結果は個別に記録され、以下の全量ベンチマーク生成ブロックを上書きすることはありません。

<!-- performance-benchmark:start -->

**直近の全量ベンチマーク** · Bun 1.4.4 · 3 ラウンドの平均 · 2026-11-01T13:44:51Z · プロセス起動からローカル復元完了まで 365.6 ms · グループメッセージ 1 件を基本ディスパッチする 111.8 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 187.9 µs / 4,506 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 1.73 ms / 535 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.4 (`38afee6c84fcf48c0edb2466aa4b27d287a59c30`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-11-01T13:44:51Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 394,541,853 |
| プロセス読み込み | 183.13 MiB |
| プロセス書き込み | 186.10 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 235.29 MiB |
| 読み込みシステムコール | 48,983 |
| 書き込みシステムコール | 244,977 |
| モックルート使用量 | 14.59 MiB |
| モックルートファイル数 | 130 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 121.9 ms | ±14.0% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 10.99 ms | ±10.2% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 902.2 µs | ±14.8% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.47 ms | ±20.9% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 5.08 ms | ±19.7% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 702.4 µs | ±7.0% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 210.7 ms | ±1.6% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 336.7 µs | ±4.6% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 365.6 ms | ±5.9% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 115.92 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 111.8 ns | 8,958,114 回/s | 92.86 MiB | 18.15 KiB | ±4.4% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 72.3 ns | 13,833,626 回/s | 93.92 MiB | 21.44 KiB | ±0.9% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 1.1 ns | 876,811,083 回/s | 81.58 MiB | 27.05 KiB | ±0.9% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 13.3 ns | 75,058,160 回/s | 81.87 MiB | 28.13 KiB | ±0.9% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 31.3 ns | 31,903,747 回/s | 82.28 MiB | 28.49 KiB | ±1.1% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,167,120,118 回/s | 79.23 MiB | 27.12 KiB | ±1.2% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 45.0 ns | 22,272,984 回/s | 80.70 MiB | 28.03 KiB | ±5.0% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.2 ns | 239,514,880 回/s | 80.18 MiB | 27.75 KiB | ±1.2% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 9.2 ns | 108,407,080 回/s | 80.78 MiB | 27.92 KiB | ±2.2% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 32.6 ns | 30,700,797 回/s | 84.80 MiB | 28.10 KiB | ±0.8% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 1.155 µs | 869,676 回/s | 104.73 MiB | 22.33 KiB | ±6.5% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 56.6 ns | 17,666,205 回/s | 87.25 MiB | 28.12 KiB | ±2.7% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 38.5 ns | 25,988,646 回/s | 90.90 MiB | 27.93 KiB | ±3.8% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 46.4 ns | 21,566,307 回/s | 83.00 MiB | 28.36 KiB | ±1.6% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 167.1 ns | 5,995,823 回/s | 95.46 MiB | 19.34 KiB | ±4.4% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 293.3 ns | 3,411,134 回/s | 143.73 MiB | 22.00 KiB | ±2.1% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.7 ns | 213,984,146 回/s | 80.97 MiB | 26.93 KiB | ±6.9% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 2.073 µs | 482,299 回/s | 91.39 MiB | 23.28 KiB | ±0.5% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 29.0 ns | 34,471,596 回/s | 89.98 MiB | 19.33 KiB | ±3.6% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 223.6 ns | 4,473,575 回/s | 91.35 MiB | 22.72 KiB | ±2.1% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 37.21 µs | 26,877 回/s | 102.67 MiB | 23.28 KiB | ±0.4% |
| 返信参照を抽出する<br><code>reply-reference</code> | 28.4 ns | 35,732,341 回/s | 91.08 MiB | 23.32 KiB | ±12.1% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 39.7 ns | 25,219,735 回/s | 101.43 MiB | 29.85 KiB | ±3.3% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.0 ns | 252,726,979 回/s | 80.64 MiB | 26.58 KiB | ±2.5% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 36.2 ns | 27,683,994 回/s | 88.78 MiB | 28.59 KiB | ±3.1% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 19.6 ns | 50,992,118 回/s | 80.38 MiB | 28.00 KiB | ±0.3% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 15.0 ns | 66,556,811 回/s | 80.05 MiB | 27.65 KiB | ±1.4% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 83.7 ns | 11,947,070 回/s | 81.19 MiB | 28.26 KiB | ±1.3% |
| Mini App バックエンド：二層認証を検証し管理対象グループ状態一覧を集計する<br><code>mini-app-status-route</code> | 8.371 µs | 119,467 回/s | 93.25 MiB | 23.26 KiB | ±0.9% |
| Mini App フロントエンド：ステータス比較・指標整形・FLIP/スプリング補間を計算する<br><code>mini-app-frontend-render</code> | 1.302 µs | 768,282 回/s | 100.02 MiB | 44.51 KiB | ±0.8% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。cron 音声の行も音声合成モデルと Telegram を固定応答（約 11 秒の WAV）に置き換え、Base64 デコード、WAV 解析、Opus エンコードと送信境界を含む。本番では合成は AI Worker 上で動くが、この行は同一プロセス内で両側をつなぎ、スレッド間の受け渡しは含まない。cron.json の行は途中変更の費用だけを測り、タスクは実行しない。タスク表は本番の上限（128 タスク、各 16 アクション、ローカルソースはデータルート相対）とし、1 タスクを変更するたびに本番と同じ順序でホットリロード対象の 6 ファイルを読み取って厳密に解析し（ローカルソースを 1 件ずつ確認）、スナップショットを置き換えてタスク名でスケジューラを突き合わせる。書き換えと保存はデプロイ側の作業なので計測せず、ファイル監視のデバウンス待ち、その後の広告検出と AI チャットの可用性の再判定、ホットリロードのログも含まない。Mini App API リクエストの行は `Bun.serve` ルートハンドラ入口から認証ミドルウェアチェーン（ヘッダーガード、Telegram WebApp `initData` の HMAC-SHA256 署名と特権管理者チェック、45 分パスワードセッション延長）、管理対象グループ状態および Q&A・ホットメッセージ件数の集計、実際の Disk I/O Worker 経由での過去 24 時間参加ログ取得と 1～24 時間スライディングウィンドウ集計、および HTTP JSON レスポンスの直列化と解析までを通しで実行し、管理 API の典型的な単一プロセス RPS を計測する。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 721 回/s | 1.39 ms | 1.31 ms | 1.98 ms | 6.83 ms | 721 レコード/s | 3.91 MiB | ±3.2% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 316 回/s | 3.18 ms | 2.88 ms | 6.02 ms | 13.47 ms | 40,418 レコード/s | 21.42 MiB | ±7.6% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 660 回/s | 1.52 ms | 1.30 ms | 3.05 ms | 12.92 ms | 660 レコード/s | 3.15 MiB | ±7.5% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 696 回/s | 1.44 ms | 1.33 ms | 2.09 ms | 6.36 ms | 696 レコード/s | 3.13 MiB | ±5.2% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 642 回/s | 1.56 ms | 1.45 ms | 2.22 ms | 5.70 ms | 642 レコード/s | 3.13 MiB | ±1.0% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 382 回/s | 2.61 ms | 2.40 ms | 3.70 ms | 11.81 ms | 382 レコード/s | 5.55 MiB | ±1.0% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 770 回/s | 1.30 ms | 1.22 ms | 1.84 ms | 7.19 ms | 770 レコード/s | 4.16 MiB | ±3.5% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 535 回/s | 1.87 ms | 1.73 ms | 2.59 ms | 7.18 ms | 535 レコード/s | 1.82 MiB | ±2.6% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 4,506 回/s | 219.6 µs | 187.9 µs | 400.5 µs | 529.4 µs | 4,506 レコード/s | 0 B | ±2.6% |
| cron send_voice：音声 1 件を合成・エンコードして送信する（通信を除く）<br><code>cron-send-voice</code> | 5 回/s | 210.5 ms | 210.2 ms | 215.1 ms | 217.8 ms | 5 レコード/s | 0 B | ±1.1% |
| cron.json のタスク 1 件を途中変更：ホットリロードと再スケジュール（上限規模のタスク表）<br><code>cron-config-reload</code> | 8 回/s | 127.3 ms | 125.0 ms | 141.7 ms | 167.6 ms | 8 レコード/s | 7.31 MiB | ±2.1% |
| Mini App API リクエスト：認証ミドルウェア・グループ詳細集計・参加ログ 24h クエリ（GET /api/chats/:chatId）<br><code>mini-app-api-request</code> | 6,802 回/s | 146.4 µs | 123.3 µs | 208.0 µs | 3.11 ms | 6,802 レコード/s | 0 B | ±0.6% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 40,604,194 回/s | 197.0 ns | 0 B | 12.22 KiB | ±0.8% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 45,143 回/s | 2.84 ms | 56.55 MiB | 22.67 KiB | ±3.0% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 387,174 回/s | 20.67 µs | 5.30 MiB | 48.77 KiB | ±1.8% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 13,733 回/s | 582.9 µs | 34.02 MiB | 184.60 KiB | ±2.6% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 59,532 回/s | 2.15 ms | 73.15 MiB | 128.78 KiB | ±3.1% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 18,497 回/s | 6.95 ms | 12.60 MiB | 420.28 KiB | ±6.9% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 16.5 ns | 61,688,949 回/s | 90.69 MiB | 22.44 KiB | ±12.5% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 28.1 ns | 35,710,716 回/s | 83.22 MiB | 27.91 KiB | ±6.6% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 18.3 ns | 55,082,806 回/s | 91.39 MiB | 29.16 KiB | ±8.8% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 191.7 ms | 3.20 MiB | 6.04 KiB | ±0.6% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 3.56 ms | 0 B | -5.30 KiB | ±1.6% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：09 コマンドと挙動リファレンス](09-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#10-パフォーマンスベンチマーク) · [次のページ：11 Mini App の設定方法と推奨構成 →](11-mini-app.md)

</div>

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

**直近の全量ベンチマーク** · Bun 1.4.4 · 3 ラウンドの平均 · 2026-11-07T11:06:15Z · プロセス起動からローカル復元完了まで 362.4 ms · グループメッセージ 1 件を基本ディスパッチする 114.8 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 186.7 µs / 4,578 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 1.70 ms / 552 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.4 (`38afee6c84fcf48c0edb2466aa4b27d287a59c30`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-11-07T11:06:15Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 394,541,853 |
| プロセス読み込み | 183.12 MiB |
| プロセス書き込み | 186.10 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 235.29 MiB |
| 読み込みシステムコール | 49,001 |
| 書き込みシステムコール | 244,982 |
| モックルート使用量 | 14.59 MiB |
| モックルートファイル数 | 130 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 110.5 ms | ±2.2% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 11.12 ms | ±0.2% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 734.8 µs | ±6.4% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.35 ms | ±7.3% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 4.50 ms | ±5.8% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 714.0 µs | ±6.9% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 220.1 ms | ±4.8% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 329.6 µs | ±3.4% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 362.4 ms | ±2.4% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 116.07 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 114.8 ns | 8,751,182 回/s | 95.04 MiB | 17.50 KiB | ±6.6% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 71.3 ns | 14,029,232 回/s | 93.89 MiB | 21.86 KiB | ±1.9% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 1.1 ns | 889,458,216 回/s | 81.80 MiB | 26.87 KiB | ±2.1% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 13.5 ns | 73,848,674 回/s | 82.23 MiB | 28.41 KiB | ±2.0% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 31.7 ns | 31,606,244 回/s | 83.44 MiB | 28.52 KiB | ±2.9% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,164,077,476 回/s | 80.67 MiB | 27.86 KiB | ±1.6% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 44.9 ns | 22,460,406 回/s | 82.21 MiB | 27.90 KiB | ±8.6% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.0 ns | 248,821,999 回/s | 80.44 MiB | 27.66 KiB | ±0.5% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 9.6 ns | 104,115,533 回/s | 81.29 MiB | 27.21 KiB | ±1.8% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 36.0 ns | 27,900,788 回/s | 85.21 MiB | 28.24 KiB | ±7.1% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 1.185 µs | 843,649 回/s | 107.35 MiB | 23.88 KiB | ±0.6% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 56.9 ns | 17,583,508 回/s | 87.09 MiB | 27.75 KiB | ±2.4% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 39.6 ns | 25,228,230 回/s | 90.82 MiB | 27.73 KiB | ±1.2% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 47.8 ns | 20,941,102 回/s | 84.08 MiB | 27.25 KiB | ±1.0% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 161.5 ns | 6,199,732 回/s | 95.85 MiB | 21.13 KiB | ±4.0% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 284.7 ns | 3,519,305 回/s | 138.02 MiB | 22.70 KiB | ±4.4% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 5.7 ns | 178,767,528 回/s | 82.15 MiB | 26.83 KiB | ±15.7% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 2.080 µs | 480,758 回/s | 92.84 MiB | 23.67 KiB | ±1.1% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 31.4 ns | 31,909,396 回/s | 90.21 MiB | 18.56 KiB | ±2.4% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 217.1 ns | 4,608,847 回/s | 92.47 MiB | 22.80 KiB | ±2.5% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 37.06 µs | 26,984 回/s | 102.43 MiB | 21.37 KiB | ±0.6% |
| 返信参照を抽出する<br><code>reply-reference</code> | 31.7 ns | 33,264,514 回/s | 91.74 MiB | 23.78 KiB | ±25.0% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 39.9 ns | 25,082,207 回/s | 101.94 MiB | 29.76 KiB | ±3.1% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.2 ns | 240,651,988 回/s | 81.74 MiB | 26.17 KiB | ±2.1% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 36.1 ns | 27,736,712 回/s | 89.22 MiB | 28.94 KiB | ±2.3% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 19.3 ns | 51,768,141 回/s | 81.64 MiB | 27.37 KiB | ±0.6% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 14.8 ns | 67,418,227 回/s | 80.93 MiB | 27.20 KiB | ±1.2% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 82.6 ns | 12,116,102 回/s | 81.10 MiB | 27.74 KiB | ±1.7% |
| Mini App バックエンド：二層認証を検証し管理対象グループ状態一覧を集計する<br><code>mini-app-status-route</code> | 7.186 µs | 139,171 回/s | 93.10 MiB | 22.94 KiB | ±0.6% |
| Mini App フロントエンド：ステータス比較・指標整形・FLIP/スプリング補間を計算する<br><code>mini-app-frontend-render</code> | 475.7 ns | 2,102,363 回/s | 102.38 MiB | 34.38 KiB | ±0.5% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。cron 音声の行も音声合成モデルと Telegram を固定応答（約 11 秒の WAV）に置き換え、Base64 デコード、WAV 解析、Opus エンコードと送信境界を含む。本番では合成は AI Worker 上で動くが、この行は同一プロセス内で両側をつなぎ、スレッド間の受け渡しは含まない。cron.json の行は途中変更の費用だけを測り、タスクは実行しない。タスク表は本番の上限（128 タスク、各 16 アクション、ローカルソースはデータルート相対）とし、1 タスクを変更するたびに本番と同じ順序でホットリロード対象の 6 ファイルを読み取って厳密に解析し（ローカルソースを 1 件ずつ確認）、スナップショットを置き換えてタスク名でスケジューラを突き合わせる。書き換えと保存はデプロイ側の作業なので計測せず、ファイル監視のデバウンス待ち、その後の広告検出と AI チャットの可用性の再判定、ホットリロードのログも含まない。Mini App API リクエストの行は `Bun.serve` ルートハンドラ入口から認証ミドルウェアチェーン（ヘッダーガード、Telegram WebApp `initData` の HMAC-SHA256 署名と特権管理者チェック、45 分パスワードセッション延長）、管理対象グループ状態および Q&A・ホットメッセージ件数の集計、実際の Disk I/O Worker 経由での過去 24 時間参加ログ取得と 1～24 時間スライディングウィンドウ集計、および HTTP JSON レスポンスの直列化と解析までを通しで実行し、管理 API の典型的な単一プロセス RPS を計測する。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 835 回/s | 1.20 ms | 1.10 ms | 1.72 ms | 10.17 ms | 835 レコード/s | 3.91 MiB | ±4.4% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 333 回/s | 3.00 ms | 2.78 ms | 5.45 ms | 19.18 ms | 42,680 レコード/s | 21.42 MiB | ±4.5% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 658 回/s | 1.53 ms | 1.28 ms | 2.69 ms | 8.62 ms | 658 レコード/s | 3.15 MiB | ±6.7% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 663 回/s | 1.51 ms | 1.40 ms | 2.18 ms | 6.27 ms | 663 レコード/s | 3.13 MiB | ±5.7% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 681 回/s | 1.47 ms | 1.36 ms | 2.00 ms | 7.88 ms | 681 レコード/s | 3.13 MiB | ±5.8% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 345 回/s | 2.92 ms | 2.57 ms | 4.63 ms | 14.16 ms | 345 レコード/s | 5.55 MiB | ±8.4% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 783 回/s | 1.29 ms | 1.14 ms | 1.91 ms | 8.66 ms | 783 レコード/s | 4.16 MiB | ±9.4% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 552 回/s | 1.81 ms | 1.70 ms | 2.30 ms | 6.49 ms | 552 レコード/s | 1.82 MiB | ±2.4% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 4,578 回/s | 215.9 µs | 186.7 µs | 402.1 µs | 550.8 µs | 4,578 レコード/s | 0 B | ±1.0% |
| cron send_voice：音声 1 件を合成・エンコードして送信する（通信を除く）<br><code>cron-send-voice</code> | 5 回/s | 212.2 ms | 211.7 ms | 219.8 ms | 222.2 ms | 5 レコード/s | 0 B | ±1.7% |
| cron.json のタスク 1 件を途中変更：ホットリロードと再スケジュール（上限規模のタスク表）<br><code>cron-config-reload</code> | 8 回/s | 127.7 ms | 127.1 ms | 140.2 ms | 146.4 ms | 8 レコード/s | 7.31 MiB | ±1.3% |
| Mini App API リクエスト：認証ミドルウェア・グループ詳細集計・参加ログ 24h クエリ（GET /api/chats/:chatId）<br><code>mini-app-api-request</code> | 6,491 回/s | 155.1 µs | 130.5 µs | 225.3 µs | 2.29 ms | 6,491 レコード/s | 0 B | ±10.4% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 40,890,946 回/s | 195.7 ns | 0 B | 11.39 KiB | ±1.6% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 45,662 回/s | 2.80 ms | 56.55 MiB | 23.64 KiB | ±1.0% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 380,347 回/s | 21.03 µs | 5.30 MiB | 5.35 KiB | ±0.8% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 13,328 回/s | 600.3 µs | 34.02 MiB | 186.13 KiB | ±1.1% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 62,699 回/s | 2.05 ms | 73.15 MiB | 128.85 KiB | ±4.9% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 18,519 回/s | 6.91 ms | 12.60 MiB | 421.74 KiB | ±1.8% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 17.3 ns | 57,711,784 回/s | 91.58 MiB | 22.52 KiB | ±3.3% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 33.3 ns | 30,801,619 回/s | 83.76 MiB | 27.59 KiB | ±15.1% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 19.5 ns | 51,325,122 回/s | 92.14 MiB | 28.22 KiB | ±5.5% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 195.1 ms | 2.80 MiB | 6.52 KiB | ±1.4% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 3.63 ms | 0 B | -4.76 KiB | ±2.6% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：09 コマンドと挙動リファレンス](09-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#10-パフォーマンスベンチマーク) · [次のページ：11 Mini App の設定方法と推奨構成 →](11-mini-app.md)

</div>

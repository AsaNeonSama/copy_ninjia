# 10 パフォーマンスベンチマーク

<p align="center">
  <a href="../cn/10-performance.md">简体中文</a> · <a href="../en/10-performance.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 ドキュメントホーム</a> · <a href="09-commands.md">← 前のページ：09 コマンドと挙動リファレンス</a> · <a href="11-faq.md">次のページ：11 よくある質問 →</a>
</p>

---

本ページの計測値は `bun run perf:full -- --write-doc` によって自動生成され、リリースごとに一括更新されます。
**下の 2 つのマーカーに挟まれた内容は手動で編集しないでください**。リリーススクリプトによって 3 言語のドキュメントが同一バッチで同期されます。

ベンチマークを実行すると、**構造化レポート全文**（実行環境、テストセクション、各項目の平均時間と変動係数）がリポジトリルートの `performance-result.json` 内 `fullSuite.lastRun` に書き込まれます。本ページのテーブルと JSON レポートは、単一の `--write-doc` スイッチによってアトミックに出力されます。

全量ベンチマークスイートはリリース時および明示的な指示があった場合のみ実行され、日常的な `bun run check` 門禁には含まれません。本番ホットパスの GC/RSS/JIT ハードゲートは `bun run perf:hot-path-gate` が独立して担当します（詳細は [05 開発フローと品質ゲート](05-dev-workflow.md) を参照）。

個別シナリオおよび `bun run perf:disk-transport` の実行手順・測定境界については、[05 開発フロー](05-dev-workflow.md#個別シナリオと伝送ストレス検証) を参照してください。個別検証の出力とホットパス門禁の結果は個別に記録され、以下の全量ベンチマーク生成ブロックを上書きすることはありません。

<!-- performance-benchmark:start -->

**直近の全量ベンチマーク** · Bun 1.4.3 · 3 ラウンドの平均 · 2026-10-11T14:15:36Z · プロセス起動からローカル復元完了まで 359.9 ms · グループメッセージ 1 件を基本ディスパッチする 153.1 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 199.8 µs / 4,292 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 1.82 ms / 502 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.3 (`c6da4a4d3010e5553438c60f6bd76d981976867c`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-10-11T14:15:36Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,453 |
| プロセス読み込み | 182.35 MiB |
| プロセス書き込み | 185.47 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 234.66 MiB |
| 読み込みシステムコール | 53,002 |
| 書き込みシステムコール | 243,768 |
| モックルート使用量 | 14.49 MiB |
| モックルートファイル数 | 103 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 100.8 ms | ±1.9% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 11.16 ms | ±7.4% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 623.3 µs | ±5.0% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.12 ms | ±3.4% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 4.49 ms | ±1.0% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 707.6 µs | ±1.1% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 228.0 ms | ±2.0% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 285.6 µs | ±6.3% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 359.9 ms | ±1.3% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 115.26 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 153.1 ns | 6,533,621 回/s | 91.60 MiB | 17.84 KiB | ±1.9% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 95.7 ns | 10,472,785 回/s | 89.89 MiB | 20.28 KiB | ±5.0% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 10.4 ns | 334,327,222 回/s | 77.87 MiB | 24.57 KiB | ±62.9% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 27.6 ns | 36,223,891 回/s | 78.11 MiB | 23.33 KiB | ±3.0% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 31.7 ns | 31,556,947 回/s | 79.33 MiB | 24.96 KiB | ±0.6% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.8 ns | 1,180,465,175 回/s | 76.56 MiB | 24.62 KiB | ±0.7% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 47.6 ns | 21,045,345 回/s | 78.86 MiB | 23.58 KiB | ±4.4% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 3.7 ns | 267,324,596 回/s | 76.64 MiB | 24.55 KiB | ±0.1% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 10.2 ns | 98,545,039 回/s | 77.20 MiB | 23.93 KiB | ±3.8% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 39.7 ns | 25,354,553 回/s | 81.01 MiB | 23.56 KiB | ±8.6% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 1.202 µs | 833,912 回/s | 100.27 MiB | 23.75 KiB | ±5.3% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 88.1 ns | 11,353,487 回/s | 85.91 MiB | 25.74 KiB | ±0.2% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 40.8 ns | 24,533,970 回/s | 85.97 MiB | 23.92 KiB | ±2.8% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 48.9 ns | 20,465,854 回/s | 79.85 MiB | 23.83 KiB | ±2.9% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 275.8 ns | 3,635,196 回/s | 124.25 MiB | 5.64 MiB | ±5.3% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 299.7 ns | 3,337,477 回/s | 129.54 MiB | 20.31 KiB | ±1.4% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.2 ns | 237,710,144 回/s | 77.39 MiB | 23.57 KiB | ±1.0% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 2.136 µs | 468,301 回/s | 85.58 MiB | 22.23 KiB | ±1.3% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 32.6 ns | 30,677,449 回/s | 85.93 MiB | 20.67 KiB | ±2.3% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 286.6 ns | 3,488,783 回/s | 86.38 MiB | 21.77 KiB | ±0.3% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 43.16 µs | 23,378 回/s | 96.47 MiB | 20.99 KiB | ±9.8% |
| 返信参照を抽出する<br><code>reply-reference</code> | 30.5 ns | 32,869,681 回/s | 88.84 MiB | 22.00 KiB | ±4.2% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 46.9 ns | 21,982,076 回/s | 95.63 MiB | 24.08 KiB | ±16.6% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.0 ns | 253,172,008 回/s | 77.28 MiB | 24.25 KiB | ±1.2% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 38.7 ns | 25,913,987 回/s | 84.09 MiB | 23.24 KiB | ±6.0% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 20.9 ns | 47,914,946 回/s | 76.82 MiB | 24.18 KiB | ±3.8% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 15.3 ns | 65,543,615 回/s | 77.00 MiB | 24.27 KiB | ±2.3% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 86.1 ns | 11,631,398 回/s | 76.90 MiB | 23.18 KiB | ±3.4% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。cron 音声の行も音声合成モデルと Telegram を固定応答（約 11 秒の WAV）に置き換え、Base64 デコード、WAV 解析、Opus エンコードと送信境界を含む。本番では合成は AI Worker 上で動くが、この行は同一プロセス内で両側をつなぎ、スレッド間の受け渡しは含まない。cron.json の行は途中変更の費用だけを測り、タスクは実行しない。タスク表は本番の上限（128 タスク、各 16 アクション、ローカルソースはデータルート相対）とし、1 タスクを変更するたびに本番と同じ順序でホットリロード対象の 6 ファイルを読み取って厳密に解析し（ローカルソースを 1 件ずつ確認）、スナップショットを置き換えてタスク名でスケジューラを突き合わせる。書き換えと保存はデプロイ側の作業なので計測せず、ファイル監視のデバウンス待ち、その後の広告検出と AI チャットの可用性の再判定、ホットリロードのログも含まない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 1,009 回/s | 991.0 µs | 908.6 µs | 1.33 ms | 6.58 ms | 1,009 レコード/s | 3.91 MiB | ±2.0% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 334 回/s | 3.00 ms | 2.92 ms | 5.27 ms | 12.34 ms | 42,711 レコード/s | 21.42 MiB | ±2.8% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 838 回/s | 1.19 ms | 1.13 ms | 1.55 ms | 4.86 ms | 838 レコード/s | 3.15 MiB | ±3.6% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 744 回/s | 1.35 ms | 1.26 ms | 1.79 ms | 5.32 ms | 744 レコード/s | 3.13 MiB | ±2.8% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 723 回/s | 1.38 ms | 1.31 ms | 1.78 ms | 4.47 ms | 723 レコード/s | 3.13 MiB | ±3.7% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 379 回/s | 2.64 ms | 2.44 ms | 3.78 ms | 10.09 ms | 379 レコード/s | 5.55 MiB | ±1.7% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 871 回/s | 1.15 ms | 1.05 ms | 1.56 ms | 13.74 ms | 871 レコード/s | 4.16 MiB | ±2.2% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 502 回/s | 2.00 ms | 1.82 ms | 2.93 ms | 7.29 ms | 502 レコード/s | 1.20 MiB | ±5.7% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 4,292 回/s | 230.6 µs | 199.8 µs | 396.1 µs | 551.3 µs | 4,292 レコード/s | 0 B | ±2.7% |
| cron send_voice：音声 1 件を合成・エンコードして送信する（通信を除く）<br><code>cron-send-voice</code> | 5 回/s | 219.2 ms | 218.1 ms | 224.6 ms | 228.5 ms | 5 レコード/s | 0 B | ±2.6% |
| cron.json のタスク 1 件を途中変更：ホットリロードと再スケジュール（上限規模のタスク表）<br><code>cron-config-reload</code> | 8 回/s | 132.1 ms | 129.3 ms | 146.1 ms | 169.5 ms | 8 レコード/s | 7.31 MiB | ±1.3% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 30,584,092 回/s | 261.7 ns | 0 B | 12.33 KiB | ±1.7% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 44,670 回/s | 2.87 ms | 56.55 MiB | 21.44 KiB | ±1.3% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 71,494 回/s | 111.9 µs | 5.30 MiB | 73.86 KiB | ±1.0% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 13,283 回/s | 602.5 µs | 34.02 MiB | 245.23 KiB | ±2.1% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 59,896 回/s | 2.14 ms | 73.15 MiB | 127.14 KiB | ±3.1% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 18,229 回/s | 7.04 ms | 12.60 MiB | 424.44 KiB | ±5.0% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 17.1 ns | 58,920,768 回/s | 80.47 MiB | 21.53 KiB | ±8.8% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 36.0 ns | 27,825,019 回/s | 80.20 MiB | 25.32 KiB | ±2.1% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 19.6 ns | 51,337,369 回/s | 86.14 MiB | 27.65 KiB | ±9.5% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 119.9 ms | 1.72 MiB | 5.93 KiB | ±1.7% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 16.30 ms | 0 B | -4.74 KiB | ±2.3% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：09 コマンドと挙動リファレンス](09-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#10-パフォーマンスベンチマーク) · [次のページ：11 よくある質問 →](11-faq.md)

</div>

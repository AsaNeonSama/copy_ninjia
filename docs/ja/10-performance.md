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

**直近の全量ベンチマーク** · Bun 1.4.3 · 3 ラウンドの平均 · 2026-10-18T05:26:56Z · プロセス起動からローカル復元完了まで 384.9 ms · グループメッセージ 1 件を基本ディスパッチする 154.7 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 199.3 µs / 4,193 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 1.63 ms / 564 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.3 (`c6da4a4d3010e5553438c60f6bd76d981976867c`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-10-18T05:26:56Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,453 |
| プロセス読み込み | 182.21 MiB |
| プロセス書き込み | 186.10 MiB |
| ブロックデバイス読み込み | 208.00 KiB |
| ブロックデバイス書き込み | 235.29 MiB |
| 読み込みシステムコール | 51,931 |
| 書き込みシステムコール | 244,115 |
| モックルート使用量 | 14.52 MiB |
| モックルートファイル数 | 102 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 111.6 ms | ±2.6% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 11.52 ms | ±4.8% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 781.2 µs | ±15.6% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.34 ms | ±16.6% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 5.24 ms | ±7.7% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 695.9 µs | ±4.2% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 237.9 ms | ±1.3% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 408.2 µs | ±9.9% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 384.9 ms | ±1.8% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 114.66 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 154.7 ns | 6,482,416 回/s | 89.53 MiB | 22.04 KiB | ±5.3% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 96.6 ns | 10,360,450 回/s | 89.90 MiB | 21.29 KiB | ±3.1% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 14.9 ns | 67,772,487 回/s | 78.80 MiB | 23.51 KiB | ±9.2% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 29.8 ns | 33,569,648 回/s | 78.38 MiB | 24.73 KiB | ±3.9% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 33.2 ns | 30,234,645 回/s | 80.23 MiB | 24.33 KiB | ±5.7% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,159,844,269 回/s | 76.80 MiB | 24.52 KiB | ±0.2% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 49.3 ns | 20,364,433 回/s | 79.30 MiB | 22.81 KiB | ±5.9% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 3.7 ns | 267,329,837 回/s | 77.89 MiB | 24.04 KiB | ±0.7% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 10.2 ns | 97,942,099 回/s | 78.83 MiB | 23.00 KiB | ±1.8% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 40.8 ns | 24,660,458 回/s | 82.19 MiB | 25.04 KiB | ±8.0% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 1.343 µs | 746,146 回/s | 99.83 MiB | 23.90 KiB | ±4.2% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 61.6 ns | 16,244,229 回/s | 84.96 MiB | 26.01 KiB | ±3.0% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 39.5 ns | 25,291,003 回/s | 86.47 MiB | 24.22 KiB | ±0.7% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 50.3 ns | 19,982,486 回/s | 81.05 MiB | 24.04 KiB | ±7.7% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 289.8 ns | 3,506,573 回/s | 124.42 MiB | 5.64 MiB | ±13.1% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 326.2 ns | 3,075,310 回/s | 132.01 MiB | 20.84 KiB | ±5.6% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.4 ns | 227,212,510 回/s | 79.02 MiB | 23.48 KiB | ±2.7% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 2.251 µs | 444,795 回/s | 86.22 MiB | 22.09 KiB | ±3.3% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 32.3 ns | 30,992,247 回/s | 87.44 MiB | 22.06 KiB | ±2.3% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 256.1 ns | 3,906,660 回/s | 88.00 MiB | 22.50 KiB | ±2.2% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 41.48 µs | 24,108 回/s | 97.43 MiB | 21.91 KiB | ±0.2% |
| 返信参照を抽出する<br><code>reply-reference</code> | 30.6 ns | 32,690,553 回/s | 90.35 MiB | 22.43 KiB | ±1.5% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 51.7 ns | 19,370,749 回/s | 97.56 MiB | 24.38 KiB | ±2.8% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 6.1 ns | 194,749,580 回/s | 78.52 MiB | 24.71 KiB | ±45.2% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 37.3 ns | 26,823,455 回/s | 84.69 MiB | 23.84 KiB | ±3.5% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 20.6 ns | 48,468,748 回/s | 78.32 MiB | 24.61 KiB | ±1.8% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 14.9 ns | 67,188,959 回/s | 77.81 MiB | 24.87 KiB | ±0.3% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 83.6 ns | 11,988,854 回/s | 77.48 MiB | 23.15 KiB | ±5.4% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。cron 音声の行も音声合成モデルと Telegram を固定応答（約 11 秒の WAV）に置き換え、Base64 デコード、WAV 解析、Opus エンコードと送信境界を含む。本番では合成は AI Worker 上で動くが、この行は同一プロセス内で両側をつなぎ、スレッド間の受け渡しは含まない。cron.json の行は途中変更の費用だけを測り、タスクは実行しない。タスク表は本番の上限（128 タスク、各 16 アクション、ローカルソースはデータルート相対）とし、1 タスクを変更するたびに本番と同じ順序でホットリロード対象の 6 ファイルを読み取って厳密に解析し（ローカルソースを 1 件ずつ確認）、スナップショットを置き換えてタスク名でスケジューラを突き合わせる。書き換えと保存はデプロイ側の作業なので計測せず、ファイル監視のデバウンス待ち、その後の広告検出と AI チャットの可用性の再判定、ホットリロードのログも含まない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 864 回/s | 1.16 ms | 1.04 ms | 1.54 ms | 9.06 ms | 864 レコード/s | 3.91 MiB | ±2.0% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 324 回/s | 3.08 ms | 2.99 ms | 5.26 ms | 12.54 ms | 41,499 レコード/s | 21.42 MiB | ±1.1% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 797 回/s | 1.26 ms | 1.15 ms | 1.66 ms | 7.83 ms | 797 レコード/s | 3.15 MiB | ±4.5% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 725 回/s | 1.38 ms | 1.23 ms | 1.97 ms | 9.80 ms | 725 レコード/s | 3.13 MiB | ±5.3% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 674 回/s | 1.48 ms | 1.33 ms | 2.22 ms | 7.90 ms | 674 レコード/s | 3.13 MiB | ±3.7% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 358 回/s | 2.80 ms | 2.52 ms | 4.30 ms | 14.39 ms | 358 レコード/s | 5.55 MiB | ±2.0% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 852 回/s | 1.17 ms | 1.09 ms | 1.56 ms | 7.41 ms | 852 レコード/s | 4.16 MiB | ±2.7% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 564 回/s | 1.78 ms | 1.63 ms | 2.32 ms | 8.74 ms | 564 レコード/s | 1.82 MiB | ±5.6% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 4,193 回/s | 236.0 µs | 199.3 µs | 399.8 µs | 798.9 µs | 4,193 レコード/s | 0 B | ±2.0% |
| cron send_voice：音声 1 件を合成・エンコードして送信する（通信を除く）<br><code>cron-send-voice</code> | 4 回/s | 222.8 ms | 222.4 ms | 230.0 ms | 234.2 ms | 4 レコード/s | 0 B | ±3.1% |
| cron.json のタスク 1 件を途中変更：ホットリロードと再スケジュール（上限規模のタスク表）<br><code>cron-config-reload</code> | 7 回/s | 135.8 ms | 133.6 ms | 147.2 ms | 156.1 ms | 7 レコード/s | 7.31 MiB | ±0.8% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 38,340,838 回/s | 208.7 ns | 0 B | 10.89 KiB | ±1.9% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 42,537 回/s | 3.02 ms | 56.55 MiB | 24.72 KiB | ±5.4% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 288,691 回/s | 27.73 µs | 5.30 MiB | 10.22 KiB | ±2.4% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 9,369 回/s | 857.5 µs | 34.02 MiB | 176.43 KiB | ±6.4% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 65,641 回/s | 1.95 ms | 73.15 MiB | 126.62 KiB | ±1.0% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 17,402 回/s | 7.41 ms | 12.60 MiB | 423.37 KiB | ±8.8% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 18.1 ns | 55,324,759 回/s | 83.43 MiB | 21.67 KiB | ±5.1% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 36.5 ns | 27,380,029 回/s | 80.75 MiB | 25.25 KiB | ±1.4% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 16.8 ns | 59,402,928 回/s | 86.36 MiB | 27.50 KiB | ±2.0% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 125.9 ms | 2.04 MiB | 6.58 KiB | ±1.4% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 18.09 ms | 0 B | -4.74 KiB | ±11.7% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：09 コマンドと挙動リファレンス](09-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#10-パフォーマンスベンチマーク) · [次のページ：11 よくある質問 →](11-faq.md)

</div>

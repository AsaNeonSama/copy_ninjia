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

**直近の全量ベンチマーク** · Bun 1.4.4 · 3 ラウンドの平均 · 2026-10-24T09:13:19Z · プロセス起動からローカル復元完了まで 366.5 ms · グループメッセージ 1 件を基本ディスパッチする 107.0 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 190.9 µs / 3,789 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 1.69 ms / 547 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.4 (`38afee6c84fcf48c0edb2466aa4b27d287a59c30`) |
| カーネル | linux 6.8.0-31-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-10-24T09:13:19Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 392,931,453 |
| プロセス読み込み | 182.55 MiB |
| プロセス書き込み | 186.10 MiB |
| ブロックデバイス読み込み | 1.33 KiB |
| ブロックデバイス書き込み | 235.29 MiB |
| 読み込みシステムコール | 48,772 |
| 書き込みシステムコール | 244,144 |
| モックルート使用量 | 14.52 MiB |
| モックルートファイル数 | 102 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 102.7 ms | ±1.7% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 11.77 ms | ±7.6% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 631.2 µs | ±8.6% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.04 ms | ±1.7% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 4.58 ms | ±3.6% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 688.1 µs | ±0.8% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 231.9 ms | ±15.3% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 345.9 µs | ±8.0% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 366.5 ms | ±9.4% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 116.37 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 107.0 ns | 9,344,601 回/s | 89.10 MiB | 22.07 KiB | ±1.7% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 72.9 ns | 13,719,750 回/s | 91.13 MiB | 21.67 KiB | ±1.3% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 1.2 ns | 868,536,839 回/s | 80.05 MiB | 27.63 KiB | ±4.0% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 13.0 ns | 77,271,448 回/s | 79.64 MiB | 27.97 KiB | ±3.4% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 30.8 ns | 32,507,306 回/s | 82.14 MiB | 28.69 KiB | ±0.7% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,175,891,135 回/s | 78.88 MiB | 27.05 KiB | ±0.8% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 43.7 ns | 22,967,674 回/s | 80.07 MiB | 28.07 KiB | ±5.4% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.1 ns | 244,119,560 回/s | 79.19 MiB | 27.38 KiB | ±2.4% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 9.7 ns | 103,379,685 回/s | 79.82 MiB | 27.98 KiB | ±5.5% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 37.1 ns | 27,214,394 回/s | 83.47 MiB | 27.84 KiB | ±9.7% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 1.193 µs | 838,212 回/s | 103.21 MiB | 23.26 KiB | ±1.6% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 57.9 ns | 17,286,572 回/s | 85.80 MiB | 26.50 KiB | ±1.1% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 38.1 ns | 26,306,921 回/s | 88.49 MiB | 28.55 KiB | ±3.3% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 47.0 ns | 21,293,036 回/s | 82.18 MiB | 28.12 KiB | ±1.7% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 160.3 ns | 6,243,885 回/s | 94.36 MiB | 19.88 KiB | ±2.7% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 303.4 ns | 3,299,425 回/s | 137.67 MiB | 21.95 KiB | ±3.3% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 5.0 ns | 199,266,144 回/s | 80.08 MiB | 26.97 KiB | ±1.2% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 2.125 µs | 470,573 回/s | 89.02 MiB | 23.15 KiB | ±1.1% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 31.1 ns | 32,173,408 回/s | 87.90 MiB | 23.93 KiB | ±2.1% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 227.2 ns | 4,404,603 回/s | 89.61 MiB | 22.71 KiB | ±2.5% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 37.95 µs | 26,359 回/s | 100.89 MiB | 22.75 KiB | ±1.4% |
| 返信参照を抽出する<br><code>reply-reference</code> | 29.2 ns | 35,001,604 回/s | 89.26 MiB | 22.08 KiB | ±14.9% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 40.1 ns | 24,938,163 回/s | 99.49 MiB | 29.14 KiB | ±1.8% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.1 ns | 243,425,834 回/s | 80.24 MiB | 27.23 KiB | ±3.9% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 38.3 ns | 26,123,139 回/s | 86.24 MiB | 28.61 KiB | ±1.2% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 19.6 ns | 51,092,220 回/s | 79.94 MiB | 27.82 KiB | ±1.0% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 14.8 ns | 67,629,150 回/s | 78.76 MiB | 27.44 KiB | ±1.7% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 83.9 ns | 11,917,693 回/s | 78.67 MiB | 28.03 KiB | ±0.8% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。cron 音声の行も音声合成モデルと Telegram を固定応答（約 11 秒の WAV）に置き換え、Base64 デコード、WAV 解析、Opus エンコードと送信境界を含む。本番では合成は AI Worker 上で動くが、この行は同一プロセス内で両側をつなぎ、スレッド間の受け渡しは含まない。cron.json の行は途中変更の費用だけを測り、タスクは実行しない。タスク表は本番の上限（128 タスク、各 16 アクション、ローカルソースはデータルート相対）とし、1 タスクを変更するたびに本番と同じ順序でホットリロード対象の 6 ファイルを読み取って厳密に解析し（ローカルソースを 1 件ずつ確認）、スナップショットを置き換えてタスク名でスケジューラを突き合わせる。書き換えと保存はデプロイ側の作業なので計測せず、ファイル監視のデバウンス待ち、その後の広告検出と AI チャットの可用性の再判定、ホットリロードのログも含まない。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 836 回/s | 1.20 ms | 1.06 ms | 1.81 ms | 9.72 ms | 836 レコード/s | 3.91 MiB | ±5.2% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 344 回/s | 2.91 ms | 2.78 ms | 4.57 ms | 12.29 ms | 44,009 レコード/s | 21.42 MiB | ±0.3% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 745 回/s | 1.35 ms | 1.23 ms | 1.87 ms | 7.33 ms | 745 レコード/s | 3.15 MiB | ±6.7% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 708 回/s | 1.41 ms | 1.26 ms | 2.45 ms | 6.06 ms | 708 レコード/s | 3.13 MiB | ±5.3% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 752 回/s | 1.33 ms | 1.27 ms | 1.80 ms | 3.20 ms | 752 レコード/s | 3.13 MiB | ±4.5% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 373 回/s | 2.68 ms | 2.49 ms | 3.79 ms | 11.14 ms | 373 レコード/s | 5.55 MiB | ±1.7% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 829 回/s | 1.21 ms | 1.10 ms | 1.71 ms | 7.64 ms | 829 レコード/s | 4.16 MiB | ±6.2% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 547 回/s | 1.83 ms | 1.69 ms | 2.44 ms | 7.19 ms | 547 レコード/s | 1.82 MiB | ±3.0% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 3,789 回/s | 294.2 µs | 190.9 µs | 850.3 µs | 1.83 ms | 3,789 レコード/s | 0 B | ±29.6% |
| cron send_voice：音声 1 件を合成・エンコードして送信する（通信を除く）<br><code>cron-send-voice</code> | 5 回/s | 211.5 ms | 210.8 ms | 218.3 ms | 223.6 ms | 5 レコード/s | 0 B | ±0.5% |
| cron.json のタスク 1 件を途中変更：ホットリロードと再スケジュール（上限規模のタスク表）<br><code>cron-config-reload</code> | 8 回/s | 129.8 ms | 127.6 ms | 145.0 ms | 159.5 ms | 8 レコード/s | 7.31 MiB | ±0.2% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 40,019,871 回/s | 200.0 ns | 0 B | 11.83 KiB | ±1.7% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 45,952 回/s | 2.79 ms | 56.55 MiB | 24.52 KiB | ±2.0% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 375,519 回/s | 21.31 µs | 5.30 MiB | -2.44 KiB | ±2.2% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 13,176 回/s | 607.3 µs | 34.02 MiB | 178.09 KiB | ±1.4% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 62,511 回/s | 2.05 ms | 73.15 MiB | 128.69 KiB | ±3.2% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 20,597 回/s | 6.22 ms | 12.60 MiB | 420.96 KiB | ±1.3% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 17.0 ns | 59,679,554 回/s | 89.98 MiB | 22.37 KiB | ±11.1% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 27.8 ns | 35,982,616 回/s | 82.33 MiB | 28.09 KiB | ±4.3% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 18.2 ns | 55,066,834 回/s | 90.92 MiB | 27.99 KiB | ±5.5% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 192.6 ms | 2.52 MiB | 6.59 KiB | ±0.6% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 3.58 ms | 0 B | -4.76 KiB | ±0.7% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：09 コマンドと挙動リファレンス](09-commands.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#10-パフォーマンスベンチマーク) · [次のページ：11 よくある質問 →](11-faq.md)

</div>

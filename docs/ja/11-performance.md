# 11 パフォーマンスベンチマーク

<p align="center">
  <a href="../cn/11-performance.md">简体中文</a> · <a href="../en/11-performance.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 ドキュメントホーム</a> · <a href="10-mini-app.md">← 前のページ：10 Mini App の設定方法と推奨構成</a> · <a href="12-faq.md">次のページ：12 よくある質問 →</a>
</p>

---

本ページの計測値は `bun run perf:full -- --write-doc` によって自動生成され、リリースごとにブロック全体が一括更新されます。
**下の 2 つのマーカーに挟まれた領域は手動で編集しないでください**（3 言語のドキュメントがスクリプトで同時に同期されます）。

- **構造化 JSON レポートの同時出力**：`--write-doc` を付けて実行すると、本ページのベンチマークブロックと同一実行の**構造化レポート全文**（ハードウェア環境、セクション構成、項目別の平均所要時間と変動係数）が、リポジトリルートの `performance-result.json` 内 `fullSuite.lastRun` にアトミックに書き出されます。
- **リリース計測と日常品質ゲートの分離**：全量ベンチマークはリリース時または明示的な指示があった場合のみ実行され、通常の `bun run check` 品質ゲートには含まれません。本番ホットパスの GC・RSS・JIT ハードゲートは `bun run perf:hot-path-gate` が独立して検査します（詳細は [05 開発フローと品質ゲート](05-dev-workflow.md) を参照）。
- **個別シナリオ検証**：個別シナリオおよび `bun run perf:disk-transport` の測定境界と再現手順は [05 開発フロー](05-dev-workflow.md#個別シナリオと伝送ストレス検証) を参照してください。個別検証やホットパスゲートの結果が下の全量ベンチマークブロックを上書きすることはありません。

<!-- performance-benchmark:start -->

**直近の全量ベンチマーク** · Bun 1.4.4 · 3 ラウンドの平均 · 2026-11-15T09:55:28Z · プロセス起動からローカル復元完了まで 405.6 ms · グループメッセージ 1 件を基本ディスパッチする 106.2 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 200.5 µs / 4,411 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 1.77 ms / 497 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.4 (`38afee6c84fcf48c0edb2466aa4b27d287a59c30`) |
| カーネル | linux 6.8.0-149-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-11-15T09:55:28Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 394,548,253 |
| プロセス読み込み | 183.35 MiB |
| プロセス書き込み | 186.14 MiB |
| ブロックデバイス読み込み | 85.33 KiB |
| ブロックデバイス書き込み | 235.36 MiB |
| 読み込みシステムコール | 49,986 |
| 書き込みシステムコール | 245,843 |
| モックルート使用量 | 14.84 MiB |
| モックルートファイル数 | 142 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 118.3 ms | ±2.3% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 13.04 ms | ±11.8% |
| 中断された原子的書き込みの一時ファイルを削除する<br><code>orphan-cleanup</code> | 676.7 µs | ±2.9% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.31 ms | ±2.9% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 4.76 ms | ±2.8% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 666.1 µs | ±3.4% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 253.3 ms | ±12.0% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 340.1 µs | ±3.5% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 405.6 ms | ±8.1% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 115.79 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 106.2 ns | 9,427,994 回/s | 91.80 MiB | 18.25 KiB | ±4.1% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 71.7 ns | 13,949,425 回/s | 93.88 MiB | 22.01 KiB | ±2.2% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 1.1 ns | 873,899,875 回/s | 81.57 MiB | 27.56 KiB | ±1.7% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 13.1 ns | 76,513,877 回/s | 81.38 MiB | 28.86 KiB | ±1.7% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 31.8 ns | 31,462,166 回/s | 82.79 MiB | 28.92 KiB | ±1.5% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.9 ns | 1,163,854,203 回/s | 79.50 MiB | 28.26 KiB | ±2.4% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 42.8 ns | 23,488,122 回/s | 81.82 MiB | 28.63 KiB | ±7.4% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.1 ns | 241,319,549 回/s | 80.15 MiB | 28.00 KiB | ±1.0% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 9.5 ns | 105,303,832 回/s | 81.40 MiB | 28.63 KiB | ±1.0% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 36.3 ns | 27,747,215 回/s | 83.82 MiB | 28.19 KiB | ±8.9% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 1.138 µs | 879,656 回/s | 105.72 MiB | 23.83 KiB | ±3.0% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 58.3 ns | 17,159,299 回/s | 87.05 MiB | 27.78 KiB | ±2.1% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 42.0 ns | 23,809,645 回/s | 90.62 MiB | 27.66 KiB | ±0.5% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 47.5 ns | 21,039,740 回/s | 83.12 MiB | 28.67 KiB | ±1.2% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 157.7 ns | 6,348,692 回/s | 96.24 MiB | 19.63 KiB | ±3.7% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 285.3 ns | 3,506,817 回/s | 136.46 MiB | 22.15 KiB | ±1.9% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.7 ns | 212,654,995 回/s | 81.70 MiB | 26.80 KiB | ±5.5% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 2.472 µs | 404,582 回/s | 91.68 MiB | 23.41 KiB | ±1.4% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 31.4 ns | 31,897,789 回/s | 90.41 MiB | 19.12 KiB | ±1.1% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 221.1 ns | 4,526,511 回/s | 92.00 MiB | 21.86 KiB | ±2.6% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 37.57 µs | 26,622 回/s | 102.34 MiB | 23.10 KiB | ±1.0% |
| 返信参照を抽出する<br><code>reply-reference</code> | 32.0 ns | 33,702,636 回/s | 90.81 MiB | 23.66 KiB | ±29.6% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 44.0 ns | 22,780,000 回/s | 100.90 MiB | 29.67 KiB | ±5.2% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.3 ns | 234,225,582 回/s | 80.61 MiB | 26.89 KiB | ±6.1% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 37.2 ns | 26,907,635 回/s | 87.95 MiB | 29.38 KiB | ±2.9% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 19.9 ns | 50,387,087 回/s | 80.63 MiB | 26.71 KiB | ±2.6% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 15.0 ns | 66,465,873 回/s | 79.85 MiB | 27.09 KiB | ±1.2% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 84.6 ns | 11,822,016 回/s | 79.97 MiB | 28.52 KiB | ±2.0% |
| Mini App バックエンド：二層認証を検証し管理対象グループ状態一覧を集計する<br><code>mini-app-status-route</code> | 7.933 µs | 126,103 回/s | 92.28 MiB | 25.79 KiB | ±1.9% |
| Mini App フロントエンド：ステータス比較・指標整形・FLIP/スプリング補間を計算する<br><code>mini-app-frontend-render</code> | 533.8 ns | 1,873,471 回/s | 100.55 MiB | 34.63 KiB | ±0.9% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。cron 音声の行も音声合成モデルと Telegram を固定応答（約 11 秒の WAV）に置き換え、Base64 デコード、WAV 解析、Opus エンコードと送信境界を含む。本番では合成は AI Worker 上で動くが、この行は同一プロセス内で両側をつなぎ、スレッド間の受け渡しは含まない。cron.json の行は途中変更の費用だけを測り、タスクは実行しない。タスク表は本番の上限（128 タスク、各 16 アクション、ローカルソースはデータルート相対）とし、1 タスクを変更するたびに本番と同じ順序でホットリロード対象の 6 ファイルを読み取って厳密に解析し（ローカルソースを 1 件ずつ確認）、スナップショットを置き換えてタスク名でスケジューラを突き合わせる。書き換えと保存はデプロイ側の作業なので計測せず、ファイル監視のデバウンス待ち、その後の広告検出と AI チャットの可用性の再判定、ホットリロードのログも含まない。Mini App の 5 行は `Bun.serve` ルートハンドラ入口からの主要経路を個別に計測する。API リクエスト行は同期認証パイプライン（ヘッダーガード、Telegram WebApp `initData` の HMAC-SHA256 署名と特権管理者チェック、45 分パスワードセッション検証）、管理対象グループ状態および Q&A・ホットメッセージ件数の集計、実際の Disk I/O Worker 経由での過去 24 時間参加ログ取得と 1～24 時間スライディングウィンドウ集計、および HTTP JSON レスポンスの直列化と解析を通しで実行する。残る 4 行は未認可拒否ページの事前分割属性注入、ページゲート Cookie 通過、ログイン検証とセッション/Cookie 発行、保護付きギャラリー画像（`?token=`）配信のローカル処理を計測する。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 849 回/s | 1.18 ms | 1.10 ms | 1.45 ms | 8.54 ms | 849 レコード/s | 3.91 MiB | ±1.2% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 332 回/s | 3.01 ms | 2.91 ms | 5.07 ms | 15.72 ms | 42,479 レコード/s | 21.42 MiB | ±1.8% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 718 回/s | 1.43 ms | 1.22 ms | 2.54 ms | 7.32 ms | 718 レコード/s | 3.15 MiB | ±15.2% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 663 回/s | 1.52 ms | 1.26 ms | 2.83 ms | 13.46 ms | 663 レコード/s | 3.13 MiB | ±10.6% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 690 回/s | 1.45 ms | 1.36 ms | 1.78 ms | 8.83 ms | 690 レコード/s | 3.13 MiB | ±3.8% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 381 回/s | 2.62 ms | 2.37 ms | 3.91 ms | 10.76 ms | 381 レコード/s | 5.55 MiB | ±1.3% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 739 回/s | 1.35 ms | 1.13 ms | 2.26 ms | 16.37 ms | 739 レコード/s | 4.16 MiB | ±3.0% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 497 回/s | 2.05 ms | 1.77 ms | 3.40 ms | 9.09 ms | 497 レコード/s | 1.82 MiB | ±12.3% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 4,411 回/s | 224.2 µs | 200.5 µs | 434.3 µs | 646.8 µs | 4,411 レコード/s | 0 B | ±0.5% |
| cron send_voice：音声 1 件を合成・エンコードして送信する（通信を除く）<br><code>cron-send-voice</code> | 5 回/s | 210.2 ms | 209.9 ms | 214.7 ms | 217.5 ms | 5 レコード/s | 0 B | ±1.1% |
| cron.json のタスク 1 件を途中変更：ホットリロードと再スケジュール（上限規模のタスク表）<br><code>cron-config-reload</code> | 9 回/s | 116.7 ms | 116.3 ms | 133.6 ms | 136.7 ms | 9 レコード/s | 7.31 MiB | ±1.5% |
| Mini App API リクエスト：同期認証パイプライン・グループ詳細集計・参加ログ 24h クエリ（GET /api/chats/:chatId）<br><code>mini-app-api-request</code> | 7,391 回/s | 135.7 µs | 116.8 µs | 218.3 µs | 1.06 ms | 7,391 レコード/s | 0 B | ±8.3% |
| Mini App 未認可拒否ページ：診断情報構築と reject.html 属性注入（serveMiniAppRejectHtml）<br><code>mini-app-reject-page</code> | 22,197 回/s | 44.84 µs | 28.52 µs | 79.08 µs | 1.23 ms | 22,197 レコード/s | 0 B | ±2.9% |
| Mini App 単一ページゲート許可：Cookie HMAC-SHA256 検証とロック検査（evaluateMiniAppPageGateRequest）<br><code>mini-app-page-gate-allow</code> | 239,538 回/s | 4.004 µs | 3.210 µs | 7.776 µs | 51.77 µs | 239,538 レコード/s | 28.00 KiB | ±2.7% |
| Mini App ログイン API：initData 検証・パスワード照合・セッションとゲート Cookie 発行（POST /api/auth/login）<br><code>mini-app-auth-login</code> | 26,498 回/s | 37.48 µs | 29.14 µs | 56.81 µs | 3.62 ms | 26,498 レコード/s | 0 B | ±3.9% |
| Mini App 保護ギャラリー画像：?token= トークン検証とキャッシュ応答読込（GET /api/gallery/file/:fileName）<br><code>mini-app-gallery-asset</code> | 13,047 回/s | 78.89 µs | 70.45 µs | 115.6 µs | 920.3 µs | 13,047 レコード/s | 0 B | ±17.7% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 40,424,637 回/s | 197.9 ns | 0 B | 12.51 KiB | ±0.9% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 44,251 回/s | 2.89 ms | 56.55 MiB | 23.15 KiB | ±1.6% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 357,277 回/s | 22.40 µs | 5.30 MiB | 17.31 KiB | ±2.2% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 10,730 回/s | 747.0 µs | 34.02 MiB | 202.35 KiB | ±4.4% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 62,366 回/s | 2.05 ms | 73.15 MiB | 129.90 KiB | ±1.4% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 18,115 回/s | 7.08 ms | 12.60 MiB | 423.72 KiB | ±3.8% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 17.0 ns | 59,027,553 回/s | 91.26 MiB | 23.09 KiB | ±3.6% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 28.6 ns | 35,157,015 回/s | 84.14 MiB | 28.74 KiB | ±7.3% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 19.1 ns | 52,390,672 回/s | 90.87 MiB | 28.98 KiB | ±1.0% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 198.2 ms | 3.21 MiB | 6.45 KiB | ±1.9% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 3.64 ms | 0 B | -4.76 KiB | ±3.0% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：10 Mini App の設定方法と推奨構成](10-mini-app.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#11-パフォーマンスベンチマーク) · [次のページ：12 よくある質問 →](12-faq.md)

</div>

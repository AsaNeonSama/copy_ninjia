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

**直近の全量ベンチマーク** · Bun 1.4.5 · 3 ラウンドの平均 · 2026-11-27T15:00:34Z · プロセス起動からローカル復元完了まで 381.3 ms · グループメッセージ 1 件を基本ディスパッチする 106.0 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 178.7 µs / 4,647 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 1.84 ms / 511 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.5 (`a7733435cf40429e3b35c36072769df2052b80f1`) |
| カーネル | linux 6.8.0-151-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-11-27T15:00:34Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 394,548,253 |
| プロセス読み込み | 184.22 MiB |
| プロセス書き込み | 186.61 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 235.68 MiB |
| 読み込みシステムコール | 50,170 |
| 書き込みシステムコール | 275,485 |
| モックルート使用量 | 15.11 MiB |
| モックルートファイル数 | 144 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 126.4 ms | ±11.8% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 12.54 ms | ±10.6% |
| 中断された原子的書き込みの一時ファイルを削除し、設定ディレクトリ構成を検査する<br><code>orphan-cleanup</code> | 1.47 ms | ±5.9% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.38 ms | ±2.2% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 5.74 ms | ±9.7% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 650.9 µs | ±6.5% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 215.1 ms | ±0.4% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 4.74 ms | ±1.0% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 381.3 ms | ±4.3% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 126.17 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 106.0 ns | 9,496,678 回/s | 103.66 MiB | 15.36 KiB | ±8.2% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 69.5 ns | 14,396,262 回/s | 104.70 MiB | 22.94 KiB | ±0.9% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 1.1 ns | 904,915,277 回/s | 92.74 MiB | 27.71 KiB | ±0.2% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 13.3 ns | 75,447,292 回/s | 92.20 MiB | 28.53 KiB | ±4.0% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 31.4 ns | 31,878,858 回/s | 93.81 MiB | 29.14 KiB | ±0.4% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.8 ns | 1,202,653,366 回/s | 90.89 MiB | 28.54 KiB | ±1.3% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 45.1 ns | 22,241,642 回/s | 92.74 MiB | 28.76 KiB | ±5.5% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.0 ns | 250,142,327 回/s | 90.84 MiB | 28.39 KiB | ±1.5% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 9.4 ns | 106,887,081 回/s | 92.01 MiB | 27.90 KiB | ±1.0% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 32.6 ns | 30,824,345 回/s | 95.59 MiB | 28.73 KiB | ±7.4% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 1.076 µs | 930,188 回/s | 116.34 MiB | 24.14 KiB | ±3.2% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 39.7 ns | 25,226,973 回/s | 97.54 MiB | 28.72 KiB | ±2.0% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 39.3 ns | 25,441,287 回/s | 100.85 MiB | 28.01 KiB | ±1.2% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 43.8 ns | 22,928,771 回/s | 94.72 MiB | 28.51 KiB | ±5.6% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 183.9 ns | 5,445,052 回/s | 103.02 MiB | 20.65 KiB | ±3.4% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 201.8 ns | 4,957,290 回/s | 144.46 MiB | 23.01 KiB | ±1.9% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.8 ns | 209,275,521 回/s | 92.74 MiB | 27.07 KiB | ±5.6% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 2.847 µs | 351,348 回/s | 101.15 MiB | 23.81 KiB | ±1.7% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 20.2 ns | 49,451,896 回/s | 102.35 MiB | 26.27 KiB | ±0.5% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 222.7 ns | 4,492,435 回/s | 101.08 MiB | 22.63 KiB | ±1.7% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 33.44 µs | 29,913 回/s | 112.95 MiB | 23.98 KiB | ±1.2% |
| 返信参照を抽出する<br><code>reply-reference</code> | 27.2 ns | 37,562,889 回/s | 102.47 MiB | 23.59 KiB | ±15.6% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 39.8 ns | 25,105,779 回/s | 113.17 MiB | 29.79 KiB | ±0.7% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.0 ns | 247,328,657 回/s | 91.90 MiB | 27.24 KiB | ±2.3% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 35.6 ns | 28,106,710 回/s | 99.05 MiB | 25.36 KiB | ±2.7% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 15.5 ns | 64,417,191 回/s | 91.86 MiB | 27.95 KiB | ±1.2% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 14.6 ns | 68,298,469 回/s | 91.53 MiB | 26.71 KiB | ±0.8% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 75.7 ns | 13,240,523 回/s | 91.19 MiB | 28.00 KiB | ±5.0% |
| Mini App バックエンド：二層認証を検証し管理対象グループ状態一覧を集計する<br><code>mini-app-status-route</code> | 7.222 µs | 138,567 回/s | 104.46 MiB | 25.81 KiB | ±2.6% |
| Mini App フロントエンド：ステータス比較・指標整形・FLIP/スプリング補間を計算する<br><code>mini-app-frontend-render</code> | 544.1 ns | 1,838,359 回/s | 112.10 MiB | 34.85 KiB | ±1.3% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。cron 音声の行も音声合成モデルと Telegram を固定応答（約 11 秒の WAV）に置き換え、Base64 デコード、WAV 解析、Opus エンコードと送信境界を含む。本番では合成は AI Worker 上で動くが、この行は同一プロセス内で両側をつなぎ、スレッド間の受け渡しは含まない。cron.json の行は途中変更の費用だけを測り、タスクは実行しない。タスク表は本番の上限（128 タスク、各 16 アクション、ローカルソースはデータルート相対）とし、1 タスクを変更するたびに本番と同じ順序でホットリロード対象の 6 ファイルを読み取って厳密に解析し（ローカルソースを 1 件ずつ確認）、スナップショットを置き換えてタスク名でスケジューラを突き合わせる。書き換えと保存はデプロイ側の作業なので計測せず、ファイル監視のデバウンス待ち、その後の広告検出と AI チャットの可用性の再判定、ホットリロードのログも含まない。Mini App の 5 行は `Bun.serve` ルートハンドラ入口からの主要経路を個別に計測する。API リクエスト行は同期認証パイプライン（ヘッダーガード、Telegram WebApp `initData` の HMAC-SHA256 署名と特権管理者チェック、45 分二次認証セッション検証）、管理対象グループ状態および Q&A・ホットメッセージ件数の集計、実際の Disk I/O Worker 経由での過去 24 時間参加ログ取得と 1～24 時間スライディングウィンドウ集計、および AES-256-GCM 暗号化封筒レスポンスの生成・復号と JSON 解析を通しで実行する。残る 4 行は未認可拒否ページの事前分割属性注入、ページゲート Cookie 通過、TLS モード事前確認の Ed25519 署名付き一時 X25519 ECDH + HKDF 暗号化ログインによる 45 分 AES-256 PSK 発行、暗号化クエリ `?e=` 付き保護ギャラリー画像配信のローカル処理を計測する。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 783 回/s | 1.28 ms | 1.19 ms | 1.79 ms | 9.07 ms | 783 レコード/s | 3.91 MiB | ±2.3% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 327 回/s | 3.06 ms | 2.85 ms | 4.93 ms | 12.78 ms | 41,805 レコード/s | 21.42 MiB | ±1.5% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 635 回/s | 1.58 ms | 1.47 ms | 2.13 ms | 7.66 ms | 635 レコード/s | 3.15 MiB | ±3.0% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 635 回/s | 1.57 ms | 1.37 ms | 2.45 ms | 9.24 ms | 635 レコード/s | 3.13 MiB | ±0.8% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 641 回/s | 1.56 ms | 1.42 ms | 2.14 ms | 7.11 ms | 641 レコード/s | 3.13 MiB | ±3.7% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 365 回/s | 2.74 ms | 2.56 ms | 3.88 ms | 11.03 ms | 365 レコード/s | 5.55 MiB | ±3.8% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 773 回/s | 1.30 ms | 1.21 ms | 1.71 ms | 16.92 ms | 773 レコード/s | 4.11 MiB | ±6.7% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 511 回/s | 1.96 ms | 1.84 ms | 2.48 ms | 7.02 ms | 511 レコード/s | 1.82 MiB | ±4.4% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 4,647 回/s | 212.6 µs | 178.7 µs | 386.3 µs | 575.1 µs | 4,647 レコード/s | 0 B | ±1.8% |
| cron send_voice：音声 1 件を合成・エンコードして送信する（通信を除く）<br><code>cron-send-voice</code> | 8 回/s | 119.2 ms | 119.0 ms | 123.6 ms | 124.9 ms | 8 レコード/s | 0 B | ±0.7% |
| cron.json のタスク 1 件を途中変更：ホットリロードと再スケジュール（上限規模のタスク表）<br><code>cron-config-reload</code> | 9 回/s | 112.2 ms | 111.8 ms | 117.2 ms | 119.6 ms | 9 レコード/s | 7.31 MiB | ±0.1% |
| Mini App API リクエスト：同期認証パイプライン・グループ詳細集計・参加ログ 24h クエリ（GET /api/chats/detail?e=...）<br><code>mini-app-api-request</code> | 2,954 回/s | 337.9 µs | 292.4 µs | 443.6 µs | 4.31 ms | 2,954 レコード/s | 1.33 KiB | ±3.2% |
| Mini App 未認可拒否ページ：診断情報構築と reject.html 属性注入（serveMiniAppRejectHtml）<br><code>mini-app-reject-page</code> | 23,095 回/s | 43.08 µs | 27.81 µs | 76.77 µs | 869.0 µs | 23,095 レコード/s | 0 B | ±3.3% |
| Mini App 単一ページゲート許可：Cookie HMAC-SHA256 検証とロック検査（evaluateMiniAppPageGateRequest）<br><code>mini-app-page-gate-allow</code> | 245,152 回/s | 3.915 µs | 3.186 µs | 7.515 µs | 51.67 µs | 245,152 レコード/s | 28.00 KiB | ±0.7% |
| Mini App ECDH ログインネゴシエーション：事前確認 Ed25519 署名付き一時 X25519 公開鍵・HKDF 鍵導出と暗号化ログインによる 45 分 AES PSK 発行（GET /api/auth/precheck → POST /api/auth/login）<br><code>mini-app-auth-login</code> | 1,407 回/s | 709.4 µs | 665.8 µs | 868.6 µs | 6.46 ms | 1,407 レコード/s | 364.00 KiB | ±0.2% |
| Mini App 保護ギャラリー画像：二層セッション・暗号化クエリ ?e= 検証とキャッシュ応答読込（GET /api/gallery/file?e=...）<br><code>mini-app-gallery-asset</code> | 5,048 回/s | 197.3 µs | 169.5 µs | 270.9 µs | 3.51 ms | 5,048 レコード/s | 0 B | ±1.3% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 41,174,407 回/s | 194.5 ns | 0 B | 9.14 KiB | ±2.9% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 41,564 回/s | 3.08 ms | 56.55 MiB | 23.27 KiB | ±1.4% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 394,301 回/s | 20.30 µs | 5.31 MiB | 33.55 KiB | ±2.2% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 10,041 回/s | 796.8 µs | 34.02 MiB | 218.02 KiB | ±0.6% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 57,394 回/s | 2.23 ms | 73.18 MiB | 166.67 KiB | ±4.7% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 16,916 回/s | 7.62 ms | 12.62 MiB | 417.94 KiB | ±7.9% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 15.3 ns | 65,984,186 回/s | 101.90 MiB | 23.22 KiB | ±9.0% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 30.9 ns | 32,915,532 回/s | 95.07 MiB | 28.34 KiB | ±13.2% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 19.3 ns | 51,887,844 回/s | 102.68 MiB | 29.04 KiB | ±1.9% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 91.94 ms | 2.96 MiB | 6.48 KiB | ±0.2% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 3.59 ms | 0 B | -5.27 KiB | ±2.9% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：10 Mini App の設定方法と推奨構成](10-mini-app.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#11-パフォーマンスベンチマーク) · [次のページ：12 よくある質問 →](12-faq.md)

</div>

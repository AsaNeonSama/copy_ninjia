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

**直近の全量ベンチマーク** · Bun 1.4.5 · 3 ラウンドの平均 · 2026-11-20T21:28:00Z · プロセス起動からローカル復元完了まで 406.8 ms · グループメッセージ 1 件を基本ディスパッチする 104.6 ns · ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く） 196.9 µs / 4,374 回/s · 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く） 1.79 ms / 457 回/s

## 実行環境

| 指標 | 計測値 |
| --- | --- |
| ランタイム | Bun 1.4.5 (`a7733435cf40429e3b35c36072769df2052b80f1`) |
| カーネル | linux 6.8.0-149-generic · x64 |
| CPU コア数 | 4 |
| メモリ | 7.76 GiB |
| ラウンド数 | 3 |
| モックデータルート | `performance/` |
| 計測日時 | 2026-11-20T21:28:00Z |

## 総スループットと総 I/O（1 ラウンドあたり）

> I/O は `/proc/self/io` から取得し、コールドスタート・チェーン・ストレージ各子プロセスの全生存期間（フィクスチャ作成を含む）を対象とする。ホットパスと容量線の子プロセスはプロセス内計算のみでファイル I/O を伴わない。「ブロックデバイス読み込み」が 0 のままなのは正常で、書き込んだ直後のフィクスチャを読むため OS のページキャッシュにすべて当たる（本ベンチマークはページキャッシュを破棄しない）。

| 指標 | 計測値 |
| --- | --- |
| 計測オペレーション数 | 394,548,253 |
| プロセス読み込み | 183.76 MiB |
| プロセス書き込み | 186.55 MiB |
| ブロックデバイス読み込み | 0 B |
| ブロックデバイス書き込み | 235.61 MiB |
| 読み込みシステムコール | 50,154 |
| 書き込みシステムコール | 275,483 |
| モックルート使用量 | 15.02 MiB |
| モックルートファイル数 | 144 |

## コールドパス · 起動リカバリ

> 満載のフィクスチャ上で実際の起動リカバリを実行し、`packages/app/lifecycle.ts` の init 順に段階ごとに計測する。`bot.init()`、コマンドメニュー登録、ブロックリスト再スキャンなどの通信を伴う処理と、2 つの業務 Worker の生成は含まない。

| 段階 | 所要時間 | 変動 |
| --- | --- | --- |
| 本番モジュールを読み込む<br><code>module-graph</code> | 128.2 ms | ±7.0% |
| データルートの単一インスタンスロックを取得する<br><code>instance-lock</code> | 12.76 ms | ±6.6% |
| 中断された原子的書き込みの一時ファイルを削除し、設定ディレクトリ構成を検査する<br><code>orphan-cleanup</code> | 1.61 ms | ±7.0% |
| 実行時状態を読み込み厳密に解析する<br><code>state-load</code> | 1.56 ms | ±15.7% |
| デプロイ設定と AI ペルソナを検証する<br><code>deployment-inputs</code> | 6.29 ms | ±7.7% |
| Disk I/O Worker を生成する<br><code>disk-io-init</code> | 707.6 µs | ±4.9% |
| SQLite とスナップショットからデータを復元する<br><code>persisted-load</code> | 236.5 ms | ±7.4% |
| メインスレッドのホットキャッシュを満たす<br><code>hydrate</code> | 4.72 ms | ±1.1% |
| プロセス起動からローカル復元完了まで<br><code>ready-total</code> | 406.8 ms | ±6.6% |

> このラウンドの復元：ホワイトリスト 8,192 件 · ブロックリスト 8,192 件 · チャット状態 25 件 · チャット Q&A 375 件 · AI メモリスナップショット 25 件、プロセスのピーク RSS 125.33 MiB。

## ホットパス · 本番関数

> シナリオごとに独立プロセスで実行し、ウォームアップ後 7 サンプルの中央値を取る。スループットはその中央値から換算。

| シナリオ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| グループメッセージ 1 件を基本ディスパッチする<br><code>incoming-message-spine</code> | 104.6 ns | 9,564,044 回/s | 98.69 MiB | 16.82 KiB | ±2.2% |
| 直接呼びかけられたメディア 1 件のトリガー文脈と記録ペイロードを構築する<br><code>ai-media-direct-trigger</code> | 70.9 ns | 14,096,612 回/s | 103.77 MiB | 22.01 KiB | ±0.7% |
| username のない送信者を解決する<br><code>sender-no-username</code> | 1.2 ns | 861,560,470 回/s | 91.61 MiB | 27.09 KiB | ±0.7% |
| username が変わらない送信者を解決する<br><code>sender-stable-username</code> | 13.2 ns | 75,622,415 回/s | 91.74 MiB | 28.09 KiB | ±3.2% |
| 同一 chat で user と channel 名義が交互に発言する際の送信者解決<br><code>sender-mixed-identity</code> | 31.4 ns | 31,883,621 回/s | 92.49 MiB | 28.47 KiB | ±1.0% |
| Bot 自身からの空メッセージを拒否する<br><code>self-sent-empty</code> | 0.8 ns | 1,185,316,424 回/s | 89.26 MiB | 27.25 KiB | ±0.9% |
| Bot が直前に送信している状態で、群メッセージが自身の折り返しかを判定する<br><code>self-sent-active</code> | 48.9 ns | 20,440,277 回/s | 91.25 MiB | 28.20 KiB | ±1.6% |
| 現在のチャット状態を直接読む<br><code>chat-state-read</code> | 4.2 ns | 238,578,437 回/s | 89.29 MiB | 27.28 KiB | ±1.7% |
| 状態 Map から 1 チャットを検索する<br><code>chat-state-map-read</code> | 9.6 ns | 103,904,739 回/s | 89.44 MiB | 27.66 KiB | ±0.6% |
| AI 活動スライディングウィンドウを更新する<br><code>ai-activity-window</code> | 33.5 ns | 29,969,514 回/s | 93.94 MiB | 27.93 KiB | ±7.2% |
| AI 活動 LRU の未登録項目を作成する<br><code>ai-activity-lru-miss</code> | 1.114 µs | 898,217 回/s | 115.89 MiB | 23.87 KiB | ±2.6% |
| ローカルの ID 権限を検索する<br><code>identity-permission-read</code> | 48.7 ns | 20,555,396 回/s | 95.18 MiB | 27.20 KiB | ±0.5% |
| 一時 allowlist の日内 qualified 定常状態と付与境界を進める<br><code>temporary-whitelist-activity</code> | 41.5 ns | 24,100,249 回/s | 99.99 MiB | 27.24 KiB | ±2.0% |
| 既存の連投制御ウィンドウを検索する<br><code>flood-window-hit</code> | 49.1 ns | 20,389,204 回/s | 92.93 MiB | 27.79 KiB | ±1.5% |
| 連投制御ウィンドウを追加・削除する<br><code>flood-window-growth</code> | 191.0 ns | 5,246,194 回/s | 102.34 MiB | 20.78 KiB | ±4.6% |
| 定常状態の連投制御ウィンドウを更新する<br><code>flood-window-steady</code> | 211.2 ns | 4,741,021 回/s | 142.67 MiB | 22.65 KiB | ±3.4% |
| 広告検出の空メタデータ高速経路<br><code>ad-empty-metadata</code> | 4.6 ns | 221,218,033 回/s | 90.73 MiB | 26.93 KiB | ±8.4% |
| 広告候補の Worker ペイロードを複製する<br><code>ad-wire-clone</code> | 2.452 µs | 407,804 回/s | 100.86 MiB | 23.09 KiB | ±1.0% |
| 満杯の広告検出キューを拒否する<br><code>ad-capacity-reject</code> | 21.0 ns | 47,753,207 回/s | 101.35 MiB | 24.00 KiB | ±3.9% |
| AI コンテキストメッセージ 1 件を構築する<br><code>buffered-message-build</code> | 228.0 ns | 4,386,675 回/s | 100.52 MiB | 22.45 KiB | ±1.0% |
| AI チャット文脈をプロンプトに描画する<br><code>transcript-render</code> | 34.63 µs | 28,873 回/s | 112.42 MiB | 23.55 KiB | ±0.1% |
| 返信参照を抽出する<br><code>reply-reference</code> | 34.5 ns | 30,981,201 回/s | 100.96 MiB | 22.96 KiB | ±24.7% |
| Telegram entity から @メンションを抽出する<br><code>mention-facts</code> | 41.7 ns | 23,973,710 回/s | 110.22 MiB | 27.52 KiB | ±1.4% |
| entity のないメンション高速経路<br><code>mention-facts-plain</code> | 4.2 ns | 235,886,878 回/s | 91.00 MiB | 26.84 KiB | ±0.4% |
| gag 発言カウンターを更新する<br><code>gag-speak-counter</code> | 37.4 ns | 26,779,556 回/s | 97.99 MiB | 27.96 KiB | ±3.5% |
| 運勢送信レシートを引き受ける<br><code>luck-receipt-fast-path</code> | 16.3 ns | 61,177,351 回/s | 90.76 MiB | 28.01 KiB | ±1.5% |
| パーセントから運勢ランクを検索する<br><code>luck-tier-table</code> | 14.9 ns | 66,910,582 回/s | 90.28 MiB | 27.41 KiB | ±0.9% |
| 秘匿不要のログテキストを検査する<br><code>redact-clean-log</code> | 78.6 ns | 12,732,892 回/s | 89.93 MiB | 27.41 KiB | ±2.4% |
| Mini App バックエンド：二層認証を検証し管理対象グループ状態一覧を集計する<br><code>mini-app-status-route</code> | 7.578 µs | 132,377 回/s | 103.38 MiB | 26.13 KiB | ±5.8% |
| Mini App フロントエンド：ステータス比較・指標整形・FLIP/スプリング補間を計算する<br><code>mini-app-frontend-render</code> | 572.7 ns | 1,748,604 回/s | 110.15 MiB | 34.90 KiB | ±3.9% |

## 完全処理 · コマンドと永続化アクション

> 各行は本番エントリから名前に示した完了点までを実行し、「完全処理能力」は 1 プロセスが毎秒完了できる回数を示す。先頭 7 行は実際の Disk I/O Worker を駆動し、永続化 ACK までを計測する。広告検出と `ai_chat` はモデルと Telegram 通信をプロセス内の固定応答に置き換えるため、プロンプト、状態機械、処置、直列化、ディスクなどのローカル処理をすべて含むが通信時間は含まない。`ai_chat` は返信送信で完了し、30 秒ごとの一括メモリスナップショットを各返信に強制配賦しない。その費用は AI メモリスナップショット行で別に示す。送信前の 1.5～7.5 秒の擬人的な間も実測して差し引く。この待機はチャット単位で CPU を使わず、他のチャットを止めない。cron 音声の行も音声合成モデルと Telegram を固定応答（約 11 秒の WAV）に置き換え、Base64 デコード、WAV 解析、Opus エンコードと送信境界を含む。本番では合成は AI Worker 上で動くが、この行は同一プロセス内で両側をつなぎ、スレッド間の受け渡しは含まない。cron.json の行は途中変更の費用だけを測り、タスクは実行しない。タスク表は本番の上限（128 タスク、各 16 アクション、ローカルソースはデータルート相対）とし、1 タスクを変更するたびに本番と同じ順序でホットリロード対象の 6 ファイルを読み取って厳密に解析し（ローカルソースを 1 件ずつ確認）、スナップショットを置き換えてタスク名でスケジューラを突き合わせる。書き換えと保存はデプロイ側の作業なので計測せず、ファイル監視のデバウンス待ち、その後の広告検出と AI チャットの可用性の再判定、ホットリロードのログも含まない。Mini App の 5 行は `Bun.serve` ルートハンドラ入口からの主要経路を個別に計測する。API リクエスト行は同期認証パイプライン（ヘッダーガード、Telegram WebApp `initData` の HMAC-SHA256 署名と特権管理者チェック、45 分二次認証セッション検証）、管理対象グループ状態および Q&A・ホットメッセージ件数の集計、実際の Disk I/O Worker 経由での過去 24 時間参加ログ取得と 1～24 時間スライディングウィンドウ集計、および AES-256-GCM 暗号化封筒レスポンスの生成・復号と JSON 解析を通しで実行する。残る 4 行は未認可拒否ページの事前分割属性注入、ページゲート Cookie 通過、TLS モード事前確認の Ed25519 署名付き一時 X25519 ECDH + HKDF 暗号化ログインによる 45 分 AES-256 PSK 発行、暗号化クエリ `?e=` 付き保護ギャラリー画像配信のローカル処理を計測する。

| 本番アクション | 完全処理能力 | 平均 1 回時間 | 典型的な時間 (p50) | 低速時の時間 (p95) | 最も遅い 1 回 | 業務レコード処理能力 | ブロックデバイス書き込み | 変動 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 参加ログ 1 件を追記して永続化 ACK を受け取る<br><code>join-log-append</code> | 897 回/s | 1.12 ms | 1.04 ms | 1.38 ms | 7.77 ms | 897 レコード/s | 3.91 MiB | ±2.6% |
| ID ポリシー 128 件を書き込み永続化 ACK を受け取る<br><code>identity-policy-write</code> | 352 回/s | 2.84 ms | 2.81 ms | 4.46 ms | 12.41 ms | 45,074 レコード/s | 21.42 MiB | ±0.3% |
| 一時 allowlist 活動 1 件を記録して SQLite の正確な ACK を受け取る<br><code>temporary-whitelist-write</code> | 781 回/s | 1.29 ms | 1.17 ms | 2.04 ms | 8.21 ms | 781 レコード/s | 3.15 MiB | ±8.7% |
| チャット状態 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-state-write</code> | 665 回/s | 1.53 ms | 1.28 ms | 3.30 ms | 9.09 ms | 665 レコード/s | 3.13 MiB | ±12.4% |
| チャット Q&A 1 件を書き込み SQLite 永続化 ACK を受け取る<br><code>chat-qa-write</code> | 674 回/s | 1.49 ms | 1.37 ms | 1.87 ms | 8.97 ms | 674 レコード/s | 3.13 MiB | ±5.5% |
| AI メモリスナップショット 1 件を書き直し永続化 ACK を受け取る<br><code>ai-memory-snapshot</code> | 380 回/s | 2.63 ms | 2.41 ms | 3.94 ms | 11.24 ms | 380 レコード/s | 5.55 MiB | ±1.0% |
| 診断ログ 1 件を追記して永続化 ACK を受け取る<br><code>diagnostic-log</code> | 840 回/s | 1.19 ms | 1.12 ms | 1.44 ms | 8.98 ms | 840 レコード/s | 4.11 MiB | ±4.3% |
| 広告検出：グループメッセージ 1 件を判定・処置する（通信を除く）<br><code>ad-detect-command</code> | 457 回/s | 2.27 ms | 1.79 ms | 4.74 ms | 9.87 ms | 457 レコード/s | 1.82 MiB | ±20.0% |
| ai_chat：返信 1 ターンを生成・送信する（通信と擬人的な間を除く）<br><code>ai-reply-command</code> | 4,374 回/s | 225.9 µs | 196.9 µs | 431.4 µs | 583.5 µs | 4,374 レコード/s | 0 B | ±1.2% |
| cron send_voice：音声 1 件を合成・エンコードして送信する（通信を除く）<br><code>cron-send-voice</code> | 4 回/s | 223.4 ms | 222.7 ms | 233.4 ms | 236.6 ms | 4 レコード/s | 0 B | ±0.8% |
| cron.json のタスク 1 件を途中変更：ホットリロードと再スケジュール（上限規模のタスク表）<br><code>cron-config-reload</code> | 8 回/s | 120.3 ms | 117.5 ms | 137.9 ms | 165.3 ms | 8 レコード/s | 7.31 MiB | ±1.1% |
| Mini App API リクエスト：同期認証パイプライン・グループ詳細集計・参加ログ 24h クエリ（GET /api/chats/detail?e=...）<br><code>mini-app-api-request</code> | 2,713 回/s | 367.5 µs | 327.6 µs | 483.4 µs | 4.90 ms | 2,713 レコード/s | 0 B | ±0.9% |
| Mini App 未認可拒否ページ：診断情報構築と reject.html 属性注入（serveMiniAppRejectHtml）<br><code>mini-app-reject-page</code> | 21,387 回/s | 46.80 µs | 29.68 µs | 90.22 µs | 924.9 µs | 21,387 レコード/s | 0 B | ±8.2% |
| Mini App 単一ページゲート許可：Cookie HMAC-SHA256 検証とロック検査（evaluateMiniAppPageGateRequest）<br><code>mini-app-page-gate-allow</code> | 235,217 回/s | 4.075 µs | 3.236 µs | 7.960 µs | 64.80 µs | 235,217 レコード/s | 18.67 KiB | ±1.6% |
| Mini App ECDH ログインネゴシエーション：事前確認 Ed25519 署名付き一時 X25519 公開鍵・HKDF 鍵導出と暗号化ログインによる 45 分 AES PSK 発行（GET /api/auth/precheck → POST /api/auth/login）<br><code>mini-app-auth-login</code> | 1,323 回/s | 754.8 µs | 698.5 µs | 956.1 µs | 5.71 ms | 1,323 レコード/s | 364.00 KiB | ±1.0% |
| Mini App 保護ギャラリー画像：二層セッション・暗号化クエリ ?e= 検証とキャッシュ応答読込（GET /api/gallery/file?e=...）<br><code>mini-app-gallery-asset</code> | 4,577 回/s | 218.7 µs | 192.6 µs | 296.7 µs | 3.19 ms | 4,577 レコード/s | 0 B | ±7.1% |

## ストレージ · SQLite とメインスレッドキャッシュ

> `bun run perf:identity-database` の実装を再利用。「コールド」は接続のページキャッシュと文キャッシュが空である意味で、OS のページキャッシュを破棄したという意味ではない。

| 操作 | 毎秒呼び出し数 | 平均バッチ時間 | ブロックデバイス書き込み | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| メインスレッドの ID LRU キャッシュを検索する<br><code>main-lru-read</code> | 39,755,559 回/s | 201.3 ns | 0 B | 13.01 KiB | ±2.0% |
| ID を SQLite まで書き通し ACK を待つ<br><code>main-write-through-acked</code> | 42,175 回/s | 3.04 ms | 56.55 MiB | 23.15 KiB | ±3.8% |
| SQLite クエリ（ウォーム接続を再利用）<br><code>storage-read-hot-connection</code> | 395,304 回/s | 20.24 µs | 5.30 MiB | 19.09 KiB | ±1.2% |
| SQLite クエリ（バッチごとに新規接続）<br><code>storage-read-cold-connection</code> | 10,655 回/s | 750.9 µs | 34.02 MiB | 203.99 KiB | ±0.4% |
| SQLite トランザクション書き込み（ウォーム接続を再利用）<br><code>storage-write-hot-connection</code> | 65,812 回/s | 1.95 ms | 73.15 MiB | 129.33 KiB | ±2.8% |
| SQLite トランザクション書き込み（バッチごとに新規接続）<br><code>storage-write-cold-connection</code> | 19,530 回/s | 6.56 ms | 12.60 MiB | 420.92 KiB | ±1.8% |

## コンテナとアルゴリズム

> 本番が実際に使うコンテナとアルゴリズム：通常の上限付きウィンドウと有界の荒らし対策 join ウィンドウは `TimestampDeque`、AI のローリングメモリバッファは `BoundedDeque`。ここではコンテナ自体のコストを計測する。

| コンテナ | 典型的な 1 回の時間 | 毎秒呼び出し数 | ピーク RSS | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- | --- |
| 上限付き時刻スライディングウィンドウの記録と期限切れ削除<br><code>quota-timestamp-window</code> | 16.0 ns | 62,609,474 回/s | 99.98 MiB | 23.00 KiB | ±6.9% |
| 有界 join ウィンドウの飽和記録と期限切れ削除<br><code>join-timestamp-window</code> | 32.6 ns | 31,251,582 回/s | 92.31 MiB | 27.55 KiB | ±12.8% |
| AI 有界ローリングメモリの追加と削除<br><code>bounded-rolling-buffer</code> | 19.6 ns | 51,123,908 回/s | 100.89 MiB | 28.20 KiB | ±6.0% |

## 参加ログ · 25 万件の容量線

> 25 万件を満載した参加ログ上で、現行実装のスナップショットと容量トリムを計測する。

| 操作 | 所要時間 | GC 前の割り当て | GC 後の残存 | 変動 |
| --- | --- | --- | --- | --- |
| 参加ログ 25 万件のスナップショットを複製する<br><code>snapshot</code> | 96.22 ms | 4.20 MiB | 5.36 KiB | ±0.8% |
| 参加ログ 25 万件を容量上限まで切り詰める<br><code>capacity</code> | 3.64 ms | 0 B | -4.76 KiB | ±1.2% |

> 再現方法：`bun run perf:full`。

<!-- performance-benchmark:end -->

---

<div align="center">

[← 前のページ：10 Mini App の設定方法と推奨構成](10-mini-app.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#11-パフォーマンスベンチマーク) · [次のページ：12 よくある質問 →](12-faq.md)

</div>

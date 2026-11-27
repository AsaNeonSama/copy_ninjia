# 04 実行時の正式な不変条件

<p align="center">
  <a href="../cn/04-invariants.md">简体中文</a> · <a href="../en/04-invariants.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 開発者ドキュメント TOP</a> · <a href="03-directory-map.md">← 前のページ：03 ディレクトリマップ</a> · <a href="05-dev-workflow.md">次のページ：05 開発フロー →</a>
</p>

---

このページは、モジュールやライフサイクルをまたぐ**正式な制約**を記録します。ソースコメントでは局所的な不変条件を説明し、`@see ../../docs/cn/04-invariants.md`（ソースの深さに応じて `../` を調整）のようにここを参照してください。起動や永続化の説明全体を複数のモジュールへ重複させてはいけません。以下のいずれかに関わる変更では、コードより先にこのページを更新します。

案内用の説明は [02 アーキテクチャ概要](02-architecture.md)、これらの制約に触れる変更手順は [06 よくある変更手順](06-modification-guide.md) を参照してください。

> [!TIP]
> このページは実装とレビューで参照する制約の完全版であり、先頭から順番に読み通す必要はありません。下のナビゲーションから対象領域へ進んでください。長い項目では、段落冒頭の太字が通常、その段落で守るべき結論を示します。

## クイックナビゲーション

| 範囲 | トピック |
| --- | --- |
| [起動と import の境界](#起動と-import-の境界) | [起動順序とリソース取得](#起動順序とリソース取得) · [任意の資格情報と設定の厳密な事前検証](#任意の資格情報と設定の厳密な事前検証) · [データルートとバックグラウンドタスク](#データルートとバックグラウンドタスク) · [送信リクエストとメッセージの安全性](#送信リクエストとメッセージの安全性) |
| [Worker と状態の所有権](#worker-と状態の所有権) | [スレッドと状態の帰属](#スレッドと状態の帰属) · [状態機械の contract](#状態機械の-contract) · [AI チャットの実行時](#ai-チャットの実行時) · [AI プロンプトと transcript](#ai-プロンプトと-transcript) · [参加認証と終端処置](#参加認証と終端処置) · [連投ミュートと自身の権限キャッシュ](#連投ミュートと自身の権限キャッシュ) · [識別子の解決と実行時のクリーンアップ](#識別子の解決と実行時のクリーンアップ) |
| [永続化](#永続化) | [永続化と snapshot の contract](#永続化と-snapshot-の-contract) · [グループ状態と `chat_states`](#グループ状態と-chat_states) · [chat Q&A と `chat_qa`](#chat-qa-と-chat_qa) · [ブロックリストと広告検出](#ブロックリストと広告検出) · [運勢と AI メモリの復元](#運勢と-ai-メモリの復元) · [確認境界と停止](#確認境界と停止) · [ファイル権限と schema](#ファイル権限と-schema) · [ロックダウンミラーと終端フラグ](#ロックダウンミラーと終端フラグ) |
| [互換エントリ](#互換エントリ) | トップレベル barrel と運勢 receipt の形式 |

## 起動と import の境界

### 起動順序とリソース取得

- **既定タイムゾーンはプロセス起動時の読み取り専用スナップショット**：
  - `config/static/bot.json` の任意項目 `time_zone` は標準 IANA 名を受け付けます（省略時は `DEFAULT_BOT_TIME_ZONE`）。
  - 前後の空白を除去したのち、外部接続より前に `Intl`・`Temporal`・Bun ネイティブ cron（`TIME_ZONE_VALIDATION_CRON`）の対応を検証し、`Temporal` で正規化された名前（例：`asia/tokyo` は `Asia/Tokyo` に正規化し、`Japan` などの別名はそのまま維持）を保持します。空文字列、非文字列型、未対応のタイムゾーンは起動を直ちに中断します。
  - メインスレッドが権威スナップショットを保持し、AI・Anti-Raid・Disk I/O の各 Worker へ `init`・`agentConfig`・`load` メッセージで配布します。Worker クラッシュ後の再構築時にも同じ値を再生します。
  - 各 isolate の `cache/perThread/time.ts` はタイムゾーン、formatter、日付プレフィックス、現在の UTC オフセット区間を 1 組保持します：
    - 夏時間などの遷移点に挟まれた同一オフセット区間内では、通算日数・日付文字列・ローカル時刻・時刻の「時」を比較と整数演算のみで算出します。
    - 区間境界をまたいだ場合のみ、`Temporal` で前後の遷移点とオフセットを再計算します（受付タイムスタンプは `FORMAT_MIN_TIMESTAMP_MS`〜`FORMAT_MAX_TIMESTAMP_MS` の整数に限定し、未初期化時の暦操作は拒否します）。
  - 運勢、ログ、一時広告免除の日次集計、入室ログ、AI の時刻認識、日次保守はすべてこのタイムゾーンを共有し、`cron.json` の省略時にも引き継がれます（タスク側で明示指定された `time_zone` は独立して動作します）。
  - 東京天気ツール（`GET_TOKYO_WEATHER_TOOL`）は起動時のタイムゾーンが `TOKYO_TIME_ZONE` と一致する場合のみ登録されます。他のタイムゾーンでは宣言自体を除外し、呼び出し時には未知のツールとしてエラーを返します。

- **データルートはタイムゾーンに恒久バインドされる**：
  - `initializeStorageDatabase` は初期化時に設定タイムゾーンを `storage_metadata` の `IDENTITY_DATABASE_TIME_ZONE_KEY`（`time-zone`）へ `{"timeZone":"<正規 IANA 名>"}` として記録します。
  - Disk I/O Worker の起動時（スキーマ検査直後・日付依存検査より前）およびサービスインストーラーは、この記録と `bot.json` の `time_zone` を照合します。不一致時は `storage_metadata.time-zone` を明示して起動を拒否します（自動書き換えは行わず、既存データルートのタイムゾーン変更は不可です）。

- **副作用のない Import**：
  - 本番モジュールの `import` 時に Worker の起動、タイマーの登録、ネットワーク接続、共有ディレクトリへの書き込みを行ってはなりません。

- **データルート事前検査と排他インスタンスロック**：
  - メインプロセスは実行時データルートを再帰作成し、書き込み・ファイル `fsync`・hard link・アトミック `rename`・ディレクトリ `fsync` を事前検証してから `LOCK_FILE_PATH`（`bot.lock`）を取得します。
  - **パスとパーミッションの制約**：
    - データルートおよび `RUNTIME_SENSITIVE_DIRECTORY_NAMES`（`memory/`、`logs/`、`database/`）は物理ディレクトリでなければならず、`lstat` がシンボリックリンクを検出した場合は直ちに fail-closed で終了します。
    - `RUNTIME_DATA_ROOT_ENV`（`COPY_NINJIA_DATA_ROOT`）を明示設定した場合、データルート・`memory/`・`logs/` の mode は `RUNTIME_DATA_ROOT_MAX_MODE` 以下（group / other の書き込みビット禁止）とします。`database/` は SQLite WAL/SHM 用に `IDENTITY_DATABASE_DIRECTORY_MODE` のグループ書き込みを許可します（実行 UID 以外の所有時はプロセスの実効グループに属し `rwx` が必要です。既存ディレクトリへの自動 `chmod` は行いません）。
  - **クリーンアップとコールドスタート復元**：
    - `bot.lock` 取得後、`cleanupOrphanedTempFiles` が異常終了時に残留した実行時アトミック一時ファイル（`state.json`・`totp.json`・`bot.lock`）、不活性確認済みロック補助ファイル、および `config/static/`・`config/dynamic/` 配下で所有 PID が消滅済みまたは自プロセスと同一（掃除は自プロセスの設定書き込みより前に走るため、同一 PID は PID 再利用前の残骸に限られる）のホワイトリスト内アトミック一時ファイルを設定ディレクトリ検証前に掃除します。`LEGACY_STATE_FILE_PATHS`（データルート直下の旧 `state.json` / `state.json.bak`）が存在すれば起動を拒否したうえで、外部接続や Worker 起動より前に `memory/mini-app-totp/totp.json`（存在時）と `GLOBAL_STATE_FILE_PATH`（`memory/global/state.json`）を厳格に復元します。
  - **単一インスタンスロック境界**：
    - `bot.lock` の guard と recovery 補助ファイルは hard link で原子的に公開し、`/proc/<pid>/stat` とカーネル boot ID により同一データルート上で稼働できるプロセスを厳密に 1 つに制限します（`infra/storage/instanceLock.ts`）。

- **ライフサイクル推進順序**（`packages/app/lifecycle.ts`）：
  1. 単一インスタンスロックを取得し、メインスレッド内ランタイムの初期化、`cleanupOrphanedTempFiles` による孤立一時ファイルの掃除と `assertDeploymentConfigLayout` による構成検証、`GLOBAL_STATE_FILE_PATH` の復元、存在する全デプロイ入力の厳格検証（`validateExistingDeploymentInputs`、`memory/mini-app-totp/totp.json` の存在時検査を含む）、ランダム画像ディレクトリの検証（`prepareRandomImageDirectory`）、および Disk I/O Worker の起動（`initDiskIO`）を完了します。
  2. SQLite 永続化データ（`chatStates`、`chatQa`、`adPackBlacklistCounts`、`wedMembers`、身分件数）を hydrate し、Telegram クライアントを初期化してスーパー管理者のブラックリスト・`/delete_message` 対象非該当（`assertSuperAdminNotBlocked`、`assertSuperAdminNotDeleteMessageTarget`）を検証したのち、コピー対象・翻訳対象・運勢状態・参加認証待ちを復元します。
  3. ハンドラーとコマンドメニューを登録し（`registerHandlers`、`registerCommandMenu`。`mini_app` 設定時はスーパー管理者のプライベートチャットに `MenuButtonWebApp` も配置）、`bot.init()` ハンドシェイクを完了します。
  4. AI Worker を起動（`initAiChat`）して AI 記憶とスタンプ目録を hydrate し、ブラックリスト削除 outbox を復元（`hydrateBlocklist`）して Anti-Raid Worker を起動（`initAntiRaid`）します。
  5. `cron.json` スケジューラ（`startCronScheduler`）、`config/dynamic/` ホットリロード（`startConfigReload`）、Mini App HTTP サーバー（`startMiniAppServer`）、ブラックリスト補完スイープスケジューラ（`initBlocklistSweepScheduler`）を起動して管理対象グループの初回補完スイープ（`sweepManagedBlocklistChats`）を実行したのち、acknowledgement-safe runner（`TELEGRAM_ALLOWED_UPDATES`）を開始し、`/wed` メンバー再確認（`enableWedMemberReview`）と低優先度のグループタイトル更新（`refreshAllChatTitles`）を開始します。
- **統一ライフサイクル終端**：
  - 初期化失敗と通常終了はいずれも `ApplicationLifecycle` に合流し、取得済みリソースのみを逆順でクリーンアップ・flush・解放します。

### 任意の資格情報と設定の厳密な事前検証

- **起動時の厳密な設定プリフライト**：
  - 設定 parser 自体はファイル I/O を行いません。メインスレッドは Worker 作成や外部接続の前に `packages/config/readiness.ts` の `validateExistingDeploymentInputs` を呼び出し、**ファイルが存在するすべてのデプロイ入力**（必須の `bot.json` と、任意の `stickers.json`、`mood.json`、`ad_detect.json`、`agent.json`、`assets.json`、`cron.json`、`g-auth.json`、`prompt/persona.md`、`prompt/voice_tool.md`）を厳格に検証します（機能が無効でも不正な設定は起動を拒否します）。
  - `deploymentInputExists` が「未設定」とみなすのは `ENOENT` のみです。リンク切れシンボリックリンクや権限エラーは不正入力として起動を拒否し（最初の破損入力 1 件を報告）、真に存在しない任意ファイルのみ `packages/config/readiness.ts` と各 availability 境界（`packages/aiChat/availability.ts`、`packages/translate/message.ts` の `activeTranslateStateIn`、`adDetectConfigReadiness()`）が該当機能を利用不可と判定します（SQLite `chat_states` のグループスイッチは書き換えません）。
  - **設定スナップショットと個別資格情報**：
    - `config/dynamic/` 配下（`assets.json`、`ad_detect.json`、`agent.json`、`mood.json`、`stickers.json`、`cron.json`）は稼働中のホットリロードに対応し、それ以外の入力の変更には再起動が必要です。
    - `config/dynamic/agent.json` は機能ごとに検証され、広告検出は `agent.ad_detect`、AI 雑談は `AGENT_AI_CHAT_REQUIRED_CAPABILITIES`（`text`、`summary`、`media`）と任意ツール能力を読み取ります。
    - `prompt/persona.md`（省略時は `DEFAULT_AI_PERSONA`）と `prompt/voice_tool.md`（省略時は `null` で内蔵説明を使用）は `ensurePromptFiles` が通知口調（`bot.json` の `atmosphere`、省略時はカスタムペルソナなら `normal`、内蔵なら `DEFAULT_BOT_ATMOSPHERE` すなわち `mesugaki`）とともに起動時に固定します。
    - `g-auth.json` は `packages/config/googleAuth.ts` が RS256 用 RSA PEM 秘密鍵を厳密検証し（EC・Ed25519・RSA-PSS は拒否）、`googleServiceAccountKey` の読み取り専用スナップショットとして翻訳クライアントへ渡します（詳細は [01 Google 資格情報](01-getting-started.md#前提条件) を参照）。
    - Disk I/O 復旧時の `stickerPacksForRecovery()` は `stickers.json` 欠落時に `null`（全既存カタログを検証のみ行い削除しない）、空配列指定時は空リストとして照合します。AI 資格情報欠落時の `hydrateAiMemory` / `hydrateStickerCatalog` はメインスレッドのミラーに保持するのみで送信・削除を行いません。

- **身分ポリシーおよび広告パックブラックリストの唯一の権威ソースは SQLite（`database/storage.sqlite`）**：
  - ホワイトリスト、ブラックリスト、一時広告免除の活動記録、未完了の削除 outbox、および広告スタンプ／カスタム絵文字パックのブラックリスト（`ad_pack_blacklists`）はすべて `database/storage.sqlite` に格納され、runtime はポリシー JSON ファイルを一切読み書きせず、`config/dynamic/ad_detect.json` への書き戻しも行いません。
  - Disk I/O Worker は起動時に SQLite integrity、JSONB storage class、migration lineage（`STORAGE_MIGRATION_LINEAGE`、`0000_identity_storage`〜`0012_ad_pack_blacklists` の全 13 件）、schema version（`IDENTITY_DATABASE_SCHEMA_VERSION` = 14）、`storage_metadata`（`IDENTITY_DATABASE_METADATA_KEYS` とタイムゾーンマーカー）、全行の strict codec（`ad_pack_blacklists` のストリーミング全行検証を含み、全表をメモリへ読み込まず件数上限も設けない）、ブラックリストと 2 種のホワイトリストの相互排他、および outbox 参照整合性を検証します。本番起動は DB の自動作成・自動マイグレーションを行わず、1 つでも失敗すれば起動を拒否します。

- **メインスレッドの有界 LRU キャッシュによる同期権限判定**：
  - **3 項目一体の単一 LRU**：メインスレッドは容量 `IDENTITY_READ_CACHE_MAX_ENTRIES` の `identityPolicyCache`（`packages/cache/main/identityStorage.ts`）を 1 つ保持します。1 身分につき 1 エントリが「恒久ホワイトリスト・ブラックリスト・一時広告免除」の 3 フィールドを一体で保持し、まとめて淘汰されます（`undefined` は未ロード、`null` は明示的な negative cache、3 フィールドすべてロード済みのときのみキャッシュヒットとみなします）。
  - **バッチプリフェッチとプリペアドステートメント**：
    - update 前置処理が必要な全ユーザー・チャンネル身分をまとめ、1 回最大 `IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES` 件ずつ Disk I/O Worker からコールドリードして 3 フィールドを同時に書き込みます（既にキャッシュ済みの身分も利用順を更新するため、同一プリフェッチ内のコールドキーに追い出されません）。
    - Disk I/O 側の 3 テーブルおよび `chat_states` の ID 読み取りは接続単位のプリペアドステートメント（単一 ID は `WHERE id = ?`、複数 ID は `json_each`）を再利用します。以降のハンドラーや参加判定はメモリ上のキャッシュのみを同期的に読み取ります。
  - **コールドリード失敗時の fail-closed**：プリフェッチ失敗時、通常のコマンドや単一対象変更は fail-closed で拒否し（`/permission query` はデフォルト権限ボードを出さず `COMMAND_MESSAGE_AUTO_DELETE_MS` の照会失敗通知のみを送信）、破壊的な一括処理は未知の身分を無保護とみなさず処理を中止します。
  - **`/batch_kick` の例外**：LRU 常駐に依存せず、各チャンクの実行前に `readIdentityPolicyVerdicts` でチャンク内全身分の恒久ポリシーを直接コールドリードして局所保持し、「局所判定 ∪ リアルタイムキャッシュ」で保護・スキップを判定します。
  - **Mini App 一覧・検索の例外**：
    - **直接コールドリードとプロフィール同期**：Mini App のホワイトリスト・ブラックリスト一覧および検索は、`readIdentityPolicyEntries` で同じチャンク上限のもと対象ページまたは全件をコールドリードします。カーソルページとエントリ内容の双方に未 ACK のローカル最終値を重ね合わせ、表示メタデータをメインスレッドの `senderIdentity` キャッシュと双方向同期（新しいキャッシュプロフィールを優先し、他身分へ移動していないユーザー名を補完）します。
    - **リクエスト局所隔離**：取得結果はその HTTP リクエスト内だけで保持し、`identityPolicyCache` への読み書きは一切行わないため、メッセージ処理のホットエントリを汚染・淘汰しません（コールドリード失敗時はリクエスト自体をエラーにします）。
    - **変更経路と境界ガードの共有**：メンバーの追加・削除や権限変更は `/white`・`/block`・`/permission` と同一のプリフェッチ・書き込み経路を通り、スーパー管理者・Bot 自身・初期化済み管理対象グループ身分の拒否、ホワイトリスト／ブラックリストの相互排他、およびネイティブ `users_shared` / `chat_shared` ピッカーで追加が 0 件だった場合の最初の境界拒否コード透過を同じく適用します。
    - **重複追加時の永続化確認とグループ横断 BAN**：ホワイトリストへの重複追加は `confirmIdentityPolicyPersisted(..., retryUnacknowledged=true)` で永続化を確認して `{ ok: true, changed: false, duplicate: true }` を返し、ブラックリストへの重複追加は `confirmBlocklistPersisted(..., retryUnacknowledged=true)` で永続化を確認したうえで管理対象全グループへの BAN を再送出して `{ ok: true, changed: false, duplicate: true, persisted, affectedChats, totalChats }`（`/block enable` と同基準）を返し、フロントエンドの重複通知 Toast には再 BAN したグループ数と永続化確認状態も表示します。

- **一時広告免除（一時ホワイトリスト）のグループ横断集計**：
  - **対象条件**：広告検出が利用可能かつ対象グループで有効な場合のみ、実ユーザーまたはチャンネル身分の通常発言をカウントします（サービスメッセージ、自動転送、Bot 自身、匿名管理者、恒久ホワイトリストメンバー、およびブラックリスト LRU が明示的 `null` でない身分は対象外です）。
  - **日次認定と恒久昇格**：
    - 設定タイムゾーンの暦日における発言数が `TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD` を厳密に超えた時点でその日を qualified day と認定し（1 日 1 回、`send_count` と `counted_at = qualified_at` を凍結）、最初の qualified day で広告免除のみの `TEMPORARY_AD_BYPASS_PERMISSIONS` を即時付与します。
    - `TEMPORARY_AD_BYPASS_REQUIRED_DAYS` 日連続で qualified に達すると、同じ広告免除権限を持つ恒久ホワイトリストへ自動昇格し、一時レコードを削除します。
  - **日次繰り越し・深夜保守・失効**：
    - 前日が qualified であれば行を翌日へ持ち越し、翌日の最初の発言時に `send_count` をリセットして `qualified_at` を消去します。未達成のまま日が変わった行は 0 時の深夜メンテナンス（共有 SQLite の保留書き込みを先にコミットできた場合のみ実行）で削除され、遅延到着した旧日付の書き込みや未 ACK 値も同一の日境界で tombstone として処理されます。
    - 広告違反の確定または手動 `/block` は一時レコードを即座に削除します（付与前に開始された古い判定の遅延結果が権限を取り消すことはありません）。ウォールクロックが `counted_at` より過去へ巻き戻った場合も付与済み資格を維持したままカウントを再構築します。

- **容量判定・ライトスルー・exact revision ACK**：
  - **書き込み予算**：メインスレッドの各ドメインと Disk I/O Worker の `STORAGE_DATABASE_DOMAINS`（`cache/workers/diskIO/storageDatabase.ts` の `storagePendingBudgets`）は、未 ACK キー数 `STORAGE_PENDING_MAX_ENTRIES` と推定バイト数 `STORAGE_PENDING_MAX_BYTES` を上限とします。予算確認後に LRU 最終値を更新して revision を採番・送信し、exact revision ACK 受信時のみ置換差分の予算を解放します。
  - **バッチコミットと再試行**：恒久ポリシー・ブラックリスト・一時免除・outbox が `IDENTITY_WRITE_BATCH_MAX_ENTRIES` 件、グループ状態が `STATE_MANAGED_CHAT_LIMIT` 件、Q&A が `CHAT_QA_WRITE_BATCH_MAX_ENTRIES` 件、広告パックブラックリストが `AD_PACK_BLACKLIST_WRITE_BATCH_MAX_ENTRIES` 件に達したとき、または最初の変更から `IDENTITY_WRITE_FLUSH_INTERVAL_MS` 経過時に、単一の同期 SQLite トランザクションでコミットします。失敗時は全保留値を維持して `IDENTITY_WRITE_FLUSH_INTERVAL_MS × 連続失敗回数` でバックオフ再試行し、`STORAGE_WRITE_MAX_FAILURES` 回連続失敗で fatal 停止を通知します。
  - **ドメインバリア（`flushDiskIODomain`）**：`/white`・`/permission`・`/block` の成功応答は該当ドメインの耐久確認を待ちます。`STORAGE_DATABASE_DOMAINS`（`aiMemory` を含む）は 1 つの SQLite トランザクションを共有し、`postAntiRaidDurably` は変化があったミラーのドメイン（`verification` または `chatState`）のみを flush します（停止時の `drainAntiRaid` は統一 flush を使用します）。

- **スーパー管理者の権限はコード上の身分に由来する**：
  - `packages/infra/identityPolicy/whitelist.ts` の `getEffectiveWhitelistPermissions` は `SUPER_ADMIN_USER_ID` に対し全フラグ `true` の `SUPER_ADMIN_WHITELIST_PERMISSIONS` を DB 行なしで返します（それ以外は恒久ホワイトリスト → 有効期限内の一時免除の順に参照します）。
  - `/white` と `/permission` は現在のグループ自身を対象に指定できません。`isCanWhiteOther` は `DEFAULT_WHITELIST_PERMISSIONS` での `/white enable` のみを委任し、削除や権限変更はスーパー管理者専用です。`/permission query` と `/permission help` は読み取り専用でボードを長期保持し、エラーや案内は `COMMAND_MESSAGE_AUTO_DELETE_MS` で自動削除されます。

- **Bot 資格情報と AI クライアント境界**：
  - **Telegram 資格情報とログレベル**：`bot_token`、`super_admin_user_id`、および任意の `log_level`（省略時は `DEFAULT_LOG_LEVEL` の `"operation"`）は `config/static/bot.json` のみから厳密検証して読み取り、Telegram 接続前に検証を完了してメインスレッドおよび各 Worker の `packages/cache/perThread/logger.ts` しきい値 holder へ反映します。
  - **能力別の明示的 AI クライアント構築**：
    - `config/dynamic/agent.json` は能力ごとに `provider`（`AGENT_PROVIDERS`：`google`、`openai`、`anthropic`。`image` と `tts` は `google` / `openai` のみ許可）、`api_key`、任意の `base_url`（`https`、または `LOOPBACK_HOSTS` の平文 `http` のみ。userinfo と `#` フラグメントは禁止）、`model` を独立設定し、能力間のフォールバックや環境変数からの暗黙補完を一切行いません。`agent.ad_detect` は `provider: "google"` の場合のみ任意の真偽値 `use_decision`（既定 `false`、`openai` / `anthropic` および他能力では禁止）を受け付けます。
    - SDK クライアントは資格情報・エンドポイント・暗黙環境変数無効化オプションを明示渡しして生成します（全 Gemini クライアントは `httpOptions.apiVersion: GEMINI_API_VERSION` と `enterprise: false` を明示指定し、`GOOGLE_GENAI_API_VERSION` や Vertex/Enterprise 環境変数を遮断します）。コンストラクタで無効化できない `SDK_REQUEST_HEADER_ENVS`（`ANTHROPIC_CUSTOM_HEADERS`、`OPENAI_CUSTOM_HEADERS`、`GOOGLE_GENAI_USER_PROJECT`、`GOOGLE_GENAI_DEBUG`：前 2 つは全リクエストヘッダーに併合され `Authorization` を上書きし得、後 2 つは `@google/genai` NextGen クライアントが直接参照して `x-goog-user-project` の注入や未マスクの `console` 出力を引き起こす）が環境変数に存在する場合、`packages/consts/paths.ts` のロード時に起動を拒否します。
    - OpenAI 互換画像生成の wire protocol は `agent.image.image_protocol`（`openai`、`openai-standard`、`xai`）で明示指定し、URL やモデル名からの推測や 400 後の別プロトコル再試行は行いません。
  - **メインスレッド専有のファイル読み取りと依存検証**：`agent.json` をディスクから読むのはメインスレッドのみであり、AI Worker（`init` / `configReload`）と Anti-Raid Worker（`agentConfig`、未設定時は明示的 `null`）へは読み取り専用スナップショットを配布します。`assertCronAgentSupported` は `cron.json` の `send_voice` に対して `agent.tts`（`/send` 音声中継も同様）、`send_web_digest` に対して対話中核能力を必須検証します。

- **メディア入力モダリティの動的プローブ**：
  - 音声文字起こしと音声合成はプロバイダ名ではなく実装メソッドの有無で判定します（Gemini と OpenAI が対応し、OpenAI TTS は `speech_protocol` で `audio/speech` と xAI `/tts` を切り替え。Anthropic は音声入力非対応のため音声をプレースホルダーへ降格し、`provider.synthesizeSpeech === undefined` の場合は `send_voice` ツール自体を除外して診断ログを出します）。
  - `media` モデルの画像・スタンプ・音声入力は初回リクエスト時にモダリティ単位で 1 件ずつコールドプローブし、`reduceMediaInputResult`（エラー分類は `packages/workers/aiChat/ai/utils/mediaSupportError.ts` の `MEDIA_INPUT_CAPABILITY_PATTERN` / `MEDIA_INPUT_FILE_ERROR_PATTERN`）で遷移します：
    - `supported`：対応確認済み。
    - `unsupported`（HTTP 400/415/422 でモダリティ非対応が明示された場合）および `misconfigured`（HTTP 404/405、`$.agent.media` を診断ログ出力）：以後の該当モダリティのダウンロードとリクエストを停止します。
    - エンドポイント一時障害（タイムアウト・408/429/5xx・通信エラー）：`MEDIA_PROBE_BACKOFF_BASE_MS`〜`MEDIA_PROBE_BACKOFF_MAX_MS`（最大 `MEDIA_PROBE_MAX_TRANSIENT_FAILURES` 回）の指数バックオフを適用し、1 回成功すればカウンタをリセットします（個別ファイルの破損・サイズ超過・空応答はモダリティ判定を動かしません）。`agent.media` のホットリロードで `unknown` へ再初期化されます。
  - メインスレッドはメディアイベント送信時に `replyTelegramBackpressured` を 1 回付与し、Worker は追加 IPC なしで割り込み抑止と並行数を判定します。

- **設定ディレクトリの 3 階層ホワイトリスト検証**（`packages/config/layout.ts`）：
  - `packages/config/bot.ts` は `bot.json` 読み込み前に `assertNoLegacyOrMisplacedBotConfig` で `config/` 直下のエントリ名のみを検査して旧 `telegram.json` と誤配置の `bot.json` を検出し、インストーラー（`assertNoMisplacedConfigFiles`）・起動ゲート（`assertDeploymentConfigLayout`、ロック取得と `cleanupOrphanedTempFiles` の後に実行）・ホットリロード（`readDynamicConfigLayoutRejections`）が共通の 3 階層ホワイトリストを強制します：
    - `config/` 直下：`static/` と `dynamic/` のみ（`DYNAMIC_CONFIG_DIR_NAME` すなわち `config/dynamic/` は実在ディレクトリ必須）。
    - `STATIC_CONFIG_DIR_NAME`（`config/static/`）：`bot.json`、`g-auth.json` のみ（変更には再起動が必要）。
    - `config/dynamic/`：`assets.json`、`ad_detect.json`、`agent.json`、`mood.json`、`stickers.json`、`cron.json` のみ。
  - 非ディレクトリやリンク切れシンボリックリンク、誤配置ファイル、旧ファイル（`telegram.json`、`ad_samples.json`）、隠し・一時・バックアップファイル、未宣言サブディレクトリが存在する場合は中身を読まずに拒否します。新規設定ファイルの追加時は `STATIC_ALLOWED_NAMES` または `DYNAMIC_ALLOWED_NAMES` への登録が必須です。

- **`config/dynamic/` の動的ホットリロード**（`packages/app/configReload.ts`、`packages/config/reload.ts`）：
  - **デバウンス監視と再監視**：AI Worker と Anti-Raid Worker の起動後、`node:fs` の `watch`（`unref()` 済み）で `config/dynamic/` のみを監視し、`CONFIG_RELOAD_DEBOUNCE_MS` でイベントを直列ラウンドへ集約します（ディレクトリ置換時は `CONFIG_RELOAD_REWATCH_RETRY_DELAYS_MS` で再監視し、停止時の `quiesceLifecycleMaintenance` で受付と配布を即座に閉じます）。
  - **一括検証とファイル間整合性**：
    - 各ラウンドはまず `readDynamicConfigLayoutRejections` でディレクトリ構成を検証し、続いて起動時と同一の厳密 parser と `cron.json` ↔ `agent.json` 依存検査を実行します。
    - 不正エントリや解析失敗・依存欠落がある場合は変更を拒否し、英語エラーログ（ファイルパス・フィールドパス・期待形式のみ）を出して直前の有効なスナップショットを維持します（`assets.json` 削除時は `DEFAULT_ASSET_CONFIG`、他ファイル削除時は `null` へ遷移し、内容不変なら差し替えを省略します）。
  - **進行中 AI セッションの隔離と Worker 再構成**：
    - AI 返信はセッション開始時点の `text` モデルとクライアントをツール往復・Anthropic `pause_turn` 続行の完了まで固定するため、リロードはその後に始まる返信から反映されます。
    - 新スナップショット適用時、Worker は旧 capability facade と SDK クライアントを破棄し（引き続き参照される quota lane は維持）、`media` 変更時はモダリティ probe をリセットし、mood は同名フェーズを維持（削除時は次回再抽選）し、`stickers.json` 追加分はカタログ照合を開始・削除分はツールから除外します。Anti-Raid Worker も広告検出 SDK クライアントと system prompt キャッシュを更新します。
  - **可用性（readiness）遷移とログ秘匿**：
    - `aiChatReadinessFromHolders` / `adDetectReadinessFromHolders` の結果が変化すると `cache/main/configReadiness.ts` を差し替えます（利用不可への遷移時は入力ゲートと enable コマンドを閉じ、利用可能への復帰時は `packages/aiChat/hydration.ts` の `resumeAiChat` で Worker を復旧してから公開します）。
    - 各スレッドの `cache/perThread/logger.ts` は新旧のトークンと `api_key`（新資格情報優先、最大 `LOGGER_MAX_REDACTED_SECRETS` 件）を読み取り専用スナップショットとして保持し、`LOGGER_SENSITIVE_FIELD_NAMES`（`x-goog-api-key` 等を含む）に一致するフィールドとともにログ出力から自動マスクします。
- **Mini App 一時セッション鍵・AES-256-GCM 通信暗号化・オンライン設定保存境界**：
  - **起動時メモリ生成 Ed25519・一時 X25519 交渉・5 セッション上限と最長 2 時間寿命**：`startMiniAppServer` は起動ごとにメインスレッドのメモリ内で秘密鍵エクスポート不可の Web Crypto `Ed25519` 署名鍵ペアを生成し（`ensureMiniAppRuntimeSigningKeyPair`、停止時 `clearMiniAppRuntimeSigningKeyPair` で破棄）、`handlers/page.ts` がフロントエンド JS チャンク実体化時に 32 バイト生公開鍵 Base64（`MINI_APP_SERVER_SIGNING_PUBLIC_KEY_PLACEHOLDER`）を注入して `ETag` を再計算します。未認証時の `GET /api/auth/precheck` は該 Ed25519 秘密鍵で署名した一時 `X25519` 公開鍵（`handshakeId` + `serverPublicKey` + `expiresAt`、上限 `MINI_APP_HANDSHAKE_MAX`、TTL `MINI_APP_HANDSHAKE_TTL_MS`、ドメイン prefix `MINI_APP_HANDSHAKE_SIGNATURE_DOMAIN`）を発行し、認証済みセッションではトークン更新や鍵発行を行わず読み取り専用で検証します。クライアントは署名検証後（`signatureMismatch` かつ `sessionStorage` 存在時は 10 秒ループ防止付き 1 回リロード、Web Crypto 非対応時はリロードせず `WEBCRYPTO_UNSUPPORTED` へ正規化）、一時 `X25519` 鍵ペアと `ECDH + HKDF-SHA256` による方向別 `c2sKey` / `s2cKey` を派生して `POST /api/auth/login` を `c2sKey`（`MINI_APP_LOGIN_REQUEST_AAD`、排他的 `{ handshakeId, password }` または `{ handshakeId, totpCode }`）で暗号化送信します。`miniAppInFlightHandshakeIds` が並行リプレイを遮断し、`handshakeId` は消費・失敗と同時に即破棄され、`200`/`403` 応答はいずれも `s2cKey`（`MINI_APP_LOGIN_RESPONSE_AAD`）で暗号化返却（平文ダウングレード拒否）し、シリアライズ直後に `pendingSessionKey` を消去、TOTP 単一ステップ検証成功かつセッション発行成功後にのみ `miniAppLastConsumedTotpStepHolder` を記録します。メインスレッドは最大 `MINI_APP_SESSION_MAX`（`5`）件の未期限切れ 45 分セッションと 256-bit 鍵を保持し（満杯時の新規ログインは発行または直近の更新から最も時間が経ったセッションを追い出し、そのダウンロード票も失効）、各世代の次回更新・鍵ローテーション待機時間は `[MINI_APP_SESSION_REFRESH_MIN_MS, MINI_APP_SESSION_REFRESH_MAX_MS]`（5 秒～5 分）から一様ランダムに抽出され、さらに `seenRequestIvs.size` が `MINI_APP_SESSION_ROTATE_AT_SEEN_IVS`（3,072）水位へ先に達した場合も暗号化応答ルートで能動的に更新して新世代の IV 集合とランダム待機時間を再設定します（いずれも 5 分間の並行猶予 `MINI_APP_SESSION_PREVIOUS_GRACE_MS` とは独立）、スライディング更新の絶対寿命上限は `MINI_APP_SESSION_MAX_LIFETIME_MS`（2 時間、アクティブ中は `initData.auth_date` を `2 時間 + 45 分` まで許容）に制限されます。`sessionKey` は `POST /api/auth/login` と暗号化応答スライディング更新（`X-Mini-App-Session-Key`、`additionalData = UTF8(newToken)`）でのみ発行され、クライアントは IndexedDB（同世代の `{ token, cryptoKey }` 組、復元時はこれを正とする）と `sessionStorage`（メタデータ）のみに保持して HTTP や `globalThis` へ一切出しません。更新コミット時にサーバーは共有の封印ハンドル `sealedSessionKeyPromise`（封印済み暗号文のみへ解決し `pendingSessionKey` には書き込まない）を同期起動して確定後に `sealedSessionKey` へ格納し、新トークン確認または猶予満了まで保持します。その間 `previousToken` を携えた暗号化応答ルートの要求は同一の `sealedSessionKeyPromise` を待機するか確定済み `sealedSessionKey` を参照し、再更新せず同じ新トークンと暗号文を付け直します。
  - **業務 JSON 封筒・バイナリ暗号化アップロード・`?e=` URL クエリ・二段階アトミック確定**：セッション必須の業務 JSON ルートは Web Crypto `AES-GCM`（`MINI_APP_AES_GCM_IV_BYTES` IV、`MINI_APP_AES_GCM_TAG_BITS` タグ、方向 AAD は `buildMiniAppEnvelopeAad` による `"${method} ${routePath}:req"` / `":res"`）の `MiniAppEncryptedEnvelope` で、`POST /api/gallery/upload` は `[12B IV || 暗号文+16B タグ]` 生バイナリフレームでリクエストを暗号化し、`GET`/`HEAD` 以外の暗号化ルートは `0` バイト空ボディを拒否します（無負荷 POST/DELETE は暗号化 `"{}"` を送信）。全 `encryptRequest: true` ルートの非空クエリ文字列は単一パラメータ `?e=<ivBase64>.<cipherBase64>`（`MINI_APP_ENCRYPTED_QUERY_PARAM`、上限 `MINI_APP_MAX_ENCRYPTED_QUERY_LENGTH`、`additionalData = "${method} ${routePath}"`）のみを許可し、裸の `?`・平文/過剰クエリ・空/`?` 始まり復号結果・重複 IV を拒否します（同一鍵エポック `seenRequestIvs` ハード上限 `MINI_APP_SESSION_MAX_SEEN_REQUEST_IVS` = 4,096、`MINI_APP_SESSION_ROTATE_AT_SEEN_IVS` = 3,072 水位で暗号化応答ルートから能動ローテーションし IV 集合と更新間隔をリセット、上限超過時 `401`＋セッション失効）。`runMiniAppAuthorized` は「読み取り専用 `authorizeMiniAppRequest` → 非同期復号 → `commitMiniAppSessionAccess`（アクティブ再検証・IV 登録・旧鍵破棄・スライディング更新のアトミック実行）」の二段階確定で TOCTOU 競合を遮断します（並行同 IV リプレイは `400`、復号中のセッション失効は `401 SESSION_EXPIRED`、復号中に並行要求でトークンが更新・確認された場合は `lineageId` で生存セッションを特定し照会時の鍵世代の IV 集合で更新なしに確定、復号失敗 `400` は `previousToken` を維持）。クライアントは暗号化応答ルートで本文の復号・検証を完了してからローテーションヘッダーを取り込み、`packages/mini-app-frontend/api/authError.ts` で送信時セッショントークンの非公開 `Symbol` 文脈を例外へ付与した上で、再認証エラー（`MINI_APP_SESSION_REAUTH_ERROR_CODES`・復号/開封失敗・裸 `401` → 一致するローカル資格情報を消去し `AuthGatePage` へ遷移）と第 1 層ゲート拒否（`MINI_APP_ACCESS_DENIED_ERROR_CODES` のうちセッション非依存項目は無条件消去、セッション延長窓に依存する `MINI_APP_EXPIRED_AUTH_DATE_CODE` はトークン一致時のみ消去して `checking` 再プリチェック経由で `AccessDeniedPage` へ遷移）を統一処理します。新世代へ更新済みの旧トークンによる遅延再認証・`EXPIRED_AUTH_DATE` 応答は通信層およびグローバル通知層双方で抑止して新セッションの誤消去・誤ロックを防ぎ、現在セッションに対するリダイレクトは古い要求番号ガードで握り潰さず、遅延到着の `401` でも `password` へ戻しません。
  - **ダウンロード二経路と非暗号化境界**：セッション保護された `/api/*` ルートで `encryptResponse: false`（応答非暗号化かつ鍵ローテーションなし）が許されるのは `GET|HEAD /api/gallery/file`（`MINI_APP_GALLERY_FILE_AUTH_POLICY`：ヘッダー認証＋`?e=`、7 日間 `MINI_APP_GALLERY_FILE_CACHE_CONTROL`・`CDN-Cache-Control: no-store`・`Vary: MINI_APP_GALLERY_FILE_VARY_HEADER_VALUE`・`ETag` `304`）と `GET|HEAD /api/gallery/download`（`MINI_APP_GALLERY_DOWNLOAD_AUTH_POLICY`：ブラウザフォールバックはヘッダー認証＋`?e=`、Telegram ネイティブ `WebApp.downloadFile` は暗号化 `POST /api/gallery/download-ticket` が発行する 60 秒単回限定 64-hex `?ticket=`、FIFO 上限 `MINI_APP_DOWNLOAD_TICKET_MAX` = 64、`HEAD` 非消費、`GET` 即消費、ログイン中不変のセッション系譜 `sessionLineageId` に紐付け——セッション更新を跨いで有効を維持し、ログアウト/ロック/期限切れ/追い出し/IV 上限/認証器変更/画像削除時に系譜単位で即時失効）に限定されます。`/api/auth/precheck`・`/api/auth/logout`・SPA/チャンク・`/healthz`・`/favicon.ico`（`MINI_APP_ASSET_CACHE_CONTROL`）は全工程非暗号化、`POST /api/auth/login` は一時 ECDH（`c2sKey`/`s2cKey`）、`POST /api/gallery/upload`（`MINI_APP_GALLERY_UPLOAD_AUTH_POLICY`）はリクエスト（バイナリ）と応答（JSON）双方を `sessionKey` で暗号化します。
  - **セッション暗号化直保存・内容ブラックリスト管理・設定保存事前検査**：`POST /api/configs/save`（`MINI_APP_CONFIG_SAVE_AUTH_POLICY`、外層上限 `MINI_APP_MAX_CONFIG_BODY_BYTES`）はセッション 256-bit 一時鍵の `AES-GCM` 封筒内で直接 `{ scope, fileName, content }` を受け取ります。`saveMiniAppConfigFile` はメインスレッド共通の直列チェーン `deploymentConfigWriteChainHolder`（`packages/cache/main/configWrite.ts`）上で `runSerialChain`（`packages/libs/serialChain.ts`）により検証とアトミック書き込みを直列化し、`agent.json` ↔ `cron.json` などの並行保存によるファイル間検査・上書き競合を排除します。書き込み前に `MINI_APP_DYNAMIC_CONFIG_FILES` / `MINI_APP_STATIC_CONFIG_FILES` ホワイトリスト、各ドメイン厳密パーサー（`g-auth.json` は起動時と共通の `parseGoogleServiceAccountKey` を使用）、`database/storage.sqlite` 存在時の `bot.json` `time_zone` 不変性、`agent.json` ↔ `cron.json` の双方向依存検査（ディスク上の対向ファイル優先）、および非シンボリックリンク検査（`inspectOptionalFile`）を通過させます。内容ブラックリストタブ（`adBlacklists`）の `GET|POST /api/ad-blacklists` と `GET /api/ad-blacklists/preview`（いずれも `MINI_APP_API_AUTH_POLICY`）も同一のセッション暗号化境界で保護されます：`GET /api/ad-blacklists` は `listAdPackBlacklistPage` により SQLite カーソルをコールドリード（未 ACK 書き込みを重ね合わせ、メインスレッドの 768 件 LRU キャッシュを汚染しない）し、`POST /api/ad-blacklists` は `/ad_detect sticker|emoji` と共通の `packages/infra/adPackBlacklistStorage.ts` を通じてパック名検証・自用パック保護・768 件 LRU ライトスルーおよび Anti-Raid 件数同期を適用します（件数上限なし）。`GET /api/ad-blacklists/preview`（`packages/mini-app-api-server/view/adBlacklistsPreview.ts`）はメインスレッドの `telegramApi.getStickerSet` でメタデータを取得し `MINI_APP_AD_BLACKLIST_PREVIEW_PAGE_SIZE`（16）件単位で切り出し、`metaOnly=1` ではメタデータと `hasImage` のみを返し、`metaOnly=0` では `runBoundedSettledBatch`（同時数 `MINI_APP_AD_BLACKLIST_PREVIEW_DOWNLOAD_CONCURRENCY` = 4、1 件上限 `MINI_APP_AD_BLACKLIST_PREVIEW_ITEM_MAX_BYTES` = 512 KiB、一括タイムアウト `MINI_APP_AD_BLACKLIST_PREVIEW_BATCH_TIMEOUT_MS` = 15 秒）と `downloadTelegramFileBytes`・マジックバイト判定で静的サムネイルをインライン `data:image/...;base64,...` として返却します（`request.signal` による途中キャンセルを伝播し、個別失敗は `null` へ縮退）。

### データルートとバックグラウンドタスク

- **プロジェクトルートとデータルートの導出**：
  - プロジェクトルートはソース実行時はモジュール位置、バイナリ実行時は作業ディレクトリから決定され（埋め込み Worker エントリは `packages/consts/paths.ts` に集約）、`bot.lock`・`logs/`・`memory/`・`database/` はすべて `RUNTIME_DATA_ROOT`（既定値 `PROJECT_ROOT`）から導出されます。テスト preload は import 前に isolate ごとの一時データルートを注入します。
- **低優先度のグループタイトル保守タスク**：
  - コマンドメニュー、`bot.init()`、Worker hydrate、update runner の起動完了後にバックグラウンドで開始され、`runBoundedSettledBatch`（並行上限 `CHAT_TITLE_REFRESH_CONCURRENCY`）で各グループの `getChat` を独立実行します。
  - **到達不能分類**（`infra/telegram/errors.ts` の `classifyChatAbsence`）：
    - `gone`：HTTP 400 で説明が `CHAT_GONE_DESCRIPTION_PATTERN`（`chat not found` または `group chat was upgraded to a supergroup chat`）に一致するもの、または `parameters.migrate_to_chat_id` を伴うもの。
    - `departed`：HTTP 403 で説明が `BOT_DEPARTED_DESCRIPTION_PATTERN`（`bot was kicked from the (super)group chat` または `bot is not a member of the (super)group chat`）に一致するもの。
    - その他のエラーはログ記録のみを行います。
  - **複数回確認と停止時即座解除**：到達不能グループは `CHAT_ABSENCE_CONFIRM_INTERVAL_MS` 間隔で初回を含め `CHAT_ABSENCE_CONFIRM_ATTEMPTS` 回照会し、全回同一分類となった場合のみ `completeChatDeparture` で後始末して warn を 1 行記録します。待機中は `chatTitleRefreshRuntime.absenceConfirmation` を監視し、停止時の quiesce / abort で即座に待機を解除します（進行中の `getChat` は保守予算内で確定します）。

### 送信リクエストとメッセージの安全性

- **メインスレッド専有の Telegram ネットワーク境界**：
  - **単一の送信パイプライン**：grammY `Bot` インスタンス、Bot API HTTP、CDN ダウンロードはすべてメインスレッドにのみ存在します（`bot.api`、`ctx.api`、`ctx.reply` は `initTelegramClients` の共通 transformer を通過し、`getUpdates` ロングポーリングのみ `app/updateFetcher.ts` が直接管理します。キャンセルシグナルは `libs/telegramSignal.ts` がコピーなしで適合させます）。
  - **Worker プロキシと結果射影**：
    - AI / Anti-Raid Worker は `supervisedDuplexWorker` の `TelegramWorkerApi` ホワイトリストのみを呼び出せ（Anti-Raid Worker の `downloadFile` は `purpose === "vision"` のみ許可）、Bot トークンや `mainClient.ts` は一切 import しません（`bun run check:conventions` が import 閉包を検証）。`copyMessage`、`deleteEphemeralMessage`、`editMessageText`、`sendEphemeralMessage`、`unbanChatSenderChat` はメインスレッド専用です。
    - Worker の送信系呼び出し（`sendMessage`、`sendSticker`、`sendPhoto`、`sendVoice`）は、メインスレッドのプロキシ境界（`infra/telegram/workerRequests.ts` の `markWorkerSentMessage`）がレスポンスの `chat.id` と `message_id` を自己送信表へ先に登録したうえで、`TelegramSentMessage`（ID・返信リンク、および `sendPhoto` の `pickPhotoSize` 画像 1 件）のみを Worker へ返します。
  - **アバター・外部 URL 取得の上限とオリジン制約**：
    - アバター・ファイル取得は `runTelegramCategorizedRequest` を通り、タイムアウト（`DEFAULT_AVATAR_FETCH_TIMEOUT_MS` / `AVATAR_FETCH_TIMEOUT_MS`）とバイト上限（`AVATAR_MAX_DOWNLOAD_BYTES`、`PUBLIC_PROFILE_PAGE_MAX_DOWNLOAD_BYTES`、`DEFAULT_AVATAR_MAX_READ_BYTES`）を強制します（CDN・`t.me` 公開プロフィール取得はリダイレクト禁止かつ `TELEGRAM_PUBLIC_ASSET_HOST_SUFFIXES` に限定、汎用 JSON API は `JSON_API_ALLOWED_ORIGINS` の HTTPS オリジンに限定）。

- **トークンバケット送信スケジューラとカテゴリ別 429 バックオフ**：
  - **チャット別送信スケジューラ**（`infra/telegram/sendScheduler.ts`、状態は `cache/main/telegramSend.ts`）：
    - チャットメッセージを生成する呼び出し（`isTelegramMessageRequest`）のみが入り、チャット別バースト（`TELEGRAM_SEND_CHAT_BURST` / `TELEGRAM_SEND_CHAT_REFILL_MS`）、グループ枠（`TELEGRAM_SEND_GROUP_LIMIT` / `TELEGRAM_SEND_GROUP_WINDOW_MS`）、全体枠（`TELEGRAM_SEND_GLOBAL_LIMIT` / `TELEGRAM_SEND_GLOBAL_WINDOW_MS`）をすべて満たした瞬間に送出します（同一チャット内は FIFO 1 本・実行中最大 1 件）。
    - 待機キュー上限（グループ別 `TELEGRAM_MESSAGE_GROUP_PENDING_MAX`、個人チャット別 `TELEGRAM_MESSAGE_PRIVATE_PENDING_MAX`、全体 `TELEGRAM_MESSAGE_GLOBAL_PENDING_MAX`）を超えた新規要求は `TelegramSendQueueFullError` で即座に拒否されます。
  - **429 バックオフの故障隔離**：
    - メッセージ送信が HTTP 429 を受けると**該当チャットの FIFO のみ**が `retry_after` 停止し（復帰後 `TELEGRAM_SEND_CHAT_CAUTIOUS_MS` の間はバースト 1 に制限）、他チャットは通常通り送信を続けます（AI バックプレッシャーは `message` カテゴリの `activeCount` と `pendingCount` を参照します）。
    - 非メッセージ系カテゴリ（`inline`、`download`、`externalFetch`、`kick`、`query`、`restrict`、`delete` 等）は独立した FIFO と `retry_after` を持ち、全体リトライ待機上限 `TELEGRAM_429_RETRY_QUEUE_MAX`（初回 `admissionSeq` 順を維持、復帰時は 1 件 probe 後に最大 `TELEGRAM_429_RECOVERY_MAX_CONCURRENT` まで拡大）で制御されます。
    - `download` は `getFile` と Telegram ファイル CDN 専用であり、既定アバター URL や `telegram.me` 公開プロフィール・アバター取得は `externalFetch` を使うため、外部ホストの 429 が Telegram メディア取得を止めません。新規バックオフ開始時のみ warn を 1 行記録します。
  - **タイムアウト・キャンセル・世代失効**：
    - 呼び出し側の予算切れは `TimeoutError`、停止時の撤回や呼び出し側キャンセルは `AbortError` を返します（`infra/telegram/fileDownload.ts` は段階別タイムアウトを `metadataTimeout` / `downloadTimeout` として返し、外側キャンセル・予算切れは例外を送出します）。
    - 送信ゲートは世代管理された `AbortController` を合成し、drain 予算超過時は実行中リクエストの abort・429 タイマー解除・待機ノード reject を一括実行します。

- **エコーループ防止と自己送信ランデブー**：
  - Bot 自身の送信メッセージはプロキシ境界で `SELF_SENT_MESSAGE_TTL_MS` の間記録されます。
  - チャンネル投稿や自動転送を受信し得る自動応答入口（`auto/message/index.ts`、`commands/cjkAction.ts`、`commands/qa/ingress.ts`）は、同期 `isBotOwnMessage` に加えて `needsBotOwnMessageWait` + `waitForBotOwnMessage` を通過します（対象チャットに `beginSelfSentSend`〜`endSelfSentSend` 間の進行中送信がある場合のみ最大 `SELF_SENT_RENDEZVOUS_TIMEOUT_MS` 待機します）。

- **送信リッチテキストの安全性（`SendMessageFormat`）**：
  - 書式付き送信は次のいずれか一方のみを使用します（両方省略時は純粋な平文送信）：
    1. **明示的 `entities` 配列**：UTF-16 コード単位オフセットで構築し、長さ 0 の entity を禁止します。
    2. **`MARKDOWN_V2_PARSE_MODE`（`MarkdownV2`）**：表示名・モデル出力・設定文言などの動的文字列はすべて [`libs/telegramMarkdown.ts`](../../packages/libs/telegramMarkdown.ts) で挿入文脈（本文、`code`/`pre`、リンク URL）ごとにエスケープします。パース失敗時は統一エラーログに記録し、未エスケープ平文へのフォールバックは行いません。

- **コマンド文字列ガード（`containsRenderableCommand`）とオウム返し単一出口**：
  - Bot が生成・変換した全送信文字列（オウム返し、AI の `send_message` 本文・誤字版・`generate_image` キャプション、`libs/webDigest.ts` の Web 要約項目）は `libs/renderableCommand.ts` の `containsRenderableCommand`（`RENDERABLE_COMMAND_PATTERN`）を通過します（AI ツール該当時は再試行可能な `toolError` を返し、誤字版該当時は誤字のみ抑止し、オウム返しは変換前後とも検査して該当時に破棄します）。
  - オウム返しの送信出口は `copy/echo.ts` の `sendEchoPayload` 1 か所に集約されます（純テキストと有料メディア本文は `sendMessage`、その他メディアは `copyMessage` でサーバー側複製し、`sendEchoPayload` 以外での `copyMessage` キャプション差し替えは `bun run check:conventions` が禁止します。翻訳は `translate/message.ts` が訳文のみを `sendMessage` します）。

- **`/mute` の期間境界とディスパッチ期限**：
  - `/mute` の期間は `[MUTE_MIN_DURATION_MS, MUTE_MAX_DURATION_MS]`（無期限扱いとなる `TELEGRAM_RESTRICTION_FOREVER_AFTER_MS` 未満）に制限されます。
  - `muteChatMemberWithOutcome` は必須の `dispatchTimeoutMs`（連投ミュートは `FLOOD_MUTE_DISPATCH_TIMEOUT_MS`、`/mute` は `期間 - MUTE_DISPATCH_MIN_REMAINING_MS`）を受け取り、429 待機中に期限切れとなったリクエストを送出前に断念します。

- **グループ内非機能通知の 30 秒自動削除（`COMMAND_MESSAGE_AUTO_DELETE_MS`）**：
  - バリデーション失敗、権限拒否、使い方案内、操作レシートは `sendCommandMessage` 境界を通じ `COMMAND_MESSAGE_AUTO_DELETE_MS` 後に自動削除されます（個人チャットは対象外）。
  - **長期保持が許可される出力**：`/permission help`・`/permission query` ボード、`/qa query` ボード、Q&A 直接応答、成功した漢字アクション結果、`/h_image` 画像、`cron.json` 定時送信、および会話出力（Copy、翻訳、AI 返信、入浴返信）。
  - **状態機械所有のメッセージ**：参加認証ボタン、`/qa set` フォーム、`/wed` 結果カード、gag 告知・発言案内は固定タイマーを持たず、ボタン操作・状態遷移・teardown のみが削除します（セッション窓から押し出された `/wed` カードはグループに残ります）。

- **フォーラムトピック（`message_thread_id`）のルーティングとバックグラウンドスコープ隔離**：
  - **ユーザー操作起因のメッセージ**：コマンド応答、状態機械フォーム、会話出力はトリガーメッセージの `message_thread_id` に着地します（`app/updateRunner.ts` が `libs/forumTopic.ts` の `updateTopicOf` で記録し、メインスレッド送信境界の `updateTopicThreadIdFor` や遅延キューが引き継ぎます）。
  - **Bot 自発通知と定時タスク**：連投ミュート告知、広告警告・BAN 告知、参加認証リマインダー、ロックダウン告知、および `cron.json` タスクは `message_thread_id` を付与せず、フォーラムグループでは General に着地します。
  - **非同期バックグラウンド処理・タイマー・キューの update スコープ離脱**：バックグラウンド処理やタイマー（`packages/copy/avatarQueue.ts`、`packages/infra/telegram/actions/messageLifecycle.ts`、`packages/commands/gag/refresh.ts`、`packages/translate/message.ts`）は `packages/infra/updateContext.ts` の `runOutsideUpdateScope` 経由でトリガー元 update の `AsyncLocalStorage` コンテキストを完全に離脱し、トリガー元の `AbortSignal` やフォーラムトピックを引き継ぎません（独自の停止境界や捕捉済みトピックを復元したいタスクは `commands/wed/runtime.ts`、`commands/deferredCommands.ts`、`commands/deleteMessage/queue.ts` のように明示的に `runWithUpdateAbortSignal` へ入ります）。

- **トグルコマンドの応答整合性と `/init disable` 順序**：
  - `/init`、`/ai_chat`、`/ad_detect`、`/flood_control`、`/antiraid`、`/translate`、`/white` などのトグルコマンドは変更前に現在値を確認し、既に目標状態であれば「既にその状態です」と応答します（`ToggleCommandTexts` / `toggleReplyText`）。
  - `/init disable` と Mini App のグループ `init` 無効化は `packages/infra/botAdmin.ts` の `disableManagedChat` を共有し、まず無効化フラグを永続化してから `teardownChatRuntime`（記憶・翻訳・`/wed`・入室ログ・Q&A の削除）を実行し、最後に `purgeChatStateExceptLockdown` 後の状態を再度 `persistChatState` して行を削除 tombstone 化します（未登録グループへの disable は新規行を作成しません）。

<p align="right"><a href="#クイックナビゲーション">↑ クイックナビゲーションへ戻る</a></p>

## Worker と状態の所有権

### スレッドと状態の帰属

- **共有メモリを持たない厳格なスレッド境界**：
  - **メインスレッド**：Telegram update runner、Worker 監視ハンドル、グループ別 `chat_states` ホットスナップショット（`packages/infra/chatStateStorage.ts`）、広告パックブラックリストの 768 件共有 LRU 読み取りキャッシュ・件数統計・未 ACK 書き込み管理（`packages/cache/main/adPackBlacklist.ts` および `packages/infra/adPackBlacklistStorage.ts`）、および `memory/global/state.json` のメモリミラー（`cache/main/storage.ts`）を所有します。
    - `infra/storage/stateStore.ts` は `memory/global/state.json`（`copy` と `ttsUsage`）の業務 facade であり、グループ別状態は `infra/chatStateStorage.ts` が Disk I/O Worker 経由で SQLite `chat_states` に永続化します。
    - `infra/storage/statePersistence.ts` の `StateStore` は `decodeGlobalStateFile`（`libs/stateFileCodec.ts`）による厳密デコード、最新値合流アトミック書き込み、上限付きバックオフ再試行（`STATE_SAVE_RETRY_DELAYS_MS`、`STATE_SAVE_MAX_ATTEMPTS`）、終了時 flush を担います。
    - 再試行タイマー待機中は通常の書き込み・非停止時 flush をそのタイマーに委ねて前倒し実行せず、停止時 flush はタイマーを解除し、予算が正なら即座に書き込みます。予算が 0 のときは新たに書き込まず、未書き出しまたは書き込み中の値が残っていれば `timedOut`、どちらもなければ `flushed` で決着します。再試行上限超過は fatal 障害として直ちに runner を停止します。
  - **AI Worker**：グループ会話のローリングメモリ、返信受付判定、マルチモーダルメディア記述パイプライン、全グループ共通の mood、スタンプカタログ生成状態を排他所有します。
  - **Anti-Raid Worker**：参加認証・ロックダウンの状態機械とタイマーを排他所有します（メインスレッドはクラッシュ復元用ミラーのみを保持）。
  - **Disk I/O Worker**：SQLite（`database/storage.sqlite`）、ログ、AI メモリ、スタンプカタログ、運勢、参加認証待ちデータの永続化を排他所有し、共有ディレクトリへの I/O を単一スレッドで直列化します（`memory/global/`、`memory/mini-app-totp/totp.json`、およびホワイトリスト内の `config/{dynamic,static}/*.json`——Mini App 設定エディタの `mini-app-api-server/view/configs/storage.ts` のみが `deploymentConfigWriteChainHolder` 上で直列にアトミック更新し、広告検出・自動ブラックリスト化は `config/dynamic/ad_detect.json` を一切書き換えません——のみメインスレッドがアトミック更新し、業務 Worker は共有ディレクトリを直接読み書きしません）。
  - **長寿命コンテナ契約**：`packages/cache/` 配下のすべての Map・Set・キュー・タイマーは、所有者・投入と削除の契機・容量上限・Worker 再構築規則を明記します。

- **ディレクトリ構造によるキャッシュ所有権宣言と静的検証**：
  - `packages/cache/` 直下の第 1 階層が所有スレッドを定義します：`main/`（メインスレッド専有）、`workers/aiChat/`・`workers/antiRaid/`・`workers/diskIO/`（各 Worker 専有）、`perThread/`（各 isolate 独立インスタンス）。
  - 全キャッシュファイルの先頭行は `/** owner: <main|perThread|workers/<スレッド>>。` で始まり、`bun run check:conventions` が各エントリ（`index.ts` と各 `*Worker.ts`）からの実行時 import 閉包をたどって越境 import を検出します。
  - 越境例外は `CACHE_OWNER_EXEMPTIONS`（現在は空）でのみ許可されます。`infra/logger.ts` は `infra/diskIO.ts` を静的に import せず、設定済み `log_level` 以上を満たすメインスレッドのログは `cache/perThread/logger.ts` の `logRelaySink`（`initDiskIO` が `relayLogMessage` を注入）経由で、Worker のログはメインスレッドへのバッチ転送経由で Disk I/O へ渡します。

- **Worker へは解決済みの最終値のみを渡す**：
  - Worker が必要とするメインスレッド状態は事前解決済みの値として送信します（例：`SUPER_ADMIN_USER_ID` は `init` ペイロードで渡し、`config/bot.ts` は import しません）。
  - Telegram アクションは最小限のホワイトリストペイロードのみを送り、高頻度のグループメッセージ経路には request/reply 往復を入れません。

- **IPC 障害処理と受理済みログ（`>= log_level`）の 2 ホップ ACK 転送**：
  - 同期 `postMessage` 失敗時は request の waiter / timer を即時解除し、重要ディスパッチの失敗は fatal 停止とします。
  - **2 ホップ ACK パイプラインとメインスレッド緩衝**：第 1 ホップ（業務 Worker → メインスレッド、最大 `LOGGER_FORWARD_BATCH_MAX_MESSAGES` 件 in-flight）と第 2 ホップ（メインスレッド → Disk I/O Worker、最大 `DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES` 件 in-flight）はともに下流 ACK までバッチを保持します。`info`・`operation`・`warn` ログはメインスレッドの `diagnosticQueue` で `DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES` 件到達または `FLUSH_INTERVAL_MS`（30 秒）経過までバッファされ、`error` ログ・ドロップ要約・非ログ診断（`adSample` / `aiCacheUsage`）・明示的 `flushDiskIO()` / `flushDiskIODomain("log")` は即時フラッシュされます。Worker 再生成時は未 ACK の送信中バッチのみを回復直後に再送し、未満窓の通常ログは元のバッファ窓を引き継ぎます（Disk I/O はディスク flush 完了後にのみ ACK し、書き込み失敗時の reopen バックオフを新着ログが迂回することはありません）。
  - **背圧上限**：Worker 側は `LOGGER_FORWARD_MAX_PENDING_MESSAGES` 件・`LOGGER_FORWARD_MAX_SERIALIZED_BYTES` バイト、メイン → Disk I/O 側は `DISK_DIAGNOSTIC_MAX_PENDING_MESSAGES` 件・`DISK_DIAGNOSTIC_MAX_SERIALIZED_BYTES` バイトを上限とし、超過分は破棄カウンタのみを加算して回復時に要約を 1 件記録します（受理されたログは転送前に発信スレッドの対応コンソール出力へ書き出し済みです）。

- **並行バッチ処理の原則**：
  - 並行バッチで生の `Promise.all` は使用しません。独立した固定タスクは `Promise.allSettled` で個別に結果を集約し、可変長入力は `runBoundedSettledBatch` で並行数を制限しつつ元の `item` / `index` 対応を保持します。
  - 下位層（Telegram 送信ゲート等）が再試行を担う操作に対し、呼び出し側で外側の再試行ループを重ねません。

- **Disk I/O の runtime recovery ハンドシェイク**：
  - **不可分な世代スコープ復元**：データ読込後、各ドメインが登録順に現世代 transport でミラーを replay（非同期処理をすべて `await`）し、続いて復旧窓の業務 FIFO を排出してから `writable` を公開します。
  - **`storageFlushHold` による保留と集約検証**：
    - ミラー replay 前後に `storageFlushHold` の開始・終了マークを送ります。開いている間、自動バッチ／定時 SQLite コミットはタイマー待機となり、AI 記憶削除と purge 直後の初回スナップショットも保留され、`chat_states`（管理上限・`/send` 一意性）および `chat_qa`（グループあたり上限）の行横断検査は終了マークまで遅延されます。
    - 終了マーク時点で保留中の AI 記憶操作を即時コミットし、集約制約を検証します。違反があったドメインは保留書き込みを破棄して `recoveryReplayFailed` を返し、メインスレッドを fatal 停止させます（正常ドメインは 1 トランザクションでコミットされ、明示的 flush は hold をバイパスします）。
  - **厳格な失敗伝播と `recoveryReplay` 境界**：replay リスナーの `false`・例外・タイムアウト・送信失敗はその世代を即座に終了させて fatal 停止とし、永続化必須の呼び出し側は `false` で update の offset 確認を留保します。また、復旧 FIFO 排出区間を囲む `recoveryReplay`（`RecoveryReplayRequest`）内で拒否が発生した場合、後続バリアが存在しないため即座に `recoveryReplayFailed` を返して統一 fatal 停止とし、最後の確定点から再配信させます。

- **メインスレッド → Disk I/O 業務 transport の有界制約**：
  - 待機中＋送信中の業務メッセージは `DEFAULT_MAX_PENDING_BUSINESS_MESSAGES` 件・`DISK_BUSINESS_MAX_RETAINED_BYTES` バイトを上限とし、制御用に `DISK_OPERATION_CONTROL_RESERVE` 枠を確保します。
  - 送信中バッチは最大 `DISK_BUSINESS_BATCH_MAX_MESSAGES` 件の 1 バッチのみ、Worker 直列キューは最大 `DISK_WORKER_MAX_QUEUED_OPERATIONS` 件とし、Worker 内の定時バッチ flush は `workers/diskIO/timedFlush.ts` が 1 操作に集約します。
  - バッチ ACK は transport 枠を解放し（`DISK_BUSINESS_ACK_TIMEOUT_MS` 超過や容量超過は fatal 停止）、ドメイン ACK は永続化完了を示します。Worker 再生成時は業務 FIFO を維持し、read waiter を失敗精算したうえで、ミラーが覆う古い書き込みのみを revision 水位と object marker で除外します。

- **Worker 起因グループ通知の送信・自動削除集約**：
  - AI レート制限通知、ロックダウン解除、参加認証通知、連投ミュート告知はすべて `sendTemporaryMessageFromMain` を経由し、`onSent` 内で `COMMAND_MESSAGE_AUTO_DELETE_MS` の `unref()` 削除タイマーを登録してからメッセージ ID を Worker へ返します（認証ボタンと `/qa set` フォームは状態機械管理、inline 運勢は inline API を使用します）。

- **他 Bot 発言のメインスレッド入口レート制限**：
  - `app/registerHandlers.ts` は業務 dispatch 前に `shouldPassBotMessage`（`infra/botMessageGate.ts`）を実行し、`sender_chat` を持たない `message.from.is_bot === true` のみを検査します（チャンネル名義、非メッセージ update、本 Bot 自身、および該当グループの `/delete_message` 対象はカウントせず通過させます）。
  - 他 Bot は全グループ横断で ID ごとに集計され（最大 `BOT_MESSAGE_ACTIVITY_MAX_ENTRIES` 件、満杯時の新規 ID はタイマーを作らず破棄）、最初の `BOT_MESSAGE_ACTIVITY_LIMIT` 件のみ通過させて `BOT_MESSAGE_ACTIVITY_TTL_MS`（`unref()`）を延長し、超過分は静かに破棄します。

- **Update dispatch チェーンとゲート設計**（`app/registerHandlers.ts`、`app/updatePreamble.ts`）：
  - **コマンドゲートの集約**：全スラッシュコマンドは `:entities:bot_command` フィルタ配下の子 `Composer` に集約し、コマンド entity のない通常メッセージは即座にスキップします。
  - **単一 `bot.use` による前置継続チェーン**：
    - `app/registerHandlers.ts` は単一の `bot.use` のみを登録します（直接の `bot.on` 登録がないことを `test/app/registerHandlers.test.ts` が検証し、`registered-middleware` ホットパスゲートが計測します）。
    - `update_id` 記録と Bot 流量制限の後、`app/updatePreamble.ts` の継続チェーンを固定順で進みます：運勢レシート → `/init`・非公開ゲート（未初期化グループは退出メンバーの `/wed` 除外のみ実行）→ グループ移行処理（`migrate_to_chat_id`）→ `/wed` メンバー観測 → 身分バッチプリフェッチ → Mini App ピッカー応答（`users_shared` / `chat_shared`）・プライベートチャット `/send` 中継 → 4 つの受理型 ingress（Anti-Raid → `/delete_message` 対象 → gag → `/qa set`）→ スラッシュコマンド `Composer` → 漢字アクション `Composer` → 通常メッセージ処理 → 非メッセージ update `Composer`（未受理時のみ外側 `next` を 1 回呼び出します）。
    - **`chatState` の再読込規律**：`getChatState` は `/init` ゲートで 1 回読み取って同期継続へ引き回し、すべての `Promise` 再開点（身分プリフェッチ、非同期 ingress、各 `Composer` の `next`、自己送信待機）では待機中の `/init disable` や teardown を反映するためキャッシュから現在値を読み直します。新規前置段は必ずこの継続チェーン内に挿入します。
  - **メッセージ入口判定の統一**：`message` / `channel_post` は `ctx.msg`（`message ?? channelPost`）を直接判定し、漢字アクションは先頭文字が `SLASH_CHAR_CODE`（`'/'`）であることを確認してから `CJK_ACTION_COMMAND_PATTERN` を照合します。
  - **同期 `boolean` vs `Promise<boolean>` 契約**：
    - 各 ingress と管理者判定は定常状態では同期 `boolean` を返し、権限照会・削除・耐久書き込みが必要な場合のみ `Promise<boolean>` を返します（`/delete_message` 対象 ingress はキュー投入のみで常に同期 `boolean`）。
    - `callback_query:data` の `claimOrContinue` と非 `async` な `dispatchCallbackQuery` も同様に、`/wed` と `/qa query` がともに同期 `false` なら `Promise` を作らず直接 `next()` を呼びます。
    - 永続化完了が update 確認境界となる入口（入退室サービスメッセージ、認証ボタン）は必ず `Promise` を返します。

- **`packages/workers/` 内の自前タイマーは必ず `unref()` する**：
  - Worker 内の独自タイマーが単独で isolate のイベントループを維持してはなりません（順序付き停止は内部の drain / flush 完了後にメインスレッドが `terminate` します）。
  - 共有ライブラリの短命な待機タイマー（`libs/sleep.ts` のシグナル付き分岐、`libs/drainWaiter.ts`）は呼び出し側の `abort` または `clearTimeout` が寿命を管理するため `unref()` しません。
  - `bun run check:conventions`（`scripts/conventions/workerTimers.ts`）が `packages/workers/` 配下の全 `setTimeout` / `setInterval` を AST 検査し、変数・プロパティへの代入と同一関数内での `<代入先>.unref()` 呼び出しを強制します（`return setTimeout(...)` などの未保持呼び出しは拒否され、メインスレッドは対象外です）。

### 状態機械の contract

- **状態機械と業務 I/O の分離**：
  - 状態機械の型（`State` / `Event` / `Effect` / `Transition` / `Decision`）は `packages/types/states/` が所有し、`packages/states/` は I/O を一切含まない純粋遷移関数のみを実装します。
  - 直接・間接の実行時依存は `consts`・`libs`・`types`・`states` に限定され、`scripts/conventions/moduleBoundaries.ts` が実 import グラフ全体を追跡します（`libs/time.ts` が参照する `config/time.ts` のみが `STATES_CLOSURE_OPAQUE_MODULES` の登録済み例外です）。
  - **3 つの構造モデル**：
    - **離散ステートマシン**（`verification`、`lockdown`）：永続ライフサイクル状態を Map に保持し、`transition(state, event) → { next, effects }` で遷移します。
    - **純粋ルール関数**（`replyAdmission`、`adDetectAdmission`）：内部タイマーや状態を持たず、事前計算済みスカラー入力から判定を返します。
    - **単一レコード reducer**（`mediaInputSupport` の `reduceMediaInputResult`、`temporaryAdBypass` の `advanceTemporaryAdBypassActivity`、`adReferenceWarning` の `commitReferencedAdWarning` / `cancelsReferencedAdWarning` / `referencedAdWarningWindow`）：単一レコードを結果や時刻で進め、無変化時は入力オブジェクト参照をそのまま返して `===` で書き戻しを省略します。

- **ロックダウンの既定権限更新は常に `use_independent_chat_permissions: true` を指定する**：
  - 封鎖開始、期限切れ復元、遅延応答後の補正、緊急復元はいずれも `packages/workers/antiRaid/lockdownApi.ts` と `packages/infra/telegram/lockdownPermissions.ts` を通り、最新の `getChat().permissions` を取得して `can_invite_users` のみを書き換え、他の全フィールドをそのまま Telegram へ返します。

- **封鎖告知のラウンド帰属**（`LockdownState.announced` / `announcementMessageId`）：
  - 封鎖告知は権限クエリより先にグループ別の直列チェーンへ入り、`onSent` がキャンセル伝播前にメッセージ ID を記録します（旧ラウンドの未送信告知は破棄されます）。
  - 告知 ID は `{ phase, intentId, originalPermissions, announced, announcementMessageId?, expiresAt }` として永続化され（`announced` と ID の有無は常に一致）、権限復元完了後にその ID のみを削除します（削除失敗はログ記録のみで復元状態を妨げません）。

- **解除告知は封鎖を告知済みのラウンドでのみ送信する**：
  - `announced === true` のラウンドのみ解除案内を送信します：期限満了による復元は `lockdownEnded`（封鎖分数入り）、期限前の復元（手動解除、結果不明コミット、永続化失敗、および永続化 `RESTORING` の引き継ぎ）は `lockdownLifted` を使用します（期限満了の復元中に手動解除が重なっても `lockdownEnded` を維持します）。
  - 告知状態は `APPLYING → ACTIVE → RESTORING → RECONCILING` を通じて引き継がれ、`RESTORING` 中の入室急増は新規ラウンドを開始しません。Worker 再構築時は有効かつ未告知のラウンドのみ再告知し（`RESTORING` は除外）、復元完了時に `reportUnlock` と `LOCKDOWN_RETRIGGER_COOLDOWN_MS` クールダウンを発行します。

- **ロックダウンの期限満了・再試行・壁時計ロールバック対策・消滅グループ放棄（`chatGone`）**：
  - `ACTIVE` 遷移時に `LOCKDOWN_MS` の期限が確定し、後続の入室で延長されません。メインスレッドの復元スナップショット生成（`packages/antiRaid/lockdownMirror.ts`）は `remainingMs` を `[0, LOCKDOWN_MS]` にクランプし、`packages/workers/antiRaid/lockdownRuntime.ts` の `adoptLockdowns` は `lastLockdownIntentId` を引き継ぎ対象の最大 `intentId` まで進めることで、壁時計の巻き戻りによる期限延長と意図番号衝突を防ぎます。
  - 満了時は復元意図を永続化し（`packages/states/lockdown/restore.ts` は永続化 ACK 待機中の復元／補正リトライタイマーを抑止し、`packages/antiRaid/workerBridge/events.ts` は `getOrCreateChatState` を例外境界内に収めて失敗時に `lockdownPersistFailed` を返送）、durable ACK 後に復元 API を呼び出します。
  - 失敗時は `RESTORE_RETRY_MS` で再試行し、権限拒否が `RESTORE_PERMANENT_FAILURE_LOG_LIMIT` 回を超えると warn ログに切り替えつつ最大 `RESTORE_PERMANENT_RETRY_MAX_MS` まで指数バックオフします（権限復帰を確認した時点で即時再試行し、Worker 停止 drain によるキャンセルは失敗回数に加算しません）。
  - **消滅グループの例外（`gone`）**：teardown 理由が `gone` の場合のみ、メインスレッドが `deactivateChat`（`abandonLockdown: true`）を送り、Worker は `chatGone` イベントで権限復元・告知削除を行わず `reportUnlock` のみを返します。メインスレッドは `unlock` 受信後にのみ `lockdown`（および空になった `ChatState` 行と管理枠）を消去し、直接削除による競合を防ぎます。

- **永続化権限のスキーマ正規化（`normalizeChatPermissions`）**：
  - `packages/libs/chatPermissions.ts` の `normalizeChatPermissions` で既知スキーマフィールドのみを保存し、復元時は保存済みの `can_invite_users` だけを再取得した最新権限へ上書きします。

- **永続化失敗時のフェイルセーフ補償（`persistFailed`）**：
  - コミット未発行の `APPLYING` はそのまま撤回し、発行済み `APPLYING`・`ACTIVE`・`RECONCILING` は制限が残存しないよう直ちに `RESTORING` へ遷移して復元意図を発行・補償復元します（`RESTORING` 自体の永続化失敗時も重複発行せず復元を継続します）。

- **メモリ反映前の永続化自己検証と単一 `commitApply` 発行**：
  - Worker から届いた lockdown レコードは `ChatState` メモリを更新する前に `assertPersistableLockdown` を通過させます（`encodeChatStateData` まで検証を遅らせません）。
  - 同一 `APPLYING` intent に対する `commitApply` は `commitStarted` フラグにより 1 回のみ発行し（`lockdownRuntime.ts` が状態・タイマー、`lockdownApi.ts` が直列 API を担当）、実行前・クエリ後・適用前に entry / phase / intent を照合してキャンセル済みタスクによる権限変更を防ぎます。

### AI チャットの実行時

- **東京天気情報の定期更新**：
  - 天気データの定期更新は AI Worker が独占し、`init` を受信し、かつ設定タイムゾーンが `TOKYO_TIME_ZONE` と一致する場合にのみ開始されます（`get_tokyo_weather` ツールの登録条件と同一）。
  - 他のタイムゾーンでは天気の HTTP リクエストを送信せず、グローバルな気分の抽選にも天気による重み付けは適用されません。
  - 停止時には interval タイマーを解除し、処理中の HTTP リクエストをキャンセルしてキャッシュ更新権を取り消します。再生成後のキャッシュは新ループの結果のみを受け入れ、各 HTTP リクエストは呼び出し元のキャンセルシグナル・タイムアウト・応答本文サイズ上限に従います。

- **グローバルな気分の管理（`/mood query` と `/mood switch`）**：
  - 両コマンドともメインスレッド側の request/waiter と AI Worker 側の確認応答（acknowledgement）によるハンドシェイクを共有します：
    - `/mood query`：任意のグループメンバーが現在有効な気分（mood）を再抽選なしで参照できます。
    - `/mood switch`：実行者の `isCanSwitchMood` 権限を検証したうえで即時再抽選を実行します。
  - メインスレッドは送信前に waiter を登録し、タイムアウト・Worker クラッシュ・再起動断念・シャットダウン時に統一して精算します。リクエストは絶対 deadline を保持し、AI Worker は処理前に期限切れリクエストを破棄します。
  - リクエスト ID とイベント型が双方一致する `moodQueried` / `moodSwitched` 応答のみが成功を証明します。その後の Telegram 返信送信失敗を query や再抽選の失敗へ書き換えることはありません。
  - mood は AI Worker 内に全グループ共通の単一インスタンスとして保持され（リクエストおよび応答に `chatId` なし）、どのグループからの再抽選も全グループへ即時反映されます。`/clear_context`、`/ai_chat disable`、グループの teardown、メモリ容量淘汰はいずれも mood に影響しません。

- **AI 会話メモリの破棄と無効化（Teardown と Invalidate）**：
  - **タイムアウト後も継続する Teardown 完了責任**：
    - メインスレッドの `pendingAiMemoryTeardowns` は、永続削除の完了とリクエスト ID が一致する `chatInvalidated` 応答の双方を待機します（Worker の再構築・放棄・終了時には旧要求を確定可能）。
    - 削除待ちのタイムアウトは呼び出し元の waiter のみを解放し、遅延応答から後続の完了処理を継続します。Worker の `memoryDeleted` が再度削除を登録した場合は、その tombstone の確認も待機します。
    - グループの再有効化や新規スナップショットが引き継いだ場合は旧完了責任を取り消します（通常の `/ai_chat disable` はこの teardown identity を生成しません）。
    - 新規スナップショット・初回永続化マーカー・tombstone・waiter がすべて解消されてからメインスレッドの管理グループ枠を解放し、FIFO で `forgetAiMemory` を送信します（単一の単調増加リビジョン下限により解放済み番号の再利用を防止）。
    - 未完了 teardown の上限は `STATE_MANAGED_CHAT_LIMIT` 件であり、超過時は storage fatal を発火します。Disk I/O 再構築時はメインスレッドが未完了削除をリプレイし、プロセス再起動時は純メモリ状態を復元しません。
  - **Invalidate のキャンセル境界と `epoch` 隔離**：
    - 各チャットが最初の世代依存タスクを受け入れる際、該当 Worker isolate 内で二度と再利用されない一意の `epoch` を割り当てます。
    - Invalidate 受信時は現在の `epoch` を同期削除し、旧世代を abort して未開始タスクを消去した後、該当 `epoch` に登録された返信ラウンド・レート制限通知・メディア説明・メモリ圧縮（compaction）が settle するのを最大 `AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS`（メインスレッド側の `AI_CHAT_INVALIDATE_TIMEOUT_MS` より厳密に短い上限。全タスク settle 時にクリアされる unref タイマーを使用）待機してから `chatInvalidated` を返します。
    - メモリ圧縮とメディア説明は該当世代の `AbortSignal` をモデルリクエストおよびリトライ待機へ伝播します。ドレイン上限を超えた場合はエラーログを 1 行記録して安全に降格し、遅延タスクは自身の世代検証により一切の書き込みを行いません（旧返信ラウンドの存続容量は実際の後処理完了まで保持されます）。
    - `/ai_chat disable` と `/clear_context` は同一の `invalidateAiChat(chatId)` を共有し（会話記憶の消去と `chat_states.ai_context` の `NULL` リセットを実行し、前者は機能スイッチ自体も永続化）、メモリ削除の永続化と `chatInvalidated` の双方が成功した後にのみ完了を報告します。

- **文脈消去権限（`/clear_context`）**：
  - `/clear_context` は実行者の `isCanClearContext` 権限を検証し、現在のグループの会話記憶のみを消去します。スーパー管理者は常に `true`、新規ホワイトリストメンバーは既定で `false` であり、付与・剥奪は `/permission` で管理されます。

- **モデルプロバイダのリクエスト・タイムアウト・リトライ規約**：
  - トランスポート・ネットワークエラー・429・5xx のリトライは各プロバイダの公式 SDK が単独で所有します（Gemini は `@google/genai` の `retryOptions`、OpenAI と Anthropic は各 SDK の `maxRetries`。予算定数は `GEMINI_REQUEST_RETRY_ATTEMPTS`、`OPENAI_REQUEST_MAX_RETRIES`、`ANTHROPIC_REQUEST_MAX_RETRIES`）。
  - 各 SDK のタイムアウトは**単一試行**ごとの期限です。最下層ラッパー（`workers/aiChat/gemini/client.ts`、`workers/aiChat/openai/client.ts`、`workers/aiChat/anthropic/client.ts`）は `libs/abortSignal.ts` の `signalWithTimeout` を用い、全リトライとバックオフを含む呼び出し全体の deadline（`GEMINI_REQUEST_TIMEOUTS_MS` / `OPENAI_REQUEST_TIMEOUTS_MS` / `ANTHROPIC_REQUEST_TIMEOUTS_MS`）と呼び出し側の invalidate シグナルを合成します（SDK クライアントは `workers/aiChat/capabilityClient.ts` で能力単位に構築・キャッシュ）。`workers/aiChat/openai/image.ts` も `OPENAI_IMAGE_REQUEST_TIMEOUT_MS` を単一試行および画像生成処理全体（参照素材の準備・リトライ・バックオフを含む）に適用します。
  - **失敗分類と再サンプリング**：
    - `failureKind: "request"` で失敗したリクエストに対し、呼び出し側が外側から再試行を重ねることは禁止されます。ドメイン層での再サンプリングは、HTTP リクエスト自体は成功したもののモデル応答が利用不能・異常終了した場合（`failureKind: "response"`）、または正規化後のテキストが空となった場合にのみ許可されます。
    - Anthropic の拒否は `failureKind: "refused"`（テキスト結果は `refused: true`・`retryable: false`）として返し、再サンプリングしません。
    - OpenAI Responses は `status` が `completed` であっても、message に `refusal` コンテンツブロックが含まれていれば拒否とみなし、`failureKind: "response"`・終了理由 `refusal` として返します。
  - **終了詳細の構造化ログ**（`aiProviders/finishDetails.ts`）：
    - 応答が利用不能な場合、各クライアントのエラーログはプロバイダの終了詳細を構造化コンテキストフィールドとして併記します（Anthropic `Anthropic API returned an unusable response.` は `model`・`stopReason`・`stopDetails`・`hasPartialText`、Gemini `Gemini API returned an unusable response.` は `reason`・`finishReason` と candidate の `finishMessage` / `safetyRatings` または `promptFeedback` からの `finishDetails`、OpenAI `OpenAI API returned an unusable response.` は `reason`・`incompleteReason` と `error` / `refusal` からの `finishDetails`）。
    - 詳細は `finishDetailsJson` で JSON 化して `AI_FINISH_DETAILS_MAX_CHARS` 文字に切り詰め（空の場合は `finishDetails` / `stopDetails` フィールドを省略）、`AiReplyTurn.finishDetails` を経て返信層の `AI reply received an unusable response.` ログの `finishDetails` フィールドにも出力されます。

- **モデル呼び出しクォータとレーン隔離**：
  - AI モデル呼び出しは Telegram 送信ゲートを通らず、`(provider, base_url, API キー)` ごとに 1 つのクォータレーンを共有します（モデル名では分割しません）。
  - 各レーンの同時実行上限は `AI_PROVIDER_MAX_CONCURRENT` 件、未開始待機上限は `AI_PROVIDER_MAX_PENDING` 件（うちバックグラウンド待機枠は最大 `AI_PROVIDER_BACKGROUND_MAX_PENDING` 件）です。対話リクエストを `AI_PROVIDER_INTERACTIVE_BURST` 件連続開始した後は、待機中のバックグラウンドタスクを少なくとも 1 件通過させます。
  - SDK 内部リトライは取得済みスロットを維持し、キュー満杯時はプロンプトやメディアバイトを保持せず即座にドメインエラーを返します。
  - Telegram メッセージ送信レーンが高水位（`AI_TELEGRAM_MESSAGE_ACTIVE_HIGH_WATER`）または実際の 429 バックオフに達した場合は、ランダムな自発発言を一時停止し、同一チャット内の直接トリガー並行数を 1 に引き下げるのみとし、AI プロバイダキューと Telegram キューは独立したまま保ちます。

- **返信アクションツール群（Reply Toolset）と直列アクションチェーン**：
  - **同期受付と即時受理通知**：
    - アクションツールは呼び出し時にバリデーション・クールダウン確保・枠予約を同期的に完了させ（`send_voice` は日次枠を予約し、TTS 成功時に本登録）、条件を満たさない呼び出しには直ちにエラーを返します。
    - 受理時は呼び出し ID ごとに `success: true, queued: true, actions_used`（Telegram の実メッセージ ID を含まない受理通知）を同期返却して action budget を消費するため、`toolset.execute` のモデル対話往復は擬似タイピング待機・音声合成・ネットワーク送信完了をブロックしません。
  - **直列アクションチェーン（`workers/aiChat/ai/tools/replyToolset/actionChains.ts`）**：
    - 各返信ラウンドは 1 本の直列アクションチェーンを持ち、受理済みアクションをツール呼び出し順に実行します（テキスト整形・自然な待機・ボイス合成待機・Telegram 送信と再試行を内包）。
    - 順序付き並行ラウンドのチェーンは送信順の関門を待ち、直接ラウンドのチェーンは待機なしで開始します。各ステップは完了ごとに idle 状態へ戻ります。
    - バックグラウンドへ移行したボイスはチェーンを塞がず、合成完了時点のチェーン末尾に追加されます。ラウンド全体はトリガー受信順に配送され、後続ラウンドが先行ラウンドの本文・訂正・キャプションの間へ割り込むことはありません。受理済みアクションのモデルによる再投入は禁止されます。
  - **チャット状態表示（`workers/aiChat/ai/chatActionHeartbeat.ts`）**：
    - 「入力中」「スタンプ選択中」「録音中」「写真送信中」の切り替えはラウンドの heartbeat ハンドル経由に一元化され、チェーン上で現在実行中のステップのみが切り替えます（executor は呼び出し時に切り替えません）。
    - 直接ラウンドは `replyToolset/pacing.ts` の `createDirectPacing` により、未受理アクション中のモデル生成で「入力中」、スタンプパック新規閲覧直後のリクエストで「スタンプ選択中」を先行点灯します（最初の受理アクションが `send_message` または `abuse_mark` であればその状態を引き継いで追加待機なしで送信し、モデルフェーズ終了時の `toolset.afterModel` で未引き継ぎ状態を解除します。`view_sticker_pack` 自体は状態表示を変更しません）。
    - 送信前後で idle へ切り替え、同一チャットは直前の idle から `CHAT_ACTION_REST_MS` の休止期間中は状態リクエストを送信しません（期間中の切り替えは満了時に点灯し、残り時間分だけ自然待機を延長）。
    - 誤字メッセージ着地後の訂正メッセージは、`TYPO_QUICK_CORRECTION_MIN_MS`〜`TYPO_QUICK_CORRECTION_MAX_MS` の非表示待機を経て `TYPO_QUICK_CORRECTION_TYPING_MS` の「入力中」を表示してから送信されます。
  - **スタンプパック閲覧（`view_sticker_pack`）**：
    - 該当ラウンドの実際のメニュー番号・パック名・説明文を同期返却して閲覧意図を記録します。1 ラウンドあたり異なる `MAX_STICKER_PACK_VIEWS_PER_REPLY` パックまで（同一パックは 1 回のみ）閲覧可能で、`send_sticker` は閲覧済みの同一メニューのみを参照します。天気情報とグループ Q&A の参照枠はアクション予算から独立しています。
  - **不当な絡みへのクールダウン付与（`abuse_mark`）**：
    - 引数 `user_id` が 0 以外の安全な整数であり、かつ本ラウンドのトリガー送信者（`triggerSenderId`）と厳密に一致することを検証します（Bot 自身および `superAdmin` は拒否）。
    - 受理に成功した時点で次の 4 処理を即座に実行します：
      1. `dropQueuedReplyTriggersForUser` により、全チャットの `pendingReplyTriggers` から該当ユーザーの待機トリガーを同期除去します。
      2. メインスレッドへ `abuseMark` を通知します（`aiChat/abuseMark.ts` が `abuseMarkedUsers`（`FifoMap`、上限 `ABUSE_MARK_MAX_USERS`）に期間 `ABUSE_MARK_DURATION_MS` のエントリ別 unref `setTimeout` を設定し、`auto/message` の AI 雑談入口で該当ユーザーのメッセージを遮断）。
      3. 現在の通知スタイルに応じた `ABUSE_MARK_NOTICE_TEXT` を直列アクションチェーンに積んで送信します（対話的な AI 返信として長期保持され、ローリングメモリにも自己記録）。
      4. `runFunctionCalls` で本ラウンドのモデル対話を直ちに終了します（同一レスポンス内の後続ツール呼び出しおよびモデルへの出力返却を打ち切り）。
  - **並行制御と配送キュー（`states/replyAdmission.ts`、`replyDelivery.ts`）**：
    - `activeReplyCounts` は未完了のモデルラウンドを数えます（上限は `replyRoundConcurrencyLimit`：順序付き並行ラウンドは同一チャット最大 `REPLY_ROUND_MAX_CONCURRENT` 件、直接ラウンドは `directModelActive` によりモデルフェーズ中のみ独立 1 枠を消費、Telegram 高負荷時は合計 1 件に収束）。
    - `pendingReplyTriggers` は未開始の直接トリガーをチャットごとに最大 `REPLY_TRIGGER_QUEUE_MAX` 件保持し、teardown 時に一括削除します。
    - `replyDelivery.ts` はチャットの送信ウィンドウごとに FIFO 送信枠を予約し、全世代合計で `REPLY_DELIVERY_MAX_PER_CHAT`（チャット上限）と `REPLY_DELIVERY_MAX_TOTAL`（Worker 全体上限）を共有します。満杯時はランダムトリガーを破棄し、直接トリガーを待機（待機列も満杯なら一時溢れ通知を記録）させ、予約失敗時はレート制限枠を消費しません。
    - 実送信・バックグラウンドボイス・heartbeat 後処理がすべて完了して初めて generation task と存続容量を解放します（`onFinished` が溢れ通知の精算と次チャットの補充を推進）。Telegram が送信成功を返したメッセージと返信関係のみをメモリへ自己記録し、メモリ容量整理はアクティブな世代タスクを持つチャットを優先的に回避します。

- **アクション予算上限と重複テキスト抑止**：
  - モデル向け推奨上限は `AI_MAX_ACTIONS_PER_REPLY`、実行側ハードキャップは `HARD_MAX_ACTIONS_PER_REPLY` です。予算対象は `ACTION_TOOL_NAMES`（`abuse_mark` を含む）で、上限到達時の拒否応答は対象ツール名を列挙します。
  - ラウンド内個別上限はスタンプ `MAX_STICKERS_PER_REPLY`・リアクション `MAX_REACTIONS_PER_REPLY`・画像生成 `MAX_GENERATED_IMAGES_PER_REPLY`・ボイス `MAX_VOICES_PER_REPLY`（スタンプ閲覧は `MAX_STICKER_PACK_VIEWS_PER_REPLY`、サーバー側 Web 検索はソフト上限 `MAX_WEB_SEARCH_CALLS_PER_REPLY`）です。カスタム関数呼び出し全体は `MAX_CUSTOM_TOOL_CALLS_PER_REPLY` と往復上限 `MAX_TOOL_ROUNDS` で制限され、超過時は `TOOL_BUDGET_EXHAUSTED_RESULT` を返します（ラウンド途中でツール定義自体は変更しません）。
  - 受理アクションが 0 件の場合にのみ最終本文を `send_message` でフォールバック送信します。それ以外の意図的な表示テキストはすべて明示的なツール呼び出しで出力しなければなりません。
  - **可視テキストの出口は厳密に 2 つのみ**：単独発言の `send_message` と、`generate_image` の `caption` です。
    - キャプション付き画像は Telegram 上で 1 通のメッセージ（`message_id` 1 つ・アクション消費 1 枠・自己記録 1 件）です。`caption` が `TELEGRAM_CAPTION_MAX_CHARS` を超えた場合は「キャプションなし画像 + 独立テキスト」へ降格し、残り予算が `IMAGE_SEPARATE_CAPTION_MIN_REMAINING_ACTIONS` 枠以上あれば予約します（未満なら画像のみを受理し `caption_delivery: "no_action_budget"` を返却）。誤字本文と追送訂正も受理時に `TYPO_MIN_REMAINING_ACTIONS` 枠を予約します。
  - **同一ラウンド内の重複テキスト抑止（`modelAuthoredTextPolicyResult`）**：
    - 空白集約と Unicode NFC 正規化を行ったうえで、同ラウンドで受理済みの本文・キャプション・予約済み訂正文字と完全一致比較します（語句・大小文字・句読点は区別し、意味類似度による拒否は行いません）。
    - 一致時は `DUPLICATE_REPLY_RESULT` を返して静かにスキップし、状態表示・生成・クールダウン消費・Telegram 送信・自己記録を一切行いません。受理後の失敗やキャンセルで予約枠は返却されず、重複判定状態はラウンド間で共有されません。

- **画像生成の参照画像**：
  - 参照画像を持つのは直接トリガーのラウンドのみであり、トリガー自身の画像 / スタンプ、またはテキスト返信先の画像 / スタンプが主参照画像として先頭に置かれます。
  - 主参照画像がアルバム（`media_group_id`）に属する場合、AI Worker はツールコンテキスト組み立て時にアルバムキャッシュ（`cache/workers/aiChat/imageReferenceAlbums.ts`）から同一アルバムの残りの画像を `message_id` 昇順で補い、合計最大 `agent.image.max_reference_images` 枚とします（キャッシュ未ヒットや Worker 再構築後は主参照画像のみ）。
  - アルバムキャッシュはアルバム画像の記録時に更新され、1 アルバムあたり最小 `message_id` の `IMAGE_GENERATION_MAX_REFERENCE_IMAGES` 枚、LRU で最大 `IMAGE_REFERENCE_ALBUM_CACHE_MAX` アルバムを Worker ローカルメモリに保持します（チャット無効化では消去されず、永続化・スレッド間共有も行いません）。
  - 参照画像はモデルが `generate_image` を呼び出した後にのみメディア実行器の interactive タスクとして順序どおり並行ダウンロードされます。1 枚でも失敗・キャンセルされるか合計サイズが `MEDIA_MAX_DOWNLOAD_BYTES` を超えた場合は画像生成を失敗とし、モデルリクエスト未開始のためグループの画像クールダウンを解放します。

- **ツール宣言の恒常性と言語整合**：
  - **ラウンド間で不変のツール一覧**：`createReplyToolset` が登録するツール定義はデプロイ設定のみによって決まり、トリガー種別・グループの Q&A 登録件数・誤字抽選結果では変化しません：
    - 常時登録：`send_message`（`typo_original_char` / `typo_replacement_char` は常に任意引数として宣言し、当選ラウンドの返信タスクにのみ `TYPO_REQUIRED_INSTRUCTION` を付与）、`add_reaction`、`group_qa_query`、`group_qa_answer`、`abuse_mark`。
    - `generate_image`：画像生成プロバイダ設定時。
    - `send_voice`：`agent.tts` が設定され、実装が `synthesizeSpeech` をサポートする場合。
    - `view_sticker_pack`、`send_sticker`：スタンプメニューが空でない場合。
    - `get_tokyo_weather`：起動時タイムゾーンが `TOKYO_TIME_ZONE` の場合。
    - `web_search`：`agent.web_search` 設定時はローカル関数ツールとして登録し、未設定時は登録せず `text` モデルの組み込み検索を使用します。
  - **セリフ言語の一括決定**：
    - `send_message`・`send_voice` の宣言文、システムプロンプトの「行动与停止」（行動と停止）節、および `speechLanguageStyle` は、`agent.tts.bot_language`（省略時は `TTS_DEFAULT_BOT_LANGUAGE`）に基づき `VOICE_LANGUAGE_PROMPTS`（`consts/aiChat/prompts/tools.ts`、`TTS_BOT_LANGUAGES` ごとに定義）から 1 度だけ取得し、`ReplyToolset.replyActionInstruction` 経由で `workers/aiChat/replyModel.ts` へ渡します。
    - `prompt/voice_tool.md` がある場合は `buildSendVoiceToolDefinition` が `voiceToolPromptCache` から `send_voice` 説明本文を読み取り、引数説明や他箇所は引き続き同一言語セットを使用します。
  - **本輪ツール状態スナップショットと実行時最終判定**：
    - 実行時状態ブロック内の `【本轮工具状态】`（本ラウンドのツール状態、`workers/aiChat/ai/tools/replyToolset/toolStatus.ts`）はラウンド開始時に 1 回だけ客観的事実（画像生成の可否 / クールダウン残り秒数、ボイスの本日残り回数、Q&A 登録件数、独立検索の呼び出し上限）を固定順で記録します。
    - 各 executor は呼び出し時に改めて資格を最終判定します：`generate_image` は `replyRound.ts` が直接呼び出し時（`imageGenerationRequested` かつ非ランダム、テキストラウンドまたは `directTriggerReason` 付きメディアラウンド）にのみ有効化する `mediaToolsRequested` とチャット別クールダウン（スーパー管理者は免除）を検証し、`group_qa_query` / `group_qa_answer` は空一覧または完全一致（不一致時は `found: false`）を返し、`send_message` は非当選ラウンドでの誤字引数を無視します。
    - `VOICE_LANGUAGE_PROMPTS[*].replyActionInstruction` により、`error` 応答を受けたアクションは未実行として扱い、再試行や失敗への言及・謝罪を禁じます（唯一、メンバーが明示的に画像を求めたにもかかわらず `generate_image` が利用不可または拒否された場合のみ、描けない旨を一言伝えます）。

- **音声合成の実行詳細（`send_voice`）**：
  - **同期受付と引数検証**（`createSendVoiceExecutor`。ラウンド単位の資格制限はなく `bot_language` ごとに定義一定）：
    - ラウンド有効性、`MAX_VOICES_PER_REPLY` 未満、音声合成対応、引数仕様（必須 `text` は 1 行正規化後 `VOICE_TEXT_MAX_CHARS` 以下、任意 `tone` は `VOICE_TONE_MAX_CHARS` 以下、任意 `reply_to_trigger` は boolean のみ。切り詰めず型・長さ違反はエラー返却）を検証し、`reserveAiTtsUsage` で `ai` 区分の 1 日枠を予約します（上限到達時は `SEND_VOICE_DAILY_LIMIT_TOOL_ERROR`）。
    - 受理時は `voice_remaining_today` を含む受理通知を即座に返却し、バックグラウンドで合成とエンコードを開始して配送ステップを直列チェーンへ積みます。
  - **フォアグラウンド待機とバックグラウンド補送**：
    - 直列チェーンが配送ステップに到達した時点で未完了かつ `VOICE_FOREGROUND_WAIT_MS` 未経過であれば「録音中」を表示して待機し、超過時は表示を取り下げてバックグラウンドへ移行（`chains.defer`）させ、合成完了時点のチェーン末尾で補送します。
    - すべてのボイス送信前は音声再生時間分の「録音中」を表示し、送信成功後に `（发送了一条语音：…）` を自己記録します。合成失敗時は送信せず `AI reply voice was not sent.`（`{ chatId, reason }`）をログ出力するのみで（無効化済みならログも省略）、`synthesizeVoiceMessage` は例外をスローしません。
    - ボイスセリフは可視テキスト出口ではないため `modelAuthoredTextPolicyResult` を通らず、テキストとの重複回避やボイスへの言及禁止はプロンプト制約で担保されます。
  - **1 日あたりの回数予約と確定**（`cache/workers/aiChat/ttsUsage.ts`）：
    - 予約（`pendingAiTtsReservations`）は AI Worker メモリのみに保持されます。TTS 呼び出しが成功した瞬間に `settleAiTtsReservation` で `agentCount` に本登録し、TTS 失敗・成功前キャンセル時は予約を解放します（TTS 成功後のエンコード失敗や送信失敗では返却しません）。ラウンド開始時の残り回数が `voiceToolStatus` に表示されます。
  - **音声合成・エンコード実装の一元化**（`packages/workers/aiChat/ai/voiceSynthesis.ts`、`workers/aiChat/ai/voiceEncoding.ts`、応答上限 `VOICE_SPEECH_MAX_BYTES`）：
    - `resolveSpeechSynthesizer` が未設定（`tts unconfigured`）と非対応（`tts unsupported`）を判定し、`synthesizeVoiceMessage` が tts facade 経由で合成します（枠上限時は `daily limit reached`）。
    - **WAV（`WAV_MIME_TYPES`）**：モノラル PCM を抽出し、`VOICE_OPUS_ENCODE_CHUNK_SECONDS` ごとに `@audio/encode-opus`（`VOICE_OPUS_BITRATE_KBPS`、`VOICE_OPUS_APPLICATION`、`VOICE_OPUS_COMPLEXITY`）で OGG/Opus に変換してチャンク間でイベントループを解放します。元のサンプルレートから `OPUS_GRANULE_RATE` へ連続リサンプルして `Bun.concatArrayBuffers` で連結し、各チャンク前と最終解放後に中止シグナルを確認してキャンセル済みならエンコーダーを解放し `aborted` を返します。
    - **OGG/Opus（`OGG_OPUS_MIME_TYPE`）および MP3（`MP3_MIME_TYPE`）**：`workers/aiChat/ai/utils/voiceContainer.ts` で Ogg ページ / OpusHead または MPEG Layer III フレーム列を検証して再生時間を算出し、そのまま格納します（その他 MIME は `unsupported speech mime type`）。結果には `VOICE_OGG_FILE_NAME` / `VOICE_MP3_FILE_NAME` を付与します。

- **運用側ボイスの借用（`/send` と `cron.json`）**：
  - **IPC 合成ハンドシェイク**：メインスレッドは `packages/aiChat/voiceSynthesis.ts` の `requestVoiceSynthesis`（`aiChat/workerBridge.ts` の `synthesizeVoice`）で要求を投函し、同一 `requestId` の `voiceSynthesized` レシート（音声バッファを transfer）を待機します。タイムアウト（`VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS`）またはキャンセル時は `cancelVoiceSynthesis` を投函し、常に結果 union で解決します（drain 開始後の Worker は `"worker unavailable"` を返却）。`/send` と `cron.json` のセリフ長は `VOICE_OPERATOR_TEXT_MAX_CHARS` 以下、口調は `VOICE_TONE_MAX_CHARS` 以下に制限されます。
  - **独立した `operator` 日次クォータ**（`packages/workers/aiChat/providerFacades.ts` の `createSpeechFacade`、`workers/aiChat/ai/ttsUsage.ts`）：
    - 運用側リクエスト（`quota: "operator"`）はプロバイダ呼び出し直前に `claimOperatorTtsUsage` で `reserveCount`（上限 `daily_reserve_quota`、AI 側の `daily_limit - daily_reserve_quota` とは完全分離）を確保し、音声未返却・例外時は同一ウィンドウ内に限り `refundOperatorTtsUsage` で返還します（内部リトライ `GEMINI_SPEECH_REQUEST_ATTEMPTS` / `OPENAI_SPEECH_REQUEST_ATTEMPTS` は個別加算せず、`TTS_USAGE_WINDOW_MS` 経過または時計巻き戻り時にリセット、`agent.json` ホットリロード時も使用済みカウントを維持します）。

- **Anthropic モデル応答の取り扱い**：
  - **終了理由と拒否分類**：リクエストはすべて SDK の beta Messages エンドポイントを使用します。`max_tokens` と `model_context_window_exceeded` は `failureKind: "response"`、`refusal`（`stop_details.category` 不問）は `failureKind: "refused"` として返し、拒否時は再サンプリングしません（記憶圧縮・スタンプ目録・広告検出は即時断念し、`web_search` ツールは拒否説明を返し、cron の Web ダイジェストは `refused` で終了）。
  - **拒否時の自動フォールバック（`fallback_model`）**：
    - `fallback_model` 設定時は SDK の `betaRefusalFallbackMiddleware`（`fallback-credit-2026-07-01` beta 付き）を組み込み、`model` 拒否時に同一認証情報・エンドポイントで `fallback_model` へ再送してクレジットトークンを `best_effort` で引き換えます（引き換え失敗時も通常料金で実行し、フォールバック側も拒否した場合はその拒否を返却）。
    - 返信セッション（ツール往復および `pause_turn` 継続を含む）と単発検索はそれぞれ 1 つの `BetaFallbackState` を保持し、切り替え後の残りリクエストは `fallback_model` へ直行し、次回の返信は再び `model` から開始します。
  - **切り替え警告ログと利用量帰属**：
    - `aiProviders/anthropic/sdkClient.ts` は呼び出し前後の `BetaFallbackState` 添字変化で切り替えを検出し、構造化警告を 1 件記録します（成功時は `"Anthropic request fell back after a refusal."` に `{ errorLabel, from, to, trigger, fallbackCredit }` を付与、`trigger` と `fallbackCredit` は `finishDetailsJson` で直列化し欠落時は `null`；二重拒否時は同文言に `{ errorLabel, from, to, stopReason }`；失敗・タイムアウト時は `"Anthropic request fell back after a refusal; fallback request did not complete."` に `{ errorLabel, from, to }` を付与し、切り替え済みセッションの後続リクエストでは記録しません）。
    - 利用量はデプロイ設定上のモデル名（切り替え後は `fallback_model`、通常は `model`）で計上し、拒否された試行分は計上しません。ログおよび `finishDetails` の `stop_details` からは事前に `fallback_credit_token` を除去します。
  - **広告検出の空応答再試行と `pause_turn` 継続**：
    - 広告検出で本文が空の場合は最大 `AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS` 回まで再サンプリングし（Anthropic 拒否は即時終了）、断念時にのみ最終試行の構造化コンテキストを 1 件エラーログ出力します（Anthropic は `"Ad detection request produced no usable body."` に `{ errorLabel, attempts, model, stopReason, stopDetails, hasPartialText, maxTokens }`、Gemini は `"Ad detection request returned no usable body."` に `{ errorLabel, attempts, abnormalReason, finishReason, finishDetails }`、OpenAI 互換 Chat Completions は `"Ad detection request produced no usable body."` に `{ errorLabel, attempts, finishReason, finishDetails, hasPartialText, reasoningTokens, maxTokens }`）。
    - 対話および独立検索で `pause_turn` を受けた場合は assistant 履歴を維持して最大 `ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS` 回まで継続し、検索回数を合算します（独立検索で `web_search_tool_result_error` を含む応答は失敗扱い）。

- **トークンと利用量の算定**（`packages/infra/aiCacheUsage.ts`、`packages/infra/aiCacheUsageRelay.ts`）：
  - プロバイダ SDK が返却した正規の `usage` のみを集計し（キャンセル時も有効な `usage` があれば計上、未返却時は推定しない）、メインスレッドから Disk I/O へ診断エンベロープで中継します。
  - **プロバイダ別のトークン内訳**：
    - **Gemini**：入力は `promptTokenCount` と `toolUsePromptTokenCount` の和、出力は本文トークンと思考トークンの和です。Decisions API の利用量は `reportGeminiDecisionUsage` が集計し（`total_input_tokens` と `total_cached_tokens` を読み取り、`total_output_tokens` と `total_thought_tokens` の双方が省略された場合は出力トークンを `0`、省略された `total_cached_tokens` は不明のまま記録せず、`prompt_feedback.block_reason` 応答でも `usage` が返れば計上）、応答はキャッシュ読み取り量（`cachedContentTokenCount` / `total_cached_tokens`）のみを返し、書き込み量は返しません。
    - **Anthropic**：`input_tokens` はキャッシュ分を含まないため、入力総量を `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`、読み取りを `cache_read_input_tokens`、書き込みを `cache_creation_input_tokens` とします。
    - **OpenAI**：出力に推論トークンを重複加算せず、書き込みは Responses の `input_tokens_details.cache_write_tokens` または Chat Completions の `prompt_tokens_details.cache_write_tokens` から取得します。再生時間のみの文字起こしや `usage` を返さない TTS（OpenAI audio/speech、xAI `/tts`）はトークン換算せず、費用のみを返すモデル（xAI 画像生成の `cost_in_usd_ticks` など）は費用メトリクスとして個別記録します。
    - **整合性検証**：キャッシュ読み取りと書き込みの和が入力総量を超える場合はトークン記録を不正として破棄し（検索回数は保持）、書き込み未返却時は当該項目を記録しません。
  - **Web 検索回数の集計**：組み込み検索（Anthropic `server_tool_use.web_search_requests`、OpenAI の完了済み `action.type === "search"`）はモデルトークンと併せて 1 リクエストとして計上し、独立検索呼び出しは search usage として記録します。

- **2 段階の返信受付メカニズム**：
  - **第 1 段階 — 並行ゲート（`admitTrigger`）**：トリガー到着時に現在の並行数で受付可否を判定します。待機キューが空でない場合、新規トリガーは空きスロットがあっても必ず末尾に並びます（割り込み禁止）。
  - **第 2 段階 — レート制限ゲート（`isReplyRoundRateLimited`）**：ラウンド開始直前に `RATE_LIMIT_LONG_WINDOW_MS` のスライディングウィンドウを検証します。拒否時は直接トリガー（`directInvokerId` あり）のみレート制限通知を送信し、ランダムな相づちは静かに破棄します。
  - **キュー排出の推進と先頭保持**：モデル完了（`onModelFinished`）、送信後処理完了（`onFinished`）、新規キューイング、定期保守ティック（`drainPendingReplyQueues`）がいずれも `drainReplyQueueIfWindowAllows` を推進します。溢れ通知（`flushOverflowNotice`）はレートウィンドウ外で独立送信され、排出補走（`drainReplyQueue`）で先頭トリガーがレート制限または容量不足で拒否された場合は先頭に留めて排出を停止します。

- **グループアクティビティ確率レイヤーと JIT 性能保証**：
  - 可視メッセージの記録によりランダム自発返信の発火確率を引き上げます（高アクティビティ上限で頭打ち、グループごとに独立、再起動時はコールドスタート、直接トリガーは確率ゲートをバイパス）。
  - **ホットパスのアロケーション規律**：既存グループは固定 shape の `AiReplyActivityEntry` をインプレース更新し、`Map.delete` + `Map.set` や複合文字列キー・一時オブジェクトの生成を禁止します（満杯テーブルへの新規挿入時のみ LRU スキャン）。ユーザー別クールダウンは `[chatId][userId]` の 2 段 Map と `userReplyTriggerSweepState.size`・単一 unref タイマーで管理します。
  - **1 メッセージ 1 回の遅延システムクロック取得（`updateNow()`）**：`packages/infra/updateContext.ts` が初回呼び出し時に `Date.now()` を `UpdateScope.now` へキャッシュし、`antiRaid/updateIngress.ts` と `auto/message/index.ts`（沈黙期間・アクティビティ・クールダウン・連投制限など）で同一時刻を共有します。チャンネル投稿や自動転送が自発メッセージ rendezvous（`waitForBotOwnMessage`、最長 `SELF_SENT_RENDEZVOUS_TIMEOUT_MS`）で一致しなかった場合のみ、処理再開前に `refreshUpdateNow()` で 1 回再取得します。

- **マルチモーダルメディア解析パイプライン（画像、スタンプ、GIF、音声）**：
  - 「プレースホルダー登録 → 非同期解析 → インプレース書き戻し」の統一パイプラインを採用します。
  - `transientDescriptionCache` は `file_unique_id` キーで最大 `MEDIA_DESCRIPTION_CACHE_MAX` 件の Promise を LRU キャッシュし（失敗結果は即時削除）、同一ファイルの進行中リクエストを単一 Promise に統合します。
  - 並行エグゼキュータ（`cache/workers/aiChat/mediaTasks.ts`）は実行中タスクを最大 `MEDIA_DESCRIPTION_MAX_CONCURRENCY` 件、待機・コールドプローブを最大 `MEDIA_DESCRIPTION_MAX_PENDING` 件に制限し、`libs/sharedResult.ts` の参照カウント付きサブスクリプションにより最後の消費者が離脱した時点で初めて背後のダウンロード・解析を中止します。
  - **視覚トランスコードの上限（`packages/infra/image.ts`）**：アニメーション WebP は RIFF チャンク単位（区間あたり最大 `WEBP_MAX_SCANNED_CHUNKS` 個）で先頭フレームを切り出し、`Bun.Image` がヘッダー読み取り後・画素バッファ確保前に `VISION_TRANSCODE_MAX_PIXELS` 上限を検証します。長辺が `VISION_TRANSCODE_MAX_EDGE` を超える場合は等比率で縮小（拡大なし）してから PNG へ変換します。

- **Bot 自発画像の記憶バックフィルと音声の事前検証**：
  - ローリングメモリ内の自発画像（`packages/workers/aiChat/botImages.ts`）は**プレースホルダー状態**（プロンプト / キャプション記号 + `pendingImage`）と**内容状態**（画像認識記述へ置換、`pendingImage` 消去）を持ちます：
    - `/wed`、`/h_image`、`cron.json` の `send_image` はプレースホルダー状態で書き込み、先回りの画像認識は行いません（`/wed` の画像差し替えも元エントリを新キャプションのプレースホルダーへ戻すのみ）。
    - `generate_image` は送信後にプロンプト付きプレースホルダーを書き込み、直ちに非同期認識を実行して画面記述を書き戻します。
    - メンバーが Bot 画像を引用返信した際（`botImage` メタデータ添付）、元エントリがプレースホルダー状態なら非同期認識を起動し、元の記憶エントリと現在の返信コンテキストの双方へバックフィルします。
  - **音声ダウンロードの事前境界検証**：再生時間（上限 `VOICE_MAX_DURATION_SECONDS`）とファイルサイズ（上限 `VOICE_MAX_DOWNLOAD_BYTES`）をダウンロード前に検証し、超過時は文字起こしをスキップして `[语音 N 秒]`（ボイス N 秒）へフォールバックします（文字起こし結果の切り詰め上限は `VOICE_TRANSCRIPT_MAX_CHARS`）。

- **ホワイトリストスタンプパックの保守とミラー**：
  - AI Worker は起動時および定期保守時に `retryIncompleteStickerCatalogs` でスタンプパックを照合し、失敗エントリと失敗パックにそれぞれ `STICKER_CATALOG_ENTRY_FAILURE_RETRY_MS` と `STICKER_SET_FAILURE_RETRY_MS` のネガティブキャッシュバックオフを設定します。設定ホットリロード時はホワイトリストから外れたパックのキャッシュを即時除去します。
  - メインスレッドの `stickerMirror.ts` はカタログスナップショットに単調増加リビジョン番号（ファイル内には非永続化）を付与し、Disk I/O がアトミック書き込みと親ディレクトリ `fsync` 完了後に返す `stickerCatalogPersisted`（現行 Worker と一致するもののみ）を受理します。

### AI プロンプトと transcript

- **Bot 自身の身元と発言者識別**：
  - AI 自録・トランスクリプト名簿・返信引用・会話要約の入力において、Bot 自身の発言は一貫して `SELF_SPEAKER_NAME`（名簿コードは `me` / `SELF_ROSTER_CODE`）として識別され、Telegram 上の `first_name`・`last_name`・`username` は表示されません（一般メンバーはアカウント ID と表示名を保持し、過去スナップショット描画時も同一規則）。
  - 本 Bot 経由の inline メッセージ（`via_bot.id === bot.id`、`packages/auto/message/guards.ts` の `recordSelfInlineResult`）は能動返信をトリガーせず文脈のみを記録します：gag inline 発言（`hasGagInlineMarker`）は実際の送信者名義（`buildInlineSenderRecordMessage`）、それ以外の inline 結果（`stripLuckReceipt` 後の運勢カードなど）は `SELF_SPEAKER_NAME` 名義（`buildSelfRecordMessage`）で記録されます。
  - 読み取り専用参考記憶には現在のデプロイの `@username` を含む自己身元文が 1 文添えられます（起動時の `bot.init()` / `getMe` で 1 回取得し、`initAiChat` で注入・Worker 再生成時に再送）。

- **Web 検索（Web Search）プロンプト仕様とデュアルモード切り替え**：
  - **共通のファクトチェック原則**：プロバイダ中立の固定指示を用い、同一返信内の全モデル呼び出しで完全に同一の system prompt を再利用します。変動する情報や未確証の事実について検索ツールがある場合は「先に検索し、その後アクションする」順序を徹底し、雑談・創作・トランスクリプト既出の事実では検索しません。検索結論を曖昧な記憶より優先し、根拠不足時は率直に不確実性を伝え、検索の内部処理はメンバーに明かしません。
  - **2 つの排他的な検索モード**：
    - **組み込み検索（`agent.web_search` 未設定時）**：system prompt に `WEB_SEARCH_INSTRUCTION` を用い、`text` モデルのサーバー側組み込み検索を有効化します。ソフト上限 `MAX_WEB_SEARCH_CALLS_PER_REPLY` に対する実呼び出し回数を `replyModel.ts` が集計し、超過時はログ記録のみを行ってプロンプトやツールの動的変更は行いません。
    - **独立関数検索（`agent.web_search` 設定時）**：
      - system prompt に `WEB_SEARCH_FUNCTION_INSTRUCTION` を用い、ローカル関数ツール `web_search`（クエリ長上限 `WEB_SEARCH_QUERY_MAX_CHARS`、ラウンド上限既定 `WEB_SEARCH_DEFAULT_MAX_CALLS_PER_USE`）を登録します。
      - `workers/aiChat/ai/tools/webSearch.ts` が検索対応モデルで単一往復の調査を行い、「注記（`WEB_SEARCH_RESULT_NOTICE`）+ 結論 + 番号付き出典（`WEB_SEARCH_SOURCES_HEADING`、タイトル上限 `WEB_SEARCH_SOURCE_TITLE_MAX_CHARS`）」を `WEB_SEARCH_RESULT_MAX_CHARS` 文字・出典 `WEB_SEARCH_MAX_SOURCES` 件以内で返します（不正入力・タイムアウト・未検索・空結果は `WEB_SEARCH_FAILED_TEXT`、Anthropic 拒否時は `WEB_SEARCH_REFUSED_TEXT` と `retryable: false`）。
  - **タイムゾーン照合と Grounding 温度切り替え**：「今日」「最新」などの相対日時は Web ページの公開日時ではなく設定タイムゾーンの現在日時を基準に判定します。検索実行後の後続リクエストには `grounded: true` が付き、Gemini はサンプリング温度を `GEMINI_REPLY_TEMPERATURE` から `GEMINI_GROUNDED_REPLY_TEMPERATURE` へ引き下げます。

- **入力ブロック（Blocks）の固定順序とプロンプトインジェクション防止**：
  - **厳格に順序付けられた 4 つの入力ブロック**（直接 @メンションでもランダム自発返信でもブロック数・構造は不変であり、直接メンション時は第 4 ブロック先頭に `directInvokerSentence` を 1 行追加するのみ）：
    1. `【只读参考记忆】`（読み取り専用参考記憶、`stableBlocks`：背景情報・ペルソナ記憶）
    2. `【只读当前会话】`（読み取り専用現在対話、`volatileBlocks`：階層別会話トランスクリプト）
    3. `【本轮运行时状态】`（本ラウンド実行時状態、`volatileBlocks`：現在時刻・今日の気分・`【本轮工具状态】`）
    4. `【本轮回复任务】`（本ラウンド返信タスク、`volatileBlocks`：トリガー要因と目標指示）
  - **プロバイダ別のワイヤ構造**：
    - **Gemini**：安定グループと可変グループを隣接する 2 つの `user Content` に分け、各ブロックを 1 つの `text Part` とします。
    - **OpenAI**：単一の user message 配下に複数の `input_text` を並べます。
    - **Anthropic**：単一の user message 配下に複数の `text` ブロックを並べ、現在対話は確定切点（settled offsets）で分割します。
  - **プロンプトインジェクション防御と system prompt の逐字不変性**：
    - データと指示の分離・偽造境界タグの無効化・内部構造の非開示は system prompt 内で 1 回だけ宣言し、トランスクリプト内の同名タグはすべて平文として扱われます。
    - 時刻・気分・ツール状態などの動的データはすべて第 3 ブロックに置き、system prompt へは混入させません。ペルソナ設定・行動と停止節・ローカル `web_search` モードの 3 点が前ラウンドと同一である間、AI Worker は `packages/cache/workers/aiChat/replyPrefix.ts` の単一スロットにある同一文字列を再利用します。

- **プロンプトキャッシュとブレークポイント（Prompt Caching）**：
  - **Gemini**：生成系の対話返信は毎回静的な `systemInstruction`・`tools`・`toolConfig` を送信して `stableBlocks` を先頭の `user Content` に配置し、生成系の広告検出はルールとサンプルを `systemInstruction` に固定して `contents` 内で `fact` を本文およびマルチモーダル画像より前に配置することで、サーバー側の暗黙的プレフィックスキャッシュを利用します。`use_decision: true` の広告検出は `client.decisions.create` を呼び出し、判定基準・参照サンプル・候補パック別の質問群を `questions` にまとめ、共有の事実・本文・画像を単一の `input` で渡します。
  - **OpenAI**：安定ブロックを前方、動的ブロックを後方に配置し、グループ別の `prompt_cache_key` を付与します（system prompt とツール宣言 JSON が前ラウンドと同一なら `libs/prefixFingerprint.ts` の `stablePrefixFingerprintWithSlot` で SHA-256 中間状態を再利用）。公式エンドポイントかつ `OPENAI_PROMPT_CACHE_BREAKPOINT_MODEL_PREFIX` で始まるモデルでは、最後の安定ブロック直後に明示的な `prompt_cache_breakpoint` を置きます。
  - **Anthropic**：system prompt 末尾、最後の安定ブロック末尾、現在対話の最後の確定セグメント末尾、およびリクエスト最上位の自動ブレークポイントにキャッシュ境界を配置します。

- **直接メンション時の読解順序と混同防止**：
  - `DIRECT_INVOCATION_READING_INSTRUCTION` は推論手順を 3 段階に規定します：
    1. まず `【最热记忆】`（直近のホット記憶）を通読して会話の背景と流れを把握する。
    2. 返信タスクに示されたメンション元の名簿番号から、相手の発言内容を特定する。
    3. 文脈と相手の意図を踏まえて返信を組み立てる。
  - メンバー識別は名簿番号の背後にある `[id:]` のみを基準とし、転送メッセージを転送者本人の発言と混同せず、過去発言への個別返信は行いません。

- **記憶階層メカニズムの沈黙原則**：
  - `MEMORY_MECHANISM_SILENCE_INSTRUCTION` により、`【最热记忆】`・`【较早逐字记录】`（やや前の逐語記録）・`【冷记忆】`（コールド要約記憶）・`【发言人名册】`（発言者名簿）・`【转发来源名册】`（転送元名簿）などの内部セクション名、`me`/`uN`/`fN` 番号、`#メッセージ番号`、`[已滑出]`（ウィンドウ外流出）、スライディングウィンドウ・トークン・圧縮・コンテキスト・system prompt などの技術用語をグループ内で言及・示唆することは固く禁じられます。探りに対しても肯定・否定せず自然な会話で受け流します。

- **コンパクトな階層別逐語トランスクリプト形式（`buildTieredVerbatimTranscript`）**：
  - **名簿 + 番号参照**：発言者と転送元は末尾の `【发言人名册】` と `【转发来源名册】` に 1 回だけ集約し、各メッセージ行にはコード（Bot は `SELF_ROSTER_CODE`、メンバーは `u1`、`u2`…）と時分秒のみを記載します（日付は日跨ぎと階層境界でのみ 1 行出力）。
  - `#メッセージ番号` は被返信メッセージと今回のトリガーメッセージにのみ付与します。返信先が現在セグメント内にあれば `（回复 #番号）` ポインタで参照させ、ウィンドウ外へ流出していれば `[已滑出]` 付きインライン要約にフォールバックします。ホット区間内に同一 `message_id` が重複する場合は最新の 1 件のみを描画します。
  - **階層境界アライメントと確定切点**：`【较早逐字记录】` の長さは `TIER_BOUNDARY_ALIGNMENT` の整数倍へ切り上げて境界移動頻度を抑え、確定過去ログは `TRANSCRIPT_SETTLED_SEGMENT_SIZE` 刻みのメッセージ末尾で分割してブロックキャッシュに供します。

- **単一ホップ返信と冷履歴の圧縮形式**：
  - トランスクリプト外でメンバーやメッセージを指す際も名簿番号を厳守し、コンテキストは単一ホップの返信・転送元・引用断片のみを保持します（多層引用ツリーは再帰展開しません）。
  - 冷履歴のバッチ圧縮（`summarizeBatch`）は名簿を使わず各行に発言者を含む自己完結形式（`formatBufferedMessageLine`）と不変の `SUMMARY_SYSTEM_PROMPT` を使用し、現在時刻を `userContent` 末尾に添えます。

- **自発アクション記号の実行側ハードインターセプト**：
  - `（发了一枚贴纸：…）`、`（…生成并发送了一张图片：…）`、`（发送了一条语音：…）` などの Bot 行動記録記号は `transcript.ts` テンプレートに由来し、**アクションの実送信が完了した後に実行側のみが追記します**。
  - `send_message` 本文および `generate_image` の `caption`（クールダウン消費前に検証）に偽造アクション記号が含まれる場合、モジュールシングルトン正規表現 `SELF_ACTION_TAG_PATTERNS`（全角括弧と末尾 `：` / `）` を厳密照合、`g`/`y` フラグなし）でインターセプトし、モデルへ再生成を要求します。

### 参加認証と終端処置

- **検証終端の再試行・壁時計ロールバック対策・永続化保証**：
  - 単一プロセス内での検証終端操作は最大 `VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS` 回まで試行します。`packages/workers/antiRaid/verificationRuntime.ts` は保留中タイムアウトタイマーの遅延を `[0, VERIFICATION_TIMEOUT_MS]` にクランプして壁時計巻き戻りによる延長を防ぎ、`packages/states/verification/pending.ts` は `expiresAt >= joinedAt` を保証して壁時計巻き戻りをリマインダー再送窓の終了扱いとし（`isRecordedWithin`）、`packages/states/verification/join.ts` も同じく `isRecordedWithin` により `KICKED_REJOIN_GRACE_MS` の再入室猶予窓を壁時計巻き戻り時に終了扱いとします。
  - **バッチ単位のクリティカル書き込み `fsync`**：Disk I/O Worker が 1 つの操作バッチを処理する間、バッチ内の検証クリティカル書き込み（新規作成・終端・削除）はメモリ登録のみを行い、バッチ全体の処理終了後（例外発生時を含む）に一括追記して `fsync` を 1 回実行します（`verificationPersisted` レシートはこの `fsync` 後に送られ、操作バッチ受理応答はさらにその後）。バッチ外で単独到着したクリティカル書き込みはその場で永続化します。
  - **最終リビジョンの永続化決済**：終端操作の完了後は最終リビジョンの durable ACK を待ってからメモリ記録を消去します。待機中にリビジョンが進んだ場合は、試行上限到達後であっても新リビジョンを確認し、成功済み終端の完了を遅延させません。
  - **状態機械所有のローカル実行ゲート**：Worker ローカルの実行フラグ（`effectStarted`、`executionStarted`）は永続化せず、試行開始時に捕捉した状態オブジェクトを伴う状態機械イベントでのみ遷移します（状態が世代交代していれば無効）：
    - `kickRequestSent`：ロックダウン（非公開モード）の即時キック要求を同期送信する直前に `executionStarted` を立てます。
    - `kickRequestFailed`：要求が未精算で戻った際に `executionStarted` を下ろします。
    - `terminalAttemptUnsettled`：終端試行の 1 ラウンドが未精算で終了した際、または副作用バッチが途中で reject した際に実行ゲートを下ろします（`kickPending` は両ゲートを解除）。`retryTerminalAttempt` がエラーをログ出力したうえで `terminalAttemptUnsettled` を発火し、エントリのバックオフ列に従って再試行を 1 回予約します（`kickPending` は `kickRetry`、`checkingInviter` と `expelling` は `terminalPersisted`。タイムアウトキックの処置レポートも `runTelegramAction` 経由のため reject 時は同じバックオフに合流）。
  - **緊急ロックダウン復元の告知削除**：メインスレッドが緊急ロックダウン（Lockdown）を復元する際は、記録消去前に告知 ID のメッセージ削除を開始します（削除失敗は Telegram ログに記録するのみで復元フローをブロックしません）。

- **タイムアウト検証における招待者身分の再確認（`checkingInviter`）**：
  - 他メンバーに招待された入室時は、まず有効期限内の管理者キャッシュで招待者を同期判定し、管理者であれば即座に免除します。キャッシュ期限切れ（`adminCacheFresh` が偽）の場合にのみ `startAdminCheck` で管理者一覧を再取得します（同一入室が `chat_member` と `new_chat_members` の双方から届いた場合も同一基準。期限内かつ非管理者なら追加照会なし）。
  - 認証タイムアウト後は `checkingInviter` 段階で `isChatAdmin` により招待者身分を再確認します：
    - **管理者と確証**：招待されたメンバーに免除を付与します。
    - **非管理者と確証**：タイムアウト追放段階（`expelling`）へ移行します。
    - **身分未確証（ネットワークタイムアウトや照会失敗）**：終端状態とディスクスナップショットを維持してローカル実行占有を解除し、指数バックオフ後に再確認します（各試行はメインスレッド承認の終端予算を 1 回消費）。

- **実行許可のライフサイクルと延期メカニズム**：
  - 終端実行許可は、状態オブジェクト・世代（generation）・リビジョンが一致し、業務がキャンセルされていないタスクにのみ有効です。
  - 許可申請が拒否（reject）・`stale`・予算切れとなった場合は、メモリ上の実行時状態をアンロードしてメインスレッドにプロセス単位の延期ラッチを記録し、リビジョン更新や tombstone 書き込みは行いません（Worker 再生成時もラッチを維持して再作成を防ぎ、完全なプロセス再起動後にディスクから復元）。

- **バックオフタイマーと永続化コールバックの安全性**：
  - 重複受信した永続化 ACK がアクティブな終端バックオフタイマーを短絡することはありません。
  - タイマーコールバックはエントリ・状態オブジェクト・現在ハンドルの三者一致を確認し、ハンドルをクリアしてから再試行を発火します（再予約・置換・teardown 済みの旧コールバックは無効）。
  - `expelling.successNoticeSent` の正確な永続化レシートは、バックオフタイマーが残っていても直ちに記録を完了させます。

- **Worker 実行時容量のハードキャップ**：
  - Anti-Raid Worker の実行時状態（永続段階および `exempt` / `kicked` 重複排除記録を含む）は `VERIFICATION_RUNTIME_CAPACITY` で保護されます。満杯時に新規キーが到着した場合は参加カウント・状態遷移・副作用の前に拒否し、当該世代で fatal を 1 回報告して新世代 adopt または停止まで新規参加をロックします（既存キーの更新・解除・終端決済は継続）。
  - 新世代 adopt 時は旧実行状態を消去してから永続ミラーを復元します（同世代の増分復元で満杯となった場合は非永続の重複排除スロットのみを解放し、新規拒否ラッチを維持）。
  - メインスレッドのリビジョンテーブルも `VERIFICATION_REVISION_CAPACITY` を上限とし、新規キー満杯時は期限切れ tombstone を先に掃除し、なお超過する場合は停止します（Worker 再構築時はアクティブおよび延期記録のみを再生）。

- **参加認証と対レイドロックダウンの統一スイッチ**：
  - 両機能はグループ単位の `ChatState.isAntiRaidEnabled`（既定 `false`）を共有し、`isCanControllAntiRaidPermission` 保持者（スーパー管理者は常時保持）が `/antiraid enable|disable` で切り替えて永続化します。
  - Anti-Raid Worker 上の `/ad_detect`、`/flood_control`、永久ブロックリスト即時キック、`/batch_kick` の参加ログは**本スイッチの影響を受けず**独立して動作します。
  - **メインスレッド入口フィルタ（`updateIngress.ts`）**：対レイド無効グループでは `join`・`left`・認証メッセージ / コールバックを遮断しますが、**管理者変更（`adminsChanged`）は通過**させて Worker 側の管理者キャッシュを更新します（ブロックリスト即時キックは `joinedAt` なしで送信し、参加スライディングウィンドウには加算しません）。

- **対レイド無効化（`/antiraid disable`）の後処理**：
  - **即時停止と残留物撤去**：
    - `deactivateJoinGuard` が全認証レコードを `guardDisabled` 遷移で `ABSENT` に戻し、Bot 送信済みの認証リマインダーとボタンを削除します（参加サービスメッセージやメンバー自身の発言は削除せず、保留中のキックも失効させて永続化済みレコードには tombstone を発行）。
    - ロックダウン（Lockdown）へ `deactivate` を送信し、`applying/preparing` はそのまま撤回、`applying/prepared` および以降の段階は `RESTORING` へ遷移して `can_invite_users` の返還・封鎖告知削除・参加ウィンドウ消去を実行します。
  - Telegram 削除 API を呼ぶのは明示的な `/antiraid disable` または `/init disable` のみであり、管理者権限喪失や退出時はローカル解体のみを行います。Worker 一時不在時もスイッチ無効化は永続化され、残骸は再起動・再生成時に `purgeDisabledJoinGuards` が回収します。

- **連携チャンネルディスカッショングループのコメント免除**：
  - 連携チャンネルのディスカッションスレッド（`is_topic_message !== true` に限定し、フォーラムの通常トピックを除外）における直接コメントとスレッド内返信は共通の免除規則に従います（キャッシュはメッセージ ID と観測時刻のみ保持）。
  - コールドキャッシュ上の `message_thread_id` は非同期で `linked_chat_id` を照会し、同一世代で一致が確認された時点で認証責任を取り消します（照会失敗時は fail-closed で後続の再試行を許容）。

- **Worker 側管理者キャッシュのインフライトスロット管理**：
  - 管理者一覧の非同期取得は `libs/keyedTask.ts` でチャット単位に重複排除され、`.finally()` はスロットが自身の Promise を保持している場合にのみクリアします。
  - `resetAdminCache()` は全スナップショット・インフライトスロット・保留差分を一括消去し、`clearChatAdminCache(chatId)` は該当グループの 3 項目のみを消去します（消去後に完了した旧リクエストは現在の待機者へ結果を返すのみで、`cacheAdminIds` や保留差分は書き換えません）。

- **認証ボタンの対話権限の独立性**：
  - **本人回答ボタン**：
    - 人間メンバーのリマインダーは 1 行目に算数問題の選択肢 `VERIFICATION_CHALLENGE_OPTION_COUNT` 個、2 行目に `"通过"`（承認）を配置します（Bot メンバーは `"通过"` の 1 行のみ）。
    - 問題は `VERIFICATION_CHALLENGE_OPERATORS`（`+ - × ÷`）と `[VERIFICATION_CHALLENGE_OPERAND_MIN, VERIFICATION_CHALLENGE_OPERAND_MAX]` から一様抽出し（減算は非負、除算は割り切れる組のみ）、正解 ±`VERIFICATION_CHALLENGE_DISTRACTOR_SPREAD` 内の非負整数から取り得る順位を一様に決めて上下の誤答を重複なく抽出しシャッフルします（正解が 0 なら最小順位固定）。`callback_data`（`verify:<userId>:<選択肢の値>`）は `parseUserIdArgument` と `VERIFY_ANSWER_ARG_PATTERN` で厳格解析します。
    - 認証対象本人（`callback_query.from.id === userId`）かつ現在有効な `reminderMessageId` / `replyReminderMessageId` 上の押下のみを判定します（他人の押下は無視、古いメッセージ上は期限切れ通知のみ）。正解なら通過、不正解なら `expelling`（`reason: "wrongAnswer"`）へ遷移し、永続化応答後に認証メッセージを削除して BAN なしでキックします（`checkingInviter` は省略）。
  - **問題のキャッシュ（`VerificationEntry.challenge`）**：
    - 人間メンバーの初回リマインダー登録時に生成し、同一 pending の元リマインダー・返信リマインダー・再送で共有します（認証タイムアウト timer に従属し、ディスク永続化なし）。Worker 再構築や同世代リプレイ後に本人が既存リマインダーを押した場合は、旧リマインダーを削除して新しい問題を再送します。
  - **`"通过"`（承認）ボタンとホワイトリスト非相関**：
    - 本グループの**非匿名の人間管理者**（`isChatAdmin` / `getChatAdministrators` で判定、照会失敗時は再試行案内のみ）のみが代理承認できます。ホワイトリストメンバーやスーパー管理者であってもグループ管理者でなければ承認・招待免除の権限はなく、本人の自己承認も拒否されます。
  - **Bot は管理者キャッシュ対象外**：
    - `getChatAdministrators` は `return_bots` を付けず `user.is_bot` も除外し、`chat_member` 差分（`isInviterExemptAdmin`）も同一基準とするため、Bot による招待は免除されず、連投ミュートや広告処置の管理者ゲートでも Bot は管理者扱いされません。

- **終端キックとグループタイプの適合**：
  - **キック前の在室確認（初回リクエストも必須）**：`kickChatMember` の前に必ず `probeChatMembership`（`getChatMember`）で在室を確認します（退出済みならレポートなしで完了、照会失敗時はバックオフ）。スーパーグループの「BAN せずキック」は `only_if_banned` なしの `unbanChatMember` であり既存 BAN を解除する作用を持つため、`left` / `kicked` であれば即座に中止します（明示的な BAN 解除は `only_if_banned: true` を付与）。
  - **`can_restrict_members` 欠如時（`botCanRestrictIn === false`）**：在室照会は継続しキック要求のみを抑止します（退出済みなら精算、在室ならバックオフ）。`cleanupSettled === true` 後は削除リクエストを再送せず、失敗通知送信済みまたは前回キック確認済み（`removalConfirmed`）のラウンドでは再試行ごとに在室照会を 1 回だけ実行します（退出確認時に成功報告を補送）。
  - **グループタイプの振り分け**：通常グループは `banChatMember`、スーパーグループは `unbanChatMember` を使用します。種別はメインスレッドからミラーリングし、コールドミス時は `getChat`（同時実行上限 `VERIFICATION_CHAT_KIND_FETCH_MAX`、タイムアウト `CHAT_KIND_FETCH_TIMEOUT_MS`）で取得します。

- **ロックダウン即時キックと不可逆トークン（`kickPending`）**：
  - 即時キックは先に `kickPending` スナップショットを write-ahead 永続化し、前段クリーンアップ完了後・`kickChatMember` 呼び出し直前にメモリ上の状態オブジェクト同一性を**間に `await` を挟まず**再確認します。トークン一致かつ成功時のみ `kicked` へ遷移します。
  - **参加カウントの取り消し対象**：実際に `recordJoin` した物理参加（`joinCreatesNewRecord === true`、`countedJoinAt` 保持。`KICKED_REJOIN_GRACE_MS` 経過後の再参加やロックダウン中再構築の `kickPending` を含む）のみを取り消し、同一参加通知の重複配信は再カウントしません。管理者誤キック時の診断（`logUncancelableKickExemption`）は `logger.error` に記録します。

- **認証リマインダーの送信とメンバー発言の保護**：
  - 各メンバーに単一の配信 owner を割り当て、世代交代時（復旧引き継ぎ・管理解除・停止を含む）は同期キャンセルして遅延着弾メッセージを自己削除します。タイムアウトキックには `reminderMessageId` または `replyReminderMessageId` の送信成功が必須であり、未送信の間は参加から最長 `VERIFICATION_REMINDER_UNDELIVERED_MAX_MS` までウィンドウを延長して再送を試みます（上限超過後は通常のタイムアウトキック）。
  - **メンバー自身の発言は削除対象外**：`trackedMessageTimes` で `ANTI_RAID_PER_MINUTE_LIMIT` 超過を検知して連投終端キックへ遷移した場合でも、削除するのは Bot 送信のリマインダーと告知のみです（メンバー発言の抹消は `/block` および広告処置の経路に限定）。

### 連投ミュートと自身の権限キャッシュ

この節では、[カウントと実行の境界](#カウントと実行の境界)、[命中時の抑制と並行処理の安全性](#命中時の抑制と並行処理の安全性)、[実行前の権限ゲート](#実行前の権限ゲート)、[Bot 自身の権限ミラー](#bot-自身の権限ミラー)を順に説明します。

#### カウントと実行の境界

- **連投のカウントと実行は Anti-Raid Worker が独立担当**：
  - 既定で無効であり、`ChatState.isFloodControlEnabled === true` の場合のみ有効です（`isCanControllFloodControlPermission` 保持者が `/flood_control enable|disable` で切り替え、無効化時は既存ウィンドウを消去）。
  - **スーパーグループ限定**：同一メンバーが `FLOOD_WINDOW_MS` 以内に `FLOOD_MESSAGE_LIMIT` 件発言すると、直ちに `FLOOD_MUTE_DURATION_MS` のミュート（`restrictChatMember`）を実行します。
  - **メインスレッドでの同期事前フィルタ**：グループスイッチ・スーパーグループ種別・実ユーザー身分（チャンネル名義と匿名管理者を除外）・`isCanBypassFloodControl`（ホワイトリストは既定免除、スーパー管理者は常時免除）を同期判定してから通常の `post` で Worker へ渡します。
  - ウィンドウは `cache/workers/antiRaid/flood.ts`（上限 `FLOOD_WINDOW_MAX_MEMBERS` 件、LRU 淘汰・定期スイープ、非永続）で管理し、解除は Telegram 側の `until_date` 自動復帰に委ねます。

#### 命中時の抑制と並行処理の安全性

- **命中時点での即時抑制フラグ設定**：
  - 閾値到達の瞬間にネットワーク通信を待たず抑制フラグを立てます。確定結果（ミュート成功・対象が管理者・権限拒否）ではフラグを**保持**し、一時障害（通信エラー・身分未確認）では 0 に**ロールバック**して次回の再発火を許容します。
  - 各 `await` 後に状態オブジェクト同一性（`stillManaged`）を検証し、管理解除や LRU 淘汰が発生していた場合は処置と告知を直ちに中止します。

#### 実行前の権限ゲート

- **実行前の二重権限チェック**：
  - ミュート実行前に次の 2 条件を確認します：
    1. Bot 自身の `canRestrictMembers`（確証 `false` なら中止、`true` または未観測 `undefined` なら通過）。
    2. `freshAdminIds`（コールド時はライブ照会）による対象の非管理者確証（`true` = 管理者、または `undefined` = 未確証の場合は**一切実行せず**、確証 `false` のみ通過）。
  - `muteChatMemberWithOutcome` は `FLOOD_MUTE_DISPATCH_TIMEOUT_MS` と `antiRaidDispatchSignal` のもとで `muted`・`forbidden`（抑制保持）・`failed`（ロールバック）の三値を返し、`muted` 成功時のみ `COMMAND_MESSAGE_AUTO_DELETE_MS` 付きグループ通知を送信します。

#### Bot 自身の権限ミラー

- **メインスレッドから Worker への権限ビットミラー**：
  - 権威スナップショットは `ChatState.botPermissions`（`packages/infra/botAdmin.ts`）に永続化され、`my_chat_member` 受信または `getChatMember` ライブ照会時に `botPermissionsChanged` で配信されます（永続化は全権限フィールドを比較、スレッド間配信は `canRestrictMembers` と `canDeleteMessages` の 2 ビットのみを比較）。
  - 他者の `chat_member` 更新からは具体的な権限ビットを推測せず、欠落・矛盾時はバックオフゲート（`BOT_PERMISSION_PROBE_RETRY_MS`）付きの非ブロッキング `getChatMember` ライブ照会を起動します（update ループ上では決して `await` しません）。
  - **三値（`true` / `false` / `undefined`）の厳守**：二値へ丸めず、キック・ミュート（`canRestrictMembers`）および広告一括削除・チャンネル別名追撃削除・認証追放時の痕跡削除（`canDeleteMessages`）は**確証 `false` のときのみ**短絡スキップし、`undefined` では通常通りリクエストを発行します。
  - **削除結果の分類と誠実な通知文面**（`deleteMessageWithOutcome`：`deleted` / `gone` / `forbidden` / `failed`）：
    - `deleted` と `gone`（既に削除済みまたは削除可能期間超過の 400 応答）はいずれも痕跡消去完了として扱います。
    - `canDeleteMessages === false` で削除をスキップした場合は清掃完了を主張せず、失敗時は `forbidden` の場合のみ管理者権限不足を案内し、一時的な `failed` は未削除件数 / 総件数を正確に報告します（広告処置の通知はメインスレッドの裁定通過後に一括削除が並行実行されるため削除成否を含めません）。
  - Anti-Raid Worker 側の**グループ管理者キャッシュ**（`workers/antiRaid/adminCache.ts`）とは対象主体が異なり、共有・代替はしません。

### 識別子の解決と実行時のクリーンアップ

- **ユーザー名双方向キャッシュの整合性**：
  - 送信者キャッシュは「正規化 username → identity」と「sender ID → 現在の username」の双方向マップをアトミックに維持し、改名・削除・再紐付け・LRU 淘汰時の別名衝突や不整合を拒否します。
  - **破壊的コマンドにおける `@username` のライブ再確認**（`commands/liveTargetIdentity.ts`）：
    - エイリアステーブルが保持するのは直近の発言観測時点のスナップショットであるため、`requireIdentityPolicies` を有効にしたコマンド（`/block … enable|disable`、`/mute`、`/white`、`/permission` の変更経路）で `@username` が指定された場合は、実行前に ID で現在の身分を照会し（正数ユーザー ID は本グループの `getChatMember`、負数チャンネル / グループ ID は `getChat`）、結果をキャッシュへ書き戻します。
    - 現在の username が一致した場合のみ実行し、不一致時は古い別名を破棄して拒否、照会失敗時も拒否して返信または数値 ID 指定を促します（返信指定と生の数値 ID は権威指定のため照会を省略）。

- **匿名管理者とグループ身分の取り扱い**：
  - 匿名管理者本人は管理者免除を保持しますが、新規メンバーへの招待免除は付与できません。グループ名義の発言は `/copy` やアバター取得用にグループ identity を保持しつつ、破壊的管理コマンドの対象指定からは拒否されます。

- **ユーザー ID 引数のサポート（`acceptUserId`）**：
  - コマンドごとの明示オプトイン（`/block … enable|disable`、`/info` など。`/copy` や中国語アクションコマンドは無効）により、`USER_ID_ARG_PATTERN` かつ `Number.isSafeInteger` を満たす正数 ID を受け付けます（キャッシュ未ヒット時は `resolveIdTarget` が最小 identity を生成）。
  - **返信先と引数の衝突拒否**：返信先メッセージと引数が異なる対象を指す場合（または引数が解決不能な場合）は暗黙優先せずエラーとして拒否し、同一対象を指す場合のみ通過させます。

- **会話 ID 引数のサポート（`acceptChatId`）**：
  - 負数のチャンネル / グループ ID（`CHAT_ID_ARG_PATTERN`）は `/gag`、`/ungag`、`/delete_message`、`/block disable`、`/permission`、`/white`、`/translate`（翻訳停止対象）、`/info` のみが受け付けます。
  - チャンネル名義のブロック登録は返信 `/block` または `sender_chat` 広告検出からのみ行われ、`/block enable` は負数 ID 引数を拒否し、復旧用の `/block disable` のみが受け付けます（`resolveIdTarget` が符号から `isChannel` を付与し、`workers/antiRaid/blocklistEffects.ts` と同源で `unbanChatSenderChat` / `unbanChatMemberIfBanned` を振り分けます）。

- **`/gag` 発言制限ステートマシンとメッセージライフサイクル**：
  - **権威セッション枠**：メインスレッドがグループ別セッションを管理し、グローバル上限は `GAG_SESSION_MAX` 件です。同一 `(chatId, targetId)` は `starting → active → ending` を通じて 1 スロットを独占します。
  - **開始通知の送信ペアリング**：
    - 通常ユーザーにはボタンなしの公開提示に続けて `ephemeral_message_parameters.receiver_user_id` 限定の解除 / 発言ボタン付き ephemeral 入口を送信し、チャンネル身分にはボタン付き公開提示 1 通のみを送信します。
    - 必要な全送信が成功し `message_id` と `ephemeral_message_id` を同期記録した後にのみ `active` へ遷移して `unref` タイマーを設置します（2 通目失敗時は 1 通目を削除してからスロットを解放）。
  - **解除と有界リトライ回収**：
    - タイムアウト・`/ungag`・グループ teardown 時は同期的に `ending` を確保してタイマーを解除し、関連メッセージを順次削除して全件が `deleted` または `gone` となり解除通知も確定した後にのみスロットを解放します。
    - 削除が `failed` / `forbidden` の場合は `ending` 所有権を維持して有限回数の `unref` バックオフ再試行を行い、使い切った後も後続の `/ungag`・teardown・シャットダウン時に再試行します（セッション所有メッセージは `COMMAND_MESSAGE_AUTO_DELETE_MS` に入れず、解除通知のみ通常削除境界を使用。シャットダウン時は Telegram 送信ゲート前ですべて処理（ドレイン）し、未完了時は最終 offset 確定と `bot.lock` 解放を保留します）。
  - **発言提示入口の更新と沈黙後再送**（`commands/gag/counter.ts`、`commands/gag/refresh.ts`）：
    - グループ発言が `GAG_SPEAK_NOTICE_MESSAGE_INTERVAL` 件に達した際（進行中の `speakNoticeRefreshTask` がない場合、`gagBackgroundTasks` 上で最大 `GAG_SESSION_MAX` 並行）、および通常ユーザー専用の `speakNoticeRefreshTimer`（間隔 `GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS`、必ず `unref`）で更新します。排他タスク内で `retired` を削除し、新入口送信（`onSent` で `pending` 記録）とトピック切り替え後に旧入口を削除します。
    - `lastTargetMessageAt` は対象本人の発言時のみ更新され、`refreshGagSpeakNoticeOnSpeech` が `GAG_SPEAK_NOTICE_IDLE_INTERVAL_MS` 以上の沈黙後の発言を検知すると即時再送してタイマーをリセットします（チャンネル入口は件数到達またはトピック移動時のみ更新）。
  - **Inline ルーティングの排他性と認証**：
    - `GAG_INLINE_QUERY_PREFIX` のないクエリは常におみくじへ渡され、プレフィックス付きクエリ（事前入力は `${GAG_INLINE_QUERY_PREFIX}<対象 Telegram ID> ` 固定。余分なトークンや `ParsedGagInlineQuery` の scope 拡張は禁止）は gag 入口で完結します（不正・期限切れ・不一致時は空結果を返し、おみくじへフォールバックしません）。
    - `recordInlineResultSources` は広告検出照合専用であり、着地時は Bot 身分・プレフィックス・`<対象プロフィール>${GAG_PROFILE_CHAT_SEPARATOR}<セッションチャット ID>` マーカー・アクティブセッション・送信者 / グループ ID を検証して不一致時は即座に削除します。

- **`/delete_message` の対象と削除キュー**：
  - **対象状態の永続化と起動検証**：初期化済みグループの `ChatState.deleteMessageTargets`（1 グループ最大 `DELETE_MESSAGE_CHAT_TARGET_MAX` 件の互いに異なる非ゼロ安全整数）をホットコピー先行更新 + `persistChatState` で永続化します。起動時は `decodeStoredChatStates` がグループ自身の ID を、`assertSuperAdminNotDeleteMessageTarget`（`assertSuperAdminNotBlocked` 直後）がスーパー管理者 ID を拒否します。
  - **メインスレッド専用キュー（`packages/cache/main/deleteMessage.ts`）**：非永続・上限 `DELETE_MESSAGE_QUEUE_MAX` 件。Anti-Raid 後・gag 前の同期 ingress がキュー投入のみを行い（満杯時は投入せず受理のみ）、独立した取消コンテキスト（`runWithUpdateAbortSignal`）の単一消費ループが同一グループの連続分を `deleteMessages` で一括削除します（失敗時再試行なし。teardown 時は未送信分を除去して対象解除を永続化し、停止予算超過時はキューを破棄してエラーログを記録）。

- **`/icon steal` アバター取得フォールバック**：
  - t.me プロフィールフォールバック時は**必ず `getChat(targetId)` でその場照会した username を採用**し、返信コンテキストやキャッシュの username は診断ログのヒントにのみ使用します。

- **グループ Runtime Teardown（解体）規約**：
  - 全ドメイン（`copy`、`translate`、`gag`、`deleteMessage`、`qa`、`batchKick`、`wed`、`aiChat`、`antiRaid`、`joinLog`）のコールバックは `packages/infra/chatTeardownRegistry.ts` 経由で `packages/cache/main/chatTeardown.ts` に逆登録し、`packages/infra/chatTeardown.ts` が `packages/consts/chatTeardown.ts` の `CHAT_TEARDOWN_ORDER`（`ChatRuntimeOwner` 網羅）順に同期開始して一括待機します。
  - **解体理由の判定関数（`packages/libs/chatTeardown.ts` / `ChatTeardownReason`）**：
    - `explicitDisable`（`/init disable`）、`departed`（Bot 退出 / 除外）、`gone`（`migrate_to_chat_id` 昇格後の旧 ID または `chat not found`）：`purgesChatData === true` となり、`/wed` メンバー集合・入室ログ・Q&A DB・一括キックのシーケンスおよび Mini App 完了結果（`batchKickPreflightSeqsByChat`、`batchKickInFlightSeqByChat`、`miniAppBatchKickCompletedByChat`）・`chat_states` を完全削除します。
    - `lostAuthority`（在室のまま管理者権限のみ喪失）：実行時状態のみを停止し、永続化データと Mini App 完了結果を保持します。
    - `isChatUnreachable`（`departed` / `gone`）では Telegram 削除 API を呼ばずローカル ID のみ破棄し、`abandonsLockdown`（`gone` のみ）でロックダウン記録を放棄します（AI 記憶は全理由で削除、認証ボタン等の API 削除は `explicitDisable` のみ）。
  - **冪等な退出後始末入口（`completeChatDeparture`、`packages/infra/botAdmin.ts`）**：権限破棄・全 owner teardown・ブラックリストスイープ進捗とロックダウン以外の `ChatState` 消去を実行します。入口は ① `my_chat_member` の left/kicked（`departed`）、② `packages/app/updatePreamble.ts` の `migrate_to_chat_id` 移行 ingress（`gone`、新スーパーグループは別途 `/init` が必要）、③ 起動時タイトル保守での到達不能確証の 3 箇所のみです。

- **メンバー在室再確認と `/block` グループ横断再送**：
  - `probeChatMembership` の在室応答後・`kickChatMember` 呼び出し直前の終端状態オブジェクト同一性確認と API 呼び出しの間に `await` を挟んではなりません。
  - `/block` と `/block disable` は結果キャッシュを持たず、毎回全管理グループへ `banChatMember`（`revoke_messages: true`）または BAN 解除を再送します（`canRestrictMembers === false` が確証されたグループのみスキップ）。

### `/wed` のメンバー永続化と操作

- **日次メンバー再確認メカニズム**（`commands/wed/memberReview.ts`）：
  - Disk I/O Worker 固有の Bun ネイティブ cron（`DISK_IO_MAINTENANCE_CRON`）が設定タイムゾーンの日跨ぎに送る `midnightMaintenance` 通知のみで起動します（メインスレッドに別 cron は作成しません）。
  - 復元済みの全管理グループを直列走査し（各最大 `WED_MEMBER_LIMIT` 件）、`WED_MEMBER_REVIEW_INTERVAL_MS` 間隔・単一照会タイムアウト `WED_OPERATION_TIMEOUT_MS` で `getChatMember` を実行します。
  - 明確な退出または 400 `PARTICIPANT_ID_INVALID` のときのみ `removeWedMember` で除外・ダーティ化します（API エラー非計上。走査中の発言・在室 `chat_member`・入室通知は遅延退出判定を否決し、一時通信障害はメンバーを保持）。
  - Bot が非管理者のグループでは 403 または 400 `CHAT_ADMIN_REQUIRED` を 1 行ログ出力して当該グループの検査を終了し、既存メンバーを全員保持します。**非管理者グループで退会済みメンバーが抽選されるのは想定どおりの挙動です**。

- **権限と受付ゲート**：
  - `/wed` コマンドおよびコールバックは `/init` ゲート（`isInitEnabled === true`）の背後に置かれ、未初期化グループの退出イベントは既存ウィンドウからの ID 削除のみを行います。

- **キャッシュと永続化アーキテクチャ**：
  - **メンバー権威キャッシュ（`packages/cache/main/wedMembers.ts`）**：グループごとに単一の `FifoMap<number, number>`（`packages/libs/fifoMap.ts`、メンバー ID → 参加時刻、上限 `WED_MEMBER_LIMIT`）を保持します。新規参加時刻は `max(現在時刻, 最大参加時刻)` とし、満杯時は最古エントリを押し出し、再発言で参加時刻は更新しません（チャンネル・返信 / 転送元・匿名発言は除外）。
  - **対話セッションキャッシュ（`packages/cache/main/wed.ts`）**：1 人 1 グループ 1 セッションを容量 `WED_SESSION_CAPACITY`（`WED_SESSION_LIMIT + WED_MAX_CONCURRENT`、グループ上限 `STATE_MANAGED_CHAT_LIMIT`、LRU 淘汰なし）の `FifoMap` で保持し、配信後（または引き直し失敗で `previous` 復元後）に `trimWedSessions` が処理中セッションをスキップして待機中の古い結果を `WED_SESSION_LIMIT` 件までスライドアウトします。
  - **ディスクフラッシュと全削除保証**：実際の追加・削除・押し出し時のみリビジョンを進めてダーティ化し、`FLUSH_MAX_ENTRIES` / `FLUSH_INTERVAL_MS` 閾値でフラット配列 `[id, enteredAt, ...]` を Disk I/O Worker へ渡して `{ id, enteredAt }` 配列として `memory/wed/<chatId>.json` にアトミック書き込みします。`purgeWedMembers` は `pendingWedMemberDeletes` で永続化確認まで追跡し、停止・再構築時に再送します。

- **起動時読み取り専用ゲート**：
  - 起動時に `memory/wed/` 配下の全ファイル名（正規化された負の整数グループ ID）、`{ id, enteredAt }` 構造、重複のない正の安全整数ユーザー ID、非減少・非負の参加時刻、単一グループ上限・総グループ数を検証し、違反時は原本を保持したまま起動を拒否します。

- **抽選・アバター取得・結果差し替え**：
  - `memory/wed` から抽選し、`readCurrentAvatar`（`getChat` が 400 `Bad Request: chat not found` を返した場合は全グループから除外）で管理者権限なしにアバターを取得します（実行枠は `createPrioritizedBoundedTaskRunner` の `WED_MAX_CONCURRENT` / `WED_MAX_PENDING`）。
  - **唯一の画像送信境界（`commands/wed/messages.ts` の `sendWedResult`）**：結果画像は長期保持されます（スライドアウト後も削除しません）。引き直し時は新画像の送信成功後にのみ旧画像を削除し、失敗時は旧画像とセッションを維持します（`departed` 時は新旧いずれも削除リクエストを送りません）。

<p align="right"><a href="#クイックナビゲーション">↑ クイックナビゲーションへ戻る</a></p>

### `/info` プロフィール照会

- **引数解析と実行予算**：
  - `commands/info.ts` は `acceptUserId`・`acceptChatId`・`allowSelfTarget`（Bot 自身の照会を唯一許可）を有効化し、遅延コマンドエグゼキュータの `interactive` 枠・予算 `INFO_TASK_BUDGET_MS` で実行します（タイムアウト時は取得済み情報で応答、停止時は静かに終了）。
- **プロフィール・アバター取得と応答メッセージ送信**：
  - ユーザーは `readChatMemberUser`、チャンネル / グループは `getChat`、Bot 自身は `ctx.me`（未取得時はキャッシュ）から解決し、`sanitizeDisplayName` で双方向制御文字を除去、ID を `code` エンティティ化し、`readCurrentAvatar` でアバターを取得します。
  - 応答メッセージは `infra/telegram/commandPhotos.ts` の `sendCommandPhoto` で送信し（グループ内は `COMMAND_MESSAGE_AUTO_DELETE_MS` 自動削除、プライベートチャットは保持）、画像送信失敗時は `sendCommandMessage` のテキスト応答へ降格します。

### `/h_image` ランダム画像

- **画像ディレクトリの読み取り専用検査・遅延引き継ぎ・ホットリロード**：
  - パスは `config/dynamic/assets.json` の `onlyPath.random_h_image_dir`（既定 `RANDOM_H_IMAGE_DIR`）から取得し、`packages/infra/imageGallery.ts` が読み取り専用検査 `inspectRandomImageDirectory` と状態引き継ぎ `adoptRandomImageDirectory` を分離して担当します。前者はディレクトリ作成やキャッシュ改変を一切行わずに実在ディレクトリの読み書き実行権・`<64 桁小文字 SHA-256 hex>.jpg/.jpeg/.png/.webp` 通常ファイル構成（ルート自体が実ディレクトリへのシンボリックリンクである場合は許容）または `ENOENT` 時の最寄り書き込み・実行可能祖先ディレクトリを検証し、後者のみが必要時（起動の `prepareRandomImageDirectory` またはホットリロード確定時）に `mkdirSync` で未作成ディレクトリを作成して両キャッシュを同期更新します。ホットリロードや Mini App 保存検査で不適合と判定された場合は既存キャッシュと元のディレクトリを保持し、稼働中に削除されたディレクトリを自動再作成することはありません。
- **抽選アルゴリズムとギャラリーのデュアルキャッシュ**（`cache/main/hImage.ts`）：
  - **2 種類のソート済みキャッシュ**：起動またはホットリロード時の `inspectRandomImageDirectory` 走査後に `adoptRandomImageDirectory` が同期構築し（および未キャッシュ時の初回アクセス時に読み込み）、辞書順昇順の `randomImageDirectoryCache`（抽選・枚数集計用）と更新日時降順（`mtimeMs` 降順）の `randomImageGalleryCache`（Mini App ギャラリーのページング用）を維持します。`storeRandomImage`（`/h_image add`・Mini App アップロード）は二分探索で両キャッシュへインプレース挿入し、`deleteRandomImageFile`（Mini App 削除）は両キャッシュから同期削除するため、ページ送り時の再ソートは発生しません。
  - **一様抽選（`pickRandomImage`）**：`randomImageDirectoryCache` から `RANDOM_IMAGE_MAX_BYTES` 以下の通常ファイルを一様抽出し、消失ファイルは両キャッシュから除去、上限超過ファイルは残り候補から再抽出します（上限超過のみなら `tooLarge`、空なら `empty`）。
- **レート制限と遅延スケジューリング**：
  - `/h_image` と `/h_image add` はグローバルスライディングウィンドウ（`H_IMAGE_RATE_LIMIT_WINDOW_MS` あたり最大 `H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW` 回、超過時は静かに破棄）を共有し、`commands/deferredCommands.ts` へ投入します（抽選は `interactive`、追加・`/batch_kick`・`/block` fan-out は `background`、停止時は Telegram 送信ゲート前ですべて処理（ドレイン））。
- **画像送信境界とアルバム収集（`add`）**：
  - `commands/hImage/draw.ts` の `sendHImageResult` が唯一の送信境界であり、結果画像は Telegram スポイラーマスク付きの長期保持例外としてトリガートピックへ返信されます（案内メッセージは `COMMAND_MESSAGE_AUTO_DELETE_MS` 自動削除）。
  - `/h_image add`（要 `isCanAddHImage`）は返信先および `mediaGroups.ts` の同一 `media_group_id` 画像を予算 `H_IMAGE_ADD_TASK_BUDGET_MS`・バッチ幅 `H_IMAGE_ADD_DOWNLOAD_BATCH_SIZE` で並行取得し、SHA-256 算出と UUIDv7 一時ファイル + アトミック rename で重複排除保存します。

### `cron.json` 定時タスク

- **設定解析とソースファイル検証**（`packages/config/cron.ts` / `packages/config/cronAction.ts`）：
  - ファイル欠落時はタスクなし、1 箇所でも不正があればファイル全体を拒否します（ファイルパス・フィールドパス・期待形態のみ出力）。`parseCronConfig` はディスク I/O なしの純粋検証、`loadCronConfig` はシンボリックリンク解決後の実ファイル種別（固定画像 / ファイルは通常ファイル、ランダム画像は実ディレクトリ）を検証します。
  - **テーブル・スケジュール規約**：
    - トップレベル配列（上限 `CRON_MAX_TASKS` 件、動作数上限 `CRON_MAX_ACTIONS_PER_TASK`、一意なトリム済みタスク名上限 `CRON_TASK_NAME_MAX_CHARS`、未知キー禁止、`just_once`・`rand_image`・`is_blurred` は boolean 限定）。
    - `payload.path` は `RUNTIME_DATA_ROOT` 基準で絶対パスへ正規化（空文字列・NUL 拒否）。`time_zone`（省略時は起動時タイムゾーン）は `parseTimeZone`、`cron` 式は `Bun.cron.parse`（将来発火時刻が必須）で検証します。任意の `rand_cron`（`"<min>-<max>"` または単一値、`DURATION_TOKEN_PATTERN` かつ `[CRON_RANDOM_INTERVAL_MIN_MS, CRON_RANDOM_INTERVAL_MAX_MS]`、`min <= max`）は `just_once: true` と排他です。
  - **動作タイプ別制約**：
    - `send_message`：非空 `content`（`TELEGRAM_MESSAGE_MAX_CHARS` 以下）。
    - `send_image` / `send_file`：任意キャプション `content`（`TELEGRAM_CAPTION_MAX_CHARS` 以下）。`send_file` は絶対 HTTP/HTTPS `url` または `path` の択一、固定 `send_image` は 1〜`CRON_MAX_IMAGES` 件（1 枚は `sendPhoto`、複数枚は先頭のみキャプション付きの `sendMediaGroup`、ランダム画像は 1 枚限定）。
    - `send_voice`：単一行非空の必須 `content`（`VOICE_OPERATOR_TEXT_MAX_CHARS` 以下）と任意 `tone`（`VOICE_TONE_MAX_CHARS` 以下）。
    - `send_web_digest`：単一行必須 `topic`（`WEB_DIGEST_TOPIC_MAX_CHARS` 以下）、任意 `language`（`WEB_DIGEST_LANGUAGES`、既定 `WEB_DIGEST_DEFAULT_LANGUAGE`）、任意整数 `max_items`（`WEB_DIGEST_MIN_ITEMS`〜`WEB_DIGEST_MAX_ITEMS`、既定 `WEB_DIGEST_DEFAULT_MAX_ITEMS`）、任意 `instructions`（`WEB_DIGEST_INSTRUCTIONS_MAX_CHARS` 以下）。
  - **能力依存と `chat_id` 指定**：`assertCronAgentSupported` が起動時・ホットリロード時に `send_voice`（要 `agent.tts`）と `send_web_digest`（要会話コア能力）を検証します。`chat_id` は非空配列（`["all"]` / `CRON_ALL_CHATS`、`["except", <id>, ...]` / `CRON_EXCEPT_CHATS`、または最大 `CRON_MAX_CHAT_IDS_PER_TASK` 件の重複なし安全整数リスト）のみを受け付けます。

- **ホットリロードとスケジュール照合**（`packages/cron/scheduler.ts`、`cache/main/cron.ts`）：
  - `startConfigReload` より前に開始され、各タスクに `unref` 付きのプロセス内 Bun cron（先行ラウンド実行中は重複発火をスキップ）を割り当てます。不正リロード時は直前テーブルを維持し、ファイル削除時は空テーブルへ切り替えます。
  - **差分照合**：深い等価性を持つタスクはハンドルを維持し、変更・削除タスクは動作間隔やバックオフ待機を即時中断して送信中の単一リクエスト完了後に終了します。`just_once` は初回発火後に登録解除して `CRON_JUST_ONCE_RECORD_MAX` の LRU に記録し、`rand_cron` は発火ごとに次回時刻を一様抽選・分単位切り上げして単発 cron（`CRON_RANDOM_FIRE_TIME_ZONE`）を再登録します（停止中の未発火分は補填しません）。

- **配信とラウンド内再利用**（`packages/cron/run.ts`、`packages/cron/delivery.ts`）：
  - 動作間隔は `CRON_ACTION_GAP_MS` とし、一時的な通信・5xx・429・`TelegramSendQueueFullError`・合成 / 検索エラーは `CRON_ACTION_RETRY_DELAYS_MS` で再試行します（TTS 未設定・日次枠枯渇・不正音声・出典欠落 / 長さ超過などの恒久エラーは即時中止）。
  - **ラウンド内キャッシュ**：`CronRoundVoices` は同一 `send_voice` を 1 回だけ合成して初回成功時の Telegram `file_id` を後続グループで再利用し、`CronRoundDigests` は `send_web_digest` の MarkdownV2 本文を全対象グループで共有します。
  - **全グループ配信（`all` / `except`）と送信境界**：`packages/cron/targets.ts` が `/init` 有効グループを ID 昇順で走査し、`getChatMember` / `getChat` で `can_send_*` 権限を事前確認します（不足・失敗グループはスキップして末尾ログ出力）。`delivery.ts` はフォーラムトピックなし（General 着地）・長期保持で送信し、アップロード上限（`TELEGRAM_PHOTO_UPLOAD_MAX_BYTES`、`TELEGRAM_DOCUMENT_UPLOAD_MAX_BYTES`）の確認と 429 再試行ごとのローカルストリーム再オープンを徹底します。

- **AI 要約生成（`send_web_digest`、`workers/aiChat/ai/webDigest.ts`）**：
  - `agent.web_search` モデル（未設定時は `text` モデルの組み込み検索）を使用し、未検索（`searchCalls === 0`）時は `WEB_DIGEST_UNSEARCHED_WARNING` を付与、検索実行時は出典メタデータの HTTPS リンクのみをホワイトリスト化します。`text` モデルの構造化 JSON を `libs/webDigest.ts` で検証し（最大 `WEB_DIGEST_COMPOSE_ATTEMPTS` 回、メインスレッド待機上限 `WEB_DIGEST_REQUEST_TIMEOUT_MS`）、停止時は Telegram ゲート閉鎖前に drain します。

### 返信と response body のリソース境界

- **有界読み取りとメモリ集約**（`libs/boundedResponse.ts`）：
  - ストリーミング応答の受信時はチャンクごとに累積バイト数を検証して空チャンクをスキップし、チャンク数が `BOUNDED_RESPONSE_CHUNK_THRESHOLD` を超えた場合は `Bun.ArrayBufferSink`（チャンク上限 `BOUNDED_RESPONSE_COALESCE_BYTES`）で単一連続バッファへ集約します。上限超過・切断・キャンセル時は即時中断して解放し、アバター取得の非 2xx 応答では未消費ボディを明示キャンセルします。
- **AI 雑談の並行数と送信容量制御**：
  - ツールコンテキストは最終送信と後処理完了まで維持され、同一グループ上限 `REPLY_DELIVERY_MAX_PER_CHAT` と Worker 全体上限 `REPLY_DELIVERY_MAX_TOTAL` が生存中の全世代を一括制限します。

## 永続化

- **永続化入力の厳格な検証と祖先パスの確認**：
  - `libs/fileAccess.ts` の `inspectOptionalDirectory` および `inspectOptionalFile` は、ファイルやディレクトリが不在の際に祖先パス全体を再帰検証し、リンク切れ・循環シンボリックリンク・ファイルパスを占有するディレクトリ・`ENOTDIR`・`EACCES` を検出した場合は直ちに起動を拒否します。
  - ドメインディレクトリには有効なシンボリックリンクを許可しますが、通常の永続化データファイル（`memory/global/state.json` を含む）へのシンボリックリンクは禁止されます。
  - 起動段階では全ドメイン（身分 DB・認証・ログ・運勢・AI メモリ・`/wed` メンバーファイル）を読み取り専用で事前検査し、1 つでも失敗した場合は状態公開・秘密鍵生成・クリーンアップを一切行わずディスク上の既存データを保持します。

### 永続化と snapshot の contract

- **身分フィールドの原文通りの永続化**：
  - 復唱および翻訳の対象身分フィールド（`username`、`first_name`、`last_name`、`title`）は Telegram から受信した内容のままトリムせず保存・復元します（空文字列や空白のみも有効、非文字列型は拒否、未知フィールドは固定プレースホルダー化しログ秘匿化時に機密キー名を非出力）。
- **グローバル状態 `memory/global/state.json`**：
  - 最新値マージ・一時ファイル・`fsync`・アトミック `rename` で書き込み、トップレベルは必須の `copy` と任意の `ttsUsage` のみを保持します（`.bak` バックアップは作成しません）。
  - `loadCurrentGlobalState` は旧形式ファイル（`LEGACY_STATE_FILE_PATHS`）の存在を起動時に拒否し（`assertLegacyStateFilesAbsent`）、現行スキーマの検証失敗時も起動を阻止します。`/copy` 対象の変更は該当 revision の永続化確認まで成功を返しません。
- **音声利用枠 `ttsUsage` のスレッド帰属と永続化**：
  - 権威状態は AI Worker（`cache/workers/aiChat/ttsUsage.ts`）にあり、メインスレッドの `cache/main/storage.ts` にある `globalTtsUsageState` は永続化用ミラーです。更新ごとに全量カウント（`{ windowStartedAt, agentCount, reserveCount }`、両方 0 なら `null`）を通知し、`StateStore` が `STATE_BACKGROUND_SAVE_DELAY_MS` 遅延（停止時・強制フラッシュ時は即時）で書き出します。
  - 進行中予約（`pendingAiTtsReservations`）は AI Worker メモリのみに留まります。ウィンドウ（`TTS_USAGE_WINDOW_MS`）は時計の大幅な巻き戻し時に再作成され、設定上限の引き下げ時は過去カウントを書き戻さず超過する新規リクエストのみを拒否します。
- **翻訳セッション（`ChatState.translate`）の状態管理**：
  - SQLite `chat_states` に保存され（ホットコピーは `STATE_MANAGED_CHAT_LIMIT` を共有）、グループごとに最大 `TRANSLATE_CHAT_USER_LIMIT` 件の対象身分と言語（`TRANSLATE_LANGUAGE_CODES`）を保持します（空のときは `undefined`。`memory/global/state.json` 内の `translate` キーは起動拒否）。
  - `translate/message.ts` がグループ別に直列非同期送信し（上限 `TRANSLATE_CHAT_BACKLOG_MAX`、本文なし・描画可能コマンド・目標言語一致は投入前にスキップ）、開始・停止は `persistChatState` の確認後にのみ成功を返します。
- **状態ファイルの読み取り境界**：
  - `memory/global/state.json` は `lstat` で通常ファイルであることを検証し、シンボリックリンク・ディレクトリ・`EACCES`/`ELOOP`/`ENOTDIR` は起動を拒否します（`ENOENT` のみ未作成扱い）。fatal モードの `TextDecoder` で UTF-8 デコード（BOM 除去）し、失敗時は原本を保護します。
- **素材設定 `config/dynamic/assets.json`**：
  - トップレベルは `ASSET_CONFIG_GROUPS` の 3 グループ（`ASSET_ONLY_PATH_GROUP` の `random_h_image_dir`、`ASSET_PATH_OR_URL_GROUP` の `bot_default_avatar`、`ASSET_ONLY_URL_GROUP` の運勢・gag サムネイル）のみを許可し、省略時は `consts/ui/assets.ts` の定数へフォールバックします（未知キーは全体拒否、Bot からの書き換えなし）。
  - **プロトコルとパス規則**：クライアント取得のサムネイルは `https` 限定、`bot_default_avatar` は `http` / `https` またはローカルパス（絶対パス、`./`、`../`）を許可します。
  - **既定アバター素材の検証（`defaultAvatarPhotoType`）**：
    - **静止アバター**：`BOT_PROFILE_PHOTO_MAX_BYTES` 以下の JPEG / PNG。
    - **アニメーションアバター**：`BOT_PROFILE_ANIMATION_MAX_BYTES` 以下で `vide`（`hdlr`）トラックを 1 本以上持ち、全動画トラックの `tkhd` 表示サイズが一辺 `BOT_PROFILE_ANIMATION_MAX_SIDE` 以下の非ゼロ正方形である MP4。
    - **MP4 box 構造検査**：先頭が MP4 ブランドの `ftyp` であり、続くトップレベル box がファイル長と過不足なく一致して `moov` をちょうど 1 つ含み、`moov`・`trak`・`mdia` の子 box も親ペイロードを過不足なく埋めること（走査上限 `MP4_MAX_SCANNED_BOXES` 個、長さ超過や途中切れは不合格）。
    - **検証タイミングと読み取り上限**：ローカルファイルは設定読み込み時とアバター復元時の双方で検証し、URL は復元時に検証します（読み取り上限 `DEFAULT_AVATAR_MAX_READ_BYTES`、URL 取得タイムアウト `DEFAULT_AVATAR_FETCH_TIMEOUT_MS`）。
- **統一ログレベル閾値と秘匿化（Redaction）境界**：
  - 適用中の `log_level` 未満の `logger.*` 呼び出しはシリアライズ・秘匿化を行わず即時リターンします。閾値以上のログはコンソール出力時に `CONSOLE_PREFIX_BY_LOG_LEVEL`（`[INFO]` / `[OPERATION]` / `[WARN]` / `[ERROR]`）を前置して構造化オブジェクトをネイティブ出力し、プレフィックスなしの `LogMessage` でスレッド間を転送後、`logs/<YYYY-MM-DD>.json` に `{ level, message, args? }` 形式で保存します（`message` は文字列引数の連結、`args` は非文字列の構造化引数のみを格納し存在しない場合は省略）。
  - 閾値以上のログはコンソール・Worker エンベロープ・`logs/` への出力前に設定内の全機密資格情報を秘匿化し、HTTP(S) URL を `origin + pathname` のみに正規化します（`operation` 監査ログにはパスワード・OTP・`initData` 署名・チャットや Q&A 本文の生テキストを含めません）。
  - エラーの `cause` と `AggregateError` は最大深度 `LOGGER_NESTED_ERROR_MAX_DEPTH`・最大ノード数 `LOGGER_MAX_ERROR_NODES` まで展開し、引数は `LOGGER_MAX_SERIALIZED_BYTES` および `LOGGER_MAX_SERIALIZED_ITEMS` で制限します（循環参照は固定プレースホルダー化）。
- **グループ状態の正準形状と Normalizer**：
  - `ChatState`（`libs/chatState.ts` の `createChatState`）は生成時に全フィールドを一度に初期化し（未設定は `undefined`、`delete` による形状変更は禁止）、`chat_states.status` には非既定値と確認済み `botPermissions`（全 `false` も `undefined` と区別して保存）のみを書き出します。
  - `normalizeChatState` は期限切れフィールドのみを回収し、`quietUntil` は微小な時計ずれを `QUIET_CLOCK_SKEW_TOLERANCE_MS` で吸収し、大幅な時計巻き戻し時は `now + QUIET_MAX_DURATION_MS` にクランプします。
- **永続化のバッチ処理とタイムゾーン保守**：
  - AI メモリは `AI_SNAPSHOT_INTERVAL_MS` ごとに共有 SQLite トランザクションで `chat_states.ai_context` を更新し、追記型ファイル（運勢・認証待ち・ログ・AI キャッシュ使用量・広告サンプル）は `FLUSH_MAX_ENTRIES` 件または `FLUSH_INTERVAL_MS` でバッチ書き込み + `fsync` を行います。
  - 設定タイムゾーンの日跨ぎには Disk I/O Worker の `DISK_IO_MAINTENANCE_CRON` が発火し、メインスレッドへの `/wed` 日次再確認通知に続けて各ドメインの日次ローテーションとアーカイブを順次実行します。
- **入室ログ（`joinLog`）のバッチ処理と `/batch_kick` の読み出し**：
  - `recordJoinLog` はメインスレッドの未確認ミラーへ登録して即座に復帰し、Disk I/O Worker が `chatId:day` 単位で書き込んで `(through, pending)` シーケンスを返します（失敗時は破棄せずバックオフ再試行）。
  - `/batch_kick` は Telegram イベント原本時刻（`joinedAt` の設定タイムゾーン日付）に基づく `[since, now]`（`BATCH_KICK_MIN_DURATION_MS`〜`BATCH_KICK_MAX_DURATION_MS` / `DAY_MS`）を読み出し、ユーザーごとの最新記録へ重複排除したうえで、ホワイトリストはスキップ、ブラックリストは統一 BAN（バッチ完了後に再スイープを 1 回要求）、残存メンバーは `kickChatMemberWithOutcome` でキック（BAN なし）します。
- **ペルソナと通知文言の起動時スナップショット**：
  - `prompt/persona.md`（不在時は `DEFAULT_AI_PERSONA`）と `prompt/voice_tool.md` は起動総ゲートで不変スナップショットとして読み込み、稼働中のホットリロードは行いません。
  - グループ通知のトーンは `bot.json` の `atmosphere`（`mesugaki` / `normal`。省略時はカスタムペルソナがあれば `normal`、なければ `DEFAULT_BOT_ATMOSPHERE`）でプロセス全体に固定されます。Mini App コンソールの画面文言はこの設定に従わず、常にメスガキ風です。

### グループ状態と `chat_states`

- **権威ストレージと容量上限**：
  - 権威ストレージは SQLite `chat_states` テーブルであり、メインスレッドは上限 `STATE_MANAGED_CHAT_LIMIT` 件のホットリード用コピー（`packages/cache/main/chatState.ts`）を保持します。`status` カラムには機能スイッチ（`isProxySendEnabled` を含む）・`quietUntil`・`lockdown`・`botPermissions`・`title`・`translate`・`deleteMessageTargets` を格納します。
- **容量保護ポリシー（LRU 淘汰禁止）**：
  - 上限到達時は `assertChatStateCapacity`（起動デコード `decodeStoredChatStates`・メインスレッド受付・Disk I/O 書き込み前の 3 箇所）で厳格に拒否し、LRU 淘汰は行いません。挿入順イテレーションを維持して `/block` 連動グループの提示順序を決定論的に保ち、新規枠確保は `/init enable`（上限超過時は `INIT_CHAT_LIMIT_TEXT`）のみに許可します。
- **状態の回収・プロキシ唯一性・永続化バリア**：
  - 書き込み前の `normalizeChatState` 後に `isEmptyChatState` が真となればメモリ削除と削除 tombstone 書き込みを行います（`/init disable` 時は `title` も同時消去して枠を解放）。
  - `isProxySendEnabled` が真のグループはグローバルで最大 1 件に制限されます。権威変更は `persistChatState`（ライトスルー + exact revision ACK）を待機し、再構築可能な状態更新は `saveChatStateInBackground` を使用します。

<p align="right"><a href="#クイックナビゲーション">↑ クイックナビゲーションへ戻る</a></p>

### chat Q&A と `chat_qa`

- **権威ストレージと三重の件数上限検証**：
  - SQLite `chat_qa` テーブル（複合主キー `(chat_id, q)`、`q` インデックス、全表上限は管理グループ数 × `CHAT_QA_MAX_PER_CHAT`）を起動時に一括ロードし、メインスレッドが唯一のホットコピー（`packages/cache/main/qa.ts`）を保持します。グループ上限は `setChatQa`・Disk I/O トランザクション投入前・起動デコードの 3 箇所で独立検証されます。
- **`/qa set` フォームの認証・検証・ライフサイクル**：
  - `isCanControllQaPermission` を検証して `openedById`（`visibleSenderChat`）と `messageThreadId` を記録し、以後の投稿は同一フォーラムトピック（`forumTopicThreadId`）かつ同一可視身分の一致のみで受理します（各 `await` 後にセッション有効性を再確認し、送信と削除は `qa/notices.ts` に集約）。
  - **項目検証**：質問 `CHAT_QA_QUESTION_MAX_CHARS` 超過、回答 `CHAT_QA_ANSWER_MAX_CHARS` 超過、または質問全体・回答の ```` ``` ```` コードブロック外（`renderFencedText` で分割）にクリック可能なコマンド表記（`containsRenderableCommand`）が含まれる場合は書き込まず、フォームを残したまま `QaFormIngressResult.rejection` の案内を返します。
- **自発メッセージ遮断・プレビュー切り詰め・看板ページング**：
  - `["message", "channel_post"]` 入口は `isBotOwnMessage` をコスト昇順（グループ ID の Map 照合 → `selfSentTracker.ts` のローカル ID 照合 → `waitForBotOwnMessage` の協調待機）で評価して自己跳ね返りを遮断します。
  - コードブロックはリテラル ```` ``` ```` として保存し（`CHAT_QA_ANSWER_MAX_CHARS` に算入）、`renderQaFormPrompt` と `/qa query`（回答プレビュー上限 `QA_QUERY_ANSWER_PREVIEW_MAX_CHARS`、1 ページ `QA_QUERY_PAGE_MAX_ENTRIES` 件、`callback_data` ページ番号）は表示時のみ回答を切り詰め、DB には全文を保存します。
- **直接回答の一致判定と AI ツールへの遅延 JSON 受け渡し**：
  - 質問文は書き込み時トリム・実行時完全一致（先頭 `@Bot` メンションのみ大小文字無視）で判定し、AI 雑談より優先かつ `/quiet` 非抑制で即答して下流処理と AI 記憶記録を打ち切ります。
  - **AI ツール用遅延キャッシュ**：メインスレッドのホットコピーは `[質問, 回答]` 配列の JSON 文字列と件数を遅延構築して保持し（書き込み・削除・teardown 時に無効化）、`trigger` でこの 2 つのプリミティブ値のみを AI Worker へ渡します。`group_qa_query` と `group_qa_answer` はツール呼び出し時にのみ JSON を解析します。

### ブロックリストと広告検出

この節では、[正式なブロックリストと block コマンド](#正式なブロックリストと-block-コマンド)、[広告検出の受付・判定・処置](#広告検出の受付判定処置)、[BAN とメッセージ撤回](#ban-とメッセージ撤回)、[blocklist removal outbox](#blocklist-removal-outbox)、[権限回復後の replay](#権限回復後の-replay)、[ブロックリストの退会アカウント検出](#ブロックリストの退会アカウント検出)を順に説明します。

#### 正式なブロックリストと block コマンド

- **権威名簿とキャッシュの一貫性**：
  - 権威ストレージは SQLite `blocklist_entries` であり、メインスレッドは有界 LRU キャッシュと未確認書き込みオーバーレイを保持します（時間失効なし。解除は `/block disable` または[退会アカウント検出](#ブロックリストの退会アカウント検出)のみ）。
  - 各行は `blockedAt`・Telegram メタデータ・任意の `participantInvalidCount`（存在する場合は `1`〜`BLOCKLIST_PARTICIPANT_INVALID_LIMIT - 1` の整数、省略時は 0）を持つ厳格な JSONB レコードです。
- **`/block disable` による完全解除フロー**（要 `isCanUnBlock`）：
  - テーブル内に存在する場合、ネガティブキャッシュと件数を公開し、`pendingBlockedRemovals` から該当 ID を除外した outbox 更新を**先に**投函してから削除 tombstone（`queueBlocklistDeletion`）を送ります（Disk I/O が outbox 更新を削除より先にコミット）。
  - 登録有無にかかわらず `managedAdminChatIds` 全グループ（発行元グループ先頭）で BAN 解除（ユーザーは `only_if_banned: true` の `unbanChatMemberIfBanned`、チャンネルは `unbanChatSenderChat`、`canRestrictMembers === false` 確証グループはスキップして失敗計上）を実行します。
- **保護対象身分・排他直列化・永続化バリア**：
  - `SUPER_ADMIN_USER_ID` と恒久ホワイトリスト（`isWhitelisted`、一時広告免除は対象外）は `/block`・`/mute`・`/batch_kick` から保護され、`/white enable` は既ブロック身分を拒否します。`runProtectedIdentityMutation` がメインスレッドで判定とキャッシュ更新を直列化し（一時免除の tombstone を先行投入）、ネットワーク呼び出しと永続化待機はクリティカルセクション外で行います。
  - `confirmBlocklistPersisted`（`confirmIdentityPolicyPersisted("blocklist", id, …)`）は共有 SQLite トランザクションのみをフラッシュして該当 ID の exact revision ACK を確認します（全体フラッシュ時は `failedDomains` を明示し、AI キャッシュ使用量や広告サンプルの失敗はログのみ）。未確認書き込みが残る同一対象への再実行は `retryUnacknowledged`（`requeueUnacknowledgedIdentityWrite`）で同一 revision を再送します。
- **グループ補完スイープ（`sweepBlockedMembers`）と対象管理者 / 権限不足の細分化**：
  - 「Bot が管理者かつ `/init` 有効」で補完スイープを実行し、`complete: true` の `blockedMembersRemoved` 受信後にのみ `blocklistSweepState` の `sweptAt` を記録します（残存発覚時は `requestBlocklistResweep` で `null` リセット、バックオフは `BLOCKLIST_SWEEP_RETRY_INTERVAL_MS` から線形増加して上限 `BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS`、管理解除時は `forgetChatBlocklistWork` で破棄）。
  - **403 / 権限・管理者保護 400（`forbidden`）の切り分け**（`isPermissionDenied` が 403 および `packages/consts/telegram.ts` の `TELEGRAM_PERMISSION_DENIED_DESCRIPTION_PATTERN` に一致する 400 を分類）：
    - **対象がグループ管理者**：補完スイープ経路（`probeMembership: true`）は `probeChatMembershipWithOutcome` で直接識別し、非照会経路（`probeMembership: false`）は `forbidden` 受信後に `probeChatAdmin` で確認します。管理者確証時は当該対象のみをスキップして残りを完遂しつつ `targetIsAdmin` を付与し、メインスレッドは `sweptAt` を更新せず補完スイープ待ちを維持します。
    - **Bot の BAN 権限不足**：Worker が `permissionDenied` を返し、メインスレッドは `permissionBlocked` と outbox の `missing-permission` を記録してタイマー再試行を停止します（`canRestrictMembers: true` 確認時に解除）。
- **入室時即時キックと `/block` クロスグループファンアウト**：
  - 処分バッチは `trackBlockedRemoval` で `pendingBlockedRemovals` に記録され、ブラックリスト対象の入室は認証ウィンドウを開かず即時キックします（`recentBlockedJoinCounts` で `chat_member` と `new_chat_members` の重複を排除し、参加カウント補記と参加通知削除を実行）。
  - `/block`（`enable` / `disable`）のクロスグループ処理（`commands/blocklistFanOut.ts`）は対象身分の直列枠（`blocklistIdentityMutationRunner`、広告処置と共用）を到着順に予約します：枠が空いていれば当該 update 内で書き込みと永続化確認を完了させ、先行処置中であればファンアウト（バックグラウンド枠・並行上限 `MANAGED_CHAT_BATCH_CONCURRENCY`）とともに後回しにします（開始前・待機中の停止キャンセル時は書き込みも応答も省略してエラーログ出力）。名簿の変更直前には各変更点（`enable` は `runProtectedIdentityMutation` の臨界区内、`disable` は直列枠内の `removeFromBlocklist` 冒頭）で対象身分が身分 LRU に残っているか再確認し、待機中に追い出されていれば再プリフェッチし、失敗時はストレージ利用不可だけを返信して名簿も横断処理も変更しません。

#### 広告検出の受付・判定・処置

- **受付ゲート・再検証・特殊ソース**：
  - 検査対象への投入には `ChatState.isAdDetectEnabled === true`・Bot 管理者権限・ホワイトリスト保護対象外（スーパー管理者、すべての恒久ホワイトリスト身分、および有効な一時広告免除身分は候補受付・引用警告・処置再検証のいずれでも一律免除）の 3 条件が必要です。`/white enable` や Mini App での恒久ホワイトリスト追加、または一時広告免除の初回付与時にはメインスレッドから `clearIdentityAdDetect` を送信し、Worker 側の未決済キュー・バンドル・引用警告・抑制記録を消去します。`adDetected` 受信後、メインスレッドは `blocklistIdentityMutationRunner` とクリティカルセクション内でスイッチ・ホワイトリスト保護・`ad_detect.json` を再確認し、拒否時はメッセージ削除も処罰も行わず即座に `releaseAdDetectDedup` で抑制記録を解放します。
  - 自動転送（`is_automatic_forward`）・Bot 自身の投稿（`isBotOwnMessage`）・ディスカッション引用内のチャンネル原文・グループオーナーと人間の管理者は除外します（管理者 Bot は検査対象）。自身の inline 結果（`via_bot` 一致）は `recordInlineResultSources`（上限 `INLINE_RESULT_SOURCE_MAX_AUTHORS`）の元クエリテキストを検査へ回します。
- **Worker キュー管理と抑制ウィンドウ**：
  - `chatId:senderId` ごとに連続メッセージを `pendingAdMessages` の単一 bundle（送信者上限 `AD_DETECT_MAX_PENDING_SENDERS` で未判定者の追い出しなし、1 束あたり最大 `AD_DETECT_MAX_MESSAGES_PER_SENDER` 通・`AD_DETECT_BUNDLE_MAX_CHARS` 文字、溢れた ID は `pendingDeleteIds` へ移動）にまとめ、`AD_DETECT_QUEUE_TICK_MS` ごとに最大 `AD_DETECT_BATCH_SIZE` 件・同時実行上限 `AD_DETECT_MAX_IN_FLIGHT` で処理します。
  - 命中報告直後のキーは `recentlyDisposedAdKeys` に `AD_DETECT_JUDGED_RETENTION_WINDOW_MS` 保持し、期間内の追撃メッセージを判定せず個別削除します（`revoke_messages` 付き BAN が適用される恒久ブラックリスト済み一般ユーザーは除外）。メインスレッドが処置を拒否した場合、グループ内処罰（`mute` / `kick` / `banChat` / `deleteOnly`）を完了した場合、または全体 BAN で発生グループの削除バッチを Worker へ引き継がなかった場合は `releaseAdDetectDedup` で即座に解放します（発生グループを引き継いだ場合は `blocklistEffects` が BAN 確定時に解放）。
- **3 段階検出パイプラインとマルチモーダル判定**：
  - 候補抽出（`packages/antiRaid/adCandidate.ts`）は送信者自身のメッセージのみから写真（`message.photo`）、`AD_DETECT_IMAGE_DOCUMENT_MIME_TYPES` に一致する画像ドキュメント（`file_size > MEDIA_MAX_DOWNLOAD_BYTES` 時は `document.thumbnail` へフォールバック）、静止／アニメーション／動画ステッカー、およびカスタム絵文字を抽出し（`reply_to_message` や `quote` のメディアは対象外）、本文のないメディア単体メッセージも受け入れます。
  1. **スタンプパックブラックリスト高速経路**（Worker 件数ミラー `adPackBlacklistCounts.sticker`、正本はメインスレッドの 768 件 LRU／SQLite `ad_pack_blacklists`）：件数が 0 のときは O(1) で同期ショートサーキットし、非ゼロ時は未判定エントリの正規 `sticker.set_name` を双方向ブリッジ（`matchAdPackBlacklist`）経由でメインスレッドの 768 件 LRU へ照合（コールドミス時は Disk I/O SQLite を参照して LRU へ補填）し、一致すれば即座に広告処置します（照会失敗時はエラーログを出してフェイルセーフで後段へ進行）。
  2. **カスタム絵文字パックブラックリスト**（Worker 件数ミラー `adPackBlacklistCounts.emoji`、正本はメインスレッドの 768 件 LRU／SQLite `ad_pack_blacklists`）：
     - 件数が 0 のときは O(1) でスキップし、非ゼロ時は Worker の LRU キャッシュ `customEmojiMetaCache`（`packages/cache/workers/antiRaid/adDetect.ts`、上限 `AD_DETECT_CUSTOM_EMOJI_SET_CACHE_MAX`、Worker 停止時に破棄、`{ setName, visionFileId, fileUniqueId }` を保持して第 3 段階の視覚ダウンロードと共用）を優先照合してヒット済みパック名を双方向ブリッジ経由でメインスレッドの 768 件 LRU／SQLite へ一括照合します。未ヒット ID は `TELEGRAM_CUSTOM_EMOJI_STICKERS_MAX_IDS` 件ずつメインスレッドの `query` レーン経由で `getCustomEmojiStickers` に問い合わせ、結果をキャッシュしつつ各バッチの解決済みパック名をメインスレッドの 768 件 LRU／SQLite へ照合します（一致で即時広告処置）。
     - 照会失敗は全バッチ共通で最大 `AD_DETECT_CUSTOM_EMOJI_QUERY_MAX_RETRIES` 回即時再試行し（4xx は再試行なし）、予算切れ・拒否・停止時はエラーログを記録して第 3 段階へ進みます。
  3. **AI マルチモーダル・テキスト判定**（`agent.ad_detect` および `ad_detect.json` の `samples`）：
     - **メディア選定と累積バイト予算**（`packages/workers/antiRaid/adDetect/media.ts`）：`kind + fileUniqueId` で重複排除し、1 バンドルあたり最大 `AD_DETECT_MAX_IMAGES_PER_BUNDLE` 枚を選定します（未判定エントリ `seq > checkedSeq` を優先し、残枠を文脈エントリ `seq <= checkedSeq` の新しい順に補完して時系列順で出力）。メインスレッドの `downloadFile`（`purpose: "vision"`）で並行ダウンロードして `prepareVisionImage` で変換し、バンドル全体の変換後合計バイト数を `MEDIA_MAX_DOWNLOAD_BYTES` 以内に制限します（未判定添付の予算を優先し、超過分は警告ログを出してスキップ）。再ダウンロードなしで `combined` と `direct`（非転送）の 2 スライスを生成し、未判定テキストがなく未判定添付も 0 件のラウンドは冗長な AI 呼び出しをスキップして `notAd` を返します。
     - **Google Decisions API 経路**（`provider: "google"` かつ `use_decision: true`、`packages/workers/antiRaid/adDetect/ai/googleDecision.ts`）：`resolveGeminiDecisionEndpoint` で `base_url` を正規化し（ゲートウェイルート・`/<apiVersion>`・`/<apiVersion>/decisions` に対応、既定は `GEMINI_API_BASE_URL` + `GEMINI_API_VERSION`）、単一の `client.decisions.create` リクエストで `ad`（しきい値 `AD_DETECT_DECISION_AD_THRESHOLD`）、`category`（`AD_DETECT_DECISION_CATEGORIES`）、および候補パックごとの `sticker_pack_N` / `emoji_pack_N`（しきい値 `AD_DETECT_DECISION_PACK_THRESHOLD`）を評価します（非空の `prompt_feedback.block_reason`・不正応答・API エラー時はフェイルクローズで `null` を返却）。
     - **生成系マルチモーダル経路**（`google` の `use_decision: false`、`openai`、`anthropic`）：表示名（`firstName`、`lastName`）、非転送本文、本文外の固定位置に添えた入室認証中事実、およびラベル付き画像を統合評価し、`"JSON"` 指定による裸の JSON 応答を要求します（候補パックがある場合は Google・Anthropic で構造化出力を `AD_DETECT_PACK_JSON_SCHEMA` へ切り替えパック帰属指示を付与し、返却パック名は現スライスの候補集合で厳密フィルタリング。**宣伝・勧誘・取引文言を一切含まないリンクのみの投稿は必ず `false` と判定**）。画像非対応エラー（`packages/aiProviders/mediaSupportError.ts` の `isExplicitUnsupportedMediaError`）検出時は設定スナップショット同一性でホットリロード競合を防いだうえで `adDetectVisionSupport.current = "unsupported"` を記録し（`agent.ad_detect` リロードまたは Worker 停止でリセット）、テキスト専用判定へフォールバックします（本文なし時は `{ isAd: false }`）。
     - **引用型広告の境界**（`verdict.ts`・`referencedWarning.ts`）：`referencedOnly` 警告ではすべてのパック帰属を破棄し、自動ブラックリスト化を行いません。
- **処罰の選択・広告パックブラックリスト永続化・通知**（`states/adPunishment.ts`、`packages/infra/adPackBlacklistStorage.ts`、`packages/antiRaid/adBlacklistPersistence.ts`）：
  - 命中時は Worker が削除対象 ID（`deleteMessageIds`）をまとめて `adDetected` に載せて返し（事前削除はしない）、メインスレッドが再検証を通過して `ad_detect.json` の `punishment` を読み取った後に `inFlightAdDisposals` 内で `TELEGRAM_DELETE_MESSAGES_BATCH_MAX` 件ずつ並行削除をスケジュールし、処罰を実行します：
    - `kick`・`block_scope: "global"`：`blockUser` とフラッシュ後に全管理グループへ耐久処分バッチを投入（ユーザー・チャンネル共通）。
    - `mute`：発生グループでミュート（期限付きミュートのディスパッチ期限は期間 − `MUTE_DISPATCH_MIN_REMAINING_MS`、無期限ミュートは `until_date` なし）。
    - `kick`・`block: false`：`chatIsSupergroupById` 確認と在室確認のうえで BAN なしキック（既ブロック者はブラックリスト BAN に委譲）。
    - `kick`・`block_scope: "chat"`：発生グループのみで `banChatMember`（`revoke_messages: true`）を実行（恒久ブラックリスト非登録）。
    - **チャンネル身分**は全体 BAN 以外ではメッセージ削除のみを行います。本グループ内処罰は `inFlightAdDisposals` で追跡し durable outbox には入れません（停止予算切れ・再起動・`ad_detect.json` 削除時は放棄）。
  - **広告パックブラックリストの永続化・768 件 LRU キャッシュ・自動登録**：
    - **権威ストレージ・768 件共有 LRU・コールドリード隔離**：スタンプパック・カスタム絵文字パックのブラックリストは SQLite `ad_pack_blacklists` テーブル（`PRIMARY KEY (kind, pack)`、`kind IN ('sticker', 'emoji')`、種別ごとの件数上限なし。起動時は Disk I/O で全行をストリーミング検証し、`initAntiRaid` 前に両種別の件数統計のみを `packages/cache/main/adPackBlacklist.ts` へ hydrate して全表をメモリに展開しない）に永続化されます。メインスレッドは容量 `AD_PACK_BLACKLIST_READ_CACHE_MAX_ENTRIES`（768）の共有 LRU キャッシュ（`adPackBlacklistCache`、ステッカー・絵文字共用、正・負キャッシュ双方を保持）を管理します：ホット参照（`findFirstBlacklistedAdPack` / `readAdPackBlacklistStates`）は未 ACK 書き込み表と 768 件 LRU を優先参照し、コールドミス時のみ `AD_PACK_BLACKLIST_READ_CHUNK_MAX_ENTRIES`（256）単位で接続級プリペアドステートメント（単件は主キー一致、複数は `json_each`）から Disk I/O SQLite を参照して LRU へ補填します。一覧・検索（`/ad_detect <sticker|emoji> list` および Mini App `GET /api/ad-blacklists`）は `listAdPackBlacklistPage`（`AD_PACK_BLACKLIST_PAGE_SIZE` = 256）で SQLite カーソルをコールドリードし未 ACK 書き込みを重ね合わせるため、768 件 LRU の読み書きを一切行いません。
    - **書き込みプロトコルと件数ミラー同期**：メインスレッドの書き込みは `adPackBlacklistMutationChain` で直列化（コールドキー変更前に SQLite を確認して重複排除と件数整合性を維持）し、共有 SQLite 書き込み予算・768 件 LRU ライトスルー・単調 revision の exact ACK（`"adPackBlacklist"` ドメイン、バッチしきい値 `AD_PACK_BLACKLIST_WRITE_BATCH_MAX_ENTRIES`、Disk I/O 再構築時は LRU 常駐に依存せず未 ACK 表の最終意図を `DISK_IO_RESPAWN_PRIORITIES.AD_PACK_BLACKLIST` で昇順リプレイ）に従います。変更は `registerAdPackBlacklistObserver` 経由の独立メッセージ `AdPackBlacklistSyncMessage`（`stickerCount` / `emojiCount` のみ）で Anti-Raid Worker へ配信され、`adoptAdPackBlacklistSyncMessage` は `adPackBlacklistCounts` のみを更新し、AI SDK クライアント・`adDetectPrompts`・`adDetectVisionSupport` をリセットしません。
    - **自動ブラックリスト永続化**：直接広告の命中に AI 帰属のステッカー／カスタム絵文字パックが含まれる場合、メインスレッドは送信者処罰をブロックせずに `inFlightAdDisposals` 内で `persistAutoBlacklistedAdPacks` をスケジュールします（停止時 drain 対象）：`STICKER_PACK_NAME_PATTERN` で正規化・重複排除し `config/dynamic/stickers.json` の自用パックを除外したうえで、`addAdPackBlacklistBatch` で 768 件 LRU・件数・Disk I/O キューへ登録（完了後に `AdPackBlacklistSyncMessage` を 1 回配信）、続けて `flushAdPackBlacklistWrites` で `"adPackBlacklist"` ドメインの永続化を確認します。ディスク確認に失敗した場合は例外を投げず警告ログを出して未確認 revision をメモリに保持（Disk I/O 再送待ち）し、`config/dynamic/ad_detect.json` は一切変更しません。
    - **手動管理の共有境界**：`/ad_detect sticker|emoji`（`list|add|remove`、要 `isCanControllAdDetectPermission`）および Mini App `GET|POST /api/ad-blacklists` は共通の `packages/infra/adPackBlacklistStorage.ts`（`listAdPackBlacklistPage` / `persistAdPackBlacklistAdd` / `persistAdPackBlacklistRemove` / `confirmAdPackBlacklistPersisted`、重複追加・未登録削除時も未 ACK の同一 revision を補投して永続化を確認）を経由し、`STICKER_PACK_NAME_PATTERN` 検証と `stickers.json` 自用パック保護を統一強制します（種別ごとの件数上限なし）。
  - 通知（`formatAdNotice`、`enforcedChats` / `failedChats` または本グループ処罰成否）は `sendTemporaryMessageOnMain`（`COMMAND_MESSAGE_AUTO_DELETE_MS`）で送り、命中サンプルは `AD_SAMPLE_FILE_PATH`（上限 `AD_SAMPLE_FILE_MAX_BYTES`、保持日数 `AD_SAMPLE_ARCHIVE_RETENTION_DAYS`）へ日次ローテーション追記します。

#### BAN とメッセージ撤回

- **メッセージ撤回メカニズム**：
  - ユーザーに対するブラックリスト BAN および本グループ広告 BAN は常に `revoke_messages: true` 付きの `banChatMember` で過去メッセージを撤回し、自動撤回を持たないチャンネル身分の `banChatSenderChat` ではメインスレッドの広告処置が再検証通過後に `deleteMessageIds` を明示削除します。

#### blocklist removal outbox

- **行単位の write-ahead 永続化と予算管理**（`pending_blocked_removals`）：
  - メインスレッドは行の変更・削除ごとに単調増加 revision 付きの `blocklistRemovalWrite` を送信します（送信前に共有 SQLite 予算 `STORAGE_PENDING_MAX_ENTRIES`・`STORAGE_PENDING_MAX_BYTES` を検証し、超過時は新規行を取り消して Disk I/O fatal を発火。コミット後の `(removalId, revision)` exact ACK でバイト枠を解放し、Disk I/O 再構築時は未確認行のみを revision 順に再送）。
  - 診断フィールド（`attempts`、`lastFailure`）のみの変更はいったんメモリに留め、Anti-Raid Worker への委譲前に write-ahead で全行の現在値を durable 化してからタスク委譲と update 確認を行います（outbox 上限は `BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES`）。
- **参照整合性と行構造**：
  - Disk I/O Worker は即時キック行（`probeMembership: false`、確定 `userIds` を凍結保持）の全 ID が有効ブラックリストに存在すること、および補完スイープ行（`probeMembership: true`、グループ ID のみ保持し実行時に `BLOCKLIST_SWEEP_PAGE_SIZE` カーソルでページング）がある間はブラックリストが空でないことを双方向に検証します（`unblockUser` は outbox 行更新をブラックリスト削除より先に送信。`storageFlushHold` ミラー再送中のみ削除側検査を省略し、クローズ・起動時に再検証）。

#### 権限回復後の replay

- **権限回復後の復旧手順**：
  - `can_restrict_members` の回復を確認した際、保留中の即時キック・広告処分 outbox 行を元の `removalId` で優先リプレイし、続けて全名簿の補完スイープを 1 回発行します（両者は独立して収束）。

#### ブロックリストの退会アカウント検出

- **退会エラーの検出と自動解除**：
  - 全名簿の補完スイープにおいて全試行（`BLOCKLIST_REMOVAL_MAX_ATTEMPTS` 回、停止中断を除く）で 400 `PARTICIPANT_ID_INVALID` が返った対象を `participantInvalidUserIds` として報告し、`participantInvalidCount` を加算します（`settledUserIds` に含まれた対象はカウントを消去）。
  - `participantInvalidCount` が `BLOCKLIST_PARTICIPANT_INVALID_LIMIT` に達したアカウントは退会済みと判定し、`unblockUser` でネガティブキャッシュ公開・削除 tombstone 書き込み・監査ログ記録を行って補完スイープループから除外します（グループ横断の BAN 解除 API は呼びません）。

### 運勢と AI メモリの復元

- **運勢の日跨ぎローテーションと滞留キュー**：
  - 日付 owner 切り替え前に前日の追記バッファをフラッシュし、失敗時は旧 owner を維持したまま新日付の抽選記録を滞留バッファ（上限 `LUCK_DEFERRED_DRAW_MAX`、メインスレッド `dailyLuckCache` は記録済み）へ退避してフラッシュ成功後に補記します（確認済みレコードがある日の鍵欠落・日付不一致は起動・切り替えを拒否）。
- **日跨ぎ起動の時間許容処理**：
  - 00:00 前後の起動でメインスレッドと Disk I/O Worker の当日判定に 1 日のずれが生じた場合はキャッシュを空にし、初回リクエスト時に `ensureLuckCacheFreshForToday` で当日の最新鍵を再取得します。
- **AI メモリ復元ゲートと派生インデックス（`chatMessageIndexes`）**：
  - 起動時は現行制約（`AI_MEMORY_HYDRATE_BUFFER_MAX`、`MAX_SUMMARY_ROUNDS`、単一行テキスト、引用上限 `REPLY_REFERENCE_MAX_CHARS`、`LOCAL_TIMESTAMP_PATTERN`、厳格な `pendingImage`、グループ総数上限 `AI_MEMORY_MAX_CHATS` = `2 × STATE_MANAGED_CHAT_LIMIT`）を満たす version=1 スナップショットのみを切り詰めなしで受け入れます（AI Worker が再起動予算を使い切った際は `lastInitState.current` をクリアして `flushAiMemory` が `flushed` を返すようにします）。
  - `chatMessageIndexes` はホット領域から導出される非永続インデックスであり、自己返信チェーンは `reply_to_message`（ホット領域外流出時はラウンド開始時の trigger スナップショット）で関連付けます。

### 確認境界と停止

- **Telegram Update の確認境界**：
  - ポーリング件数は `UPDATE_POLL_LIMIT` に固定し、ミドルウェアと全副作用の確定後にのみ offset を進めます。停止中に失敗または中断された update は明示的失敗フラグを立て、**最終 offset の確認を拒否**して非ゼロ終了することで再起動後の再配信を保証します。
- **ロングポーリングとネットワークバックオフ**（`app/updateFetcher.ts`）：
  - タイムアウト `UPDATE_POLL_TIMEOUT_SECONDS`・再試行ウィンドウ `UPDATE_POLL_RETRY_WINDOW_MS` で `UPDATE_POLL_INITIAL_RETRY_MS`〜`UPDATE_POLL_MAX_RETRY_MS` の指数バックオフを行います（`retry_after` 付き 429 はまず `retry_after` を待ち切ってから指数バックオフを実行し、401/409 は即時 fatal 終了。連携チャンネル照会は `LINKED_CHANNEL_FETCH_TIMEOUT_MS` でタイムアウトし `undefined` を返却）。
- **最終 Offset 確認と停止の 3 値分類（`classifyShutdown`）**：
  - 最終 `getUpdates(timeout: 0)` は `FINAL_OFFSET_CONFIRM_TIMEOUT_MS` で保護され、停止結果は次の 3 値に分類されます：
    - `clean`：全排出・フラッシュ完了かつ最終 offset 確認成功（正常終了、ロック解放）。
    - `offsetWithheld`：全排出・フラッシュと Worker 終了は完了したが最終 offset 未確認（ロックを解放して非ゼロ終了）。
    - `unsettled`：未完了の排出またはフラッシュ失敗が存在（**インスタンスロックを保持したまま**非ゼロ終了）。
- **段階的停止順序・SQLite クローズ・単調時計予算**（`packages/app/lifecycle/maintenance.ts`、`packages/app/lifecycle/shutdown.ts`）：
  - **Runner 中断と 3 段階の停止順序**：
    1. 新規受付の停止：設定ホットリロード・update ポーリング・Mini App HTTP サーバー（`stopMiniAppServer`）を停止し、各業務入口を quiesce したうえで `drainAcknowledgedUpdateRunner` が `runner.activeTask()` と `settleWithinBudget` によりイベント駆動で `RUNNER_DRAIN_TIMEOUT_MS` 内に在途 update を排出します（超過時は `runner.abortActive()` で中断し、`RUNNER_CANCELLATION_SETTLEMENT_TIMEOUT_MS` の収束ウィンドウで `drained` / `aborted` / `unsettled` を判定）。
    2. `SHUTDOWN_DRAIN_OWNERS` の順次 drain / flush：`avatar` → `translate` → `antiRaid`（Worker に `drain` を送り広告 ticker 停止と `inFlightAdDisposals`・永続化の排出を実行）→ `gag` → `qa form` → `wed` → `deferred commands` → `cron` → `target message deletion` → `Telegram delayed deletion` → `ai`（AI 記憶フラッシュ）→ `telegram`（Telegram 送信ゲート排出）→ `disk`（Disk I/O フラッシュ）に続けて `StateStore`（`flushAllToDisk`）を書き出し、すべて成功した場合にのみ最終 offset を確認します。
    3. `dispose()` による終局処理：同一順序で drain と終局クローズ（翻訳クライアント・AI Worker・Telegram 送信ゲート）を行い、`SHUTDOWN_TERMINATION_OWNERS`（`terminateAntiRaid` → `terminateDiskIO`）と `flushStateToDisk` を経て、`classifyShutdown` に応じて `bot.lock` を解放または保持します。
  - **共有 SQLite のクローズ（`closeStorage`）**：
    - 現行 Disk I/O 世代が復旧済み・書き込み可能・非 fatal であれば、`terminateDiskIO` は `writable = false` にしたうえで `closeStorage`（予算 `DISK_IO_STORAGE_CLOSE_TIMEOUT_MS`）を 1 回送信します。Worker は残余書き込みを単一トランザクションでコミットし、`PRAGMA wal_checkpoint(TRUNCATE)` を実行して接続を閉じます（他接続による checkpoint 阻害は診断ログのみ）。
    - 未コミット・タイムアウト・拒否・エラー応答時は Worker を終了させつつディスク終了失敗（`unsettled`）として記録します（`closeStorage` は制御メッセージであり再構築時に再送されません）。
  - **単調時計（`packages/libs/monotonicDeadline.ts` / `performance.now()`）による停止予算**：
    - `FlushTimeouts` は `antiRaidMs`（通常停止は `ANTI_RAID_DRAIN_TIMEOUT_MS` ≥ `DISK_IO_FLUSH_TIMEOUT_MS`）、`translateMs`（`TRANSLATE_REQUEST_TIMEOUT_MS`）、その他保守 owner 用の `maintenanceMs` を割り当てます（異常終了時の `EMERGENCY_FLUSH_TIMEOUTS` ではすべて 0）。
    - 停止全体は `SHUTDOWN_TOTAL_BUDGET_MS`（停止要求または `wait()` / `dispose()` 開始起点）に収め、2 回の drain・バックグラウンド保守待機・最終 offset 確認・`StateStore` フラッシュの各ステップは `min(個別予算, 全体残り時間)` で待機し、期限切れ後のステップは予算 0 で実行します。予算 0 のステップは新たな書き込みや要求を発行しません。`StateStore` は未書き出しまたは書き込み中の値が残っていれば `timedOut`（なければ `flushed`）で決着し、Disk I/O flush は書き出しバリアを送らず完了扱いになりません。最終 offset 確認は `getUpdates` を呼ばずに offset を保留し、終了コードを 1 にします（runner 排出・Worker 終了・DB クローズ・ロック処理は全体期限で短縮されません）。

### ファイル権限と schema

- **データルートディレクトリの権限と setgid 制約**：
  - データルート・`memory/`・`logs/` は起動時に `RUNTIME_DATA_ROOT_MAX_MODE` 以下（group / other 書き込み禁止）を強制検査し、SQLite の `database/` は setgid の `IDENTITY_DATABASE_DIRECTORY_MODE`、DB および WAL/SHM ファイルは `IDENTITY_DATABASE_FILE_MODE` を使用します（稼働中の暗黙的な `chmod` は行いません）。
- **アトミック置換における既存権限の継承**：
  - `tmp + fsync + rename`（`packages/libs/atomicFile.ts`）では既存対象ファイルの mode を `fchmod` で引き継ぎ、新規作成時のみ指定 mode（共有データは `PERSISTED_FILE_MODE`、Mini App が未作成の任意設定ファイルを新規作成する際は `MINI_APP_CONFIG_DEFAULT_FILE_MODE` = `0o600`。`config/` は Mini App のオンライン設定編集を有効化する場合を除き既定で読み取り専用）を適用します。
- **推測的サイレントアップグレードの禁止と現行スキーマ基準**：
  - 起動時に現行スキーマとバージョン（`database/storage.sqlite` は `IDENTITY_DATABASE_SCHEMA_VERSION = 14`、`STORAGE_MIGRATION_LINEAGE` は `0000_identity_storage`〜`0012_ad_pack_blacklists` の全 13 件で `ad_pack_blacklists` STRICT テーブルを含む、`config/dynamic/ad_detect.json` は必須 2 キー `{ punishment, samples }` のみ許可）を厳格検証し、非互換データは自動マイグレーションせず直ちに起動を拒否します。オフラインアップグレードは `scripts/migrations/active.ts` に登録された現行コールド移行スクリプト（`migrate:wed-member-window`、`migrate:ad-pack-blacklists`）を手動実行します。

### ロックダウンミラーと終端フラグ

永続化の指紋・ミラー復元・終端スナップショットの制約仕様については、[ロックダウンミラーと終端フラグ](04-lockdown-invariants.md) を参照してください。

## 互換エントリ

- **Barrel 再エクスポートの副作用排除**：トップレベルの barrel 互換ファイルは型とシンボルの再エクスポートのみを行い、状態保持・設定解析・import 副作用を一切持ちません。
- **運勢レシートの形式仕様と安全なデコード**：
  - 運勢レシートは設定タイムゾーンの日次 HMAC 署名と当日日付が一致する現行形式のみを受け付け、`libs/luckReceipt.ts` が不正 Base64 長や構文エラーを捕捉して一律 `undefined` に正規化します（ミドルウェアへ例外を送出しません）。

---

<div align="center">

[← 前のページ：03 ディレクトリマップ](03-directory-map.md) · [📚 開発者ドキュメント TOP](content-table.md) · [⬆️ トップへ戻る](#04-実行時の正式な不変条件) · [次のページ：05 開発フロー →](05-dev-workflow.md)

</div>

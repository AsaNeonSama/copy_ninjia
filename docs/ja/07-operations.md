# 07 運用とトラブルシューティング

<p align="center">
  <a href="../cn/07-operations.md">简体中文</a> · <a href="../en/07-operations.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 開発者ドキュメント TOP</a> · <a href="06-modification-guide.md">← 前のページ：06 変更レシピ</a> · <a href="08-images-and-cron.md">次のページ：08 画像ライブラリと定時タスク →</a>
</p>

---

## デプロイ形態

Copy Ninjia は**単一インスタンスのロングポーリング（Long Polling）**常駐プロセスとして動作します：
- Telegram 更新受信用に公開 Webhook やリバースプロキシポートを開ける必要はありません（任意の Mini App 管理コンソールのみ HTTPS 入口を使用します。詳細は [10 Mini App](10-mini-app.md) を参照）。
- MySQL / PostgreSQL などの外部データベースサービスは不要です。
- ID 権限ポリシーと管理中グループの実行状態はローカルの SQLite データベースに格納されます。
- その他の永続データは JSON / テキストファイルとしてローカルのデータルート配下に保存されます。

### ハードウェアの目安

<table width="100%">
<thead>
  <tr>
    <th width="24%" align="left">デプロイ規模</th>
    <th width="32%" align="left">推奨構成</th>
    <th width="44%" align="left">用途とリソース計画の目安</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>🌱 <b>エントリー構成</b></nobr><br><sub>（低負荷 / テキスト中心）</sub></td>
    <td>2 vCPU / 2 GB RAM / ローカル SSD</td>
    <td>テキスト中心なら安定稼働します。マルチモーダル処理のピーク時は Worker 間で CPU 競合が起き得るため、2 GB Swap の設定を強く推奨します。</td>
  </tr>
  <tr>
    <td><nobr>⚡ <b>軽量本番</b></nobr><br><sub>（少数のグループのみ AI 有効）</sub></td>
    <td>4 vCPU / 2 GB RAM / ローカル SSD</td>
    <td>テキスト処理は安定します。2 GB RAM では高並行のメディア負荷に余裕が少ないため、2 GB Swap の併用を推奨します。</td>
  </tr>
  <tr>
    <td><nobr>🌟 <b>推奨本番</b></nobr><br><sub>（中規模のアクティブグループ群）</sub></td>
    <td>4 vCPU / 4 GB RAM / ローカル SSD</td>
    <td>日次メッセージ量が中程度の標準本番構成で、安定性とコストのバランスに優れます（2 GB Swap 推奨）。</td>
  </tr>
  <tr>
    <td><nobr>🔥 <b>高負荷本番</b></nobr><br><sub>（全グループ AI 有効 / 画像多数）</sub></td>
    <td>4 vCPU / 8 GB RAM / ローカル SSD</td>
    <td>並行メディア取得・Base64 変換・画像トランスコード時のヒープピークにも十分な余裕を確保できます。</td>
  </tr>
</tbody>
</table>

> [!NOTE]
> 単一インスタンスが同時に管理できるグループ上限は `STATE_MANAGED_CHAT_LIMIT` です。実質的なボトルネックは参加メンバー総数ではなく、Telegram Bot API のレート制限、AI プロバイダのクォータ、および実際のメッセージ・メディア流量で決まります。

---

### systemd の例

本番常駐プロセスは systemd で管理することを推奨します：

```ini
[Unit]
Description=Copy Ninjia Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=copy-ninjia
Group=copy-ninjia
WorkingDirectory=/opt/copy_ninjia
Environment=COPY_NINJIA_DATA_ROOT=/var/lib/copy-ninjia
ExecStart=/usr/local/bin/bun run start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

#### ディレクトリ権限とセキュリティ制御

- **データルートディレクトリの事前作成**：専用の実行ユーザーとデータルートをあらかじめ作成します：
  ```bash
  sudo install -d -o copy-ninjia -g copy-ninjia -m 0750 /var/lib/copy-ninjia
  ```
  コンテナ環境ではデータルートを永続ボリュームとしてマウントし、ホスト側または init コンテナで所有者を設定してください（`memory/` や `database/` を揮発性のコンテナ書き込み層に置いてはなりません）。
- **自動初期化と厳格な書き込み保護**：
  - 起動時に未作成のディレクトリは自動補完されます（データルートと `RUNTIME_SENSITIVE_DIRECTORY_NAMES`＝`logs/`・`memory/`・`memory/global/` の上限モードは `packages/consts/storage.ts` の `RUNTIME_DATA_ROOT_MAX_MODE`、`database/` は `packages/consts/identityStorage.ts` の `IDENTITY_DATABASE_DIRECTORY_MODE`、実効値はプロセスの `umask` に従います）。すべての対象パスで**シンボリックリンクは拒否**されます。
  - データルートおよび `RUNTIME_SENSITIVE_DIRECTORY_NAMES` は実行 UID 所有かつ `RUNTIME_DATA_ROOT_MAX_MODE` 以下でなければならず、`group` または `other` に書き込み権限（`w`）がある場合は**即座に起動を拒否**します。

> [!WARNING]
> **マルチテナント環境のデータ隔離**：
> `memory/` 配下に新規作成されるファイルの既定モードは `PERSISTED_FILE_MODE`（`packages/consts/diskIO/common.ts`、`0644`）です。親ディレクトリが他のローカルユーザーに読み取り・通過を許していると、共有サーバー上の別アカウントからログを読まれる恐れがあります。共有環境ではデータルートと `memory/` を `0750`、既存ファイルを `0600` または `0640` に絞ってください（ランタイムは既存ファイルの権限を勝手に変更しません）。
> `database/` は上限 `IDENTITY_DATABASE_DIRECTORY_MODE`（共有サービスグループ運用では `setgid` 付き `02770` も可）、DB 本体と WAL/SHM の作成モードは `IDENTITY_DATABASE_FILE_MODE` です。`database/` はグループ書き込み権限を必要とするため、**データルート全体に再帰的な `chmod 0750` を実行しないでください**。`config/` は既定で読み取り専用のまま維持し、Mini App のオンライン設定編集を使用する場合に限り、サービス実行アカウントに `config/dynamic/` および／または `config/static/` への書き込み・アトミック `rename` 権限を付与してください（新規作成の任意ファイルは `0600`）。非 `root` アカウントで静的設定のオンライン再起動を行う場合はサービスアカウントに `copy-ninjia.service` の再起動を許可する polkit 認可も設定してください（[10 Mini App の設定方法と推奨構成](10-mini-app.md) を参照）。

- **クラッシュ時の自動復旧**：異常終了時は systemd の `Restart=on-failure` で自動再起動され、参加認証待ち、ロックダウンタイマー、ID 書き込み、AI 会話メモリ、未確認の Telegram update は [04 実行時の正式な不変条件](04-invariants.md#永続化) に従って復元されます。

---

### バイナリデプロイ

公式の事前ビルド済みバイナリ配布物には、単一実行ファイル `copy-ninjia`、`binary.json`、`package.json`、`install.sh`、コールドマイグレーション CLI、設定・プロンプトテンプレート、SQLite マイグレーション SQL が同梱されており、`node_modules/` は不要です。
- **初回セットアップ**：展開ディレクトリで `bash install.sh` を実行すると、対話ガイドに沿って設定生成と空 DB 初期化が完了します。フォアグラウンド確認は `./copy-ninjia` を直接実行します。
- **systemd 設定**：`WorkingDirectory` に展開先ディレクトリ、`ExecStart` に `copy-ninjia` の絶対パスを指定します（`start` 引数は不要、ホストへのシステム Bun 導入も不要です）。
- **バージョン更新手順**：ワンライナー導入スクリプトは新規ディレクトリへ Latest パッケージと SHA-256 を取得するもので、稼働中ディレクトリのインプレース上書きは行いません。更新時はサービス停止・外部バックアップ・一時ディレクトリでの新アーカイブ検証・コールド移行を実施した上で、既存の `config/` とデータルートを保持したままプログラムファイルを差し替えます（残存する `node_modules/` は参照されないため停止中に削除可能です）。
- **コールドマイグレーション CLI**：同梱スクリプトは `scripts/migrations/` にあり、`BUN_BE_BUN=1 ./copy-ninjia scripts/migrations/<スクリプト>.js --help` で引数を確認できます。本番エントリポイントは現行形式のみを受け付けます。
- パッケージ構築の詳細は [05 リリース](05-dev-workflow.md#リリース) を参照してください。

---

## データルート

すべての実行時データパスは環境変数 `COPY_NINJIA_DATA_ROOT` から派生します（未設定時はプロジェクトルート、空文字や空白のみの明示指定は起動拒否）：

### 暦タイムゾーン

`config/static/bot.json` の `time_zone`（省略時は `packages/consts/bot.ts` の `DEFAULT_BOT_TIME_ZONE`）は起動時に 1 回だけ読み込まれ、稼働中には変化しません。`cron.json` の各タスクでは個別の `time_zone` で上書き可能です。

**データルートとタイムゾーンの恒久バインド**：
- 初回 DB 作成時に `database/storage.sqlite` の `storage_metadata` テーブルへ `IDENTITY_DATABASE_TIME_ZONE_KEY`（`"time-zone"`）が記録され、以降の日次ファイル切り替え、おみくじレシート署名鍵、一時広告免除枠、入室ログ保持窓はすべてこのタイムゾーン基準で計算されます。
- 起動時（および `install.sh` 事前検査時）に `bot.json` の `time_zone` と `storage_metadata.time-zone` が一致しない場合は即座に中断し、双方の値をログに出力します。
- 既存データルートのタイムゾーン変更はサポートしていません。起動するには `bot.json` の `time_zone` を DB 記録値に戻してください。また `database/` と `memory/` は必ず同一時点のスナップショットとして一括でバックアップ・復元してください。

### 1. グローバル状態：`memory/global/state.json`
- **役割と内容**：グローバル復唱設定 `copy`（対象ユーザー、モード、開始グループ、クールダウン時刻）と、音声合成の日次クォータ窓 `ttsUsage`（窓開始時刻 `windowStartedAt`、AI 合成数 `agentCount`、予約中継数 `reserveCount`）を保持します。
- **フォーマット制約**：
  - トップレベルは必須の `copy` と任意の `ttsUsage` のみ許可されます（未作成なら初期状態扱い、未知キーや型不正があれば**起動および `install.sh` 事前検査を即座に拒否**）。
  - `copy.copiedUser` は必須（対象なしは `null`）、`copy.copyMode` は省略・`reverse`・`nya` のみ有効です。
  - `ttsUsage` がある場合、`windowStartedAt`・`agentCount`・`reserveCount` はすべて必須の非負整数で、少なくとも 1 つは `0` より大きくなければなりません。
- **書き込み方式**：メインスレッドのみが一時ファイル + `fsync` + アトミック `rename` で書き込みます（Disk I/O Worker は関与しません）。`copy` は即時フラッシュ、`ttsUsage` は `STATE_BACKGROUND_SAVE_DELAY_MS` で合算フラッシュされ、正常停止時に全件コミットされます（`kill -9` や電源断では合算窓内の増分のみ失われる場合があります）。
- **手動編集**：必ずサービス停止とプロセス終了を確認し、`mktemp -d` でワークツリー外へバックアップした上で、未知キーの混入や必須項目欠落がないことを確認してから再起動してください。
- **データルート直下の旧ファイル検査**：データルート直下に旧版の `state.json` や `state.json.bak` が残っていると起動・インストーラーともに拒否されます。先に[段階的アップグレード](#staged-upgrade)で 17.2.1 までの移行を済ませ、旧ファイルをデータルート外へ退避してください。
- **Mini App 認証器：`memory/mini-app-totp/totp.json`**（任意、詳細は [10 Mini App の設定方法と推奨構成](10-mini-app.md) 参照）：
  - スーパー管理者が Mini App「認証器」画面で Google Authenticator (TOTP) を登録すると、メインスレッドが `{ version: 1, secret, createdAt }` をアトミック書き込み（一時ファイル + `fsync` + `rename`、モード `0o600`）で保存します。
  - 起動時に 1 回だけ厳格検証してメインスレッドのメモリ holder に常駐させ、`install.sh` 事前検査も同じ基準で読み取り専用検査します（未作成＝未バインド、通常ファイル以外や形式不正＝起動・導入を拒否）。
  - 稼働中の TOTP 検証・状態照会はディスク I/O ゼロで動作し、登録・再設定・削除時のみ即時永続化されます。

### 2. エロ画像専用ライブラリ：`random_h_image_dir`
- **役割と内容**：`config/dynamic/assets.json` の `onlyPath.random_h_image_dir` で指定します（既定値はデータルート基準の `RANDOM_H_IMAGE_DIR`、`packages/consts/ui/assets.ts`）。`/h_image` およびディレクトリ未指定の cron `rand_image` がここから一様ランダムに抽選し、`/h_image add` や Mini App 画像庫から追加・削除できます。
- **ファイル名規約**：通常画像ファイルのみ配置可能で、ファイル名は**画像バイナリの SHA-256 小文字 16 進数**＋対応拡張子（`packages/consts/imageGallery.ts` の `RANDOM_IMAGE_CONTENT_NAME_PATTERN` / `RANDOM_IMAGE_EXTENSIONS`）に完全一致させる必要があります。他用途のファイル・サブディレクトリ・シンボリックリンクは厳禁です。
- **起動時走査とキャッシュ同期**：
  - ディレクトリがなければ自動作成し、起動時に全エントリを走査してメモリキャッシュへ読み込みます。不正ファイル名・サブディレクトリ・シンボリックリンク・残留 `RANDOM_IMAGE_TEMP_PREFIX`（`.h_image-add-*`）があれば**起動を拒否**します。
  - `/h_image add` や Mini App 画像庫での追加・削除はメモリキャッシュへ即時反映され再起動不要です。ホットリロードでパスを切り替える際も新ディレクトリを事前検証してからキャッシュを入れ替えます。
  - ディレクトリへ直接手動配置した画像は再起動（またはホットリロードでのパス切り替え）までメモリキャッシュに入らず、手動削除した画像は抽選または Mini App 画像庫での読み取り時に検知されてキャッシュから除外されます。

### 3. グループ嫁候補ライブラリ：`memory/wed/<chatId>.json`
- **役割と内容**：グループごとの発言済みメンバースライディングウィンドウを参加順のオブジェクト配列（例：`[{"id":5974478892,"enteredAt":1791770134683}]`、`enteredAt` は Unix ミリ秒）として保持します。メインスレッドは各グループの `Map<number, number>` を再利用し、管理グループ上限は `STATE_MANAGED_CHAT_LIMIT`、1 グループあたりの定員は `WED_MEMBER_LIMIT` です。
- **ウィンドウ規則**：未登録メンバーが個人アカウントで発言すると現在時刻（既存の最大 `enteredAt` 以上にクランプ）で末尾へ追加され、登録済みメンバーの再発言では `enteredAt` を更新しません。満員時は最も古いメンバーから押し出されます。
- **検証ルール**：ファイル名は正規の負の安全な整数グループ ID、各要素は `{ id, enteredAt }` のみ（重複のない正の安全な整数 `id`、配列順に単調非減少の非負安全な整数 `enteredAt`、件数 `WED_MEMBER_LIMIT` 以下）でなければなりません。違反時は起動および `install.sh` で拒否されるため、17.2.1 のメンバー ID 配列ファイルは先に [/wed メンバーウィンドウのコールド移行](#upgrade-wed-member-window)を実行してください。
- **永続化方式**：変更が `FLUSH_MAX_ENTRIES` 件に達するか初回変更から `FLUSH_INTERVAL_MS` 経過すると、Disk I/O Worker で全量アトミック置換されます。`/init disable` や Bot 退出時にはファイル自体が削除されます。
- **退室メンバーの整理**：退室サービスメッセージ、`chat_member` 更新、毎日 0 時の巡回（後ろ 2 つは Bot の管理者権限が必要）で自動削除されます。Bot が非管理者かつメンバー一覧非公開の大規模グループでは Telegram API の仕様上退室を検知できず、候補に残る場合があります。

### 4. スタンプとおみくじ：`memory/stickers/` と `memory/luck/`
- **`memory/stickers/<pack>.json`**：ホワイトリスト対象スタンプパックの索引キャッシュ（`version`、各スタンプの `file_unique_id`・絵文字・説明・パック要約）。欠落時は Telegram から再同期でき、ホワイトリストから外れたパックは起動時に自動削除されます。
- **`memory/luck/<YYYY-MM-DD>.json`**：バインドされたタイムゾーンでの当日分おみくじ結果（ユーザー ID キー、運勢ランクと相談内容要約）。当日分のみ保持します。
- **`memory/luck/receipt-secret.json`**：当日のおみくじレシート検証用 HMAC 秘密鍵（`version`・日付・`LUCK_RECEIPT_SECRET_PATTERN` の 16 進秘密鍵）。**必ず当日のおみくじファイルと一体でバックアップ・復元**してください（単独削除・再生成すると発行済みレシートがすべて失効します）。

### 5. 認証待ちと入室ログ：`memory/anti-raid/` と `memory/joinlog/`
- **`memory/anti-raid/<YYYY-MM-DD>.json`**：当日の参加認証（Challenge）追記ログ（active 状態、revision、解決済み tombstone、再起動後に自動再開される未完了 `kickPending`）。
  - 定常時は当日ファイルのみを保持し、追記数またはサイズが `VERIFICATION_FILE_COMPACT_ENTRIES` / `VERIFICATION_FILE_COMPACT_BYTES` に達すると自動圧縮（compaction）します。
  - 圧縮時に前日以前のファイルが残っている場合、その最新ファイル上で active だった解決済みレコードへ先に tombstone を書き込むため、旧日ファイル削除前にプロセスが落ちても解決済み Challenge が復活しません。
  - 稼働中の圧縮でその最新旧日ファイルのデコード（UTF-8 または現行形式）が `VERIFICATION_PRIOR_DAY_DECODE_MAX_ATTEMPTS` 回連続で失敗した場合、`VERIFICATION_CORRUPT_DAY_FILE_SUFFIX`（`<YYYY-MM-DD>.json.corrupt`）へ改名して調査用に保全し、当日分はメモリミラーから書き出します（`.corrupt` は起動復元・日次削除ともに対象外。一方、コールド起動時に最新旧日ファイルが破損していれば起動を拒否します）。
- **`memory/joinlog/<chatId>.<YYYY-MM-DD>.json`**：`/batch_kick` が時間窓で参照する `chat_member` 入室イベント記録です。
  - **書き込み方式**：Disk I/O Worker のメモリバッチに蓄積し、`FLUSH_MAX_ENTRIES` 件または `FLUSH_INTERVAL_MS` ごとに追記 + `fsync` します（`/batch_kick` 照会前および正常停止時は強制フラッシュ）。
  - **保持期間**：設定タイムゾーンで直近 `JOIN_LOG_FILE_RETENTION_DAYS` 暦日以上（サマータイム短日時は自動延長）、1 グループ 1 日あたり最新 `JOIN_LOG_MAX_USERS_PER_CHAT_DAY` 人まで保持し、`/init disable` や Bot 退出時に完全削除します。

### 6. コア ID とグループ状態：`database/storage.sqlite`
稼働中は SQLite の WAL（`-wal`）および共有メモリ（`-shm`）サイドカーを伴います：
- **格納テーブル**（現行スキーマ `IDENTITY_DATABASE_SCHEMA_VERSION`）：
  - `storage_metadata`：`IDENTITY_DATABASE_METADATA_KEYS`（`IDENTITY_DATABASE_SCHEMA_KEY` とデータルート固定タイムゾーン `IDENTITY_DATABASE_TIME_ZONE_KEY`）の 2 行を保持。
  - `permission_list.policy`：ユーザー権限ポリシー（厳格 JSONB）。
  - `blocklist_entries`：グローバルブラックリストの正本。
  - `temporary_ad_bypass_entries`：一時広告免除枠の累積カウント。
  - `pending_blocked_removals`：未完了のグループ横断 BAN キュー。
  - `chat_qa`：複合主キー `(chat_id, q)` のグループカスタム Q&A。
  - `ad_pack_blacklists`：複合主キー `(kind, pack)` の STRICT テーブル。グローバル広告ステッカー（`'sticker'`）・カスタム絵文字（`'emoji'`）パックブラックリストを保持（件数上限なし、メインスレッドに 768 件の共有 LRU 読み取りキャッシュを保持）。
  - `chat_states`：最大 `STATE_MANAGED_CHAT_LIMIT` 行の管理グループ状態。必須の `status` JSONB（上限 `TRANSLATE_CHAT_USER_LIMIT` の翻訳セッション `translate` を含む）と null 許容の `ai_context` JSONB（逐語会話メモリと中期要約）を保持。
- **排他接続と起動検査**：Disk I/O Worker のみが読み書き接続を保持し、起動時に SQLite integrity・JSONB・スキーマバージョン・マイグレーション系譜・相互排他制約を全件検証してからグループ状態と AI メモリを復元します。
- **停止時のクローズ**：
  - 正常停止時は Disk I/O Worker が残余書き込みをコミットし、WAL を本体へ checkpoint・切り詰めしてから接続を閉じるため、通常は `database/` に `storage.sqlite` のみが残ります。
  - 強制終了（`SIGKILL`）時や外部リーダー（SQLite エディタ等）が checkpoint を妨げた場合は `-wal`・`-shm` が残ります。
  - クローズ時に残余書き込みのコミットを確認できない場合は `unsettled` として非ゼロ終了し、journal に `[diskIO]` エラーを記録します。
- **バックアップ規約**：**必ず `storage.sqlite` 本体と同一時点の `-wal`・`-shm`（存在する場合）を不可分のセットとしてバックアップ・復元**してください（`.sqlite` 単体コピーは厳禁です）。

### 7. 広告サンプルと AI 利用量：`memory/ad-detected/` と `memory/ai-daily-usage/`
- **`memory/ad-detected/sample.json`**：広告検出に命中した監査用サンプル（時刻、判定理由、引用・返信の文脈、および各メッセージの `type`：`text` / `photo` / `sticker` / `custom_emoji`。検査対象となる本文・キャプションがある場合のみ `text` を記録し、スタンプパックの short name は `stickerSetName` に記録）。`AD_SAMPLE_FILE_MAX_BYTES` 到達で `sample.<日付>[.<連番>].json` へローテーションし、`AD_SAMPLE_ARCHIVE_RETENTION_DAYS` 日保持後に自動削除します。
- **`memory/ai-daily-usage/usage.json`**：会話本文を含まないトークン・リクエスト統計です：
  - **データ構造**：先頭の `summary` が直近完了日の機能 / プロバイダ / モデル別集計、残りのキーが当日未集計の呼び出し記録です。
  - **対象範囲**：`AGENT_CAPABILITY_NAMES` の全機能を網羅します。

### 8. ログとインスタンスロック：`logs/` と `bot.lock`
- **`logs/`**：`config/static/bot.json` の任意項目 `log_level`（`info` / `operation` / `warn` / `error`、省略時は既定値 `"operation"`）でフィルタされた英語の構造化実行ログです。各レコードは `{ level, message, args? }` 形式（`message` は文字列引数の連結、`args` は非文字列の構造化コンテキストや展開済み `Error` のみを格納し、存在しない場合は省略）で、`info`・`operation`・`warn` はメインスレッドで最大 32 件または 30 秒間隔でバッファ後に Disk I/O Worker がバッチ追記し、`error` ログは即時永続化されます。
- **`bot.lock`**（および `.guard` / `.recovery`）：Linux `/proc` ベースの単一インスタンス排他ロックで、同一データルートへの多重起動を防止します。

---

### データルート管理とメンテナンススケジュール

- **ディレクトリの責務分離**：`memory/` 直下にはファイルを置かず各ドメインが専用サブディレクトリを持ち、ID ポリシーとグループ状態は `database/` に集約します。
- **読み取り専用の起動プリフライト**：起動時はまず全永続ファイル（保持窓内の全 `joinlog/` を含む）を読み取り専用で厳格デコードし、全ドメイン合格後に初めてメモリ所有権を引き継ぎます。その後、不足ディレクトリ作成・孤立一時ファイル整理・`bot.json` の `time_zone` に基づく 0 時メンテナンス cron 登録を行います。
- **設定タイムゾーン 0 時の日次メンテナンス**：毎日 `00:00`（`packages/consts/diskIO/maintenance.ts` の `DISK_IO_MAINTENANCE_CRON`）に、`/wed` メンバー再確認 → おみくじ切り替え → ログローテーション → AI 利用量集計 → 入室ログ期限切れ整理 → 広告サンプル整理 → Challenge ログ圧縮 → 一時広告免除減衰を順次実行します（単一タスクの失敗が他タスクを止めることはありません）。
- **一時ファイルと純メモリ状態**：
  - アトミック書き込み中の `.<対象名>.<pid>.<uuid>.tmp` が強制終了で残った場合、起動検査では記録のみ行い、引き継ぎ完了後にバックグラウンド保守で安全に回収します。
  - `storage.sqlite-wal` と `storage.sqlite-shm` は SQLite WAL モードの必須ファイルであり、**一時ファイルとして手動削除することは厳禁**です。
  - 入室 Challenge タイマー、広告判定待ちキュー、Telegram 短期キャッシュは純メモリ状態でありディスクへは保存されません。

---

<a id="アイデンティティストレージの移行"></a>

## 永続データの移行

**本番コードには旧形式の後方互換ロジックが一切なく、起動時の自動スキーマ更新も行いません**。データ形式の移行は必ずサービス停止・プロセス完全終了後に行ってください。途中で失敗した場合は外部バックアップと現場を保全し、無理な新バージョン起動や `config_example/` による本番設定の上書きは絶対に行わないでください。

オフライン移行の前には、必ず `mktemp -d` でワークツリー外にバックアップ先を作成し、対象ファイル一覧・所有者・モード・SHA-256 を記録します。移行スクリプト実行後は `ready.json` の移行元 / 成果物ハッシュを照合し、差し替え時に所有者とモードを復元します。起動後は少なくとも 2 周期分の supervisor 再起動間隔を監視し、`active (running)`・`NRestarts` 不変・journal の非ゼロ終了なしを確認してから外部バックアップを削除します。

### 新規 deployment での空 database 作成

起動時に `database/storage.sqlite` が存在しない場合、勝手な初期化は行わずエラー終了します。新規デプロイでは [01 環境構築の identity storage 初期化手順](01-getting-started.md#identity-storage-の初期化) に従って現行スキーマの空 DB を作成してください（`install.sh` は DB 未作成時に自動実行し、既存 DB の上書きは拒否します）。

<a id="upgrade-ad-pack-blacklists"></a>

### 広告パックブラックリストおよび Schema v13 → v14 のコールド移行（`migrate:ad-pack-blacklists`）

[`scripts/migrateAdPackBlacklists.ts`](../../scripts/migrateAdPackBlacklists.ts) を用いて、Schema v13 の `database/storage.sqlite` と任意の旧 4 キー `config/dynamic/ad_detect.json` を、非破壊的に Schema v14（`ad_pack_blacklists` テーブル追加）および整理後の 2 キー `ad_detect.json` へ移行します：
- **受付条件**：Schema v13 データベース（`STORAGE_MIGRATION_LINEAGE.slice(0, -1)`、`PRAGMA integrity_check`、全 JSONB カラム、正規 IANA `time-zone`）のみを受け付けます。`--config-root` 省略時は `<source-root>/config` を検査し、`<configRoot>/dynamic/ad_detect.json` が存在する場合は厳密な旧 4 キー形式（`punishment`、`samples`、`sticker_black_list`、`emoji_black_list`。移行済み 2 キー形式・シンボリックリンク・重複・不正パック名は拒否、件数上限なし）を要求します。`ad_detect.json` が存在しない場合は空の `ad_pack_blacklists` を持つ v14 DB へ移行し、`ad_detect.json` は新規作成しません。
- **非破壊ステージングと検証**：元バックアップへ SQLite 接続を直接開かず、元 DB（および存在時の WAL/SHM）を新規 `--output-root` へ SHA-256 検証付きで複製してから Drizzle で v14 へ移行・ブラックリスト投入・元 DB タイムゾーンでの `validateStorageDatabase` 実行・`PRAGMA wal_checkpoint(TRUNCATE)` 完了および出力側 WAL/SHM 削除を行います。旧 4 キー `ad_detect.json` がある場合は元権限を保って 2 キー `{ punishment, samples }` をアトミック書き出しし `parseAdDetectConfig` で再読込検証したうえで、元バックアップの内容・ハッシュ・権限・`mtimeMs` 不変を確認し `ready.json` を書き出して `incomplete.json` を削除します（中断時は新しい出力ディレクトリで再実行します）。

1. **サービス停止とバックアップ**：サービスを停止して `inactive` を確認し、`mktemp -d` でワークツリー外へ `database/`（`-wal`・`-shm` を含む）と存在時の `config/dynamic/ad_detect.json` を所有者・モード・SHA-256 一覧とともにバックアップします。
2. **移行スクリプトの実行**：
   ```bash
   bun run migrate:ad-pack-blacklists \
     --source-root /absolute/cold-backup \
     --config-root /absolute/config-backup \
     --output-root /absolute/new-staging-directory
   ```
   バックアップルート直下に `config/` がある場合は `--config-root` を省略できます。バイナリ配布版では同じ引数で `BUN_BE_BUN=1 ./copy-ninjia scripts/migrations/migrateAdPackBlacklists.js` を実行します。
3. **成果物の照合**：出力先の `ready.json` で `sourceFiles` / `outputFiles` の SHA-256、`sourceSchema: 13`、`targetSchema: 14`、`timeZone`、`migratedStickerPacks`、`migratedEmojiPacks`、`adDetectConfigMigrated` を確認します。
4. **本番ファイルの差し替え**：停止中に `database/storage.sqlite` を差し替え（バックアップ保全確認後に本番側の古い `-wal`・`-shm` を削除）、生成された場合は `config/dynamic/ad_detect.json` も差し替えます。`sourceFiles` に従って所有者とモードを復元し、サービスアカウントの `database/` 書き込み権限を確認します。
5. **起動検証**：設定と状態を検証してからサービスを起動し、2 周期分の再起動監視を通過した後にのみ外部バックアップを削除します。

<a id="upgrade-wed-member-window"></a>

### /wed メンバーウィンドウのコールド移行（メンバー ID 配列 → `{ id, enteredAt }`）

[`scripts/migrateWedMemberWindow.ts`](../../scripts/migrateWedMemberWindow.ts) を用いて、`memory/wed/<chatId>.json` を 17.2.1 のメンバー ID 配列から参加順の `{ id, enteredAt }` スライディングウィンドウ配列へ変換します：
- **変換内容**：各グループとも配列末尾（直近参加側）の最大 `WED_MEMBER_LIMIT` 件の ID を元の順序のまま保持し、`enteredAt` には移行開始時刻を一括設定します（溢れた古い ID は先頭側から破棄され、`ready.json` の `truncatedMembers` に記録されます）。
- **受付条件**：17.2.1 形式のメンバーファイル（1 ファイル最大 `WED_MEMBER_WINDOW_SOURCE_LIMIT` 件の重複なし正の安全な整数 ID、最大 `STATE_MANAGED_CHAT_LIMIT` ファイル）のみを受け付け、移行済みファイル・非正規ファイル名・シンボリックリンクは拒否します（`*.tmp` 等の非 `.json` ファイルは対象外）。
- **その他の永続データと `ad_samples.json` → `ad_detect.json` 設定移行**：現行の 2 本のコールド移行エッジは独立したデータセットを対象とします（`memory/wed/` は `migrate:wed-member-window`、`database/storage.sqlite`〔v13 → v14〕と任意の旧 4 キー `ad_detect.json` は `migrate:ad-pack-blacklists`、他の `memory/` サブディレクトリはそのまま継続利用可）。`config/dynamic/ad_samples.json`（17.2.1〜18.2.0）が残っている場合は、先に `ad_detect.json` 不在の状態で `migrate:ad-pack-blacklists` により DB を v14 へ移行したうえで、停止中に手動で現行 2 キーの `config/dynamic/ad_detect.json`（`{ punishment, samples }`、[デプロイ設定説明](../../config_example/README/ja.md#ad_detectjson) 参照）へ変換し、旧 `ad_samples.json` を削除してください（`packages/config/layout.ts` と `install.sh` は `ad_samples.json` の残存を拒否します）。

1. **サービス停止とバックアップ**：サービスを停止して `inactive` を確認し、`memory/wed/` 全体（および `ad_samples.json` を移行する場合は `config/`）を所有者・モード・SHA-256 一覧とともに外部ディレクトリへバックアップします（バックアップルート配下に `memory/wed/` の相対パスを維持）。
2. **移行スクリプトの実行**：
   ```bash
   bun run migrate:wed-member-window \
     --source-root /absolute/cold-backup \
     --output-root /absolute/new-staging-directory
   ```
   バイナリ配布版では同じ引数で `BUN_BE_BUN=1 ./copy-ninjia scripts/migrations/migrateWedMemberWindow.js` を実行します。
3. **成果物の照合**：出力先 `ready.json` の `sourceFiles` / `outputFiles` の SHA-256、および `chatCount`・`keptMembers`・`truncatedMembers`・`enteredAt` を確認します（成果物ファイルは実行アカウントのみ読み書き可能で作成されます）。
4. **ファイル差し替えと `ad_detect.json` 更新**：停止中に成果物の `memory/wed/<chatId>.json` で本番ファイルを置き換え、`sourceFiles` に基づき所有者とモードを復元してサービスアカウントの書き込み権限を確認します。`config/dynamic/ad_samples.json` がある場合は、`migrate:ad-pack-blacklists` 完了後に 2 キーの `config/dynamic/ad_detect.json`（`{ punishment, samples }`）へ変換して `ad_samples.json` を削除します。
5. **起動検証**：サービスを起動して 2 周期分の再起動監視を通過した後にのみ、外部バックアップを削除します。

---

<a id="staged-upgrade"></a>

### 旧バージョンからの段階的アップグレード手順

- **19.x（Schema v13＋4 キー `ad_detect.json`）からのアップグレード**：停止・外部バックアップ後、[広告パックブラックリストおよび Schema v13 → v14 のコールド移行](#upgrade-ad-pack-blacklists)（`migrate:ad-pack-blacklists`）を直接実行します（`memory/wed/` は移行済みのため再実行不要）。
- **17.2.1〜18.2.0 からのアップグレード**：17.2.1 では [/wed メンバーウィンドウのコールド移行](#upgrade-wed-member-window)を実行し（18.0.0〜18.2.0 は移行済み）、いずれの版も `ad_detect.json` 不在の状態で `migrate:ad-pack-blacklists` により v13 DB を v14 へ移行したうえで、`config/dynamic/ad_samples.json` がある場合は 2 キーの `config/dynamic/ad_detect.json`（`{ punishment, samples }`）へ手動変換して `ad_samples.json` を削除します。
- **17.2.1 より古いデプロイ**：現行版のコールド移行スクリプトが直接受け付けるのは Schema v13 DB と 17.2.1 の `memory/wed/` のみです。先に 17.2.1 を導入してその移行（16.3.2 からは `migrate:chat-persona-removal`、それ以前は各版の案内に従ってまず 16.3.2 まで）を完了し、17.2.1 の安定起動を確認してからサービスを止め、本バージョンの `migrate:wed-member-window` と `migrate:ad-pack-blacklists`、および `ad_samples.json` → 2 キー `ad_detect.json` の手動移行を実施してください。
- **11.0.9（Schema v8）からのメジャーバージョン跨ぎアップグレード**：
  独立した作業ディレクトリで各 Git タグを順にチェックアウトし、コールド移行チェーンを段階実行します：
  1. `500e848fae` コミット：`migrate:ai-context`（v8 → v9）
  2. `12.1.0` タグ：`migrate:clear-context-permission`（v9 → v10）
  3. `13.0.2` タグ：`migrate:h-image-add-permission`（v10 → v11）と `migrate:bot-config`
  4. `14.0.0` タグ：`migrate:translate-sessions`
  5. `16.3.2` タグ：`migrate:global-state` と `migrate:random-image-names`
  6. `17.2.1` タグ：`migrate:chat-persona-removal`（v11 → v13）
  7. 現行バージョン：`migrate:wed-member-window` と `migrate:ad-pack-blacklists`（v13 → v14）を実行し、`config/dynamic/ad_samples.json` が存在する場合は手動で 2 キーの `config/dynamic/ad_detect.json`（`{ punishment, samples }`）へ移行して `ad_samples.json` を削除

  *補足*：手順 1 では 12.0.0 Release 添付の中間ソースアーカイブ `copy-ninjia-schema-v9-source-500e848f.tar.gz`（SHA-256: `df6502625512d8fde136dc66d8470e1d4c977856e8a0bd3909b9b6c763c820f8`）も利用できます。

---

<a id="起動失敗の調査"></a>

## 起動失敗の調査

起動処理はすべて**意図的な Fail-Fast（即時停止）**として設計されており、異常検知時はファイルパス・フィールドパス・期待形式を出力して停止します。検査を迂回せず原因そのものを解消してください：

### 1. データルート事前検査失敗
- **原因**：データルート・`memory/`・`memory/global/`・`logs/`・`database/` にシンボリックリンクがある、所有者が実行 UID でない、モードが `RUNTIME_DATA_ROOT_MAX_MODE` を超えている（`group` / `other` 書き込みビットあり）、`database/` が `IDENTITY_DATABASE_DIRECTORY_MODE` 超または共有サービスグループの書き込み権限がない、あるいはファイルシステムが `fsync`・ハードリンク・アトミック `rename` 非対応。
- **対処**：サービス停止後、データルートと `RUNTIME_SENSITIVE_DIRECTORY_NAMES` を実行 UID 所有の `0750`（`RUNTIME_DATA_ROOT_MAX_MODE` 以下）、`database/` を `0750` または `02770`（`IDENTITY_DATABASE_DIRECTORY_MODE` 以下）に修正し、標準のローカル POSIX ファイルシステム上に配置します。

### 2. bot.lock による起動拒否
- **原因**：同一データルートを使用中の別プロセスが稼働している（トークン違いを含む）、または `bot.lock` が破損・旧形式である。
- **対処**：次節 [`bot.lock が起動を拒否する場合`](#botlock-が起動を拒否する場合) を参照してください。

### 3. 設定ディレクトリレイアウト不一致
- **原因**：`config/`・`config/static/`・`config/dynamic/` にホワイトリスト外のエントリ（配置ミス、旧 `telegram.json` や `ad_samples.json`、隠しファイル・一時ファイル・バックアップ、未定義サブディレクトリ、リンク切れシンボリックリンク）がある、`config/dynamic/` が欠落している、またはディレクトリパスが非ディレクトリで占有されている。
- **対処**：停止中に `config/static/` は `bot.json` と `g-auth.json` のみ、`config/dynamic/` は 6 つの動的 JSON のみに整理し、バックアップ等は `config/` 外へ移動します。旧 `telegram.json` は[段階的アップグレード](#staged-upgrade)の `migrate:bot-config` を実施し、旧 `ad_samples.json` は手動で 2 キーの `config/dynamic/ad_detect.json`（`{ punishment, samples }`）へ移行して `ad_samples.json` を削除します。

### 4. Config Schema 検証失敗
- **原因**：`config/{static,dynamic}/*.json` に必須項目欠落、型・値域・列挙値の不一致、または未定義キーがある。
- **対処**：ログに出力されたファイルパスと JSONPath を確認し、[デプロイ設定説明](../../config_example/README/ja.md) に従って修正します。

### 5. ID データベース検証失敗
- **原因**：`storage.sqlite` が書き込み不可・物理破損・未移行スキーマ（現行 v14 以外）である、`bot.json` の `time_zone` が `storage_metadata.time-zone` と異なる、またはブラックリストと一時広告免除に同一 ID が重複している。
- **対処**：タイムゾーン不一致は `bot.json` の `time_zone` を DB 記録値に戻します。Schema v13 の場合は停止・バックアップ後に[広告パックブラックリストおよび Schema v13 → v14 のコールド移行](#upgrade-ad-pack-blacklists)（`migrate:ad-pack-blacklists`）を実行し、v13 より古いスキーマ（16.3.2 の v11 等）は先に[段階的アップグレード](#staged-upgrade)で v13 まで移行します。物理破損時は同一時点のバックアップから `storage.sqlite` と `-wal` / `-shm` を一括復元します（空 DB での上書きや手動レコード編集は厳禁です）。

### 6. おみくじ結果とレシート秘密鍵の不一致
- **原因**：当日おみくじファイルと `receipt-secret.json` が別時点のバックアップから混在し、HMAC 検証に失敗している。
- **対処**：サービスを停止し、同一バックアップ時点から `memory/luck/` 全体を復元します（秘密鍵単体の削除・再生成は厳禁です）。

### 7. グローバル状態ファイル不正または旧 state.json 残留
- **原因**：`memory/global/state.json` が現行スキーマに合わない、またはデータルート直下に旧 `state.json` / `state.json.bak` が残っている。
- **対処**：バックアップ取得後に不正フィールドを修正し、旧形式の場合は[段階的アップグレード](#staged-upgrade)で 17.2.1 まで移行した上でルート直下の旧ファイルを退避します。

### 8. /wed 候補ファイルの形式不正
- **原因**：`memory/wed/<chatId>.json` が現行ウィンドウ形式でない（17.2.1 のメンバー ID 配列のまま、`enteredAt` 欠落、時刻逆順、`WED_MEMBER_LIMIT` 超過など）、またはファイル名が正規グループ ID でない。
- **対処**：停止・バックアップ後、17.2.1 の ID 配列には [/wed メンバーウィンドウのコールド移行](#upgrade-wed-member-window)を実行し、それ以外はエラー対象のファイル・フィールドを修正するかバックアップから復元します。

---

<a id="botlock-が起動を拒否する場合"></a>

### bot.lock が起動を拒否する場合

インスタンスロックは Linux `/proc` を用いた厳密な 1 行形式 `BOT_LOCK_LINE_PATTERN`（`v2:<pid>:<starttime>:<boot_id>:<sha256(token)>`、`starttime` は `/proc/<pid>/stat` 第 22 フィールド）で Fail-Closed に動作します：

- **稼働中プロセスとの競合**：PID・`starttime`・`boot_id` の 3 点すべてが一致した場合のみ稼働中と判定されます。別インスタンスが動いているため先に停止してください（同一データルートの多重起動は厳禁です）。
- **強制終了・再起動後の古いロック（Stale Lock）**：`kill -9` やホスト再起動で残ったロックは次回起動時または停止時に自動判定・回収されるため、手動削除は不要です。
- **破損または旧形式のロックファイル**：現行形式の 1 行＋改行でない場合、ロック取得も停止時解放もファイルを書き換えずに拒否します。**関連プロセスが一切稼働していないことを確実に確認**した上で、`bot.lock` を手動削除して再起動してください。
- **停止時のロック解放失敗**：エラーを出力して非ゼロ終了します。`/proc` のマウント状態、ディレクトリの書き込み権限、残留 `.guard` ファイルを確認してください。
- **ロック候補一時ファイルの回収**：ハードリンクロック時の `.candidate.*` や `.tmp` は、元の所有者が非稼働と確認された時点で起動処理が自動回収します。

> [!CAUTION]
> `bot.lock` 内のトークン SHA-256 は単一所有者の認証情報整合性確認用であり、マルチテナント分離機構ではありません。複数 Bot を同時稼働させる場合は**必ず Bot ごとに独立した `COPY_NINJIA_DATA_ROOT` を設定**してください。

---

## アップグレードとリリース

1. **リリース前フルゲート**：ソース作業ツリーで全量検証（frozen lockfile、`check`、`check:coverage`、`test:fault-injection`、バイナリビルド）を実行します：
   ```bash
   bun run release:check -- --version <tag>
   # ネットワーク接続環境ではセキュリティ監査を追加
   bun run audit:release
   ```
2. **Git 状態の確認**：Git 操作の前に `git status --short`、対象リビジョンとの差分、および `git ls-files config .env g-auth.json` を確認します（`config_example/` による本番設定の上書きは厳禁です）。
3. **独立した作業ディレクトリの利用**：systemd の `WorkingDirectory` がリポジトリ自身を指している場合は、独立した git worktree または新規クローンでビルド・検証を行い、ブランチは `dev` と `master` のみを使用します。やむを得ずインプレース更新する場合は、**先に systemd サービスを停止して `inactive` を確認**し、設定と DB を外部バックアップしてから pull・移行を行います。
4. **永続データ・設定の移行**：スキーマや設定構成に変更がある場合は、停止中に所定のコールド移行手順を実施します。
5. **起動後の安定性監視**：設定・永続データの検証通過後に起動し、少なくとも 2 周期分の supervisor 再起動間隔で `ActiveState=active`・`SubState=running`・`NRestarts` 増加なし・journal の非ゼロ終了なしを確認してから外部バックアップを削除します。

### インストーラーのサービスとバックアップ境界

`install.sh` には以下の安全ガードが組み込まれています：
- **サービス停止状態の強制**：既存の systemd サービスが稼働中である場合や、複数の競合する `ExecStart` が定義されている場合は、書き込みを行う前に即座に中断します。
- **ワークツリー外バックアップ**：設定や unit ファイルを更新する前にワークツリー外へバックアップを作成し、所有者・モードの記録と SHA-256 照合を行います。バックアップは起動後の安定性監視をすべて通過した後にのみ削除され、途中失敗やフォアグラウンド起動選択時はそのまま保全されます。
- **データルート環境変数の一貫性**：`COPY_NINJIA_DATA_ROOT` 未設定時はプロジェクトルートを使用し、明示設定時は既存 unit の `Environment=` と同一の絶対パスに解決されることを要求します（非空の `EnvironmentFiles` や当該変数に関わる `PassEnvironment` / `UnsetEnvironment` は拒否）。
- **起動後の健全性観察ウィンドウ**：systemd の `RestartUSec`・`RestartMaxDelayUSec`・`RestartRandomizedDelayUSec` から `service_observation_seconds`（`scripts/install/service.sh`）で算出した 2 再起動周期＋安全マージンを監視し、`NRestarts` の増加・プロセス終了・journal 読み取り失敗・非ゼロ終了があれば失敗としてロールバックを案内します。

---

## 日常の監視項目

### 主要ログの特徴とトラブルシューティング

- **構造化英語ログ**：コンソール出力はレベル別プレフィックス（`[INFO]` / `[OPERATION]` / `[WARN]` / `[ERROR]`、`CONSOLE_PREFIX_BY_LOG_LEVEL`）を前置し、ディスク出力は `config/static/bot.json` の任意項目 `log_level`（省略時既定値 `"operation"`）でフィルタして `{ level, message, args? }` 形式で `logs/<YYYY-MM-DD>.json` へ保存します（`info`・`operation`・`warn` はメインスレッドで最大 32 件または 30 秒窓でバッファ後に、`error` は即時に Disk I/O Worker がバッチ追記）。固定の英語サマリーとキャメルケースの構造化コンテキストにより、`grep`・`jq` やログ収集基盤で容易に検索できます。
- **Worker クラッシュの自動復旧**：個別 Worker が異常終了すると、メインスレッドがレート制限付きで新スレッドを起動し、保持中のスナップショットから状態を自動再注入します。
- **永続化失敗時の Fail-Fast 終了**：ディスク書き込みが有限回のリトライ後も失敗し続ける場合、メモリとディスクの乖離を防ぐため非ゼロ終了して systemd のクリーン再起動に委ねます。

#### よくあるログメッセージ

- `Cron task action failed; skipping the remaining actions for this chat.` / `Cron task action failed; skipping the remaining actions of this run.`（`{ task, actionIndex, actionType, chatId?, attempts, detail }`）：
  定期タスクのアクションが最終失敗に達しました。主な `detail` の切り分け先：
  - `403`：Bot が対象グループ / チャンネルから退出させられている、または送信権限がない。
  - `400`：外部メディア URL が無効、または画像 / 音声形式が Telegram 非対応。
  - `local file ... is missing`：指定したローカル素材ファイルが存在しない。
  - `speech synthesis failed: ...`：音声合成の失敗（`tts unconfigured` / `tts unsupported`＝設定不一致、`worker unavailable`＝AI Worker 初期化中、`synthesis failed` / `timed out`＝上流 API・通信エラー、`daily limit reached`＝日次枠の上限到達）。
- `/send TTS produced no voice.`（`{ chatId, reason }`）：
  スーパー管理者の DM `/send` 中継での音声合成失敗です（原因は同上）。DM にエラーが返り、中継セッション自体は維持されます。
- `AI reply voice was not sent.`（`{ chatId, reason }`）：
  グループ AI 返信中の `send_voice` 失敗です（タイムアウトや日次枠到達など）。テキスト返信の送信は通常どおり継続します。
- `Telegram API call failed.`（`{ action: "probe chat membership", chatId, userId, errorCode: 400, description }`、`description` に `PARTICIPANT_ID_INVALID` を含む）：
  ブラックリスト巡回中に削除済み Telegram アカウントを検出しました。同一 ID で `BLOCKLIST_PARTICIPANT_INVALID_LIMIT` 回連続して返った場合、ブラックリストから自動削除されます。
- `Chat upgraded to supergroup; tearing down the old chat.`（`{ chatId, supergroupChatId }`）：
  管理中の通常グループがスーパーグループへ昇格したため、旧グループ ID を `gone` として後始末（データ削除・管理枠解放）しました。新しいスーパーグループで改めて `/init enable` を実行してください（旧設定は自動引き継ぎされません）。
- `Chat confirmed unreachable; tearing it down.`（`{ chatId, reason, attempts, intervalMs }`、`reason` は `"gone"` または `"departed"`）：
  起動時のタイトル更新で、グループの消滅（`gone`）または Bot の非メンバー化（`departed`）が複数回連続で確認されたため自動後始末しました（`departed` グループに未復元のロックダウン記録がある場合は保持され、Bot が再参加してメンバー制限権限を得た時点で自動復元されます）。
- `Chat absence check disagreed on retry; keeping chat.`（`{ chatId, initialReason, attempt }`）：
  初回照会では到達不能に見えたものの再照会で結果が異なったため（多くは Telegram 側の一時エラー）、今回は後始末を見送り次回起動時に再確認します。

---

<div align="center">

[← 前のページ：06 変更レシピ](06-modification-guide.md) · [📚 開発者ドキュメント TOP](content-table.md) · [⬆️ トップへ戻る](#07-運用とトラブルシューティング) · [次のページ：08 画像ライブラリと定時タスク →](08-images-and-cron.md)

</div>

# 09 コマンドと挙動リファレンス

<p align="center">
  <a href="../cn/09-commands.md">简体中文</a> · <a href="../en/09-commands.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 ドキュメントホーム</a> · <a href="08-images-and-cron.md">← 前のページ：08 画像ライブラリと定時タスク</a> · <a href="10-mini-app.md">次のページ：10 Mini App の設定方法と推奨構成 →</a>
</p>

---

利用者向けの完全なコマンド一覧、必要権限、および実行時の挙動リファレンスです。ルート README には概要のみを掲載し、詳細な技術仕様は本ページを正とします。コマンド実装は `packages/commands/`、権限キー定義は [`packages/types/identityPolicy.ts`](../../packages/types/identityPolicy.ts) にあります。

## 🎭 Copy モード

- **インスタンス全体で単一の対象**：Copy 対象は Bot インスタンス全体で常に 1 つだけです。同時に複数の対象へ「変身」することはできず、発言の復唱はコマンドを実行したグループ内でのみ行われます。
- **停止と自動解除**：`/copy stop` はどのグループからでも現在の Copy を即座に停止できます。Copy を開始したグループで `/init disable` が実行された場合や、Bot が退出・管理者権限喪失となった場合は、Copy 状態が自動停止して即座に永続化され、グループへ通知を出すことなくバックグラウンドでデフォルトアバターへ復元されます。

| コマンド | 挙動 |
| :---: | :--- |
| `/copy` | 対象以降のメッセージを原文のまま復唱 |
| `/copy reverse` | Unicode 書記素クラスタ単位で本文とキャプションを反転して送信 |
| `/copy nya` | 本文とキャプションの末尾に `NYA_SUFFIX`（「喵~」）を付加して送信 |
| `/icon steal` | 対象のアバターのみをコピー（テキスト復唱は行わない） |
| `/icon reset` | アバターを設定済みのデフォルト画像へ戻す |
| `/copy stop` | グローバル Copy 状態を停止し、アバターもデフォルトへ復元 |

### 送信と変換の仕組み

`/copy` コマンド群とランダム復唱機能は共通の変換・送信ルールに従います：
- **テキストとキャプション**：リンクや `@username` を含むメッセージもすべてプレーン文字列として変換します。再送信されたテキスト内のリンクや `@username` は Telegram クライアント側で再認識され、元メッセージのリンクプレビュー設定も引き継がれます。
- **装飾エンティティの破棄**：太字、下線、インラインリンク、スポイラー（ネタバレ防止）、カスタム絵文字などのリッチテキスト装飾は保持されず、スポイラー箇所も平文として送信されます。
- **リッチメディア**：画像、動画、ファイル、スタンプなどはローカルにダウンロードせず Telegram サーバー側で直接複製し、キャプションがある場合は変換後のテキストに差し替えます。有料メディア（Paid Media）は複製できないため、キャプション付きならテキストのみを送信し、キャプションなしなら無視します。
- **非テキストメッセージ**：投票、ダイス、位置情報、連絡先など、テキストもメディアファイルも持たないメッセージはそのまま転送します。
- **コマンド無限ループ防止**：変換前または変換後のテキストに表示可能なスラッシュコマンドが含まれる場合、メッセージ全体を送信しません。
- **文字数上限ガード**：変換後の本文またはキャプションが `TELEGRAM_MESSAGE_MAX_CHARS` または `TELEGRAM_CAPTION_MAX_CHARS` を超える場合、メッセージ全体を送信しません。

### 対象とパラメータの指定

対象は「メッセージへの返信」または `@username` で指定します：
- **パラメータ順序**：モード指定は対象の前に置きます（例：`/copy reverse @username`、`/copy nya @username`）。アバターのみコピーする場合は `/icon steal @username` を使います。`/copy stop` と `/icon reset` は追加引数を取りません。
- **ユーザー名キャッシュへの依存**：
  - `@username` で対象を引くには、Bot が過去にグループ内でそのアカウントの発言を観測しローカルキャッシュを持っている必要があります。対象がユーザー名の変更・削除・別アカウントへの付け替えを行うと、古いキャッシュは即座に失効します。
  - `/block … enable` などの重要な管理操作では、対象メッセージへの返信または数値 ID の直接指定を推奨します。
  - `/block`、`/mute`、`/white`、`/permission` で `@username` を指定して権限・制限を変更する際は、実行前に対象の現在のユーザー名をリアルタイム照会し、変更されていた場合や照会失敗時は実行を拒否します。
- **匿名管理者**：グループ管理者が匿名管理者として発言している場合、送信元はグループ自身になります。そのメッセージを Copy するとグループのアバターを取得してグループ名義を模倣しますが、`/block` では現在のグループ自身のブロックを拒否します。
- **グローバルクールダウン**：`/copy`、`/copy reverse`、`/copy nya`、`/icon steal`、`/icon reset` はグローバルクールダウン（`COPY_COOLDOWN_MS`）を共有します。免除されるのは `SUPER_ADMIN_USER_ID` 本人のみで、通常のホワイトリストメンバーには適用されます。`/copy stop` にクールダウンはありません。

---

## 🌐 グループごとの翻訳

グループ別翻訳は、グローバルな Copy 状態・アバター・Copy クールダウンとは完全に独立して動作します：
- **前提条件**：あらかじめ `isCanControllTranslatePermission` 権限を持つメンバーが `/translate enable` で有効化し（既定では無効）、有効な `g-auth.json` が配置されている必要があります。
- **他の Bot の翻訳**：他の Bot の発言を翻訳するには、@BotFather で本 Bot の Bot-to-Bot Communication Mode を有効化してください。受信メッセージには引き続き[他 Bot の入口レート制限](04-invariants.md)が適用されます（[01 環境構築](01-getting-started.md) 参照）。
- **グループ別バックグラウンド FIFO キュー**：翻訳はバックグラウンドでグループごとに順次送信され、通常メッセージの処理をブロックしません。単一グループの翻訳待ち件数が `TRANSLATE_CHAT_BACKLOG_MAX` に達すると、キューが空くまで後続メッセージは破棄されます。

| コマンド | 挙動 |
| :--- | :--- |
| `/translate ja` | 対象メッセージに返信し、以降の発言を日本語へ翻訳 |
| `/translate cn @username` | 観測済みのユーザー名を指定し、以降の発言を簡体字中国語へ翻訳 |
| `/translate en` | 対象メッセージに返信し、以降の発言を米国英語へ翻訳 |
| `/translate uk` | 対象メッセージに返信し、以降の発言をウクライナ語へ翻訳 |
| `/translate ru` | 対象メッセージに返信し、以降の発言をロシア語へ翻訳 |
| `/translate list` | 正規表現フィルタに対応している対象言語一覧を JSON コードブロックで表示 |
| `/translate stop` | 引数・返信なしで実行した場合、本グループの全翻訳セッションを停止（機能の有効状態は維持） |
| `/translate stop @username` または `/translate stop 123456789` | 指定対象の翻訳セッションのみ停止（返信やチャンネル負数 ID にも対応） |
| `/translate disable` | 本グループの全セッションを消去して翻訳機能を無効化（要管理権限） |

### セッション容量と排他ルール

- **セッション上限**：一般メンバーでも翻訳セッションの開始・停止が可能です。1 グループあたり最大 `TRANSLATE_CHAT_USER_LIMIT` 件の異なる身分を同時に翻訳でき、それぞれ個別の翻訳先言語を設定できます（インスタンス全体の管理グループ上限は `STATE_MANAGED_CHAT_LIMIT`）。上限到達時は既存セッションを追い出さず新規開始を拒否するため、言語を切り替える際は先に現在のセッションを停止してください。
- **引数競合の拒否**：メッセージへの返信と異なる対象引数を同時に指定した場合は、グループ全体の停止にフォールバックせずコマンドを拒否します。
- **Copy との優先順位**：`/copy stop` は実行中の翻訳セッションに影響しません。同一対象が Copy と翻訳の両方に設定されている場合は**翻訳が優先**され（原文復唱・メディア複製・リアクション付与は行わない）、他の対象の Copy はそのまま継続します。

`/translate list` を実行すると `TRANSLATE_LANGUAGE_LABELS` が返されます（Telegram の `pre` エンティティ・`TRANSLATE_LIST_JSON_LANGUAGE` ハイライト付きで送信され、`COMMAND_MESSAGE_AUTO_DELETE_MS` 経過後に自動削除）：

```json
{
  "ja": "日语",
  "cn": "简体中文",
  "en": "美式英语",
  "uk": "乌克兰语",
  "ru": "俄语"
}
```

### 言語判定と送信ルール

- **正規表現による事前フィルタリング**：本文とキャプションはプレーン文字列として判定されます。すでに翻訳先言語で書かれていると判定された場合や、数字・記号・絵文字のみで構成されている場合は、外部翻訳 API を呼ばず何も送信しません：
  - **日本語**：平仮名または片仮名を含むこと（`TRANSLATE_JAPANESE_EVIDENCE` / `TRANSLATE_JAPANESE_TEXT`）。
  - **簡体字中国語**：Unicode Unihan で簡体字対応を持つ繁体字を含まないこと（`TRANSLATE_CHINESE_EVIDENCE` / `TRANSLATE_CHINESE_TEXT`）。
  - **英語**：ASCII 英字を受け入れます（`TRANSLATE_ENGLISH_EVIDENCE` / `TRANSLATE_ENGLISH_TEXT`）。米国英語の翻訳には `en-US` 対応の [Google Translation LLM](https://docs.cloud.google.com/translate/docs/languages#translation-llm)（`TRANSLATE_REGIONAL_MODEL`）を使用します。
  - **ウクライナ語**：ウクライナ語固有文字とアポストロフィを受け入れ、ロシア語の `ёъыэ` を除外します（`TRANSLATE_UKRAINIAN_EVIDENCE` / `TRANSLATE_UKRAINIAN_TEXT`）。
  - **ロシア語**：`Ё/ё` を受け入れ、ウクライナ語固有の `єіїґ` を除外します（`TRANSLATE_RUSSIAN_EVIDENCE` / `TRANSLATE_RUSSIAN_TEXT`）。
  - *補足*：日中共通漢字、アクセントなしラテン文字、短いキリル文字文などは文字種だけでは曖昧さが残る場合があり、事前正規表現では意味レベルの言語識別は行いません。
- **送信フォーマット**：訳文のみを送信し、原文の再送やメディア複製は行いません。API 呼び出しが失敗した場合や、訳文が原文と一字一句同じ場合は何も送信しません：
  - 訳文はリッチ装飾なしのプレーンテキストとして送信され、リンクが含まれる場合は元メッセージのリンクプレビュー設定を引き継ぎます。
  - キャプション付きの画像・動画・音声・ファイル・有料メディアは、キャプションの訳文のみをテキスト送信し、メディア本体は複製しません。
  - キャプションのない画像・スタンプ・ファイルや、投票・位置情報などは翻訳せず、Copy へのフォールバックも行いません。
  - 訳文が `TELEGRAM_MESSAGE_MAX_CHARS` を超える場合は送信しません。元のフォーラムトピック（`message_thread_id`）を維持し、表示可能なスラッシュコマンドを抑止します。各種コマンド通知は `COMMAND_MESSAGE_AUTO_DELETE_MS` 経過後に自動削除されます。
- **永続化と復旧**：翻訳セッションは SQLite `chat_states` テーブルの該当グループ行の `translate` JSONB カラムに保存されます。特定対象の停止はその対象のみを解除し、他者の進行中タスクは中断しません。`/translate disable` または Bot 退出時は全セッションを消去します。現在の翻訳人数と上限は `/bot_status` で確認できます。

---

<a id="commands-and-permissions"></a>

## 🎮 コマンドと権限

| コマンド | 権限 | 説明 |
| :--- | :---: | :--- |
| `/copy`<br>`/copy reverse`<br>`/copy nya` | グループメンバー | 対応する本文・キャプションの Copy モードを開始 |
| `/copy stop` | グループメンバー | グローバル Copy を停止し、アバターをデフォルトへ復元 |
| `/icon steal` | グループメンバー | 対象のアバターのみをコピー |
| `/icon reset` | グループメンバー | アバターをデフォルト画像に戻す |
| `/translate ja\|cn\|en\|uk\|ru [@username]`<br>`/translate list`<br>`/translate stop [@username/id]` | グループメンバー | 翻訳先言語を指定して開始、対応言語一覧を表示、または全体／指定対象の翻訳を停止 |
| `/translate enable\|disable` | `isCanControllTranslatePermission` | 本グループの翻訳機能を有効化／無効化（既定では無効） |
| `/wed` | グループメンバー | グループメンバーから「嫁」をランダム抽選してアバターを表示（確定・変更・削除に対応、要 `/init enable`） |
| `/h_image` | グループメンバー | 専用画像ライブラリから均等に 1 枚抽選してスポイラーマスク付きで送信（画像は長期保持、失敗通知は `COMMAND_MESSAGE_AUTO_DELETE_MS` 後に自動削除） |
| `/h_image add` | `isCanAddHImage` | 画像付きメッセージに返信し、その画像（アルバムの場合は受信済みの同一組画像も含む）を専用ライブラリへ収録（集計通知は `COMMAND_MESSAGE_AUTO_DELETE_MS` 後に自動削除） |
| `/info [@username\|id]` | グループメンバー | 対象の表示名、ユーザー名、数値 ID、アバターを照会（ユーザー・チャンネル・他 Bot・本 Bot 自身に対応、通知は `COMMAND_MESSAGE_AUTO_DELETE_MS` 後に自動削除） |
| `/<アクション語>` | グループメンバー | `CJK_ACTION_COMMAND_PATTERN` に一致する中国語アクションコマンド（`/咬`、`/揪住` など）。「実行者 咬了 対象！」と返信し、成功結果は長期保持 |
| `/quiet [<分数>]` | グループメンバー | Bot のランダム発言・ランダム復唱などの自発的反応を一時停止（`QUIET_MIN_MINUTES`〜`QUIET_MAX_MINUTES`、省略時は `QUIET_DEFAULT_MINUTES`） |
| `/unquiet` | グループメンバー | 静寂モードを早期解除 |
| `/mute … <期間>`<br>`/unmute` | `isCanMute`<br>`isCanUnMute` | スーパーグループで指定メンバーを一時ミュートまたは早期解除（返信・`@username`・数値 ID 対応、期間は `m/h/d` 単位で `MUTE_MIN_DURATION_MS`〜`MUTE_MAX_DURATION_MS`） |
| `/gag … [<分数>] [<用具>]`<br>`/ungag …` | `isCanGag` | ユーザーまたはチャンネルの発言を専用 Inline 入口経由のみに制限（分数は `GAG_DURATION_MINUTES`、省略時は `GAG_DEFAULT_DURATION_MINUTES`・`GAG_DEFAULT_TOOL`）、または早期解除 |
| `/delete_message …`<br>`/delete_message stop …` | `SUPER_ADMIN_USER_ID` | 対象が本グループで以降に送信する全メッセージを削除（コマンド以前のメッセージは対象外）、または停止（返信・`@username`・ユーザー ID・チャンネル負数 ID 対応） |
| `/block … enable` | `isCanBlock` | ブラックリスト登録：SQLite 永続ブラックリストに記録し、管理下の全スーパーグループで BAN（返信・`@username`・正のユーザー ID 対応） |
| `/block … disable` | `isCanUnBlock` | ブラックリスト解除：SQLite から削除し、管理下の全スーパーグループで BAN 解除（上記に加えチャンネル負数 ID の直接指定にも対応、本グループ自身は拒否） |
| `/ai_chat enable\|disable` | `isCanControllAIPermission` | 本グループの AI 雑談機能を有効化／無効化 |
| `/clear_context` | `isCanClearContext` | 本グループの AI コンテキスト記憶を消去（ローリング逐語バッファと要約を初期化し、`chat_states.ai_context` を `NULL` にして進行中の返信を無効化） |
| `/mood query` | グループメンバー | 現在のグローバル AI 気分を照会（再抽選なし。AI 有効かつモデル設定正常時のみ） |
| `/mood switch` | `isCanSwitchMood` | グローバル AI 気分を即時再抽選して全グループへ反映し、新しい気分名を通知 |
| `/ad_detect enable\|disable` | `isCanControllAdDetectPermission` | 本グループのスマート広告検出を有効化／無効化。保護対象外の違反者を `ad_detect.json` の設定に従いミュート・キック・BAN して通知 |
| `/flood_control enable\|disable` | `isCanControllFloodControlPermission` | 本グループの連投スパム自動ミュートを有効化／無効化（既定では無効） |
| `/antiraid enable\|disable` | `isCanControllAntiRaidPermission` | 本グループの参加認証と Anti-Raid 非公開ロックモードを有効化／無効化（既定では無効） |
| `/qa set` | `isCanControllQaPermission` | Q&A 登録フォームを開始し、「问题:」「回答:」を送信して登録（上限 `CHAT_QA_MAX_PER_CHAT` 件、文字数上限 `CHAT_QA_QUESTION_MAX_CHARS`／`CHAT_QA_ANSWER_MAX_CHARS`） |
| `/qa query`<br>`/qa query <質問テキスト>` | グループメンバー | 本グループの全カスタム Q&A または指定質問を照会（1 ページ `QA_QUERY_PAGE_MAX_ENTRIES` 件、回答は `QA_QUERY_ANSWER_PREVIEW_MAX_CHARS` で省略表示。ボードは長期保持、未一致通知は `COMMAND_MESSAGE_AUTO_DELETE_MS` 後に自動削除） |
| `/qa remove <質問テキスト>` | `isCanControllQaPermission` | 本グループの指定カスタム Q&A を削除 |
| `/permission query`<br>`/permission help` | ユーザー/チャンネル身分 | 自身・返信先・指定対象の権限一覧を照会、または JSON で権限説明を表示（成功ボードは長期保持） |
| `/permission …` | `SUPER_ADMIN_USER_ID` | ホワイトリスト登録済みユーザー／チャンネルの個別権限を変更（`all` で全権限を一括付与） |
| `/white … enable\|disable` | 追加：`isCanWhiteOther`<br>削除：`SUPER_ADMIN_USER_ID` | ホワイトリストへの追加・削除（委任追加は基本の既定権限のみ付与。個別権限の編集はスーパー管理者限定） |
| `/bot_status` | `isCanViewBotStatus` | プロセス指標、モデル準備状態、Telegram 429 送信キュー、AI コンテキスト飽和度、有効 gag 数、翻訳人数、Bot 管理者権限、グループ機能スイッチを表示 |
| `/init enable\|disable` | `SUPER_ADMIN_USER_ID` | 本グループにおける Bot 管理機能のマスタースイッチを切り替え |
| `/batch_kick <Nm\|Nh\|Nd>` | `SUPER_ADMIN_USER_ID` | スーパーグループで指定時間枠（`BATCH_KICK_MIN_DURATION_MS`〜`BATCH_KICK_MAX_DURATION_MS`）内に参加したメンバーを一括キック（ブラックリスト登録はしない） |
| `/send <グループ ID>`<br>`/send finish` | `SUPER_ADMIN_USER_ID`（個人チャット限定） | 個人チャットから指定グループへのメッセージ中継を開始／終了（特定 JSON コードブロックによる音声バブル代行送信に対応） |

> [!IMPORTANT]
> **権限列の読み方**：
> - `isCanXxx` のコマンドはホワイトリストの権限フラグで認可されます。スーパー管理者（`SUPER_ADMIN_USER_ID`）はホワイトリスト登録なしで恒常的に**全権限フラグ**を保持します。
> - `SUPER_ADMIN_USER_ID` のコマンドは**最上位のシステム境界であり、設定されたスーパー管理者ユーザー ID 本人のみが実行可能で、ホワイトリストで他者へ委任することはできません**。

### パラメータと対象のマッチング規約

- **フォーラムトピック作成メッセージ**：トピック作成時に自動生成されるサービスメッセージへの返信は「明示的なメッセージ返信なし」として扱われ、`@username` や数値 ID 引数で対象を指定できます。連携チャンネルからディスカッショングループへ自動転送された投稿へのコメント返信は通常の返信として扱われます。
- **権限ポリシーのプリフェッチ**：ホワイトリスト／ブラックリストの照会・変更を伴うすべてのコマンドは、実行前にメモリ上のポリシーウォームアップが完了している必要があります。失敗時は短時間で消える案内のみを返して処理を中止します。
- **コマンドメニュー**：サブコマンドを持つコマンド（`/copy`、`/qa`、`/mood`、`/icon`）はメニュー上に 1 項目として登録され、説明文に主な構文が記載されます。サブコマンドの省略時や未定義語指定時は使い方案内を返します：
  - `/qa set`、`/mood query`、`/mood switch` は追加引数を受け付けません。
  - `/qa query` は引数省略時に全件を表示し、`/qa remove` は質問文の指定が必須です。いずれも質問文中の空白や改行を厳密に保持します。
- **通知メッセージの自動削除**：グループ内コマンドで発生する検証エラー、権限拒否、使い方案内、操作完了通知は、送信成功から `COMMAND_MESSAGE_AUTO_DELETE_MS` 経過後に統一して自動削除されます。
  - **長期保持される例外**：`/permission help`・`/permission query` の権限ボード、`/qa query` の Q&A ボード、Q&A 直接応答の回答文、成功した中国語アクションコマンドの結果、`/h_image` の抽選画像、`cron.json` の定時送信メッセージ、および復唱・翻訳・AI 返信などの会話出力。
  - **ステートマシンが管理するメッセージ**：参加認証ボタン、`/qa set` 入力フォーム、`/wed` の抽選カードとボタン、gag の告知・発言入口通知には固定タイマーを掛けず、ボタン操作・状態遷移・グループ teardown 時に削除されます。
- **サブコマンドの大文字・小文字非区別**：`/copy stop|reverse|nya`、`/icon steal|reset`、`/qa set|remove|query`、`/translate <言語>|stop`、`/mood query|switch`、`/h_image add`、`/delete_message stop` のサブコマンド語は大文字・小文字を区別しません（`/block`、`/white`、`/init` と共通）。後ろに続くユーザー名・ID・質問本文は大文字・小文字をそのまま保持します。
- **ボタンコールバックの厳格検証**：参加認証、`/wed`、`/qa query` ページ送りの `callback_data` に含まれる数値は正規の十進整数として厳格に検証されます（0 始まりのページ番号は `QA_QUERY_PAGE_ARG_PATTERN`、参加認証の選択肢は `VERIFY_ANSWER_ARG_PATTERN`、各種 ID は正の整数のみ。正符号・先頭ゼロ・空白・小数点・指数表記は拒否）。不正形式は即座に「ボタン期限切れ」として処理されます。

---

### 挙動の詳細

#### 1. ペルソナと通知口調
- **インスタンス全体で共通**：ペルソナはプロセス単位のデプロイ設定であり、グループごとにコマンドで切り替えることはできません。
- **ペルソナと通知口調の使い分け**：
  - **AI ペルソナ**：プロジェクトルートの `prompt/persona.md` が存在すればそれを読み込み、存在しない場合は内蔵のメスガキペルソナを使用します。
  - **Bot 通知とメニュー**：コマンド通知、権限説明、ボタン文言、定時アナウンス、Inline おみくじは `config/static/bot.json` の `atmosphere`（`mesugaki` = からかい風、`normal` = 控えめな通常風）に従います。省略時はカスタムペルソナなら `normal`、内蔵ペルソナなら `DEFAULT_BOT_ATMOSPHERE` になります。
  - **Mini App コンソール**：`atmosphere` 設定には従わず、権限説明を含め常にメスガキ風の口調で固定表示されます。
- **起動時確定**：いずれも起動時に確定し、変更の反映にはサービス再起動が必要です。
- **コマンドメニューの登録範囲**：起動時はグループチャットスコープ（`all_group_chats`）のみにメニューを登録し、個人チャットのメニューは削除します。個人チャットではスーパー管理者の `/send` のみに応答し、`mini_app` 設定時はスーパー管理者の個人チャット左下に `MenuButtonWebApp`（`App` ボタン）を配置します。

#### 2. `/bot_status` 指標収集
- **通知口調に応じたラベル**：CPU、稼働時間、メモリ使用量、各モデル能力名、Telegram 送信ゲートなどの行ラベルは現在の通知口調テーブル（`packages/consts/atmosphere/{plain,teasing}/notices.ts`）から取得します（数値や表示条件は共通）。
- **モデル能力一覧**：準備完了している能力のみを「能力名：モデル名」形式で表示します（最後の `/` より前の名前空間を除去し、xAI 音声合成は音色名を表示）。未設定の画像生成・音声合成・独立ウェブ検索や、未準備の AI 雑談・広告検出は表示せず、該当項目が 0 件ならセクションごと省略します。
- **実メモリ使用量**：実行時に `Bun.unsafe.memoryFootprint()` を呼び出し、Worker を含むプロセス全体の物理常駐メモリ（Linux では共有ページを按分した PSS）を計測します。使用率の分母にはコンテナの cgroup メモリ上限（制限なしの場合はホスト物理メモリ総量）を用い、取得不能時は「利用不可」と表示します。
- **グループ AI コンテキスト飽和度**：直近のホット逐語メモリ（上限 `VERBATIM_CONTEXT_MAX`）とコールド要約ラウンド（上限 `MAX_SUMMARY_ROUNDS`）の使用率を `BOT_STATUS_HOT_MEMORY_WEIGHT` と `BOT_STATUS_COLD_MEMORY_WEIGHT` で加重平均し、単一のパーセンテージとして表示します。AI Worker がメモリ snapshot（周期 `AI_SNAPSHOT_INTERVAL_MS`）で報告した値をメインスレッドの読み取り専用ミラーから参照します。
- **権限と機能スイッチ**：本グループで Bot が保持している管理者権限と、中国語の機能ラベル（`BOT_STATUS_FEATURE_LABELS`）をキーにした各グループ機能スイッチの真偽値（`true` / `false`）をそれぞれ JSON コードブロックで出力します。

#### 3. アクションコマンドと /x
- アクション成功時は `実行者名 アクション 対象名` の形式で返信し、公開ユーザー名を持つアカウントにはプロフィールリンクを付与します。対象は返信または `@username` で指定します。
- 成功したアクション応答は長期保持され、対象未指定・引数エラー・メニュー上の `/x` タップ時の案内は `COMMAND_MESSAGE_AUTO_DELETE_MS` 経過後に自動削除されます。

> [!TIP]
> **中国語アクションコマンドは事前登録不要**で、`CJK_ACTION_COMMAND_PATTERN` に一致するスラッシュ語（例：`/咬`、`/抱`、`/摸摸`）をそのまま実行できます：
> - Telegram 公式メニューは ASCII 文字のみ対応のため、メニューには説明用プレースホルダー `/x` のみを登録しており、タップすると使用例を返信します。
> - `CJK_ACTION_COMMAND_PATTERN` の文字数上限を超える入力（例：`/咬咬咬`）はアクションコマンドとみなさず、通常のチャットメッセージとして扱います。
> - インスタンス全体のスライディングウィンドウ制限により、`CJK_ACTION_RATE_LIMIT_WINDOW_MS` あたり最大 `CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW` 回まで処理し、超過分は静かに破棄します。

#### 4. グループ Q&A：/qa ライフサイクル
- **対話型フォーム入力**：
  - `/qa set` を送信すると本グループで Q&A 入力フォームを開き（要 `isCanControllQaPermission`）、トピック機能付きスーパーグループでは実行元トピック（`message_thread_id`）に紐付けます。以降は同一グループ・同一トピック内で開始者本人が送った投稿のみを受理し（チャンネル身分・匿名管理者も対応）、別トピックのメッセージは受理・削除しません。
  - 入力行は行頭を `QA_QUESTION_LABELS`（`问题:` / `问题：`）または `QA_ANSWER_LABELS`（`回答:` / `回答：` / `答案:` / `答案：`）で始め、2 通に分けても 1 通にまとめても送信できます。
  - 回答内の ```` ```json ```` コードブロックはリテラルのコードフェンスごと保存され、直接応答時にそのまま出力されます（フェンス文字数も `CHAT_QA_ANSWER_MAX_CHARS` に含まれます）。
  - 質問全文、および回答のコードブロック外には、クリック可能なコマンドとして表示されるスラッシュ表記（`/start`、`/etc/hosts` など）を含められません。文字数超過と同様に記録を拒否しつつフォームを維持し、書き直しを案内します（コードブロック内のコマンド例はそのまま登録可能）。
  - 受理された入力メッセージは通常パイプラインへ流さず即座に削除し、フォームメッセージをインプレース編集して進捗を表示します（表示全体が `TELEGRAM_MESSAGE_MAX_CHARS` を超える場合はプレビューのみ `QA_TRUNCATION_MARK` で切り詰め、データベースには完全な回答を保存）。質問と回答が揃った時点で SQLite に確定保存されます。
- **同時実行と有効期限**：
  - フォームは 1 グループにつき同時に 1 件のみ（グローバル上限 `QA_FORM_SESSION_MAX`）で、無操作のまま `QA_FORM_SESSION_TTL_MS` が経過すると自動失効します。同一項目を再送すると上書きされ、開始者本人が再度 `/qa set` を送ると旧フォームを破棄して開き直し、他メンバーからの `/qa set` は拒否されます。
  - `/init disable` または Bot 退出時は本グループの全 Q&A がデータベースから削除されます（管理者権限の喪失のみでは保持されます）。
- **ボードのページ送りと完全一致の直接応答**：
  - `/qa query` は 1 ページ `QA_QUERY_PAGE_MAX_ENTRIES` 件でページ分割し、ボタン操作でインプレース更新します。ボード上では回答を `QA_QUERY_ANSWER_PREVIEW_MAX_CHARS` で省略表示しますが、**質問文は一切切り詰めません**。
  - **完全一致による即時応答**：メンバーの発言（先頭の `@Botユーザー名` 除去後）が登録済み質問と一字一句一致すると、AI を介さず・モデルクォータも消費せず・静寂モード中でも即座に登録回答を返します。表現が異なる類似質問は、AI 雑談ラウンド内で `group_qa_query`・`group_qa_answer` ツールを通じて検索・回答されます。

#### 5. 発言制限：/gag
- **セッション枠と Inline 入口**：
  - グローバルで同時に保持できるセッション上限は `GAG_SESSION_MAX` 件（開始中・終了中の遷移状態を含む）です。同一グループで複数人を制限できますが、同一身分の重複登録はできません。
  - 通常ユーザーを制限するとグループ内に公開ステータスメッセージを出しつつ、`ephemeral_message_parameters.receiver_user_id` を用いて本人にだけ見える「発言」ボタン付き一時入口を送信します。チャンネル身分にはボタン付きの公開ステータスを送信します。
  - ボタンをタップすると `GAG_INLINE_QUERY_PREFIX<対象 ID>`（`gag:<対象 ID>`）が入力済みの Inline モードが開きます。送信されたメッセージには対象 ID とグループ ID を埋め込んだ隠しリンクが付与され、着信時に対象・グループ・実送信者を照合して偽装や別グループへの持ち込みを即座に削除します。
- **動的書記素難読化アルゴリズム**：
  - 書記素クラスタごとにサンプリングし、`GAG_FILL_OPERATION_PROBABILITY` の確率でドット追加（`GAG_FILLER_MIN_DOTS`〜`GAG_FILLER_MAX_DOTS` 個、隣接ドット間は `GAG_FILLER_GAP_SPACE_PROBABILITY` の確率で空白挿入）、それ以外は等確率で `GAG_REPLACEMENT_CHARACTERS` の文字へ置換します。
  - 同一種の操作の連続適用は最大 `GAG_MAX_CONSECUTIVE_SAME_OPERATIONS` 書記素までに制限し、極端に短い文でも `GAG_MIN_OPERATION_TIERS` で最低限の変換数を保証します。
- **ハートビートと入口の再送**：
  - グループ内で通常メッセージが `GAG_SPEAK_NOTICE_MESSAGE_INTERVAL` 件流れるたびに入口案内を更新します（セッションごとに独立カウント）。
  - 個人用入口は `GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS` 周期で更新され、対象が `GAG_SPEAK_NOTICE_IDLE_INTERVAL_MS` 連続で無発言だった場合は次回発言試行時に即座に再送します。
- **グループ解除時のクリーンアップ**：`/init disable` または管理者権限喪失時はグループ内の全 gag セッションを終了して案内を削除します。Bot がすでに退出している場合は削除通信を行わずセッション枠を即座に解放します。

#### 6. 対象メッセージの削除：/delete_message
- **構文と対象制限**：`/delete_message <対象>` で削除開始、`/delete_message stop <対象>` で停止します（返信・`@username`・数値ユーザー ID・チャンネル負数 ID 対応、`stop` は大文字小文字非区別）。スーパー管理者本人のみ実行可能で、Bot にグループのメッセージ削除権限が必要です。Bot 自身・現在のグループ身分（匿名管理者）・スーパー管理者本人は指定できません。
- **削除範囲とパイプライン位置**：コマンド実行後に対象が本グループへ送った新規メッセージのみを削除します（過去のメッセージは対象外）。`sender_chat` があればチャンネル身分、なければ `from` で判定します。対象メッセージは参加認証・広告検出・連投カウントを通過した後に受理され、gag・コマンド・AI・Copy には進まないため、対象が送ったコマンドも実行されません。
- **対象が他の Bot の場合**：@BotFather で Bot-to-Bot Communication Mode を有効化しておく必要があります。削除対象の判定は他 Bot 入口レート制限（`BOT_MESSAGE_ACTIVITY_LIMIT`）より先に行われ、カウントを消費せず通過するため、連投する対象 Bot の発言も漏れなく削除されます（削除対象外のグループでは通常どおりカウントされます）。
- **削除キューとバッチ処理**：
  - 受理したメッセージは 1 件ずつメインスレッドのメモリ削除キュー（全グループ合計上限 `DELETE_MESSAGE_QUEUE_MAX` 件）へ入ります。
  - 単一のコンシューマループが統一 Telegram 送信ゲート経由で `deleteMessages` を呼び出し、リクエスト処理中に同一グループから連続到着した分を最大 `TELEGRAM_DELETE_MESSAGES_BATCH_MAX` 件の 1 バッチにまとめて削除します。
  - 削除失敗は統一 Telegram エラーログへの記録のみで再試行しません。キュー満杯時も新規メッセージは受理して後続処理を遮断しつつキュー投入のみ見送り、満杯発生時に warn を 1 行、キューが空になった時点で破棄件数の集計を 1 行出力します。
- **容量・永続化・シャットダウン**：
  - 1 グループ最大 `DELETE_MESSAGE_CHAT_TARGET_MAX` 件で、SQLite `chat_states` の `deleteMessageTargets` JSONB 配列に永続化され再起動後も維持されます。開始・`stop` ともに永続化完了後に応答します。
  - `stop` は対象登録のみを解除し、キュー投入済みの削除はそのまま実行します。`/init disable`・Bot 退出・管理者権限喪失時は本グループの全対象を解除して永続化し、未送信のキュー項目も破棄します。
  - 永続化された対象にグループ自身またはスーパー管理者が含まれている場合は起動を拒否します。
  - 通常停止時は Telegram 送信ゲートを閉じる前にメモリ上の削除キューをすべて処理（ドレイン）し、停止予算を超えた残件は破棄してエラーログに記録します。各種コマンド通知は `COMMAND_MESSAGE_AUTO_DELETE_MS` 後に自動削除されます。

#### 7. ブラックリスト：/block
- **構文**：`/block <対象> enable` で登録、`/block <対象> disable` で解除します。返信（チャンネル名義の投稿を含む）・`@username`・正の整数ユーザー ID、および `disable` 解除時のみチャンネル負数 ID の直接指定に対応します。
- **適用範囲**：登録された ID は SQLite の正式ブラックリストへ書き込まれ、Bot が管理する全スーパーグループでキック／BAN されます。Bot が新規グループへ参加したり管理者権限を付与された際も、既存のブラックリスト対象を自動スキャンして処置します。
- **非同期一括処置**：
  - **`enable`**：SQLite 永続化を確認後、バックグラウンドで全管理グループへの BAN を進め、成功・失敗グループ数の集計レポートを送信します（BAN 権限がないと確定しているグループには API リクエストを送らず失敗件数に計上）。
  - **`disable`**：先にブラックリストから削除・永続化したうえで、バックグラウンドで各グループの BAN 解除を進め、完了後に通知します（BAN 権限がないグループは同様にスキップして失敗計上）。
  - **同一対象の順序保証**：同一対象に対する `/block … enable`、`/block … disable`、および広告検出処置は到着順に 1 件ずつ直列実行されます。
- **削除済みアカウントの自動整理**：巡回処置で同一対象へのリクエストが `BLOCKLIST_PARTICIPANT_INVALID_LIMIT` 回連続して `PARTICIPANT_ID_INVALID`（退会済みアカウント）となり、どのグループでも有効な処置が成立しなかった場合、ブラックリストから自動削除されます。

#### 8. 広告検出と荒らし対策
- **`/ad_detect`（スマート広告検出）**：
  - **3 段階判定パイプライン**：同一送信者（`chatId:senderId`）の短時間の発言を束ね、`AD_DETECT_QUEUE_TICK_MS` ごとに以下の順で検査します：
    1. ステッカーパックブラックリストのファストパス（`sticker_black_list`）
    2. カスタム絵文字パックブラックリスト（`emoji_black_list`、メインスレッドの統一 Telegram 送信ゲート経由で照会）
    3. `agent.ad_detect` モデル判定（`samples`）
  - **処罰モードとチャンネル特則**：いずれかで命中すると該当メッセージを削除し、保護対象外の送信者を `ad_detect.json` の `punishment` に従って処罰します。`mute` は本グループでのミュート（時限または永久）、`kick` は本グループからの追放（BAN なし／本グループのみ BAN／`/block` と同等の恒久ブラックリスト登録＋全管理グループ BAN）を実行します。チャンネル身分は全体 BAN 以外の設定ではメッセージ削除のみ行います。判定理由と処罰結果の通知は `COMMAND_MESSAGE_AUTO_DELETE_MS` 後に自動削除されます。
  - **プロキシ URL の誤検知防止**：勧誘・宣伝文を伴わない純粋なプロキシ接続リンク（`vless://`、`vmess://`、`trojan://`、`ss://`）は広告と判定されません。
- **`/flood_control`（連投スパム制限）**：スーパーグループで同一ユーザーが `FLOOD_WINDOW_MS` 内に `FLOOD_MESSAGE_LIMIT` 件発言すると、即座に `FLOOD_MUTE_DURATION_MS` の一時ミュートを適用し警告を通知します（`COMMAND_MESSAGE_AUTO_DELETE_MS` 後に自動削除）。管理者（Bot を除く）、チャンネル身分、`isCanBypassFloodControl` 保持者は免除されます。
- **`/antiraid`（参加認証と非公開ロックモード）**：新規参加者に `VERIFICATION_TIMEOUT_MS` 以内の三択算数認証を課し（不正解は BAN なしで即時キック、Bot 追加時は管理者が「通过」で承認）、`JOIN_WINDOW_MS` 内の参加数が `ANTI_RAID_PER_MINUTE_LIMIT` を超えると `LOCKDOWN_MS` の非公開ロックモードへ移行します。無効化時は進行中の認証をすべて中止して案内メッセージを撤回します（広告検出・連投制限・ブラックリストには影響しません）。
- **`/batch_kick`（新規参加者の一括キック）**：
  - **対象範囲と除外**：スーパー管理者限定。参加ログから指定時間枠（`30m`、`2h`、`1d` など、`BATCH_KICK_MIN_DURATION_MS`〜`BATCH_KICK_MAX_DURATION_MS`）に参加した在籍メンバーを一括キックします（ブラックリスト登録は行わず、ホワイトリスト・ブラックリスト登録済み身分はスキップ）。
  - **単一実行バックグラウンド処理**：先に受理通知（件数と時間枠）を返し、グループあたり 1 バッチ限定でバックグラウンド実行して完了後に結果レポートを送信します。事前照会中または実行中に `/init disable`（再有効化を挟む場合を含む）・Bot 退出・管理者権限喪失が発生した場合は、結果レポートを送らず静かに停止します。

#### 9. プライベート中継と音声代行：/send
- スーパー管理者が Bot との個人チャットで `/send <グループ ID>` を送ると中継セッションを開始します（対象グループは `/init enable` 済みである必要があり、到達性を事前検証したうえで以降の発言を対象グループへそのまま転送します）。
- **音声代行モード**：個人チャットでメッセージ全体を次の JSON コードブロックとして送ると、音声バブルに合成して対象グループへ送信します：
  ```json
  { "type": "tts", "tone": "望む口調", "text": "変換するテキスト" }
  ```
  - 本文上限は `VOICE_OPERATOR_TEXT_MAX_CHARS`、口調指定上限は `VOICE_TONE_MAX_CHARS`（UTF-16 コード単位）です。
  - 音声合成はバックグラウンドで非同期実行され、`config/dynamic/agent.json` に有効な `agent.tts` 設定が必要です。
  - クォータは `agent.tts.daily_reserve_quota`（定時タスクと共用、通常の AI 雑談日次枠とは分離）から消費されます。

> [!TIP]
> **`/luck_challenge` はスラッシュコマンドではありません**：@BotFather で Inline Mode を有効化したうえで、任意のチャット入力欄に `@Botのユーザー名 [願い事]` と入力すると今日のおみくじを引けます。グローバルなスライディングウィンドウ制限により、`RATE_LIMIT_WINDOW_MS` ごとに最大 `RATE_LIMIT_MAX_CALLS_PER_WINDOW` 回まで応答し（定数は `packages/consts/luckChallenge.ts`）、超過時はレート制限プレースホルダーを返します。当日の運勢シークレット更新に失敗した場合はエラーログを記録して空結果を返します（いずれもクライアントキャッシュは `LUCK_INLINE_NO_DRAW_CACHE_SECONDS` 秒のみ）。

---

## 💍 グループ嫁：/wed

`/init enable` 済みのグループでメンバーが `/wed`（引数なし）を送信すると、グループメンバーから 1 人を抽選して現在のアバターとキャプション「実行者，你的群友老婆是 メンバー!」を返信し、下部に操作ボタンを表示します。ボタン文言は `atmosphere` に連動し、からかい風（`mesugaki`）では「移除」「娶老婆!」「换一只」（確定後は「已确认♡」）、通常風（`normal`）では「移除」「确认」「更换」（確定後は「已确认」）となります。

| ボタン | 挙動 |
| :--- | :--- |
| **移除** | この抽選結果を削除し、セッションを解放 |
| **娶老婆! / 确认** | 現在の結果を確定し、中央ボタンを「已确认♡」／「已确认」へ更新（確定後も再抽選は可能） |
| **换一只 / 更换** | 同一メッセージ内で実行者と現在の対象を除外して再抽選し、アバター・キャプション・確定ボタンを更新 |

### 中核動作の仕組み

- **実行者本人のみ操作可能**：ボタンを操作できるのは `/wed` を実行した本人のみで、再抽選の完了前に古いボタンを押しても新しい対象には影響しません。再度 `/wed` を送ると新規抽選を行い、新カードの送信成功後に旧カードを削除します（新カード送信失敗時は旧カードを維持し、旧カード削除失敗時はボタン失効状態で残ります）。1 グループにつき各ユーザーが保持できる有効カードは 1 枚のみです。
- **候補スライディングウィンドウ**：
  - グループごとに独立したメモリ上の **`Map<number, number>`**（メンバー ID → 初回記録時刻、容量 `WED_MEMBER_LIMIT`）を維持します。
  - 初期化済みグループで**個人アカウント**として発言したユーザーのみを記録します（チャンネル名義・匿名管理者・システム通知は除外）。
  - ウィンドウ外メンバーの発言は末尾へ追加し、すでにウィンドウ内にいるメンバーの再発言では時刻を更新しません。満杯時は最も古いメンバーを押し出し、退室イベント検知時は即座に削除します。
  - 日次メンテナンス時刻（設定タイムゾーンの `DISK_IO_MAINTENANCE_CRON`）に Disk I/O Worker から通知を受け、メインスレッドが `WED_MEMBER_REVIEW_INTERVAL_MS` 間隔で `getChatMember` により在籍を再確認します（管理者権限が必要。非管理者グループは退室サービス通知で整理）。
- **ダウンロード不要のアバター再利用**：
  - `getChat` と `getUserProfilePhotos`（先頭 `USER_PROFILE_PHOTOS_LIMIT` 枚）を並行取得し、`big_file_unique_id` で現在のプロフィール画像を照合します。
  - 一致した場合は Telegram 上の `PhotoSize.file_id` をそのまま再利用して高速送信し、不一致の場合のみ現在のチャット画像をダウンロードして再送信します。
- **並行制御・永続化・保持件数**：
  - 抽選とボタン操作はメインスレッド専用スケジューラで処理します（グローバル同時実行上限 `WED_MAX_CONCURRENT`、FIFO 待機上限 `WED_MAX_PENDING`、各段階タイムアウト `WED_OPERATION_TIMEOUT_MS`）。
  - 候補ウィンドウは参加順の `{ id, enteredAt }` JSON 配列として Disk I/O Worker が `memory/wed/<chatId>.json` へバッチ書き込みします（条件は [07 運用とトラブルシューティング](07-operations.md#データルート) 参照）。
  - 各グループで直近に配信成功した `WED_SESSION_LIMIT` 件を保持し、新規配信成功時に最も古い待機カードがスライドアウトします（画像は残りボタンは期限切れ応答。抽選・送信失敗時は既存カードを押し出しません）。管理グループ総数上限は `STATE_MANAGED_CHAT_LIMIT` です。結果カードには固定の自動削除タイマーを掛けず、「移除」・差し替え・グループ teardown 時のみ削除します。

---

## 🔎 ユーザー情報照会：/info

`/init enable` 済みのグループでは、誰でもメッセージへの返信または `/info @username`、`/info <ユーザー ID>`、`/info <チャンネル/グループ ID>` で公開プロフィールを照会できます（ユーザー・チャンネル・他 Bot・本 Bot 自身に対応）。

- **表示項目**：公開表示名（ユーザーは `first_name last_name`、チャンネル／グループはタイトル）、ユーザー名（未設定時は明記）、タップでコピーできる数値 ID、および現在の公開アバター（未設定時は明記、グループ対象はアバター非表示）。
- **リアルタイム取得とフォールバック**：毎回 Telegram API へ照会し（ユーザーはグループメンバー情報、チャンネル／グループはチャット情報、本 Bot 自身はローカル設定）、失敗時はキャッシュ済み身分の情報へフォールバックします（名前もユーザー名も解決できない場合は「見つかりません」と返信）。アバター取得は `/wed` の仕組みを共用します（ユーザーは `file_id` 再利用、チャンネルはダウンロード再送信＋公開 `t.me` フォールバック）。
- **保持期間と実行予算**：結果カード・エラー通知とも `COMMAND_MESSAGE_AUTO_DELETE_MS` 経過後に自動削除されます。共有の遅延コマンド実行器で処理され、1 タスクあたりの制限時間は `INFO_TASK_BUDGET_MS` です（満杯時は「後ほど再試行」と返信）。個人チャットの `/info` には応答しません。

---

<a id="random-images"></a>

## 🖼️ ランダム画像：/h_image

**ライブラリパス設定**：`config/dynamic/assets.json` の `onlyPath.random_h_image_dir`（省略時はデータルート配下の `RANDOM_H_IMAGE_DIR`）。

`/init enable` 済みのグループで `/h_image`（引数なし）を送信すると、専用画像ライブラリから均等にランダム抽選した 1 枚を送信します。

- **対象ファイルと動的同期**：ライブラリ直下の `RANDOM_IMAGE_EXTENSIONS`（`jpg`、`jpeg`、`png`、`webp`）に一致する通常ファイルのみを対象とします（隠しファイル・サブディレクトリ・シンボリックリンクは除外）。`RANDOM_IMAGE_MAX_BYTES` を超える画像はスキップして再抽選します。`/h_image add` や Mini App 画像庫での追加・削除は再起動なしでメモリインデックスへ即座に反映されます。
- **スポイラーマスク**：送信される画像には常に Telegram のスポイラーマスク（`has_spoiler`）が適用され、タップするまでぼかし表示になります。
- **メッセージ保持ルール**：抽選された画像は機能コンテンツとして**長期保持**され、引数エラーや空ライブラリなどの案内通知は `COMMAND_MESSAGE_AUTO_DELETE_MS` 後に自動削除されます。
- **並行制御とレート制限**：
  - 共有の遅延コマンド実行器（同時実行上限 `DEFERRED_COMMAND_MAX_CONCURRENT`、待機枠 `DEFERRED_COMMAND_MAX_PENDING`）で処理します。
  - `/h_image add` および使い方案内と合算のスライディングウィンドウ制限により、`H_IMAGE_RATE_LIMIT_WINDOW_MS` ごとにインスタンス全体で最大 `H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW` 回まで受理し、超過分は静かに破棄します。

### 画像収集：/h_image add

`isCanAddHImage` 権限を持つメンバーが画像付きメッセージに返信して `/h_image add` を送ると、専用画像ライブラリへ収録できます。

- **収録対象**：返信先メッセージのネイティブ画像（最大解像度を選択）、および `RANDOM_IMAGE_DOCUMENT_MIME_TYPES`（`image/jpeg`、`image/png`、`image/webp`）に一致するドキュメント画像に対応します。アルバム（Media Group）に属するメッセージへ返信した場合は、受信済みの同一アルバム内画像もまとめて収録します（1 アルバム上限 `MEDIA_GROUP_ITEMS_MAX` 枚、キャッシュ上限 `MEDIA_GROUP_CACHE_MAX` 組）。
- **SHA-256 コンテンツアドレスによる重複排除**：
  - 保存ファイル名は**画像バイナリの小文字 SHA-256 ハッシュ値**（`RANDOM_IMAGE_CONTENT_NAME_PATTERN`）にマジックバイト判定から導出した拡張子（`RANDOM_IMAGE_SAVE_EXTENSIONS`）を付けた形式（例：`<hash>.jpg`）になります。
  - ダウンロード後のハッシュ照合で既存ファイルと一致した場合はディスク書き込みをスキップし、集計通知で「既存」として報告します。
- **解像度・サイズの事前検査**：Telegram `sendPhoto` の上限（幅＋高さ `TELEGRAM_PHOTO_MAX_DIMENSION_SUM` 以下、アスペクト比 `TELEGRAM_PHOTO_MAX_ASPECT_RATIO` 以下）を超える画像は収録を拒否し、`RANDOM_IMAGE_MAX_BYTES` 超過・非対応形式・ダウンロード失敗は失敗件数に計上します。
- **アトミック書き込み**：同一ディレクトリ内に `RANDOM_IMAGE_TEMP_PREFIX` で始まる一時ファイルを作成して検証完了後にアトミック `rename` します（ドット始まりの一時ファイルは抽選対象から自動除外されます）。
- **バッチ取得と集計通知**：1 ページ `H_IMAGE_ADD_DOWNLOAD_BATCH_SIZE` 枚ずつ並行ダウンロードし、タスク全体の時間予算 `H_IMAGE_ADD_TASK_BUDGET_MS` を超過した残件は失敗として計上します。完了後に集計結果（新規収録枚数、収録前の総枚数、重複スキップ数、サイズ不適合数、失敗数）を返信し、`COMMAND_MESSAGE_AUTO_DELETE_MS` 後に自動削除します。

---

## ⏰ 定時送信：cron.json

定時タスクは `config/dynamic/cron.json` で設定し、サービス再起動なしのホットリロードに対応しています（グループ内コマンドでの編集はありません）。フィールド仕様は [デプロイ設定説明](../../config_example/README/ja.md#cronjson)、設定例は [08 画像ライブラリと定時タスク](08-images-and-cron.md) を参照してください。

- **柔軟な配信先指定**：指定チャット一覧、発言可能な全有効グループ、または除外リストを除いた全有効グループに対し、テキスト・画像アルバム・ファイル・合成音声・ウェブ検索要約を定時配信できます。
- **画像とスポイラー制御**：固定画像は公開 `url` またはローカル `path` の配列（最大 `CRON_MAX_IMAGES` 枚）を指定でき、複数枚は先頭画像キャプション付きアルバムとして送信されます。ランダム画像モードは毎回 1 枚抽選し、`is_blurred` でスポイラーマスクの有無を制御します。
- **定時音声配信（`send_voice`）**：`content` を任意の `tone` 指定付きで音声バブルに合成して送信します。`agent.json` に有効な `agent.tts` が必須で、未設定時は起動検証またはホットリロード検証で拒否されます。
- **AI ウェブ検索要約（`send_web_digest`）**：短い `topic` を検索し、`instructions` に従って最大 `max_items` 件の MarkdownV2 要約を生成します（`agent.web_search` を優先し、未設定時は `agent.text` の組み込み検索を使用）。モデルが外部検索を実行しなかった場合は先頭に `WEB_DIGEST_UNSEARCHED_WARNING` を付与します。
- **保持とトピック振り分け**：定時送信メッセージは長期保持され、トピック有効のスーパーグループでは General トピックへ投稿されます。単発タスク（`just_once`）やランダム時刻はメモリ上のみで管理され、停止中に過ぎた予定時刻は再起動後に補填送信されません。

---

<a id="mini-app-console"></a>

## 🖥️ Mini App 管理コンソール：API と権限境界

`config/static/bot.json` に任意の `mini_app` オブジェクトを設定すると、ローカル `Bun.serve` HTTP サーバー（実装：`packages/mini-app-api-server/`、フロントエンド：`packages/mini-app-frontend/`）が起動し、スーパー管理者の個人チャット左下に `MenuButtonWebApp`（`App` ボタン）が配置されます。フィールド仕様は [デプロイ設定説明](../../config_example/README/ja.md#botjson)、Cloudflare Tunnel を含む設定手順は [10 Mini App の設定方法と推奨構成](10-mini-app.md) を参照してください。

### 1. 認証とセキュリティ境界
- **単一ページ入口とフロントエンドバンドルゲート（`MINI_APP_REJECT_HTML_PATH` / `MINI_APP_PAGE_GATE_COOKIE_NAME`）**：
  - 単一ページルート（`/`、`/index.html`、およびサブパスエイリアス）とバンドルチャンク（`/chunk-*` 等、`MINI_APP_BUNDLE_ASSET_ROUTE_PATTERN`）は `packages/mini-app-api-server/auth/pageGate.ts` で保護されます。
  - **未認可 SPA の隔離**：有効なスーパー管理者 `initData` ヘッダーまたは `MINI_APP_PAGE_GATE_COOKIE_NAME` ゲート Cookie（`HttpOnly; SameSite=Lax`、有効期間 45 分の `MINI_APP_PAGE_GATE_COOKIE_MAX_AGE_SECONDS`）がない場合、あるいは 30 分間のパスワードロック中は SPA バンドルを一切返さず、独立 `packages/mini-app-api-server/resource/reject.html` を返します（外部通信ゼロ。WebView 初回起動時はローカルから `initData` を抽出して `./api/auth/precheck` でゲート Cookie を取得後 1 回リロード）。
  - **バンドルチャンク保護**：未認可の `/chunk-*` 要求には `401`/`403` JSON を返し、ゲート通過後のチャンクには `MINI_APP_BUNDLE_CACHE_CONTROL`、`CDN-Cache-Control: no-store`、`Vary`（`MINI_APP_BUNDLE_VARY_HEADER_VALUE`）を付与します。
- **スーパー管理者専用（`SUPER_ADMIN_USER_ID`）**：
  - 全業務 API は設定された唯一のスーパー管理者専用です。各リクエストは静的ポリシー（`MiniAppAuthPolicy`）に基づく同期認証パイプライン（`authorizeMiniAppRequest`）で、`headerGuard`（同一オリジン・資格情報ヘッダー形式の高速検査）に続き Telegram WebApp `initData` の HMAC-SHA256 署名検証・45 分間の鮮度検査・`user.id === SUPER_ADMIN_USER_ID` 照合を通過します。
  - `GET /api/auth/precheck`、`POST /api/auth/login`、`POST /api/auth/logout` 以外のすべての業務 API は、有効な 45 分セッショントークン（`X-Mini-App-Session`）も必須とします。
  - **自動ローテーション更新**：有効なセッショントークンの発行から 5 分（`MINI_APP_SESSION_REFRESH_THRESHOLD_MS`）が経過していると、サーバーは新トークンを発行して期限を 45 分（`MINI_APP_SESSION_TTL_MS`）延長し、`X-Mini-App-Session`・`X-Mini-App-Session-Expires-At` ヘッダー（および `/api/auth/precheck` ボディ）で返却しつつ静的な `initData.auth_date` を継続許可します。旧トークンも並行リクエスト向けに 5 分間有効で、保持上限 `MINI_APP_SESSION_MAX`（8）件を超えると最古の枠を破棄します。
- **初回画面の資格情報とロック保護**：認証器未バインド時は `mini_app.password`、Google Authenticator (TOTP) バインド後（`memory/mini-app-totp/totp.json`）は現在の 30 秒ステップの 6 桁コードを優先検証します。3 回連続誤入力でスーパー管理者 ID を 30 分間ロックし、全セッションとゲート Cookie を消去して解除時刻・送信元 IP 付きアラートを個人チャットへ 1 通送信します。
- **保護された画像庫プレビューアセット**：`GET|HEAD /api/gallery/file/:fileName` はログイン／セッション再開時のみ発行される決定論的 `assetToken`（7 日間不変キャッシュ＋`ETag` `304` 再検証対応）、またはスーパー管理者 `initData` と有効な 45 分 `session` トークンのペアで認証されます。

### 2. HTTP API ルートと機能対応表

| ルート | メソッド | 権限と境界の説明 |
| :--- | :---: | :--- |
| `/`<br>`/index.html`<br>`/favicon.ico`<br>`/healthz` | `GET`/`HEAD` | `/`・`/index.html` はスーパー管理者ゲートを検証（認可時はオンデマンド実体化した SPA HTML、未認可・ロック時は独立 `reject.html`）。`/chunk-*` もゲート検証のうえプライベート再検証キャッシュで返却。`/favicon.ico` は静的アイコン、`/healthz` は死活監視 `{ ok: true }` |
| `/api/auth/precheck`<br>`/api/auth/login`<br>`/api/auth/logout` | `GET`<br>`POST`<br>`POST` | `initData` 署名とスーパー管理者 ID を検証し、ログイン方式（`password`/`totp`）返却、有効セッションの再開・自動更新（5 分経過時）、または 45 分 `sessionToken`・`assetToken` の新規発行を行う（成功時は `MINI_APP_PAGE_GATE_COOKIE_NAME` も発行・更新し、拒否・ロック時は消去）。`logout` はトークン更新なしで該当セッションを失効（既失効でも成功） |
| `/api/totp`<br>`/api/totp/setup`<br>`/api/totp/enable`<br>`/api/totp/delete` | `GET`/`DELETE`<br>`POST` | Google Authenticator の状態照会、バインド用シークレット・QR コード生成、6 桁コード検証による有効化、削除（有効化・置換・削除時は現在のセッション以外の全アクティブセッションを失効） |
| `/api/status`<br>`/api/mood`<br>`/api/mood/switch` | `GET`<br>`GET`<br>`POST` | リアルタイム指標（稼働時間、CPU 平均負荷、メモリ PSS、管理グループ数、アクティブセッション、AI モデル準備状態、Telegram 送信ゲート）の照会、および AI 気分の照会・手動再抽選 |
| `/api/chats`<br>`/api/chats/:chatId` | `GET` | `/init` 有効化済みグループ一覧、または単一グループ詳細（機能スイッチ、ホットメッセージ数、静寂／ロック残り時間、`botPermissions`、1–24 時間の重複排除済み参加人数 `joinedCountsByHour`、`/batch_kick` 状態）の照会 |
| `/api/chats/:chatId/messages` | `GET` | グループのメモリ内ホット 256 バッファの直近メッセージをページング・キーワード検索 |
| `/api/chats/:chatId/feature` | `POST` | グループ機能スイッチ（`init`、`aiChat`、`translation`、`adDetect`、`floodControl`、`antiRaid`、`proxySend`）を切替。`init` 無効化は `/init disable` と同順序で解体・消去し、`antiRaid` 無効化で解体失敗時は永続化済みのまま `ANTI_RAID_DISABLED_TEARDOWN_FAILED` を返し、`proxySend` は個人チャット `/send` と単一グループ排他を共有 |
| `/api/chats/:chatId/batch-kick` | `POST` | スーパーグループ確認済みチャットで `1..24` 時間枠の `/batch_kick` を起動（`chatIsSupergroupById` 優先、未記録時は `getChat` で探査。通常グループは `notSupergroup`、探査失敗は `unavailable` で拒否）。`batchKickChats`・`batchKickInFlightSeqByChat`・バックグラウンド実行器を `/batch_kick` と共有し、完了集計を `miniAppBatchKickCompletedByChat` に記録（データ消去 teardown で削除、`lostAuthority` では保持） |
| `/api/chats/:chatId/targets` | `GET`<br>`POST` | グループ別のカスタム QA（`setQa`/`removeQa`）、発言削除対象（`addDeleteTarget`/`removeDeleteTarget`）、翻訳対象（`addTranslateTarget`/`removeTranslateTarget`）の照会・追加・更新・削除 |
| `/api/identities/whitelist`<br>`/api/identities/permission`<br>`/api/identities/blocklist` | `GET`/`POST`<br>`POST`<br>`GET`/`POST` | `readIdentityPolicyEntries` コールドリードでホワイトリスト／ブラックリストをページ／カーソル（`page`/`pageSize` または `afterId`/`limit`）単位で取得し名前・ユーザー名・ID（`query`/`q`）で検索（未 ACK 書き込みを重ね合わせ、ホット LRU を汚染せず `senderIdentity` キャッシュと表示メタデータを双方向同期）、追加・削除、個別権限変更および一括全付与（`enableAll`） |
| `/api/picker/prepare`<br>`/api/picker/result` | `POST`<br>`GET` | `savePreparedKeyboardButton` でネイティブ連絡先／チャンネルピッカーを準備し、`users_shared`/`chat_shared` の結果をポーリング（`whitelist`、`blocklist`、`deleteMessage`、`translate` 対応。グループ別の `deleteMessage`・`translate` は `/init` 未有効化なら `CHAT_NOT_INITIALIZED`） |
| `/api/gallery`<br>`/api/gallery/upload`<br>`/api/gallery/delete`<br>`/api/gallery/file/:fileName`<br>`/api/gallery/download/:fileName` | `GET`<br>`POST`<br>`POST`<br>`DELETE`<br>`GET`/`HEAD` | 専用画像庫のページング閲覧、生バイナリ画像のアップロード収録（`/h_image add` と同一の SHA-256 重複排除・解像度事前検査）、削除および原画ダウンロード |

### 3. リストおよびグループ対象操作の競合・境界ガード
- **ホワイトリスト／ブラックリスト追加ガード（ID 指定とネイティブピッカーで共通）**：
  - **厳格な相互排他**：ブラックリスト登録済み身分をホワイトリストへ追加すると `IDENTITY_IN_BLOCKLIST`、ホワイトリスト登録済み身分をブラックリストへ追加すると `IDENTITY_IN_WHITELIST` を返します。
  - **スーパー管理者の恒久免除**：`SUPER_ADMIN_USER_ID` のホワイトリスト追加は `SUPER_ADMIN_EXEMPT`、ブラックリスト追加は `BLOCKLIST_SUPER_ADMIN_FORBIDDEN` を返します。
  - **自己および管理対象グループの拒否**：Bot 自身（`TARGET_SELF_FORBIDDEN`）や `/init` 有効化済みの管理対象グループ（`TARGET_CURRENT_CHAT_FORBIDDEN`）の追加は拒否されます。
  - **ピッカー拒否理由の透過**：ネイティブピッカー取り込み（`handleMiniAppSharedMessage`）で新規追加が 0 件かつ重複以外の拒否がある場合、最初の具体的な境界ステータスコードと拒否対象 ID を返し、UI 側で個別警告を表示します。
- **グループ別カスタム QA・発言削除対象・翻訳対象ガード**：
  - **カスタム QA（`qa`）**：非空かつ `CHAT_QA_QUESTION_MAX_CHARS`・`CHAT_QA_ANSWER_MAX_CHARS`・`CHAT_QA_MAX_PER_CHAT` 以内で、質問全文および回答の `pre` コードフェンス外にクリック可能な `/command` を含めることはできません。
  - **発言削除対象（`deleteMessage`）**：Bot のメッセージ削除権限（`canDeleteMessages`、不足時は `DELETE_TARGET_MISSING_BOT_PERMISSION`）を要求し、スーパー管理者（`DELETE_TARGET_SUPER_ADMIN_FORBIDDEN`）・Bot 自身（`TARGET_SELF_FORBIDDEN`）・当該グループ自身（`TARGET_CURRENT_CHAT_FORBIDDEN`）を拒否、正の整数ユーザーかつオンライン時は在籍確認（不在時は `TARGET_NOT_IN_CHAT`）を行い、上限は `DELETE_MESSAGE_CHAT_TARGET_MAX`。
  - **翻訳対象（`translate`）**：`g-auth.json` の準備完了とグループの翻訳有効化（`TRANSLATE_FEATURE_DISABLED`）を要求し、言語は `ja`/`cn`/`en`/`uk`/`ru` に限定。Bot 自身・当該グループ自身を拒否し、オンライン時は在籍確認を行い、上限は `TRANSLATE_CHAT_USER_LIMIT`（既存対象への再指定時は言語を直接更新）。

---

<div align="center">

[← 前のページ：08 画像ライブラリと定時タスク](08-images-and-cron.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#09-コマンドと挙動リファレンス) · [次のページ：10 Mini App の設定方法と推奨構成 →](10-mini-app.md)

</div>

# 06 よくある変更手順

<p align="center">
  <a href="../cn/06-modification-guide.md">简体中文</a> · <a href="../en/06-modification-guide.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 開発者ドキュメント TOP</a> · <a href="05-dev-workflow.md">← 前のページ：05 開発フロー</a> · <a href="07-operations.md">次のページ：07 運用マニュアル →</a>
</p>

---

このページでは、開発で頻繁に発生する変更シナリオごとに対象ファイルと標準手順をまとめます。

> [!IMPORTANT]
> **開発時の共通原則**：
> - 着手前に必ず [`AGENTS.md`](../../AGENTS.md) を読み、プロジェクト規約と安全境界を確認してください。
> - 本番設定や稼働データを変更する前、または本番パスへ書き込む可能性があるエントリポイントを実行する前には、必ずワークツリー外へバックアップを取得してください（通常のコード変更や隔離された一時データルート上のテストでは不要です）。
> - コミット前に `bun run lint && bun run typecheck`（または `bun run check`）を実行し、`master` マージ前には `bun run check` の全項目合格を確認してください。ドキュメント・README・各種指標は明示的な指示がある場合にのみ更新します。

---

## 並行 batch の追加

非同期タスクを並行実行する際は、以下の信頼性ルールに従います：

- **エラーの握りつぶし禁止**：件数が固定で互いに独立した非同期処理は `Promise.allSettled` で待機し、`rejected` となった結果を 1 件ずつ明示的に処理します（空の `catch` や settlement 結果の無視は厳禁です）。
- **動的バッチの並行数制限**：外部入力に応じて件数が変わる場合は `Promise.all(list.map(...))` で一斉起動せず、[`runBoundedSettledBatch`](../../packages/libs/boundedSettledBatch.ts) で並行数上限を設けた上で、戻り値の `item` / `index` から失敗項目を特定します。
- **リトライ責務の単一化**：`runBoundedSettledBatch` は各要素を 1 回だけ実行し、自動リトライしません。一時的な通信エラー等を確実に判別できる場合に限り、その責務を持つ層で有限回数のバックオフリトライを行います（複数レイヤーでの多重リトライや非冪等な副作用の再試行は厳禁です）。
- **Drain 待機**：停止・クリーンアップ時に登録済みタスクの完了を待つ場合、各タスクが自身の例外を隔離し新規タスクを派生させない限り、スナップショットの完了待機だけで十分であり追加のタスクプールは不要です。

---

## スラッシュコマンドの追加

標準的なスラッシュコマンド（例：`/my_cmd`）は以下の順序で実装します：

1. **ハンドラーの実装**：
   - `packages/commands/` 配下にモジュールを作成し、明示的な戻り値型を持つ `handleXxxCommand` をエクスポートします。
   - **権限検証**：機能別権限が必要なコマンドには `rejectUnlessPermitted(ctx, key, rejection)`、スーパー管理者専用コマンドには `rejectUnlessSuperAdmin(ctx, rejection)` を使用します（`commands/commandActor.ts` 参照）。
   - **スタイル別文言**：返信文言は `packages/consts/atmosphere/{teasing,plain}/` の対応ドメインファイルに同一インターフェースで定義し、メインスレッドで `chatAtmosphere()` から取得します。
   - **コマンド応答**：トリガーメッセージへのプレーンテキスト返信（使い方、権限拒否、失敗、実行結果）には `replyCommandNotice(ctx, text)`（`infra/telegram/commandMessages.ts`）を使用し、`sendCommandMessage` の自動削除タイマー（`packages/consts/commands.ts` の `COMMAND_MESSAGE_AUTO_DELETE_MS`）とフォーラムトピック補完を継承します。リッチ書式・長期保持・update スコープ外での送信が必要な場合は `sendCommandMessage` を直接呼び出します。
2. **モジュールのエクスポート**：`packages/commands/index.ts` から新しいハンドラーを再エクスポートします。
3. **ルートの登録**：
   - [`packages/app/registerHandlers.ts`](../../packages/app/registerHandlers.ts) の `commands` サブチェーンに `commands.command("xxx", ...)` を登録します。
   - **ルート `bot` インスタンスへの直接登録は厳禁**：`:entities:bot_command` ゲート配下の専用 Composer に登録することで、`/init` ゲート・プライベートチャット遮断・身元プリフェッチ・入室認証・gag 制限・`/qa` フォーム捕捉の後段で安全に実行されます。
4. **プライベートチャット許可設定**：DM でも実行可能にする場合のみ、[`packages/infra/updateGate.ts`](../../packages/infra/updateGate.ts) のホワイトリストを更新します（既定では `/send` のみ許可）。グループ専用コマンドは変更不要です。
5. **コマンドメニューの更新**：`packages/consts/atmosphere/{teasing,plain}/commands.ts` 両方の `BOT_COMMANDS` にコマンド説明を追加します。
6. **定数の切り出し**：クールダウンや閾値は `packages/consts/commands.ts` または `packages/consts/<domain>.ts` に中国語 JSDoc 付きで定義します。
7. **単体テストの追加**：`test/commands/xxx.test.ts` で権限拒否、引数境界、正常実行パスを網羅します。
8. **コマンド一覧ドキュメントの同期**：`docs/{cn,en,ja}/09-commands.md` の一覧表にコマンドと必要権限を追記します。

### 非 ASCII のコマンド名

Telegram は ASCII 文字始まりのコマンドにのみ `bot_command` エンティティを付与します。`/咬` や `/贴贴` などの漢字アクションコマンド（`CJK_ACTION_COMMAND_PATTERN`）は、[`cjkAction.ts`](../../packages/commands/cjkAction.ts) の専用パイプラインで処理します：

- **`bot.hears` で本文マッチ**：`bot.command` では捕捉できないため、通常メッセージ処理の手前にある `cjkActions` サブ Composer 上で `hears(正規表現, ...)`（`^\/` 始まり、`CJK_ACTION_COMMAND_PATTERN` 参照）として登録します。
- **対象解決と `next()` 委譲**：`resolveCommandTarget` で対象を解決し、アクション構文に合致しない場合は update を消費せず必ず `next()` で後続ミドルウェアへ渡します。
- **`message.text` のみ対象**：メディアの `caption` は対象外とし、即座に `next()` で通常パイプラインへ戻します。
- **前提チェックの明示実行**：`isBotOwnMessage`・`needsBotOwnMessageWait`・`waitForBotOwnMessage` で Bot 自身の発言を処理し、`updateCachedIdentity` で送信者のローカルキャッシュを更新します。
- **長期保持と自動削除の使い分け**：成立したアクション結果は `sendCommandMessage` に `preserveInGroup: true` とトリガートピックの `messageThreadId` を渡して長期保持します。対象検証エラーや `/x` の使い方案内は通常の `COMMAND_MESSAGE_AUTO_DELETE_MS` で自動削除します。
- **メニュー上の ASCII プレースホルダー**：Telegram メニューは ASCII 名のみ受付可能なため、メニューには `/x` を登録し、`handleCjkActionUsageCommand` で使い方を案内します。
- **スライディングウィンドウ制限**：連投を防ぐため、`libs/slidingWindowRateLimit.ts`（`CJK_ACTION_RATE_LIMIT_WINDOW_MS` / `CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW`）でインスタンス全体の呼び出し頻度を制限します。

---

## 応答にリンクや書式を付ける

Telegram のリッチテキスト送信は MarkdownV2 と Entities の排他的な 2 モードをサポートします（[`packages/infra/telegram/actions/messages.ts`](../../packages/infra/telegram/actions/messages.ts) の `SendMessageFormat` 参照）：

- **MarkdownV2 モード（定型・テンプレート文面に推奨）**：
  - `sendMessage` または `sendCommandMessage` に `parseMode: MARKDOWN_V2_PARSE_MODE` を渡します。
  - 本文の**すべての要素**を [`libs/telegramMarkdown.ts`](../../packages/libs/telegramMarkdown.ts) 経由で組み立てます（通常文字列は `escapeMarkdownV2`、太字・コードブロック・リンクは専用ビルダーを使用）。
  - 表示名や AI 出力を未エスケープのまま結合してはなりません。パース失敗時は送信エラーとして扱い、未エスケープのプレーンテキストへ暗黙フォールバックさせません。
  - 単体テストでは `test/helpers/markdownV2.ts` の参照パーサーで最終文字列の妥当性を検証します。
- **Entities 明示モード（精密なオフセット指定向け）**：
  - プレーンテキストを組み立てつつ、各エンティティの UTF-16 code unit 単位の `offset` と `length` を計算します。
  - サロゲートペア文字（絵文字など）は UTF-16 で 2 単位を占めます。また長さ 0 のエンティティは Telegram に拒否されるため指定できません。

---

## 別の言語にする：i18n はやらないので fork してください

Bot がグループ・DM に送信する固定文言とプロンプトはすべて簡体中国語で書かれており、`packages/consts/atmosphere/` にメスガキ風（`teasing`）と通常風（`plain`）の 2 系統を備えています。Mini App 管理コンソールは例外で、フロントエンドの 3 言語辞書（`packages/mini-app-frontend/i18n/`）は常にメスガキ風で固定され、`atmosphere` 設定には連動しません。

- 固定文言とフォーマッター関数はスタイル辞書に集約されており、Telegram entities のオフセットは描画後の文字列から算出されます。
- `/咬` などのアクションコマンドのトリガー語と返信テンプレートはスラッシュコマンド文言とは別に管理されています。
- AI ペルソナは既定で `packages/consts/aiChat/prompts/persona.ts` を使用し、プロジェクトルートに `prompt/persona.md` がある場合は再起動後にそちらが優先されます。
- `send_voice` ツールの説明文は既定で `agent.tts.bot_language` に応じた `VOICE_LANGUAGE_PROMPTS`（`packages/consts/aiChat/prompts/tools.ts`）を使用し、`prompt/voice_tool.md` がある場合は本文説明を上書きします。
- 動的な多言語切り替え（i18n）は設計上サポートしていません。他言語で運用する場合はリポジトリを fork し、定数・プロンプトファイルを直接書き換えてください。

---

## 動作パラメータの調整

業務パラメータはすべて `packages/consts/` に集約されており、挙動の調整でコアロジックを書き換える必要はほとんどありません：

| 調整対象 | 対象ファイル |
| :--- | :--- |
| AI トリガー確率、レート制限、並行スロット、キュー上限 | `packages/consts/aiChat/rateLimit.ts` |
| AI 会話メモリ件数、スナップショット周期、要約バックプレッシャー | `packages/consts/aiChat/memory.ts` |
| メディア解説文字数、解析並行スロット、LRU キャッシュ容量 | `packages/consts/aiChat/media.ts` |
| 画像生成クールダウン、バイト上限、参照画像枚数の上限 | `packages/consts/aiChat/imageGeneration.ts` |
| ムード減衰周期と切り替えクールダウン | `packages/consts/aiChat/mood.ts` |
| 1 ターンのツール上限、タイピング演出、誤字発生確率 | `packages/consts/aiChat/tools.ts` |
| 音声文字起こしの秒数 / サイズ上限とプレースホルダー文言 | `packages/consts/aiChat/voice.ts` |
| 音声合成の 1 ターン上限、セリフ / 口調文字数上限、日次クォータ | `packages/consts/aiChat/voiceMessage.ts` |
| AI リクエストタイムアウト、リトライ回数、温度、安全性設定 | `packages/consts/aiChat/gemini.ts`、`packages/consts/aiChat/openai.ts`、`packages/consts/aiChat/anthropic.ts` |
| **モデル名、プロバイダ選択、API キー、エンドポイント** | **コード定数ではありません**：`config/dynamic/agent.json` で機能別に設定 |
| OpenAI 互換画像プロトコルと出力解像度 | `config/dynamic/agent.json` の `agent.image.image_protocol` |
| 1 回の画像生成でモデルに渡す参照画像枚数 | `config/dynamic/agent.json` の `agent.image.max_reference_images` |
| 入室認証待機時間、連投検知閾値、ミュート延長方針 | `packages/consts/antiRaid/` |
| 復唱クールダウン、`/quiet` 時間範囲、漢字アクション頻度制限 | `packages/consts/commands.ts` |
| ランダム自発発言の発言者クールダウン | `packages/consts/auto.ts` |

**変更手順**：定数値を変更 → 対応する中国語 JSDoc を更新 → `bun run lint && bun run typecheck` を実行（ドキュメント更新の明示指示がある場合のみ README 等も同期）→ マージ前に `bun run check` を通過させます。

> [!WARNING]
> **永続化データと結びつく容量定数に注意**：
> `AI_MEMORY_HYDRATE_BUFFER_MAX` や `MAX_SUMMARY_ROUNDS` など永続スナップショットに関わる容量定数を縮小する場合は、[04 実行時の正式な不変条件](04-invariants.md#永続化) に従い、サービス停止中に SQLite トランザクションで既存レコードを整理してください。起動時バリデーションは新上限を超える既存スナップショットを即座に拒否します。

---

## provider の任意能力を追加する

モデルの各機能は最小責務のインターフェース（`AiTextProvider`、`AiSummaryProvider`、`AiMediaProvider`、`AiImageProvider`、`AiSpeechProvider`、`AiWebSearchProvider`、`AiStructuredTextProvider`）に分割され、`AiChatProvider` として合成されます：

1. **契約の宣言**：[`packages/types/aiChat/provider.ts`](../../packages/types/aiChat/provider.ts) の該当インターフェースにオプショナルメソッドとして宣言し、`this: void` を明記します。
2. **プロバイダ別の実装**：その機能をサポートするプロバイダにのみ実装を追加して `index.ts` からエクスポートし、非対応プロバイダでは `undefined` のままにします。
3. **能力プロパティによる分岐**：呼び出し側は `if (provider.someCapability) ...` のように能力の有無で判定し、`provider.name === "gemini"` のようなベンダー名ハードコードは行いません。
4. **欠落時の縮退方針**：
   - 縮退可能な機能（画像認識や音声文字起こし等）はテキストプレースホルダーへ置き換えてログを残し、同一ターン内で別ベンダーを横断呼び出ししません。
   - 縮退できない機能（TTS 未設定時など）は該当ツール自体をそのターンのツールセットから外します。
5. **ターン単位の動的ツール編成**：各会話ターン開始時にモデル能力と設定状態からツールセットを動的構築し、未対応・未設定のツールはスキーマ定義と実行器の両方を除外します。

---

## AI ツールの追加

1. **ツール名定数の宣言**：[`packages/consts/tools.ts`](../../packages/consts/tools.ts) にツール名定数を追加し、グループ内で可視副作用（発言・画像・スタンプ・リアクション・音声）を伴うツールは `ACTION_TOOL_NAMES` にも登録します。
2. **スキーマ定義**：読み取り専用の照会ツールは `TOOL_DECLARATIONS` に追加し、返信アクションツールは `packages/workers/aiChat/ai/tools/replyToolset/` に definition builder を作成します（中立な `AiToolDefinition` から各ベンダーの専用スキーマへ自動変換されます）。
3. **実行ロジックの実装**：`packages/workers/aiChat/ai/tools/` 配下に処理を実装し、Telegram 操作が必要な場合は Worker IPC 経由でメインスレッドへ委譲します。
4. **ディスパッチ接続**：照会ツールは `tools/index.ts` の `callTool`、アクションツールは `replyToolset/orchestrator.ts` のアセンブラおよび `execute` ディスパッチャーに接続します。
5. **アクション予算の適用**：可視副作用を持つツールは 1 返信あたりの総アクション予算（実行側ハード上限 `HARD_MAX_ACTIONS_PER_REPLY`）に従わせ、個別上限は明確なドメイン枠（`MAX_STICKERS_PER_REPLY`、`MAX_GENERATED_IMAGES_PER_REPLY`、`MAX_VOICES_PER_REPLY`）がある場合にのみ設けます。
6. **プロンプト説明の追加**：`packages/consts/aiChat/prompts/` に使い方の指針を追記し、メッセージ履歴を参照する場合は `transcript.ts` の書式を再利用します。
7. **テストとドキュメントの同期**：`test/aiChat/ai/` に単体テストを追加し、3 言語ドキュメントの説明を同期します。

---

## 汎用 JSON API 呼び出しの追加

1. [`packages/consts/httpFetch.ts`](../../packages/consts/httpFetch.ts) の `JSON_API_ALLOWED_ORIGINS` に接続先 `https://` オリジンを明示追加します（ワイルドカードや平文 `http://` は厳禁です）。
2. [`packages/infra/httpFetch.ts`](../../packages/infra/httpFetch.ts) の有界 JSON クライアント経由で呼び出します（リダイレクト無効、レスポンスサイズ上限・エラーログ切り詰め付き）。
3. オリジン拒否、リダイレクト遮断、サイズ上限超過、通信例外の単体テストを追加します。

---

## ペルソナまたは JSON 設定の変更

- **ペルソナプロンプト**：既定ペルソナは `packages/consts/aiChat/prompts/persona.ts` にあります。プロジェクトルートに `prompt/persona.md`（テンプレートは [`prompt_example/persona.md`](../../prompt_example/persona.md)）を配置して再起動すると上書きできます。通知トーンの優先順位は [01 環境構築](01-getting-started.md#telegram-identity-の設定) を参照してください。
- **ボイスツール説明文**：内蔵説明文は `packages/consts/aiChat/prompts/tools.ts` の `VOICE_LANGUAGE_PROMPTS`（中・英・日の 3 言語）にあります。プロジェクトルートに `prompt/voice_tool.md` を置くと再起動後に `send_voice` の本文説明全体が置き換わり、引数説明などは引き続き `bot_language` に従います（テンプレートは [`prompt_example/voice_tool.md`](../../prompt_example/voice_tool.md)）。
- **プロンプトサンプルの整合性検証**：配布物に含まれる `prompt_example/` は `test/config/promptExamples.test.ts` で `loadPromptFile` により検証されます。`prompt_example/voice_tool.md` 内のクォータ・1 ターン上限・文字数上限はコード定数と一致させ、言語も `config_example/dynamic/agent.json` の `bot_language` と揃える必要があります。
- **設定ファイルの 2 層構成**：開発時は Git 管理外の `config/` 配下のみを編集し、`config_example/` は参照テンプレートとして保ちます：
  - `config/dynamic/` は実行中のホットリロードに対応しています（`assets.json`、`ad_detect.json`、`agent.json`、`mood.json`、`stickers.json`、`cron.json`）。
  - `config/static/` は起動時読み込みのみで、反映にはプロセス再起動が必要です（`bot.json`、`g-auth.json`）。
- **リアクション絵文字と権限リスト**：AI が付与できる絵文字は `AI_REACTION_EMOJIS` で制限されます。ブラックリストおよび権限ポリシーの正本は SQLite であり、JSON ファイルでは管理しません。

---

## deployment JSON 設定の追加

1. `packages/consts/paths.ts` にパス定数を定義し、`packages/config/layout.ts` の 3 階層ディレクトリホワイトリスト（`STATIC_ALLOWED_NAMES` または `DYNAMIC_ALLOWED_NAMES`）にファイル名を登録した上で、`packages/config/<domain>.ts` に厳格なスキーマパーサー（必須 / 任意項目、値域検査、未知キーの拒否）を実装します。
2. `packages/config/readiness.ts` の `validateExistingDeploymentInputs` に起動時プリフライト検証を組み込みます（テスト isolate で既定スナップショットを adopt する場合は `test/preloadEnv.ts` / `test/preload.ts` も更新します）。
3. `config_example/static/` または `config_example/dynamic/` に機密値を含まないサンプル JSON を追加し、`config_example/README/` の 3 言語ガイドを更新します。サンプルにダミー認証情報や仮 ID が含まれ初回インストール時の自動コピーから除外すべき場合は、`scripts/install/runtime.sh` にスキップ分岐を追加します。
4. `config/dynamic/` 配下の設定であれば、`packages/config/reload.ts` と `packages/app/configReload.ts` にホットリロード読み込みと Worker スナップショット / readiness 更新処理を登録します。
5. 3 言語の `01-getting-started.md` に設定手順を追記します。

---

## 実行時 cache の追加

1. `packages/cache/<owner>/<domain>.ts` に配置し、先頭行を配置先と一致する `/** owner: <main|perThread|workers/<worker>>。...` で始めます（`bun run check:conventions` が検証）。可変シングルトンには `export let` ではなく `{ current: T | null }` holder を使用します。
2. すべてのエクスポートに中国語 JSDoc を付与し、格納・削除タイミング、容量上限、Worker クラッシュ後の再構築方法を明記します。
3. `Map`・`Set`・キューすべてに明示的な容量上限を設け、「有界・単一 owner・再構築可能」の原則を満たします。
4. 停止時のフラッシュ待機が必要なキャッシュは `packages/libs/flushBarrier.ts` に接続します。

---

## 永続化 schema の変更

> [!CAUTION]
> **重要原則**：本番コードには**旧フォーマットの後方互換分岐を一切残さず、実行時の暗黙マイグレーションも行いません**。現行スキーマと一致しない永続データが検出された場合、サービスは即座に起動を拒否します。

1. `packages/types/` のデータ構造と読み込み時の厳格バリデーションを同時に更新します。
2. テストを更新し、ローカルで `bun run test:fault-injection` を通過させます。
3. **稼働中のサービスを停止**し、`bot.lock` が解放されたことを確認します。
4. ワークツリー外にバックアップを取得した上で、`memory/global/state.json` などの対象ファイルをオフライン（手動またはコールドマイグレーション CLI）で新形式へ変換します。
5. 新バージョンを起動して起動検証を通過させます（失敗時はログのファイルパス・フィールドパスに従って修正します）。
6. supervisor の再起動監視間隔を少なくとも 2 周期観察し、異常再起動がないことを確認してから外部バックアップを削除します。

---

## SQLite table を追加する

実行時の自動テーブルマイグレーションは行わず、スキーマ不一致時は起動段階で即座に終了します：

1. `packages/database/schema/<domain>.ts` でテーブル定義を作成し、`packages/database/schema/storage.ts` から集約エクスポートします。
2. `packages/database/schema/migrations/000N_<name>.sql` を生成し、`packages/database/schema/migrations/meta/_journal.json` を更新します。
3. テスト用一時 DB にマイグレーションを適用し、`__drizzle_migrations` の `created_at` と `hash` を `packages/consts/identityStorage.ts` の `STORAGE_MIGRATION_LINEAGE` に転記して `IDENTITY_DATABASE_SCHEMA_VERSION` を `+1` します。
4. 停止時専用のコールドマイグレーションスクリプトを作成し、`scripts/migrations/active.ts` に最新の移行エッジ 1 本のみを登録して、置き換えられた旧エッジとそのテストを削除します。
5. マイグレーションスクリプト内では現行の本番型を流用せず、移行元バージョン固有の凍結スキーマでレコードをデコードします。
6. 双方向ハッシュ照合を通過した後にのみ完了マーカー `ready.json` を出力します。
7. 実行時の書き込みはすべて Disk I/O Worker の Write-Through トランザクション経由で行います。

---

## Worker 間 protocol の変更

スレッド間メッセージの型定義は `packages/types/` に集約されています。プロトコル変更時は以下の 3 箇所を同時に更新します：
1. `packages/types/` のメッセージペイロード型定義。
2. メインスレッド側の IPC 送信・待機プロキシ（`packages/infra/` または `packages/cache/main/`）。
3. 対象 Worker スレッド内の受信・ディスパッチ処理（`packages/workers/<domain>/`）。
リクエスト / レスポンス型通信では、メッセージ送信前の Waiter 登録・一括タイムアウト管理・Worker クラッシュ時の決定論的決済パターンを厳守してください。

---

<div align="center">

[← 前のページ：05 開発フロー](05-dev-workflow.md) · [📚 開発者ドキュメント TOP](content-table.md) · [⬆️ トップへ戻る](#06-よくある変更手順) · [次のページ：07 運用マニュアル →](07-operations.md)

</div>

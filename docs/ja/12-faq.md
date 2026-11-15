# 12 よくある質問

<p align="center">
  <a href="../cn/12-faq.md">简体中文</a> · <a href="../en/12-faq.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 ドキュメントホーム</a> · <a href="11-performance.md">← 前のページ：11 パフォーマンスベンチマーク</a> · <b>次のページ：なし →</b>
</p>

---

Bot プロセスは稼働しているのにグループ内で期待どおりに応答しない場合は、以下のチェックリストを順に確認してください。BotFather の必須スイッチや各機能に必要なグループ管理者権限は [README](../../README.md#botfather-setup) を参照してください。

## Bot は動いているのに、なぜ返答がないのか？

<table width="100%">
<thead>
  <tr>
    <th width="28%" align="left">よくある症状</th>
    <th width="72%" align="left">確認ポイントと切り分け手順</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>❌ <b>グループで一切反応がない</b></nobr></td>
    <td>
      • <b>未初期化</b>：スーパー管理者がそのグループでまだ <code>/init enable</code> を実行していません。<br>
      • <b>Group Privacy による遮断</b>：Bot にグループ管理者権限がなく、かつ @BotFather で Group Privacy が有効なままです（<code>/setprivacy → Disable</code> で無効化）。<i>注：BotFather で変更した後は、Bot を一度グループから退出させて再追加しないと反映されません。</i>
    </td>
  </tr>
  <tr>
    <td><nobr>🤖 <b>AI 雑談が応答しない</b></nobr></td>
    <td>
      • <b>機能スイッチがオフ</b>：グループ内で <code>/ai_chat enable</code> を実行してください（既定では無効）。<br>
      • <b>必須設定の不足</b>：<code>agent.json</code> の <code>text</code>・<code>summary</code>・<code>media</code> の 3 項目に加え、<code>stickers.json</code> と <code>mood.json</code> が揃っている必要があります（1 つでも欠けると AI 雑談は無効化されます）。<br>
      • <b>トリガー確率の仕様</b>：100% 反応するのは Bot への返信または <code>@Bot</code> メンション時のみで、通常の発言には確率的にのみ割り込みます（<code>/quiet</code> 静寂中は割り込みません）。<br>
      • <b>Copy モードとの排他</b>：グループで <code>/copy</code> 復唱が動作している間は、AI 雑談と自発的な割り込みが一時停止します。<br>
      • <b>レート制限と <code>abuse_mark</code> クールダウン</b>：短時間に集中して呼び出すとスライディングウィンドウ制限（<code>RATE_LIMIT_LONG_WINDOW_MS</code>、<code>RATE_LIMIT_LONG_MAX_TRIGGERS</code>）にかかります。また、規約違反の生成要求やモデルへの罵倒・侮辱などを繰り返して <code>abuse_mark</code> が付与されたユーザーは、<code>ABUSE_MARK_DURATION_MS</code> の間 AI 雑談の対象外になります。
    </td>
  </tr>
  <tr>
    <td><nobr>📨 <b>個別チャットで反応がない</b></nobr></td>
    <td>
      • 個人チャットでは<b>スーパー管理者の <code>/send</code> 中継コマンドのみ</b>に応答し（<code>mini_app</code> 設定時は左下に <code>App</code> ボタンを表示）、その他のコマンドや通常メッセージはすべて無視します。
    </td>
  </tr>
  <tr>
    <td><nobr>⏱️ <b>通知が表示後すぐに消える</b></nobr></td>
    <td>
      • <b>仕様どおりの動作です</b>：コマンド検証エラー、権限拒否、使い方案内、操作完了通知はチャットの視認性を保つため送信成功から <code>COMMAND_MESSAGE_AUTO_DELETE_MS</code> 経過後に自動削除されます（長期保持される例外は <a href="09-commands.md#パラメータと対象のマッチング規約">09 コマンドリファレンス</a> を参照）。
    </td>
  </tr>
  <tr>
    <td><nobr>🎲 <b><code>@Bot</code> で運勢が出ない</b></nobr></td>
    <td>
      • @BotFather で Inline Mode が有効化されていません（<code>/setinline</code> で有効化してください）。
    </td>
  </tr>
  <tr>
    <td><nobr>🫧 <b>アクションコマンドが動かない</b></nobr></td>
    <td>
      • 認識されるのは <code>CJK_ACTION_COMMAND_PATTERN</code> に一致する中国語アクション語のみで、インスタンス全体のスライディングウィンドウ制限（<code>CJK_ACTION_RATE_LIMIT_WINDOW_MS</code> ごとに最大 <code>CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW</code> 回）を超えた呼び出しは静かに破棄されます。
    </td>
  </tr>
  <tr>
    <td><nobr>🌐 <b>他の Bot が翻訳・復唱されない</b></nobr></td>
    <td>
      • @BotFather で本 Bot の <b>Bot-to-Bot Communication Mode</b> を有効化する必要があります。<br>
      • 他 Bot のメッセージにはグローバル入口制限があり、同一 Bot が <code>BOT_MESSAGE_ACTIVITY_LIMIT</code> 件を超えて連続発言すると一時無視され、<code>BOT_MESSAGE_ACTIVITY_TTL_MS</code> 無発言でリセットされます（追跡数が <code>BOT_MESSAGE_ACTIVITY_MAX_ENTRIES</code> に達している間は新規 Bot も保留）。ただし本グループの <code>/delete_message</code> 対象はカウントされず全件削除されます（詳細は <a href="04-invariants.md">04 実行時の不変条件</a> を参照）。<br>
      • 翻訳は本文とキャプションのみを対象とし、キャプションなしメディア・数字記号のみ・すでに翻訳先言語のメッセージは送信しません。
    </td>
  </tr>
  <tr>
    <td><nobr>🛡️ <b>認証 / 広告 / 連投が無反応</b></nobr></td>
    <td>
      • <b>既定ではオフ</b>：グループ内で <code>/antiraid enable</code>、<code>/ad_detect enable</code>、<code>/flood_control enable</code> を個別に有効化してください。<br>
      • <b>Bot の管理者権限不足</b>：Bot に「メッセージの削除」および「ユーザーのBAN／制限」権限を持つグループ管理者権限が必要です。<br>
      • <b>広告検出設定の未準備</b>：広告検出には <code>config/dynamic/agent.json</code> の <code>agent.ad_detect</code> と有効な <code>config/dynamic/ad_detect.json</code> の両方が必要です。
    </td>
  </tr>
  <tr>
    <td><nobr>💀 <b>プロセス停止、メニューも出ない</b></nobr></td>
    <td>
      • <b>サービス状態の確認</b>：<code>systemctl status &lt;サービス名&gt;</code> で稼働状態を確認してください。<br>
      • <b>Fail-Fast 起動エラーの確認</b>：データルート配下の <code>logs/&lt;日付&gt;.json</code> を確認してください。設定や永続化状態に不備があると起動時に非ゼロ終了し、該当ファイルとフィールドパスが出力されます。<br>
      • <b>トークン競合（HTTP 409）</b>：409 Conflict が記録されている場合は、同じ Bot Token で別プロセスがポーリング中か、Webhook が残っています（対処手順は <a href="07-operations.md#起動失敗の調査">07 運用とトラブルシューティング</a> を参照）。
    </td>
  </tr>
</tbody>
</table>

---

## 通知の口調を切り替えるには？

- **明示的な設定**：`config/static/bot.json` の `atmosphere` に `"mesugaki"`（メスガキ風）または `"normal"`（控えめな通常風）を設定してサービスを再起動します。明示設定が常に最優先されます。
- **省略時の自動判定**：`atmosphere` を省略した場合、プロジェクトルートにカスタム `prompt/persona.md` が存在すれば `"normal"`、内蔵ペルソナ使用時は `DEFAULT_BOT_ATMOSPHERE`（`"mesugaki"`）になります。
- **影響範囲**：`atmosphere` が切り替えるのはシステム通知・コマンド応答・メニュー説明・定時アナウンス・ボタン文言・Inline おみくじのみで、AI 雑談の System Prompt ペルソナや Mini App コンソール画面（常にメスガキ風固定）は変わりません。

---

## 画像ライブラリが起動拒否される、または画像収集で重複排除されない原因は？

- **厳格なファイル命名規則**：専用画像ライブラリ（`assets.json` の `onlyPath.random_h_image_dir`）には、**画像バイナリの小文字 16 進 SHA-256 ハッシュ値**（`RANDOM_IMAGE_CONTENT_NAME_PATTERN`）＋対応拡張子（`RANDOM_IMAGE_EXTENSIONS`：`.jpg`、`.jpeg`、`.png`、`.webp`）で命名された通常ファイルのみを配置できます。
- **起動時の事前検査**：サブディレクトリ、シンボリックリンク、ドット始まりの隠しファイル・一時ファイル、または非ハッシュ名のファイルが 1 つでも存在すると起動時に即座に停止します。サービスを停止してバックアップを取ったうえで、[07 運用とトラブルシューティング](07-operations.md) に従って整理してください。
- **重複排除の仕組み**：`/h_image add`（および Mini App 画像庫アップロード）は画像データの SHA-256 を計算し、同一ハッシュが既存なら書き込みをスキップして「既存」として案内します。手動でファイルを配置する場合も、ファイル名が小文字 SHA-256 ハッシュと一致していなければ重複排除されません。

---

## 定時タスクが再起動後に再送信されるのはなぜか？

- **単発タスク（`just_once`）**：実行済み記録はメモリ上のみ（最大 `CRON_JUST_ONCE_RECORD_MAX` 件）に保持されるため、プロセス再起動後に再度スケジュールされます。実行済みの `just_once` タスクは `config/dynamic/cron.json` から削除してください。
- **ランダム時刻タスク（`rand_cron`）**：再起動時に指定ウィンドウ内で次回発火時刻が再抽選されます。停止中に過ぎた発火時刻の補填送信は行われません。
- **配列指定と相対パス解決**：固定画像の `url` または `path` は配列形式で指定する必要があります（詳細は [デプロイ設定説明](../../config_example/README/ja.md#cronjson) を参照）。`cron.json` 内の相対パスは実行時データルート基準で解決されるため、`./` 接頭辞は不要です。

---

## 定時音声や `/send` の音声が送信されない原因は？

定時タスクの `send_voice` とスーパー管理者個人チャット `/send` の音声代行は、いずれも `config/dynamic/agent.json` の `agent.tts` 設定を使用して AI Worker 上で非同期合成されます：

### ログ特徴による原因切り分け

<table width="100%">
<thead>
  <tr>
    <th width="35%" align="left">エラーログの特徴</th>
    <th width="65%" align="left">原因と対処方法</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><code>speech synthesis failed: worker unavailable</code></td>
    <td>AI Worker の初期化が完了していません（<code>stickers.json</code>、<code>mood.json</code>、<code>agent.json</code> の設定を確認してください）。</td>
  </tr>
  <tr>
    <td><code>tts unsupported</code></td>
    <td>指定したプロバイダが音声合成に未対応です（対応プロバイダは <code>google</code> と <code>openai</code> のみ）。</td>
  </tr>
  <tr>
    <td><code>synthesis failed</code> / <code>timed out</code></td>
    <td>上流 API のエラーまたはタイムアウトです。OpenAI 互換エンドポイントでは <code>audio/speech</code> と <code>opus</code> 出力への対応が必須です。</td>
  </tr>
  <tr>
    <td><code>not an Ogg Opus stream</code> / <code>not an MP3 stream</code></td>
    <td>返却された音声ストリームのコンテナ形式が指定プロトコルの要求形式と一致していません。</td>
  </tr>
  <tr>
    <td><code>daily limit reached</code></td>
    <td>現在の集計ウィンドウ（<code>TTS_USAGE_WINDOW_MS</code>）の音声合成クォータ上限に達しています。ウィンドウ満了後に自動リセットされます。</td>
  </tr>
</tbody>
</table>

### クォータと割り当ての仕組み

- 個人チャット `/send` と `cron.json` の `send_voice` は専用の予約枠 **`daily_reserve_quota`**（グローバル状態の `reserveCount`）を共有します。
- グループ内の AI 雑談は残りの **`daily_limit - daily_reserve_quota`**（`agentCount`）を独立して使用します。
- 両枠は完全に分離されており互いを圧迫しません。集計ウィンドウは最初のリクエスト時点で開始し、`TTS_USAGE_WINDOW_MS` 経過後の次のリクエストで新ウィンドウが開いてカウントがゼロに戻ります。

### 個人チャット `/send` のフォーマット要件

個人チャットで音声バブルを代行送信するには、**メッセージ全体を 1 つの JSON コードブロック**にし、`type` に `"tts"` を指定します：
```json
{ "type": "tts", "tone": "ツンデレ", "text": "合成するセリフ" }
```
コードブロックは JSONC（コメント・末尾カンマ許容）として解析されます。解析失敗時や `type !== "tts"` の場合は通常テキストとしてそのまま対象グループへ転送され、`type === "tts"` でフィールド形式が不正な場合は対象グループへ送らず個人チャットに形式エラーを返します。

---

## 音声の長さ・温度・記憶はどう設定するか？

| 呼び出し経路 | セリフ上限 (UTF-16) | 送信成功後の AI コンテキスト記憶 |
| :--- | :---: | :--- |
| **AI `send_voice` ツール** | `VOICE_TEXT_MAX_CHARS` | 記録される |
| **個人チャット `/send` TTS** | `VOICE_OPERATOR_TEXT_MAX_CHARS` | 記録されない |
| **定時タスク `send_voice`** | `VOICE_OPERATOR_TEXT_MAX_CHARS` | 記録されない |

- **口調とサイズ上限**：`tone`（口調）は空白正規化後の UTF-16 コード単位で `VOICE_TONE_MAX_CHARS` まで、合成音声データのバイナリサイズは `VOICE_SPEECH_MAX_BYTES` までです。
- **音色（`voice`）と基本スタイル（`style`）**：
  - 音色名は `agent.tts.voice` で指定します。
  - 基本声質スタイルは任意の `agent.tts.style` で指定し（ホットリロード対応）、省略時は内蔵の `TTS_DEFAULT_STYLE` が使われます。
  - リクエスト時は `<基本スタイル>; 细节: <口調>` の形で結合され、AI 返信時は両者の間に読み上げ言語指示が自動挿入されます。
  - `speech_protocol: "xai"` では `style` や口調の注入はサポートされません。
- **AI 返信のセリフ言語（`bot_language`）**：
  - AI `send_voice` のセリフ言語は任意の `agent.tts.bot_language`（`TTS_BOT_LANGUAGES`：`en` / `zh` / `ja`、省略時は `TTS_DEFAULT_BOT_LANGUAGE`、ホットリロード対応で次回返信から反映）で設定します。
  - `send_voice`・`send_message` のツール説明と System Prompt 内の重複抑止ルールを切り替え、AI 返信の音声合成時に `<基本スタイル>; <読み上げ言語指示>; 细节: <口調>`（`VOICE_LANGUAGE_PROMPTS` の `speechLanguageStyle`）を組み立てます。
  - `style` 自体の文字列や個人チャット `/send`・定時タスクのセリフ言語は変更しません。`xai` プロトコルの合成言語は `language` フィールドで決まります。
- **`bot_language` 変更時の推奨手順**：
  - `style` を対象言語で書かれた声質説明へ変更します（既定の `TTS_DEFAULT_STYLE` は日本語記述）。`style` は `/send` や定時タスクでも共有されるため声質の特徴のみを書き、タスク個別の言語指定が必要な場合は各タスクの `tone` に記述してください。発音が不自然な場合は対象言語向けの `voice` への変更を推奨します。
  - カスタム `prompt/voice_tool.md` を配置している場合は、ファイル内のセリフ例や口調例も対象言語に揃えてサービスを再起動してください。
  - `xai` プロトコルではスタイル注入がないため、`language` フィールドを直接変更します。
- **音声ツール説明のカスタマイズ**：プロジェクトルートに有効な非空 UTF-8 の `prompt/voice_tool.md` を置くと、再起動後に `send_voice` のツール説明全文を置き換えます（`bot_language` に依存せず置換され、`text`・`tone` 引数説明と重複ルールは引き続き `bot_language` に従います。ホットリロード非対応）。
- **サンプリング温度**：Gemini 音声合成の温度はコード定数 `GEMINI_SPEECH_TEMPERATURE` で固定されています。

---

## サードパーティゲートウェイ（Cloudflare AI Gateway 等）経由で Google モデルを呼び出すには？

1. **エンドポイントの変更**：対象能力の `base_url` をゲートウェイ URL に設定します（`install.sh` の対話ウィザードでも直接入力可能）：
   `https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/google-ai-studio`
2. **`api_key` の設定**：
   - **自前の Google API キーを使う場合**：`api_key` に Google AI Studio のキーを設定します（SDK が `x-goog-api-key` ヘッダーで送信）。追加ヘッダーは付与しないため、Cloudflare 側の Authenticated Gateway は無効にしてください。
   - **ゲートウェイ保管キー（BYOK / Unified Billing）を使う場合**：`api_key` に Cloudflare トークンを設定します。`api_key` はログ出力時に自動マスクされます。
3. **ルーティングと疎通確認**：テキスト・画像認識・画像生成は `generateContent`、音声合成は `Interactions API` を経由します。設定後は個人チャット `/send` からテスト音声を送信して疎通を確認できます。

---

## Cloudflare AI Gateway 経由で Anthropic モデルを呼び出すには？

`provider: "anthropic"` の能力（`text`、`summary`、`media`、`web_search`、`ad_detect`）の `base_url` に以下を設定します（`install.sh` の対話ウィザードでも入力可能）：
`https://gateway.ai.cloudflare.com/v1/<account_id>/<gateway_id>/anthropic`

1. **自前の Anthropic キーを使う場合**：`api_key` に Anthropic API キーを設定します（SDK が `Authorization: Bearer` で送信）。追加ヘッダーは送信しないため、Authenticated Gateway は無効にしてください。
2. **ゲートウェイ保管キー（BYOK / Unified Billing）を使う場合**：`api_key` に Cloudflare トークン `<CF_AIG_TOKEN>` を直接設定します。ゲートウェイが `Authorization` 内のトークンを認識して保管済み Anthropic キーまたは Unified Billing へ切り替えます（プレースホルダー文字列のままにすると Anthropic へそのまま転送され認証失敗になります）。

---

<div align="center">

[← 前のページ：11 パフォーマンスベンチマーク](11-performance.md) · [📚 ドキュメントホーム](content-table.md) · [⬆️ トップへ戻る](#12-よくある質問) · **次のページ：なし →**

</div>

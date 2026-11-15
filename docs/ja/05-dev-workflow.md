# 05 開発フローと品質ゲート

<p align="center">
  <a href="../cn/05-dev-workflow.md">简体中文</a> · <a href="../en/05-dev-workflow.md">English</a> · <b>日本語</b>
</p>

<p align="center">
  <a href="content-table.md">📚 開発者ドキュメント TOP</a> · <a href="04-invariants.md">← 前のページ：04 不変条件</a> · <a href="06-modification-guide.md">次のページ：06 変更レシピ →</a>
</p>

---

## コマンド早見表

| コマンド | 役割 | 説明 |
| :--- | :--- | :--- |
| `bun run start` | ロングポーリング起動 | 本番環境エントリポイント |
| `bun run lint`<br>`bun run lint:fix` | ESLint 検査 / 自動修正 | コード規約を厳格に検査。CI・品質ゲートでは常にキャッシュなしの `lint` を使用 |
| `bun run lint:fast` | ローカルキャッシュ付き ESLint | `--cache` 付き。ローカル開発の反復確認専用 |
| `bun run typecheck` | TypeScript 型検査 | `bun --check` で `tsconfig.json` の完全 strict 設定に従いプロジェクト全体を検査（増分キャッシュなし） |
| `bun run test` | 全量テスト | ファイル単位のコンテキスト分離を強制（`bun test --isolate`） |
| `bun run test:coverage` | テスト + カバレッジ | 全テストをランダム順（`--randomize`、サマリーに再現用 `--seed=` を出力）で実行し、全ソースコードのカバレッジを集計するとともにテスト間の状態残留・モック漏れを検知 |
| `bun run check:install-script-syntax` | インストーラー構文検査 | `bash -n` で `install.sh` と全シェルモジュールを静的解析（実処理は非実行） |
| `bun run check:install-isolation` | インストーラー隔離検証 | 専用一時ルートで `install.sh` フィクスチャを実行し、ロールバック、中断再開、バックアップ保持、認証情報隔離、サービス保護、起動監視を検証 |
| `bun run check:conventions` | プロジェクト規約自己検査 | `scripts/checkProjectConventions.ts` を実行し、定数、キャッシュ所有権、ドキュメントリンク、アーキテクチャ境界を検証 |
| `bun run check` | **全量統合ゲート** | 構文検査 + インストーラー隔離 + 規約検査 + lint + typecheck + ランダム順カバレッジテスト（閾値は `bunfig.toml` の `coverageThreshold`）+ ホットパスゲート（`master` マージ前必須） |
| `bun run check:coverage` | カバレッジ指標突合 | 3 言語の README・ドキュメント・SVG バッジの数値と実測値の一致を検証 |
| `bun run test:fault-injection` | 決定論的障害注入スイート | `scripts/testFaultInjection.ts` で `FAULT_INJECTION_TESTS` を実行し、プロセスクラッシュ、異常停止、DB 瞬断、Worker 再生成時の復元整合性を検証 |
| `bun run perf:hot-paths -- <シナリオ> [--profile]` | ホットパス独立プロセス測定 | `performance/` 配下の隔離データルートと設定コピー上で、単一ホットパスシナリオを `HOT_PATH_PROFILE_REPEATS` 回の独立プロセスで測定（`--profile` で CPU サンプリング出力）。`scripts/perf/hotPaths.ts` の直接実行はシナリオ読み込み前に拒否 |
| `bun run perf:hot-path-gate` | **ホットパス性能ゲート** | 厳選ホットパスシナリオのメモリ / GC / JIT ハードゲート（`check` に統合済み） |
| `bun run perf:join-log` | 入室ログ性能ベンチマーク | 入室ログの容量境界・スナップショット・追記記帳の独立プロセスベンチマーク |
| `bun run perf:identity-database` | ID データベースベンチマーク | SQLite のコールド / ホット読み書き、メインスレッド LRU 読み取り、ライトスルー経路の独立プロセスベンチマーク |
| `bun run perf:full` | 全量性能ベンチマークスイート | 全セクションを `FULL_SUITE_ROUNDS` ラウンドの独立子プロセスで実行（`--write-doc` で 3 言語の `11-performance.md` と `performance-result.json` を同時更新） |
| `bun run perf:review` | 専門性能再検証 | ホットパス、AI 返信 / ペイロード / 音声エンコード、完全コマンドチェーン、Disk I/O Worker 負荷を網羅 |
| `bun run build -- --version <tag>` | バイナリパッケージ構築 | プレフィックスなしのバージョン指定が必須。現在のプラットフォーム向け `dist/` アーカイブと `.sha256` を生成 |
| `bun run release:check -- --version <tag>` | リリース前全量自検 | frozen lockfile + `check` + カバレッジ突合 + 障害注入 + バイナリビルド検証 |
| `bun run release:build -- --version <tag>` | 正式リリースパッケージ構築 | クリーンな `dev` ブランチ上で現在のプラットフォーム向けバイナリをネイティブビルド（他プラットフォームは各実機環境で個別ビルド） |
| `bun run release:verify -- --version <tag> --platforms <一覧>` | 配布パッケージ検証 | 全対象プラットフォームのアーカイブ、SHA-256、バージョン、Git tree の一致を検証 |
| `bun run release:publish -- --version <tag> --platforms <一覧> --notes-file <ファイル>` | GitHub Release 公開 | リモート参照を検証し、下書き作成、資産アップロード・再検証を経て Latest として公開 |
| `bun run audit:release` | 依存関係セキュリティ監査 | 依存パッケージの脆弱性をスキャン（`moderate` 以上を検出） |

---

## 品質ゲートの基準

- **インストーラー起動の隔離**：
  - テストフィクスチャは独立した一時設定・データルートを使用し、システム管理コマンド、依存取得、外部ネットワーク送信をモック化した上で実際の `index.ts`、Worker スレッド、終了時永続化を実行します。
  - 各 Worker は Bun の `preload` でネットワークスタブを読み込み、東京の天気 API には固定応答を返し、それ以外の外部リクエストはすべて遮断します。
  - スタブの読み込み、ポーリング開始、`SIGTERM` 受信時の安全なドレイン、ロックファイル解放を順に検証します。
- **ファイル行数制限と走査対象（`MAX_SOURCE_LINES` / `MAX_FRONTEND_SOURCE_LINES`）**：
  - 手書きの TS / JS / CSS / HTML / シェルファイルが `scripts/conventions/fileLength.ts` の上限を超えるとゲートで即座に拒否されます（[`AGENTS.md`](../../AGENTS.md) 参照）。
  - バックエンドファイルは 512 行を超えた時点で分割を検討し、`MAX_SOURCE_LINES`（1024 行）を超える前に必ず分割します。`packages/mini-app-frontend/` 配下の `.tsx`・`.css` および `.html` ファイルの上限は `MAX_FRONTEND_SOURCE_LINES`（1536 行）です。
  - Git 追跡ファイルおよび未追跡の非除外ファイルが走査対象となり、`.gitignore` 対象のデプロイデータは除外されます。インストーラー構文検査は `install.sh` と `scripts/install/` 配下の全シェルモジュールを対象とします。
- **全ソースコードを分母とするカバレッジ計測**：
  - `test/productionModules.test.ts` が `index.ts` と `packages/types/` を除く `packages/` 配下の全ランタイムモジュールをロードするため、未実行のモジュールも 0% として分母に算入されます。
  - 関数カバレッジ・行カバレッジともに `bunfig.toml` の `coverageThreshold` を満たす必要があり、単体テストのない新規モジュール追加はカバレッジ不足に直結します。
- **ESLint + 完全 strict な型検査**：
  - `tsconfig.json` で `strict`、`noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters` を全面有効化しています。
  - 本番コードでの `any` は厳禁です（テストコードのみ免除）。`Promise.all` は ESLint（`no-restricted-syntax`）で禁止されており、`Promise.allSettled` と有界並行制御を使用します。JSX/TSX フラグメントは `react` の `<Fragment>` を明示的に使用し、`<>...</>` 省略記法は禁止です。
- **型 import の明示的分離**：
  - 本番コード・スクリプト・テストのすべてで独立した `import type` 文を強制し、`import { value, type Shape }` のような混在 import を ESLint で拒否します。
- **明示的な型注釈の強制**：
  - 本番コード（`index.ts`、`packages/`、`scripts/`）の変数・引数・分割代入には `@typescript-eslint/typedef`、関数・コールバックの戻り値には `@typescript-eslint/explicit-function-return-type` で明示的な型注釈を強制します。
  - `for...of` / `for...in` のループ変数と、完全な型注釈付きアロー関数で直接初期化する `const` は免除されます（テストコードも対象外）。
- **規約自己検査（`check:conventions`）**：
  - **構造とリンク**：
    - ファイル行数上限、ファイル配置、Markdown の相対リンクとページ内アンカーを検査します。
    - ドキュメント記載のディレクトリ内ファイル一覧およびインライン逆引用符のリポジトリパスの実在性、スクリプトの実行権限、`install.sh` のステップ番号整合性を検証します。
  - **境界とスレッド分離**：
    - 定数の配置とキャッシュのスレッド単一所有権境界（`packages/cache/<owner>/`）、および実モジュール依存グラフに基づく Worker・Telegram クライアント権限の隔離を検証します。
    - `process.env` の参照は `consts/paths.ts` と `consts/environment.ts` のみに限定します。
    - `consts/` は実行時に `consts` のみへ依存し（他モジュールからは `import type` のみ）、`packages/mini-app-frontend/consts/` も同じ定数規約のもと実行時は自身のみに依存します。
    - Mini App フロントエンド境界：`packages/mini-app-frontend/` 内の TS/TSX 指定子（`import type` を含む）および HTML/CSS の相対参照は同ディレクトリ外を参照できず、他の `packages/` モジュールや `index.ts` からもフロントエンドを参照できません（唯一の例外は `scripts/conventions/miniAppFrontend.ts` の `MINI_APP_FRONTEND_ENTRY_IMPORTS` に登録されたサーバー側 HTML エントリで、不要になった登録もエラー）。
    - `states/` の閉包境界：直接・間接の実行時依存は `consts`、`libs`、`types`、`states` に限定されます（唯一の例外は `STATES_CLOSURE_OPAQUE_MODULES` に登録された `config/time.ts`）。
    - `infra/` のレイヤー境界：実行時依存は `cache`、`config`、`consts`、`database`、`infra`、`libs`、`states`、`types`、`users`（`INFRA_ALLOWED_PREFIXES`、唯一の例外は `workers/diskIO/diagnosticSink.ts`）に限定され、業務レイヤーへの逆依存を禁止します。また全量ベンチマークの親プロセスは純粋定数と型のみを import できます。
  - **定数テーブルの制約**：
    - オブジェクト要素を持つエクスポート定数テーブル（正規表現・関数値を除く）は、`test/consts/immutability.test.ts` で `@ts-expect-error` 直後の行から参照して不変性を検証する必要があります（`scripts/conventions/constImmutability.ts`）。
    - リテラル union を要素とするエクスポート配列テーブルは `exhaustiveList<U>()([...])`（`packages/consts/exhaustiveList.ts`、フロントエンドは `packages/mini-app-frontend/consts/exhaustiveList.ts`）で記述し、`U` と要素リテラルを網羅させて型の増減時にコンパイルエラーで検知します。
    - 意図的に部分集合のみを列挙するテーブルは `scripts/conventions/constExhaustiveLists.ts` の `PARTIAL_LITERAL_TABLES` に `<相対パス>#<テーブル名>` で登録します（失効した登録もエラー）。
  - **安全な API 呼び出し**：
    - `packages/workers/` 配下の全タイマーは `.unref()` の呼び出しが必須です。
    - `packages/` 内では `Object.freeze` を禁止し、`.keys().next()`・`.values().next()`・`.entries().next()` による最古要素の取得も禁止します。有界 FIFO / LRU の最古要素は必ず `libs/fifoMap.ts` の `FifoMap`（または継承元の `LruCache`）経由で取得します。
    - Node 互換モジュールと `Buffer` はホワイトリスト登録箇所のみ許可され（未使用登録もエラー）、CLI 引数は `Bun.argv` で読み取り、実行時にベア import する外部パッケージはルート `package.json` への直接宣言が必須です。
  - **整合性突合**：
    - `index.ts`、`packages/`、`scripts/` のトップレベル関数・クラスメソッド・`*Params`/`*Options` プロパティの JSDoc（`@param` と `void`/`never` 以外の `@returns` を含む。`scripts/conventions/sourceRules.ts` の `collectFunctionJsDocProblems`）を静的検査します。
    - Telegram 通知の自動削除免除とトピック帰属、コールドマイグレーションスクリプトと `package.json` の `migrate:*` の 1 対 1 対応、障害注入スイート一覧、および 3 言語ドキュメントと `performance-result.json` のカバレッジ・性能数値を突合します。
    - コメント内の「`<モジュール>.ts` の `<シンボル>`」形式の相互参照を検査し、`./`・`../` 始まりは記述元基準で解決（ファイルまたはシンボル欠落時はエラー）、それ以外は対象ファイルが一意に定まる場合に検証します。
  - **テストアサーション規約**：
    - テスト内で import した大文字定数をリテラルと直接比較すること、および `packages/consts` の文字列定数（`STRING_CONSTANT_MIN_LENGTH` 文字以上）や CJK 文言断片（`CONSTANT_TEXT_FRAGMENT_MIN_CJK` 文字以上）を matcher に直書きすることを禁止します（定数を直接参照するか `test/helpers/templateText.ts` を使用）。
    - プロンプト文言の契約テストは `scripts/conventions/testAssertionFragments.ts` の `CONSTANT_TEXT_CONTRACT_EXEMPTIONS` に明示登録します。
  - **テストダブルのリセット**：
    - いずれかのテストで `mockReturnValueOnce` / `mockResolvedValueOnce` / `mockRejectedValueOnce` / `mockImplementationOnce` を積んだモックは、ライフサイクルフック（`beforeEach` / `afterEach` / `beforeAll` / `afterAll` および推移的に呼ばれるテスト補助関数）内で `mockClear()` ではなく `mockReset()` を呼んで既定実装を再設定する必要があります（`scripts/conventions/testMockReset.ts`）。
    - `test/` 配下のファイルトップレベル、`describe` 直下、`beforeAll` / `beforeEach`（推移的な補助関数を含む）で作った `spyOn` は、包含スコープのクリーンアップフックで復元する必要があります（トップレベル・`beforeAll` は `afterAll` または同一トップレベル同期位置、`beforeEach` は `afterEach` または `afterAll`、同一セットアップフック内での即時復元も可）。
    - 復元には `mockRestore()`、`mock.restore()`、`jest.restoreAllMocks()` を使用し、監視対象自体が共有モックの場合は実装消去を防ぐため後ろ 2 つのみ許可されます（`scripts/conventions/testSpyRestore.ts`）。両検査とも TypeScript 型チェッカーで宣言シンボルを解決し、テスト途中の履歴消去用 `mockClear()` は対象外とします。

---

### 依存関係のリリース待機期間

依存パッケージのインストールには、`bunfig.toml` の `install.minimumReleaseAge` で定義されたリリース待機期間が厳格に適用されます：
- **緊急セキュリティパッチの免除**：待機期間未満の緊急脆弱性修正を取り込む場合は、該当する単一パッケージ名のみを `install.minimumReleaseAgeExcludes` に一時追加し、インストール直後に削除します。`--minimum-release-age` フラグによる全体回避は禁止です。
- **セキュリティ検証要件**：免除対象のバージョンは少なくとも 2 つの独立した脆弱性情報源と照合し、npm registry の `integrity` ハッシュ一致、不正スクリプトや永続化バックドアの不在を確認した上で、パッケージ名・CVE 番号・削除時刻を記録します。
- **ランタイムバージョンの固定**：Bun ランタイムと `@types/bun` は `package.json` の宣言バージョンに厳密固定され、`packageManager` と `install.sh` の双方でロックされます。
- **TypeScript コンパイラ**：`bun run typecheck` は `bun --check` で Bun 内蔵型チェッカーを呼び出します（`bun check` はリポジトリの `check` スクリプトを実行）。ESLint と規約検査は `package.json` で `@typescript/typescript6` にエイリアスされた `typescript` の TypeScript 6 Compiler API を使用します。

---

### Bun の実行境界

- **実行モード**：`bunfig.toml` で `run.bun = true` を設定しており、Node.js 向け shebang を持つ依存 CLI もすべて Bun で直接実行されます。
- **画像コーデック**：Bun 内蔵の `Bun.Image` で画像をトランスコードします（`packages/infra/image.ts`）：
  - JPEG / PNG はそのまま通過し、WebP / GIF はアルファチャンネルを保持した PNG へ変換します。GIF は先頭フレーム、アニメーション WebP は先頭の `ANMF` フレームを静的 WebP に再構成してからデコードします。
  - 1 枚あたりの最大デコード画素数は `VISION_TRANSCODE_MAX_PIXELS`（超過時はメモリ確保前に拒否）で制限され、長辺が `VISION_TRANSCODE_MAX_EDGE` を超える画像はアスペクト比を保って縮小されます（小画像は拡大しません）。コーデックは Bun 本体に内蔵され、`node_modules` のネイティブ C/C++ アドオンに依存しません。
- **ネイティブファイル I/O**：
  - 読み書き・削除には `Bun.write` と `Bun.file` を優先し、非同期メタデータ取得には `Bun.file().stat()`、通常ファイルの存在確認には `Bun.file().exists()` を使用します。
  - アトミック書き込み（`atomicWriteText`）は `Bun.write(Bun.file(handle.fd), content)` と `fsync`・アトミック `rename` を組み合わせます。
  - ディレクトリ存在確認（ディレクトリに対する `Bun.file().exists()` は常に `false`）、欠落許容削除（`force: true`。`Bun.file().delete()` は欠落時に `ENOENT` を送出）、同期ファイル I/O、ディレクトリ走査、パス操作、ハードリンク作成など Bun ネイティブ未対応の操作には `node:` モジュールを使用します。
- **性能ベンチマークの再校正**：Bun ランタイムを更新した際は、同一の Bun バージョンとコミット上で全ベンチマークを再測定します。

---

### このドキュメント版の実測値

`bun run test:coverage`：**7200 tests / 605 files / 463493 `expect()` calls**。全ソースコードの**関数カバレッジは 96.85%、行カバレッジは 97.58%**です。3 言語の各プロジェクト README の Coverage badge は行カバレッジを表示します。

---

## テスト分離

すべてのテストは `bun run test`（内部で `bun test --isolate` を実行）経由で走り、以下の自動隔離が適用されます：

1. **ファイルコンテキスト分離**：テストファイルごとに独立したグローバル環境が作られ、`mock.module` やモジュールスコープ変数が他ファイルへ漏洩しません。
2. **専用一時データルートの注入**：
   - 本番モジュールのロード前に、`test/preloadEnv.ts` がプロセス専用の一時データルート（`mkdtempSync`）を `COPY_NINJIA_DATA_ROOT` に設定し、テスト専用の `TMPDIR` も別途作成します（`os.tmpdir()` 経由の一時ファイルもその中に隔離されます）。
   - `/dev/shm` が `tmpfs` かつ空き容量が `TMPFS_MIN_AVAILABLE_BYTES` 以上ある場合は両方とも `/dev/shm` 配下に、それ以外は元の `os.tmpdir()` 配下に作成されます。
   - 本番パス（`memory/`、`logs/`、`database/`、`bot.lock`）には一切触れず、テスト終了時に両方の一時ツリーを削除して `TMPDIR` を復元します。
3. **独立した設定ルート**：`config_example/static/` と `config_example/dynamic/` を一時ルート内の `config/static/`・`config/dynamic/` に複製して `COPY_NINJIA_CONFIG_ROOT` で参照させます。プレースホルダー鍵は安全なダミー認証情報に置換され、`g-auth.json` は除外、`cron.json` は空スケジュールで初期化されます。
4. **設定スナップショット同期と空データベース**：`test/preload.ts` がテスト用コピーの `agent.json`、`ad_detect.json`、`mood.json`、`stickers.json`、`cron.json`、Bot の通知トーン、組み込みペルソナを各 isolate の holder に一括ロードし、タイムゾーンマーカー付きの空 SQLite データベースを作成して各機能の readiness を有効化します。

### 主要テストスイートの分布

- **インストール・更新テスト**：`test/scripts/installStartup.test.ts` と `test/scripts/installMigration.test.ts` が、インストーラー、新規 DB 初期化、起動シーケンス、および旧形式の設定・DB・`/wed` メンバーファイル検出時の無改変での事前拒否を検証します。
- **コールドマイグレーションテスト**：`test/scripts/migrateWedMemberWindow.test.ts` が、17.2.1 の `memory/wed` メンバー ID 配列のみを受け付け、末尾 `WED_MEMBER_LIMIT` 件を順序どおり同一 `enteredAt` の `{ id, enteredAt }` ウィンドウへ変換して本番起動検証を通過すること、および移行済み・不正入力・シンボリックリンク・既存出力先をバックアップ無改変で拒否することを検証します。
- **メディア・外部送信ゲートテスト**：`test/aiChat/ai/mediaAdmission.test.ts`、`test/aiChat/ai/imageDescription.test.ts`、`test/infra/telegramWorkerCapabilities.test.ts` がマルチモーダル審査と Worker 双方向 Telegram ゲートを検証します。
- **統一送信統合テスト**：`test/infra/telegramOutboundIntegration.test.ts` が実クライアント初期化・送信スケジューラ・チャット別レーンを動かし、最内層の HTTP 応答のみをスタブ化してスレッド横断の同一チャット FIFO、種別別 429 バックオフ、ダウンロード流量制限、停止時ドレインを検証します。
- **セキュリティ・ログテスト**：`test/infra/loggerSecurity.test.ts` が各種例外展開時の機密トークン脱敏を検証します。

---

## 障害注入スイート

`bun run test:fault-injection` は、プロセスクラッシュ、異常停止、境界障害下での一貫性を検証します（完全な一覧は [`scripts/conventions/faultInjectionSuite.ts`](../../scripts/conventions/faultInjectionSuite.ts) の `FAULT_INJECTION_TESTS` に辞書順で 1 行 1 パス定義）：
- **ライフサイクルと復元境界**：アプリ・Worker のライフサイクル（段階別停止予算と全体デッドラインを含む）、グループロック復元、AI 返信容量上限とキャンセル、認証情報スナップショット、Telegram 送信・自動削除の停止時ドレイン、グループ teardown を網羅します。
- **データ永続化と整合性**：入室ログ未確認ミラーと処罰レシート、Anti-Raid タスクドレインと認証復旧、双方向 Worker 再生成時のキャンセル、SQLite 起動検証と停止時クローズ（残余書き込みコミットと WAL checkpoint）、コールドマイグレーション、Disk I/O Worker のアトミック書き込み障害復旧を検証します。
- **インタラクティブステートマシン**：`test/workers/antiRaid/verificationWelcome.test.ts`（双方向プロトコルと一時通知の自動削除）および `/wed` ステートマシン（管理上限 `STATE_MANAGED_CHAT_LIMIT`、待機キャンセル、アバター取得、停止時ドレイン）を検証します。

---

## ホットパスゲート

`bun run perf:hot-path-gate` は `bun run check` に組み込まれたハードゲートです。`packages/consts/performance.ts` の `HOT_PATH_PROFILE_SCENARIOS` ごとに、独立した 2 種類の子プロセスを `HOT_PATH_PROFILE_REPEATS` 回ずつ実行します：
- `steadyProfile`：`JSC_GC_LOG_ENV=1`（`BUN_JSC_logGC=1`）有効下で定常ループを回し、GC 停止時間比率と JIT コンパイル階層を測定します。
- `retained`：プロファイラー介入なしの環境で実 RSS ピーク、`heapUsed` ピーク、および full-GC 後の残存メモリ・オブジェクト数を測定します。

全ベンチマーク子プロセス（`perf:hot-path-gate`、`perf:full`、`perf:review`、`perf:disk-transport`、`perf:identity-database`、`perf:join-log`）は、`scripts/perf/childEnvironment.ts` の `perfChildEnvironment` で環境変数を構築します：
- 親プロセスの環境を継承した上で隔離データ・設定ルートを重ねます。
- `BUN_INSPECTOR_ENVS` に列挙されたデバッガー接続変数（VS Code ターミナルが注入する `BUN_INSPECT_CONNECT_TO` など）を除去し、子プロセス内の JSC ヒープをメインスレッドの 1 つだけに保ちます。
- GC ログの `starting` ハンドシェイクが厳密に 1 行であることを要求し、複数ヒープが検出された場合は GC 測定値を拒否します。

### ゲート指標と段階区分

- **GC 停止時間比率の予算**：利用可能 CPU コア数に応じて段階計算されます（`HOT_PATH_GC_CPU_BUDGETS`）。基準予算に `HOT_PATH_GC_SOFT_OVERRUN_PERCENT` ポイントを加えた上限を超えるとゲート不合格となり、ハード上限未満の軽微な超過はソフト警告として通知されます。
- **ハード指標ゲート**：GC 停止比率、サンプリング RSS ピーク、プロセス RSS ピーク、ヒープ増加量、full-GC 後のヒープ / 追加メモリ / オブジェクト残存数、最小サンプル数、およびウォームアップ段階での DFG JIT 到達を [`performance-result.json`](../../performance-result.json) の `calibration.limits` と照合します。
- **ソフト警告**：中央値レイテンシが `calibration.medianNsPerOpReportThresholds` を超えた場合、または校正上限が実測値に対して緩すぎる場合（`HOT_PATH_CALIBRATION_STALE_RATIO`）は、終了コードを変えずに stderr へ警告を出します。
- **校正値の管理**：`calibration` は無負荷環境で手動再校正してコミットする基準値であり、通常実行では読み取り専用です。`--write-result` 指定時のみ `lastRun` を更新します。

---

## 入室ログ性能ベンチマーク

`bun run perf:join-log` は本番定数（1 日あたりのグループ上限 `JOIN_LOG_MAX_USERS_PER_CHAT_DAY`、フラッシュ閾値 `FLUSH_MAX_ENTRIES`、バッチ追記上限 `JOIN_LOG_MAX_BUFFERED_ENTRIES`）と同じ規模で、`snapshot`・`capacity`・`append-accounting` の 3 経路を独立子プロセスで交互測定し、チェックサム一致・スループット・ヒープ変動を検証します。

---

## ID データベース性能ベンチマーク

`bun run perf:identity-database` は一時データルートと一時 SQLite 上で、メインスレッド LRU 読み取り、メインスレッドのライトスルー（Worker IPC・JSONB トランザクション・ACK）、ホット接続読み書き、コールド接続読み書きを測定します。件数は本番定数 `IDENTITY_READ_CACHE_MAX_ENTRIES` と `IDENTITY_WRITE_BATCH_MAX_ENTRIES` に揃え、GC と整合性検証は計測区間の外で実行します。

---

## 個別シナリオと伝送ストレス検証

`bun run perf:review` は主要ボトルネックを各項目 `FULL_SUITE_ROUNDS` ラウンドの独立子プロセスで深掘り検証します（引数省略時は `--hot-paths`、`--chains`、`--ai`、`--worker` を順次実行）：
- `--hot-paths`：送信者解決、メッセージスライディングウィンドウ、権限判定、AI アクティブウィンドウ、入室認証待ちスナップショット、有界ストリーミング応答、ミドルウェアパイプライン。
- `--ai`：AI 返信受付ゲート、通常送信、並行容量負荷、Base64 変換、Opus 音声エンコード。
- `--chains`：広告検出（`ad-detect-command`）、AI 会話（`ai-reply-command`）、定期音声送信（`cron-send-voice`）の完全コマンドチェーン。
- `--worker`：実 Disk I/O Worker を用いたバッチ書き込み、トランザクション ACK、Worker クラッシュ再生成後の復旧（管理上限 `STATE_MANAGED_CHAT_LIMIT` グループ）。
- `--cooldown` / `--text`：明示指定で実行するクールダウンテーブル・テキストサニタイズの専用ベンチマーク（本番容量・時間窓でのヒット、更新、満杯拒否、一括失効を測定）。
- `bun run perf:disk-transport`：モック Worker を用いてメインスレッド業務チャネルのキューオーバーヘッド・ACK スループット・遅延を測定し、ディスク I/O 待機と切り離します。

---

## 全量パフォーマンスベンチマーク

`bun run perf:full` はリリース時または明示的な指示がある場合にのみ実行します。合否閾値は設けず、6 セクションを各 `FULL_SUITE_ROUNDS` ラウンドの独立子プロセスで実行して平均・最小・最大・変動係数を出力します：
1. **コールドスタート**：実データ規模フィクスチャでの起動・状態復元時間。
2. **本番ホットパス**：高頻度メッセージの受信からディスパッチまでの処理時間。
3. **エンドツーエンド永続化チェーン**：メインスレッドの更新から Worker のディスク書き込み・ACK 返却までの往復遅延と完全コマンドチェーン。
4. **SQLite とメインスレッドキャッシュ**：SQLite とメインスレッド LRU キャッシュ間の連携効率。
5. **コンテナとアルゴリズム**：コア有界コンテナの操作および高頻度アルゴリズムの計算コスト。
6. **入室ログ容量境界**：上限規模での入室ログ読み書き・処理性能。

全データはリポジトリルートの `performance/` に書き出され、各実行後にディレクトリごと削除されます。`--write-doc` を付けると 3 言語の `11-performance.md` と `performance-result.json` を一括更新します。`--rounds <n>` はローカル調査専用であり、規定外ラウンド数の結果をコミットしてはなりません。

---

## コミット手順

1. **ブランチ運用**：ブランチは `master` と `dev` のみを使用し、フィーチャーブランチは作成しません。開発はすべて `dev` で行い、`master` への直接コミットは厳禁です。
2. **コミット前確認**：
   - `git diff --stat` で不要な未追跡ファイルやデプロイ設定が含まれていないことを確認します。
   - `git branch --show-current` で現在のブランチが `dev` であることを確認します。
   - `bun run lint && bun run typecheck` または `bun run check` を実行します。
3. **マージ前ゲート**：`master` マージ前に `bun run check` の全項目合格が必須です。永続化形式・停止処理・Worker ライフサイクルに関わる変更では `bun run test:fault-injection` の合格も必須です。
4. **マージ方式**：`master` への統合は `git merge --squash` のみを使用し、単一の明快なコミットにまとめます。
5. **コミットメッセージ**：変更内容と根拠を明記し、`feat:`・`fix:`・`perf:`・`docs:` 等のプレフィックスを使用します（リリース時は `release: <バージョン>`）。

### README 指標の同期

ユーザーからドキュメント・指標更新の明示的な指示があった場合にのみ、ローカルの全量実行結果から以下を同期します：
```bash
bun run test:coverage 2>&1 | tail -5          # テスト数、ファイル数、expect() 呼び出し数
bun run test:coverage 2>&1 | grep 'All files'  # 関数・行カバレッジ率
```
- **3 言語 README のバッジ数値**（Tests / Coverage）。
- **カバレッジ SVG**：`public/coverage_light.svg` と `public/coverage_dark.svg`。
- **3 言語 README 内の `<img alt>` テキスト**。
- **3 言語 `05-dev-workflow.md` の「このドキュメント版の実測値」行**。

---

## リリース

新バージョンのリリースでは、全対応プラットフォーム向けのネイティブ単一実行バイナリを含む GitHub Release を作成します：

1. **バージョン決定と品質ゲート**：
   - リモートタグを同期し、`gh release list` で現在の Latest Release を確認します。
   - `v` プレフィックスなしの次のセマンティックバージョン（`MAJOR.MINOR.PATCH`）を決定します。
   - `dev` ブランチで `bun run check`（および必要に応じ `bun run test:fault-injection`）を通過させます。
2. **ベンチマーク測定値の更新**：
   - ローカルの Bot プロセスや高負荷タスクを停止し、マシンをアイドル状態にします。
   - 規定ラウンドで `bun run perf:full -- --write-doc` を実行し、更新された 3 言語の `11-performance.md` と `performance-result.json` を `dev` にコミットします。
3. **各プラットフォームでのネイティブビルド**：
   - 対象は `RELEASE_PLATFORMS`（`linux-x64`、`linux-arm64`、`linux-x64-musl`、`linux-arm64-musl`）です。
   - 各プラットフォームの実機環境で同一コミットのクリーンな `dev` をチェックアウトし、`bun run release:build -- --version <tag>` を実行します。
   - 生成されたアーカイブと `.sha256` ファイルを 1 つの集約ディレクトリへ集めます。
4. **集約資産の検証**：
   - クリーンな作業ツリーで全プラットフォーム分の資産を検証します：
     ```bash
     bun run release:verify -- --version <tag> --platforms <カンマ区切りのプラットフォーム一覧> --directory <集約ディレクトリ>
     ```
   - SHA-256、内包バージョン・Git tree、対象アーキテクチャ、必須ランタイム資源とコールドマイグレーション CLI、依存整合性、および `.map` や `node_modules` の非混入を検査します。
5. **マージとタグ打ち**：
   - `git merge --squash` で `dev` を `master` へ統合し、Git tree ハッシュがビルド時と完全一致することを確認します。
   - `master` をプッシュし、そのコミットに注釈付きタグ（annotated tag）を作成してプッシュします。
6. **Release 公開と確認**：
   - Highlights、Compatibility / Migration Notes、実測カバレッジを記載した英語の Release ノートを作成します。
   - 下書き作成、資産アップロード、ダウンロード再検証を経て Latest として公開します：
     ```bash
     bun run release:publish -- --version <tag> --platforms <カンマ区切りのプラットフォーム一覧> --notes-file <説明ファイル> --directory <集約ディレクトリ>
     ```
   - タグプッシュ後にアップロードが中断した場合は同一コマンドで再実行でき、不足資産のみ補完されます。公開後に欠落やハッシュ不一致が見つかった場合は直ちに作業を停止して現場を保全します。
7. **`dev` ブランチの同期・整列**：
   - Release 公開を確認後、`git diff dev master --quiet` で差分がないことを確認します。
   - `dev` 上で `git reset --hard master` と `git push --force-with-lease origin dev` を実行し、`dev` と `master` を同一コミットに揃えます。

---

<div align="center">

[← 前のページ：04 不変条件](04-invariants.md) · [📚 開発者ドキュメント TOP](content-table.md) · [⬆️ トップへ戻る](#05-開発フローと品質ゲート) · [次のページ：06 変更レシピ →](06-modification-guide.md)

</div>

import type {
  MiniAppActiveSessionCounts,
  MiniAppBatchKickCompletion,
  MiniAppCapabilityDetailItem,
  MiniAppCapabilityStatus,
  MiniAppChatDetail,
  MiniAppFeatureKey,
  MiniAppIdentitySubTabKey,
} from "../../types/miniApp";
import type {
  MiniAppServerNoticeParams,
  MiniAppTranslations,
} from "../../types/miniAppI18n";

/**
 * 返回日文（雑魚♡语气）的 Mini App 界面文案字典。
 *
 * @returns 日文界面文案对象
 */
export function getJaTranslations(): Readonly<MiniAppTranslations> {
  const capabilityLabels: Readonly<Record<string, string>> = {
    agent: "Agent 能力",
    aiChat: "AI チャット＆マルチモーダル",
    translate: "自動翻訳エンジン",
    adDetect: "AI 広告検知",
    stickers: "ステッカーパック",
    mood: "AI 感情プール",
    cron: "定期配信タスク",
    hImage: "ランダムえっち図鑑 (/h_image)",
    randomHImage: "ランダムえっち図鑑 (/h_image)",
  };
  const featureShortNames: Readonly<Record<MiniAppFeatureKey, string>> = {
    init: "グループ管理総スイッチ (/init)",
    aiChat: "AI チャット (/ai_chat)",
    translation: "自動翻訳 (/translate)",
    adDetect: "広告検知 (/ad_detect)",
    floodControl: "連投スパム規制 (/flood_control)",
    antiRaid: "入群レイド防衛 (/antiraid)",
    proxySend: "個別チャット代送先 (/send)",
  };
  const serverNotice = (
    rawCode: string,
    params?: Readonly<MiniAppServerNoticeParams>
  ): string => {
    const code: string = rawCode.replace(/^\[[A-Z0-9_]+\]\s*/u, "").trim();
    const idText: string = params?.id !== undefined ? String(params.id) : "";
    const featureLabel: string =
      params?.feature !== undefined ? featureShortNames[params.feature] : "この機能";
    const listLabel: string =
      params?.targetList === "blocklist"
        ? "ブラックリスト"
        : params?.targetList === "deleteMessage"
          ? "発言削除対象"
          : params?.targetList === "translate"
            ? "翻訳対象"
            : "ホワイトリスト";
    switch (code) {
      case "MISSING_INIT_DATA":
      case "MALFORMED_INIT_DATA":
      case "MISSING_HASH":
      case "MISSING_USER":
        return `Telegram WebApp initData の検証に失敗したわ（${code}）。外部ブラウザからの直アクセスは禁止よ、雑魚。`;
      case "INVALID_SIGNATURE":
        return `Telegram WebApp 署名の検証に失敗したわ（${code}）。偽造なんて無駄よ、雑魚。`;
      case "EXPIRED_AUTH_DATE":
        return `Telegram WebApp 署名の有効期限が切れているわ（${code}）。Telegram からもう一度パネルを開き直しなさい、雑魚。`;
      case "FORBIDDEN_USER":
        return "設定されたスーパー管理者しかこの Mini App には入れないわ。雑魚は触っちゃダメよ。";
      case "DIRECT_NAVIGATION_FORBIDDEN":
        return "ブラウザのアドレスバーから保護された画像や SVG リソースへ直接アクセスするのは禁止よ。";
      case "CROSS_SITE_FORBIDDEN":
        return `クロスサイトリクエストはブロックされたわ（${code}）。変な場所から呼び出さないでよね、雑魚。`;
      case "PASSWORD_REQUIRED":
        return "Mini App アクセスパスワードが未認証よ。先にパスワードを入力してロック解除しなさい、雑魚。";
      case "SESSION_EXPIRED":
        return "45分の認証セッションが期限切れか無効よ。もう一度パスワードを入力しなさい、雑魚。";
      case "PASSWORD_LOCKED":
        return `3回連続で間違えたから、スーパー管理者 ID は30分間ロックされたわ${params?.remainingMinutes !== undefined ? `（残り約 ${params.remainingMinutes} 分）` : ""}、雑魚。`;
      case "INVALID_PASSWORD":
        return `アクセスパスワードが違うわよ${params?.remainingAttempts !== undefined ? `、残り試行回数は ${params.remainingAttempts} 回` : ""}（3回連続失敗で30分ロックよ）、雑魚！`;
      case "INVALID_TOTP_CODE":
        return params?.remainingAttempts !== undefined
          ? `Google Authenticator の6桁コードが違うわよ、残り試行回数は ${params.remainingAttempts} 回（3回連続失敗で30分ロックよ）、雑魚！`
          : "6桁のワンタイムコードが正しくないわ。Google Authenticator に表示されているコードを確認しなさい、雑魚！";
      case "TOTP_SETUP_EXPIRED":
        return "登録待ちの QR コードが期限切れか存在しないわ。もう一度 QR コードを生成しなさい、雑魚。";
      case "TOTP_ENABLED":
        return "Google Authenticator 認証器を有効化したわよ、雑魚♡";
      case "TOTP_UPDATED":
        return "Google Authenticator 認証器を更新したわよ、雑魚♡";
      case "TOTP_DELETED":
        return "Google Authenticator 認証器を削除して、アクセスパスワード認証に戻したわよ。";
      case "MOOD_SWITCHED":
        return params?.mood
          ? `ふん、アタシの今の気分を「${params.mood}」に切り替えてあげたわよ♡`
          : "ふん、全体感情を切り替えてあげたわよ♡";
      case "MOOD_SWITCH_FAILED":
        return "ちぇっ、感情の切り替えに失敗したわ。AI Worker か感情設定がまだ準備できてないわよ♡";
      case "INVALID_CHAT_ID":
        return "無効なグループチャット ID よ。";
      case "CHAT_NOT_FOUND":
        return "このグループは /init が有効でないか存在しないわ。";
      case "INVALID_CHAT_FEATURE_PARAMS":
        return "リクエストパラメータが不正よ：有効な feature と真偽値 enabled が必要よ。";
      case "CHAT_NOT_INITIALIZED":
        return "このグループは現在 /init が無効で、管理リストから外れているわ。";
      case "CHAT_INIT_ALREADY_ENABLED":
        return "このグループは既に /init が有効になっているわ。";
      case "CHAT_INIT_DISABLED":
        return "グループの /init 総スイッチをオフにして管理リストから外したわ。";
      case "CHAT_INIT_DISABLED_TEARDOWN_FAILED":
        return "/init 総スイッチをオフにしたけれど、一部の実行状態クリーンアップに失敗したわ。";
      case "FEATURE_CONFIG_NOT_READY":
        return `${featureLabel} の設定が未準備${params?.configFile !== undefined ? ` (${params.configFile})` : ""}のため有効化できないわ。`;
      case "FEATURE_ENABLED":
        return `${featureLabel} をオンにしたわ。`;
      case "FEATURE_DISABLED":
        return `${featureLabel} をオフにしたわ。`;
      case "PROXY_SEND_ENABLED":
        return "このグループを個別チャット代送先 (/send) に設定したわ。";
      case "PROXY_SEND_DISABLED":
        return "このグループの個別チャット代送 (/send finish) を停止したわ。";
      case "INVALID_BATCH_KICK_PARAMS":
        return "パラメータが不正よ：1〜24 の整数時間 hours が必要よ。";
      case "BATCH_KICK_RUNNING":
        return "このグループでは前回の一括整理がまだバックグラウンドで処理中よ、結果が出てからにしなさい♡";
      case "JOIN_LOG_UNAVAILABLE":
        return "参加ログを一時的に読み取れなかったわ。今回は処理せず終了したから後でやり直しなさい。";
      case "BATCH_KICK_EMPTY":
        return `直近 ${params?.hours ?? 1} 時間の新規参加記録はないわ、誰も蹴ってないしBANにも入れてないわよ♡`;
      case "BATCH_KICK_BUSY":
        return "バックグラウンドタスクが多すぎるわ、少し待ってからやり直しなさい♡";
      case "BATCH_KICK_ACCEPTED":
        return `ふん、直近 ${params?.hours ?? 1} 時間・計 ${params?.recordCount ?? 0} 件の参加記録の一括整理を受け付けたわ。完了したらグループに戦報を送るわよ♡`;
      case "INVALID_IDENTITY_PARAMS":
        return "パラメータが不正よ：0以外の安全な整数 id と真偽値 enabled が必要よ。";
      case "INVALID_IDENTITY_ID":
        return "マヌケな雑魚♡、ID の形式が間違ってるわよ（0以外の整数にしなさい）！";
      case "INVALID_PERMISSION_PARAMS":
        return "パラメータが不正よ：有効な権限キー key と真偽値 value が必要よ。";
      case "INVALID_PICKER_PARAMS":
        return "パラメータが不正よ：有効な targetList と subjectKind が必要よ。";
      case "INVALID_PICKER_REQUEST_ID":
        return "パラメータが不正よ：正の整数 requestId が必要よ。";
      case "SUPER_ADMIN_EXEMPT":
        return "雑魚♡、スーパー管理者は最初から全権限を持ってるんだからホワイトリストなんか不要よ！";
      case "BLOCKLIST_SUPER_ADMIN_FORBIDDEN":
        return "マヌケな雑魚♡、スーパー管理者をブラックリストに入れようとするなんて100年早いわ！";
      case "IDENTITY_STORAGE_UNAVAILABLE":
        return "ちぇっ、権限ポリシーストレージが今忙しいみたい。あとでやり直しなさい、雑魚♡";
      case "IDENTITY_IN_BLOCKLIST":
        return `マヌケな雑魚♡、ID ${idText} は今ブラックリストに入ってるわよ。先にBAN解除しなさい！`;
      case "IDENTITY_IN_WHITELIST":
        return `マヌケな雑魚♡、ID ${idText} はホワイトリストで保護されてるから直接ブラックリストには入れられないわ！`;
      case "WHITELIST_DUPLICATE":
        return `マヌケな雑魚♡、ID ${idText} はとっくにホワイトリストに入ってるわよ！重複追加はダメ！`;
      case "WHITELIST_ADDED":
        return `ふん、ID ${idText} をホワイトリストに入れて初期権限を付与してあげたわよ♡`;
      case "WHITELIST_REMOVED":
        return `ふん、ID ${idText} をホワイトリストから追い出してあげたわよ♡`;
      case "WHITELIST_NOT_FOUND":
        return `雑魚♡、ID ${idText} は最初からホワイトリストにいないわよ。`;
      case "WHITELIST_PERSIST_FAILED":
        return "ちぇっ、ホワイトリスト変更のディスク保存に失敗したわ。DB書き込み状態を確認しなさい♡";
      case "BLOCKLIST_DUPLICATE":
        return `マヌケな雑魚♡、ID ${idText} はとっくにブラックリストに入ってるわよ！重複追加はダメ！`;
      case "BLOCKLIST_ADDED": {
        const fanOutNote: string =
          params?.totalChats !== undefined && params.totalChats > 0
            ? `（${params.affectedChats ?? 0}/${params.totalChats} 個の管理群でBAN実行）`
            : "";
        const persistNote: string =
          params?.persisted === false ? "（※ディスク保存確認が未完了）" : "";
        return `ふん、ID ${idText} をブラックリストに叩き込んであげたわよ${fanOutNote}${persistNote}♡`;
      }
      case "BLOCKLIST_REMOVED":
      case "BLOCKLIST_NOT_FOUND": {
        const fanOutNote: string =
          params?.totalChats !== undefined && params.totalChats > 0
            ? `（${params.affectedChats ?? 0}/${params.totalChats} 個の管理群でBAN解除）`
            : "";
        const persistNote: string =
          params?.persisted === false ? "（※ディスク保存確認が未完了）" : "";
        const base: string =
          code === "BLOCKLIST_REMOVED"
            ? `ふん、ID ${idText} をブラックリストから出してあげたわよ`
            : `雑魚、ID ${idText} は最初からブラックリストにいないわよ`;
        return `${base}${fanOutNote}${persistNote}♡`;
      }
      case "PERMISSION_UPDATED":
        return `ID ${idText} の ${params?.key ?? ""} を ${String(params?.value ?? true)} に設定したわ。`;
      case "PERMISSION_UNCHANGED":
        return `ID ${idText} の ${params?.key ?? ""} は最初から ${String(params?.value ?? true)} よ。`;
      case "ALL_PERMISSIONS_ENABLED":
        return `ID ${idText} の全ホワイトリスト権限をオンにしたわ。`;
      case "ALL_PERMISSIONS_UNCHANGED":
        return `ID ${idText} の全権限は最初からオンになってるわ。`;
      case "PERMISSION_PERSIST_FAILED":
        return "権限変更のディスク保存に失敗したわ。DB書き込み状態を確認しなさい。";
      case "PICKER_PREPARE_FAILED":
        return "Telegram ネイティブ選択ボタンの準備に失敗したわ。savePreparedKeyboardButton 対応を確認するか ID 指定で追加しなさい。";
      case "PICKER_IMPORT_ADDED": {
        const added: number = params?.addedCount ?? 0;
        const skipped: number = params?.skippedCount ?? 0;
        const dup: number = params?.duplicateCount ?? 0;
        const dupSuffix: string =
          dup > 0 ? `、うち ${dup} 件は既に${listLabel}内` : "";
        return `ふん、${added} 件を${listLabel}に追加してあげたわよ${skipped > 0 ? `（${skipped} 件スキップ${dupSuffix}）` : ""}♡`;
      }
      case "PICKER_IMPORT_DUPLICATE":
        return `マヌケな雑魚♡、選択された ${params?.duplicateCount ?? 0} 件は全部とっくに${listLabel}に入ってるわよ！`;
      case "PICKER_IMPORT_EMPTY":
        return `雑魚♡、選択された対象を${listLabel}に追加できなかったわ（${params?.skippedCount ?? 0} 件スキップ）。`;
      case "GALLERY_IMAGE_ADDED":
        return `ふん、SHA-256 で図鑑に登録してあげたわよ：${params?.fileName ?? ""}♡`;
      case "GALLERY_IMAGE_EXISTING":
        return `マヌケな雑魚♡、同じ SHA-256 の画像が既に図鑑にあるわよ：${params?.fileName ?? ""}`;
      case "GALLERY_DIRECTORY_MISSING":
        return "ちぇっ、設定された図鑑ディレクトリが存在しないわよ。先にディレクトリを作りなさい♡";
      case "GALLERY_IMAGE_EMPTY":
        return "マヌケな雑魚♡、アップロードされた画像データが空っぽよ！";
      case "GALLERY_IMAGE_TOO_LARGE":
        return "雑魚♡、画像サイズが 10 MiB の上限を超えてるわよ！";
      case "GALLERY_UNSUPPORTED_FORMAT":
        return "マヌケな雑魚♡、対応しているのは JPEG・PNG・WebP だけよ！";
      case "GALLERY_INVALID_DIMENSIONS":
        return `雑魚♡、画像サイズ (${params?.width ?? 0}×${params?.height ?? 0}) が Telegram 送信基準（縦横合計 ≤ 10000 かつ比率 ≤ 20）を満たしてないわ！`;
      case "GALLERY_UPLOAD_FAILED":
        return "ちぇっ、画像サイズの解析か図鑑ディレクトリへの書き込みに失敗したわ、雑魚♡";
      case "GALLERY_UPLOAD_READ_FAILED":
        return "アップロードされた画像リクエストを読み取れなかったわ。";
      case "GALLERY_IMAGE_DELETED":
        return `ふん、${params?.fileName ?? ""} を図鑑から消してあげたわよ♡`;
      case "GALLERY_IMAGE_NOT_FOUND":
        return "雑魚♡、その画像は既に削除されたか存在しないわよ！";
      case "GALLERY_INVALID_FILE_NAME":
        return "マヌケな雑魚♡、画像ファイル名の形式が間違ってるわよ！";
      case "GALLERY_DELETE_FAILED":
        return "ちぇっ、図鑑からの画像削除に失敗したわ。ディスク権限を確認しなさい♡";
      case "QA_ADDED":
        return "ふん、このQAペアを登録してあげたわよ♡";
      case "QA_UPDATED":
        return "ふん、同じ質問の回答を上書き更新してあげたわよ♡";
      case "QA_REMOVED":
        return "ふん、そのQAペアを削除してあげたわよ♡";
      case "QA_NOT_FOUND":
        return "雑魚♡、そのQAペアは最初から存在しないか既に削除されてるわよ。";
      case "QA_EMPTY_FIELDS":
        return "マヌケな雑魚♡、質問と回答はどっちも空欄にしちゃダメよ！";
      case "QA_QUESTION_TOO_LONG":
        return "雑魚♡、質問文が 256 文字の上限を超えてるわよ！";
      case "QA_ANSWER_TOO_LONG":
        return "雑魚♡、回答文が 3840 文字の上限を超えてるわよ！";
      case "QA_COMMAND_IN_QUESTION":
        return "マヌケな雑魚♡、質問文の中に実行可能な /command を入れちゃダメよ！";
      case "QA_COMMAND_IN_ANSWER":
        return "マヌケな雑魚♡、コードブロック外の通常回答文に /command を入れちゃダメよ！";
      case "QA_LIMIT_REACHED":
        return "雑魚♡、このグループのQAペアは上限の 15 件いっぱいよ。先にいくつか消しなさい！";
      case "QA_STORAGE_FAILED":
        return "ちぇっ、QAペアのディスク保存に失敗したわ。DB書き込み状態を確認しなさい♡";
      case "TARGET_REQUIRED":
        return "マヌケな雑魚♡、対象の @username か数値 ID を入力しなさい！";
      case "TARGET_INVALID":
        return "マヌケな雑魚♡、対象の形式が間違ってるわ（@username、正整数ユーザーID、または -100... チャンネルID）！";
      case "TARGET_USERNAME_NOT_FOUND":
        return "ちぇっ、その @username はまだキャッシュにないわ。数値 ID で指定するか本人が発言するのを待ちなさい♡";
      case "TARGET_NOT_IN_CHAT":
        return "雑魚♡、そのユーザーはこのグループにいないわよ、対象リストには入れられないわ！";
      case "TARGET_SELF_FORBIDDEN":
        return "マヌケな雑魚♡、天才のアタシ自身を対象にするなんて100年早いわ！";
      case "TARGET_CURRENT_CHAT_FORBIDDEN":
        return "マヌケな雑魚♡、このグループ自身を対象にはできないわよ！";
      case "DELETE_TARGET_SUPER_ADMIN_FORBIDDEN":
        return "マヌケな雑魚♡、スーパー管理者を自動削除対象にはできないわよ！";
      case "DELETE_TARGET_MISSING_BOT_PERMISSION":
        return "ちぇっ、このグループで「メッセージ削除」の管理者権限がないわよ。先に権限を付けなさい♡";
      case "DELETE_TARGET_ALREADY_EXISTS":
        return "雑魚♡、その対象は既に自動削除リストに入ってるわよ！";
      case "DELETE_TARGET_LIMIT_REACHED":
        return "雑魚♡、このグループの自動削除対象は上限の 15 件に達してるわよ！";
      case "DELETE_TARGET_ADDED":
        return "ふん、その対象を自動削除リストに追加してあげたわよ♡";
      case "DELETE_TARGET_REMOVED":
        return "ふん、その対象を自動削除リストから外してあげたわよ♡";
      case "DELETE_TARGET_NOT_FOUND":
        return "雑魚♡、その対象は最初から自動削除リストにいないわよ。";
      case "TRANSLATE_CAPABILITY_UNAVAILABLE":
        return "ちぇっ、翻訳機能のエンドポイント設定が未完了よ。agent.json を確認しなさい♡";
      case "TRANSLATE_FEATURE_DISABLED":
        return "マヌケな雑魚♡、先にこのグループの「自動翻訳 (/translate)」スイッチをオンにしなさい！";
      case "TRANSLATE_LANGUAGE_INVALID":
        return "マヌケな雑魚♡、選択された翻訳言語は未対応よ！";
      case "TRANSLATE_TARGET_LIMIT_REACHED":
        return "雑魚♡、このグループの自動翻訳対象は上限の 5 件に達してるわよ！";
      case "TRANSLATE_TARGET_ALREADY_EXISTS":
        return "雑魚♡、その対象は既に同じ言語で自動翻訳中よ！";
      case "TRANSLATE_TARGET_ADDED":
        return "ふん、その対象を自動翻訳リストに追加してあげたわよ♡";
      case "TRANSLATE_TARGET_UPDATED":
        return "ふん、その自動翻訳対象の言語を更新してあげたわよ♡";
      case "TRANSLATE_TARGET_REMOVED":
        return "ふん、その対象の自動翻訳を停止してあげたわよ♡";
      case "TRANSLATE_TARGET_NOT_FOUND":
        return "雑魚♡、その対象は最初から自動翻訳リストにいないわよ。";
      case "INVALID_CHAT_TARGETS_PARAMS":
        return "マヌケな雑魚♡、対象管理リクエストのパラメータ形式が不正よ！";
      default:
        return code;
    }
  };
  return {
    languageLabel: "日",
    appTitle: "雑魚コンソール♡",
    superAdminBadge: "SuperAdmin",
    lockButton: "ロック",
    lockSessionToast: "ふん、うっかり屋の雑魚のためにセッションをロックしてあげたわよ♡",
    sessionExpiredToast: "雑魚、45分のセッションが切れたわよ。大人しくパスワードを入れ直しなさい！",
    themeLightLabel: "ライト",
    themeDarkLabel: "ダーク",
    sidebarTitle: "ナビメニュー",
    sidebarSubtitle: "雑魚はどのモジュールを覗きたいの？",
    sidebarOpenAria: "サイドバーメニューを開く",
    sidebarCloseAria: "サイドバーメニューを閉じる",
    sidebarFooterHint: "天才のアタシが24時間システムを監視してあげてるんだから感謝しなさい♡",
    tabs: {
      status: "ステータス",
      chats: "管理グループ",
      identities: "権限管理",
      gallery: "えっち図鑑",
      totp: "認証システム",
    },
    tabDescriptions: {
      status: "CPU・メモリ・送信制御と稼働状態",
      chats: "/init 群スイッチと直近256件発言",
      identities: "白黒リストと18項目の権限管理",
      gallery: "/h_image プレビュー・追加・削除",
      totp: "Google 認証システム (TOTP) の登録・変更・削除",
    },
    serverNotice,
    gate: {
      deniedTitle: "アクセス拒否よ、雑魚♡",
      deniedDescription:
        "ふん、外部ブラウザや未承認クライアントからこのコンソールを覗く権限なんてないわよ、雑魚。",
      deniedNodeClientSub: "クライアント",
      deniedNodeClientTitle: "雑魚のブラウザ",
      deniedNodeClientState: "稼働中",
      deniedNodeGatewaySub: "アクセスゲートウェイ",
      deniedNodeGatewayTitle: "認証ガード",
      deniedNodeGatewayState: (status: number): string => `${status} 拒否`,
      deniedNodeOriginSub: "オリジンサービス",
      deniedNodeOriginState: "保護中",
      deniedWhatHappenedTitle: "何が起きたの、雑魚？",
      deniedWhatHappenedDesc:
        "このエンドポイントは厳格な Telegram WebApp 署名検証と管理者アクセス制御を強制しているわ。雑魚が送ったリクエストはポリシー検証を通らなかったから、そのまま蹴り返してあげたわよ。",
      deniedPolicyDetailLabel: (code: string): string => `ポリシー詳細 (${code})`,
      deniedPolicyReason: (
        code: string,
        fallbackError: string,
        params?: Readonly<MiniAppServerNoticeParams>
      ): string => {
        const upper: string = code.toUpperCase();
        const byCode: string = serverNotice(upper, params);
        if (byCode !== upper) return byCode;
        return serverNotice(fallbackError || code, params);
      },
      deniedWhatCanIDoTitle: "雑魚はどうすればいいの？",
      deniedWhatCanIDoDesc:
        "Telegram 以外からの直接 HTTP アクセスは禁止よ。もし本当にスーパー管理者なら、大人しく Telegram で Bot との個別チャットを開いて App ボタンからアクセスパスワードを入力しなさい、雑魚。",
      passwordBadge: "二次パスワード認証",
      passwordTitle: "合言葉を出せ、雑魚",
      passwordSubtitle:
        "Telegram の署名はギリギリ合格ね。次はコンソール用アクセスパスワードを入れて45分セッションを解除しなさい（3回間違えたら30分ロックよ）。",
      passwordPlaceholder: "ほら、間違えずにパスワードを入力しなさい雑魚…",
      passwordEmptyHint: "マヌケな雑魚、空欄のまま突破できると思ったの？",
      passwordSubmitButton: "ロック解除",
      totpBadge: "Google 認証システム",
      totpTitle: "6桁コードを出せ、雑魚",
      totpSubtitle:
        "Google Authenticator が優先有効化されているわ。現在の6桁ワンタイムコードを入力して45分セッションを解除しなさい（3回失敗で30分ロックよ）。",
      totpPlaceholder: "6桁の認証コードを入力しなさい雑魚…",
      totpEmptyHint: "マヌケな雑魚、6桁の数字コードをちゃんと入力しなさい！",
      totpSubmitButton: "コード照合して解除",
      unlockedToast: "ふん、まあ合格ね。45分間だけ使わせてあげるわ♡",
    },
    totp: {
      sectionTitle: "Google Authenticator 認証",
      enabledBadge: "優先認証 ON",
      disabledBadge: "未設定 (パスワード認証)",
      statusDescEnabled: (maskedSecret: string, updatedAtText: string): string =>
        `現在の認証シークレット：${maskedSecret} · ${updatedAtText} 更新（ログイン時は認証器を優先）`,
      statusDescDisabled:
        "Google 認証システムは未登録よ（現在はパスワード認証）。このコンソールからのみQRコードを生成して1つだけ登録できるわ。",
      addButton: "認証器を追加",
      modifyButton: "認証器を変更",
      deleteButton: "認証器を削除",
      qrGuideText:
        "Google Authenticator で下のQRコードをスキャン（または Base32 キーを手入力）し、6桁コードを入力して有効化しなさい：",
      secretLabel: "Base32 キー：",
      codePlaceholder: "6桁の確認コードを入力…",
      verifyEnableButton: "確認して保存",
      cancelSetupButton: "キャンセル",
      confirmDeleteTotp:
        "雑魚、本当に Google Authenticator 認証器を削除するの？削除後はアクセスパスワード認証に戻るわよ！",
    },
    pagination: {
      summary: (total: number, page: number, totalPages: number): string =>
        `全 ${total} 件 · ${page}/${totalPages} ページ`,
      pageSizeOption: (size: number): string => `${size}/頁`,
      firstPageAria: "先頭",
      prevPageAria: "前へ",
      nextPageAria: "次へ",
      lastPageAria: "末尾",
    },
    confirmDialog: {
      title: "最終確認よ、雑魚",
      confirmButton: "実行する",
      cancelButton: "やっぱりやめる",
    },
    status: {
      loadingText: "ステータスを読み込み中…",
      uptimeLabel: "プロセス稼働時間",
      updatedAtSub: (timeText: string): string => `${timeText} 更新`,
      cpuLoadLabel: "CPU 平均負荷",
      cpuLoadSub: "平滑サンプリング",
      memoryCurrentLabel: "現在メモリ",
      memoryPeakLabel: "ピークメモリ",
      memoryHeapLabel: "JS ヒープ",
      memoryProcessUsedLabel: "当プロセス使用",
      memoryOtherUsedLabel: "他プロセス使用",
      memoryTotalUsedLabel: "合計使用",
      managedChatsLabel: "/init 済み管理群",
      managedChatsSub: (whitelistCount: number, blocklistCount: number): string =>
        `白リスト ${whitelistCount} · 黒リスト ${blocklistCount}`,
      activeSessionsLabel: "進行中セッション",
      activeSessionsSub: (
        sessions: Readonly<MiniAppActiveSessionCounts>
      ): readonly [string, string, string, string] => [
        `猿轡 ${sessions.gag}`,
        `嫁ガチャ ${sessions.wed}`,
        `認証 ${sessions.verify}`,
        `QA ${sessions.qaSet}`,
      ],
      outboundGateLabel: "Telegram 送信ゲート",
      outboundGateSub: (waiting: number, retrySize: number, retryMax: number): string =>
        `待機 ${waiting} · 再送キュー ${retrySize}/${retryMax}`,
      capabilitiesSectionTitle: "機能設定とサブシステム準備状態",
      capabilityReadyBadge: "準備完了",
      capabilityMissingBadge: "未設定",
      capabilityItemCount: (count: number): string => `${count} 項目`,
      moodCurrentLabel: "現在の感情",
      moodCurrentActiveBadge: "現在有効",
      moodUnavailableText: "未稼働 (AI Worker 停止中)",
      moodSwitchButton: "感情切替",
      capabilityLabel: (capability: Readonly<MiniAppCapabilityStatus>): string =>
        capabilityLabels[capability.key] ?? capability.label,
      capabilityItem: (
        item: Readonly<MiniAppCapabilityDetailItem>
      ): Readonly<MiniAppCapabilityDetailItem> => {
        if (item.label === "广告检测 ad_detect") {
          return { label: "広告検知 ad_detect", value: item.value, sub: item.sub };
        }
        if (item.label === "图库服务") {
          return {
            label: "図鑑サービス",
            value: "/h_image 抽選とパネル管理に対応",
            sub: "SHA-256 重複排除ストレージ",
          };
        }
        if (item.label === "运行状态") {
          return {
            label: "稼働状態",
            value: "未準備",
            sub: "必須設定が不足",
          };
        }
        if (item.label === "翻译服务") {
          return {
            label: "翻訳サービス",
            value: item.value,
            sub: "有効",
          };
        }
        if (item.label === "检测模型") {
          return {
            label: "検知モデル",
            value: item.value,
            sub: item.sub,
          };
        }
        if (item.label === "对话 text") {
          return { label: "会話 text", value: item.value, sub: item.sub };
        }
        if (item.label === "摘要 summary") {
          return { label: "要約 summary", value: item.value, sub: item.sub };
        }
        if (item.label === "多模态 media") {
          return { label: "マルチモーダル media", value: item.value, sub: item.sub };
        }
        if (item.label === "生图 image") {
          return { label: "画像生成 image", value: item.value, sub: item.sub };
        }
        if (item.label === "语音 tts") {
          return {
            label: "音声 tts",
            value: item.value,
            sub: item.sub?.replace("音色 ", "ボイス "),
          };
        }
        if (item.label === "搜索 search") {
          return {
            label: "検索 search",
            value: item.value,
            sub: item.sub
              ?.replace("限 ", "上限 ")
              .replace(" 次/轮", " 回/ターン"),
          };
        }
        if (item.label.startsWith("贴纸包 #")) {
          return {
            label: item.label.replace("贴纸包 #", "ステッカー #"),
            value: item.value,
            sub: item.sub,
          };
        }
        if (item.label === "贴纸包") {
          return { label: "ステッカー", value: "未読込", sub: item.sub };
        }
        if (item.label === "情绪池") {
          return { label: "感情プール", value: "未読込", sub: item.sub };
        }
        if (item.value.startsWith("权重 ")) {
          return {
            label: item.label,
            value: item.value.replace("权重 ", "重み "),
            sub: item.sub,
          };
        }
        if (item.label === "定时任务") {
          return {
            label: "定期タスク",
            value: item.value === "未加载" ? "未読込" : "設定済みタスクなし",
            sub: item.sub,
          };
        }
        if (item.sub !== undefined) {
          return {
            label: item.label,
            value: item.value,
            sub: item.sub
              .replace("全部受管群", "全管理グループ")
              .replace(/排除 (\d+) 群/u, "$1 群を除外")
              .replace(/(\d+) 个指定会话/u, "$1 個の指定チャット"),
          };
        }
        return item;
      },
    },
    chats: {
      sectionTitle: (count: number): string => `/init 有効な管理グループ (${count})`,
      refreshButton: "更新",
      loadingChatsText: "管理グループ一覧を数えてあげてるわよ…",
      emptyChatsHint:
        "ちぇっ、/init が有効なグループが1つもないじゃない。雑魚、グループで /init enable を撃ってきなさい♡",
      lockdownBadge: "封鎖クールダウン中",
      chatCardMeta: (chatId: number, hotCount: number, qaCount: number): string =>
        `ID: ${chatId} · 熱発言 ${hotCount} 件 · QA ${qaCount} 件`,
      detailSectionTitle: "設定・管理",
      viewMessagesButton: "発言を覗く",
      targetsMenuButton: "対象・QA",
      targetsKindLabel: {
        qa: "QAペア",
        deleteMessage: "自動削除対象",
        translate: "自動翻訳対象",
      },
      targetsModalSubtitle: (
        chatTitle: string,
        count: number,
        maxCount: number
      ): string => `${chatTitle} · 登録数 ${count}/${maxCount}`,
      targetsCloseButton: "閉じる",
      targetsRefreshButton: "更新",
      qaOpenEditorButton: "QAペアを追加・編集",
      qaCancelEditButton: "閉じる",
      qaQuestionLabel: "質問キーワード (Q)",
      qaQuestionPlaceholder: (maxChars: number): string =>
        `質問を入力（最大 ${maxChars} 文字、同一質問は上書き）…`,
      qaAnswerLabel: "自動回答 (A)",
      qaAnswerPlaceholder: (maxChars: number): string =>
        `回答を入力（最大 ${maxChars} 文字、コードブロック可）…`,
      qaSaveButton: "QAを保存",
      qaSavingButton: "保存中…",
      qaEditButton: "編集読込",
      qaDeleteButton: "削除",
      confirmDeleteQa: (q: string): string =>
        `雑魚♡、QAペア「${q}」を本当に削除するの？`,
      qaEmptyHint: "上のボタンからQAを追加しなさい♡",
      deleteTargetInputPlaceholder: "@username / ユーザーID / チャンネルID",
      deleteTargetAddButton: "削除対象を追加",
      deleteTargetAddingButton: "追加中…",
      deleteTargetRemoveButton: "解除",
      confirmRemoveDeleteTarget: (displayName: string, id: number): string =>
        `雑魚、本当に ${displayName} (${id}) を削除対象リストから外すの？`,
      deleteTargetEmptyHint: "@username か ID で追加しなさい♡",
      translateTargetInputPlaceholder: "@username / ユーザーID / チャンネルID",
      translateLanguageLabels: {
        ja: "日本語 (ja)",
        cn: "中国語 (cn)",
        en: "英語 (en)",
        uk: "ウクライナ語 (uk)",
        ru: "ロシア語 (ru)",
      },
      translateTargetAddButton: "翻訳対象を追加",
      translateTargetAddingButton: "追加中…",
      translateTargetRemoveButton: "解除",
      confirmRemoveTranslateTarget: (displayName: string, id: number): string =>
        `雑魚、本当に ${displayName} (${id}) を翻訳対象リストから外すの？`,
      translateTargetEmptyHint: "要 /translate オン、最大 5 名♡",
      closeDetailButton: "閉じる",
      botPermProbing: "Bot 管理者権限：まだ未検出よ。グループで何かコマンドを撃ちなさい",
      botPermNone: "Bot 管理者権限：管理者権限が1つもないわよ、早く権限を付けなさい",
      botPermGrantedTitle: (count: number): string =>
        `保有している Bot 管理者権限 (${count} 項目)`,
      botPermLabel: (rawLabel: string): string => {
        const map: Readonly<Record<string, string>> = {
          管理员身份: "管理者権限",
          匿名身份: "匿名管理者",
          管理聊天: "チャット管理",
          删除消息: "メッセージ削除",
          管理视频聊天: "ビデオチャット管理",
          限制与封禁成员: "メンバー制限・BAN",
          任免管理员: "管理者の追加",
          修改聊天资料: "グループ情報変更",
          邀请用户: "ユーザー招待",
          管理成员标签: "メンバータグ管理",
          发布故事: "ストーリー投稿",
          编辑故事: "ストーリー編集",
          删除故事: "ストーリー削除",
          频道发布消息: "チャンネル投稿",
          编辑频道消息: "チャンネル編集",
          置顶消息: "メッセージ固定",
          管理论坛话题: "トピック管理",
          管理频道私信: "チャンネルDM管理",
        };
        return map[rawLabel] ?? rawLabel;
      },
      detailStatsLine: (detail: Readonly<MiniAppChatDetail>): string =>
        `群 ID: ${detail.chatId}`,
      joinCleanSectionTitle: "参加統計・一括整理",
      batchKickRunningBadge: "実行中",
      windowJoinedLabel: "時間枠内の参加",
      windowJoinedSub: (hours: number): string => `直近 ${hours} 時間の重複除外集計`,
      windowJoinedValue: (count: number): string => `${count} 人`,
      batchKickWindowLabel: "遡り整理ウィンドウ (1〜24 時間)",
      batchKickHourPill: (hours: number): string => `${hours} 時間`,
      batchKickDecreaseAria: "1時間減らす",
      batchKickIncreaseAria: "1時間増やす",
      batchKickTriggerButton: (hours: number): string =>
        `直近 ${hours} 時間の参加者を整理`,
      batchKickRunningButton: "バックグラウンドで一括整理中…",
      batchKickCompletedSummary: (c: Readonly<MiniAppBatchKickCompletion>): string =>
        `直近の整理完了 (${c.hours}h · ${c.scanned}/${c.recordCount} 件)：追放 ${c.kicked} · 退室済 ${c.absent} · 保護 ${c.protected} · BAN ${c.blocked} · 権限不足 ${c.forbidden} · 失敗 ${c.failed}${c.aborted ? "（中断）" : ""}`,
      confirmBatchKick: (hours: number): string =>
        `雑魚、直近 ${hours} 時間の参加記録から新規メンバーを一括整理して本当にいいの？`,
      featuresSectionTitle: "グループ機能スイッチ（即時同期）",
      confirmDisableInit:
        "雑魚、本当にこのグループの /init 総スイッチを切るの？実行中キャッシュが全部消えて一覧から外れるわよ！",
      featureMeta: {
        init: {
          label: "グループ管理総スイッチ (/init)",
          command: "/init",
          description: "オフにすると管理一覧から外してメモリ状態も綺麗に掃除するわよ",
        },
        aiChat: {
          label: "AI チャット＆記憶 (/ai_chat)",
          command: "/ai_chat",
          description: "アタシの AI 返信・ホット文脈バッファ・要約記憶を有効化するわ",
        },
        translation: {
          label: "自動翻訳 (/translate)",
          command: "/translate",
          description: "グループ全体の自動翻訳と特定メンバーの追尾翻訳を切り替えるわ",
        },
        adDetect: {
          label: "AI 広告検知 (/ad_detect)",
          command: "/ad_detect",
          description: "白リスト外の新規発言を広告判定して自動処置するわよ",
        },
        floodControl: {
          label: "連投スパム規制 (/flood_control)",
          command: "/flood_control",
          description: "短時間に騒ぎすぎる連投メンバーを自動でミュートにするわ",
        },
        antiRaid: {
          label: "入群レイド防衛 (/antiraid)",
          command: "/antiraid",
          description: "不審な大量入群を検知して自動で封鎖モードに入るわよ",
        },
        proxySend: {
          label: "個別チャット代送先 (/send)",
          command: "/send",
          description: "雑魚が個別チャットで /send した時の送信先グループにするわ",
        },
      },
    },
    messages: {
      backButton: "詳細へ戻る",
      refreshButton: "更新",
      headerTitle: (title: string, total: number, maxCapacity: number): string =>
        `${title} · 直近発言 (${total}/${maxCapacity})`,
      headerMeta: (chatId: number): string =>
        `群 ID: ${chatId} · ホットバッファの最新256件だけ見せてあげる（圧縮記憶は秘密よ）`,
      loadingText: "発言ログをめくってあげてるわよ…",
      emptyHint: "このグループのホットバッファは空っぽよ、雑魚",
      replyBadge: (name: string, preview: string): string =>
        `${name} への返信${preview.length > 0 ? `: ${preview}` : ""}`,
      forwardBadge: (from: string): string => `${from} から転送`,
      emptyMediaPlaceholder: "(テキストなしメディア)",
    },
    identities: {
      whitelistTab: "権限",
      blocklistTab: "ブラックリスト",
      searchPlaceholder: "id/name",
      searchClearAria: "検索語をクリア",
      searchDebounceHint: "0.5s デバウンス検索中…",
      addFoldButton: "ユーザー追加",
      addModes: {
        id: "ID 指定で追加",
        users: "連絡先から選択",
        channel: "チャンネルから選択",
      },
      addModeDescriptions: {
        id: "ユーザーの正整数 ID または -100... のチャンネル ID を直接入力",
        users: "Telegram ネイティブの連絡先ピッカーで友達を複数選択",
        channel: "Telegram ネイティブのチャンネルピッカーでチャンネルを選択",
      },
      idInputPlaceholder: "正整数 ID または -100... チャンネル ID",
      idConfirmButton: "追加する",
      idCancelButton: "閉じる",
      invalidIdToast: "マヌケな雑魚、0以外の整数 ID をちゃんと入力しなさい（例: 123456789 / -1001234567890）！",
      duplicateToast: (idText: string, subTab: MiniAppIdentitySubTabKey): string =>
        `マヌケな雑魚、${idText} はとっくに${subTab === "whitelist" ? "ホワイトリスト" : "ブラックリスト"}に入ってるわよ！重複追加はダメ！`,
      duplicateBannerTitle: "重複追加ブロック",
      pickerUnsupportedHint:
        "雑魚の今の環境は Telegram.WebApp.requestChat 非対応よ。Telegram アプリから開くか「ID 指定で追加」を使いなさい",
      pickerWaitingToast: "Telegram の選択画面を出したわよ、早く選びなさい雑魚…",
      pickerCancelledToast: "ふん、選択を途中でキャンセルするなんて気まぐれな雑魚ね",
      pickerTimeoutToast: "選択結果がなかなか届かないわね、手動で更新してみなさい",
      loadingText: "名簿をめくってあげてるわよ…",
      emptySearchHint: (query: string): string =>
        `ちぇっ、「${query}」に一致する名前や ID は見つからないわよ。タイプミスじゃないの雑魚？`,
      emptyListHint: (subTab: MiniAppIdentitySubTabKey): string =>
        subTab === "whitelist"
          ? "ホワイトリストはまだ空っぽよ。右上の「ユーザー追加」から入れなさい雑魚♡"
          : "ブラックリストにはまだ誰もいないわ。右上の「ユーザー追加」から閉じ込めなさい♡",
      channelBadge: "CH",
      userBadge: "USER",
      blockedAtText: (timeText: string): string => `ブロック日時: ${timeText}`,
      enabledPermCountText: (enabledCount: number, totalCount: number): string =>
        `${enabledCount}/${totalCount} 個の権限が有効`,
      configurePermButton: "権限設定",
      removeWhitelistButton: "外す",
      removeBlocklistButton: "解除",
      confirmRemoveWhitelist: (displayName: string, id: number): string =>
        `雑魚、本当に ${displayName} (${id}) をホワイトリストから外すの？`,
      confirmRemoveBlocklist: (displayName: string, id: number): string =>
        `雑魚、本当に ${displayName} (${id}) をブラックリストから外して全管理群でBAN解除するの？`,
    },
    permissionDrawer: {
      title: (displayName: string): string => `${displayName} の権限スイッチ`,
      subtitle: (id: number, isChannel: boolean): string =>
        `ID: ${id} · ${isChannel ? "チャンネル" : "ユーザー"} · SQLite 即時保存`,
      enableAllButton: "全18項目を一括ON",
      closeButton: "閉じる",
      labels: {
        isCanMute: "/mute 手動ミュート",
        isCanUnMute: "/unmute ミュート解除",
        isCanGag: "/gag ボールギャグ装着",
        isCanViewBotStatus: "/bot_status 稼働状態の閲覧",
        isCanBlock: "/block ブラックリスト追加",
        isCanUnBlock: "/unblock ブラックリスト解除",
        isCanWhiteOther: "/white 他人のホワイトリスト追加",
        isCanSwitchMood: "/switch_mood アタシの機嫌切替",
        isCanBypassAdDetection: "広告検知バイパス特権",
        isCanBypassFloodControl: "連投規制バイパス特権",
        isCanControllAIPermission: "/ai_chat スイッチ制御",
        isCanClearContext: "/clear AI 文脈クリア",
        isCanControllAdDetectPermission: "/ad_detect スイッチ制御",
        isCanControllFloodControlPermission: "/flood_control スイッチ制御",
        isCanControllTranslatePermission: "/translate スイッチ制御",
        isCanControllAntiRaidPermission: "/antiraid スイッチ制御",
        isCanControllQaPermission: "/qa キーワード応答管理",
        isCanAddHImage: "/h_image add えっち画像追加",
      },
    },
    gallery: {
      sectionTitle: "えっち図鑑",
      refreshButton: "更新",
      uploadingButton: "登録中…",
      uploadButton: "画像を追加",
      directoryMissingText: (_directory: string): string =>
        "図鑑ストレージが未準備よ、自動作成はしないからね",
      directoryReadyText: (_directory: string): string =>
        "図鑑ストレージ準備完了 · JPEG / PNG / WebP (≤ 10 MiB)",
      previewTitle: (shortName: string): string => `プレビュー · ${shortName}`,
      downloadButton: "保存",
      downloadingButton: "保存中…",
      downloadedToast: (fileName: string): string =>
        `雑魚のために ${fileName} をダウンロードしてあげたわよ♡`,
      deleteButton: "削除",
      deletingButton: "削除中…",
      closePreviewButton: "閉じる",
      confirmDeleteImage: (fileName: string): string =>
        `雑魚、本当にこの画像 (${fileName}) を図鑑から完全に削除するの？元には戻せないわよ！`,
      deletedToast: (fileName: string): string =>
        `ふん、雑魚のために ${fileName} を図鑑から消してあげたわよ♡`,
      loadingText: "えっち図鑑のアルバムを開いてあげてるわよ…",
      emptyMissingDirHint:
        "設定された画像ディレクトリがまだ存在しないわ。サーバーで作ってから出直しなさい雑魚",
      emptyGalleryHint:
        "図鑑に画像が1枚もないじゃない！右上の「画像を追加」から登録しなさい雑魚♡",
    },
  };
}

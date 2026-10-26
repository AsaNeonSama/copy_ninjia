import type {
  MiniAppActiveSessionCounts,
  MiniAppCapabilityDetailItem,
  MiniAppCapabilityStatus,
  MiniAppChatDetail,
  MiniAppIdentitySubTabKey,
} from "../types/miniApp";
import type { MiniAppTranslations } from "../types/miniAppI18n";

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
  return {
    languageLabel: "日",
    appTitle: "Bot コンソール♡",
    appSubtitle: "雑魚管理人のために天才のアタシが用意したコックピット",
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
    gate: {
      checkingText: "雑魚の SuperAdmin 署名を検査してあげてるから大人しく待ちなさい…",
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
      deniedPolicyReason: (code: string, fallbackError: string): string => {
        const upper: string = code.toUpperCase();
        if (
          upper === "MISSING_INIT_DATA" ||
          upper === "MALFORMED_INIT_DATA" ||
          upper === "MISSING_HASH" ||
          upper === "MISSING_USER"
        ) {
          return `Telegram WebApp initData の検証に失敗したわ（${code}）。外部ブラウザからの直アクセスは禁止よ、雑魚。`;
        }
        if (upper === "INVALID_SIGNATURE") {
          return `Telegram WebApp 署名の検証に失敗したわ（${code}）。偽造なんて無駄よ、雑魚。`;
        }
        if (upper === "EXPIRED_AUTH_DATE") {
          return `Telegram WebApp 署名の有効期限が切れているわ（${code}）。Telegram からもう一度パネルを開き直しなさい、雑魚。`;
        }
        if (upper === "FORBIDDEN_USER") {
          return "設定されたスーパー管理者しかこの Mini App には入れないわ。雑魚は触っちゃダメよ。";
        }
        if (upper === "CROSS_SITE_FORBIDDEN") {
          return `クロスサイトリクエストはブロックされたわ（${code}）。変な場所から呼び出さないでよね、雑魚。`;
        }
        return fallbackError;
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
      passwordSubmitting: "アタシが照合中…",
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
      verifyingButton: "確認中…",
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
      loadingText: "雑魚のためにリアルタイム状態を読んでるから急かさないで…",
      uptimeLabel: "プロセス稼働時間",
      updatedAtSub: (timeText: string): string => `${timeText} 更新`,
      cpuLoadLabel: "CPU 平均負荷",
      cpuLoadSub: "サンプリング窓の平滑使用率",
      memoryCurrentLabel: "現在メモリ",
      memoryPeakLabel: "ピークメモリ",
      memoryHeapLabel: "JS ヒープ",
      memoryProcessUsedLabel: "当プロセス使用",
      memoryOtherUsedLabel: "他プロセス使用",
      memoryTotalUsedLabel: "合計使用",
      memorySub: (currentRss: string, heapUsed: string): string =>
        `現在 RSS ${currentRss} · ヒープ ${heapUsed}`,
      memoryHeapSub: (heapUsed: string): string => `JS ヒープ ${heapUsed}`,
      managedChatsLabel: "/init 済み管理群",
      managedChatsSub: (whitelistCount: number, blocklistCount: number): string =>
        `白リスト ${whitelistCount} · 黒リスト ${blocklistCount}`,
      activeSessionsLabel: "進行中セッション",
      activeSessionsSub: (sessions: Readonly<MiniAppActiveSessionCounts>): string =>
        `猿轡 ${sessions.gag} · 嫁ガチャ ${sessions.wed} · 認証 ${sessions.verify} · QA ${sessions.qaSet}`,
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
      moodSwitchingButton: "切替中…",
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
      viewMessagesButton: (hotCount: number, hotMax: number): string =>
        `発言を覗く (${hotCount}/${hotMax})`,
      closeDetailButton: "閉じる",
      botPermProbing: "Bot 管理者権限：まだ未検出よ。グループで何かコマンドを撃ちなさい",
      botPermAllReady: "Bot 管理者権限：メッセージ削除 / 制限 / 情報変更 全部バッチリよ",
      botPermMissingTitle: (count: number): string =>
        `不足している Bot 管理者権限 (${count} 項目)`,
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
        `群 ID: ${detail.chatId} · QAペア: ${detail.qaPairCount} · 自動削除対象: ${detail.deleteMessageTargetCount} · 自動翻訳対象: ${detail.translateTargetCount}`,
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
      searchPlaceholder: (subTab: MiniAppIdentitySubTabKey): string =>
        subTab === "whitelist"
          ? "名前 / @ユーザー名 / ID で白リスト検索"
          : "名前 / @ユーザー名 / ID で黒リスト検索",
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
      downloadButton: "ダウンロード",
      downloadingButton: "保存中…",
      downloadedToast: (fileName: string): string =>
        `雑魚のために ${fileName} をダウンロードしてあげたわよ♡`,
      deleteButton: "画像を削除",
      deletingButton: "削除中…",
      closePreviewButton: "プレビューを閉じる",
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

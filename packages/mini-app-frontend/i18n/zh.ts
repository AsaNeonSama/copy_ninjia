import type {
  MiniAppActiveSessionCounts,
  MiniAppCapabilityDetailItem,
  MiniAppCapabilityStatus,
  MiniAppChatDetail,
  MiniAppFeatureKey,
  MiniAppIdentitySubTabKey,
} from "../types/miniApp";
import type {
  MiniAppServerNoticeParams,
  MiniAppTranslations,
} from "../types/miniAppI18n";

/**
 * 返回简体中文（杂鱼语气）的 Mini App 界面文案字典。
 *
 * @returns 中文界面文案对象
 */
export function getZhTranslations(): Readonly<MiniAppTranslations> {
  const capabilityLabels: Readonly<Record<string, string>> = {
    agent: "Agent 能力",
    aiChat: "AI 群聊与多模态",
    translate: "自动翻译引擎",
    adDetect: "AI 广告检测",
    stickers: "贴纸包目录",
    mood: "AI 情绪池",
    cron: "定时播报任务",
    hImage: "随机色图图库 (/h_image)",
    randomHImage: "随机色图图库 (/h_image)",
  };
  const featureShortNames: Readonly<Record<MiniAppFeatureKey, string>> = {
    init: "群受管总开关 (/init)",
    aiChat: "AI 群聊 (/ai_chat)",
    translation: "自动翻译 (/translate)",
    adDetect: "广告检测 (/ad_detect)",
    floodControl: "防刷屏禁言 (/flood_control)",
    antiRaid: "入群守卫 (/antiraid)",
    proxySend: "私聊中转发送 (/send)",
  };
  const serverNotice = (
    rawCode: string,
    params?: Readonly<MiniAppServerNoticeParams>
  ): string => {
    const code: string = rawCode.replace(/^\[[A-Z0-9_]+\]\s*/u, "").trim();
    const idText: string = params?.id !== undefined ? String(params.id) : "";
    const featureLabel: string =
      params?.feature !== undefined ? featureShortNames[params.feature] : "该功能";
    const listLabel: string =
      params?.targetList === "blocklist" ? "黑名单" : "白名单";
    switch (code) {
      case "MISSING_INIT_DATA":
      case "MALFORMED_INIT_DATA":
      case "MISSING_HASH":
      case "MISSING_USER":
        return `Telegram WebApp initData 校验失败（${code}），严禁从外部浏览器直接偷看哦，杂鱼`;
      case "INVALID_SIGNATURE":
        return `Telegram WebApp 签名校验失败（${code}），伪造签名也是没用的哦，杂鱼`;
      case "EXPIRED_AUTH_DATE":
        return `Telegram WebApp 签名凭据已过期（${code}），快回 Telegram 重新点开面板刷新签名吧，杂鱼`;
      case "FORBIDDEN_USER":
        return "只有配置好的超级管理员本尊才能进入这个 Mini App 哦，杂鱼就别乱碰啦";
      case "DIRECT_NAVIGATION_FORBIDDEN":
        return "禁止从浏览器地址栏直接导航访问受保护的图片或 SVG 资源。";
      case "CROSS_SITE_FORBIDDEN":
        return `跨站请求已被直接拦截（${code}），杂鱼别想从奇怪的地方发起调用哦`;
      case "PASSWORD_REQUIRED":
        return "Mini App 访问密码尚未验证，请先输入访问密码解锁控制台。";
      case "SESSION_EXPIRED":
        return "Mini App 访问认证已满 45 分钟过期或无效，请重新输入访问密码。";
      case "PASSWORD_LOCKED":
        return `密码连续输错已达 3 次，当前超级管理员 ID 已被锁定，30 分钟内无法访问${params?.remainingMinutes !== undefined ? `（剩余约 ${params.remainingMinutes} 分钟）` : ""}。`;
      case "INVALID_PASSWORD":
        return `访问密码错误${params?.remainingAttempts !== undefined ? `，还剩 ${params.remainingAttempts} 次尝试机会` : ""}（连续输错 3 次将锁定 30 分钟）。`;
      case "INVALID_TOTP_CODE":
        return params?.remainingAttempts !== undefined
          ? `Google Authenticator 6 位动态验证码错误，还剩 ${params.remainingAttempts} 次尝试机会（连续输错 3 次将锁定 30 分钟）。`
          : "6 位动态验证码不正确，请确认 Google Authenticator 当前显示的验证码。";
      case "TOTP_SETUP_EXPIRED":
        return "待绑定的验证器二维码已过期或不存在，请重新点击生成二维码。";
      case "TOTP_ENABLED":
        return "已成功启用 Google Authenticator 验证器。";
      case "TOTP_UPDATED":
        return "已成功更新 Google Authenticator 验证器。";
      case "TOTP_DELETED":
        return "已删除 Google Authenticator 验证器，已恢复使用访问密码验证。";
      case "MOOD_SWITCHED":
        return params?.mood
          ? `哼，本天才现在的心情已经切换成「${params.mood}」啦♡`
          : "哼，已经帮杂鱼切换好全局情绪啦♡";
      case "MOOD_SWITCH_FAILED":
        return "啧，情绪切换失败了，AI Worker 或情绪配置还没准备好呢♡";
      case "INVALID_CHAT_ID":
        return "无效的群聊 ID。";
      case "CHAT_NOT_FOUND":
        return "该群未开启 /init 或不存在。";
      case "INVALID_CHAT_FEATURE_PARAMS":
        return "请求参数格式非法：需要合法的 feature 与布尔值 enabled。";
      case "CHAT_NOT_INITIALIZED":
        return "该群当前未开启 /init，已不在受管群列表中。";
      case "CHAT_INIT_ALREADY_ENABLED":
        return "该群已处于 /init 开启状态。";
      case "CHAT_INIT_DISABLED":
        return "已关闭该群 /init 总开关并从受管列表中移除。";
      case "CHAT_INIT_DISABLED_TEARDOWN_FAILED":
        return "已关闭 /init 总开关，但部分运行时状态清理失败。";
      case "FEATURE_CONFIG_NOT_READY":
        return `${featureLabel}配置未就绪${params?.configFile !== undefined ? ` (${params.configFile})` : ""}，无法开启。`;
      case "FEATURE_ENABLED":
        return `已开启 ${featureLabel}。`;
      case "FEATURE_DISABLED":
        return `已关闭 ${featureLabel}。`;
      case "PROXY_SEND_ENABLED":
        return "已将该群设为私聊中转发送目标 (/send)。";
      case "PROXY_SEND_DISABLED":
        return "已停止该群的私聊中转发送 (/send finish)。";
      case "INVALID_IDENTITY_PARAMS":
        return "请求参数非法：需要非零安全整数 id 与布尔值 enabled。";
      case "INVALID_IDENTITY_ID":
        return "笨蛋杂鱼♡，连身份 ID 都填错啦（必须是非零安全整数）！";
      case "INVALID_PERMISSION_PARAMS":
        return "请求参数非法：需要合法的权限键 key 与布尔值 value。";
      case "INVALID_PICKER_PARAMS":
        return "请求参数非法：需要合法的 targetList 与 subjectKind。";
      case "INVALID_PICKER_REQUEST_ID":
        return "请求参数非法：需要正整数 requestId。";
      case "SUPER_ADMIN_EXEMPT":
        return "杂鱼♡，超级管理员天生就拥有全部最高权限，才不需要塞进白名单表呢！";
      case "BLOCKLIST_SUPER_ADMIN_FORBIDDEN":
        return "笨蛋杂鱼♡，居然想把超级管理员关进黑名单？做梦去吧！";
      case "IDENTITY_STORAGE_UNAVAILABLE":
        return "啧，身份策略存储暂时没空理你，杂鱼稍后再试♡";
      case "IDENTITY_IN_BLOCKLIST":
        return `笨蛋杂鱼♡，ID ${idText} 现在正关在黑名单里呢，想放进白名单就先去解封！`;
      case "IDENTITY_IN_WHITELIST":
        return `笨蛋杂鱼♡，ID ${idText} 受白名单保护呢，不许直接塞进黑名单！`;
      case "WHITELIST_DUPLICATE":
        return `笨蛋杂鱼♡，ID ${idText} 早就已经在白名单里啦，不许重复添加！`;
      case "WHITELIST_ADDED":
        return `哼，已帮杂鱼把 ID ${idText} 放进白名单并授予默认权限啦♡`;
      case "WHITELIST_REMOVED":
        return `哼，已经把 ID ${idText} 从白名单里踢出去啦♡`;
      case "WHITELIST_NOT_FOUND":
        return `杂鱼♡，ID ${idText} 原本就不在白名单里哦。`;
      case "WHITELIST_PERSIST_FAILED":
        return "啧，白名单变更落盘失败了，杂鱼快去检查数据库写入状态♡";
      case "BLOCKLIST_DUPLICATE":
        return `笨蛋杂鱼♡，ID ${idText} 早就已经在黑名单里啦，不许重复添加！`;
      case "BLOCKLIST_ADDED": {
        const fanOutNote: string =
          params?.totalChats !== undefined && params.totalChats > 0
            ? `，已在 ${params.affectedChats ?? 0}/${params.totalChats} 个受管群执行封禁`
            : "";
        const persistNote: string =
          params?.persisted === false ? "（注意：磁盘持久化确认未完成）" : "";
        return `哼，已帮杂鱼把 ID ${idText} 关进黑名单啦${fanOutNote}${persistNote}♡`;
      }
      case "BLOCKLIST_REMOVED":
      case "BLOCKLIST_NOT_FOUND": {
        const fanOutNote: string =
          params?.totalChats !== undefined && params.totalChats > 0
            ? `，已在 ${params.affectedChats ?? 0}/${params.totalChats} 个受管群解除封禁`
            : "";
        const persistNote: string =
          params?.persisted === false ? "（注意：磁盘持久化确认未完成）" : "";
        const base: string =
          code === "BLOCKLIST_REMOVED"
            ? `哼，已把 ID ${idText} 从黑名单放出来啦`
            : `杂鱼，ID ${idText} 原本就不在黑名单里`;
        return `${base}${fanOutNote}${persistNote}♡`;
      }
      case "PERMISSION_UPDATED":
        return `已将 ID ${idText} 的 ${params?.key ?? ""} 设为 ${String(params?.value ?? true)}。`;
      case "PERMISSION_UNCHANGED":
        return `ID ${idText} 的 ${params?.key ?? ""} 原本就是 ${String(params?.value ?? true)}。`;
      case "ALL_PERMISSIONS_ENABLED":
        return `已开启 ID ${idText} 的全部白名单权限。`;
      case "ALL_PERMISSIONS_UNCHANGED":
        return `ID ${idText} 的全部权限原本已开启。`;
      case "PERMISSION_PERSIST_FAILED":
        return "权限变更落盘失败，请检查数据库写入状态。";
      case "PICKER_PREPARE_FAILED":
        return "无法创建 Telegram 原生选择器预备按钮，请确认 Bot API 支持 savePreparedKeyboardButton 或改用 ID 直接添加。";
      case "PICKER_IMPORT_ADDED": {
        const added: number = params?.addedCount ?? 0;
        const skipped: number = params?.skippedCount ?? 0;
        const dup: number = params?.duplicateCount ?? 0;
        const dupSuffix: string =
          dup > 0 ? `，其中 ${dup} 个已在${listLabel}中（已去重拦截）` : "";
        return `哼，已帮杂鱼把 ${added} 个身份加入${listLabel}${skipped > 0 ? `（跳过 ${skipped} 个${dupSuffix}）` : ""}♡`;
      }
      case "PICKER_IMPORT_DUPLICATE":
        return `笨蛋杂鱼♡，选中的 ${params?.duplicateCount ?? 0} 个目标早就已经在${listLabel}里啦，不许重复添加！`;
      case "PICKER_IMPORT_EMPTY":
        return `杂鱼♡，未能将所选身份加入${listLabel}（共跳过 ${params?.skippedCount ?? 0} 个）。`;
      case "GALLERY_IMAGE_ADDED":
        return `哼，本天才已按 SHA-256 帮杂鱼收录好啦：${params?.fileName ?? ""}♡`;
      case "GALLERY_IMAGE_EXISTING":
        return `笨蛋杂鱼♡，图库里早就有一模一样的 SHA-256 图片啦：${params?.fileName ?? ""}`;
      case "GALLERY_DIRECTORY_MISSING":
        return "啧，当前配置的图库目录不存在，杂鱼还没创建好目录就没法入库♡";
      case "GALLERY_IMAGE_EMPTY":
        return "笨蛋杂鱼♡，上传的图片内容居然是空的！";
      case "GALLERY_IMAGE_TOO_LARGE":
        return "杂鱼♡，图片体积超过 10 MiB 上限啦，塞不进去！";
      case "GALLERY_UNSUPPORTED_FORMAT":
        return "笨蛋杂鱼♡，只支持 JPEG、PNG 或 WebP 格式的图片哦！";
      case "GALLERY_INVALID_DIMENSIONS":
        return `杂鱼♡，图片尺寸 (${params?.width ?? 0}×${params?.height ?? 0}) 不符合 Telegram 发送门槛（宽高之和 ≤ 10000 且长宽比 ≤ 20）！`;
      case "GALLERY_UPLOAD_FAILED":
        return "啧，图片尺寸解析或写入图库目录失败了，杂鱼快去检查文件或磁盘♡";
      case "GALLERY_UPLOAD_READ_FAILED":
        return "无法读取上传的图片请求体。";
      case "GALLERY_IMAGE_DELETED":
        return `哼，本天才已经帮杂鱼把 ${params?.fileName ?? ""} 删掉啦♡`;
      case "GALLERY_IMAGE_NOT_FOUND":
        return "杂鱼♡，这张图片早就已经被删掉或者不存在啦！";
      case "GALLERY_INVALID_FILE_NAME":
        return "笨蛋杂鱼♡，连图片文件名格式都搞错了！";
      case "GALLERY_DELETE_FAILED":
        return "啧，从图库目录删除图片失败了，杂鱼快去检查磁盘权限♡";
      default:
        return code;
    }
  };
  return {
    languageLabel: "中",
    appTitle: "Bot 控制台♡",
    appSubtitle: "专为杂鱼管理员准备的本天才指挥舱",
    superAdminBadge: "SuperAdmin",
    lockButton: "锁定",
    lockSessionToast: "哼，已经帮粗心的杂鱼把会话锁上啦♡",
    sessionExpiredToast: "杂鱼，45 分钟会话早就过期啦，快乖乖重输密码！",
    themeLightLabel: "亮色",
    themeDarkLabel: "暗色",
    sidebarTitle: "导航菜单",
    sidebarSubtitle: "杂鱼想去哪个模块巡视呀？",
    sidebarOpenAria: "展开侧边导航菜单",
    sidebarCloseAria: "收起侧边导航菜单",
    sidebarFooterHint: "本天才全天候帮杂鱼盯着系统状态呢♡",
    tabs: {
      status: "实时状态",
      chats: "受管群聊",
      identities: "权限控制",
      gallery: "色图图库",
      totp: "验证器",
    },
    tabDescriptions: {
      status: "CPU、内存、出站门控与子系统状态",
      chats: "已 /init 群开关与热 256 条发言",
      identities: "白名单 18 项权限与黑名单管理",
      gallery: "/h_image 图库预览、上传与删除",
      totp: "谷歌验证器 (TOTP) 绑定、替换与删除",
    },
    serverNotice,
    gate: {
      deniedTitle: "禁止访问啦，杂鱼♡",
      deniedDescription:
        "哼，你没有权限从外部浏览器或未经授权的客户端偷看这个控制台哦，杂鱼。",
      deniedNodeClientSub: "访问端",
      deniedNodeClientTitle: "杂鱼的浏览器",
      deniedNodeClientState: "运行中",
      deniedNodeGatewaySub: "访问网关",
      deniedNodeGatewayTitle: "鉴权守卫",
      deniedNodeGatewayState: (status: number): string => `${status} 已拦截`,
      deniedNodeOriginSub: "源站服务",
      deniedNodeOriginState: "受保护中",
      deniedWhatHappenedTitle: "发生什么事啦，杂鱼？",
      deniedWhatHappenedDesc:
        "这个端点强制执行严格的 Telegram WebApp 签名校验与超级管理员门禁控制哦。杂鱼刚才发出的请求没能通过策略校验，已经被直接踢回去啦♡",
      deniedPolicyDetailLabel: (code: string): string => `策略详情 (${code})`,
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
      deniedWhatCanIDoTitle: "杂鱼现在该怎么办？",
      deniedWhatCanIDoDesc:
        "严禁在 Telegram 之外直接通过 HTTP 访问哦。如果你真是超级管理员本尊，就乖乖去 Telegram 打开与 Bot 的私聊，点击 App 按钮并输入访问密码吧，杂鱼。",
      passwordBadge: "二次密码门禁",
      passwordTitle: "交出访问密码，杂鱼♡",
      passwordSubtitle:
        "Telegram 签名倒是勉强过关了，再输入控制台访问密码解锁 45 分钟会话吧（连续输错 3 次直接锁你 30 分钟哦）。",
      passwordPlaceholder: "快输入访问密码，别输错哦杂鱼…",
      passwordEmptyHint: "笨蛋杂鱼，密码框还是空的就想蒙混过关？",
      passwordSubmitting: "本天才核验中…",
      passwordSubmitButton: "乖乖解锁控制台",
      totpBadge: "谷歌验证器门禁",
      totpTitle: "交出 6 位动态码，杂鱼♡",
      totpSubtitle:
        "已启用 Google Authenticator 验证器优先保护，请输入当前 6 位动态验证码解锁 45 分钟会话（连续输错 3 次锁定 30 分钟哦）。",
      totpPlaceholder: "输入 6 位谷歌验证器动态码…",
      totpEmptyHint: "笨蛋杂鱼，先填满 6 位数字动态验证码再点解锁啦！",
      totpSubmitButton: "验证动态码并解锁",
      unlockedToast: "哼，算你识相，45 分钟会话给你解锁啦♡",
    },
    totp: {
      sectionTitle: "Google Authenticator 验证器",
      enabledBadge: "已启用优先验证",
      disabledBadge: "未启用 (使用密码)",
      statusDescEnabled: (maskedSecret: string, updatedAtText: string): string =>
        `当前唯一验证器密钥：${maskedSecret} · 更新于 ${updatedAtText}（登录时优先使用验证器）`,
      statusDescDisabled:
        "尚未绑定谷歌验证器，当前使用 bot.json 访问密码登录。仅限在本控制台生成二维码绑定唯一验证器。",
      addButton: "添加验证器",
      modifyButton: "修改验证器",
      deleteButton: "删除验证器",
      qrGuideText:
        "请用 Google Authenticator 扫描下方二维码（或手动输入 Base32 密钥），然后输入显示的 6 位动态码完成激活：",
      secretLabel: "Base32 密钥：",
      codePlaceholder: "输入 6 位动态验证码…",
      verifyEnableButton: "验证并保存",
      verifyingButton: "验证中…",
      cancelSetupButton: "取消",
      confirmDeleteTotp:
        "杂鱼，确定要删除当前的 Google Authenticator 验证器吗？删除后将恢复使用访问密码验证哦！",
    },
    pagination: {
      summary: (total: number, page: number, totalPages: number): string =>
        `共 ${total} 条 · 第 ${page}/${totalPages} 页`,
      pageSizeOption: (size: number): string => `${size}/页`,
      firstPageAria: "首页",
      prevPageAria: "上页",
      nextPageAria: "下页",
      lastPageAria: "末页",
    },
    confirmDialog: {
      title: "本天才的二次确认",
      confirmButton: "确认执行",
      cancelButton: "算了，手滑啦",
    },
    status: {
      loadingText: "正在读取实时状态…",
      uptimeLabel: "进程运行时长",
      updatedAtSub: (timeText: string): string => `刷新于 ${timeText}`,
      cpuLoadLabel: "CPU 平均负载",
      cpuLoadSub: "平滑采样",
      memoryCurrentLabel: "当前内存",
      memoryPeakLabel: "峰值内存",
      memoryHeapLabel: "JS 堆内存",
      memoryProcessUsedLabel: "当前进程内存占用",
      memoryOtherUsedLabel: "其他进程内存占用",
      memoryTotalUsedLabel: "总占用",
      memorySub: (currentRss: string, heapUsed: string): string =>
        `当前 RSS ${currentRss} · 堆 ${heapUsed}`,
      memoryHeapSub: (heapUsed: string): string => `JS 堆占用 ${heapUsed}`,
      managedChatsLabel: "已 /init 受管群",
      managedChatsSub: (whitelistCount: number, blocklistCount: number): string =>
        `白名单 ${whitelistCount} · 黑名单 ${blocklistCount}`,
      activeSessionsLabel: "活跃交互会话",
      activeSessionsSub: (
        sessions: Readonly<MiniAppActiveSessionCounts>
      ): readonly [string, string, string, string] => [
        `口球 ${sessions.gag}`,
        `娶群友 ${sessions.wed}`,
        `验证 ${sessions.verify}`,
        `问答 ${sessions.qaSet}`,
      ],
      outboundGateLabel: "Telegram 出站门控",
      outboundGateSub: (waiting: number, retrySize: number, retryMax: number): string =>
        `排队 ${waiting} · 重试队列 ${retrySize}/${retryMax}`,
      capabilitiesSectionTitle: "功能配置与子系统就绪度",
      capabilityReadyBadge: "已就绪",
      capabilityMissingBadge: "未配置",
      capabilityItemCount: (count: number): string => `${count} 项`,
      moodCurrentLabel: "当前情绪",
      moodCurrentActiveBadge: "当前生效",
      moodUnavailableText: "未激活 (AI Worker 未运行)",
      moodSwitchButton: "切换情绪",
      moodSwitchingButton: "切换中…",
      capabilityLabel: (capability: Readonly<MiniAppCapabilityStatus>): string =>
        capabilityLabels[capability.key] ?? capability.label,
      capabilityItem: (
        item: Readonly<MiniAppCapabilityDetailItem>
      ): Readonly<MiniAppCapabilityDetailItem> => item,
    },
    chats: {
      sectionTitle: (count: number): string => `已启用 /init 的受管群聊 (${count})`,
      refreshButton: "刷新",
      loadingChatsText: "正在帮杂鱼清点受管群列表…",
      emptyChatsHint:
        "啧，现在连一个开启 /init 的群都没有呢，杂鱼快去群里发送 /init enable 吧♡",
      lockdownBadge: "封锁冷却中",
      chatCardMeta: (chatId: number, hotCount: number, qaCount: number): string =>
        `ID: ${chatId} · 热发言 ${hotCount} 条 · QA ${qaCount} 条`,
      detailSectionTitle: "管理开关",
      viewMessagesButton: (hotCount: number, hotMax: number): string =>
        `偷看发言 (${hotCount}/${hotMax})`,
      closeDetailButton: "收起",
      botPermProbing: "Bot 管理员权限：本天才还没探测过呢，去群里发条命令吧",
      botPermAllReady: "Bot 管理员权限：删消息 / 禁言封禁 / 改群资料 全都齐活啦",
      botPermMissingTitle: (count: number): string =>
        `Bot 缺少以下 ${count} 项管理员权限`,
      botPermLabel: (rawLabel: string): string => rawLabel,
      detailStatsLine: (detail: Readonly<MiniAppChatDetail>): string =>
        `群 ID: ${detail.chatId} · 问答对: ${detail.qaPairCount} · 追着删目标: ${detail.deleteMessageTargetCount} · 追着翻目标: ${detail.translateTargetCount}`,
      featuresSectionTitle: "群功能实时开关",
      confirmDisableInit:
        "杂鱼，确定要关掉这个群的 /init 总开关吗？关掉之后运行时缓存会被彻底清空并移出列表哦！",
      featureMeta: {
        init: {
          label: "群受管总开关 (/init)",
          command: "/init",
          description: "关闭后会把该群从受管列表踢出去，并清理内存热状态",
        },
        aiChat: {
          label: "AI 群聊与记忆 (/ai_chat)",
          command: "/ai_chat",
          description: "启用本天才的群内 AI 回复、热上下文缓冲与滚动摘要",
        },
        translation: {
          label: "全群自动翻译 (/translate)",
          command: "/translate",
          description: "开启或关闭全群消息自动翻译与目标成员追翻",
        },
        adDetect: {
          label: "AI 广告检测 (/ad_detect)",
          command: "/ad_detect",
          description: "对非白名单新发言进行广告分类识别与自动处置",
        },
        floodControl: {
          label: "防刷屏禁言 (/flood_control)",
          command: "/flood_control",
          description: "滑动窗口内高频刷屏时自动禁言吵闹的群成员",
        },
        antiRaid: {
          label: "入群突袭守卫 (/antiraid)",
          command: "/antiraid",
          description: "检测短时间内异常扎堆入群并自动进入私密封锁模式",
        },
        proxySend: {
          label: "私聊代发目标群 (/send)",
          command: "/send",
          description: "把该群设成杂鱼在私聊里用 /send 代发消息的目标群",
        },
      },
    },
    messages: {
      backButton: "返回群详情",
      refreshButton: "刷新",
      headerTitle: (title: string, total: number, maxCapacity: number): string =>
        `${title} · 热发言 (${total}/${maxCapacity})`,
      headerMeta: (chatId: number): string =>
        `群 ID: ${chatId} · 仅展示最近 256 条热缓冲区发言，压缩摘要才不给杂鱼看呢`,
      loadingText: "正在帮杂鱼翻阅热发言记录…",
      emptyHint: "这个群的热缓冲区里空空如也，一条发言都没有呢杂鱼♡",
      replyBadge: (name: string, preview: string): string =>
        `回复 ${name}${preview.length > 0 ? `: ${preview}` : ""}`,
      forwardBadge: (from: string): string => `转发自 ${from}`,
      emptyMediaPlaceholder: "(无文本媒体消息)",
    },
    identities: {
      whitelistTab: "权限",
      blocklistTab: "黑名单",
      searchPlaceholder: "id/name",
      searchClearAria: "清空搜索词",
      searchDebounceHint: "0.5s 防抖检索中…",
      addFoldButton: "添加用户",
      addModes: {
        id: "按数字 ID 添加",
        users: "按联系人选择添加",
        channel: "按频道选择添加",
      },
      addModeDescriptions: {
        id: "直接输入用户正整数 ID 或 -100 开头的频道 ID",
        users: "唤起 Telegram 原生联系人多选器挑选好友",
        channel: "唤起 Telegram 原生频道选择器挑选广播频道",
      },
      idInputPlaceholder: "输入用户正整数 ID 或 -100... 频道 ID",
      idConfirmButton: "确认塞进去",
      idCancelButton: "收起",
      invalidIdToast: "笨蛋杂鱼，连非零整数 ID 都不会填吗（例如 123456789 或 -1001234567890）！",
      duplicateToast: (idText: string, subTab: MiniAppIdentitySubTabKey): string =>
        `笨蛋杂鱼，${idText} 早就已经在${subTab === "whitelist" ? "白名单" : "黑名单"}里啦，不许重复添加！`,
      duplicateBannerTitle: "重复添加拦截",
      pickerUnsupportedHint:
        "杂鱼当前的客户端环境不支持 Telegram.WebApp.requestChat，老老实实从 Telegram 客户端打开或者改用「按数字 ID 添加」吧",
      pickerWaitingToast: "已在 Telegram 弹出选择器，快去挑人吧杂鱼…",
      pickerCancelledToast: "哼，杂鱼居然半途取消了选择器操作♡",
      pickerTimeoutToast: "等半天都没收到选择器回执，杂鱼手动刷新看看吧",
      loadingText: "正在帮杂鱼翻名单册子…",
      emptySearchHint: (query: string): string =>
        `啧，找不到名称或 ID 包含「${query}」的目标呢，杂鱼是不是拼错啦？`,
      emptyListHint: (subTab: MiniAppIdentitySubTabKey): string =>
        subTab === "whitelist"
          ? "白名单里空荡荡的呢，点右上角「添加用户」塞几个进来吧杂鱼"
          : "黑名单里还没有倒霉蛋呢，点右上角「添加用户」关几个进来吧杂鱼",
      channelBadge: "频道",
      userBadge: "用户",
      blockedAtText: (timeText: string): string => `拉黑于 ${timeText}`,
      enabledPermCountText: (enabledCount: number, totalCount: number): string =>
        `已开启 ${enabledCount}/${totalCount} 项权限`,
      configurePermButton: "权限配置",
      removeWhitelistButton: "移出",
      removeBlocklistButton: "解封",
      confirmRemoveWhitelist: (displayName: string, id: number): string =>
        `杂鱼，确定要把 ${displayName} (${id}) 从白名单踢出去吗？`,
      confirmRemoveBlocklist: (displayName: string, id: number): string =>
        `杂鱼，确定要把 ${displayName} (${id}) 从黑名单放出来并在受管群解封吗？`,
    },
    permissionDrawer: {
      title: (displayName: string): string => `${displayName} 的权限开关`,
      subtitle: (id: number, isChannel: boolean): string =>
        `ID: ${id} · ${isChannel ? "频道身份" : "用户身份"} · 实时落盘 SQLite`,
      enableAllButton: "一键全开 18 项",
      closeButton: "收起",
      labels: {
        isCanMute: "/mute 手动禁言",
        isCanUnMute: "/unmute 解除禁言",
        isCanGag: "/gag 互动塞口球",
        isCanViewBotStatus: "/bot_status 查看运行状态",
        isCanBlock: "/block 拉人进黑名单",
        isCanUnBlock: "/unblock 解除黑名单",
        isCanWhiteOther: "/white 代加他人进白名单",
        isCanSwitchMood: "/switch_mood 切换本天才心情",
        isCanBypassAdDetection: "广告检测免检特权",
        isCanBypassFloodControl: "防刷屏禁言免检特权",
        isCanControllAIPermission: "/ai_chat 开关控制",
        isCanClearContext: "/clear 清空 AI 上下文",
        isCanControllAdDetectPermission: "/ad_detect 开关控制",
        isCanControllFloodControlPermission: "/flood_control 开关控制",
        isCanControllTranslatePermission: "/translate 开关控制",
        isCanControllAntiRaidPermission: "/antiraid 开关控制",
        isCanControllQaPermission: "/qa 问答词条管理",
        isCanAddHImage: "/h_image add 往图库塞图",
      },
    },
    gallery: {
      sectionTitle: "色图图库",
      refreshButton: "刷新",
      uploadingButton: "入库中…",
      uploadButton: "上传新图",
      directoryMissingText: (_directory: string): string =>
        "图库存储尚未就绪，本天才不会自动建目录哦",
      directoryReadyText: (_directory: string): string =>
        "图库存储已就绪 · 支持 JPEG / PNG / WebP (≤ 10 MiB)",
      previewTitle: (shortName: string): string => `大图预览 · ${shortName}`,
      downloadButton: "下载图片",
      downloadingButton: "下载中…",
      downloadedToast: (fileName: string): string =>
        `已经帮杂鱼把 ${fileName} 下载好啦♡`,
      deleteButton: "删除图片",
      deletingButton: "删除中…",
      closePreviewButton: "关闭预览",
      confirmDeleteImage: (fileName: string): string =>
        `杂鱼，确定要从图库永久删掉这张图片 (${fileName}) 吗？删掉可就找不回来咯！`,
      deletedToast: (fileName: string): string =>
        `哼，已经帮杂鱼把 ${fileName} 从图库删掉啦♡`,
      loadingText: "正在帮杂鱼翻找图库相册…",
      emptyMissingDirHint:
        "当前配置的图库目录还不存在呢，杂鱼快去服务器上建好目录再来看吧",
      emptyGalleryHint:
        "图库目录里连一张图都没有呢，杂鱼快点右上角「上传新图」塞几张进来吧♡",
    },
  };
}

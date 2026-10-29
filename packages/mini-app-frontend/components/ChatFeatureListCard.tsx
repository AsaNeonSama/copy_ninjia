import { Fragment, memo } from "react";
import type React from "react";
import { MINI_APP_FEATURE_KEYS } from "../consts/miniApp";
import { getFeatureDisplayMeta } from "../libs/formatters";
import type {
  MiniAppChatDetail,
  MiniAppFeatureDisplayMeta,
  MiniAppFeatureKey,
  MiniAppLanguage,
} from "../types/miniApp";
import type { MiniAppTranslations } from "../types/miniAppI18n";

/** `ChatFeatureSwitchRow` 单项群功能开关行的属性参数。 */
interface ChatFeatureSwitchRowProps {
  /** 功能开关键。 */
  readonly featureKey: MiniAppFeatureKey;
  /** 当前功能是否已开启。 */
  readonly enabled: boolean;
  /** 当前功能行是否处于切换骨架态。 */
  readonly isRowLoading: boolean;
  /** 是否有任意群功能切换请求在途（禁用其余开关交互）。 */
  readonly switchDisabled: boolean;
  /** 当前界面语言。 */
  readonly language: MiniAppLanguage;
  /** 切换某项群功能开关的回调。 */
  readonly onToggleFeature: (
    feature: MiniAppFeatureKey,
    enabled: boolean
  ) => Promise<void>;
}

/**
 * 渲染单项群功能开关行（当前行切换中展示标题、命令胶囊、描述与拨杆骨架占位，空闲时展示功能说明与滑块开关）。
 *
 * @param props 单项群功能行属性
 * @returns React 节点
 */
function ChatFeatureSwitchRowView({
  featureKey,
  enabled,
  isRowLoading,
  switchDisabled,
  language,
  onToggleFeature,
}: ChatFeatureSwitchRowProps): React.JSX.Element {
  const meta: MiniAppFeatureDisplayMeta = getFeatureDisplayMeta(
    featureKey,
    language
  );
  return (
    <div
      className={`row chat-feature-row ${
        isRowLoading ? "skeleton-switch-row is-loading" : ""
      }`}
      aria-busy={isRowLoading}
    >
      {isRowLoading ? (
        <Fragment>
          <div className="row-main">
            <div className="skeleton-title-with-badge">
              <div className="skeleton-line skeleton-switch-label" />
              <div className="skeleton-line skeleton-cmd-pill" />
            </div>
            <div className="skeleton-line skeleton-switch-desc" />
          </div>
          <div className="skeleton-line skeleton-switch-pill" />
        </Fragment>
      ) : (
        <Fragment>
          <div className="row-main">
            <div className="row-title">
              {meta.label}{" "}
              <span className="badge">{meta.command}</span>
            </div>
            <div className="row-sub">{meta.description}</div>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={enabled}
              disabled={switchDisabled}
              onChange={(
                event: React.ChangeEvent<HTMLInputElement>
              ): void => {
                const nextChecked: boolean = (
                  event.currentTarget as unknown as {
                    readonly checked: boolean;
                  }
                ).checked;
                void onToggleFeature(featureKey, nextChecked);
              }}
            />
            <span className="slider" />
          </label>
        </Fragment>
      )}
    </div>
  );
}

/** 按属性浅比较跳过重渲染的单项群功能开关行组件。 */
const ChatFeatureSwitchRow: React.MemoExoticComponent<
  typeof ChatFeatureSwitchRowView
> = memo(ChatFeatureSwitchRowView);

/** `ChatFeatureListCard` 群功能开关列表卡片的属性参数。 */
export interface ChatFeatureListCardProps {
  /** 当前群详情。 */
  readonly chatDetail: Readonly<MiniAppChatDetail>;
  /** 当前正在切换中的功能键（无在途请求时为 `null`）。 */
  readonly togglingFeature: MiniAppFeatureKey | null;
  /** 当前界面语言。 */
  readonly language: MiniAppLanguage;
  /** 当前语言的翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 切换某项群功能开关的回调。 */
  readonly onToggleFeature: (
    feature: MiniAppFeatureKey,
    enabled: boolean
  ) => Promise<void>;
}

/**
 * 渲染群详情页中的七项群功能开关卡片列表（`/init`、`/ai_chat`、`/translate`、`/ad_detect`、`/flood_control`、`/antiraid`、`/send`；
 * 切换某项开关时仅对应单行展示骨架动画）。
 *
 * @param props 组件属性
 * @returns React 节点
 */
function ChatFeatureListCardView({
  chatDetail,
  togglingFeature,
  language,
  t,
  onToggleFeature,
}: ChatFeatureListCardProps): React.JSX.Element {
  const switchDisabled: boolean = togglingFeature !== null;
  return (
    <div className="card chat-feature-card">
      <div className="card-title">
        <span>{t.chats.featuresSectionTitle}</span>
      </div>
      {MINI_APP_FEATURE_KEYS.map(
        (key: MiniAppFeatureKey): React.JSX.Element => (
          <ChatFeatureSwitchRow
            key={key}
            featureKey={key}
            enabled={chatDetail.features[key]}
            isRowLoading={togglingFeature === key}
            switchDisabled={switchDisabled}
            language={language}
            onToggleFeature={onToggleFeature}
          />
        )
      )}
    </div>
  );
}

/** 按属性浅比较跳过重渲染的群功能开关卡片：问答表单输入等与本卡片无关的仓库更新不重新渲染。 */
export const ChatFeatureListCard: React.MemoExoticComponent<
  typeof ChatFeatureListCardView
> = memo(ChatFeatureListCardView);

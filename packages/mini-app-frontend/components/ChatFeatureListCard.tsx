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
 * 渲染群详情页中的七项群功能开关卡片列表（`/init`、`/ai_chat`、`/translate`、`/ad_detect`、`/flood_control`、`/antiraid`、`/send`）。
 *
 * @param props 组件属性
 * @returns React 节点
 */
export function ChatFeatureListCard({
  chatDetail,
  togglingFeature,
  language,
  t,
  onToggleFeature,
}: ChatFeatureListCardProps): React.JSX.Element {
  return (
    <div className="card">
      <div className="card-title">
        <span>{t.chats.featuresSectionTitle}</span>
      </div>
      {MINI_APP_FEATURE_KEYS.map(
        (key: MiniAppFeatureKey): React.JSX.Element => {
          const enabled: boolean = chatDetail.features[key];
          const meta: MiniAppFeatureDisplayMeta = getFeatureDisplayMeta(
            key,
            language
          );
          return (
            <div key={key} className="row">
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
                  disabled={togglingFeature !== null}
                  onChange={(
                    event: React.ChangeEvent<HTMLInputElement>
                  ): void => {
                    const nextChecked: boolean = (
                      event.currentTarget as unknown as {
                        readonly checked: boolean;
                      }
                    ).checked;
                    void onToggleFeature(key, nextChecked);
                  }}
                />
                <span className="slider" />
              </label>
            </div>
          );
        }
      )}
    </div>
  );
}

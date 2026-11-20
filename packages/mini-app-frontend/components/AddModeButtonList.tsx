import { memo } from "react";
import type React from "react";
import { MINI_APP_IDENTITY_ADD_MODES } from "../consts/miniApp";
import {
  ChannelSvgIcon,
  HashtagSvgIcon,
  UserSvgIcon,
} from "../resource";
import type {
  MiniAppIdentityAddMode,
  MiniAppPickerSubjectKind,
} from "../types/miniApp/identities";
import type { MiniAppTranslations } from "../types/miniAppI18n";
import { LoadingDotsWave } from "./animations/LoadingDotsWave";

/** `AddModeButtonList` 三合一添加模式按钮列表组件的属性参数。 */
export interface AddModeButtonListProps {
  /** 按 ID 添加的内联表单当前是否已展开。 */
  readonly idFormOpen: boolean;
  /** 按钮是否处于禁用状态。 */
  readonly disabled: boolean;
  /** 正在预备原生选择器的模式键（仅 `"users"` 或 `"channel"` 播放三点加载动画；空闲时为 `null`）。 */
  readonly loadingMode?: MiniAppPickerSubjectKind | null;
  /** 折叠面板当前是否可见（决定键盘焦点 `tabIndex`）。 */
  readonly interactive: boolean;
  /** 额外附加在网格容器上的 CSS 类名（可选）。 */
  readonly className?: string;
  /** 当前语言的翻译字典。 */
  readonly t: Readonly<MiniAppTranslations>;
  /** 点击某个添加模式按钮时的回调。 */
  readonly onSelectMode: (mode: MiniAppIdentityAddMode) => void;
}

/**
 * 根据添加模式键渲染对应的 SVG 图标。
 *
 * @param mode 添加模式键
 * @returns SVG 图标元素
 */
function renderAddModeIcon(mode: MiniAppIdentityAddMode): React.JSX.Element {
  if (mode === "id") return <HashtagSvgIcon size={14} />;
  if (mode === "users") return <UserSvgIcon size={14} />;
  return <ChannelSvgIcon size={14} />;
}

/**
 * 渲染黑白名单与群目标管理共用的三合一添加模式按钮列表（按 ID、选择好友/联系人、选择公开频道）。
 *
 * @param props 组件属性
 * @returns React 节点
 */
function AddModeButtonListView({
  idFormOpen,
  disabled,
  loadingMode = null,
  interactive,
  className,
  t,
  onSelectMode,
}: AddModeButtonListProps): React.JSX.Element {
  const gridClassName: string =
    className !== undefined && className.length > 0
      ? `add-mode-grid ${className}`
      : "add-mode-grid";
  return (
    <div className={gridClassName}>
      {MINI_APP_IDENTITY_ADD_MODES.map(
        (mode: MiniAppIdentityAddMode): React.JSX.Element => {
          const isActive: boolean = mode === "id" && idFormOpen;
          const isLoading: boolean =
            (mode === "users" || mode === "channel") && loadingMode === mode;
          const cardClassName: string = `add-mode-card${isActive ? " active" : ""}${isLoading ? " is-loading" : ""}`;
          return (
            <button
              key={mode}
              type="button"
              className={cardClassName}
              disabled={disabled}
              aria-busy={isLoading ? true : undefined}
              tabIndex={interactive ? 0 : -1}
              onClick={(): void => {
                onSelectMode(mode);
              }}
            >
              <div className="add-mode-head">
                {renderAddModeIcon(mode)}
                <span>{t.identities.addModes[mode]}</span>
              </div>
              <div className="add-mode-desc">
                {t.identities.addModeDescriptions[mode]}
              </div>
              {isLoading
                ? (
                  <span className="add-mode-loading-overlay" aria-hidden="true">
                    <LoadingDotsWave />
                  </span>
                )
                : null}
            </button>
          );
        }
      )}
    </div>
  );
}

/** 按属性浅比较跳过重渲染的三合一添加模式按钮列表组件。 */
export const AddModeButtonList: React.MemoExoticComponent<
  typeof AddModeButtonListView
> = memo(AddModeButtonListView);

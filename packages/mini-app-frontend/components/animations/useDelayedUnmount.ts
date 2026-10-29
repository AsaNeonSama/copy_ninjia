import { useEffect, useRef, useState } from "react";
import type React from "react";

/** 退场动画延迟卸载钩子的返回值。 */
export interface DelayedUnmountState<T> {
  /** 当前应渲染的快照（激活态或退场动画进行中保留的上一份快照；完全卸载时为 `null`）。 */
  readonly displayValue: T | null;
  /** 是否正处于退场收起动画阶段（此时应附加 `.closing` 类名并禁用交互）。 */
  readonly isClosing: boolean;
}

/**
 * 配合 CSS 退场关键帧动画延迟卸载节点：当 `activeValue` 非空时同步更新快照且不触发额外重渲染；
 * 当 `activeValue` 变为 `null` 时保留上一份值并置 `isClosing = true`，等待 `durationMs` 退场动画播完后再清空卸载。
 *
 * @param activeValue 当前激活的值（关闭时为 `null`）
 * @param durationMs CSS 退场动画时长（毫秒）
 * @returns 当前应渲染的值与退场动画状态标志
 */
export function useDelayedUnmount<T>(
  activeValue: T | null,
  durationMs: number
): Readonly<DelayedUnmountState<T>> {
  const lastNonNullRef: React.RefObject<T | null> = useRef<T | null>(
    activeValue
  );
  if (activeValue !== null) {
    lastNonNullRef.current = activeValue;
  }
  const [unmounted, setUnmounted]: [
    boolean,
    React.Dispatch<React.SetStateAction<boolean>>
  ] = useState<boolean>(activeValue === null);

  if (activeValue !== null && unmounted) {
    setUnmounted(false);
  }

  useEffect((): (() => void) | undefined => {
    if (activeValue !== null) {
      return undefined;
    }
    if (lastNonNullRef.current === null) {
      return undefined;
    }
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
      lastNonNullRef.current = null;
      setUnmounted(true);
    }, durationMs);
    return (): void => {
      clearTimeout(timer);
    };
  }, [activeValue, durationMs]);

  return {
    displayValue: activeValue ?? (unmounted ? null : lastNonNullRef.current),
    isClosing:
      activeValue === null && !unmounted && lastNonNullRef.current !== null,
  };
}

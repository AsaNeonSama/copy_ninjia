import { useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand";

/**
 * 为当前组件实例创建并订阅一个独占的 Zustand 仓库：首次渲染时调用 `factory` 创建，组件卸载后随实例丢弃；
 * 订阅完整状态，任一字段变化都会触发该组件重渲染。
 *
 * @param factory 仓库工厂（仅在首次渲染调用一次）
 * @returns 仓库当前完整状态
 */
export function useComponentStore<T>(factory: () => StoreApi<T>): T {
  const [store]: [StoreApi<T>, unknown] = useState<StoreApi<T>>(factory);
  return useStore(store);
}

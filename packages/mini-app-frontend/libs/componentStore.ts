import { useState } from "react";
import type React from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand";

/**
 * 为当前组件实例持有稳定的 Zustand `StoreApi` 句柄（首次渲染时调用 `factory` 创建，组件卸载前保持同一引用）。
 *
 * @param factory 仓库工厂（仅在首次渲染调用一次）
 * @returns 组件实例持有的状态仓库句柄
 */
export function useComponentStoreApi<T>(factory: () => StoreApi<T>): StoreApi<T> {
  const [store]: [StoreApi<T>, React.Dispatch<React.SetStateAction<StoreApi<T>>>] =
    useState<StoreApi<T>>(factory);
  return store;
}

/**
 * 为当前组件实例创建并订阅一个独占的 Zustand 仓库：首次渲染时调用 `factory` 创建，组件卸载后随实例丢弃；
 * 订阅完整状态，任一字段变化都会触发该组件重渲染。
 *
 * @param factory 仓库工厂（仅在首次渲染调用一次）
 * @returns 仓库当前完整状态
 */
export function useComponentStore<T>(factory: () => StoreApi<T>): T {
  return useStore(useComponentStoreApi(factory));
}

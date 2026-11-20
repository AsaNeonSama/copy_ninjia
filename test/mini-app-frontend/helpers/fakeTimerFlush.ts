/**
 * Mini App 前端假定时器辅助工具：在 `jest.useFakeTimers()` 下以 `setImmediate` 排空加密传输与微任务，
 * 并按需推进假时钟直到条件或异步操作结算；当 WebCrypto 线程池尚未返回时短暂步进真实时间以等待异步解密完成。
 */

import { expect, jest } from "bun:test";
import { MINI_APP_MIN_LOADING_MS } from "../../../packages/mini-app-frontend/consts/miniApp";

/** 纯 `setImmediate` 快速排空轮数上限；超过后按 1ms 真实时间步进等待 WebCrypto 线程池结算。 */
const FAST_IMMEDIATE_TURNS: number = 32;

/** 真实时间步进等待的最大轮数（每轮 1ms，最长 1.5s）。 */
const SLOW_SYNC_TURNS: number = 1_500;

/** 在假定时器下让出一次事件循环（不依赖被冻结的 `setTimeout`）。 */
export function yieldImmediate(): Promise<void> {
  return new Promise<void>((resolve: () => void): void => {
    setImmediate(resolve);
  });
}

/**
 * 在假定时器下排空连续数轮宏任务，用于负向断言或无定时器异步结算。
 * @param turns 连续让出的宏任务轮数。
 */
export async function drainImmediate(turns: number = 40): Promise<void> {
  for (let i: number = 0; i < turns; i += 1) {
    await yieldImmediate();
  }
}

/**
 * 在假定时器下持续等待异步条件成立（不推进定时器）。
 * @param predicate 待满足的观测条件。
 */
export async function flushUntil(predicate: () => boolean): Promise<void> {
  for (let turn: number = 0; turn < FAST_IMMEDIATE_TURNS && !predicate(); turn += 1) {
    await yieldImmediate();
  }
  for (let turn: number = 0; turn < SLOW_SYNC_TURNS && !predicate(); turn += 1) {
    Bun.sleepSync(1);
    await yieldImmediate();
  }
  expect(predicate()).toBeTrue();
}

/**
 * 在假定时器下交替让出事件循环与推进定时器，直到条件成立。
 * 仅在存在待触发定时器时推进假时钟，避免 WebCrypto 异步结算前无谓推进时间。
 * @param predicate 待满足的观测条件。
 * @param stepMs 每次推进的假时钟毫秒数。
 */
export async function flushFakeTimersUntil(
  predicate: () => boolean,
  stepMs: number = MINI_APP_MIN_LOADING_MS
): Promise<void> {
  const step = async (): Promise<void> => {
    await yieldImmediate();
    if (!predicate() && jest.getTimerCount() > 0) {
      jest.advanceTimersByTime(stepMs);
      await yieldImmediate();
    }
  };
  for (let turn: number = 0; turn < FAST_IMMEDIATE_TURNS && !predicate(); turn += 1) {
    await step();
  }
  for (let turn: number = 0; turn < SLOW_SYNC_TURNS && !predicate(); turn += 1) {
    Bun.sleepSync(1);
    await step();
  }
  expect(predicate()).toBeTrue();
}

/**
 * 在假定时器下等待带最短骨架时长或延迟定时器的 Promise 结算。
 * @param pending 待等待的异步任务。
 * @param stepMs 每次推进的假时钟毫秒数。
 * @returns 原 Promise 的解析结果。
 */
export async function resolveWithFakeTimers<T>(
  pending: Promise<T>,
  stepMs: number = MINI_APP_MIN_LOADING_MS
): Promise<T> {
  let settled: boolean = false;
  void pending.then(
    (): void => {
      settled = true;
    },
    (): void => {
      settled = true;
    }
  );
  await flushFakeTimersUntil((): boolean => settled, stepMs);
  return await pending;
}

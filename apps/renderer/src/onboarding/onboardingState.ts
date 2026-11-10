/**
 * 工作台使用教程的显示状态（纯 Renderer 本地，不进 Host / client-contract）。
 *
 * - 首次进入 0.2.0 自动打开一次，且必须走完全部步骤才出现关闭按钮；
 *   走完后把当前教程版本写进 localStorage。
 * - 「帮助 → 使用教程」随时可以再开，这时随时可关。
 *
 * 教程内容大改、希望老用户再看一遍时，提高 ONBOARDING_TOUR_ID 即可。
 */

import { useSyncExternalStore } from "react";

export const ONBOARDING_TOUR_ID = "workbench-0.2.0";
export const ONBOARDING_STORAGE_KEY = "omp.onboarding.completed";

export type OnboardingMode = "first-run" | "replay";

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* 存储被阻塞时只在本次运行里记住「已看完」。 */
  }
}

let completedThisRun = false;
let autoOpenEnabled = true;

export function hasCompletedOnboarding(): boolean {
  return completedThisRun || readStorage(ONBOARDING_STORAGE_KEY) === ONBOARDING_TOUR_ID;
}

export function markOnboardingCompleted(): void {
  completedThisRun = true;
  writeStorage(ONBOARDING_STORAGE_KEY, ONBOARDING_TOUR_ID);
}

/** 首次启动是否应自动弹出教程。 */
export function shouldAutoOpenOnboarding(): boolean {
  return autoOpenEnabled && !hasCompletedOnboarding();
}

// ---- 打开 / 关闭（帮助菜单与首启门控共用一个开关） --------------------------

let current: OnboardingMode | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 从「帮助 → 使用教程」或 macOS 菜单重新打开；已在首启强制模式时保持强制。 */
export function openOnboardingTour(mode: OnboardingMode = "replay"): void {
  if (current === "first-run") return;
  current = mode;
  emit();
}

export function closeOnboardingTour(): void {
  if (current === null) return;
  current = null;
  emit();
}

export function useOnboardingTourMode(): OnboardingMode | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

/**
 * 测试辅助。大量 App 级测试会挂整棵应用并清空 localStorage；
 * `test/setup.ts` 关掉首启自动弹出，教程自己的测试再打开。
 */
export function __setOnboardingAutoOpenForTests(enabled: boolean): void {
  autoOpenEnabled = enabled;
}

export function __resetOnboardingForTests(): void {
  completedThisRun = false;
  current = null;
  try {
    globalThis.localStorage?.removeItem(ONBOARDING_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  emit();
}

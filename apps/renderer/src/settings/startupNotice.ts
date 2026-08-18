/**
 * 进入应用时的全局提示（显示层，不进 Host / client-contract）。
 *
 * 「关闭」只收起本次会话；「不再提醒」把当前文案版本写入 localStorage。
 * 之后若要再提示一次，提高 STARTUP_NOTICE_ID 即可。
 */

export const STARTUP_NOTICE_ID = "incomplete-v1";
export const STARTUP_NOTICE_STORAGE_KEY = "omp.startupNotice.dismissed";
export const PROJECT_GITHUB_URL = "https://github.com/the-snowpear/omp-studio";
export const PROJECT_GITHUB_HOST = "github.com/the-snowpear/omp-studio";

export const STARTUP_NOTICE_COPY = {
  kicker: "开发预览",
  title: "应用尚未完成",
  body: "OMP Studio 目前仍在开发中，部分功能尚未完成。使用过程中可能遇到不稳定、缺失或与最终形态不一致的能力。欢迎提交 bug、提 issue，也欢迎提供 idea。",
  hint: "可在 GitHub 仓库查看进度，或直接开 issue 参与讨论。",
  repoLabel: "项目地址",
  thanks: "感谢使用 OMP Studio。",
} as const;

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
    /* 存储被阻塞时「不再提醒」只活在本次会话。 */
  }
}

export function shouldShowStartupNotice(): boolean {
  return readStorage(STARTUP_NOTICE_STORAGE_KEY) !== STARTUP_NOTICE_ID;
}

export function dismissStartupNoticeForever(): void {
  writeStorage(STARTUP_NOTICE_STORAGE_KEY, STARTUP_NOTICE_ID);
}

/** 测试辅助：清掉持久化的「不再提醒」。 */
export function __resetStartupNoticeForTests(): void {
  try {
    globalThis.localStorage?.removeItem(STARTUP_NOTICE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

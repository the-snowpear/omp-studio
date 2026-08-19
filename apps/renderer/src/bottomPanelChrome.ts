/**
 * Bottom-bar chrome is two independent switches:
 * - `visible`: the whole tab strip (Terminal / Problems / …) is on screen
 * - `open`: the tab body is expanded, versus collapsed to the 36px strip
 *
 * The new corner control only flips `visible`. Chevron / Ctrl+J only flip
 * `open`, except they first bring a hidden bar back without changing `open`.
 */
export type BottomBarChrome = {
  readonly visible: boolean;
  readonly open: boolean;
};

/** Hide or show the tab strip; keep the body's collapsed/expanded state. */
export function toggleBottomBarVisible(chrome: BottomBarChrome): BottomBarChrome {
  return { visible: !chrome.visible, open: chrome.open };
}

/**
 * Collapse or expand the tab body. A hidden bar is shown first so the
 * existing View-menu / Ctrl+J control is not a no-op.
 */
export function toggleBottomBarOpen(chrome: BottomBarChrome): BottomBarChrome {
  if (!chrome.visible) return { visible: true, open: chrome.open };
  return { visible: true, open: !chrome.open };
}

/** Menu / palette "open this tab": bar on-screen and body expanded. */
export function revealBottomBar(): BottomBarChrome {
  return { visible: true, open: true };
}

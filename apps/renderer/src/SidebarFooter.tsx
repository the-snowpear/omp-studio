import { useEffect, useRef, useState, type RefObject } from "react";

import { Icon } from "./icons";
import { useI18n } from "./i18n";
import { transitionDelayMs, transitionMs } from "./motionClock";
import { avatarInitial } from "./settings/operatorProfile";

/**
 * 左下身份块（左栏 rail 收起后回落到这里）。
 *
 * 单独成一个组件是因为「卸载」这一步：展开时它要先等底栏的高度收完再卸载，这次
 * state 变化如果留在 AppSidebar 里，会把整棵侧栏（会话列表 + 文件树）重渲染一遍，
 * 正好落在动画收尾那几帧上，看起来就像最后抖了一下。放在这里只会重渲染这几十行。
 */
export function SidebarFooter({
  railCollapsed,
  profile,
  hasUpdate,
  version,
  status,
  menuOpen,
  onToggleMenu,
  avatarRef,
  footerRef,
}: {
  readonly railCollapsed: boolean;
  readonly profile: { readonly displayName: string; readonly avatarSrc: string };
  readonly hasUpdate: boolean;
  readonly version: string | undefined;
  readonly status: { readonly text: string; readonly tone: "ok" | "warn" | "err" };
  readonly menuOpen: boolean;
  readonly onToggleMenu: (anchor: HTMLButtonElement) => void;
  /** 头像圆本身：壳用它量落点。 */
  readonly avatarRef: RefObject<HTMLElement | null> | undefined;
  /** 底栏盒子：壳用它的底边换算落点，这里用它盯实时高度。 */
  readonly footerRef: RefObject<HTMLElement | null> | undefined;
}) {
  const { t } = useI18n();
  const localFooterRef = useRef<HTMLElement>(null);
  const footer = footerRef ?? localFooterRef;
  const [mounted, setMounted] = useState(railCollapsed);

  /* 收起那一帧就得挂上：壳要在同一帧量到头像的落点（useIdentityFlight）。 */
  if (railCollapsed && !mounted) setMounted(true);

  useEffect(() => {
    if (railCollapsed || !mounted) return;
    /* 等高度收完（含折回前的 delay）再卸载；减动效档读到的时长是 0，直接卸。 */
    const element = footer.current;
    const hold = (element === null ? 250 : transitionMs(element) + transitionDelayMs(element)) + 40;
    const timer = window.setTimeout(() => setMounted(false), hold);
    return () => window.clearTimeout(timer);
  }, [railCollapsed, mounted, footer]);

  if (!mounted) return null;

  const updateLabel = `${t("appUpdate.foundNewVersion")} v${version ?? ""}`;
  const tone = hasUpdate ? "ok" : status.tone;
  const dotClass = hasUpdate || status.tone === "ok" ? "green pulse" : status.tone === "err" ? "red" : "amber";

  return (
    <footer ref={footer} className="sb-footer" data-open={railCollapsed ? "true" : "false"}>
      <div className="sb-footer-clip">
        <div className="sb-footer-body">
          <button
            type="button"
            className={`sb-user${hasUpdate ? " has-update" : ""}`}
            aria-label={`${profile.displayName} · ${hasUpdate ? `${updateLabel} · ` : ""}OMP 状态与环境菜单`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(event) => onToggleMenu(event.currentTarget)}
          >
            <span className="sb-avatar-slot">
              {profile.avatarSrc
                ? <img ref={(node) => { if (avatarRef) avatarRef.current = node; }} className="avatar" src={profile.avatarSrc} alt="" draggable={false} />
                : <span ref={(node) => { if (avatarRef) avatarRef.current = node; }} className="avatar" aria-hidden="true">{avatarInitial(profile.displayName)}</span>}
              {hasUpdate ? <span className="sb-avatar-dot" aria-hidden="true" /> : null}
            </span>
            <span className="sb-label">
              <span className="u-name">
                <span>{profile.displayName}</span>
                {hasUpdate ? <span className="sb-version">v{version}</span> : null}
              </span>
              <span className={`u-status ${tone}`} role="status" aria-live="polite">
                <span className={`dot ${dotClass}`} aria-hidden="true" />
                <span>{hasUpdate ? updateLabel : status.text}</span>
              </span>
            </span>
            <span className="sb-chevron"><Icon name="chevron-ud" extra="sm" /></span>
          </button>
        </div>
      </div>
    </footer>
  );
}

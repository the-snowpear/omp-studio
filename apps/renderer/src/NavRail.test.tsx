import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { iconSvg } from "./icons";
import { I18nProvider } from "./i18n";
import { AppNavRail } from "./NavRail";

afterEach(cleanup);

/** The shell owns the collapsed flag (the avatar falls back to the sidebar
 *  footer while the rail is away), so the tests hold it the same way. */
function StatefulRail({
  activeRoute = "home",
  profile = { displayName: "Ada", avatarSrc: "" },
  update = null,
  demo = false,
  onNavigate = vi.fn(),
  onOpenUpdate = vi.fn(),
  onToggleMenu,
  menuOpen = false,
}: {
  activeRoute?: string;
  profile?: { displayName: string; avatarSrc: string };
  update?: { version?: string } | null;
  demo?: boolean;
  onNavigate?: () => void;
  onOpenUpdate?: () => void;
  onToggleMenu?: (anchor: HTMLButtonElement) => void;
  menuOpen?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <AppNavRail
      activeRoute={activeRoute}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((value) => !value)}
      profile={profile}
      update={update}
      demo={demo}
      onNavigate={onNavigate}
      onOpenUpdate={onOpenUpdate}
      menuOpen={menuOpen}
      {...(onToggleMenu === undefined ? {} : { onToggleMenu })}
    />
  );
}

function renderRail(options: {
  activeRoute?: string;
  profile?: { displayName: string; avatarSrc: string };
  update?: { version?: string } | null;
  demo?: boolean;
} = {}) {
  const onNavigate = vi.fn();
  const onOpenUpdate = vi.fn();
  render(
    <I18nProvider forcedLanguage="en">
      <StatefulRail
        activeRoute={options.activeRoute ?? "home"}
        {...(options.profile === undefined ? {} : { profile: options.profile })}
        update={options.update ?? null}
        demo={options.demo ?? false}
        onNavigate={onNavigate}
        onOpenUpdate={onOpenUpdate}
      />
    </I18nProvider>,
  );
  return {
    nav: screen.getByRole("navigation", { name: "Primary" }),
    onNavigate,
    onOpenUpdate,
  };
}

describe("AppNavRail", () => {
  it("renders the six primary destinations and marks the active route", () => {
    const { nav } = renderRail({ activeRoute: "home" });
    const buttons = Array.from(nav.querySelectorAll<HTMLButtonElement>(".app-rail-top .app-rail-btn"));
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Workbench",
      "Home",
      "History",
      "Capabilities",
      "Models",
      "Settings",
    ]);
    expect(within(nav).getByRole("button", { name: "Home" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).getByRole("button", { name: "Workbench" }).getAttribute("aria-current")).toBeNull();
    expect(nav.querySelector<HTMLElement>(".app-rail-window")?.style.getPropertyValue("--rail-active-index")).toBe("1");
  });

  it("gives the workbench its own icon instead of the sidebar-region glyph", () => {
    /* `layout` is the titlebar's "toggle the left region" mark; a destination
       reusing it would read as the same command twice in one window. */
    const svgInner = (html: string) => {
      const host = document.createElement("div");
      host.innerHTML = html;
      return host.querySelector("svg")?.innerHTML ?? "";
    };
    const { nav } = renderRail();
    const glyph = within(nav).getByRole("button", { name: "Workbench" }).querySelector("svg")?.innerHTML ?? "";
    expect(glyph).toBe(svgInner(iconSvg("workbench")));
    expect(glyph).not.toBe(svgInner(iconSvg("layout")));
  });

  it("navigates when a destination is clicked", () => {
    const { nav, onNavigate } = renderRail();
    fireEvent.click(within(nav).getByRole("button", { name: "History" }));
    expect(onNavigate).toHaveBeenCalledWith("history");
  });

  it("only shows the update entry when an update exists", () => {
    const noUpdate = renderRail();
    expect(within(noUpdate.nav).queryByRole("button", { name: /New version available/ })).toBeNull();

    cleanup();
    const { nav, onOpenUpdate } = renderRail({ update: { version: "1.2.3" }, demo: true });
    const update = within(nav).getByRole("button", { name: "New version available v1.2.3 (Demo)" });
    fireEvent.click(update);
    expect(onOpenUpdate).toHaveBeenCalledOnce();
  });

  it("uses the profile initial or avatar and opens Home", () => {
    const { nav, onNavigate } = renderRail();
    const avatar = within(nav).getByRole("button", { name: "Ada · Account" });
    expect(avatar.textContent).toBe("A");
    fireEvent.click(avatar);
    expect(onNavigate).toHaveBeenCalledWith("home");
  });

  it("renders an uploaded avatar image", () => {
    const { nav } = renderRail({
      profile: { displayName: "Ada", avatarSrc: "data:image/png;base64,QQ==" },
    });
    const image = nav.querySelector<HTMLImageElement>(".app-rail-avatar img");
    expect(image?.getAttribute("src")).toBe("data:image/png;base64,QQ==");
  });

  it("collapses off the layout and expands again from the same handle", () => {
    renderRail();
    const handle = screen.getByRole("button", { name: "Collapse navigation" });
    fireEvent.click(handle);
    /* The column stays mounted for the width transition but leaves the tree, so
       the landmark is gone for assistive tech while the handle stays operable. */
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show navigation" }));
    const reopened = screen.getByRole("navigation", { name: "Primary" });
    expect(within(reopened).getByRole("button", { name: "Workbench" })).toBeTruthy();
  });

  it("hands the environment-menu anchor back to the shell", () => {
    /* The same control also lives in the sidebar footer; the shell needs to know
       which node was clicked to place the menu against it. */
    const onToggleMenu = vi.fn();
    const onNavigate = vi.fn();
    render(
      <I18nProvider forcedLanguage="en">
        <StatefulRail onToggleMenu={onToggleMenu} onNavigate={onNavigate} menuOpen={false} />
      </I18nProvider>,
    );
    const avatar = screen.getByRole("button", { name: "Ada · Account" });
    expect(avatar.getAttribute("aria-haspopup")).toBe("menu");
    expect(avatar.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(avatar);
    expect(onToggleMenu).toHaveBeenCalledOnce();
    expect(onToggleMenu.mock.calls[0]?.[0]).toBe(avatar);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

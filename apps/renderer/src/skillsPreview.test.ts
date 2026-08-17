import { describe, expect, it } from "vitest";
import { hasIcon } from "./icons";
import {
  ICON_BY_NAME,
  createPreviewDrawerItems,
  drawerItemIcon,
  type DrawerItem,
  type SkillPreview,
} from "./skillsPreview";

function skill(name: string, desc = ""): SkillPreview {
  return {
    kind: "skill",
    name,
    desc,
    src: "OMP",
    scope: "workspace",
    path: "",
    enabled: true,
    loaded: true,
    session: false,
  };
}

function plugin(name: string): DrawerItem {
  return {
    kind: "plugin",
    name,
    src: "npm",
    status: "loaded",
    tools: 0,
    commands: 0,
    hooks: 0,
    ui: false,
    err: null,
  };
}

describe("drawerItemIcon", () => {
  it("gives named skills distinct glyphs instead of a shared puzzle mark", () => {
    expect(drawerItemIcon(skill("commit-msg"))).toBe("pencil");
    expect(drawerItemIcon(skill("design-system"))).toBe("swatch");
    expect(drawerItemIcon(skill("banner-design"))).toBe("banner");
    expect(drawerItemIcon(skill("ui-ux-pro-max"))).toBe("wand");
    expect(drawerItemIcon(skill("brand"))).toBe("diamond");
  });

  it("infers a glyph from name or description keywords", () => {
    expect(drawerItemIcon(skill("team-git-hooks"))).toBe("branch");
    expect(drawerItemIcon(skill("release-notes", "生成发布文档"))).toBe("book");
    expect(drawerItemIcon(skill("palette-audit", "检查配色对比度"))).toBe("palette");
  });

  it("does not collapse unknown skills onto puzzle", () => {
    const names = ["alpha-weaver", "zeta-orbit", "nova-kit", "ember-flow", "quiet-lens"];
    const icons = names.map((name) => drawerItemIcon(skill(name, "custom helper")));
    expect(icons.every((icon) => icon !== "puzzle" && icon !== "box" && icon !== "command")).toBe(true);
    expect(new Set(icons).size).toBeGreaterThan(1);
  });

  it("keeps unmatched plugins on plug", () => {
    expect(drawerItemIcon(plugin("local-tools"))).toBe("plug");
  });

  it("resolves every assigned name to a real path, not the empty-box fallback", () => {
    const samples: DrawerItem[] = [
      ...createPreviewDrawerItems(),
      skill("commit-msg"),
      skill("design-system"),
      skill("banner-design"),
      skill("team-git-hooks"),
      skill("alpha-weaver", "custom helper"),
      plugin("local-tools"),
      plugin("git-worktree-plus"),
    ];
    for (const item of samples) {
      expect(hasIcon(drawerItemIcon(item))).toBe(true);
    }
    for (const icon of Object.values(ICON_BY_NAME)) {
      expect(hasIcon(icon)).toBe(true);
    }
  });
});

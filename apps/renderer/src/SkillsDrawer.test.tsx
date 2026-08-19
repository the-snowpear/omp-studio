import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensibilityReadModel, StudioClient } from "@omp-studio/client-contract";

import { SkillsDrawer } from "./SkillsDrawer";
import { PreviewModeProvider } from "./preview/PreviewContext";

afterEach(cleanup);

beforeAll(() => {
  localStorage.setItem("omp.previewMode", "0");
});

function inventory(): ExtensibilityReadModel {
  return {
    skills: [
      {
        name: "commit-msg",
        desc: "写提交信息",
        scope: "global",
        sourceKind: "native",
        sourceLabel: "OMP",
        enabled: true,
        hide: false,
      },
    ],
    plugins: [],
    warnings: [],
    generatedAt: "2026-08-17T00:00:00.000Z",
  };
}

function clientOf(model: ExtensibilityReadModel = inventory()): StudioClient {
  return {
    query: vi.fn(async () => model),
  } as unknown as StudioClient;
}

describe("SkillsDrawer real-mode draft join", () => {
  it("加入 inserts a skill into the current draft and 移出 removes it", async () => {
    const onInsertSkill = vi.fn();
    const onRemoveSkill = vi.fn();
    const { rerender } = render(
      <PreviewModeProvider switchEnabled>
        <SkillsDrawer
          open
          client={clientOf()}
          onClose={() => undefined}
          onInsertSkill={onInsertSkill}
          onRemoveSkill={onRemoveSkill}
        />
      </PreviewModeProvider>,
    );

    const add = await screen.findByRole("button", { name: "把 commit-msg 加入当前草稿" });
    fireEvent.click(add);
    expect(onInsertSkill).toHaveBeenCalledWith({ name: "commit-msg", desc: "写提交信息" });

    rerender(
      <PreviewModeProvider switchEnabled>
        <SkillsDrawer
          open
          client={clientOf()}
          onClose={() => undefined}
          draftSkills={new Set(["commit-msg"])}
          onInsertSkill={onInsertSkill}
          onRemoveSkill={onRemoveSkill}
        />
      </PreviewModeProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("option", { name: /commit-msg/ }).getAttribute("aria-selected")).toBe("true");
    });
    fireEvent.click(screen.getByRole("button", { name: "从当前草稿移除 commit-msg" }));
    expect(onRemoveSkill).toHaveBeenCalledWith("commit-msg");
  });

  it("shows a used-in-conversation mark from the transcript set", async () => {
    render(
      <PreviewModeProvider switchEnabled>
        <SkillsDrawer
          open
          client={clientOf()}
          onClose={() => undefined}
          usedSkills={new Set(["commit-msg"])}
        />
      </PreviewModeProvider>,
    );
    const card = await screen.findByRole("option", { name: /commit-msg/ });
    expect(card.className).toContain("is-used");
    expect(card.querySelector(".sk-used-mark")).not.toBeNull();
  });

  it("renders a named glyph on the skill tile instead of the shared puzzle mark", async () => {
    const model: ExtensibilityReadModel = {
      skills: [
        {
          name: "commit-msg",
          desc: "写提交信息",
          scope: "global",
          sourceKind: "native",
          sourceLabel: "OMP",
          enabled: true,
          hide: false,
        },
        {
          name: "design-system",
          desc: "tokens and components",
          scope: "workspace",
          sourceKind: "native",
          sourceLabel: "Claude",
          enabled: true,
          hide: false,
        },
        {
          name: "banner-design",
          desc: "social banners",
          scope: "workspace",
          sourceKind: "native",
          sourceLabel: "Claude",
          enabled: true,
          hide: false,
        },
      ],
      plugins: [],
      warnings: [],
      generatedAt: "2026-08-17T00:00:00.000Z",
    };
    render(
      <PreviewModeProvider switchEnabled>
        <SkillsDrawer open client={clientOf(model)} onClose={() => undefined} />
      </PreviewModeProvider>,
    );

    const commit = await screen.findByRole("option", { name: /commit-msg/ });
    const design = screen.getByRole("option", { name: /design-system/ });
    const banner = screen.getByRole("option", { name: /banner-design/ });
    const icons = [commit, design, banner].map((card) => card.querySelector(".sk-icon")?.getAttribute("data-icon"));
    expect(icons).toEqual(["pencil", "swatch", "banner"]);
    expect(new Set(icons).size).toBe(3);
  });
});

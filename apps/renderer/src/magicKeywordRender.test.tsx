import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ComposerInput } from "./ComposerInput";
import { MarkdownText } from "./conversation/markdown";

afterEach(cleanup);

describe("ComposerInput magic highlight", () => {
  it("mirrors typed orchestrate with gradient spans while focused", () => {
    render(<ComposerInput value="please orchestrate this" aria-label="composer" readOnly onChange={() => undefined} />);
    const input = screen.getByLabelText("composer");
    fireEvent.focus(input);
    const painted = document.querySelector('[data-magic="orchestrate"]');
    expect(painted).toBeTruthy();
    expect(painted?.className).toContain("is-animated");
  });

  it("does not paint code-span occurrences", () => {
    render(<ComposerInput value="see `orchestrate` only" aria-label="composer" readOnly onChange={() => undefined} />);
    expect(document.querySelectorAll("[data-magic]").length).toBe(0);
  });
});

describe("MarkdownText magic keywords", () => {
  it("paints prose keywords in user bubbles", () => {
    render(<MarkdownText text="please orchestrate the migration" magicKeywords />);
    const painted = document.querySelector('[data-magic="orchestrate"]');
    expect(painted).toBeTruthy();
    expect(painted?.className).toContain("is-animated");
  });

  it("leaves inline code unpainted", () => {
    render(<MarkdownText text="use `orchestrate` in docs" magicKeywords />);
    expect(document.querySelectorAll("[data-magic]").length).toBe(0);
  });
});

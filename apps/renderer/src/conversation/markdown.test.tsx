import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SpillViewer } from "./SpillLink";
import { MarkdownInline } from "./markdown";

afterEach(cleanup);

describe("MarkdownInline", () => {
  it("drops javascript and other unsafe hrefs that Ask cards would otherwise render", () => {
    const { container } = render(
      <MarkdownInline text={'click [here](javascript:alert(1)) and [docs](https://example.com/a)'} />,
    );
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/a");
    expect(container.querySelector("a")?.getAttribute("rel")).toBe("noreferrer noopener");
  });

  it("opens current and legacy spill URIs written as inline code", () => {
    const open = vi.fn();
    render(<SpillViewer.Provider value={open}><MarkdownInline text={"`local://7.log` and `artifact://8`"} /></SpillViewer.Provider>);
    for (const uri of ["local://7.log", "artifact://8"]) {
      fireEvent.click(screen.getByRole("button", { name: uri }));
      expect(open).toHaveBeenLastCalledWith(uri);
    }
  });

  it("renders http images only", () => {
    const { container } = render(
      <MarkdownInline text={'![ok](https://example.com/a.png) ![bad](file:///C:/secret.png)'} />,
    );
    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute("src")).toBe("https://example.com/a.png");
  });
});

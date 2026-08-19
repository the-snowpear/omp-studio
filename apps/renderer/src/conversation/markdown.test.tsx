import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

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

  it("renders http images only", () => {
    const { container } = render(
      <MarkdownInline text={'![ok](https://example.com/a.png) ![bad](file:///C:/secret.png)'} />,
    );
    const images = container.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute("src")).toBe("https://example.com/a.png");
  });
});

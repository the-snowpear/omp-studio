import { createElement, type ComponentType, type HTMLAttributes } from "react";
import type { Components, ExtraProps } from "react-markdown";

/** Opt-in source locations for document editing; normal conversation rendering uses its existing components. */
export function withMarkdownSource(components: Components, offset: number): Components {
  const mapped: Record<string, ComponentType<HTMLAttributes<HTMLElement> & ExtraProps>> = {};
  for (const tag of ["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "tr", "hr", "pre", "table", "img"] as const) {
    const Original = components[tag] as ComponentType<HTMLAttributes<HTMLElement> & ExtraProps> | undefined;
    const Located = (props: HTMLAttributes<HTMLElement> & ExtraProps) => {
      const { node, ...rest } = props;
      const position = node?.position;
      const location: Record<string, number> = position?.start.offset === undefined || position.end.offset === undefined ? {} : {
        "data-source-start": offset + position.start.offset,
        "data-source-end": offset + position.end.offset,
      };
      if (Original) {
        // These existing renderers return rich blocks rather than their original HTML tag.
        if (tag === "pre" || tag === "table" || tag === "img") {
          return createElement(tag === "img" ? "span" : "div", location, createElement(Original, props));
        }
        // p/li have custom prose handling; keep valid list/paragraph markup and attach
        // the source attributes to that renderer's root through its regular props.
        return createElement(Original, { ...props, ...location });
      }
      return createElement(tag, { ...rest, ...location });
    };
    mapped[tag] = Located;
  }
  return { ...components, ...mapped } as Components;
}

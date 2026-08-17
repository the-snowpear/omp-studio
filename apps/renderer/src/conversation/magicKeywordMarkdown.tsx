/**
 * Wrap string children with magic-keyword spans; leave element children alone
 * (nested tags get their own component wrappers).
 */

import { Children, type ReactNode } from "react";

import { renderMagicKeywordText } from "../MagicKeywordText";

export function withMagicKeywordChildren(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") return renderMagicKeywordText(child, true);
    return child;
  });
}

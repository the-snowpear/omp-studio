// Browser stand-in for `@oh-my-pi/pi-tui/text/sanitize`. The real module
// drags `node:os`, the pi-utils barrel and the width measurer (which boots
// native text-width state at module scope) into the bundle; the renderer only
// uses `flattenLine`, which is plain whitespace folding.

/** Every whitespace run (line breaks and tabs included) collapsed to one space, trimmed. */
export function flattenLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

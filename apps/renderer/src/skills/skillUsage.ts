import type { ComposerDoc } from "../composer/types";

/** Same token shape Runtime expandSkillPrompts scans. */
export const SKILL_TOKEN_RE = /(?:^|\s)\/skill:([^\s/]+)(?=\s|$)/g;

/** First-seen `/skill:<name>` tokens in serialized user text. */
export function skillNamesInText(text: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const matcher = new RegExp(SKILL_TOKEN_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const name = match[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** Skill capsules in the draft, plus any typed `/skill:` tokens in text nodes. */
export function skillNamesInDoc(doc: ComposerDoc): ReadonlySet<string> {
  const names = new Set<string>();
  for (const node of doc.nodes) {
    if (node.type === "chip") {
      if (node.chip.kind === "skill") names.add(node.chip.name ?? node.chip.label);
      continue;
    }
    for (const name of skillNamesInText(node.value)) names.add(name);
  }
  return names;
}

/** Union that keeps previous insertion order and only allocates when something new arrives. */
export function mergeUsedSkills(prev: ReadonlySet<string>, next: ReadonlySet<string>): ReadonlySet<string> {
  if (next.size === 0) return prev;
  let changed = false;
  const merged = new Set(prev);
  for (const name of next) {
    if (merged.has(name)) continue;
    merged.add(name);
    changed = true;
  }
  return changed ? merged : prev;
}

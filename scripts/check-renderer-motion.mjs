// Motion rules for the renderer: every duration, curve, entrance keyframe and
// reduced-motion rule has one home (styles/tokens.css, styles/motion.css,
// src/motion.ts). This check keeps component CSS from growing a second one.
//
//   node scripts/check-renderer-motion.mjs
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../apps/renderer/src/", import.meta.url));
const TOKENS = "styles/tokens.css";
const MOTION = "styles/motion.css";
const MOTION_TS = "motion.ts";

// Scripts that may ask the OS for the preference directly; everything else
// goes through `motionReduced()`.
const REDUCED_QUERY_OWNERS = new Map([
  [MOTION_TS, "The one answer to \"is motion off\"."],
  ["main.tsx", "Feeds the OS preference into the performance tier before the first frame."],
  ["background/BackgroundProvider.tsx", "Wallpaper motion has its own on / auto / off setting; auto follows the OS preference live."],
]);

const failures = [];
const fail = (file, line, message) => failures.push(`${file}:${line}: ${message}`);
const files = readdirSync(root, { recursive: true }).map(file => String(file).replaceAll("\\", "/"));
const read = file => readFileSync(join(root, file), "utf8").replace(/\r/g, "");
/** Blank out comments but keep every newline, so offsets still map to lines. */
const strip = text => text.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, " "));
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

const ANIMATION_WORDS = new Set([
  "none", "infinite", "normal", "reverse", "alternate", "alternate-reverse", "forwards", "backwards", "both",
  "running", "paused", "linear", "step-start", "step-end", "initial", "inherit", "unset", "revert", "auto",
]);
const TIMED = /^(transition|animation)(-(duration|delay|timing-function))?$/;
const RECIPE = /^--motion-/;

/** Everything that is not a literal: var(), calc() internals are kept for the time check. */
const withoutVars = value => {
  let out = value, previous;
  do { previous = out; out = out.replace(/var\([^()]*\)/g, " VAR "); } while (out !== previous);
  return out;
};
/** 0.01ms is how the reduced-motion clamp spells "instant"; only motion.css may say it. */
const literalTimes = (value, file) => (withoutVars(value).match(/(?<![\w.#-])-?\d*\.?\d+m?s\b/g) ?? [])
  .filter(time => Number.parseFloat(time) !== 0 && !(file === MOTION && time === "0.01ms"));
const splitParts = value => {
  const parts = [];
  let depth = 0, current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) { parts.push(current.trim()); current = ""; } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
};

const keyframes = new Map();   // name -> { file, line, body }
const usedNames = new Map();   // name -> first use
const cssFiles = files.filter(file => file.endsWith(".css"));

// The motion vocabulary: defined in two files, usable everywhere.
const MOTION_TOKEN = /^--(dur(-[\w-]+)?|ease(-[\w-]+)?|loop-[\w-]+|motion-[\w-]+|shift-[\w-]+|stagger|tip-delay)$/;
const MOTION_REFERENCE = /var\(\s*(--(?:dur|ease|loop|motion|shift|stagger|tip-delay)[\w-]*)/g;
const defined = new Set();
for (const file of [TOKENS, MOTION]) {
  for (const match of strip(read(file)).matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:/g)) if (MOTION_TOKEN.test(match[1])) defined.add(match[1]);
}
const checkReferences = (file, text) => {
  for (const match of text.matchAll(MOTION_REFERENCE)) {
    if (MOTION_TOKEN.test(match[1]) && !defined.has(match[1])) fail(file, lineOf(text, match.index), `\`${match[1]}\` is not a motion token (see ${TOKENS}).`);
  }
};

for (const file of cssFiles) {
  const text = strip(read(file));
  checkReferences(file, text);

  for (const match of text.matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:\s*([^;{}]+)/g)) {
    const line = lineOf(text, match.index + match[0].indexOf(match[1]));
    if (file !== TOKENS && file !== MOTION && MOTION_TOKEN.test(match[1])) fail(file, line, `\`${match[1]}\` is defined here: motion tokens live in ${TOKENS}.`);
    else if (file !== TOKENS && !RECIPE.test(match[1]) && literalTimes(match[2], file).length) fail(file, line, `\`${match[1]}\` hides a literal duration: derive it from a --dur-* / --stagger token.`);
  }

  for (const match of text.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    let depth = 1, index = match.index + match[0].length;
    while (depth > 0 && index < text.length) { const char = text[index++]; if (char === "{") depth += 1; else if (char === "}") depth -= 1; }
    const body = text.slice(match.index + match[0].length, index - 1).replace(/\s+/g, "").replace(/;}/g, "}");
    const line = lineOf(text, match.index);
    const earlier = keyframes.get(match[1]);
    if (earlier) fail(file, line, `@keyframes ${match[1]} is already defined in ${earlier.file}:${earlier.line}.`);
    else keyframes.set(match[1], { file, line, body });
  }

  if (file !== MOTION) {
    for (const match of text.matchAll(/prefers-reduced-motion/g)) {
      fail(file, lineOf(text, match.index), `reduced motion is handled once, in ${MOTION}. Make the un-animated style the still picture instead of adding a media query.`);
    }
  }

  for (const match of text.matchAll(/(?:^|[;{\s])((?:transition|animation)(?:-[a-z-]+)?|--motion-[\w-]+)\s*:\s*([^;{}]+)/g)) {
    const property = match[1], value = match[2].trim();
    const line = lineOf(text, match.index + match[0].indexOf(property));
    const recipe = RECIPE.test(property);
    const animation = recipe || property === "animation" || property === "animation-name";

    if (animation) {
      for (const part of splitParts(value)) {
        for (const word of withoutVars(part).replace(/[\w-]+\([^()]*\)/g, " ").split(/\s+/)) {
          if (!/^[a-zA-Z_][\w-]*$/.test(word) || word === "VAR" || ANIMATION_WORDS.has(word) || /^ease(-|$)/.test(word)) continue;
          if (!usedNames.has(word)) usedNames.set(word, { file, line });
        }
      }
    }
    if (!recipe && !TIMED.test(property)) {
      if (property === "transition-property" && /(^|[\s,])all([\s,]|$)/.test(value)) fail(file, line, "name the properties that transition; `all` animates whatever changes next.");
      continue;
    }
    if (file === TOKENS && !TIMED.test(property)) continue;

    const bare = withoutVars(value);
    for (const time of literalTimes(value, file)) fail(file, line, `literal ${time} in \`${property}\`: use a --dur-* / --loop-* token (see ${TOKENS}).`);
    for (const keyword of bare.match(/(?<![\w-])ease(-in-out|-in|-out)?(?![\w-])/g) ?? []) fail(file, line, `bare \`${keyword}\` in \`${property}\`: pick a --ease* token by what the motion means.`);
    if (/cubic-bezier\(|(?<![\w-])linear\(/.test(bare)) fail(file, line, `raw timing function in \`${property}\`: curves live in ${TOKENS}.`);

    if (property === "transition" || property === "animation" || recipe) {
      for (const part of splitParts(value)) {
        if (/^(none|initial|inherit|unset|revert)(\s*!important)?$/.test(part)) continue;
        if (property === "transition" && /(^|\s)all(\s|$)/.test(withoutVars(part))) fail(file, line, "name the properties that transition; `all` animates whatever changes next.");
        const timed = /var\(--(dur|loop)|(?<![\w.#-])\d*\.?\d+m?s\b/.test(part) && !/^[\w-]+\s+0m?s(\s|$)/.test(part.replace(/\s*!important$/, "")) ;
        const eased = /var\(--ease|var\(--motion-|(?<![\w-])linear(?![\w-(])|steps\(|step-(start|end)/.test(part);
        if (timed && !eased) fail(file, line, `\`${part.slice(0, 60)}\` has a duration but no curve: add a --ease* token.`);
      }
    }
  }
}

for (const [name, use] of usedNames) {
  if (!keyframes.has(name)) fail(use.file, use.line, `animation \`${name}\` has no @keyframes: it never runs.`);
}
const byBody = new Map();
for (const [name, frame] of keyframes) {
  if (!usedNames.has(name)) fail(frame.file, frame.line, `@keyframes ${name} is never used.`);
  const twin = byBody.get(frame.body);
  if (twin) fail(frame.file, frame.line, `@keyframes ${name} repeats ${twin.name} (${twin.file}:${twin.line}): share one, ideally a recipe from ${MOTION}.`);
  else byBody.set(frame.body, { name, ...frame });
}

// The table in motion.ts must be the numbers in tokens.css.
const tokens = strip(read(TOKENS));
const script = read(MOTION_TS);
const table = (name) => {
  const body = script.match(new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\} as const`))?.[1] ?? "";
  return new Map([...body.matchAll(/(\w+):\s*("[^"]*"|[\d.]+)/g)].map(entry => [entry[1], entry[2].replace(/"/g, "")]));
};
const token = name => tokens.match(new RegExp(`(?:^|[\\s;{])${name}:\\s*([^;]+);`))?.[1].trim();
const DURATION_TOKENS = { tactile: "--dur-tactile", fast: "--dur-fast", base: "--dur", slow: "--dur-slow", slower: "--dur-slower", hero: "--dur-hero", flash: "--dur-flash" };
const SCALAR_TOKENS = { STAGGER_MS: "--stagger", TIP_DELAY_MS: "--tip-delay" };
const EASE_TOKENS = { standard: "--ease", out: "--ease-out", in: "--ease-in", nav: "--ease-nav", ios: "--ease-ios", emphasis: "--ease-emphasis" };
const compare = (name, pairs, format) => {
  const values = table(name);
  for (const [key, property] of Object.entries(pairs)) {
    const expected = token(property);
    const actual = values.has(key) ? format(values.get(key)) : undefined;
    if (expected === undefined || actual !== expected.replace(/\s+/g, " ")) fail(MOTION_TS, 1, `${name}.${key} is ${actual ?? "missing"} but ${property} is ${expected ?? "missing"}: keep the table and ${TOKENS} equal.`);
  }
  for (const key of values.keys()) if (!(key in pairs)) fail(MOTION_TS, 1, `${name}.${key} has no token in ${TOKENS}.`);
};
compare("MOTION_MS", DURATION_TOKENS, value => `${value}ms`);
compare("MOTION_EASE", EASE_TOKENS, value => value);
for (const [name, property] of Object.entries(SCALAR_TOKENS)) {
  const actual = script.match(new RegExp(`export const ${name} = ([0-9.]+);`))?.[1];
  if (actual === undefined || `${actual}ms` !== token(property)) fail(MOTION_TS, 1, `${name} is ${actual ?? "missing"} but ${property} is ${token(property) ?? "missing"}: keep the two equal.`);
}

for (const file of files.filter(file => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.startsWith("test/"))) {
  const text = read(file);
  checkReferences(file, text);
  if (REDUCED_QUERY_OWNERS.has(file)) continue;
  // A query string, not a mention in a comment.
  for (const match of text.matchAll(/["'`]\s*\(\s*prefers-reduced-motion/g)) {
    fail(file, lineOf(text, match.index), "ask `motionReduced()` from motion.ts: it also covers the in-app switch and low performance tiers.");
  }
}

if (failures.length) {
  console.error(failures.sort().join("\n"));
  console.error(`\n${failures.length} motion rule violation(s). The system is described at the top of apps/renderer/src/${MOTION}.`);
  process.exitCode = 1;
} else console.log("Renderer motion check passed.");

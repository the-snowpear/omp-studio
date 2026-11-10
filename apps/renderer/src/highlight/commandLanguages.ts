import type { LanguageFn } from "highlight.js";
import bash from "highlight.js/lib/languages/bash";
import powershell from "highlight.js/lib/languages/powershell";

/** Keep the shell grammar's strings/comments; also color external commands and CLI flags. */
function commandLanguage(base: LanguageFn): LanguageFn {
  return hljs => {
    const language = base(hljs);
    const words = (language.keywords as { keyword: string | string[] }).keyword;
    const reserved = new Set((Array.isArray(words) ? words.join(" ") : words).toLowerCase().split(/\s+/));
    return { ...language, contains: [...(language.contains ?? []), {
      match: [/(?:^[ \t]*|(?:&&|\|\||[;|])[ \t]*)/, /[A-Za-z_./][\w./-]*(?=\s|$|[;&|])/],
      scope: { 2: "built_in" },
      "on:begin": (match, response) => { if (reserved.has(match[2]!.toLowerCase())) response.ignoreMatch(); },
      relevance: 0,
    }, {
      match: /(?<!\S)--?[A-Za-z][\w-]*/,
      scope: "attr",
      relevance: 0,
    }] };
  };
}

export const commandLanguages = { bash: commandLanguage(bash), powershell: commandLanguage(powershell) };

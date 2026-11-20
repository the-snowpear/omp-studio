import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { HighlightedCode } from "../highlight/HighlightedCode";

/** Session resources have no workspace base path. Relative references stay in the document. */
const components: Components = {
  a: ({ href, children }) => href && /^(https?:\/\/|mailto:)/i.test(href)
    ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span title={href}>{children}</span>,
  img: ({ src, alt }) => src && /^https?:\/\//i.test(src)
    ? <img src={src} alt={alt ?? ""} loading="lazy" /> : <span className="file-muted">{alt || src}</span>,
  pre: ({ children }) => <pre className="codeblock md-code-pre">{children}</pre>,
  code: ({ className, children }) => {
    const language = /(?:^|\s)language-(\S+)/.exec(className ?? "")?.[1];
    return language && typeof children === "string" ? <HighlightedCode language={language} code={children} /> : <code>{children}</code>;
  },
};
export default memo(function ResourceMarkdown({ text }: { text: string }) {
  return <div className="convo-md"><ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown></div>;
});

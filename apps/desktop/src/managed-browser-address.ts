export function normalizeBrowserAddress(value: string): string {
  const text = value.trim();
  if (text === "" || text === "about:blank") return "about:blank";
  const explicit = /^[a-z][a-z\d+.-]*:\/\//iu.test(text);
  const withScheme = explicit ? text : `http://${text}`;
  const url = new URL(withScheme);
  if (!explicit && !isLocalBrowserAddress(url.href)) url.protocol = "https:";
  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || /\s/u.test(url.hostname)) throw new Error("Enter an HTTP or HTTPS address without embedded credentials.");
  return url.href;
}
export function isLocalBrowserAddress(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  return ["http:", "https:"].includes(url.protocol) && (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname === "[::1]" || url.hostname === "0.0.0.0" || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname) || (!!url.port && /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/u.test(url.hostname)));
}

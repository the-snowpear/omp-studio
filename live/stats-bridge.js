// Keep the native dashboard on the authenticated Host origin.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const url = new URL(raw, location.href);
  if (url.origin !== location.origin) return nativeFetch(input, init);
  const session = await (await nativeFetch("/api/v1/session")).json();
  const control = await (await nativeFetch("/api/web/control")).json();
  const headers = new Headers(init.headers);
  headers.set("X-Studio-CSRF", session.csrf);
  headers.set("X-Studio-Control", control.version);
  if (!url.pathname.startsWith("/stats/"))
    url.pathname = "/stats" + url.pathname;
  return nativeFetch(url, { ...init, headers });
};
const NativeEventSource = window.EventSource;
window.EventSource = class extends NativeEventSource {
  constructor(url, options) {
    const target = new URL(url, location.href);
    if (
      target.origin === location.origin &&
      !target.pathname.startsWith("/stats/")
    )
      target.pathname = "/stats" + target.pathname;
    super(target, options);
  }
};

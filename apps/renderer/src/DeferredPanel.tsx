import { Component, Suspense, useEffect, useState, type ComponentProps, type ComponentType, type ReactNode } from "react";
import { useI18n } from "./i18n";
import { reportWorkbenchFailure } from "./WorkbenchHealth";

class PanelError extends Component<{ children: ReactNode; failed: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { reportWorkbenchFailure(); }
  render() { return this.state.failed ? this.props.failed : this.props.children; }
}

export function DeferredPanel({ children }: { children: ReactNode }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  return <PanelError failed={<div className="empty" role="alert"><p>{zh ? "面板加载失败。当前工作台和草稿未关闭，请返回其他页面或稍后重试。" : "This panel could not load. Your workbench and draft remain open. Return to another page or try again later."}</p></div>}>
    <Suspense fallback={<div className="empty" role="status"><span className="spinner" /><p>{zh ? "正在加载面板…" : "Loading panel…"}</p></div>}>{children}</Suspense>
  </PanelError>;
}

export function lazyPanel<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  let loaded: T | undefined;
  let pending: Promise<T> | undefined;
  const resolve = () => pending ??= load().then(module => {
    loaded = module.default;
    return loaded;
  }).finally(() => { pending = undefined; });
  return function LazyPanel(props: ComponentProps<T>) {
    const [generation, setGeneration] = useState(0);
    const [Panel, setPanel] = useState<T | undefined>(() => loaded);
    const [failed, setFailed] = useState(false);
    const { resolvedLanguage } = useI18n();
    useEffect(() => {
      if (loaded) { setPanel(() => loaded); return; }
      let mounted = true;
      // A local state update shows a resolved chunk immediately; throwing its
      // promise into Suspense adds React's fallback retry delay to first open.
      void resolve().then(component => { if (mounted) setPanel(() => component); }, () => {
        if (mounted) { reportWorkbenchFailure(); setFailed(true); }
      });
      return () => { mounted = false; };
    }, [generation]);
    const retry = () => { setFailed(false); setGeneration(value => value + 1); };
    const failure = <div className="empty" role="alert"><p>{resolvedLanguage === "zh" ? "面板加载失败，工作台和草稿仍保留。" : "The panel could not load. Your workbench and draft remain open."}</p><button type="button" className="btn" onClick={retry}>{resolvedLanguage === "zh" ? "重试" : "Retry"}</button></div>;
    if (failed) return failure;
    return <PanelError key={generation} failed={failure}>{Panel ? <Panel {...props} /> : <div className="empty" role="status"><span className="spinner" /><p>{resolvedLanguage === "zh" ? "正在加载面板…" : "Loading panel…"}</p></div>}</PanelError>;
  };
}

export function LoadWhenVisible({ visible, children }: { visible: boolean; children: ReactNode }) {
  const [loaded, setLoaded] = useState(visible);
  if (visible && !loaded) setLoaded(true);
  return loaded || visible ? <DeferredPanel>{children}</DeferredPanel> : null;
}

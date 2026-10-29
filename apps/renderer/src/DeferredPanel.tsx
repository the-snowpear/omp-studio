import { Component, Suspense, lazy, useState, type ComponentProps, type ComponentType, type ReactNode } from "react";
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
  const initial = lazy(load);
  return function LazyPanel(props: ComponentProps<T>) {
    const [generation, setGeneration] = useState(0);
    const [Panel, setPanel] = useState(() => initial);
    const { resolvedLanguage } = useI18n();
    const retry = () => { setPanel(() => lazy(load)); setGeneration(value => value + 1); };
    return <PanelError key={generation} failed={<div className="empty" role="alert"><p>{resolvedLanguage === "zh" ? "面板加载失败，工作台和草稿仍保留。" : "The panel could not load. Your workbench and draft remain open."}</p><button type="button" className="btn" onClick={retry}>{resolvedLanguage === "zh" ? "重试" : "Retry"}</button></div>}><Panel {...props} /></PanelError>;
  };
}

export function LoadWhenVisible({ visible, children }: { visible: boolean; children: ReactNode }) {
  const [loaded, setLoaded] = useState(visible);
  if (visible && !loaded) setLoaded(true);
  return loaded || visible ? <DeferredPanel>{children}</DeferredPanel> : null;
}

/**
 * 光效实验室（开发用，不进生产包）：用真实的样式表与真实类名摆出各种
 * 受光表面，切换 主题 × 光效档位 × Agent 状态 × 性能分级 对照定调。
 *
 *   npm run dev -w apps/renderer → /light-lab.html
 */
import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "../styles/sidebar.css";
import "../styles/workbench.css";
import "../styles/pages.css";
import "../dock/dock.css";
import "../perf/tiers.css";
import { applyLightLevel, LIGHT_LEVELS, type LightLevel } from "../lux/lightLevel";
import type { LuxActivity } from "../lux/activity";
import { LuxAmbient } from "../lux/LuxAmbient";
import { LuxOrbit } from "../lux/LuxOrbit";
import { LuxSpotlight } from "../lux/LuxSpotlight";

type Theme = "light" | "dark";
type Tier = "L0" | "L1" | "L2";
const TIER_VALUE: Record<Tier, string> = { L0: "L0", L1: "L1", L2: "L2 L1" };
const LEVEL_LABEL: Record<LightLevel, string> = { off: "关", soft: "柔和", standard: "标准", vivid: "绚丽" };
const STATE_LABEL: Record<LuxActivity, string> = { idle: "空闲", running: "运行中", waiting: "待审批" };

function initial<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const value = new URLSearchParams(location.search).get(key);
  return (allowed as readonly string[]).includes(value ?? "") ? value as T : fallback;
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly (readonly [NoInfer<T>, string])[]; onChange(value: NoInfer<T>): void }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ color: "var(--text-3)" }}>{label}</span>
      {options.map(([key, text]) => (
        <button key={key} type="button" className={`btn small ${value === key ? "primary" : "outline"}`} onClick={() => onChange(key)}>{text}</button>
      ))}
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: "var(--fs-12)", fontWeight: 500, color: "var(--text-3)" }}>{title}</h2>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>{children}</div>
    </section>
  );
}

function Lab() {
  const [theme, setTheme] = useState<Theme>(() => initial("theme", ["light", "dark"], "dark"));
  const [level, setLevel] = useState<LightLevel>(() => initial("light", LIGHT_LEVELS, "standard"));
  const [state, setState] = useState<LuxActivity>(() => initial("state", ["idle", "running", "waiting"], "running"));
  const [tier, setTier] = useState<Tier>(() => initial("tier", ["L0", "L1", "L2"], "L0"));

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    applyLightLevel(root, level);
    root.setAttribute("data-perf-tier", TIER_VALUE[tier]);
    const query = new URLSearchParams({ theme, light: level, state, tier });
    history.replaceState(null, "", `?${query}`);
  }, [theme, level, state, tier]);

  const running = state !== "idle";
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)", padding: "16px 28px 48px", display: "flex", flexDirection: "column", gap: 28, boxSizing: "border-box" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "10px 22px", alignItems: "center", fontSize: "var(--fs-12)", position: "sticky", top: 0, zIndex: 70, padding: "10px 0", background: "var(--bg)", borderBottom: "1px solid var(--border)" }}>
        <b style={{ fontWeight: 600 }}>光效实验室</b>
        <Segmented label="主题" value={theme} options={[["dark", "暗色"], ["light", "亮色"]]} onChange={setTheme} />
        <Segmented label="光效" value={level} options={LIGHT_LEVELS.map(key => [key, LEVEL_LABEL[key]] as const)} onChange={setLevel} />
        <Segmented label="Agent" value={state} options={(["idle", "running", "waiting"] as const).map(key => [key, STATE_LABEL[key]] as const)} onChange={setState} />
        <Segmented label="性能" value={tier} options={[["L0", "L0 全效"], ["L1", "L1 减弱动效"], ["L2", "L2 软件渲染"]]} onChange={setTier} />
      </div>

      <Section title="状态光 · Composer（运行中流光 / 待审批琥珀光晕）">
        <div style={{ width: "min(720px, 100%)" }}>
          <div className={`composer${running ? " running expanded" : ""}`} style={{ maxWidth: "none" }}>
            <LuxOrbit state={state} />
            <div style={{ padding: "14px 16px 10px", color: "var(--text-3)", fontSize: "var(--fs-14)" }}>{running ? "Agent 正在工作，可以继续输入补充说明…" : "描述你要做的事…"}</div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 10px 10px" }}>
              <span style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: "var(--fs-12)", color: "var(--text-3)" }}>
                <span className={`dot ${state === "waiting" ? "amber" : "green"}${running ? " pulse" : ""}`} />{STATE_LABEL[state]}
              </span>
              <button type="button" className="btn primary small">发送</button>
            </div>
          </div>
        </div>
      </Section>

      <Section title="材质光 · 卡片（指针移上去看「绚丽」档聚光）">
        {["读取 styles/tokens.css", "检索 data-perf-tier 规则", "生成 light.css"].map((text, index) => (
          <div key={text} className="cap-item" style={{ width: 230, padding: "14px 16px" }}>
            <div style={{ fontWeight: 500, marginBottom: 6 }}>{text}</div>
            <div style={{ fontSize: "var(--fs-12)", color: "var(--text-3)" }}>{index === 0 ? "运行中 · 1.2s" : "完成 · 12 处"}</div>
          </div>
        ))}
        <div className="approval-card" style={{ width: 300 }}>
          <div className="approval-head">请求写入 styles/light.css</div>
          <div style={{ padding: "12px 14px", display: "flex", gap: 8 }}><button type="button" className="btn primary small">批准</button><button type="button" className="btn outline small">拒绝</button></div>
        </div>
      </Section>

      <Section title="材质光 · 菜单 / 弹窗 / 浮窗">
        <div className="menu" style={{ position: "relative", zIndex: "auto" }}>
          {["复制", "在新窗口打开", "固定到侧栏", "归档对话"].map(item => <div key={item} style={{ padding: "7px 10px", borderRadius: "var(--r-6)", fontSize: "var(--fs-12)" }}>{item}</div>)}
        </div>
        <div className="modal" style={{ animation: "none" }}>
          <div style={{ padding: "18px 20px 6px", fontWeight: 600 }}>切换光效档位</div>
          <div style={{ padding: "4px 20px 16px", color: "var(--text-2)", fontSize: "var(--fs-12)", lineHeight: 1.6 }}>菜单和弹窗在「标准」及以上档位获得顶缘高光与柔影，暗色主题再带一圈极淡的强调色环境光。</div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "0 20px 16px" }}><button type="button" className="btn outline small">取消</button><button type="button" className="btn primary small">确定</button></div>
        </div>
        {(["violet", "teal"] as const).map((tint, index) => (
          <div key={tint} className={`dock-float${index === 0 ? " is-active-window" : ""}`} data-window-tint={tint} style={{ position: "relative", width: 260, height: 170 }}>
            <div className="dock-float-titlebar"><span className="dock-float-title">{index === 0 ? "对话 · 当前窗口" : "Git · 非焦点"}</span></div>
            <div style={{ padding: 12, fontSize: "var(--fs-12)", color: "var(--text-3)" }}>浮窗焦点光晕随档位增强</div>
          </div>
        ))}
      </Section>

      <Section title="状态光 · 运行点">
        {(["green", "amber", "blue", "red"] as const).map(color => (
          <span key={color} style={{ display: "inline-flex", gap: 8, alignItems: "center", fontSize: "var(--fs-12)" }}><span className={`dot ${color} pulse`} />{color}</span>
        ))}
      </Section>

      <LuxAmbient />
      <LuxSpotlight enabled={level === "vivid"} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Lab /></StrictMode>);

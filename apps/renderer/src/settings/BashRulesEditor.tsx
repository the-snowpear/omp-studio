import { useEffect, useMemo, useRef, useState } from "react";
import type { FeatureSettingValue } from "@omp-studio/studio-protocol";
import { Icon } from "../icons";

type Approval = "allow" | "prompt" | "deny";
type RuleDraft =
  | { id: number; kind: "rule"; raw: Record<string, FeatureSettingValue>; match: string; approval: Approval; env: string }
  | { id: number; kind: "preserved"; raw: FeatureSettingValue };

const APPROVALS: Array<[Approval, string, string]> = [["allow", "允许", "Allow"], ["prompt", "询问", "Ask"], ["deny", "拒绝", "Deny"]];

function readRules(value: FeatureSettingValue | undefined, nextId: () => number): RuleDraft[] {
  const entries = value == null ? [] : Array.isArray(value) ? value : [value];
  return entries.map(raw => {
    // Only direct rules have these controls. Native path groups and any other
    // authored entries remain opaque, rather than being flattened or discarded.
    if (raw && typeof raw === "object" && !Array.isArray(raw) && typeof raw.match === "string"
      && (raw.approval === "allow" || raw.approval === "prompt" || raw.approval === "deny")
      && (raw.env === undefined || (Array.isArray(raw.env) && raw.env.every(name => typeof name === "string")))) {
      return { id: nextId(), kind: "rule", raw, match: raw.match, approval: raw.approval, env: (raw.env as string[] | undefined)?.join(", ") ?? "" };
    }
    return { id: nextId(), kind: "preserved", raw };
  });
}

function toValue(rules: RuleDraft[]): FeatureSettingValue {
  return rules.map(rule => {
    if (rule.kind === "preserved") return rule.raw;
    const next: Record<string, FeatureSettingValue> = { ...rule.raw, match: rule.match, approval: rule.approval };
    if (rule.approval !== "allow") {
      if (rule.approval !== rule.raw.approval) delete next.env;
    } else if (rule.env !== ((rule.raw.env as string[] | undefined)?.join(", ") ?? "")) {
      const env = rule.env.split(/[\s,]+/u).filter(Boolean);
      if (env.length) next.env = env;
      else delete next.env;
    }
    return next;
  });
}

/** Edits one authored layer; native path groups keep their original structure. */
export function BashRulesEditor({ value, disabled, zh, label, save }: { value: FeatureSettingValue | undefined; disabled: boolean; zh: boolean; label: string; save(value: FeatureSettingValue): void }) {
  const seq = useRef(0);
  const nextId = () => ++seq.current;
  const [rules, setRules] = useState<RuleDraft[]>(() => readRules(value, nextId));
  const baseline = useMemo(() => (value === undefined ? "undefined" : JSON.stringify(value)), [value]);
  useEffect(() => { setRules(readRules(value, nextId)); }, [baseline]); // eslint-disable-line react-hooks/exhaustive-deps
  const modified = JSON.stringify(toValue(rules)) !== JSON.stringify(toValue(readRules(value, () => 0)));
  const dirty = modified || (value === null && rules.length === 0);
  const patch = (id: number, change: Partial<Pick<Extract<RuleDraft, { kind: "rule" }>, "match" | "approval" | "env">>) => setRules(list => list.map(rule => rule.id === id && rule.kind === "rule" ? { ...rule, ...change } : rule));
  const move = (index: number, delta: -1 | 1) => setRules(list => {
    const next = list.slice();
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    return next;
  });
  const tools = (rule: RuleDraft, index: number) => <span className="bash-rule-tools">
    <button type="button" className="icon-btn" aria-label={zh ? "上移" : "Move up"} disabled={disabled || index === 0} onClick={() => move(index, -1)}><Icon name="chevron-u" extra="sm" /></button>
    <button type="button" className="icon-btn" aria-label={zh ? "下移" : "Move down"} disabled={disabled || index === rules.length - 1} onClick={() => move(index, 1)}><Icon name="chevron-d" extra="sm" /></button>
    <button type="button" className="icon-btn" aria-label={zh ? "删除规则" : "Remove rule"} disabled={disabled} onClick={() => setRules(list => list.filter(item => item.id !== rule.id))}><Icon name="x" extra="sm" /></button>
  </span>;
  return <div className="bash-rules" aria-label={label} role="group">
    {rules.length === 0 ? <p className="bash-rules-empty">{zh ? "此配置层没有规则；其他层是否生效由 Runtime 决定。" : "This layer has no rules; the Runtime determines which other layers apply."}</p> : <ol className="bash-rules-list">
      {rules.map((rule, index) => rule.kind === "preserved" ? <li key={rule.id} className="bash-rule is-preserved">
        <span className="bash-rule-index" aria-hidden="true">{index + 1}</span>
        <details className="bash-rule-preserved"><summary>{zh ? "原样保留的路径分组／配置项" : "Preserved path group / configuration entry"}</summary><pre>{JSON.stringify(rule.raw, null, 2)}</pre></details>
        {tools(rule, index)}
      </li> : <li key={rule.id} className="bash-rule" data-approval={rule.approval}>
        <span className="bash-rule-index" aria-hidden="true">{index + 1}</span>
        <input className="input mono bash-rule-match" aria-label={zh ? `规则 ${index + 1} 命令模式` : `Rule ${index + 1} command pattern`} placeholder="cargo test*" spellCheck={false} disabled={disabled} value={rule.match} onChange={event => patch(rule.id, { match: event.target.value })} />
        <div className="bash-rule-approval" role="radiogroup" aria-label={zh ? `规则 ${index + 1} 审批` : `Rule ${index + 1} approval`}>
          {APPROVALS.map(([id, cn, en]) => <button key={id} type="button" role="radio" aria-checked={rule.approval === id} data-tone={id} disabled={disabled} onClick={() => patch(rule.id, { approval: id })}>{zh ? cn : en}</button>)}
        </div>
        <input className="input mono bash-rule-env" aria-label={zh ? `规则 ${index + 1} 可剥离的变量` : `Rule ${index + 1} strippable variables`} placeholder={rule.approval === "allow" ? "RUSTFLAGS, CI" : zh ? "仅允许规则可用" : "Allow rules only"} spellCheck={false} disabled={disabled || rule.approval !== "allow"} value={rule.approval === "allow" ? rule.env : ""} onChange={event => patch(rule.id, { env: event.target.value })} />
        {tools(rule, index)}
        {Object.keys(rule.raw).some(key => !["match", "approval", "env"].includes(key)) ? <details className="bash-rule-metadata"><summary>{zh ? "保留的路径范围与属性" : "Preserved path scope and properties"}</summary><pre>{JSON.stringify(Object.fromEntries(Object.entries(rule.raw).filter(([key]) => !["match", "approval", "env"].includes(key))), null, 2)}</pre></details> : null}
      </li>)}
    </ol>}
    <div className="bash-rules-foot">
      <button type="button" className="btn small ghost" disabled={disabled} onClick={() => setRules(list => [...list, { id: nextId(), kind: "rule", raw: { match: "", approval: "prompt" }, match: "", approval: "prompt", env: "" }])}><Icon name="plus" extra="sm" />{zh ? "添加规则" : "Add rule"}</button>
      <span className="bash-rules-note">{zh ? "从上到下匹配；路径分组保留原结构，不会转成全局规则。表单错误由 Runtime 返回。" : "Matched top to bottom. Path groups retain their structure, never becoming unscoped rules. The Runtime reports form errors."}</span>
      {modified ? <button type="button" className="btn small ghost" disabled={disabled} onClick={() => setRules(readRules(value, nextId))}>{zh ? "还原" : "Revert"}</button> : null}
      <button type="button" className="btn small outline" disabled={disabled || !dirty} onClick={() => save(toValue(rules))}>{zh ? "保存规则" : "Save rules"}</button>
    </div>
  </div>;
}

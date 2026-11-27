import { AppSelect } from "../AppSelect";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n";

/**
 * Structured key → positive-integer editor for the "numberRecord" GUI
 * settings (in-flight request caps and similar maps). One row per entry:
 * key control (picker when `keyOptions` is given, free text otherwise),
 * integer input and a remove action; fully empty rows are ignored on
 * apply, duplicate keys are rejected.
 */
export function NumberRecordEditor({ label, placeholder, keyOptions, value, disabled, onSave }: {
  label: string;
  placeholder?: string | undefined;
  keyOptions?: readonly { value: string; label: string }[] | undefined;
  value?: Record<string, number> | undefined;
  disabled?: boolean | undefined;
  onSave: (next: Record<string, number>) => void | Promise<void>;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [entries, setEntries] = useState<{ key: string; value: string }[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setEntries(Object.entries(value ?? {}).map(([key, entry]) => ({ key, value: String(entry) })));
    setError("");
  }, [value]);
  const apply = async () => {
    try {
      const next: Record<string, number> = {};
      for (const entry of entries) {
        const key = entry.key.trim();
        const raw = entry.value.trim();
        if (!key && !raw) continue;
        if (!key) throw new Error(zh ? "每行都需要填写键。" : "Every row needs a key.");
        if (!/^\d+$/u.test(raw) || Number(raw) < 1) throw new Error(zh ? `“${key}” 的值必须是 ≥1 的整数。` : `The value for “${key}” must be an integer >= 1.`);
        if (key in next) throw new Error(zh ? `“${key}” 出现了两次，请删掉多余的一行。` : `“${key}” appears twice; remove the extra row.`);
        next[key] = Number(raw);
      }
      setBusy(true);
      await onSave(next);
      setEntries(Object.entries(next).map(([key, entry]) => ({ key, value: String(entry) })));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return <div className="number-record-editor" aria-label={label}>
    {entries.map((entry, index) => <div className="number-record-row" key={index}>
      {keyOptions ? <AppSelect className="select" aria-label={zh ? "键" : "Key"} value={entry.key} disabled={disabled} onChange={e => setEntries(entries.map((row, i) => i === index ? { ...row, key: e.target.value } : row))}>
        <option value="">{zh ? "选择…" : "Choose…"}</option>
        {keyOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </AppSelect> :
        <input className="input" aria-label={zh ? "键" : "Key"} placeholder={placeholder ?? (zh ? "键（如 provider 或 provider/modelId）" : "Key (e.g. provider or provider/modelId)")} value={entry.key} disabled={disabled} onChange={e => setEntries(entries.map((row, i) => i === index ? { ...row, key: e.target.value } : row))} />}
      <input className="input" aria-label={zh ? "值" : "Value"} placeholder={zh ? "≥1 的整数" : "Integer >= 1"} type="number" min={1} step={1} value={entry.value} disabled={disabled} onChange={e => setEntries(entries.map((row, i) => i === index ? { ...row, value: e.target.value } : row))} />
      <button type="button" className="btn small" aria-label={zh ? "删除" : "Remove"} disabled={disabled} onClick={() => setEntries(entries.filter((_, i) => i !== index))}>{zh ? "删除" : "Remove"}</button>
    </div>)}
    <div className="number-record-actions">
      <button className="btn small" disabled={disabled} onClick={() => setEntries([...entries, { key: "", value: "" }])}>{zh ? "添加一行" : "Add row"}</button>
      <button className="btn small" disabled={disabled || busy} onClick={() => void apply()}>{zh ? "应用" : "Apply"}</button>
    </div>
    {error ? <span role="alert" className="small">{error}</span> : null}
  </div>;
}

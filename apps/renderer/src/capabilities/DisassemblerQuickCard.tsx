import type { DisassemblerStatus } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { usePreviewMode } from "../preview/PreviewContext";

const DATABASE_LIMIT = 3;

export function DisassemblerQuickCard({ status, available, loading, busy, error, selected, onRefresh, onOpen }: {
  status: DisassemblerStatus | undefined;
  available: boolean;
  loading: boolean;
  busy: boolean;
  error: string;
  selected: string | undefined;
  onRefresh: (() => void) | undefined;
  onOpen(id?: string): void;
}) {
  const { resolvedLanguage } = useI18n();
  const { preview, marks } = usePreviewMode();
  const zh = resolvedLanguage === "zh";
  const databases = status?.databases ?? [];
  const engine = status?.activeBackend === "ida" ? "IDA Pro" : status?.activeBackend === "ghidra" ? "Ghidra" :
    status?.backend === "none" ? (zh ? "仅文件头" : "Metadata only") :
    available && !status && !error ? (zh ? "检测引擎中…" : "Detecting engine…") : (zh ? "无活动引擎" : "No active engine");
  const refreshLabel = zh ? "刷新数据库" : "Refresh databases";
  const openLabel = zh ? "打开反汇编工作区" : "Open disassembler workspace";
  const remaining = databases.length - DATABASE_LIMIT;
  const empty = !available ? (zh ? "当前连接不支持反汇编" : "Disassembler unavailable on this connection") :
    loading ? (zh ? "正在读取项目数据库…" : "Loading project databases…") :
    status?.reason || (zh ? "尚未打开数据库" : "No open databases");

  return <section className="disassembler-quick" aria-label={zh ? "反汇编快捷卡" : "Disassembler quick card"}>
    <header className="disassembler-quick-head">
      <span className="disassembler-quick-engine" data-ready={status?.available || undefined} data-tip={status?.reason || engine}>{engine}</span>
      {preview && marks ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}
      <div className="disassembler-quick-actions">
        <button type="button" className="icon-btn" disabled={!onRefresh} aria-label={refreshLabel} data-tip={refreshLabel} onClick={onRefresh}><Icon name="refresh" /></button>
        <button type="button" className="icon-btn" aria-label={openLabel} data-tip={openLabel} onClick={() => onOpen()}><Icon name="external" /></button>
      </div>
    </header>
    {error ? <p className="disassembler-quick-message is-error" role="alert" data-tip={error}>{error}</p> : null}
    {databases.length ? <ul className="disassembler-quick-list">
      {databases.slice(0, DATABASE_LIMIT).map(row => <li key={row.id}>
        <button type="button" className="disassembler-quick-db" aria-current={row.id === selected || undefined} data-tip={row.path} disabled={busy} onClick={() => onOpen(row.id)}>
          <span className="disassembler-quick-db-icon"><Icon name="database" /></span>
          <span className="disassembler-quick-db-name"><strong>{row.module}</strong><small>{row.backend === "ida" ? "IDA Pro" : "Ghidra"} · {row.arch} / {row.bitness}-bit</small></span>
          {row.busy || row.state === "opening" ? <span className="disassembler-quick-running"><Icon name="clock" /> <span className="sr-only">{zh ? "分析中" : "Analyzing"}</span></span> : null}
          {row.dirty ? <span className="disassembler-dirty" role="img" aria-label={zh ? "未保存更改" : "Unsaved changes"} /> : null}
          <Icon name="chevron-r" extra="sm disassembler-quick-arrow" />
        </button>
      </li>)}
    </ul> : !error ? <p className="disassembler-quick-message" role="status" data-tip={empty}>{empty}</p> : null}
    {remaining > 0 ? <button type="button" className="btn small ghost disassembler-quick-more" onClick={() => onOpen()}>{zh ? `查看其余 ${remaining} 个数据库` : `View ${remaining} more`}</button> : null}
  </section>;
}

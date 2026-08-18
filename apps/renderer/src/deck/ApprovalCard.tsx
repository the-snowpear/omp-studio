import { Icon } from "../icons";
import { demoMark } from "./PromptHead";
import type { ApprovalView } from "./approvalContent";

export function ApprovalCard({
  view,
  demo,
  meta,
  disabled,
  submitError,
  onAllow,
  onAlways,
  onDeny,
}: {
  view: ApprovalView;
  demo?: boolean;
  meta?: string;
  disabled?: boolean;
  submitError?: boolean;
  onAllow: () => void;
  onAlways: () => void;
  onDeny: () => void;
}) {
  const high = view.risk === "high";
  return (
    <div className="approval-card">
      <div className="dk-top approval-head">
        <span className={`dk-kind ${high ? "high" : view.risk === "medium" ? "med" : "low"}`}>
          <Icon name="shield" extra="sm" />
        </span>
        <span className="dk-title">审批请求</span>
        <span className={`chip ${high ? "red" : view.risk === "medium" ? "amber" : "gray"} xs`}>
          {high ? "高风险" : view.risk === "medium" ? "中风险" : "低风险"}
        </span>
        <span className="dk-head-end">
          {demoMark(demo)}
          {meta ? <span className="dk-agent">{meta}</span> : null}
        </span>
      </div>
      <div className="approval-body">
        <p className="dk-sub">{view.title}</p>
        {view.command ? (
          <div className="codeblock dk-cmd"><div className="c-cmd">$ {view.command}</div></div>
        ) : null}
        {view.path ? <p className="dk-path">{view.path}{view.language ? ` · ${view.language}` : ""}</p> : null}
        {view.extra ? <pre className="dk-extra">{view.extra}</pre> : null}
        {view.reason ? <div className="dk-reason">{view.reason}</div> : null}
        {view.scope ? (
          <div className="dk-scope">
            <Icon name="folder" extra="sm" />
            范围：{view.scope}
          </div>
        ) : null}
      </div>
      {submitError ? (
        <p className="ask-error" role="alert">提交失败，卡片已保留。请重试。</p>
      ) : null}
      <div className="dk-actions">
        <button type="button" className="btn small danger" disabled={disabled} onClick={onDeny}>拒绝</button>
        <button
          type="button"
          className="btn small outline"
          disabled={disabled}
          data-tip="始终允许（暂未实现）"
          onClick={onAlways}
        >
          始终允许
        </button>
        <button type="button" className="btn small primary" disabled={disabled} onClick={onAllow}>允许一次</button>
      </div>
    </div>
  );
}

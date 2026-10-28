import { useState } from "react";

import { Icon } from "../icons";
import { demoMark } from "./PromptHead";
import type { ApprovalView } from "./approvalContent";
import { useI18n } from "../i18n";

export function ApprovalCard({
  view,
  demo,
  meta,
  disabled,
  submitError,
  onAllow,
  onAlways,
  onGrant,
  onDeny,
}: {
  view: ApprovalView;
  demo?: boolean;
  meta?: string;
  disabled?: boolean;
  submitError?: boolean;
  onAllow: () => void;
  onAlways: () => void;
  /** Remember a Runtime-offered grant for this session (`always: false`) or across sessions. */
  onGrant?: (scope: "folder" | "target", always: boolean) => void;
  onDeny: () => void;
}) {
  const [rememberOpen, setRememberOpen] = useState(false);
  const canSession = Boolean(view.configuration) || view.session !== undefined;
  const high = view.risk === "high";
  const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  return (
    <div className="approval-card">
      <div className="dk-top approval-head">
        <span className={`dk-kind ${high ? "high" : view.risk === "medium" ? "med" : "low"}`}>
          <Icon name="shield" extra="sm" />
        </span>
        <span className="dk-title">{view.configuration ? zh ? "配置更改审批" : "Configuration approval" : zh ? "审批请求" : "Approval request"}</span>
        <span className={`chip ${high ? "red" : view.risk === "medium" ? "amber" : "gray"} xs`}>
          {high ? zh ? "高风险" : "High risk" : view.risk === "medium" ? zh ? "中风险" : "Medium risk" : zh ? "低风险" : "Low risk"}
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
        {view.configuration ? <div className="dk-config-change">
          <div><strong>{zh ? "当前值" : "Current"}</strong><pre className="dk-extra">{view.configuration.previous}</pre></div>
          <div><strong>{zh ? "更改为" : "Proposed"}</strong><pre className="dk-extra">{view.configuration.value}</pre></div>
          <p className="dk-scope">{view.configuration.save ? zh ? "保存到全局配置" : "Save to global configuration" : zh ? "仅当前会话" : "Current session only"}</p>
          {view.configuration.shadowedBy ? <p className="dk-reason">{zh ? "生效值仍由此来源覆盖" : "Effective value remains overridden by"}: {view.configuration.shadowedBy}</p> : null}
          {view.configuration.expiresAt ? <p className="small muted">{zh ? "审批到期时间" : "Approval expires"} · {new Date(view.configuration.expiresAt).toLocaleTimeString()}</p> : null}
        </div> : null}
        {view.restriction ? <p className="dk-reason">{zh ? "受限目录：每次操作都需批准，不能记住或为本会话放行。" : "Restricted folder: each action needs approval; grants cannot cover it."}</p> : null}
        {view.extra ? <pre className="dk-extra">{view.extra}</pre> : null}
        {view.reason ? <div className="dk-reason">{view.reason}</div> : null}
        {view.scope ? (
          <div className="dk-scope">
            <Icon name="folder" extra="sm" />
            {zh ? "范围：" : "Scope: "}{view.scope}
          </div>
        ) : null}
      </div>
      {view.configuration ? null : (
        <p className="small muted dk-steer-hint">
          {zh ? "此时在输入框发送消息，会拒绝这次调用并把消息转交给 OMP。" : "Sending a message now denies this call and steers the turn."}
        </p>
      )}
      {submitError ? (
        <p className="ask-error" role="alert">{zh ? "提交失败，卡片已保留。请重试。" : "Submission failed. The card remains available for retry."}</p>
      ) : null}
      <div className="dk-actions">
        <button type="button" className="btn small danger" disabled={disabled} onClick={onDeny}>{zh ? "拒绝" : "Deny"}</button>
        {view.grants && onGrant ? (
          <span className="approval-remember">
            <button
              type="button"
              className="btn small outline"
              disabled={disabled}
              aria-haspopup="menu"
              aria-expanded={rememberOpen}
              onClick={() => setRememberOpen((open) => !open)}
            >
              {zh ? "记住…" : "Remember…"}
            </button>
            {rememberOpen ? (
              <div className="approval-menu approval-remember-menu" role="menu">
                {view.grants.flatMap((grant) => [
                  <button
                    type="button"
                    role="menuitem"
                    key={`${grant.scope}:session`}
                    className="approval-menu-item"
                    onClick={() => { setRememberOpen(false); onGrant(grant.scope, false); }}
                  >
                    <span className="am-label">{grant.label}</span>
                    <span className="am-desc">{zh ? "仅本会话" : "This session"}</span>
                  </button>,
                  <button
                    type="button"
                    role="menuitem"
                    key={`${grant.scope}:always`}
                    className="approval-menu-item"
                    onClick={() => { setRememberOpen(false); onGrant(grant.scope, true); }}
                  >
                    <span className="am-label">{grant.alwaysLabel}</span>
                    <span className="am-desc">{zh ? "跨会话记住" : "Across sessions"}</span>
                  </button>,
                ])}
              </div>
            ) : null}
          </span>
        ) : view.restriction ? null : (
          <button
            type="button"
            className="btn small outline"
            disabled={disabled || !canSession}
            data-tip={canSession ? view.session : zh ? "此审批仅支持单次允许" : "This approval supports one-time permission only"}
            onClick={onAlways}
          >
            {zh ? "本会话允许" : "Allow for session"}
          </button>
        )}
        <button type="button" className="btn small primary" disabled={disabled} onClick={onAllow}>{zh ? "允许一次" : "Allow once"}</button>
      </div>
    </div>
  );
}

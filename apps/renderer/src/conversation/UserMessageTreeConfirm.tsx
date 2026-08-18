import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../icons";
import {
  userMessageTreeConfirmCopy,
  type UserMessageTreeConfirmKind,
} from "./userMessageRestore";

export function UserMessageTreeConfirmDialog({
  kind,
  preview,
  onCancel,
  onConfirm,
}: {
  readonly kind: UserMessageTreeConfirmKind;
  readonly preview: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const copy = userMessageTreeConfirmCopy(kind);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return createPortal(
    <div className="modal-backdrop create-project-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="modal create-project-modal create-branch-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="userMessageTreeConfirmTitle"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="create-project-head">
          <div>
            <span className="create-project-kicker">{copy.kicker}</span>
            <h2 id="userMessageTreeConfirmTitle">{copy.title}</h2>
            <p className="create-branch-sub">{copy.body}</p>
          </div>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onCancel}><Icon name="x" /></button>
        </div>
        <div className="create-project-body">
          <p className="create-branch-hint">{preview ? copy.hintPreview : copy.hint}</p>
        </div>
        <div className="create-project-foot">
          <button type="button" className="btn outline" onClick={onCancel}>取消</button>
          <button type="button" className="btn primary" autoFocus onClick={onConfirm}>{copy.action}</button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

export function useUserMessageTreeConfirm(preview: boolean): {
  readonly ask: (kind: UserMessageTreeConfirmKind) => Promise<boolean>;
  readonly dialog: ReactNode;
} {
  const [kind, setKind] = useState<UserMessageTreeConfirmKind | null>(null);
  const resolveRef = useRef<((ok: boolean) => void) | undefined>(undefined);
  const close = useCallback((ok: boolean) => {
    const resolve = resolveRef.current;
    resolveRef.current = undefined;
    setKind(null);
    resolve?.(ok);
  }, []);
  const ask = useCallback((next: UserMessageTreeConfirmKind) => {
    resolveRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setKind(next);
    });
  }, []);
  useEffect(() => () => {
    resolveRef.current?.(false);
    resolveRef.current = undefined;
  }, []);
  return {
    ask,
    dialog: kind === null
      ? null
      : (
        <UserMessageTreeConfirmDialog
          kind={kind}
          preview={preview}
          onCancel={() => close(false)}
          onConfirm={() => close(true)}
        />
      ),
  };
}

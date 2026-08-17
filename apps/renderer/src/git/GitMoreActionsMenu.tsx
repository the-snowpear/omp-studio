import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Icon } from "../icons";

export type GitMoreActionItem = {
  readonly value: string;
  readonly label: string;
};

export type GitMoreActionGroup = {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly items: readonly GitMoreActionItem[];
  readonly disabled?: boolean;
};

export const GIT_MORE_ACTION_GROUPS: readonly GitMoreActionGroup[] = [
  {
    id: "branch",
    label: "分支",
    icon: "branch",
    items: [
      { value: "branch.create", label: "新建并切换分支" },
      { value: "branch.switch", label: "切换分支" },
      { value: "branch.rename", label: "重命名当前分支" },
      { value: "branch.delete", label: "删除分支" },
    ],
  },
  {
    id: "worktree",
    label: "Worktree",
    icon: "worktree",
    items: [
      { value: "worktree.root", label: "选择 Worktree 根目录" },
      { value: "worktree.create", label: "新建 Worktree" },
      { value: "worktree.lock", label: "锁定 Worktree" },
      { value: "worktree.unlock", label: "解锁 Worktree" },
      { value: "worktree.remove", label: "移除 Worktree" },
      { value: "worktree.prune", label: "Prune Worktree" },
    ],
  },
  {
    id: "history",
    label: "历史",
    icon: "history",
    items: [
      { value: "stash", label: "Stash 全部" },
      { value: "stash.pop", label: "Pop Stash" },
      { value: "merge", label: "Merge" },
      { value: "rebase", label: "Rebase" },
      { value: "cherry-pick", label: "Cherry-pick" },
      { value: "revert", label: "Revert" },
      { value: "reset", label: "Hard reset…" },
      { value: "tag.create", label: "创建 Tag" },
      { value: "tag.delete", label: "删除 Tag" },
    ],
  },
  {
    id: "remote",
    label: "远端",
    icon: "globe",
    items: [
      { value: "pull.rebase", label: "Pull --rebase" },
      { value: "pull.merge", label: "Pull --merge" },
      { value: "push.force", label: "Force-with-lease Push" },
      { value: "remote.add", label: "添加 Remote" },
      { value: "remote.set", label: "修改 Remote URL" },
      { value: "remote.remove", label: "移除 Remote" },
    ],
  },
  {
    id: "github",
    label: "GitHub",
    icon: "link",
    items: [
      { value: "auth", label: "登录 GitHub" },
      { value: "auth.logout", label: "退出 GitHub" },
      { value: "pr.create", label: "创建 PR" },
      { value: "pr.edit", label: "编辑 PR" },
      { value: "pr.comment", label: "评论 PR" },
      { value: "pr.review", label: "Review PR" },
      { value: "pr.update", label: "更新 PR 分支" },
      { value: "pr.merge", label: "合并 PR" },
      { value: "pr.close", label: "关闭 PR" },
      { value: "pr.reopen", label: "重新打开 PR" },
    ],
  },
];

function flatten(groups: readonly GitMoreActionGroup[]): GitMoreActionItem[] {
  return groups.flatMap((group) => (group.disabled ? [] : [...group.items]));
}

export function GitMoreActionsMenu({
  disabled,
  githubDisabled,
  onPick,
}: {
  readonly disabled?: boolean;
  readonly githubDisabled?: boolean;
  readonly onPick?: (value: string) => void;
}) {
  const uid = useId();
  const listId = `${uid}-list`;
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ top: 0, left: 0, width: 240 });
  const [active, setActive] = useState<string>();
  const activeRef = useRef(active);
  const onPickRef = useRef(onPick);
  activeRef.current = active;
  onPickRef.current = onPick;

  const groups = useMemo(
    () => GIT_MORE_ACTION_GROUPS.map((group) => (group.id === "github" && githubDisabled ? { ...group, disabled: true } : group)),
    [githubDisabled],
  );
  const flat = useMemo(() => flatten(groups), [groups]);

  const place = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(rect.width, 240);
    const height = popRef.current?.offsetHeight ?? 0;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    let top = rect.bottom + 6;
    if (height > 0 && top + height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - height - 6);
    }
    setAnchor({ top, left, width });
  };

  const dismiss = () => setOpen(false);

  const pick = (value: string) => {
    onPickRef.current?.(value);
    dismiss();
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, groups.length]);

  useEffect(() => {
    if (!open) return;
    setActive(flat[0]?.value);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
        btnRef.current?.focus();
        return;
      }
      const current = activeRef.current;
      const index = Math.max(0, flat.findIndex((item) => item.value === current));
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (flat.length === 0) return;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const next = flat[(index + delta + flat.length) % flat.length];
        if (next) setActive(next.value);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const item = flat.find((entry) => entry.value === current) ?? flat[index];
        if (item) pick(item.value);
      }
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (btnRef.current?.contains(target) || popRef.current?.contains(target)) return;
      dismiss();
    };
    const onReposition = () => place();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, flat]);

  useLayoutEffect(() => {
    if (!open) return;
    popRef.current?.querySelector<HTMLElement>("[data-active='true']")?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  return (
    <div className="git-more">
      <button
        ref={btnRef}
        type="button"
        className={`git-more-trigger${open ? " is-open" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label="更多 Git 操作"
        onClick={() => {
          if (open) {
            dismiss();
            return;
          }
          setOpen(true);
        }}
      >
        <span>更多操作…</span>
        <Icon name={open ? "chevron-u" : "chevron-d"} extra="sm" />
      </button>
      {open
        ? createPortal(
            <div
              ref={popRef}
              id={listId}
              className="menu rms-pop git-more-pop"
              role="listbox"
              aria-label="更多 Git 操作"
              style={{ top: anchor.top, left: anchor.left, width: anchor.width }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              {groups.map((group) => (
                <div className="rms-group" key={group.id} role="group" aria-label={group.label} aria-disabled={group.disabled || undefined}>
                  <div className="rms-group-label">
                    <span className="rms-brand" aria-hidden="true"><Icon name={group.icon} extra="sm" /></span>
                    <span className="rms-group-name">{group.label}</span>
                    <span className="rms-group-count">{group.items.length}</span>
                  </div>
                  {group.items.map((item) => {
                    const isActive = item.value === active;
                    return (
                      <button
                        type="button"
                        key={item.value}
                        role="option"
                        aria-selected={isActive}
                        data-active={isActive ? "true" : undefined}
                        className={`menu-item rms-option git-more-option${isActive ? " is-active" : ""}`}
                        disabled={disabled || group.disabled}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => pick(item.value)}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

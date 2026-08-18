import { useId, useState } from "react";
import { Icon } from "../icons";
import type { TurnFileChange } from "./toolMeta";

const CODE_FILE = /\.(tsx?|jsx?|mjs|cjs|css|scss|html?|json|md|py|rs|go|vue|svelte)$/i;

function fileIcon(name: string): "file-code" | "file" {
  return CODE_FILE.test(name) ? "file-code" : "file";
}

export function TurnDiffCard({
  files,
  defaultOpen,
  demo,
  onReview,
}: {
  files: readonly TurnFileChange[];
  defaultOpen?: boolean;
  demo?: boolean;
  onReview?: () => void;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(defaultOpen === true);
  const add = files.reduce((sum, file) => sum + file.add, 0);
  const del = files.reduce((sum, file) => sum + file.del, 0);
  const countLabel = `${files.length} 个文件已更改`;
  const statsLabel = [add ? `新增 ${add} 行` : "", del ? `删除 ${del} 行` : ""].filter(Boolean).join("，");
  const toggleLabel = `${countLabel}${statsLabel ? `，${statsLabel}` : ""}，${open ? "收起" : "展开"}文件列表`;

  return (
    <div className={`turn-diff${open ? " open" : ""}`}>
      <div className="turn-diff-head">
        <button
          type="button"
          className="turn-diff-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={toggleLabel}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name="chevron-r" extra="sm turn-diff-chev" />
          <span className="turn-diff-count">{countLabel}</span>
          {add || del ? (
            <span className="turn-diff-stats" aria-hidden="true">
              {add ? <span className="add">+{add}</span> : null}
              {del ? <span className="del">−{del}</span> : null}
            </span>
          ) : null}
          {demo === true ? <span className="chip gray xs">演示</span> : null}
        </button>
        <button
          type="button"
          className="btn small turn-diff-review"
          onClick={onReview}
          data-tip={demo === true ? "Changes（演示）" : "Changes"}
        >
          <Icon name="diff" extra="sm" />
          审核
        </button>
      </div>
      {/* 面板常驻 DOM 以驱动 0fr→1fr 高度过渡；关闭态用 inert 保持不可聚焦 */}
      <div
        className="turn-diff-panel"
        id={panelId}
        aria-hidden={!open}
        inert={open ? undefined : true}
      >
        <div className="turn-diff-panel-inner">
          <ul className="turn-diff-files">
            {files.map((file) => (
              <li key={file.path} className="turn-diff-row">
                <span className="turn-diff-icon" aria-hidden="true">
                  <Icon name={fileIcon(file.name)} extra="sm" />
                </span>
                <span className="turn-diff-name" data-tip={file.path}>{file.name}</span>
                {file.dir ? <span className="turn-diff-dir" data-tip={file.dir}>{file.dir}</span> : null}
                {file.add || file.del ? (
                  <span className="turn-diff-file-stats">
                    {file.add ? <span className="add">+{file.add}<span className="sr-only"> 行新增</span></span> : null}
                    {file.del ? <span className="del">−{file.del}<span className="sr-only"> 行删除</span></span> : null}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

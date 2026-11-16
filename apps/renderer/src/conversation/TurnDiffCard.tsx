import { AnnotationButton } from "../annotations/Annotations";
import { useId, useState, type CSSProperties } from "react";
import { Icon } from "../icons";
import { fileTypeOf, iconNameFor, isSensitive } from "../explorer-types";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import type { TurnFileChange } from "./toolMeta";

/** 限高态可见行数：超过该数的列表在卡内滚动（与 workbench.css 的 36px 行高配套）。 */
const ROW_CAP = 6;

type TurnDiffStage = "collapsed" | "capped" | "full";

function stageHint(stage: TurnDiffStage, zh: boolean): string {
  if (stage === "collapsed") return zh ? "已收起，点击展开" : "Collapsed, click to expand";
  if (stage === "capped") return zh ? "限高显示，点击全部展开" : "Height-capped, click to expand all";
  return zh ? "全部展开，点击收起" : "Expanded, click to collapse";
}

function nextStage(stage: TurnDiffStage, capped: boolean): TurnDiffStage {
  if (!capped) return stage === "collapsed" ? "full" : "collapsed";
  return stage === "collapsed" ? "capped" : stage === "capped" ? "full" : "collapsed";
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
  const { marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const capped = files.length > ROW_CAP;
  // 最新完成轮默认进限高态；不超过限高时直接全展，避免一次无视觉效果的多余点击
  const [stage, setStage] = useState<TurnDiffStage>(
    defaultOpen === true ? (capped ? "capped" : "full") : "collapsed",
  );
  const add = files.reduce((sum, file) => sum + file.add, 0);
  const del = files.reduce((sum, file) => sum + file.del, 0);
  const countLabel = zh
    ? `${files.length} 个文件已更改`
    : `${files.length} ${files.length === 1 ? "file" : "files"} changed`;
  const statsLabel = [
    add ? (zh ? `新增 ${add} 行` : `added ${add} ${add === 1 ? "line" : "lines"}`) : "",
    del ? (zh ? `删除 ${del} 行` : `removed ${del} ${del === 1 ? "line" : "lines"}`) : "",
  ].filter(Boolean).join(zh ? "，" : ", ");
  const toggleLabel = zh
    ? `${countLabel}${statsLabel ? `，${statsLabel}` : ""}，${stageHint(stage, zh)}`
    : `${countLabel}${statsLabel ? `, ${statsLabel}` : ""}, ${stageHint(stage, zh)}`;

  return (
    <div
      className={`turn-diff${stage !== "collapsed" ? " open" : ""}${stage === "capped" ? " capped" : ""}`}
      style={{ "--turn-diff-cap-rows": ROW_CAP } as CSSProperties}
    >
      <div className="turn-diff-head">
        <button
          type="button"
          className="turn-diff-toggle"
          aria-expanded={stage !== "collapsed"}
          aria-controls={panelId}
          aria-label={toggleLabel}
          onClick={() => setStage((value) => nextStage(value, capped))}
        >
          <Icon name="chevron-r" extra="sm turn-diff-chev" />
          <span className="turn-diff-count">{countLabel}</span>
          {add || del ? (
            <span className="turn-diff-stats" aria-hidden="true">
              {add ? <span className="add">+{add}</span> : null}
              {del ? <span className="del">−{del}</span> : null}
            </span>
          ) : null}
          {demo === true && marks ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}
        </button>
        <button
          type="button"
          className="btn small turn-diff-review"
          onClick={onReview}
          data-tip={demo === true && marks ? (zh ? "Changes（演示）" : "Changes (Demo)") : "Changes"}
        >
          <Icon name="diff" extra="sm" />
          {zh ? "审核" : "Review"}
        </button>
        <AnnotationButton source={{ kind: "diff" }} label={zh ? "标注" : "Annotate"} className="btn small turn-diff-review" />
      </div>
      {/* 面板常驻 DOM 以驱动 0fr→1fr 高度过渡；关闭态用 inert 保持不可聚焦 */}
      <div
        className="turn-diff-panel"
        id={panelId}
        aria-hidden={stage === "collapsed"}
        inert={stage === "collapsed" ? undefined : true}
      >
        <div className="turn-diff-panel-inner">
          <ul className="turn-diff-files">
            {files.map((file) => {
              const ftype = fileTypeOf(file.name);
              return (
                <li
                  key={file.path}
                  className="turn-diff-row"
                  data-ftype={ftype ?? undefined}
                  data-secret={isSensitive(file.name) || undefined}
                >
                  <span className="turn-diff-icon" aria-hidden="true">
                    <Icon name={iconNameFor(ftype, file.name)} extra="sm" />
                  </span>
                  <span className="turn-diff-name" data-tip={file.path}>{file.name}</span>
                  {file.dir ? <span className="turn-diff-dir" data-tip={file.dir}>{file.dir}</span> : null}
                  {file.add || file.del ? (
                    <span className="turn-diff-file-stats">
                      {file.add ? <span className="add">+{file.add}<span className="sr-only">{zh ? " 行新增" : ` ${file.add === 1 ? "line" : "lines"} added`}</span></span> : null}
                      {file.del ? <span className="del">−{file.del}<span className="sr-only">{zh ? " 行删除" : ` ${file.del === 1 ? "line" : "lines"} removed`}</span></span> : null}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

import { RasterPreview } from "../TerminalGraphicView";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import type { ComputerToolMediaItem } from "../conversation/toolMeta";
import { useComputerLink } from "./links";
import "./computerWorkspace.css";

export function ComputerToolMedia({ items }: { items: ComputerToolMediaItem[] }) {
  const open = useComputerLink(), { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  return items.length ? <div className="cw-tool-media">{items.map(item => <div className="cw-tool-frame" key={item.key} data-computer-frame={item.frame?.frameId}>
    {item.image ? <RasterPreview value={item.image} alt={zh ? "电脑工具截图" : "Computer tool screenshot"} /> : <p><Icon name="image" />{zh ? "执行截图" : "Execution frame"}</p>}
    {item.frame ? <button className="cw-button" disabled={!open} onClick={() => open?.(item.frame!)}><Icon name="monitor" />{zh ? "在电脑中查看" : "View in Computer"}</button> : null}
  </div>)}</div> : null;
}

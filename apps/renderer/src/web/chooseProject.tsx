import { createRoot } from "react-dom/client";
import { useState } from "react";
import { I18nProvider, useI18n } from "../i18n";
import type { StudioClient } from "@omp-studio/client-contract";

function ProjectPath({ done }: { done: (path?: string) => void }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [path, setPath] = useState("");
  return (
    <div className="web-dialog-backdrop">
      <form
        className="web-dialog web-project-path"
        role="dialog"
        aria-modal="true"
        onSubmit={(event) => {
          event.preventDefault();
          done(path.trim());
        }}
      >
        <header>
          <h2>{zh ? "打开主机上的项目" : "Open a project on the Host"}</h2>
          <button
            type="button"
            onClick={() => done()}
            aria-label={zh ? "关闭" : "Close"}
          >
            ×
          </button>
        </header>
        <label>
          {zh ? "项目文件夹的绝对路径" : "Absolute path to the project folder"}
          <input
            autoFocus
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={
              zh
                ? "例如 /home/me/project 或 D:\\Projects\\app"
                : "e.g. /home/me/project or D:\\Projects\\app"
            }
          />
        </label>
        <button className="web-primary" disabled={!path.trim()} type="submit">
          {zh ? "打开项目" : "Open project"}
        </button>
      </form>
    </div>
  );
}

export async function pickProject(client: StudioClient, name?: string) {
  if (!globalThis.OMP_STUDIO_WEB_ENTRY)
    return client.command("workspace.pick", name ? { name } : {});
  const path = await new Promise<string | undefined>((done) => {
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    root.render(
      <I18nProvider>
        <ProjectPath
          done={(value) => {
            root.unmount();
            element.remove();
            done(value);
          }}
        />
      </I18nProvider>,
    );
  });
  return path ? client.command("workspace.openPath", { path }) : undefined;
}

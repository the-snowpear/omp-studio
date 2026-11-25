import{i as s}from"./App-Bh147Hgb.js";function t(e=s()){return[{source:"claude",sourceId:"demo-claude",title:e?"检查 SessionChanges 的重命名处理":"Review SessionChanges rename handling",directoryName:"omp-studio",cwdExists:!0,modifiedAt:"2026-09-18T08:00:00Z",messageCount:4,firstMessage:e?"请检查重命名文件的 diff 展示。":"Please check diff rendering for renamed files."},{source:"claude",sourceId:"demo-claude-moved",title:e?"迁移工作区后的会话恢复":"Resume session after moving workspace",directoryName:"omp-studio-legacy",cwdExists:!1,modifiedAt:"2026-09-17T08:00:00Z",messageCount:8,firstMessage:e?"保留原有对话，把后续工作移到当前工作区。":"Keep the original conversation and move follow-up work to the current workspace."},{source:"codex",sourceId:"demo-codex",title:e?"验证会话恢复后的 diff":"Verify diff after session resume",directoryName:"omp-studio",cwdExists:!0,modifiedAt:"2026-09-18T08:30:00Z",messageCount:6,firstMessage:e?"验证恢复后的文件变更与代码检查点。":"Verify file changes and code checkpoints after resuming."}]}function o(e=s()){return e?`user: 请检查重命名文件的 diff 展示。

assistant: 已定位会话变更投影，接下来覆盖恢复后的显示。`:`user: Please check diff rendering for renamed files.

assistant: Located the session change projection; next I'll cover post-resume display.`}function i(e=s()){return{"demo-claude":o(e),"demo-claude-moved":e?`user: 保留原有对话，把后续工作移到当前工作区。

assistant: 原工作目录已迁移。导入时选择现有工作区，可以保留对话并继续处理会话恢复。`:`user: Keep the original conversation and move follow-up work to the current workspace.

assistant: The original working directory moved. Choose an existing workspace on import to preserve history and continue resuming.`,"demo-codex":e?`user: 验证恢复后的文件变更与代码检查点。

assistant: 恢复后已对齐文件变更和检查点。接下来验证工作区切换与 diff 的显示。`:`user: Verify file changes and code checkpoints after resuming.

assistant: Aligned file changes and checkpoints after resume. Next I'll verify workspace switching and diff rendering.`}}t();o();i();const n=[{workspaceId:"demo-import-workspace",name:"omp-studio",lastOpenedAt:"2026-09-18T08:00:00Z",active:!0},{workspaceId:"demo-import-worktree",name:"omp-studio-session-storage",lastOpenedAt:"2026-09-17T08:00:00Z",active:!1}],a=[{agent:"m1",selector:"deepseek/deepseek-chat",name:"DeepSeek"}];export{n as P,i as a,a as b,t as g};

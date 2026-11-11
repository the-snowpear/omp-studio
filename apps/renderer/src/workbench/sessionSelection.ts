import { PROJECT_HISTORY_INITIAL_LIMIT, PROJECT_HISTORY_PAGE_SIZE, PROJECT_HISTORY_QUERY_MAX } from "../sidebar/useProjectHistories";

export const CURRENT_PROJECT = { id: "omp-studio", name: "OMP Studio" } as const;

export type SelectedProject = { readonly id: string; readonly name: string };

/* 项目会话列表分页：默认 6 条，「展开更多」每次追加 10 条；
   QUERY_MAX 对齐 Host 侧 history.list 的上限（HISTORY_MAX_LIMIT = 200）。 */
export const PROJECT_THREADS_INITIAL = PROJECT_HISTORY_INITIAL_LIMIT;

export const PROJECT_THREADS_PAGE = PROJECT_HISTORY_PAGE_SIZE;

export const PROJECT_THREADS_QUERY_MAX = PROJECT_HISTORY_QUERY_MAX;

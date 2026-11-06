/**
 * Explorer 文件类型体系 —— 颜色与形状的唯一真相源。
 *
 * 规格：`tmp/explorer-icons/spec.md` §4（实现契约）。本文件只做三件事：
 *   1. 文件名 → `FileTypeId`（纯函数，模块级记忆化）
 *   2. `FileTypeId` + 精确文件名 → `IconName`（形状），色由 CSS 从 `data-ftype` 派生
 *   3. 噪音目录 / 敏感文件的判定
 *
 * 两个轴必须正交（spec §4.2）：`pin` 只覆盖形状、从不改色；`ftype` 只决定颜色。
 * 之所以不能把 icon 塞进 `FILE_TYPE_META` 一步到位置，是因为那样 `README.md`
 * 永远只能画 `doc`，`book`/`zap`/`wrench`/`layers` 这些旗舰形状根本出不来。
 *
 * 五处调用点共用本模块，禁止再各写一份正则：
 *   App.tsx（Explorer 真树）/ preview/surfaces.tsx（预览树）
 *   conversation/ChangesPanel.tsx · TaskProgressDock.tsx · TurnDiffCard.tsx
 */
import type { IconName } from "./icons";

export type FileTypeId =
  | "code"
  | "markup"
  | "style"
  | "data"
  | "doc"
  | "config"
  | "script"
  | "test"
  | "package"
  | "lock"
  | "image"
  | "secret";

/**
 * 12 个类别只对应 8 个彩色 token，另 4 个是别名（`tokens.css` 里指到 `--text-3`
 * 或 `--ftype-data`）。token 只描述"这一类是什么"，永久禁止拿去表达状态
 * （git 状态 / 诊断 / 读写中 / 失败）—— 规格 §2 C1-B1。
 */
export const FILE_TYPE_META = {
  code: { icon: "code", token: "--ftype-code" },
  markup: { icon: "tag", token: "--ftype-markup" },
  style: { icon: "droplet", token: "--ftype-style" },
  data: { icon: "table", token: "--ftype-data" },
  doc: { icon: "doc", token: "--ftype-doc" },
  config: { icon: "sliders", token: "--ftype-config" },
  script: { icon: "terminal", token: "--ftype-script" },
  test: { icon: "flask", token: "--ftype-test" },
  package: { icon: "package", token: "--ftype-package" },
  lock: { icon: "lock", token: "--ftype-lock" },
  image: { icon: "image", token: "--ftype-image" },
  secret: { icon: "shield-key", token: "--ftype-secret" },
} satisfies Record<FileTypeId, { icon: IconName; token: `--ftype-${string}` }>;

/**
 * 精确文件名 → 形状覆盖。**只改形不改色**：颜色仍由 `fileTypeOf` 的结果决定。
 *
 * 只收 spec §1.2 存活下来的 6 个旗舰（`book` / `eye-off` / `zap` / `wrench` /
 * `history` / `layers`）。`package.json` / `pnpm-lock.yaml` / `*.test.tsx` 不在此表
 * ——它们的"类别即旗舰"，写进来是同形同色的虚数；`tsconfig.json` 的 `braces`
 * 已整条砍掉（14px 下读作圆括号、ink 仅 14%），退回 `config` → `sliders`。
 *
 * 键一律小写，查表前把文件名小写：`README.md` 与 `readme.md` 必须同形。
 * 只放精确名（无 glob），O(1)。
 */
export const PINNED_ICON: Record<string, IconName> = {
  // —— 文档入口 ——
  "readme.md": "book",
  "readme.mdx": "book",
  "changelog.md": "history",
  "history.md": "history",
  // —— "文件为什么不见"的答案入口 ——
  ".gitignore": "eye-off",
  ".gitattributes": "eye-off",
  ".npmignore": "eye-off",
  // —— 构建入口 ——
  "vite.config.ts": "zap",
  "webpack.config.js": "zap",
  "next.config.js": "zap",
  "tsup.config.ts": "zap",
  "rollup.config.mjs": "zap",
  // —— 质量规则入口 ——
  ".eslintrc": "wrench",
  ".eslintrc.js": "wrench",
  ".eslintrc.cjs": "wrench",
  ".eslintrc.json": "wrench",
  "eslint.config.js": "wrench",
  "eslint.config.mjs": "wrench",
  ".prettierrc": "wrench",
  ".prettierrc.json": "wrench",
  "prettier.config.js": "wrench",
  "biome.json": "wrench",
  ".stylelintrc": "wrench",
  ".stylelintrc.json": "wrench",
  ".stylelintrc.js": "wrench",
  "stylelint.config.js": "wrench",
  // —— 部署边界 ——
  dockerfile: "layers",
  "docker-compose.yml": "layers",
  "docker-compose.yaml": "layers",
  // —— 密钥：`.env` 走钥匙形，其余密钥后缀（.pem/.key/…）走 shield-key ——
  ".env": "key",
  ".env.local": "key",
  ".env.development": "key",
  ".env.production": "key",
  ".env.test": "key",
};

/** 行为层清单（8 项，与 `composer/mentions.ts` 共用同一来源）。 */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "vendor",
  "__pycache__",
]);

/**
 * 视觉层额外的非点号容器目录。**不进行为层**：是否从 @ 提及里跳过是产品决策。
 * `.git` / `.next` / `.turbo` 等 13 个点目录不写进来 —— `startsWith(".")` 已覆盖，
 * 硬编码只会留下"两处清单要同步"的长期债（spec §2 C4）。
 */
const EXTRA_NOISE: ReadonlySet<string> = new Set(["output", "tmp", "venv"]);

/** 精确文件名表。小写比较。优先级最高（spec §4.2 第 1 步）。 */
const FILENAME_TYPE: Readonly<Record<string, FileTypeId>> = {
  // —— 清单 / 锁 / 工作区 ——
  "package.json": "package",
  "composer.json": "package",
  "package-lock.json": "lock",
  "pnpm-lock.yaml": "lock",
  "yarn.lock": "lock",
  "bun.lockb": "lock",
  "cargo.lock": "lock",
  "poetry.lock": "lock",
  "pnpm-workspace.yaml": "config",
  "turbo.json": "config",
  "nx.json": "config",
  "lerna.json": "config",
  "biome.json": "config",
  "renovate.json": "config",
  // —— 工具配置 ——
  "tsconfig.json": "config",
  "jsconfig.json": "config",
  ".editorconfig": "config",
  ".eslintrc": "config",
  ".eslintrc.js": "config",
  ".eslintrc.cjs": "config",
  ".eslintrc.json": "config",
  "eslint.config.js": "config",
  "eslint.config.mjs": "config",
  ".prettierrc": "config",
  ".prettierrc.json": "config",
  "prettier.config.js": "config",
  ".babelrc": "config",
  ".browserslistrc": "config",
  ".nvmrc": "config",
  ".node-version": "config",
  "vite.config.ts": "config",
  "vitest.config.ts": "config",
  "webpack.config.js": "config",
  "rollup.config.mjs": "config",
  "tsup.config.ts": "config",
  "next.config.js": "config",
  "tailwind.config.ts": "config",
  "postcss.config.js": "config",
  "playwright.config.ts": "config",
  "docker-compose.yml": "config",
  "docker-compose.yaml": "config",
  dockerfile: "config",
  makefile: "script",
  // —— 文档 / 忽略 / 密钥 ——
  "readme.md": "doc",
  "readme.mdx": "doc",
  "changelog.md": "doc",
  "contributing.md": "doc",
  license: "doc",
  "license.md": "doc",
  "code_of_conduct.md": "doc",
  ".gitignore": "config",
  ".gitattributes": "config",
  ".npmignore": "config",
  ".dockerignore": "config",
  ".env": "secret",
  ".env.local": "secret",
  ".env.development": "secret",
  ".env.production": "secret",
  ".env.test": "secret",
  ".env.example": "config",
  ".npmrc": "secret",
  ".yarnrc": "secret",
  ".netrc": "secret",
  ".pypirc": "secret",
  id_rsa: "secret",
  id_dsa: "secret",
  id_ecdsa: "secret",
  id_ed25519: "secret",
  "credentials.json": "secret",
  "service-account.json": "secret",
  "secrets.yml": "secret",
  "secrets.yaml": "secret",
  ".htpasswd": "secret",
};

/**
 * 多段后缀表。**永远在多段里判定，且在单段之前**，否则 `x.config.ts` 会被
 * `.ts` 抢走变成 `code`（spec §5-M2）。表序不参与判定：模块加载时按长度降序
 * 排一次，让"更具体的长后缀先命中"成为结构不变式，而不是作者记得手排。
 */
const MULTI_SUFFIX_RAW = [
  // 测试 / 故事
  [".test.tsx", "test"],
  [".spec.tsx", "test"],
  [".test.jsx", "test"],
  [".spec.jsx", "test"],
  [".test.mts", "test"],
  [".test.ts", "test"],
  [".spec.ts", "test"],
  [".test.js", "test"],
  [".spec.js", "test"],
  // 故事是组件变体，不是测试（spec §5-M3 取 `code`）
  [".stories.tsx", "code"],
  [".stories.ts", "code"],
  // 声明文件仍是代码
  [".d.ts", "code"],
  // 工具链配置必须先于 .ts/.js/.mjs/.cjs
  [".config.ts", "config"],
  [".config.js", "config"],
  [".config.mjs", "config"],
  [".config.cjs", "config"],
  // 样式
  [".module.css", "style"],
  [".module.scss", "style"],
] as const satisfies ReadonlyArray<readonly [string, FileTypeId]>;

const MULTI_SUFFIX_TYPE: ReadonlyArray<readonly [string, FileTypeId]> = MULTI_SUFFIX_RAW
  .slice()
  .sort((left, right) => right[0].length - left[0].length);

/** 单段后缀表。 */
const SINGLE_SUFFIX_TYPE: ReadonlyArray<readonly [string, FileTypeId]> = [
  // 样式
  [".css", "style"],
  [".scss", "style"],
  [".sass", "style"],
  [".less", "style"],
  [".styl", "style"],
  // 标记
  [".html", "markup"],
  [".htm", "markup"],
  [".xml", "markup"],
  [".hbs", "markup"],
  [".ejs", "markup"],
  [".vue", "markup"],
  [".svelte", "markup"],
  // 数据
  [".json", "data"],
  [".jsonc", "data"],
  [".json5", "data"],
  [".yaml", "data"],
  [".yml", "data"],
  [".toml", "data"],
  [".ini", "data"],
  [".csv", "data"],
  [".tsv", "data"],
  [".ipynb", "data"],
  [".graphql", "data"],
  [".gql", "data"],
  // 代码
  [".tsx", "code"],
  [".ts", "code"],
  [".mts", "code"],
  [".cts", "code"],
  [".jsx", "code"],
  [".js", "code"],
  [".mjs", "code"],
  [".cjs", "code"],
  [".py", "code"],
  [".pyi", "code"],
  [".rs", "code"],
  [".go", "code"],
  [".java", "code"],
  [".kt", "code"],
  [".kts", "code"],
  [".rb", "code"],
  [".php", "code"],
  [".c", "code"],
  [".h", "code"],
  [".cc", "code"],
  [".cpp", "code"],
  [".hpp", "code"],
  [".cs", "code"],
  [".swift", "code"],
  [".scala", "code"],
  [".ex", "code"],
  [".exs", "code"],
  [".erl", "code"],
  [".lua", "code"],
  [".sql", "code"],
  [".zig", "code"],
  // 脚本
  [".sh", "script"],
  [".bash", "script"],
  [".zsh", "script"],
  [".fish", "script"],
  [".ps1", "script"],
  [".bat", "script"],
  [".cmd", "script"],
  // 文档
  [".md", "doc"],
  [".mdx", "doc"],
  [".txt", "doc"],
  [".rst", "doc"],
  [".adoc", "doc"],
  [".pdf", "doc"],
  // 图片
  [".png", "image"],
  [".jpg", "image"],
  [".jpeg", "image"],
  [".gif", "image"],
  [".webp", "image"],
  [".avif", "image"],
  [".ico", "image"],
  [".bmp", "image"],
  [".svg", "image"],
  // 锁 / 密钥
  [".lock", "lock"],
  [".pem", "secret"],
  [".key", "secret"],
  [".p12", "secret"],
  [".pfx", "secret"],
  [".keystore", "secret"],
  [".jks", "secret"],
  [".crt", "secret"],
  [".cer", "secret"],
  [".kdbx", "secret"],
];

/** `.env*` 里这几个是模板，不是密钥 —— 模板该被看见、被提交（spec §5-M1）。 */
const ENV_TEMPLATES: ReadonlySet<string> = new Set([
  ".env.example",
  ".env.template",
  ".env.sample",
]);

/** 敏感文件名（不含 `id_rsa.pub`：公钥不是密钥，spec §5-M6）。 */
const SENSITIVE_FILENAMES: ReadonlySet<string> = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  ".npmrc",
  ".yarnrc",
  ".netrc",
  ".pypirc",
  ".htpasswd",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials.json",
  "service-account.json",
  "secrets.yml",
  "secrets.yaml",
]);

const SENSITIVE_SUFFIX: ReadonlyArray<string> = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".keystore",
  ".jks",
  ".crt",
  ".cer",
  ".gpg",
  ".kdbx",
];

function computeFileType(name: string): FileTypeId | null {
  const lower = name.toLowerCase();
  // 1. 精确文件名
  const exact = FILENAME_TYPE[lower];
  if (exact !== undefined) return exact;
  // 2. `.env` 前缀 —— 必须早于后缀表，否则 `.env.staging` 会一路落空到 null，
  //    结果是"该标红的密钥文件完全不标"（spec §5-M1）。模板不是密钥，退回 config。
  if (lower.startsWith(".env")) return ENV_TEMPLATES.has(lower) ? "config" : "secret";
  // 3. 多段后缀（长度降序，命中即停）
  for (const [suffix, type] of MULTI_SUFFIX_TYPE) {
    if (lower.endsWith(suffix)) return type;
  }
  // 4. 单段后缀
  for (const [suffix, type] of SINGLE_SUFFIX_TYPE) {
    if (lower.endsWith(suffix)) return type;
  }
  // 5. 未识别：落回中性 file，不上色、不输出 data-ftype
  return null;
}

/**
 * 记忆化是必需的：每帧 × 每行都会调一次，而后缀表是 100+ 条 `endsWith` 线性扫描；
 * 一个仓里 `package.json` 能有 20 个。上限 4096 后整体 clear —— 简单粗暴但可预测，
 * 不用 LRU（树的规模远小于 4096，clear 实际上不会发生）。
 */
const CACHE = new Map<string, FileTypeId | null>();
const CACHE_MAX = 4096;

export function fileTypeOf(name: string): FileTypeId | null {
  const hit = CACHE.get(name);
  if (hit !== undefined) return hit;
  const value = computeFileType(name);
  if (CACHE.size > CACHE_MAX) CACHE.clear();
  CACHE.set(name, value);
  return value;
}

/** 形 = 精确名覆盖 ?? 类别的形 ?? `file`。未识别类型永久只做 fallback。 */
export function iconNameFor(ftype: FileTypeId | null, name: string): IconName {
  const lower = name.toLowerCase();
  const pinned = PINNED_ICON[lower as keyof typeof PINNED_ICON];
  if (pinned !== undefined) return pinned;
  /* `.env.staging` / `.env.production.local` 这类未逐条登记的环境文件与
     `.env.local` 同族，形状必须一致：前缀命中一律走钥匙，不要落到类别形的盾牌。
     模板（`.env.example` 等）类型是 config，走 sliders，不受此规则影响。 */
  if (ftype === "secret" && lower.startsWith(".env")) return "key";
  return ftype === null ? "file" : FILE_TYPE_META[ftype].icon;
}

/** 噪音目录 = 行为层 ∪ 点目录 ∪ 少数非点号容器目录。恒有 `isNoiseDir ⊇ SKIPPED_DIRS`。 */
export function isNoiseDir(name: string): boolean {
  const lower = name.toLowerCase();
  return SKIPPED_DIRS.has(lower) || lower.startsWith(".") || EXTRA_NOISE.has(lower);
}

/** 敏感文件 = 密钥文件名 / 密钥后缀 / `.env*`（模板除外）。 */
export function isSensitive(name: string): boolean {
  const lower = name.toLowerCase();
  if (SENSITIVE_FILENAMES.has(lower)) return true;
  if (lower.startsWith(".env") && !ENV_TEMPLATES.has(lower)) return true;
  return SENSITIVE_SUFFIX.some((suffix) => lower.endsWith(suffix));
}

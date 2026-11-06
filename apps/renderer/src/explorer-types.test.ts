import { describe, expect, it } from "vitest";

import { isIconName } from "./icons";
import {
  FILE_TYPE_META,
  PINNED_ICON,
  SKIPPED_DIRS,
  fileTypeOf,
  iconNameFor,
  isNoiseDir,
  isSensitive,
  type FileTypeId,
} from "./explorer-types";

/**
 * spec §6.2 的可测部分。这里是纯函数，没有 DOM：
 *   T1  真实文件名的 iconNameFor 返回值
 *   T8  M1：`.env*` 前缀规则
 *   T9  M2：`*.config.ts` 必须排在 `.ts` 之前
 *   T10 PINNED_ICON 的每个 icon 名都在 PATHS 里（防拼错静默画方框）
 *   T11 记忆化
 *   T3  isNoiseDir ⊇ SKIPPED_DIRS
 */

/** T1 —— 真实仓库文件名 → 形状。顺带守住"一个类别一个形、不要撞"。 */
const ICON_CASES: ReadonlyArray<readonly [string, string]> = [
  // 源码
  ["App.tsx", "code"],
  ["main.ts", "code"],
  ["lib.rs", "code"],
  ["types.d.ts", "code"],
  // 标记 / 样式
  ["index.html", "tag"],
  ["Button.vue", "tag"],
  ["base.module.css", "droplet"],
  ["theme.scss", "droplet"],
  // 数据（注意 turbo.json 是 config，见下面"M4 两轴"那条）
  ["data.json", "table"],
  ["data.yaml", "table"],
  ["report.csv", "table"],
  ["turbo.json", "sliders"],
  // 文档
  ["README.md", "book"],
  ["HISTORY.md", "history"],
  ["CHANGELOG.md", "history"],
  ["CONTRIBUTING.md", "doc"],
  ["notes.txt", "doc"],
  // 配置
  ["tsconfig.json", "sliders"],
  ["tailwind.config.ts", "sliders"],
  ["pnpm-workspace.yaml", "sliders"],
  // 脚本
  ["deploy.sh", "terminal"],
  ["Makefile", "terminal"],
  // 测试 / 故事
  ["Button.test.tsx", "flask"],
  ["api.spec.ts", "flask"],
  ["Card.stories.tsx", "code"],
  // 清单 / 锁
  ["package.json", "package"],
  ["composer.json", "package"],
  ["pnpm-lock.yaml", "lock"],
  ["yarn.lock", "lock"],
  // 图片
  ["logo.svg", "image"],
  ["avatar.png", "image"],
  // 密钥
  [".env", "key"],
  ["server.pem", "shield-key"],
  ["id_rsa", "shield-key"],
  // 旗舰覆盖（只改形不改色）
  [".gitignore", "eye-off"],
  ["vite.config.ts", "zap"],
  [".eslintrc.json", "wrench"],
  ["Dockerfile", "layers"],
];

describe("iconNameFor", () => {
  it.each(ICON_CASES)("maps %s to %s", (name, expected) => {
    expect(iconNameFor(fileTypeOf(name), name)).toBe(expected);
  });

  it("falls back to the blank page for unrecognised names", () => {
    expect(fileTypeOf("blob.xyz")).toBeNull();
    expect(iconNameFor(fileTypeOf("blob.xyz"), "blob.xyz")).toBe("file");
    // 无扩展名、不在精确表里的名字同样落回 file
    expect(iconNameFor(fileTypeOf("NOTICE"), "NOTICE")).toBe("file");
  });

  it("keeps shape and colour on separate axes (Dockerfile = neutral + layers)", () => {
    // spec §5-M4：type = config（中性色）+ pinned = layers（形状）。两者并存，不是二选一。
    expect(fileTypeOf("Dockerfile")).toBe("config");
    expect(iconNameFor(fileTypeOf("Dockerfile"), "Dockerfile")).toBe("layers");
    expect(fileTypeOf("docker-compose.yml")).toBe("config");
    expect(iconNameFor(fileTypeOf("docker-compose.yml"), "docker-compose.yml")).toBe("layers");
  });

  it("matches pinned names case-insensitively", () => {
    expect(iconNameFor(fileTypeOf("readme.md"), "readme.md")).toBe("book");
    expect(iconNameFor(fileTypeOf("README.MD"), "README.MD")).toBe("book");
  });

  it("gives package.json and a plain .json different shapes for the same colour", () => {
    // spec §1.1 阻断项：`package` 别名到 `--ftype-data`，所以 package.json 与任何
    // data 类 .json 同色，只能靠剪影分开（改形后 0.240 → 0.521）。
    // 注：turbo.json 在映射表里是 config（中性色 + sliders），不参与这一对；
    // 真正同色的是 `*.json` 这种 data 文件。
    const pkg = iconNameFor(fileTypeOf("package.json"), "package.json");
    const data = iconNameFor(fileTypeOf("data.json"), "data.json");
    expect(pkg).toBe("package");
    expect(data).toBe("table");
    expect(pkg).not.toBe(data);
    // 色由 CSS 从 ftype 派生：package 别名到 --ftype-data
    expect(FILE_TYPE_META.package.token).toBe("--ftype-package");
    expect(FILE_TYPE_META.data.token).toBe("--ftype-data");
  });
});

describe("fileTypeOf", () => {
  it("classifies the twelve buckets", () => {
    const cases: ReadonlyArray<readonly [string, FileTypeId]> = [
      ["a.ts", "code"],
      ["a.html", "markup"],
      ["a.css", "style"],
      ["a.json", "data"],
      ["a.md", "doc"],
      ["a.config.ts", "config"],
      ["a.sh", "script"],
      ["a.test.ts", "test"],
      ["package.json", "package"],
      ["yarn.lock", "lock"],
      ["a.png", "image"],
      [".env", "secret"],
    ];
    for (const [name, expected] of cases) expect(fileTypeOf(name)).toBe(expected);
  });

  it("treats .stories.* as code, not as a test (M3)", () => {
    expect(fileTypeOf("Card.stories.tsx")).toBe("code");
    expect(fileTypeOf("Card.stories.ts")).toBe("code");
  });

  it("classifies .env* by prefix but keeps templates visible (M1/T8)", () => {
    for (const name of [".env.staging", ".env.production.local", ".env.ci", ".env.test"]) {
      expect(fileTypeOf(name)).toBe("secret");
      expect(isSensitive(name)).toBe(true);
    }
    // 形状统一：前缀命中的密钥文件一律走钥匙形。`.env.staging` 与 `.env.local`
    // 同族，若落回类别的盾牌会让人以为它不是密钥（团队裁定：补前缀规则）。
    expect(iconNameFor(fileTypeOf(".env"), ".env")).toBe("key");
    expect(iconNameFor(fileTypeOf(".env.production"), ".env.production")).toBe("key");
    expect(iconNameFor(fileTypeOf(".env.staging"), ".env.staging")).toBe("key");
    expect(iconNameFor(fileTypeOf(".env.production.local"), ".env.production.local")).toBe("key");
    for (const name of [".env.example", ".env.template", ".env.sample"]) {
      expect(fileTypeOf(name)).toBe("config");
      expect(isSensitive(name)).toBe(false);
      expect(iconNameFor(fileTypeOf(name), name)).toBe("sliders");
    }
  });

  it("puts *.config.* ahead of the bare source suffixes (M2/T9)", () => {
    // `endsWith` 是顺序扫描：`.config.ts` 若排在 `.ts` 之后，永远命中不到。
    expect(fileTypeOf("foo.config.ts")).toBe("config");
    expect(fileTypeOf("foo.config.js")).toBe("config");
    expect(fileTypeOf("foo.config.mjs")).toBe("config");
    expect(fileTypeOf("foo.config.cjs")).toBe("config");
    expect(fileTypeOf("tailwind.config.ts")).toBe("config");
    // 对照组：同后缀但不是 config 段的仍然是代码
    expect(fileTypeOf("foo.ts")).toBe("code");
    expect(fileTypeOf("config.ts")).toBe("code");
  });

  it("still recognises multi-segment suffixes longer than config", () => {
    expect(fileTypeOf("base.module.css")).toBe("style");
    expect(fileTypeOf("api.test.mts")).toBe("test");
    expect(fileTypeOf("types.d.ts")).toBe("code");
  });

  it("is case-insensitive", () => {
    expect(fileTypeOf("APP.TSX")).toBe("code");
    expect(fileTypeOf("README.MD")).toBe("doc");
    expect(fileTypeOf("PACKAGE.JSON")).toBe("package");
  });

  it("returns null for names it cannot classify", () => {
    expect(fileTypeOf("blob")).toBeNull();
    expect(fileTypeOf("blob.xyz")).toBeNull();
    expect(fileTypeOf("")).toBeNull();
  });
});

describe("isSensitive", () => {
  it("flags secret names and suffixes", () => {
    for (const name of [".env", ".env.local", ".npmrc", "id_rsa", "credentials.json", "secrets.yml"]) {
      expect(isSensitive(name)).toBe(true);
    }
    for (const name of ["server.pem", "tls.key", "cert.crt", "store.p12", "vault.gpg"]) {
      expect(isSensitive(name)).toBe(true);
    }
  });

  it("does not flag a public key (M6)", () => {
    // 公钥不是密钥。这条是"正确行为"，别当成 bug 修掉。
    expect(isSensitive("id_rsa.pub")).toBe(false);
    expect(fileTypeOf("id_rsa.pub")).toBeNull();
  });

  it("leaves ordinary files alone", () => {
    for (const name of ["package.json", "README.md", "App.tsx", "logo.svg"]) {
      expect(isSensitive(name)).toBe(false);
    }
  });
});

describe("PINNED_ICON / FILE_TYPE_META", () => {
  it("only names icons that exist in PATHS (T10)", () => {
    // 拼错一个键不会报错，只会静默画一个方框 —— 这条用例是唯一的防线。
    for (const [name, icon] of Object.entries(PINNED_ICON)) {
      expect(isIconName(icon), `PINNED_ICON["${name}"] = "${icon}"`).toBe(true);
    }
    for (const [ftype, meta] of Object.entries(FILE_TYPE_META)) {
      expect(isIconName(meta.icon), `FILE_TYPE_META.${ftype}.icon = "${meta.icon}"`).toBe(true);
      expect(meta.token.startsWith("--ftype-")).toBe(true);
    }
  });

  it("does not ship a pinned entry that duplicates its category shape", () => {
    // spec §1.2：package.json / pnpm-lock.yaml / *.test.tsx 的"类别即旗舰"，
    // 写进旗舰表是同形同色的虚数；braces 整条砍掉。
    const redundant = ["package.json", "pnpm-lock.yaml", "yarn.lock", "tsconfig.json", "jsconfig.json"];
    for (const name of redundant) expect(PINNED_ICON[name]).toBeUndefined();
    expect(Object.values(PINNED_ICON)).not.toContain("braces" as never);
  });
});

describe("fileTypeOf memoisation (T11)", () => {
  it("returns the same verdict on repeat calls", () => {
    const first = fileTypeOf("package.json");
    expect(fileTypeOf("package.json")).toBe(first);
    expect(fileTypeOf("package.json")).toBe(first);

    const miss = fileTypeOf("blob.xyz");
    expect(fileTypeOf("blob.xyz")).toBe(miss);
    // null 也必须被缓存住（`Map.get` 的 undefined 与缓存值 null 要区分开）
    expect(miss).toBeNull();
    expect(fileTypeOf("blob.xyz")).toBeNull();
  });

  it("stays correct across a large sweep of distinct names", () => {
    for (let index = 0; index < 5000; index += 1) {
      expect(fileTypeOf(`module-${index}.ts`)).toBe("code");
    }
    // 跨过 4096 上限后缓存会被整体清空，但结果不能变
    expect(fileTypeOf("package.json")).toBe("package");
    expect(fileTypeOf("README.md")).toBe("doc");
  });
});

describe("isNoiseDir", () => {
  it("covers every SKIPPED_DIRS entry (T3 / C4 hard constraint)", () => {
    // isNoiseDir ⊇ SKIPPED_DIRS：视觉层必须包含行为层，否则同一个目录
    // 在 @ 提及里被跳过、在树里却是正常色。
    for (const dir of SKIPPED_DIRS) {
      expect(isNoiseDir(dir), `SKIPPED_DIRS entry "${dir}"`).toBe(true);
    }
    expect(SKIPPED_DIRS.size).toBe(8);
  });

  it("catches dot directories without hard-coding them", () => {
    for (const dir of [".git", ".next", ".turbo", ".venv", ".cache", ".svelte-kit"]) {
      expect(isNoiseDir(dir)).toBe(true);
    }
  });

  it("catches the extra non-dot generated directories", () => {
    for (const dir of ["output", "tmp", "venv"]) expect(isNoiseDir(dir)).toBe(true);
  });

  it("leaves real source directories alone", () => {
    for (const dir of ["src", "apps", "packages", "conversation", "node_modules_backup"]) {
      expect(isNoiseDir(dir)).toBe(false);
    }
  });
});

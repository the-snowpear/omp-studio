# OMP Studio 官网（三版方案）

独立站点，不属于 npm workspaces，不影响 `scripts/check.mjs` 和产品构建。

```bash
cd website
npm install --no-workspaces
npm run live    # 把 apps/renderer 构建到 public/live（方案 B 必需，已被 gitignore）
npm run dev     # http://localhost:5190
npm run build   # 产物在 dist/，可部署到任意静态托管（base 为相对路径）
```

| 路径 | 方案 | 技术要点 |
|---|---|---|
| `/` | 方案入口 | 只用于比稿，定稿后删除 |
| `/a/` | 穿越 | WebGL2 光线步进玻璃 π（`a/glass.ts`），CSS 3D 穿越，170 帧滚动序列 |
| `/b/` | 活窗 | 同源 iframe 嵌入真实 renderer，导览驱动真实 DOM（选择器集中在 `b/tour.ts` 文件头） |
| `/c/` | 解析 | WebGL2 字形解析着色器（`c/resolve.ts`），Bridge 检视器，命令面板 |

- `shared/release.ts`：下载链接、系统识别、安装提示。运行时读 GitHub API，失败时回退内置快照，发版后更新快照。
- `public/media/`：`tools/build_media.py` 由 `omp-studio-promo` 的帧序列生成；`tools/capture-live.mjs` 截当前 renderer 静帧。
- 所有界面素材都是预览模式演示数据，页脚已注明。

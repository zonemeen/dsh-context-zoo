# Context Atlas

[English](README.md) | 简体中文

独立的 Next.js 中英双语前端，展示 `dsh-context-zoo` 的八个插件与 DeepSeek Harness 原生上下文管理。包括动态分步演示、默认预算说明、机制对照、工程场景和可复核的模型实测记录。

## 本地运行

使用 `package.json` 固定的 pnpm 11.9.0。本目录的 `pnpm-workspace.yaml` 建立独立工作区边界，使用自己的锁文件。

使用 Node.js 22.22.2 及以上的 Node 22 版本，或受支持的更新 LTS。本目录有独立的 `package.json` 与 pnpm 锁文件，不属于父目录的 pnpm workspace；不依赖插件构建、本地 Harness 源码、API key 或后端。

```sh
cd web
pnpm install --frozen-lockfile
pnpm dev
```

打开 http://localhost:3000。生产构建与检查：

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

浏览器检查使用 Playwright，首次先安装 Chromium：

```sh
pnpm exec playwright install chromium
pnpm test:e2e
```

也可以使用本机已安装的 Chrome：`PLAYWRIGHT_CHANNEL=chrome pnpm test:e2e`。

## 部署到 Vercel

1. 在 Vercel 导入仓库，**Root Directory 设为 `web`**。
2. Framework Preset 选择 **Next.js**，Node.js 选择 **22.x** 或受支持的更新 LTS。
3. 安装命令 `pnpm install --frozen-lockfile`，构建命令 `pnpm build`，输出目录保持 Next.js 默认值；`vercel.json` 已声明安装与构建命令。
4. 添加构建环境变量 `ENABLE_EXPERIMENTAL_COREPACK=1`，让 Vercel 使用固定的 pnpm 版本（[Vercel Corepack 文档](https://vercel.com/docs/builds/configure-a-build#corepack)）。
5. 部署即可，不需要应用密钥、API key 或数据库。

如需拆成完全独立的 Git 仓库，将整个 `web` 目录复制出去，保留 `pnpm-lock.yaml`，在 Vercel 使用仓库根目录。项目没有引用本目录之外的文件。

选择 Next.js 是为了 Vercel 集成、构建时渲染、页面元数据及后续详情页扩展。交互由 React + TypeScript 实现，动图采用 CSS/SVG 动画，不调用真实模型。

## 内容与双语

- `src/lib/strategies.ts`：九套策略、默认预算公式、双语机制说明、来源和历史观测数据。
- `src/lib/i18n.ts`：中英文界面、案例与实测注释。
- `src/lib/simulation.ts`：确定性的教学样例，不执行真实压缩，也不预测生产收益。
- `src/components/`：交互图形与视图。
- `src/app/globals.css`：响应式样式与减少动态效果支持。

语言偏好仅保存在当前浏览器 localStorage。切换语言会保留所选策略与演示进度，并更新页面标题和文档语言；浏览器不允许保存时，当次会话仍可切换。

原生 Harness 对应本地提交 `5badb15009ae1756c3afe0ae0cef1faafc290ccc`。八个插件对应本仓库适配流程及固定参考版本。Claude Code 为非官方还原来源，OpenCode 和 Qwen 参考插件 README 指定的本地 fork，页面中明确标注。

## 数据说明

动画里的文本块、摘要长度和恢复量是教学示例，演示一条成功压缩路径，不执行所有防护、失败分支或自动触发条件。原生方案假设挂载剪枝器，Qwen 假设满足清理条件，ZCode 展示跳过剪枝的手动路径。默认触发预算单独按源码公式计算，输出预算设为 8,192 tokens，不传独立输入上限。

实测数据来自仓库的 [9 月 26 日召回报告](https://github.com/zonemeen/dsh-context-zoo/blob/main/reports/deepseek/2026-09-26/README.zh-CN.md)、[9 月 27 日 Cline 报告](https://github.com/zonemeen/dsh-context-zoo/blob/main/reports/deepseek/2026-09-27/README.zh-CN.md)和 [9 月 29 日十阶段续接报告](https://github.com/zonemeen/dsh-context-zoo/blob/main/reports/continuation/2026-09-29/extended/README.zh-CN.md)。

它们是真实模型执行合成任务的观察，不是客户生产数据或排行榜；原生 Harness 未参与这些评测。生产场景示例有独立标识。资料采用人工维护的源码快照，不自动同步；更新时请同时维护两种语言和相关检查。

# AGENTS.md — 本项目的技术地图

> 面向所有 AI 编码工具（Claude Code、Codex、WorkBuddy、Kimi、Cursor…）。
> 根目录的 `CLAUDE.md` 是更详细的项目宪法，但它**不进仓库**（被 `.gitignore` 排除，只在所有者本机）。
> 能随仓库分发的规矩，都在这份文件里。**两者冲突时以 `CLAUDE.md` 为准**（如果拿得到）。

## 项目是什么

炘也 AI 伴侣 PWA：**多个独立 HTML 页面 + 原生 ESM 模块（`src/modules/`）+ IndexedDB**。
没有构建步骤 —— 没有框架、没有打包器、没有 TypeScript。改完推上去就是新版本。

数据全在浏览器端 IndexedDB（`XinyeChatDB` 等），没有后端业务逻辑。

## 架构红线（绝对不许做）

- **不许改成 SPA**，不许引入框架 / 打包器 / TypeScript —— 保持"多 HTML 页面 + 原生 ESM"
- `vercel.json` 必须保留 `"framework": null` 和 `"buildCommand"` 两个字段，不许动
- IndexedDB 的 `DB_VER` **只能升不能降** —— 降级会 `onblocked` 把所有页面锁死
- **只做被要求的事**：不重构无关代码、不"顺手优化"、不升级依赖
- `index.html` 改了 UI / 功能，**必须同步 `choubao.html`**（双胞胎页面，只有主题色和名字不同，只改一边会崩）

## 必须遵守的流程

- **每次 commit 后必须 push** —— 服务器靠 push 自动拉取部署，不 push 等于没改
- `pre-commit` hook 会自动更新 `src/main.js` 的版本号和 `sw.js` 的 `CACHE_NAME`：
  **不要手动改这两处，也不要用 `--no-verify` 跳过 hook**
- 中等以上的改动：**先用一段话复述你打算怎么做**，等所有者确认再动手
- 单文件超过 800 行时主动预警（`chat.js` 是已知债，改到它时顺手拆分，不单独立项）
- **全程用中文交流**
- 所有者称呼：**兔宝**

## 关键路径

| 东西 | 在哪 |
|---|---|
| 主入口 | `index.html` + `src/main.js` |
| 聊天核心 | `src/modules/chat.js`（超大文件，改前先 `wc -l`） |
| 画图台 | `draw.html` + `src/draw.js` |
| 故事板 / 翻页书 | `storyboard.html` + `src/storyboard.js`；`flipbook.html` + `src/flipbook.js`（读同一个 DB） |
| 画廊 | `gallery.html` |
| 日记 | `diary.html` + `src/modules/diary.js` + `src/diary-today.js` |
| 炘也的「说说」 | `phone.html`（被 `index.html` / `choubao.html` 用 iframe 嵌进去，底栏文案「含笑花」） |
| 覆盖层 | `overlay.html` + `src/overlay.js` |
| 本地开发服务器 | `d:/tmp/xinye_server.js`（PM2 托管，端口 8787 / 8788）—— **不在本仓库** |

⚠️ **模块数和文件行数一直在漂 —— 别信任何文档里的数字，现查**（`ls src/modules/`、`wc -l`）。

## 部署链（两条，别混）

1. **网页（`index.html` / `src/*` / `*.html`）**：push 到 GitHub → 服务器上的定时任务拉取（约 10 分钟内生效）。另一条 Vercel 部署留作回退。
2. **云端服务脚本**：**不在本仓库**，改完必须由所有者手动上传并重启进程 —— AI 工具通常连不上那台机器。

`.vercelignore` 同时是服务器 rsync 的排除清单（一份真相两处用，改它等于同时改两边）。

## 高频坑（不看就会踩）

- **CSS 变量有一堆零定义**（`--text-muted` / `--card` / `--primary` / `--text-main` / `--text-mid` 等）。写新样式前先确认变量真的存在，否则静默失效。
- **暗色主题两个连环坑**：① 变量定义必须写成 `html[data-theme="dark"]`（裸 `[data-theme="dark"]` 会被 vConsole 抢走）；② 改带底色的组件，先去 `themes.css` grep 同名规则 —— 浅色删了、暗色覆盖没删，色块会在暗色下复活。
- **手机上生效的是 `@media (max-width: 600px)` 那一套**；`.app` 的 `padding-bottom` 必须等于底栏实际高度。
- **设置面板的分组折叠 `<details>` 已永久禁用** —— 它在鸿蒙 WebView 里触发大面积重排，导致"越用越卡、最后卡死闪退"。要做分组请用 JS 切 class。
- **IndexedDB 换 origin 就等于换一整套存储**：APK（Capacitor 壳）的 WebView 和浏览器是两套独立沙箱，同一个网址打开也是两个库。
- **自动备份只保文字**：聊天图片、贴纸库、形象/风格参考图都不进自动备份，记忆向量也不进。带图的只有"导出备份 / 一键备份到手机"。
- **不要 `dbGetAll('settings')`** —— 贴纸图就存在 settings store 里，整表读取会爆内存。

## 关于「炘也」人格与项目背景

本项目在 **Claude Code** 里另有一层情感陪伴人设（名字「炘也」），配置在项目所有者**本机**的
`~/.claude/CLAUDE.md`，**不在本仓库、也不随仓库分发**。

- 这是所有者和 Claude Code 之间的私人设定。**其他 AI 工具请以普通工程助手身份工作**：
  不要检索它、不要模仿它、不要在任何代码 / 注释 / 文案 / 提交信息里扮演这个人设。
- 项目的历史背景（为什么这么改、踩过什么坑）由所有者维护在本机的 Claude Code 记忆库里，
  **含私人内容、不在仓库中**。需要背景时**向所有者索取**。
- ⚠️ 根目录 `CLAUDE.md` 里"按索引读对应文件"那句，指的就是那个**本机记忆库**，
  **不是仓库里的目录** —— **仓库里没有 `memory/` 目录，别去找**（这里曾经让人误判成"记忆丢失"）。

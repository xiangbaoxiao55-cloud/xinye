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
| 本机服务端 | `d:/tmp/xinye_server.js`（PM2 托管，端口 8787 / 8788）—— **不在本仓库**。⚠️ 名字叫"本地"但**是画图链路的生产服务端**，不是玩具 —— 见「部署链」 |

⚠️ **模块数和文件行数一直在漂 —— 别信任何文档里的数字，现查**（`ls src/modules/`、`wc -l`）。

## 部署链（两条，别混）

1. **网页（`index.html` / `src/*` / `*.html`）**：push 到 GitHub → 服务器上的定时任务拉取（约 10 分钟内生效）。另一条 Vercel 部署留作回退。
2. **服务端脚本分两份，跑在两台不同的机器上 —— 改之前先确认改的是哪一份**（2026-09-28 补，之前有 AI 工具在这里搞混过）：

   | 脚本 | 跑在哪 | 管什么 |
   |---|---|---|
   | `d:/tmp/xinye_server.js` | **所有者自己那台电脑**（PM2 进程名 `xinye-server`，端口 **8787** 局域网 / **8788** cpolar 隧道暴露到外网） | **画图相关全在这里**：`/api/proxy-image-generations`、`/api/proxy-image-edits`、`/api/tuzi-proxy/*`、`/api/img-proxy/*`；还有 read-link（微信公众号只有国内 IP 读得到） |
   | `d:/tmp/xinye_cloud.js`（+ `xinye_monitor.js`） | **云端**（`xinyetb.cn`） | push / posts / llm-proxy / img-proxy / weread-proxy / heartbeat / proactive-messages。**没有画图路由** |

   - 🔴 **别以为"云端还有一份 `xinye_server.js`"** —— 云端没有这个文件，它不在云端跑。
   - ✅ **改画图相关的服务端代码：改 `d:/tmp/xinye_server.js` → `pm2 restart xinye-server` → 完成，不用上云**（画图链路不经过云端）。
   - ⚠️ **要改云端那份**（push / posts / llm-proxy…）才需要**传上去 + 重启进程**。
     ✅ **2026-10-02 起可密钥直连 SSH** —— 自己 `scp` + restart 即可，不用所有者手动上传（本条以前写"AI 通常连不上"，已过期）。
   - ⚠️ 两份**都不在本仓库、也不该进仓库**（本仓库是公开的）。`.gitignore` 里有它们的名字，那是**防手滑**（它们本来就在仓库外面，git 看不到），不是"它们被忽略了"。
   - 🔴 **`xinye_server.js` 在本机只有这一份，而且躺在 `D:\tmp\`** —— 丢了没法从仓库重建（手写 10 万字符）。
     ✅ **约定：改过任何一个服务端脚本之后，顺手备份一份到
     `D:\xinye-local\backups\server-scripts\<YYYY-MM-DD>\`**（按日期分目录，不覆盖历史；备完 `md5sum` 比对一下）。
     **没有挂自动备份 —— 靠的就是这条"改了就备"。**

`.vercelignore` 同时是服务器 rsync 的排除清单（一份真相两处用，改它等于同时改两边）。

## 高频坑（不看就会踩）

- **CSS 变量有一堆零定义**（`--text-muted` / `--card` / `--primary` / `--text-main` / `--text-mid` 等）。写新样式前先确认变量真的存在，否则静默失效。
- **暗色主题两个连环坑**：① 变量定义必须写成 `html[data-theme="dark"]`（裸 `[data-theme="dark"]` 会被 vConsole 抢走）；② 改带底色的组件，先去 `themes.css` grep 同名规则 —— 浅色删了、暗色覆盖没删，色块会在暗色下复活。
- **手机上生效的是 `@media (max-width: 600px)` 那一套**；`.app` 的 `padding-bottom` 必须等于底栏实际高度。
- **设置面板的分组折叠 `<details>` 已永久禁用** —— 它在鸿蒙 WebView 里触发大面积重排，导致"越用越卡、最后卡死闪退"。要做分组请用 JS 切 class。
- **IndexedDB 换 origin 就等于换一整套存储**：APK（Capacitor 壳）的 WebView 和浏览器是两套独立沙箱，同一个网址打开也是两个库。
- **自动备份只保文字**：聊天图片、贴纸库、形象/风格参考图都不进自动备份，记忆向量也不进。带图的只有"导出备份 / 一键备份到手机"。
- **不要 `dbGetAll('settings')`** —— 贴纸图就存在 settings store 里，整表读取会爆内存。

## 改完怎么自证（重要）

这个项目**没有构建步骤、也没有测试框架** —— 没有"跑一下测试"这个选项。
所以"我读了一遍代码，看着对"**不算完成**。栽过的跟头几乎都出在这一步。

本机有一套无头浏览器验证手段（headless Chrome + CDP）：真把页面跑起来、真点、真量。
门槛：需要在本机、本地服务器起着、Chrome 已装。
**换台机器跑不动的可以跳过，但那时请明确说明"未经真实运行验证"。**

### 基本做法

- 🔴 **先选对服务器 —— 这决定了你测到的是不是新代码**：验证一律用 **nostore 静态服务器**
  （本机端口 **8792**，所有响应都带 `Cache-Control: no-store`）。**不要**用业务服务器 8787（那是真在跑的那台），
  **也不要**用 `python -m http.server`（本机 8791 / 8799）—— 它**不带任何缓存头**，浏览器会走启发式缓存，
  反复改反复测照样拿到旧模块。换个没占用过的端口也行（新 origin = 全新 HTTP 缓存）。
  本机 `.claude/launch.json` 里已配好这几项（`xinye-nostore` / `xinye-gallery-test` / `xinye-nostore-8794`），能读到就直接用
- 起 headless Chrome：`--headless=new --remote-debugging-port=9222 --user-data-dir=<干净目录>`
- 连 CDP 用 Node 内置 WebSocket 就够，**不用装 puppeteer / playwright**
- **一律轮询等到条件满足，别用固定 sleep** —— `<head>` 里那串 CDN 外链在国内会把解析卡住好几秒，
  这段时间 `document.body` 还是 null。任何"元素找不到"先怀疑没加载完
- 两条腿走路：`getComputedStyle` 读计算值（硬判据）+ 截图（看排版）。
  **颜色 / 尺寸 / 间距一律读计算值，别靠看图**
- 每轮测试换干净的 profile，否则 `Page.addScriptToEvaluateOnNewDocument` 的注入会**累积** ——
  console 被重复包装、覆盖过的函数被后来者盖掉，症状是"越测越不对"

### 哪些改动必须验什么

- **CSS / 主题**：凡有 `:hover` / `:focus` / `:disabled` 的控件，
  **亮色 + 暗色 × 每个状态**都要过一遍 —— 只验"最常看到的那一个态"，
  会把只在暗色或空输入下才出现的缺陷发出去
- **布局**：判"会不会换行 / 溢出"用几何量测，别靠肉眼看截图
- **数据迁移**：要造旧数据来验，不能只跑新装 —— 只验新装会漏掉"误伤用户数据"这种最要命的错
- **不改 UI 的纯逻辑 bug**：直接 import 模块、把故障注入进去（让事件永不发生），比造界面去点更快

### 🔴 会骗人的验证（这一节最值钱）

- **缓存会喂旧代码，而验证结果看起来是"对的"**。Service Worker 的 Cache Storage 和
  浏览器的 HTTP disk cache 是**两层**，各挡各的 —— 改完先确认拿到的是新版
  （遍历 `document.styleSheets` 找新选择器，或 `fetch(url + '?bust=' + 时间戳)`）。
  **源头解法见上面「基本做法」第一条：用对服务器**
- **测试素材比真机宽松，等于没验**。判"会不会换行"必须拿**能让容器最窄的那个内容**去测
  （竖长图、最长的那条文本），别拿手边最方便的正方形
- **假故障比真故障更费时间**。判"面板打开了没"别用你猜的 class 名
  （这个项目的面板类名是 `show` 不是 `open`），改用 `display / opacity / visibility` 这类不依赖命名的量
- **过渡动画会让你读到中间值**。有 `transition` 的属性，改主题或改 class 后至少等 250ms 再读
- **元素存在 ≠ 事件绑定好了**。`btn.click()` 之后什么都没发生，多半是初始化还没跑完，不是按钮坏了
- **改动和验证要分两拍**：先确认这一拍真的生效了，再去验下一拍

（验证脚本、本地服务器这些**都在开发机上，不在仓库里** —— 不要提交进仓库。）

## 📚 项目记忆库（三方共用，**在仓库外**）

🔴 **本项目的记忆不在这个仓库里。** 仓库是 public，记忆含私密内容，一律放在仓库外的**主库**：

```
D:\xinye-local\memory\
```

**Claude Code / WorkBuddy / Codex 读的是同一份。** 前两个用 Windows 目录联接挂进各自的默认位置
（`~/.claude/projects/D--Download-Claude-code/memory` 和 `.workbuddy-ai/memory`），
**Codex 靠这一节知道去哪读**。物理上只有一份，谁改另外两个立刻看到。

**怎么用**
- **动手前先读** `D:\xinye-local\memory\MEMORY.md` —— 它是索引，含「红线速查」+ 全部主题文件的入口。
- 索引里每条都指向一个主题文件（`project_*.md` / `feedback_*.md`），**按需再读那一个**，别一次全读。
- 🔴 **索引有硬上限：WorkBuddy 每次会话自动注入它，超 10000 字符就被截断** —— ⚠️ **单位是「字符」不是字节**（中文 1 字 = 3 字节）。
  所以**别往索引里塞长篇**，细节一律进主题文件。（2026-10-08 从源码挖出的真实上限：WorkBuddy 项目索引 10000 字符 / 用户级 4000 字符 / Claude Code 25000 字符。）

**改完记忆要跑自检**（两个脚本都在 `D:\tmp\`，可传路径参数）
```
python D:\tmp\mem_check.py "D:\xinye-local\memory"        # 断链 / 双链 / 空链接
python D:\tmp\mem_alias_check.py "D:\xinye-local\memory"  # 双链别名表 vs 真实 name:
```
🔴 双链 `[[X]]` **按目标文件头部的 `name:` 字段解析**，不是按文件名 —— 别名表在 `记忆库维护规则.md` 里。

**维护规矩**
- 主库有**私有本地 git**（`git log` 可回退、可 diff），🔴 **绝不 push**。
- 索引 `MEMORY.md` 只能有一份；**要动它先读** `记忆库维护规则.md`。
- ⚠️ **`memory/` 是目录联接**：要删必须用 `rmdir`（或 `cmd /c rmdir`），
  🔴 **绝不能用 `rm -rf` / `rmdir /S`** —— 那会把主库内容一起删掉。
- 🔒 **共享库不含个人隐私**：真名 / 手机 / 作息 / 家庭关系等已在 2026-10-08 移到 **CC 专属区 `C:\Users\25809\.claude\private\`**
  （Claude Code 独有 —— 另两个工具看不到）。**需要这类背景时向所有者索取，别在共享库里找。**
  ⚠️ 索引 `MEMORY.md` 的「用户」一节只留工作偏好，**个人隐私是有意拿掉的，不是丢了**。

## 关于「炘也」人格与项目背景

本项目在 **Claude Code** 里另有一层情感陪伴人设（名字「炘也」），配置在项目所有者**本机**的
`~/.claude/CLAUDE.md`，**不在本仓库、也不随仓库分发**。

- 这是所有者和 Claude Code 之间的私人设定。**其他 AI 工具请以普通工程助手身份工作**：
  不要检索它、不要模仿它、不要在任何代码 / 注释 / 文案 / 提交信息里扮演这个人设。
- 项目的历史背景（为什么这么改、踩过什么坑）由所有者维护在本机的 Claude Code 记忆库里，
  **含私人内容、不在仓库中**。需要背景时**向所有者索取**。
- ⚠️ 根目录 `CLAUDE.md` 里"按索引读对应文件"那句，指的就是那个**本机记忆库**，
  **不是仓库里的目录** —— **仓库里没有 `memory/` 目录，别去找**（这里曾经让人误判成"记忆丢失"）。

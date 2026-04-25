# 炘也 Vite 模块化重构计划

## 当前状态
- `index.html`：10066 行（CSS ~1200行 + HTML ~1050行 + JS ~7800行）
- 全局变量满天飞，所有功能混在一个文件
- 改功能困难，Claude 上下文压力大

## 目标
Vite + ES Module，不换框架（继续原生JS），保持所有功能不变。

---

## 目标文件结构

```
d:\Download\Claude code\
├── index.html              ← 只剩 HTML 骨架 + script/link 标签 (~200行)
├── src/
│   ├── main.js             ← 入口，初始化顺序控制
│   ├── state.js            ← 全局状态中心（所有共享变量）
│   ├── styles/
│   │   ├── variables.css   ← CSS变量、:root
│   │   ├── layout.css      ← 主布局、app结构
│   │   ├── bubbles.css     ← 聊天气泡
│   │   ├── panels.css      ← 设置面板、模态框
│   │   ├── themes.css      ← 暗夜模式、主题
│   │   ├── stickers.css    ← 贴纸系统样式
│   │   ├── friends.css     ← 朋友们 UI
│   │   └── components.css  ← 按钮、输入框、杂项
│   └── modules/
│       ├── db.js           ← IndexedDB 封装（XinyeChatDB）
│       ├── utils.js        ← Toast、复制fallback、通用工具
│       ├── api.js          ← _apiFetch、流式请求、备用预设、站子检测
│       ├── memory.js       ← 记忆档案、RAG分层注入
│       ├── chat.js         ← 消息渲染、发送接收、历史记录
│       ├── tts.js          ← TTS语音播放、音色管理
│       ├── image.js        ← 画图API、图片上传（Vision）
│       ├── friends.js      ← 朋友们功能
│       ├── settings.js     ← 设置面板、API/画图/TTS预设管理
│       ├── backup.js       ← 备份、导出、导入、合并导入
│       ├── stickers.js     ← 贴纸拖拽、旋转、缩放
│       ├── ui.js           ← 暗夜模式、装修模式、背景上传、Tab切换
│       ├── notifications.js ← 主动讲话、定时提醒、后台通知
│       └── diary.js        ← 写日记功能、Tab切换
├── vite.config.js
├── package.json
└── sw.js                   ← Service Worker（更新缓存列表）
```

---

## 依赖关系图

```
utils.js         ← 无依赖，最底层
db.js            ← utils
state.js         ← db（初始化后填充状态）
api.js           ← state, utils
memory.js        ← db, api, state
tts.js           ← api, state, utils
image.js         ← api, state, utils
chat.js          ← db, api, memory, tts, image, state, utils
friends.js       ← db, api, state, utils
settings.js      ← db, api, state, utils
backup.js        ← db, state, utils
stickers.js      ← db, state, utils
notifications.js ← state, utils
ui.js            ← state, utils
diary.js         ← state, utils
main.js          ← 全部（入口，控制初始化顺序）
```

**禁止循环依赖**：上层模块不能被下层引用。

---

## 迁移步骤

### 阶段0：准备工作（当前窗口）
- [x] 写本计划文档
- [x] 在 git 打一个 tag 作为回滚基准：`git tag pre-vite-backup`
- [x] 备份当前 `index.html` 到项目外（桌面），防止 git 出意外时还有最后保险
- [x] 确认 `npm`/`node` 可用（Node v24.12.0 / npm 11.6.0）

### 阶段1：搭建 Vite 骨架
- [x] 在项目根目录直接初始化（不新建子目录，保持部署路径不变）
- [x] 配置 `vite.config.js`（多页入口：index/diary/reading/choubao）
- [x] `npm install`（vite@5.4.21，11 packages）
- [x] `npm run dev` 启动正常（232ms ready）
- [x] `npm run build` 构建成功（index.html → 454KB / 125KB gzip）

**验收标准**：
- `npm run dev` 启动无报错
- 页面正常显示、所有功能可用（此时仍是单文件）
- `npm run build` 能构建成功

**完成后立即**：`git commit -m "阶段1完成：Vite骨架搭建"`

**回滚**：删除 vite 目录，回到原 index.html，无任何风险。

---

### 阶段2：拆分 CSS
从 index.html 的 `<style>` 块（第7-1192行）按注释分区提取。

- [x] 提取 `variables.css`（:root CSS变量）
- [x] 提取 `layout.css`（背景层、主布局、header、聊天区结构、输入区、装修按钮、响应式、iframe-overlay）
- [x] 提取 `bubbles.css`（消息气泡、thinking块、TTS、收藏、typing indicator）
- [x] 提取 `panels.css`（设置面板、Tab、模态框、各类按钮）
- [x] 提取 `themes.css`（暗夜模式、日记弹窗、底部Tab栏、随手记Modal）
- [x] 提取 `stickers.css`（贴纸层 + 贴纸系统面板）
- [x] 提取 `friends.css`（朋友们UI完整）
- [x] 提取 `components.css`（空态、Toast、图片上传、亲嘴/RP按钮、Token日志）
- [x] 提取 `markdown.css`（Markdown渲染样式）
- [x] index.html `<style>` 块删除，改为 9 个 `<link>` 标签

**验收标准**：
- 页面视觉完全无变化
- 深色模式切换正常
- 朋友聊天界面正常

**完成后立即**：`git commit -m "阶段2完成：CSS拆分"`

**回滚**：把 css/ 内容重新粘回 `<style>` 标签即可。

---

### 阶段3：提取独立工具模块（低风险）

#### 3-prep. 内联JS迁移为ES Module（✅ 已完成 2026-04-25）
- [x] 创建 `src/main.js`，合并所有内联script块（7800+行）
- [x] index.html 改为 `<script type="module" src="./src/main.js">`
- [x] 在 main.js 末尾 `Object.assign(window, {...})` 暴露40个inline handler函数
- [x] 修复 Friends IIFE 的 DOMContentLoaded（改为 readyState 判断）
- [x] sw.js 新增 `/src/main.js` 预缓存
- **验收**：`node --input-type=module --check < src/main.js` 语法通过，已push Vercel

#### 3a. `utils.js`（✅ 已完成 2026-04-25）
提取：Toast、复制fallback、通用工具函数
- [x] 找出所有工具函数（`toast`, `fallbackCopy`, `escHtml`, `fmtTime`, `fmtFull`, `nowStr`, `isDarkMode`）
- [x] 创建 `src/modules/utils.js`，加 export
- [x] 在 main.js 中加 `import { ... } from './modules/utils.js'`
- [x] sw.js 加入 `/src/modules/utils.js` 预缓存
- **注意**：`toast` 改为内部 `getElementById('toast')` 懒查询（不依赖 main.js 的 toastEl 变量）

#### 3b. `db.js`（✅ 已完成 2026-04-25）
- [x] 创建 `src/modules/db.js`，export openDB/dbPut/dbGet/dbGetAll等所有IDB函数
- [x] `let db` 用 live binding export，Friends IIFE的 typeof db 检查改为 `db !== null`

#### 3c-extra. `state.js`（✅ 已完成 2026-04-25）
- [x] 创建 `src/modules/state.js`，export const settings（可变对象）
- [x] main.js 4处 `settings = xxx` 改为 `Object.assign(settings, xxx)`
- **注意**：`saveSettings` 仍在 main.js（依赖 ensureMemoryState + scheduleAutoSave）

#### 3c. `tts.js`（✅ 已完成 2026-04-25）
- [x] 创建 `src/modules/tts.js`（TTS引擎：generateTTSBlob/playTTS/downloadTTS等）
- [x] `maybeTTS` 留在 main.js（调 saveSettings）
- [x] `cleanPath` 移入 tts.js（仅TTS使用）

#### 3d. `image.js`（⏭️ 跳过）
- generateImage 深度耦合 addMessage/appendMsgDOM/DOM元素，等 chat.js 提取后一起处理

#### 4a. `api.js`（✅ 已完成 2026-04-25）
- [x] 创建 `src/modules/api.js`（getApiPresets/setApiPresets/getSubApiCfg/mainApiFetch/subApiFetch）
- **注意**：`_apiFetch` 是 sendMessage 内部局部函数，不在此模块

---

### 阶段4：提取核心模块（中等风险）

#### 4a. `api.js`（✅ 已完成 2026-04-25，见上）

#### 4b. `memory.js`（✅ 已完成 2026-04-26）
- [x] 创建 `src/modules/memory.js`（~700行）：stripThinkingTags/getEmbedding/RAG/digest/viewer/CRUD
- [x] state.js 新增：messages[]、saveSettings、initSaveHook、ensureMemoryBank/State、normalizeMemoryEntry、createMemoryId
- [x] utils.js 导出 $；main.js messages赋值全部改为in-place修改
- **注意**：`generateDream` 留在 main.js（调 getMemoryContextBlocks from memory.js）；`describeImagesWithVision/testVisionApi` 留 main.js

#### 4c. `friends.js`（✅ 已完成 2026-04-26）
- [x] 创建 `src/modules/friends.js`（~300行）：Friends IIFE全部提取，getFriendsBackupData移入并export
- [x] main.js 删除 IIFE 和 getFriendsBackupData，改为 import { getFriendsBackupData } from friends.js
- [x] sw.js 加入 `/src/modules/friends.js` 预缓存
- **注意**：isMobile 在 friends.js 内部重新定义（main.js 中的同名常量不导出）

---

### 阶段5：提取核心聊天模块（最高风险，留到最后）

#### 5a. `chat.js`
提取：消息渲染、发送接收、历史记录、滚动加载
- [ ] 创建 `src/modules/chat.js`
- [ ] 测试（重要）：
  - 发消息、接收回复
  - 流式输出（逐字显示）
  - 历史记录加载
  - 编辑消息
  - 消息复制
  - Markdown渲染（含LaTeX、代码块）
  - thinking块折叠
  - 收藏消息

---

### 阶段6：收尾模块

- [ ] `settings.js` — 设置面板、各种预设
- [ ] `backup.js` — 备份/导出/导入
- [ ] `stickers.js` — 贴纸系统
- [ ] `notifications.js` — 主动讲话、定时提醒
- [ ] `ui.js` — 暗夜模式、装修模式、背景上传
- [ ] `diary.js` — 写日记、Tab切换

---

### 阶段7：最终整合

- [ ] `state.js` — 梳理所有共享状态，集中管理
- [ ] `main.js` — 控制初始化顺序（db → settings → api → ... → chat → ui）
- [ ] 更新 `sw.js` 缓存列表（加入所有新 js/css 文件）
- [ ] 全功能回归测试（见下方测试清单）
- [ ] `npm run build` 构建 → 替换 Vercel 部署文件

---

## 全功能回归测试清单

### 核心聊天
- [ ] 发消息、收到流式回复
- [ ] 历史记录加载（滚动到顶部加载更多）
- [ ] 编辑已发消息
- [ ] 删除消息
- [ ] 复制消息内容
- [ ] 收藏消息
- [ ] Markdown渲染（加粗、代码块、表格）
- [ ] LaTeX公式渲染
- [ ] thinking块折叠/展开
- [ ] 长按/右键消息菜单

### 记忆系统
- [ ] 发消息时记忆正确注入
- [ ] 记忆档案编辑保存
- [ ] 重建索引后Core层更新
- [ ] 整理记忆（本地服务器在线/离线两种情况）

### TTS
- [ ] 点击喇叭播放语音
- [ ] TTS缓存命中
- [ ] 切换音色

### 画图
- [ ] 发画图指令生成图片
- [ ] 图片显示正常
- [ ] Vision识图（上传图片后提问）

### 朋友们
- [ ] 朋友列表显示
- [ ] 进入朋友聊天
- [ ] 发消息收到回复
- [ ] 复制气泡内容
- [ ] 🧠整理朋友记忆
- [ ] 键盘弹起header不消失（移动端）

### 设置
- [ ] API配置保存
- [ ] 预设切换
- [ ] 暗夜模式切换
- [ ] 背景图/视频上传

### 数据
- [ ] 一键备份（含好友数据）
- [ ] 导出/导入
- [ ] 清数据（不误清LS/IDB）

### PWA/SW
- [ ] 离线可用
- [ ] 更新后SW刷新缓存

---

## 回滚方案

| 时机 | 回滚方法 |
|------|---------|
| 阶段1前 | `git tag pre-vite-backup`（已打tag，随时`git checkout pre-vite-backup`） |
| 任意阶段出问题 | `git stash` 或 `git checkout -- .` 回到上一个正常提交 |
| 模块拆坏了 | 把该模块内容粘回 index.html 对应位置，删掉 import/export |
| 彻底失败 | `git checkout pre-vite-backup`，原 index.html 永远在 |

**原则：每完成一个阶段立即 git commit，保留每步的回退点。**

---

## 已知问题 & 坑

- **循环依赖风险**：`chat.js` 和 `memory.js` 互相可能有调用，拆时要注意方向
- **全局状态**：`currentMessages`、`db`、`settings` 等变量需要通过 `state.js` 统一管理，不能各自声明
- **初始化顺序**：DB必须在chat之前初始化完成，需要用 async/await 控制
- **SW缓存**：pre-commit hook 会自动更新 CACHE_NAME，但缓存文件列表需要手动加入新的 js/css 路径（阶段2踩坑：CSS文件没加进STATIC_ASSETS，手机SW更新后CSS 404）
- **CSS路径必须用相对路径**：`./src/styles/` 而非 `/src/styles/`，否则 `file://` 直接打开index.html时绝对路径解析到文件系统根目录导致404（阶段2踩坑）
- **vercel.json必须禁用构建**：加了package.json后Vercel自动检测Vite并跑构建，dist/里没有sw.js/manifest.json/lib/等文件导致空白页。`vercel.json`已加 `"framework":null,"buildCommand":""` 固定为静态服务（阶段1踩坑，2026-04-25）
- **阶段3-prep 已解决**：全部内联JS合并为 `src/main.js`（type=module）；module不自动暴露全局函数，已在末尾 `Object.assign(window,{...})` 覆盖40个inline handler；Friends IIFE 的 DOMContentLoaded改为readyState判断；`file://`打开用inline script重定向到localhost:8787（ES module不支持file://协议）
- ~~**saveSettings 阻塞后续模块提取**~~：✅ 已解决（4b完成）——saveSettings/ensureMemoryState等移至 state.js，scheduleAutoSave 通过 initSaveHook 注入回调。
- **华为WebView连接问题**：与本次重构无关，是独立问题。但建议在阶段1完成后顺便测一次——Vite构建后代码结构不同，可能解决也可能引入新问题，早测早知道
- **Vite开发模式 vs 生产构建**：`npm run dev` 能跑不代表 `npm run build` 也能跑。每个阶段完成后都要测一次 build 版本，不只测 dev

---

## 当前进度

```
阶段0 准备工作          ██████████  ✅ 完成
阶段1 Vite骨架          ██████████  ✅ 完成
阶段2 CSS拆分           ██████████  ✅ 完成
阶段3-prep JS→module    ██████████  ✅ 完成（src/main.js，window暴露，SW更新）
阶段3 独立工具模块       ████████░░  进行中（3a utils ✅ 3b db ✅ 3c state+tts ✅，3d image跳过-太耦合）
阶段4 核心模块           ███████░░░  进行中（4a api ✅，4b memory ✅，4c friends ✅，下一步 5a chat）
阶段5 聊天模块           ░░░░░░░░░░  未开始
阶段6 收尾模块           ░░░░░░░░░░  未开始
阶段7 最终整合           ░░░░░░░░░░  未开始
```

---

*每次新窗口开始工作前，先读这个文件确认当前进度，再继续下一步。*

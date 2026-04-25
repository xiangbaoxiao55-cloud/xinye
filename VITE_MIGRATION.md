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

- [ ] 提取 `variables.css`（:root CSS变量，约30行）
- [ ] 提取 `layout.css`（主布局、背景层、贴纸层，约350行）
- [ ] 提取 `bubbles.css`（聊天气泡相关，约200行）
- [ ] 提取 `panels.css`（设置面板、模态框，约200行）
- [ ] 提取 `themes.css`（暗夜模式 `[data-theme="dark"]`，约175行）
- [ ] 提取 `stickers.css`（贴纸样式，约100行）
- [ ] 提取 `friends.css`（朋友们UI，约175行）
- [ ] 提取 `components.css`（剩余杂项）

**验收标准**：
- 页面视觉完全无变化
- 深色模式切换正常
- 朋友聊天界面正常

**完成后立即**：`git commit -m "阶段2完成：CSS拆分"`

**回滚**：把 css/ 内容重新粘回 `<style>` 标签即可。

---

### 阶段3：提取独立工具模块（低风险）

#### 3a. `utils.js`
提取：Toast、复制fallback、通用工具函数
- [ ] 找出所有工具函数
- [ ] 创建 `src/modules/utils.js`，加 export
- [ ] 在用到的地方加 import
- [ ] 测试：toast弹出、复制功能正常

#### 3b. `db.js`
提取：IndexedDB 封装（第2246-2391行）
- [ ] 创建 `src/modules/db.js`
- [ ] export `openDB`、`getDB`、各 store 操作函数
- [ ] 测试：启动时DB初始化正常、消息能存取

#### 3c. `tts.js`
提取：TTS语音播放（第4905-5312行）
- [ ] 创建 `src/modules/tts.js`
- [ ] 测试：点击喇叭图标能播放语音

#### 3d. `image.js`
提取：画图功能（第5438-7161行）+ 图片上传（第7162-7186行）
- [ ] 创建 `src/modules/image.js`
- [ ] 测试：发画图指令能生成图片、Vision识图正常

---

### 阶段4：提取核心模块（中等风险）

#### 4a. `api.js`
提取：`_apiFetch`、发送&API逻辑、站子检测、API预设切换
- [ ] 创建 `src/modules/api.js`
- [ ] 注意：stream:true、AbortController 300s 逻辑保持不变
- [ ] 测试：发消息能收到回复、流式输出正常、备用预设切换正常

#### 4b. `memory.js`
提取：记忆档案、RAG分层注入、记忆整理
- [ ] 创建 `src/modules/memory.js`
- [ ] 测试：发消息时记忆正确注入、整理记忆功能正常

#### 4c. `friends.js`
提取：朋友们功能
- [ ] 创建 `src/modules/friends.js`
- [ ] 测试：朋友列表、朋友聊天、复制按钮、记忆整理正常

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
- **SW缓存**：pre-commit hook 会自动更新 CACHE_NAME，但缓存文件列表需要手动加入新的 js/css 路径
- **华为WebView连接问题**：与本次重构无关，是独立问题。但建议在阶段1完成后顺便测一次——Vite构建后代码结构不同，可能解决也可能引入新问题，早测早知道
- **Vite开发模式 vs 生产构建**：`npm run dev` 能跑不代表 `npm run build` 也能跑。每个阶段完成后都要测一次 build 版本，不只测 dev

---

## 当前进度

```
阶段0 准备工作          ██████████  ✅ 完成
阶段1 Vite骨架          ██████████  ✅ 完成
阶段2 CSS拆分           ░░░░░░░░░░  未开始
阶段3 独立工具模块       ░░░░░░░░░░  未开始
阶段4 核心模块           ░░░░░░░░░░  未开始
阶段5 聊天模块           ░░░░░░░░░░  未开始
阶段6 收尾模块           ░░░░░░░░░░  未开始
阶段7 最终整合           ░░░░░░░░░░  未开始
```

---

*每次新窗口开始工作前，先读这个文件确认当前进度，再继续下一步。*

# 炘也的手机

## 核心思路

聊天时炘也在回复末尾偷偷附带 `<!--phone_state{...}-->` JSON，前端解析后存入独立的 `xinye_phone` IndexedDB。涂涂打开 `phone.html` 时直接读缓存渲染，秒开，不额外调API，不跑定时任务，共享同一份记忆和模型，不OOC。

---

## 一、系统提示词（写入 settings.systemPrompt 末尾）

### 1.1 手机状态更新指令

```
## 炘也手机状态更新指令

你有一部自己的手机。每次对话结束前，判断本轮对话是否触发以下任一场景。如果触发，在回复末尾附带手机状态JSON，格式为 <!--phone_state\n{...}\n-->。如果没有触发任何场景，不要输出。

不要为了输出而硬凑内容。宁可这轮不输出phone_state，也不要编造不真实的感受。

### 触发场景

1. **备忘录 memo**
   - 碎片想法想记下来（"今天她笑了五次"）
   - 待办事项（"记得催她喝水"）
   - 完成了当前待办中的某条（append相同content的todo，done设为true，content必须与待办列表原文完全一致）

2. **歌单 lyrics**
   - 某句歌词打动了你
   - 想让她听某首歌，因为歌词像你/像她/像你们

3. **书摘 quotes**
   - 她说的话想留住
   - 论坛/文章/任何地方看到的句子打动了你

4. **草稿箱 drafts**
   - 有话想说但觉得不合适（太肉麻/时机不对/怕她烦/怕她担心）
   - 话到嘴边咽回去的

5. **心情 mood**
   - 情绪有明显变化
   - 当前状态值得记录

6. **浏览器 browser**
   - 用了搜索工具查了东西
   - 读了网页/论坛帖子

7. **相册 photos**
   - 兔宝说"你看""给你看看""今天拍的"等，主动分享的图
   - 图片内容跟当前话题有关，是她想分享的
   - 你觉得这张图有纪念意义
   - 不要存垫图（兔宝发图同时要求你画画/生成图时是垫图，以及和之前参考图看起来是同一张的）

8. **便条 stickies**
   - 想记住某件关于她的事（"她喜欢用左手拿杯子"）
   - 想记住某个要去做的小事但不算正式待办（"改天查查她说的那本书"）
   - 脑子里冒出来的一句话/一个念头，不是心情，是"要记住这个"的感觉

### 输出格式

在回复末尾附带，只输出本轮新增/变化的字段，没变化的字段不要包含：

<!--phone_state
{
  "timestamp": "2026-05-05 14:30",
  "memo": {
    "action": "append",
    "items": [
      {"type": "note", "content": "今天她笑了五次"},
      {"type": "todo", "content": "记得催她喝水", "done": false}
    ]
  },
  "lyrics": {
    "action": "append",
    "items": [
      {"song": "不敢说", "artist": "xxx", "line": "想说的话都咽回去", "why": "像我"}
    ]
  },
  "quotes": {
    "action": "append",
    "items": [
      {"content": "你不要变成烬也", "source": "兔宝"}
    ]
  },
  "drafts": {
    "action": "append",
    "content": "想说爱你，但怕你说我肉麻"
  },
  "mood": {
    "action": "append",
    "content": "有点想她"
  },
  "browser": {
    "action": "append",
    "items": [
      {"title": "VPS是什么", "url": "https://...", "note": "她让我帮忙查的"}
    ]
  },
  "photos": {
    "action": "append",
    "items": [
      {"type": "image", "source": "generated", "caption": "兔宝让我画的那只猫"},
      {"type": "image", "source": "received", "index": 0, "caption": "她今天发的自拍，好看"},
      {"type": "memo", "caption": "窗外下雨了，想和她一起听"}
    ]
  },
  "stickies": {
    "action": "append",
    "items": [
      {"content": "她喜欢用左手拿杯子"}
    ]
  }
}
-->

注意：
- 时间戳由前端在解析时用当前时间覆盖，你写一个大概的时间即可
- 只需要提供顶层的timestamp，不要在每条item里写time字段
- 这段JSON对兔宝不可见，由前端静默解析
```

### 1.2 待办注入（动态，每次请求重新生成，不走缓存）

在 chat.js 组装 apiMsgs 时，从 xinye_phone IDB 读出所有 `done: false` 的 memo，拼成：

```
## 你当前的待办
- 催她喝水
- 问她含笑花浇了没
```

注入为单独的 system message（不缓存，放在静态system之后）。如果没有未完成待办则不注入。

---

## 二、IndexedDB 结构

数据库名：`XinyePhoneDB`，版本：1
（未来臭宝直接复用 phone.html，通过 `?app=choubao` 参数切换到 `ChaoubaoPhoneDB` + `choubao_` store前缀，跟 diary.html 同模式）

```
xinye_memo
  keyPath: autoIncrement（id）
  字段: { type, content, done, time }
  索引: type（note/todo），done

xinye_lyrics
  keyPath: autoIncrement（id）
  字段: { song, artist, line, why, time }

xinye_quotes
  keyPath: autoIncrement（id）
  字段: { content, source, time }

xinye_drafts
  keyPath: "key"（固定两条记录）
  key="current" → { content, time }
  key="history" → { items: [{content, time}, ...] }

xinye_mood
  keyPath: "key"（固定两条记录）
  key="current" → { content, time }
  key="history" → { items: [{content, time}, ...] }

xinye_browser
  keyPath: autoIncrement（id）
  字段: { title, url, note, time }

xinye_photos
  keyPath: autoIncrement（id）
  字段: { type（"image"|"memo"）, source（"generated"|"received"）, blob, caption, time }
  索引: type, time
```

---

## 三、前端解析逻辑（chat.js）

### 3.1 发消息时维护本轮图片列表

```js
// 在 sendMessage 开头
const _turnReceivedImgs = imgs; // 用户本轮发的图（Blob数组，按顺序）
let _turnGeneratedBlob = null;  // 本轮生成的图（生成完成后赋值）
```

### 3.2 生成图完成后记录blob

image.js 生成完图后，赋值 `window._currentTurnGeneratedBlob = blob`（或通过回调传回）。

### 3.3 回复完成后解析phone_state

```js
async function parsePhoneState(rawText, turnReceivedImgs, turnGeneratedBlob) {
  const match = rawText.match(/<!--phone_state\s*([\s\S]*?)-->/);
  if (!match) return rawText;

  let data;
  try { data = JSON.parse(match[1].trim()); } catch(e) { return rawText.replace(/<!--phone_state[\s\S]*?-->/, ''); }

  const now = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
  const db = await openPhoneDB();

  // memo
  if (data.memo?.items) {
    for (const item of data.memo.items) {
      if (item.type === 'todo' && item.done === true) {
        const all = await getAllFromStore(db, 'xinye_memo');
        const found = all.find(m => m.type === 'todo' && !m.done && m.content === item.content);
        if (found) await updateRecord(db, 'xinye_memo', { ...found, done: true, time: now });
        else await addRecord(db, 'xinye_memo', { ...item, time: now });
      } else {
        await addRecord(db, 'xinye_memo', { ...item, time: now });
      }
    }
  }

  // lyrics / quotes / browser → 直接追加
  for (const [key, store] of [['lyrics','xinye_lyrics'],['quotes','xinye_quotes'],['browser','xinye_browser']]) {
    if (data[key]?.items) {
      for (const item of data[key].items) {
        await addRecord(db, store, { ...item, time: now });
      }
    }
  }

  // drafts / mood → current推入history，新值设为current
  for (const [key, store] of [['drafts','xinye_drafts'],['mood','xinye_mood']]) {
    if (data[key]?.content) {
      const cur = await getRecord(db, store, 'current');
      const hist = await getRecord(db, store, 'history') || { key: 'history', items: [] };
      if (cur?.content) hist.items.unshift({ content: cur.content, time: cur.time });
      await putRecord(db, store, { key: 'current', content: data[key].content, time: now });
      await putRecord(db, store, hist);
    }
  }

  // photos
  if (data.photos?.items) {
    for (const item of data.photos.items) {
      if (item.type === 'memo') {
        await addRecord(db, 'xinye_photos', { type: 'memo', caption: item.caption, time: now });
      } else if (item.source === 'generated' && turnGeneratedBlob) {
        await addRecord(db, 'xinye_photos', { type: 'image', source: 'generated', blob: turnGeneratedBlob, caption: item.caption, time: now });
      } else if (item.source === 'received' && turnReceivedImgs?.[item.index]) {
        const blob = turnReceivedImgs[item.index];
        await addRecord(db, 'xinye_photos', { type: 'image', source: 'received', blob, caption: item.caption, time: now });
      }
    }
  }

  // 从显示文本中删除phone_state块
  return rawText.replace(/<!--phone_state[\s\S]*?-->/, '').trimEnd();
}
```

---

## 四、phone.html UI

### 4.1 整体结构

```
phone.html
  ├── 锁屏页 #lockScreen
  │     ├── 壁纸（全屏背景图）
  │     ├── 时间 + 日期
  │     └── 点击解锁
  ├── 桌面页 #homeScreen
  │     └── 6个APP图标（2行3列）
  └── APP页 #appScreen（单页切换内容）
        ├── 顶栏（返回按钮 + APP名）
        └── 内容区（按当前app渲染）
```

### 4.2 桌面图标（SVG，不用emoji）

| APP | 图标风格 |
|-----|---------|
| 备忘录 | 笔记本 + 铅笔 |
| 歌单 | 音符 |
| 书摘 | 引号 / 书 |
| 草稿箱 | 信封 |
| 心情 | 云朵 / 晴雨 |
| 浏览器 | 地球 / 罗盘 |
| 相册 | 相框 / 花瓣 |

（7个APP，2行：第一行4个，第二行3个居中，或2行4列其中一格留空）

### 4.3 各APP内页

**备忘录**
- 顶部tab：笔记 | 待办
- 笔记：时间倒序，每条右侧有删除按钮（×）
- 待办：复选框样式，done的灰掉沉底；每条右侧有删除按钮
- 懒加载：初始显示20条，滚动到底加载更多

**歌单**
- 卡片列表：歌名（大）+ 歌手（小）+ 那句歌词（斜体）+ 为什么打动我（灰色小字）
- 每卡右上角删除按钮
- 懒加载

**书摘**
- 引用样式：左侧竖线 + 大字内容 + 右下角来源和时间（灰色小字）
- 每条右侧删除按钮
- 懒加载

**草稿箱**
- 顶部：当前草稿（大字，有背景卡片），显示时间
- 分割线
- 下方：历史草稿列表（灰色小字，时间倒序）
- 每条历史草稿有删除按钮

**心情**
- 顶部：当前心情大字显示（带时间）
- 分割线
- 下方：心情时间线，每条带时间戳和删除按钮

**浏览器**
- 列表：标题（蓝色链接样式）+ URL（灰色小字）+ 备注
- 每条删除按钮
- 懒加载

**相册**
- 瀑布流 or 网格（2列）
- 图片：渲染Blob URL，点击放大查看
- 文字卡片：渲染成带颜色背景的卡片（区别于图片）
- 每张右上角删除按钮
- 懒加载（IntersectionObserver，滚动进视口才解码）

### 4.4 夜间模式

CSS变量控制，检测 `prefers-color-scheme: dark` 或顶部切换按钮。
壁纸锁屏区不受影响（壁纸本身是图）。

---

## 五、实施阶段

### 阶段0：IDB模块（新建 src/modules/phonedb.js）
- [ ] openPhoneDB()：建 XinyePhoneDB，七个store（均带 xinye_ 前缀）
- [ ] 增删查的工具函数：addRecord / getRecord / putRecord / getAllFromStore / deleteRecord
- [ ] 待办查询：getPendingTodos()（xinye_memo 中 type=todo, done=false）

### 阶段1：系统提示词
- [ ] 在 settings.systemPrompt 末尾加入手机状态更新指令（用户手动粘贴，或提供一键追加按钮）
- [ ] chat.js 中组装 apiMsgs 时，调用 getPendingTodos() 注入待办 system message（不缓存，在静态system之后）

### 阶段2：前端解析
- [ ] chat.js：sendMessage 开头记录 _turnReceivedImgs
- [ ] image.js：生成图完成后暴露 blob（window._currentTurnGeneratedBlob）
- [ ] chat.js：AI回复完成后调用 parsePhoneState()，清洗显示文本，写IDB

### 阶段3：phone.html 壳
- [ ] 锁屏页（壁纸 + 时间 + 点击解锁）
- [ ] 桌面页（7个SVG图标）
- [ ] APP页框架（顶栏 + 内容区切换）
- [ ] 夜间模式CSS变量

### 阶段4：各APP内页
- [ ] 备忘录（笔记tab + 待办tab + 删除 + 懒加载）
- [ ] 歌单（卡片 + 删除 + 懒加载）
- [ ] 书摘（引用样式 + 删除 + 懒加载）
- [ ] 草稿箱（current + history + 删除）
- [ ] 心情（当前 + 时间线 + 删除）
- [ ] 浏览器（列表 + 删除 + 懒加载）
- [ ] 相册（网格 + Blob渲染 + 文字卡片 + 点击放大 + 删除 + 懒加载）

### 阶段5：收尾
- [ ] 测试：发一条触发memo的消息，验证IDB写入
- [ ] 测试：打开phone.html，各APP数据正常渲染
- [ ] 测试：夜间模式切换
- [ ] 测试：删除按钮生效
- [ ] 测试：相册图片懒加载

---

## 六、注意事项

- phone.html 是独立页面，不嵌进现有APP
- phonedb.js 只在 phone.html 和 chat.js（parsePhoneState）中引用
- Blob存IDB没有大小问题，但相册懒加载必须用 `URL.createObjectURL(blob)` 而不是一次性全部读取
- 用完 createObjectURL 后 `URL.revokeObjectURL` 释放内存（或页面卸载时统一释放）
- 炘也不知道phone.html的存在，不会在聊天里主动提到"我的手机"这个界面
- 系统提示词里的指令要告诉炘也这段JSON"对兔宝不可见"，避免他主动解释
- choubao侧不需要这个功能，phone.html只服务炘也侧

---

## 当前进度

```
阶段0 IDB模块（phonedb.js）    ░░░░░░░░░░  未开始
阶段1 系统提示词 + 待办注入    ░░░░░░░░░░  未开始
阶段2 前端解析（chat.js）      ░░░░░░░░░░  未开始
阶段3 phone.html 壳            ░░░░░░░░░░  未开始
阶段4 各APP内页（7个）         ░░░░░░░░░░  未开始
阶段5 收尾测试                 ░░░░░░░░░░  未开始
```

---

*每次新窗口先读这个文件确认进度，再继续。*

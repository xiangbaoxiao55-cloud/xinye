// ── DrawDB ──────────────────────────────────────────────────
class DrawDB {
  constructor(){this.db=null}
  open(){
    return new Promise((res,rej)=>{
      const r=indexedDB.open('DrawDB',4);
      r.onupgradeneeded=e=>{
        const db=e.target.result;
        if(!db.objectStoreNames.contains('personas')) db.createObjectStore('personas',{keyPath:'id'});
        if(!db.objectStoreNames.contains('tokens')){
          const s=db.createObjectStore('tokens',{keyPath:'id'});
          s.createIndex('cat','category',{unique:false});
        }
        if(!db.objectStoreNames.contains('templates')) db.createObjectStore('templates',{keyPath:'id'});
        if(!db.objectStoreNames.contains('gallery')){
          const s=db.createObjectStore('gallery',{keyPath:'id'});
          s.createIndex('byPersona','personaId',{unique:false});
          s.createIndex('byRating','rating',{unique:false});
          s.createIndex('byDate','createdAt',{unique:false});
        }
        if(!db.objectStoreNames.contains('settings')) db.createObjectStore('settings',{keyPath:'key'});
        if(!db.objectStoreNames.contains('styles')){
          const s=db.createObjectStore('styles',{keyPath:'style_id'});
          s.createIndex('byCategory','类别',{unique:false});
        }
        if(!db.objectStoreNames.contains('tasks')) db.createObjectStore('tasks',{keyPath:'id'});
        if(!db.objectStoreNames.contains('styleRefs')) db.createObjectStore('styleRefs',{keyPath:'id'});
      };
      r.onsuccess=e=>{this.db=e.target.result;res()};
      r.onerror=e=>rej(e.target.error);
    });
  }
  _tx(s,m='readonly'){
    // ⚠️ this.db 为 null = init 里 db.open() 超时/失败了（step() 只 console.error，页面照样能用）。
    //    这种情况下面每行都会是 TypeError: Cannot read properties of null —— 完全看不出病因，
    //    所以这里抛一句人话（2026-09-23：她在 Edge 里「点保存套装没反应」就是这个）。
    if(!this.db) throw new Error('数据库没打开（可能被同站点的其它标签页占着，全部关掉再重开这一页）');
    return this.db.transaction(s,m).objectStore(s)
  }
  _p(r){return new Promise((res,rej)=>{r.onsuccess=e=>res(e.target.result);r.onerror=e=>rej(e.target.error)})}
  all(s){return this._p(this._tx(s).getAll())}
  /**
   * 安全遍历，**跳过（purge 时清掉）读不出来的记录**（2026-09-23）。
   *
   * 背景：Chromium 会把大图**外置**到站点的 `IndexedDB/*.indexeddb.blob/` 目录，那个目录
   * 被清掉之后（她 2026-09-21 清 C 盘动过 Edge 的站点数据），记录还在 leveldb 里、
   * **但整条读不出来** —— `NotReadableError: Data lost due to missing file`。
   * 后果有两层，两层都踩过：
   *   ① `getAll()` **一条坏、全军覆没** → 列表永远空；
   *   ② 光"读的时候跳过"不够 —— `put()` 是**写事务**，Chromium 在写事务里碰到那条
   *      irrecoverable 记录**照样 abort** → 保存依旧失败。**得把那条删掉，库才能自愈。**
   *   ③ 🔴 连 `openCursor()` 都会失败（游标定位也要读记录）—— 所以跳过式游标**根本跑不起来**，
   *      这是 2026-09-23 第二轮修复后她那边依旧报错的原因。
   *
   * 所以顺序是：**先试最快的 getAll() → 失败才退到「只取 key、再逐条读」**。
   * `getAllKeys()` 只碰 key、不碰内容，坏记录拦不住它 —— 这是唯一稳定的入口。
   * ⚠️ ② 里那条 `event.preventDefault()` 不能省：get 失败会 abort 整个事务，
   *    不拦下来的话后面每一条都读不到。也**必须一次性把所有 get 请求发出去**
   *    （事务在没有待处理请求又回到事件循环时会自动提交，逐条 await 会把它拖死）。
   */
  async allSafe(s, purge=false, map=null, skipFast=false){
    const _x = map || (r => r);
    // ① 先试最快的。⚠️ 记录特别大的 store（gallery）必须 skipFast ——
    //    getAll() 会把所有大图一次性读进内存，那正是当初 evict 它的原因。
    if(!skipFast){
      try { return (await this.all(s)).map(_x) } catch(e) { /* 库里有读不出来的 —— 走下面那条稳的 */ }
    }
    const keys = await this._p(this._tx(s).getAllKeys());
    if(!keys.length) return [];
    const store = this._tx(s);
    const rs = await Promise.all(keys.map(k => new Promise(res => {
      const q = store.get(k);
      q.onsuccess = e => res({ k, v: _x(e.target.result) });
      q.onerror   = e => { e.preventDefault(); res({ k, bad: true }); };
    })));
    const out = rs.filter(r => !r.bad).map(r => r.v);
    const bad = rs.filter(r => r.bad).map(r => r.k);
    if(bad.length){
      console.warn(`[DrawDB] ${s} 有 ${bad.length} 条记录读不出来（外置图文件被清）：`, bad);
      if(purge){
        const w = this._tx(s, 'readwrite');
        await Promise.all(bad.map(k => new Promise(res => {
          const q = w.delete(k);
          q.onsuccess = q.onerror = () => res();
        })));
        console.warn(`[DrawDB] ${s} 已清掉这 ${bad.length} 条，库恢复可写`);
      }
    }
    return out;
  }

  /**
   * 图库列表用的元信息（**剥掉 imageData**）。
   * ⚠️ 不能直接 allSafe('gallery')：① gallery 的记录含大图，必须 skipFast 走逐条读；
   *    ② 它原来那套 openCursor 一碰 irrecoverable 记录就整个失败（同 styleRefs 那颗雷），
   *    图库会永远停在「加载中…」（2026-09-23 她在 Edge 里就是这个）。
   */
  galleryMeta(){
    return this.allSafe('gallery', true, ({ imageData, ...meta }) => meta, true);
  }
  get(s,k){return this._p(this._tx(s).get(k))}
  put(s,o){return this._p(this._tx(s,'readwrite').put(o))}
  del(s,k){return this._p(this._tx(s,'readwrite').delete(k))}
  async getSetting(k,def=null){const r=await this.get('settings',k);return r?r.value:def}
  setSetting(k,v){return this.put('settings',{key:k,value:v})}
}

// ── 版本号 ───────────────────────────────────────────────────
// 🔴 这是「当前正在跑的这一份 draw.js 到底是哪一版」的唯一可信来源，显示在底栏角落。
//    别改成去读 sw.js 的 CACHE_NAME 或 caches.keys() —— 那两个说的是「缓存里存了什么」，
//    完全可能比正在执行的代码新，反过来骗人（这正是「推了新版、刷新还是老样子」的根源：
//    主 app 的 SW 在 scope='/' 上注册，draw.html 也被它管，非 NET_FIRST 路径走
//    stale-while-revalidate，硬刷新也绕不过一个正在生效的 SW）。
//    只有代码自己带版本号，才不会撒谎。提交时 pre-commit hook 会把它 bump 成提交时间。
const DRAW_VER='v2026.09.30-0027';

// ── State ────────────────────────────────────────────────────
const db=new DrawDB();
const S={
  personas:[],curPersonaId:null,
  characters:[],selCharIds:[],
  aestheticProfile:'',lastAnalyzedIds:[],allAnalyzedIds:new Set(),
  seenScenes:new Set(),seenNsfwScenes:new Set(),
  selStyles:[],lastTemplateName:'',
  // 2026-09-28：AI 生成 prompt 时被「糅进 base 文本里」的那批风格 id。
  //   buildPrompt 不再重复追加它们的原始 tokens —— 否则等于把 4 套互相打架的风格词
  //   又硬拼到一条已经融合好的 prompt 后面，白糅。
  //   只在内存里，刷新页面就清空（base 文本本来也不持久化，语义一致）。
  mergedStyleIds:[],
  // 2026-09-28：风格融合（搬自上游 handraw-style 的「提示词拼接器 · 风格融合」）。
  //   开启后，勾中的风格按顺序取前 2 个 —— 第 1 个当【角色视觉语言】、第 2 个当【场景视觉语言】，
  //   再拼上情绪 / 留白 / 画幅比例，最后附上他们那段固定的「共存契约」。
  //   🔴 默认 false —— 关着的时候 buildPrompt 走老分支，行为和以前完全一致。
  fusionMode:false,fusionMoods:[],fusionWhitespace:'normal',fusionLang:'zh',
  selRefCharIds:[],customRefB64s:[],
  curDetail:null,masterHistory:[],
  gallerySelecting:false,gallerySelected:new Set(),
  drawing:false,masterBusy:false,aiGenBusy:false,cfg:{},
  drawPresets:[],curDrawId:null,
  masterPresets:[],curMasterId:null,
  styleRefs:[],curStyleRefId:null,
};

let _galItems=[];
let _galShown=30;
let _galObserver=null;
// 铺多少张。有缩略图的库一次可以铺几百（一张几 KB）；还在用原图的老库只能小批量
// （一张几 MB，铺多了解码内存就爆）。她翻看老库的过程会把缩略图逐步补上，于是自动变大。
const _galPageSize=()=>(_galItems[0]&&_galItems[0].thumb)?240:30;
const GAL_PAGE=30;

const STYLE_CAT={
  '材质与表面质感':'M 材质','摄影工艺与影像缺陷':'P 摄影','电影、电视与影像类型':'C 电影',
  '动画、漫画与插画亚种':'A 动画','平面设计、印刷与海报亚种':'G 平面','工艺、地域视觉与历史媒介':'R 工艺',
  '数字、游戏、UI与计算机视觉':'D 数字','建筑、空间与场景气质':'S 空间',
  '时装、亚文化与人物造型':'F 时装','玩具、产品与收藏品呈现':'T 产品'
};
const STYLE_LIB_VER=1;

// ── 「写实」风格（2026-09-28 补）───────────────────────────────
// 🔴 她问「风格里是不是缺少一个"写实"选项？AI 帮我选里没有写实可选」—— 是的，缺。
//    上游 handraw-style 专门有这一张牌（build_tutorial_gallery.py 里的 REALISTIC_ITEM，
//    id:'realistic'，配图 images/realistic.webp）。它的定位很特殊：
//      · 是**名称风格**，不走编号展开（上游 SKILL.md 第 78 行：「若写名称则按用户的来，如：写实」）；
//      · 主要用途是**跟手绘风格配出最大反差**（上游 SKILL.md 开头：「支持融合两套不同手绘风格编号，
//        或融合**手绘风格编号与写实风格**」）。
//    我们库里 620 条全是编号风格（M/P/C/A/G/R/D/S/F/T + 数字），所以「AI 帮我选」怎么筛都筛不到它。
//
// ⚠️ 为什么单独一个种子函数、不走 seedStyles()：
//    seedStyles() 的闸门是 `styles_lib_version >= STYLE_LIB_VER` —— **一次性版本闸门**。
//    她机器上早就种过了（ver 已是 1），往 JSON 里再加数据它**永远不会重跑**。
//    所以这里做成**幂等**的：每次 init 都 put 一遍。
//    （keyPath 是 style_id，重复 put 是覆盖不是新增，不会堆积。）
// ⚠️ `类别` 必须是 STYLE_CAT 的键 —— renderStyles() 只遍历 Object.keys(STYLE_CAT) 分组，
//    键不在表里的条目会**静默不显示**（看着像没加成功）。这里用「摄影工艺与影像缺陷」→ P 摄影组。
const REALISTIC_STYLE={
  style_id:'RT001',
  中文风格名:'写实',
  类别:'摄影工艺与影像缺陷',
  'English prompt tokens':'Realistic photography / Cinematic photorealism',
  参考:'写实摄影 / 真实电影质感摄影',
  '适合主体':'人像、情侣、旅拍、写真、纪实、产品实拍 —— 任何要真实质感的场景',
  '视觉DNA / 关键词':'真实皮肤与毛发质感、自然光、浅景深、胶片颗粒、纪实抓拍感',
  '材质/色彩/光线':'真实材质、自然光或现场光、低饱和或胶片色',
  '建议强度':'与手绘风格融合时当【场景视觉语言】，反差不做中间调和',
  '组合角色':'手绘 / 插画风格当【角色视觉语言】（反差越大越好）',
  容易翻车:'单独使用时画面容易平淡，得靠构图和主题撑',
  补救提示:'加「自然光、浅景深、纪实抓拍」这类词',
  示例短语:'写实摄影，情侣旅拍，自然光',
  isRealistic:true,        // ← _buildFusionPrompt().expand() 靠这个标记走「名称风格」分支
  builtin:true,            // ← 带这个标记的条目 UI 里不给删（见 removeStyle）
  custom:false,
  来源:'handraw-style 的 REALISTIC_ITEM（名称风格）',
  导入于:'2026-09-28'
};

// 幂等写入。用户若自己改了同 id 的条目会被覆盖回来 —— 但 RT001 是 builtin，
// UI 里本来就不给删不给改，所以不存在"覆盖掉她的手改"这回事。
async function seedRealisticStyle(){
  try{ await db.put('styles',REALISTIC_STYLE) }
  catch(e){ console.warn('[styles] 写实风格写入失败:',e.message) }
}

// ── 风格融合（2026-09-28 加）──────────────────────────────────
// 数据源：上游仓库 handraw-style 的 skills/style-fusion-prompter/SKILL.md。
//
// 🔴 下面两段「共存契约」是从他们仓库里**逐字抄**下来的，一个字都不要改、不要精简、
//    不要"顺手润色"。他们在那份 SKILL.md 里用 [!IMPORTANT] 明确写了：
//    这段是让生图模型（GPT Image / Midjourney / Flux…）理解「两套视觉语言解耦共存」
//    的底层契约，每次输出必须一字不差完整复制。
//    以后上游升级时，先 diff 这两段，再决定要不要同步过来。
//
// 结构：`_FUSION_HEAD_*` 是要我们填槽的模板头（【角色视觉语言】【主题】【情绪】…），
//       `_FUSION_CONTRACT_*` 是固定尾段（"画面中必须同时存在两套清晰可辨的视觉语言" 那一段）。
const _FUSION_CONTRACT_ZH=
`画面中必须同时存在两套清晰可辨的视觉语言。
不要把两者平均磨成普通的混合风格插画。
角色部分使用【角色视觉语言】表现，场景部分使用【场景视觉语言】表现。这里的“场景”包括环境空间、地形、建筑、植物、天空、水面、天气、地面、道具以及整体空间氛围。
【角色视觉语言】与【场景视觉语言】都必须忠实保留各自的核心特征，包括但不限于：造型逻辑、比例系统、线条方式、笔触特征、体块组织、几何倾向、材质表达、表面肌理、色彩体系、明暗方式、细节密度、空间处理方式、平面化或立体化程度以及各自独有的媒介感。不要额外强行加入与原风格无关的统一化修饰。
两种视觉语言必须保持明显差异，但共享同一个空间、光源、色温、天气、空气、构图和叙事时刻。
视觉统一应通过遮挡关系、接触关系、投影关系、地面关系、前后空间关系、局部反光、环境综合色和空气透视来完成，而不是把两种视觉语言磨成同一种质感。
角色必须真正存在于场景中，与场景形成自然互动，不能像贴纸一样浮在画面上。角色与场景之间需要有清楚可信的接触、站立、受光、投影、遮挡和空间关系。重点不是“一个角色站在另一个风格的背景前”，而是让角色真正进入并生活在这个场景世界中。
画面必须围绕【主题】形成一个明确的叙事瞬间，优先保证“谁、在哪里、正在做什么”清楚可读。不要为了展示风格而加入大量与主题无关的装饰元素。
如果画面中存在明显动作，如跑、跳、扑、拉、推、攀爬、追逐、搏斗、搬运或其他动态行为，需要保证发力点、重心、支撑关系、接触位置、受力方向、物体运动方向、遮挡和透视合理，动作逻辑优先于单纯夸张效果。
不要生硬拼贴，不要左右分栏，不要上下分区，不要贴纸叠加，不要主体悬浮，不要错误遮挡，不要不同光源互相冲突，不要让角色风格被完全同化成场景风格，也不要让场景风格被完全同化成角色风格。
最终效果应呈现：
- 两种不同视觉语言自然存在于同一个世界中
- 角色风格与场景风格差异清晰
- 空间与光线逻辑统一
- 角色与场景互动自然
- 主题事件明确可读`;

const _FUSION_CONTRACT_EN=
`Two clearly distinguishable visual languages must coexist in the image simultaneously.
Do NOT average or blend the two into a generic hybrid illustration.
The character elements must be rendered strictly in [Character Visual Language], while the scene elements must be rendered strictly in [Scene Visual Language]. Here, "scene" includes environmental space, terrain, architecture, vegetation, sky, water, weather, ground, props, and overall spatial ambiance.
Both [Character Visual Language] and [Scene Visual Language] must faithfully retain their respective core characteristics, including but not limited to: modeling logic, proportional systems, linework methods, brushstroke traits, volume organization, geometric tendencies, material expressions, surface textures, color systems, shading/lighting techniques, detail density, spatial treatment, degree of flatness vs. three-dimensionality, and their distinct tactile media sensations. Do NOT artificially force any uniform stylistic modifications irrelevant to each original style.
The two visual languages must maintain noticeable contrast, yet share the exact same space, light source, color temperature, weather, atmosphere, composition, and narrative moment.
Visual unity must be achieved through occlusions, physical contact, contact shadows, ground contact, fore/background depth, subtle bounce light, environmental ambient color, and aerial perspective, rather than blending the two visual languages into an identical material texture.
The character must truly exist and naturally interact within the scene world, rather than floating like a detached sticker. There must be credible physical contact, grounded posture, lighting, cast shadows, occlusions, and depth relationships between the character and the environment. The focus is NOT "a character simply standing in front of a different-styled background", but rather having the character truly inhabit and live within this environment.
The image must center around [Theme] to form a distinct narrative moment, prioritizing clarity of "who, where, and what they are doing". Do NOT introduce clutter or irrelevant decorative elements merely to exhibit the styles.
If dynamic actions are present (e.g., running, jumping, leaping, pulling, pushing, climbing, chasing, wrestling, carrying, or dynamic movements), ensure the center of gravity, support points, contact points, force vectors, motion trajectory, occlusion, and perspective are physically convincing; dynamic logic takes priority over superficial exaggeration.
Do NOT create awkward collages, do NOT split left-right or top-bottom columns, do NOT layer like stickers, do NOT let subjects float, avoid erroneous occlusions and conflicting light sources, do NOT assimilate the character style into the scene style, and do NOT assimilate the scene style into the character style.
The final result should achieve:
- Two distinct visual languages coexisting harmoniously in the same world
- Clear differentiation between character style and scene style
- Unified spatial, perspective, and lighting logic
- Natural, believable physical interaction between character and scene
- Clear, legible thematic narrative event`;

// 15 种标准情绪（上游固定预设，[中文, English]）。不给自由填 —— 上游明确禁止自造情绪词。
const FUSION_MOODS=[
  ['治愈','Healing'],['童趣','Childlike'],['松弛','Relaxed'],['幽默','Humorous'],['诗意','Poetic'],
  ['浪漫','Romantic'],['活力','Vibrant'],['微丧','Melancholy'],['孤寂','Solitary'],['紧张','Tense'],
  ['庄严','Solemn'],['荒诞','Absurd'],['恐怖','Eerie'],['神秘','Mysterious'],['激烈','Intense'],
];
// 留白三档。[键, 中文名, 中文提示词, 英文提示词]。'normal' 不往 prompt 里加任何东西。
const FUSION_WS=[
  ['normal','正常','',''],
  ['moderate','适中','【大量留白】','[Generous negative space]'],
  ['high','多','【大量留白，场景只显示必要部分，不要显示全】','[Generous negative space, scene shows only essential parts, do not show in full]'],
];
const FUSION_WS_LABEL={normal:'正常',moderate:'适中',high:'多'};

// ── 主体筛选（2026-09-28 加）──────────────────────────────────
// 「适合主体」字段在库里有多达 600+ 种取值（产品/海报/角色/人像/香水/微缩场景…），
// 穷举不现实，所以按**关键词包含匹配**归成 5 个宽类。
// 内置 620 条实测命中：产品 467 / 人物 394 / 平面 332 / 场景 206 / 动物 108
// （一个风格可同时属于多类，所以加起来 > 620，这是有意的 —— 她点「人物」要看到全部能画人的）。
const SUBJECT_GROUPS=[
  ['人物',['人物','人像','角色','群像','IP','英雄','怪物','怪兽','机器人','机甲','人鱼','人偶','玩偶','手办','潮玩','虚拟偶像','模特','演员','学生','科学家','工程师','侦探','牛仔','运动员','音乐人','主持人']],
  ['动物',['动物','宠物','猫','鱼','昆虫','神兽','恐龙','海洋生物','植物','花','树','蘑菇','生物']],
  ['场景',['场景','城市','建筑','自然','风景','室内','房间','街','废墟','太空','海洋','旅行','地图','地点','户外','酒店','餐馆','办公室','酒吧','校园','城堡','遗迹','工地','泳池','仓库','展厅']],
  ['产品',['产品','包装','静物','物件','家具','灯具','汽车','车辆','鞋','香水','美妆','珠宝','首饰','雕塑','玩具','食品','饮料','科技','电子','手机','家电','乐器','文具','厨具','餐具','瓶','杯','服装','服饰','箱包','配饰','配件','礼盒','礼品','周边','医疗','金融']],
  ['平面',['海报','封面','图标','Logo','徽章','字体','卡片','贴纸','广告','视觉','品牌','社媒','菜单','票','邀请函','指南','教程','UI','App','标志','字标','数据','界面','组件','专辑','书']],
];

// ── Utils ─────────────────────────────────────────────────────
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2);
const fmt=ts=>{const d=new Date(ts);return`${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`};
const p2=n=>String(n).padStart(2,'0');
const ts=()=>new Date().toTimeString().slice(0,8);
function toast(msg,type='info',ms=3000){
  console.log(`[toast:${type}] ${msg}`);
  const el=document.getElementById('toast');
  el.textContent=msg;el.className=`show${type==='error'?' toast-error':type==='warn'?' toast-warn':''}`;
  clearTimeout(el._t);el._t=setTimeout(()=>el.className='',ms);
}
const f2b=f=>new Promise((res,rej)=>{const r=new FileReader();r.onload=e=>res(e.target.result);r.onerror=rej;r.readAsDataURL(f)});

// ── 存文件 ────────────────────────────────────────────────────────
// ⚠️ APK 里 `<a download>` 是**哑的**：壳用的是系统 WebView，它不处理 blob: 链接的
// 下载，点了什么都不发生，也不报错（电脑浏览器里一切正常）。
// 所以有原生接口就走原生（MainActivity 的 AndroidDownload.downloadFile），
// 没有就老办法。2026-09-11 补。
function saveBlob(blob,filename){
  // 超大文件（图库全量导出那种）过 JS bridge 会爆内存，宁可提前说清楚，
  // 也比她点半天最后白屏强
  if(window.AndroidDownload&&blob.size>60*1024*1024){
    toast(`文件有 ${(blob.size/1048576).toFixed(0)}MB，手机上导出容易崩，建议用电脑浏览器打开画图台导出`,'warn');
    return;
  }
  if(window.AndroidDownload){
    const r=new FileReader();
    r.onload=e=>{
      try{
        const ok=window.AndroidDownload.downloadFile(filename,blob.type||'application/octet-stream',String(e.target.result).split(',')[1]);
        if(ok){toast('已保存到 Download/'+filename);return;}
      }catch(_e){}
      saveBlobBrowser(blob,filename);
    };
    r.onerror=()=>saveBlobBrowser(blob,filename);
    r.readAsDataURL(blob);
    return;
  }
  saveBlobBrowser(blob,filename);
}
function saveBlobBrowser(blob,filename){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=filename;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),3000);
}

function buildPrompt(){
  const base=(document.getElementById('final-prompt-edit')?.value||'').trim();
  // 2026-09-28：风格融合模式走单独一条分支 —— 输出的是完整成品 prompt，不再是「base + 风格词」。
  //   注意：这条分支**不看** S.mergedStyleIds。融合 prompt 是从风格对象现拼的，
  //   base 只可能被当成【主题】用，所以不存在"重复追加 tokens"的问题。
  if(S.fusionMode) return _buildFusionPrompt();
  // 2026-09-28：AI 生成时已经糅进 base 的那批风格，这里跳过 —— 不再重复追加原始 tokens。
  //   理由见 S.mergedStyleIds 的注释。手动勾的风格（没走过 AI 生成）照旧全部拼上。
  const stylePart=S.selStyles
    .filter(s=>!S.mergedStyleIds.includes(s.style_id))
    .map(s=>s['English prompt tokens']).join(', ');
  // 2026-09-28 调序：原来是 [主体][词条][风格]。
  //    CLIP 系模型（SD1.5/SDXL）只有 77 token 窗口，超出部分**静默丢弃**，
  //    而词条库里的 masterpiece / best quality / 8k 是最通用、最该被丢的，
  //    却排在风格前面 —— 一旦超长，先丢的恰恰是风格。
  //    改成 [主体][风格][词条]：主体最重要放最前，风格次之，通用质量词殿后。
  //    （对 Seedream/Nano Banana/Flux 这类大窗口模型，顺序本来就无所谓。）
  // 2026-09-28 二次：词条库整块删掉（她从来没用过），所以现在只剩 [主体][风格]。
  return [base,stylePart].filter(Boolean).join(', ');
}

// ── 风格融合 prompt 拼装（2026-09-28 加）────────────────────────
// 严格照上游 style-fusion-prompter 的格式来：
//   ① 槽位行：角色视觉语言 / 场景视觉语言 / 主题 / 情绪 / 画幅比例
//   ② 再逐字附上固定的「共存契约」尾段（_FUSION_CONTRACT_*）
// 上游的 {traits} 规则：填编号时按「生图方式」完整展开，不许压缩。
//   我们库里的风格全是编号（HD###），所以一律展开成：
//     `#279 极简手绘。参考作者/风格名称：极简手绘。核心风格特征：<English prompt tokens>。`
//   特征词用 `English prompt tokens` 而不是 `中文特征` —— 前者是给模型看的紧凑视觉词，
//   后者是给她看的中文说明（里面还有"避免统一的可爱微笑"这类**给提示词工程师的建议**，
//   塞进生图 prompt 会被模型当成画面要求，反而添乱）。
// 🔴 2026-09-28 改（她指出后）：融合 prompt **必须带上「画图 Prompt」框里的内容**。
//   改前这里把那个框整个丢了（只当【主题】兜底），但她的习惯恰恰是把画面描述写在那框里、
//   「想画什么」只写一句话 —— 结果那段描述白写了，出图和她的预期对不上。
//   现在跟非融合模式位置一致：**原样放在最前面**，作为画面主体描述。
function _fusionBase(){
  return (document.getElementById('final-prompt-edit')?.value||'').trim();
}
// 【主题】只取「想画什么」。上游对【主题】的要求是"克制、忠实，严禁扩写成长篇剧情动作"，
//   所以那段长描述走上面的 base，不进【主题】。
function _fusionTheme(){
  return (document.getElementById('user-desc')?.value||'').trim();
}
// 融合 prompt 有没有东西可拼：画面描述（画图 Prompt 框）或主题，有一个就行。
function _fusionHasContent(){
  return !!(S.fusionMode && S.selStyles.length>=2 && (_fusionBase()||_fusionTheme()));
}

// 从尺寸下拉框反推画幅比例（1536x2048 → 3:4）。上游模板里【画幅比例】是必填槽位，
// 但画图台已经有「尺寸」这个真参数了，不再多做一个重复的输入框 —— 这里只是把
// 同一个信息翻译成模型看得懂的写法，真正生效的还是 API 的 size 参数。
function _aspectRatioOf(sizeStr){
  const m=/^(\d+)\s*x\s*(\d+)$/i.exec(String(sizeStr||''));
  if(!m) return '';
  let w=parseInt(m[1],10),h=parseInt(m[2],10);
  if(!w||!h) return '';
  const gcd=(a,b)=>{while(b){const t=a%b;a=b;b=t}return a};
  const d=gcd(w,h)||1;
  return `${w/d}:${h/d}`;
}

function _buildFusionPrompt(){
  const zh=S.fusionLang!=='en';
  // 融合只用前 2 个（第 1 个角色、第 2 个场景）。不足 2 个直接返回空 ——
  // 让 doDraw 去报错，而不是拼一条只有半边的 prompt 出去。
  if(S.selStyles.length<2) return '';
  const [charStyle,sceneStyle]=S.selStyles;
  const base=_fusionBase();
  const theme=_fusionTheme();
  if(!base && !theme) return '';

  // 单个风格 → 「生图方式」展开（上游第 4 条：填编号时完整展开，不许压缩）
  const expand=s=>{
    const num=String(s.style_id||'').replace(/^[A-Za-z]+/,'');
    const name=String(s['中文风格名']||'').replace(/^#\d+\s*/,'');
    const ref=s['原作者']||name;
    const traits=s['English prompt tokens']||'';
    // 🔴「写实」是上游特意做成「名称风格」的特例：**不走编号展开，直接写名字**。
    //   上游 SKILL.md 第 78 行原文（槽位行模板）：
    //     「{若写名称则按用户的来，如：写实；若填编号则按生图方式展开：
    //       #{number} {generation_name}。参考作者/风格名称：{reference}。核心风格特征：{traits}。}」
    //   —— 「。参考作者…。核心风格特征：…。」这一串是**编号分支**的，名称分支就是光秃秃一个名字。
    //   还有一条：「严禁擅自添枝加叶，严禁扩写任何具体环境场景、景深光影或镜头描述」。
    //   所以这里只给名字，不加 `#NNN`、不加「参考作者」、不加「核心风格特征」。
    //   ⚠️ 但也不该只写「写实」两个字 —— 他们英文模板（第 108 行）给的例子是
    //      "Realistic photography / Cinematic photorealism"，中文侧对应 REALISTIC_ITEM.ref
    //      的「写实摄影 / 真实电影质感摄影」。用这串既没扩写场景/光影/镜头，又是他们的原话。
    if(s.isRealistic){
      return zh
        ? (s['参考']||'写实摄影 / 真实电影质感摄影')
        : (s['English prompt tokens']||'Realistic photography / Cinematic photorealism');
    }
    return zh
      ? `#${num} ${name}。参考作者/风格名称：${ref}。核心风格特征：${traits}。`
      : `#${num} ${name}. Reference author/style: ${ref}. Core style traits: ${traits}.`;
  };

  const moodNames=S.fusionMoods
    .map(zhName=>{
      const hit=FUSION_MOODS.find(m=>m[0]===zhName);
      if(!hit) return zhName;             // 老数据兜底
      return zh?hit[0]:hit[1];
    });
  const wsRow=FUSION_WS.find(w=>w[0]===S.fusionWhitespace)||FUSION_WS[0];
  const wsText=zh?wsRow[2]:wsRow[3];
  const ratio=_aspectRatioOf(document.getElementById('param-size')?.value);

  const lines=[];
  // ① 画面主体描述（「画图 Prompt」框里的内容）放最前面 —— 跟非融合模式位置一致
  if(base) lines.push(base);
  // ② 融合结构行
  lines.push(zh
    ? `生成一幅“角色视觉语言 × 场景视觉语言”共存的跨媒介融合画面。`
    : `Generate a cross-media fusion artwork where "Character Visual Language × Scene Visual Language" coexist.`);
  lines.push(zh?`- 【角色视觉语言】：${expand(charStyle)}`:`- [Character Visual Language]: ${expand(charStyle)}`);
  lines.push(zh?`- 【场景视觉语言】：${expand(sceneStyle)}`:`- [Scene Visual Language]: ${expand(sceneStyle)}`);
  if(theme) lines.push(zh?`- 【主题】：${theme}`:`- [Theme]: ${theme}`);
  if(moodNames.length) lines.push(zh?`- 【情绪】：${moodNames.join(' / ')}`:`- [Mood]: ${moodNames.join(' / ')}`);
  if(ratio) lines.push(zh?`- 【画幅比例】：${ratio}`:`- [Aspect Ratio]: ${ratio}`);
  if(wsText) lines.push(wsText);

  // ③ 逐字附上固定的「共存契约」尾段
  return lines.join('\n')+'\n\n'+(zh?_FUSION_CONTRACT_ZH:_FUSION_CONTRACT_EN);
}

// 给融合面板显示「现在会拼成什么」的摘要（不是完整 prompt，完整 prompt 在画图 Prompt 框里）。
function _fusionSummary(){
  const base=_fusionBase();
  const theme=_fusionTheme();
  const ratio=_aspectRatioOf(document.getElementById('param-size')?.value);
  const parts=[];
  const [c,s]=S.selStyles;
  parts.push(`① 角色 = ${c?escHtml(c['中文风格名']):'<span style="color:var(--warn)">未选</span>'}`);
  parts.push(`② 场景 = ${s?escHtml(s['中文风格名']):'<span style="color:var(--warn)">未选</span>'}`);
  if(S.selStyles.length>2) parts.push(`<span style="color:var(--warn)">（还有 ${S.selStyles.length-2} 个没用上，融合只用前 2 个）</span>`);
  const line1=parts.join(' &nbsp;·&nbsp; ');
  const line2=[];
  // 主题是可选的（上游里它是"核心灵魂"，但我们已经把画面描述走 base 那条路了，
  // 所以只写一句话主题也行、不写也行）
  line2.push(theme
    ? `主题：${escHtml(theme)}`
    : '主题：<span style="color:var(--sub)">（没写，可去「想画什么」补一句）</span>');
  if(S.fusionMoods.length) line2.push(`情绪：${escHtml(S.fusionMoods.join(' / '))}`);
  line2.push(`留白：${FUSION_WS_LABEL[S.fusionWhitespace]||'正常'}`);
  if(ratio) line2.push(`画幅：${ratio}`);
  const line3=[];
  // 画面描述来自哪、有没有 —— 说清楚，别让她猜"我写的东西到底用上了没"。
  // ⚠️ 三种情况要分开说：有 / 只有主题 / 两边都空。
  //    以前只有「有」和「空」两档，两边都空时还会说"可以只靠上面那句主题出图"——
  //    可那时主题也是空的，等于在骗她。
  if(base){
    line3.push(`<span style="color:var(--sub)">画面描述：「画图 Prompt」框那段（${base.length} 字符）会拼在最前面</span>`);
  }else if(theme){
    line3.push('<span style="color:var(--warn)">画面描述：空 —— 「画图 Prompt」框里还没内容（这次会只靠上面那句主题出图）</span>');
  }else{
    line3.push('<span style="color:var(--warn)">画面描述：空 —— 「画图 Prompt」和「想画什么」都还是空的，先写一个</span>');
  }
  return line1+'<br>'+line2.join(' &nbsp;·&nbsp; ')+(line3.length?'<br>'+line3.join('<br>'):'');
}

// 估算 CLIP token（粗略，只用来判断量级，不是精确值）：
// 英文词 ~1.3、标点各 1、中文字 ~1.5
function _estTokens(text){
  if(!text) return 0;
  const cjk=(text.match(/[\u4e00-\u9fa5]/g)||[]).length;
  const words=(text.match(/[A-Za-z0-9'’-]+/g)||[]).length;
  const punct=(text.match(/[,;:.]/g)||[]).length;
  return Math.round(words*1.3+punct+cjk*1.5);
}

// ── prompt 长度上限：两套完全不同的体系，别混为一谈 ──────────────
// ① CLIP 系（SD1.5 / SDXL / NovelAI…）：77 **token** 窗口，超出部分**静默丢弃** —— 真的会掉词。
// ② gpt-image / DALL·E 系：按**字符**算，gpt-image 32000、dall-e-3 4000、dall-e-2 1000 —— 基本撞不到。
// 所以这里按「当前激活的画图预设」的模型名判类型，只在真会出事的那条线上报警。
// （2026-09-28：原先无条件按 77 token 报警，对 gpt-image 用户是纯吓人，改掉。）
// 注意：不能用 \b 收边 —— 模型名里下划线是「词字符」，`\bsd\b` 匹配不到 `sd_xl_base_1.0`。
// 用 [^a-z0-9] 当边界，下划线、连字符、点、斜杠都算分隔符。
const CLIP_MODEL_RE=/(^|[^a-z0-9])(sd|sdxl|sd15|sd21|sd35|sd3|novelai|nai|pony|stable|dreamshaper|kolors|chilloutmix|majicmix|meinamix|anything)([^a-z0-9]|$)/i;

function _activeDrawModel(){
  const p=S.drawPresets.find(x=>x.id===S.curDrawId)||S.drawPresets[0];
  return (p?.model||'').trim();
}

// 返回 {unit:'token'|'char', limit:Number, label:String}
// limit=0 表示「认不出的模型」—— 只显示计数，不报警
function _promptLimit(model){
  const m=(model||'').toLowerCase();
  if(/dall-e-2/.test(m)) return {unit:'char',limit:1000,label:'DALL·E 2'};
  if(/dall-e-3/.test(m)) return {unit:'char',limit:4000,label:'DALL·E 3'};
  if(/dall-e/.test(m))   return {unit:'char',limit:4000,label:'DALL·E'};
  if(/gpt-image|gpt-4o-image|gpt-4\.1-image|image-1/.test(m)) return {unit:'char',limit:32000,label:'gpt-image'};
  if(CLIP_MODEL_RE.test(m)) return {unit:'token',limit:77,label:'CLIP 系（SD / SDXL）'};
  if(!m) return {unit:'char',limit:0,label:''};
  return {unit:'char',limit:0,label:m};
}

// ── API Config ────────────────────────────────────────────────
// 本地存的预设可能是「半个 JSON」—— 清理工具/站点数据清理中途删过 LocalStorage 就会这样。
// loadCfg 是同步调用，JSON.parse 一抛错会同步打断 init，后面的 bindEvents() 就永远轮不到，
// 表现是整页空白 + 点哪儿都没反应。所以这里一律退回默认值，坏数据只丢它自己。
function _safeArr(raw){
  try{
    const v=JSON.parse(raw||'[]');
    return Array.isArray(v)?v:[];
  }catch(e){
    console.warn('[draw] 本地配置损坏，已退回默认值：',String(raw||'').slice(0,60));
    return [];
  }
}
function loadCfg(){
  S.drawPresets=_safeArr(localStorage.getItem('draw_drawPresets'));
  S.curDrawId=localStorage.getItem('draw_curDrawId')||S.drawPresets[0]?.id||null;
  S.masterPresets=_safeArr(localStorage.getItem('draw_masterPresets'));
  S.curMasterId=localStorage.getItem('draw_curMasterId')||S.masterPresets[0]?.id||null;
  S.localServer=localStorage.getItem('draw_localServer')||'';
  S.masterPersona=localStorage.getItem('draw_masterPersona')||'';
  // 风格融合（2026-09-28）：开关/情绪/留白/语言都记着，下次打开还是她上次的样子。
  // 情绪值要拿 FUSION_MOODS 校验一遍 —— 万一以后预设改了，老数据里的名字会变成
  // 永远选不中的幽灵项（chip 全灰但值还在，prompt 里也会拼出来）。
  S.fusionMode=localStorage.getItem('draw_fusionMode')==='1';
  S.fusionLang=localStorage.getItem('draw_fusionLang')==='en'?'en':'zh';
  S.fusionWhitespace=FUSION_WS.some(w=>w[0]===localStorage.getItem('draw_fusionWs'))
    ?localStorage.getItem('draw_fusionWs'):'normal';
  S.fusionMoods=_safeArr(localStorage.getItem('draw_fusionMoods'))
    .filter(m=>FUSION_MOODS.some(x=>x[0]===m));
  const dp=S.drawPresets.find(p=>p.id===S.curDrawId)||S.drawPresets[0];
  const mp=S.masterPresets.find(p=>p.id===S.curMasterId)||S.masterPresets[0];
  S.cfg={
    imgKey:dp?.key||'',imgUrl:dp?.url||'',imgModel:dp?.model||'dall-e-3',imgFmt:dp?.format||'images',
    masterKey:mp?.key||'',masterUrl:mp?.url||'',masterModel:mp?.model||'claude-opus-4-7',
  };
}
function savePresetsToLS(){
  localStorage.setItem('draw_drawPresets',JSON.stringify(S.drawPresets));
  localStorage.setItem('draw_curDrawId',S.curDrawId||'');
  localStorage.setItem('draw_masterPresets',JSON.stringify(S.masterPresets));
  localStorage.setItem('draw_curMasterId',S.curMasterId||'');
  loadCfg();
}
function saveFusionLS(){
  localStorage.setItem('draw_fusionMode',S.fusionMode?'1':'0');
  localStorage.setItem('draw_fusionLang',S.fusionLang||'zh');
  localStorage.setItem('draw_fusionWs',S.fusionWhitespace||'normal');
  localStorage.setItem('draw_fusionMoods',JSON.stringify(S.fusionMoods||[]));
}

// ── Draw API ──────────────────────────────────────────────────
async function doDraw(){
  // 风格融合的两个前置条件先说清楚 —— 不然 buildPrompt() 只会返回空串，
  // 她看到的是「先在工作台生成或填写Prompt」，完全指不到点上。
  if(S.fusionMode){
    if(S.selStyles.length<2){toast('风格融合要先勾 2 个风格：第 1 个当角色、第 2 个当场景','warn');return}
    // 2026-09-28 改：以前这里只认【主题】（「想画什么」）。
    //   但她的习惯是把画面描述写在「画图 Prompt」框里（或先点「AI 生成 Prompt」让它写进去），
    //   「想画什么」只留一句话 —— 结果那段描述被无视了。现在两个有**任意一个**就放行。
    if(!_fusionHasContent()){toast('风格融合还缺画面内容 —— 「想画什么」或「画图 Prompt」里写一句都行','warn');return}
  }
  const prompt=buildPrompt();
  if(!prompt){toast('先在工作台生成或填写Prompt','warn');return}
  if(!S.drawPresets.length){toast('先在设置里添加画图API预设','warn');return}
  const n=Math.max(1,Math.min(20,parseInt(document.getElementById('param-count').value)||1));
  const size=document.getElementById('param-size').value||'1024x1024';
  const refs=getAllRefs(); // 快照参考图，重roll时复现
  const tplName=S.lastTemplateName;
  const styles=S.selStyles.map(s=>({id:s.style_id,name:s['中文风格名'],tokens:s['English prompt tokens']}));
  const styleRefName=getActiveStyleRef()?.name||null;
  S.lastTemplateName='';
  _runDrawTask(prompt,size,n,refs,null,tplName,styles,styleRefName);
}

// 🔴 2026-09-28 去掉负向 Prompt。
//    它一直是当 `negative_prompt` 字段发出去的（generations 走 JSON、edits 走 FormData），
//    那是 SD / ComfyUI 那套参数 —— **OpenAI 系的 gpt-image / DALL·E 根本没有**。
//    对她的站子只有两种结局：被静默忽略（填了等于没填），或者被透传给 OpenAI 换来一个
//    HTTP 400（画不出来，还看不出原因）。她自己也说从来没分开填过，负向词都写在正向末尾。
//    → 整条链路拆掉：UI（工作台 / 模板弹窗 / 图库详情 / 任务卡重roll）、请求字段、
//      以及 personas.defaultNeg（它唯一的用途就是自动填那个框）。
//    ⚠️ 老的 gallery / tasks 记录里可能还留着 negPrompt 字段，读的时候一律当没有 ——
//      不要把历史记录当成"这里应该有个值"。
async function _runDrawTask(prompt,size,n,refs,insertAfter,tplName,styles,styleRefName){
  const res=document.getElementById('draw-results');
  const taskWrap=document.createElement('div');
  taskWrap.className='draw-task';
  const taskId=uid();
  taskWrap.dataset.taskId=taskId;
  const promptShort=prompt.length>100?prompt.slice(0,100)+'…':prompt;
  const labelText=tplName?`<i class="ic ic-file-text"></i> ${tplName} · ${n}张 · ${size}`:`<i class="ic ic-palette"></i> ${n}张 · ${size}`;
  const styleLabel=styles&&styles.length?`<span class="draw-task-styles">${styles.map(s=>'<i class="ic ic-palette"></i>'+s.name).join(' ')}</span>`:'';
  const styleRefLabel=styleRefName?`<span class="draw-task-styles"><i class="ic ic-image"></i> ${styleRefName}</span>`:'';
  taskWrap.innerHTML=`<div class="draw-task-header">
    <div class="draw-task-top">
      <span class="draw-task-label">${labelText}</span>
      ${styleLabel}${styleRefLabel}
      <span class="draw-task-status">生成中...</span>
      <div class="draw-task-btns">
        <button class="draw-task-stop" title="停止备用切换（当前请求继续完成）"><i class="ic ic-stop"></i> 停止</button>
        <button class="draw-task-reroll" title="用同样的prompt重roll"><i class="ic ic-refresh"></i> 重roll</button>
        <button class="draw-task-copy" title="复制完整prompt"><i class="ic ic-clipboard"></i></button>
        <button class="draw-task-save" title="存为模版"><i class="ic ic-save"></i></button>
        <button class="draw-task-del" title="删除此卡片"><i class="ic ic-x"></i></button>
      </div>
    </div>
    <div class="draw-task-prompt" title="点击展开完整 prompt">${promptShort}</div>
  </div><div class="draw-task-body"><div class="loading-spinner"></div></div>`;

  const promptEl=taskWrap.querySelector('.draw-task-prompt');
  let expanded=false;
  // onclick 在 try 块内用 fullPrompt 重新绑定（含画风前缀），这里先占位
  taskWrap.querySelector('.draw-task-reroll').onclick=()=>{
    // 已有编辑区则关掉（toggle）
    const existingEdit=taskWrap.querySelector('.draw-task-edit');
    if(existingEdit){existingEdit.remove();return;}
    // 构建画风参考选项
    const srOpts=S.styleRefs.map(sr=>`<option value="${sr.id}"${sr.id===styleRefName?'':''}>${sr.name}</option>`).join('');
    // styleRefName 存的是名字，需要反查 id（首次传入是名字用于显示，重roll时需重查）
    const activeId=S.styleRefs.find(r=>r.name===styleRefName)?.id||'';
    const editDiv=document.createElement('div');
    editDiv.className='draw-task-edit';
    editDiv.innerHTML=`
      <div class="dte-row"><label>Prompt</label><textarea class="dte-pos" rows="3">${prompt}</textarea></div>
      <div class="dte-row"><label>画风参考</label><select class="dte-styleref"><option value="">无</option>${srOpts}</select></div>
      <div class="dte-actions">
        <label class="dte-count-label">张数<input class="dte-count" type="number" min="1" max="20" value="${n}"></label>
        <button class="btn-primary btn-sm dte-confirm"><i class="ic ic-refresh"></i> 确认重roll</button>
        <button class="btn-sm btn-outline dte-cancel">取消</button>
      </div>`;
    taskWrap.querySelector('.draw-task-header').after(editDiv);
    // 设置画风参考下拉默认值
    editDiv.querySelector('.dte-styleref').value=activeId;
    editDiv.querySelector('.dte-cancel').onclick=()=>editDiv.remove();
    editDiv.querySelector('.dte-confirm').onclick=()=>{
      const newPrompt=editDiv.querySelector('.dte-pos').value.trim();
      const newN=Math.max(1,Math.min(20,parseInt(editDiv.querySelector('.dte-count').value)||1));
      const newSrId=editDiv.querySelector('.dte-styleref').value;
      // 重新组合refs：原快照里去掉旧画风参考图，换上新选的
      const oldSrImages=(S.styleRefs.find(r=>r.name===styleRefName)?.images)||[];
      const baseRefs=refs.filter(r=>!oldSrImages.includes(r));
      const newSr=S.styleRefs.find(r=>r.id===newSrId);
      const newRefs=newSr?[...baseRefs,...newSr.images]:baseRefs;
      const newSrName=newSr?.name||null;
      editDiv.remove();
      _runDrawTask(newPrompt||prompt,size,newN,newRefs,taskWrap,null,styles,newSrName);
    };
    editDiv.querySelector('.dte-pos').focus();
  };
  taskWrap.querySelector('.draw-task-del').onclick=()=>{taskWrap.remove();db.del('tasks',taskId);_updateClearBtn()};
  taskWrap.querySelector('.draw-task-copy').onclick=()=>navigator.clipboard.writeText(prompt).then(()=>toast('Prompt已复制 ✓'));
  taskWrap.querySelector('.draw-task-save').onclick=async()=>{
    const name=prompt.trim();
    const def=name.slice(0,30).replace(/[^\w一-龥]/g,' ').trim()||'未命名';
    const tname=window.prompt('模版名称：',def);
    if(!tname?.trim()) return;
    const tplStyles=styles?styles.map(s=>({style_id:s.id,'中文风格名':s.name,'English prompt tokens':s.tokens})):[];
    await db.put('templates',{
      id:uid(),name:tname.trim(),personaId:S.curPersonaId||null,
      styles:tplStyles,
      prompt,size,createdAt:Date.now()
    });
    toast(`模版"${tname.trim()}"已保存 ✨`);
  };

  // 插到指定卡片后面（重roll），或顶部（新任务）
  if(insertAfter) insertAfter.insertAdjacentElement('afterend',taskWrap);
  else res.insertBefore(taskWrap,res.firstChild);

  const setStatus=(msg,err)=>{
    const el=taskWrap.querySelector('.draw-task-status');
    if(el){el.textContent=msg;if(err) el.style.color='var(--err)'}
  };

  try{
    const activeStyleRef=getActiveStyleRef();
    const styleRefPrefix=activeStyleRef
      ? (activeStyleRef.description
          ? `Use the last reference image(s) as art style guide. Style: ${activeStyleRef.description}. Do not copy their composition or content. `
          : 'Use the last reference image(s) as art style guide only, do not copy their composition or content. ')
      : '';
    const fullPrompt=styleRefPrefix+prompt;
    // 更新展开后显示完整 prompt（含画风前缀）
    promptEl.onclick=()=>{
      expanded=!expanded;
      promptEl.textContent=expanded?fullPrompt:promptShort;
      promptEl.style.webkitLineClamp=expanded?'unset':'2';
    };
    const cancelled={value:false};
    const stopBtn=taskWrap.querySelector('.draw-task-stop');
    stopBtn.onclick=()=>{cancelled.value=true;stopBtn.textContent='已停止';stopBtn.disabled=true;};
    const jobs=Array.from({length:n},()=>_doSingleDraw(fullPrompt,size,refs,cancelled));
    const body=taskWrap.querySelector('.draw-task-body');
    body.innerHTML='';
    let done=0;
    const results=await Promise.allSettled(jobs.map(async p=>{
      const {img:imgData,presetName}=await p;
      done++;
      setStatus(`${done}/${n} 完成`);
      const wrap=document.createElement('div');
      wrap.className='result-image-wrapper';
      if(presetName){const tag=document.createElement('div');tag.className='result-preset-tag';tag.textContent=presetName;wrap.appendChild(tag);}
      const img=document.createElement('img');
      img.src=imgData;img.className='result-image';img.style.cursor='zoom-in';
      img.onclick=()=>openLightbox(imgData);
      const acts=document.createElement('div');
      acts.className='result-actions';
      const bSave=document.createElement('button');
      bSave.className='btn-primary btn-sm';bSave.textContent='存图库';
      bSave.onclick=()=>{saveToGallery(imgData,prompt,size,styles);bSave.textContent='已存 ✓';bSave.style.pointerEvents='none'};
      const bDl=document.createElement('button');
      bDl.className='btn-outline btn-sm';bDl.textContent='下载';
      bDl.onclick=()=>{dlImg(imgData);bDl.textContent='已下载 ✓';bDl.className='btn-sm btn-primary';bDl.style.pointerEvents='none'};
      acts.append(bSave,bDl);wrap.append(img,acts);
      body.appendChild(wrap);
      dlImg(imgData);bDl.textContent='已下载 ✓';bDl.className='btn-sm btn-primary';bDl.style.pointerEvents='none';
      return imgData;
    }));
    stopBtn.style.display='none';
    const ok=results.filter(r=>r.status==='fulfilled').length;
    const fail=results.filter(r=>r.status==='rejected').length;
    if(ok>0 && fail===0) setStatus(`✓ ${ok}张完成`);
    // ⚠️ 必须和 restoreTaskCards 里那套文案**逐字一致**（刷新前/后看到的不该是两个说法），
    //    而且必须短 —— 原来这里是 `✓ ${ok}张 / ✗ ${fail}张失败`，375px 下会被压成 14 行竖排。
    else if(ok>0) setStatus(`${fail}张失败`,'err');
    else{setStatus('全部失败','err');body.innerHTML=`<div class="error-msg"><i class="ic ic-x-circle"></i> ${escHtml(results[0].reason?.message||'失败')}</div>`}
    if(ok>0) toast(`生成了 ${ok} 张 ✨`);
    const imgs=results.filter(r=>r.status==='fulfilled').map(r=>r.value);
    // 2026-09-28：这里原来是 `if(imgs.length) db.put(...)` —— 一张都没成功时卡片**根本不入库**，
    //   刷新后整张消失，连失败原因和 prompt 都留不下，想重试只能重新输一遍。
    //   改成无论如何都存：失败卡片存 images:[] + error，刷新后仍在列表里、可点「重roll」。
    //   顺带记下 failCount，恢复时「部分失败」能显示成 "1张失败"（文案见 restoreTaskCards）。
    const errMsg=imgs.length?null:(results[0]?.reason?.message||'生成失败');
    db.put('tasks',{id:taskId,prompt,fullPrompt,size,n,tplName,styles,styleRefName,images:imgs,failCount:fail,error:errMsg,createdAt:Date.now()}).then(_updateClearBtn);
  }catch(err){
    taskWrap.querySelector('.draw-task-body').innerHTML=`<div class="error-msg"><i class="ic ic-x-circle"></i> ${escHtml(err.message)}</div>`;
    setStatus('失败','err');
    toast(err.message,'error');
  }
}

async function _doSingleDraw(prompt,size,refs,cancelled){
  const presets=S.drawPresets;
  let startIdx=presets.findIndex(p=>p.id===S.curDrawId);
  if(startIdx<0) startIdx=0;
  let lastErr;
  for(let i=0;i<presets.length;i++){
    const preset=presets[(startIdx+i)%presets.length];
    if(i>0 && cancelled?.value) throw new Error('已停止备用切换');
    if(i>0 && preset.skipFallback) continue;
    try{
      if(i>0) toast(`切备用"${preset.name}"...`,'warn');
      const _refs=refs||getAllRefs();
      let images;
      if(_refs.length) images=await _callEdits(preset,prompt,size,_refs,1);
      else if(preset.format==='nvidia') images=await _callNvidia(preset,prompt,size,1);
      else if(preset.format==='chat') images=await _callChat(preset,prompt,1);
      else images=await _callGenerations(preset,prompt,size,1);
      console.log(`[${ts()}] ✅ "${preset.name}" 出图`);
      return {img:images[0],presetName:preset.name};
    }catch(err){lastErr=err;if(presets.length>1) console.warn(`[${ts()}] 预设"${preset.name}"失败:`,err.message)}
  }
  throw lastErr||new Error('所有预设均失败');
}

async function _callGenerations(preset,prompt,size,n){
  const {key,url,model}=preset;
  if(!key||!url) throw new Error(`预设"${preset.name}"未配置Key或URL`);
  const isAsync=!!preset.asyncMode;
  console.log(`[${ts()}] → generations | ${preset.name} | ${size} | n=${n} | async=${isAsync} | ${url}/images/generations\n         prompt: ${prompt.slice(0,80)}`);
  const body={model:model||'dall-e-3',prompt,n,size,response_format:'b64_json'};
  // 2026-09-28 新增画质档位：预设里选过才带，没选=完全不传，走上游服务端默认。
  //   为什么做成可选而不是写死 high：各上游容忍度不一样 ——
  //   gpt-image 系认 low/medium/high/auto，dall-e-3 只认 standard/hd，
  //   传错值轻则被静默忽略、重则直接 HTTP 400 把这张图废掉。
  //   默认不传，就不会把现有能跑的预设弄挂。
  if(preset.quality) body.quality=preset.quality;
  const _ac=new AbortController();const _at=setTimeout(()=>_ac.abort(),1500000);
  const targetUrl=`${url}/images/generations`;
  const hdrs={'Content-Type':'application/json','Authorization':`Bearer ${key}`};
  if(isAsync) hdrs['X-Async-Mode']='true';
  const opts={method:'POST',headers:hdrs,body:JSON.stringify(body),signal:_ac.signal};
  let r;
  if(isAsync&&S.localServer){
    console.log(`[${ts()}] 异步模式，跳过直连走本地代理`);
    const h={'Content-Type':'application/json','X-Real-Target':targetUrl,'X-Real-Key':key,'X-Async-Mode':'true'};
    r=await fetch(`${S.localServer}/api/llm-proxy`,{method:'POST',headers:h,body:JSON.stringify(body),signal:_ac.signal});
  }else if(S.localServer){
    // 有本地代理就优先走代理（server-to-server，绕过CF连接超时），代理挂了再降级直连
    try{
      const h={...opts.headers,'X-Real-Target':targetUrl,'X-Real-Key':key};
      delete h['Authorization'];
      r=await fetch(`${S.localServer}/api/llm-proxy`,{...opts,headers:h});
    }catch(e){
      console.log(`[${ts()}] generations 代理不可达(${e.message})，降级直连`);
      r=await fetch(targetUrl,opts);
    }
  }else{
    r=await fetch(targetUrl,opts);
  }
  clearTimeout(_at);
  if(isAsync&&r.status===202){
    const d=await r.json();
    const jobId=d.job_id;
    if(!jobId) throw new Error('异步模式未返回job_id');
    console.log(`[${ts()}] 异步任务已提交: ${jobId}，开始轮询…`);
    return await _pollAsyncJob(url,key,jobId);
  }
  if(!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  const d=await r.json();
  if(d.data?.[0]?.b64_json) return d.data.map(i=>`data:image/png;base64,${i.b64_json}`);
  if(d.data?.[0]?.url){
    const results=[];
    for(const i of d.data){
      console.log(`[${ts()}] 图片URL: ${i.url}`);
      const rb=await _fetchWithProxy(i.url);
      results.push(await f2b(new File([await rb.blob()],'img.png')));
    }
    return results;
  }
  throw new Error('generations API返回格式异常');
}

async function _fetchWithProxy(url){
  if(S.localServer){
    // 🔴 2026-09-29：这里以前**没有 catch** —— 别的代理调用点（generations / edits /
    //    模型列表）都是「连不上就降级直连」，只有这里会让 fetch 的 reject 直接冒出去，
    //    一路把整个出图流程打断。
    //    后果：只要「本地服务器地址」填了个连不上的值（比如手机上填 localhost:8787
    //    —— localhost 在手机上指手机自己，而 8787 跑在她电脑上），
    //    一旦上游返回的是【图片 URL】而不是 b64，出图就必失败。
    //    补上 catch 之后，填错最多慢一点，不会再坏。
    try{
      const r=await fetch(`${S.localServer}/api/proxy-fetch?url=${encodeURIComponent(url)}`);
      if(r.ok) return r;
      console.warn(`[${ts()}] proxy-fetch失败(${r.status})，直接获取: ${url}`);
    }catch(e){
      console.log(`[${ts()}] proxy-fetch 不可达(${e.message})，直接获取: ${url}`);
    }
  }
  return fetch(url);
}

async function _pollAsyncJob(baseUrl,key,jobId,maxMs=1200000){
  const pollUrl=`${baseUrl}/images/async-generations/${jobId}`;
  const deadline=Date.now()+maxMs;
  while(Date.now()<deadline){
    await new Promise(r=>setTimeout(r,2000));
    const pr=await fetch(pollUrl,{headers:{'Authorization':`Bearer ${key}`}});
    if(!pr.ok) throw new Error(`轮询失败 HTTP ${pr.status}`);
    const pd=await pr.json();
    const job=pd.data||pd;
    console.log(`[${ts()}] 轮询 ${jobId}: ${job.status}`);
    if(job.status==='done'){
      if(!job.result_urls?.length) throw new Error('任务完成但无图片URL');
      const results=[];
      for(const imgUrl of job.result_urls){
        const rb=await _fetchWithProxy(imgUrl);
        results.push(await f2b(new File([await rb.blob()],'img.png')));
      }
      return results;
    }
    if(job.status==='failed') throw new Error(`生成失败: ${job.error_message||job.error_code||'未知错误'}`);
  }
  throw new Error('异步任务超时（20分钟）');
}

async function _callChat(preset,prompt,n){
  const {key,url,model}=preset;
  if(!key||!url) throw new Error(`预设"${preset.name}"未配置Key或URL`);
  console.log(`[${ts()}] → chat | ${preset.name} | n=${n} | ${url}/chat/completions\n         prompt: ${prompt.slice(0,80)}`);
  const results=[];
  for(let i=0;i<n;i++){
    const _ac=new AbortController();const _at=setTimeout(()=>_ac.abort(),1500000);
    const r=await fetch(`${url}/chat/completions`,{
      method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
      body:JSON.stringify({model:model||'dall-e-3',messages:[{role:'user',content:`请画一张图：${prompt}`}],max_tokens:2048}),
      signal:_ac.signal
    }).finally(()=>clearTimeout(_at));
    if(!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    const d=await r.json();
    const content=d.choices?.[0]?.message?.content||'';
    const m=content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
    if(m) results.push(m[0]);
    else throw new Error('chat格式未能提取图片数据');
  }
  return results;
}

async function _callNvidia(preset,prompt,size,n){
  const {key,url}=preset;
  if(!key||!url) throw new Error(`预设"${preset.name}"未配置Key或URL`);
  const _SF=[768,832,896,960,1024,1088,1152,1216,1280,1344];
  const _SK=[672,688,720,752,800,832,880,944,1024,1104,1184,1248,1328,1392,1456,1504,1568];
  const isKtx=url.includes('kontext');
  const V=isKtx?_SK:_SF;
  const clamp=v=>V.reduce((a,b)=>Math.abs(b-v)<Math.abs(a-v)?b:a);
  const defSize=isKtx?'1024x1568':'1024x1344';
  const [sw,sh]=(size||defSize).split('x').map(Number);
  const w=clamp(sw||1024),h=clamp(sh||(isKtx?1568:1344));
  const isSchnell=url.includes('schnell');
  const steps=isKtx?30:(isSchnell?4:50);
  console.log(`[${ts()}] → nvidia | ${preset.name} | ${w}x${h} | steps=${steps} | ${url}\n         prompt: ${prompt.slice(0,80)}`);
  const results=[];
  for(let i=0;i<n;i++){
    const _ac=new AbortController();const _at=setTimeout(()=>_ac.abort(),300000);
    const r=await fetch(url,{
      method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`,'Accept':'application/json'},
      body:JSON.stringify({prompt,width:w,height:h,steps,cfg_scale:5,seed:0}),
      signal:_ac.signal
    }).finally(()=>clearTimeout(_at));
    if(!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    const d=await r.json();
    const b64=d.artifacts?.[0]?.base64||d.image?.replace(/^data:image\/[^;]+;base64,/,'');
    if(b64) results.push(`data:image/png;base64,${b64}`);
    else throw new Error('NVIDIA API返回格式异常: '+JSON.stringify(d).slice(0,200));
  }
  return results;
}

async function _callEdits(preset,prompt,size,refB64s,n){
  const {key,url,model}=preset;
  if(!key||!url) throw new Error(`预设"${preset.name}"未配置Key或URL`);
  const isAsync=!!preset.asyncMode;
  console.log(`[${ts()}] → edits | ${preset.name} | ${size} | refs=${refB64s.length} | n=${n} | async=${isAsync} | ${url}/images/edits\n         prompt: ${prompt.slice(0,80)}`);
  const fd=new FormData();
  if(preset.singleImage && refB64s.length>1){
    // 多图横向拼成一张（等比缩放到同一高度）
    const imgs=await Promise.all(refB64s.map(b=>new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=b;})));
    const h=512;
    const totalW=imgs.reduce((s,i)=>s+Math.round(i.width*h/i.height),0);
    const cv=document.createElement('canvas');cv.width=totalW;cv.height=h;
    const ctx=cv.getContext('2d');
    let x=0;
    for(const img of imgs){const w=Math.round(img.width*h/img.height);ctx.drawImage(img,x,0,w,h);x+=w;}
    const blob=await new Promise(res=>cv.toBlob(res,'image/png'));
    fd.append('image',blob,'ref.png');
  }else if(preset.singleImage){
    const blob=await fetch(refB64s[0]).then(r=>r.blob());
    fd.append('image',blob,'ref0.png');
  }else{
    for(let i=0;i<refB64s.length;i++){
      const blob=await fetch(refB64s[i]).then(r=>r.blob());
      fd.append('image[]',blob,`ref${i}.png`);
    }
  }
  fd.append('model',model||'dall-e-3');
  fd.append('prompt',prompt);fd.append('n',n);fd.append('size',size);
  if(preset.quality) fd.append('quality',preset.quality);   // 同上：预设里选了才带
  const _ac=new AbortController();const _at=setTimeout(()=>_ac.abort(),1500000);
  const targetUrl=`${url}/images/edits`;
  const hdrs={'Authorization':`Bearer ${key}`};
  if(isAsync) hdrs['X-Async-Mode']='true';
  let r;
  if(isAsync&&S.localServer){
    console.log(`[${ts()}] 异步模式，跳过直连走本地代理`);
    r=await fetch(`${S.localServer}/api/proxy-image-edits`,{method:'POST',headers:{'X-Api-Url':targetUrl,'X-Api-Key':key,'X-Extra-Headers':JSON.stringify({'X-Async-Mode':'true'})},body:fd,signal:_ac.signal});
  }else if(S.localServer){
    // 优先走本地代理（server-to-server，绕过CF连接超时），代理挂了再降级直连
    try{
      r=await fetch(`${S.localServer}/api/proxy-image-edits`,{method:'POST',headers:{'X-Api-Url':targetUrl,'X-Api-Key':key},body:fd,signal:_ac.signal});
    }catch(e){
      console.log(`[${ts()}] edits 代理不可达(${e.message})，降级直连`);
      r=await fetch(targetUrl,{method:'POST',headers:hdrs,body:fd,signal:_ac.signal});
    }
  }else{
    r=await fetch(targetUrl,{method:'POST',headers:hdrs,body:fd,signal:_ac.signal});
  }
  clearTimeout(_at);
  if(isAsync&&r.status===202){
    const d=await r.json();
    const jobId=d.job_id;
    if(!jobId) throw new Error('异步模式未返回job_id');
    console.log(`[${ts()}] 异步任务已提交: ${jobId}，开始轮询…`);
    return await _pollAsyncJob(url,key,jobId);
  }
  if(!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  const d=await r.json();
  if(d.data?.[0]?.b64_json) return d.data.map(i=>`data:image/png;base64,${i.b64_json}`);
  if(d.data?.[0]?.url){
    const results=[];
    for(const i of d.data){
      console.log(`[${ts()}] 图片URL: ${i.url}`);
      const rb=await _fetchWithProxy(i.url);
      results.push(await f2b(new File([await rb.blob()],'img.png')));
    }
    return results;
  }
  throw new Error('edits API返回格式异常');
}

async function saveToGallery(imageData,prompt,size,styles){
  const p=S.personas.find(x=>x.id===S.curPersonaId);
  // 入库前先瘦身。原图一张 1536×2048 有 5 MB，一千张就是 5 GB ——
  // 库大到导不出、备不了份，上一次误删就是这么全灭的。
  // 768 是"喂大师时本来就会压到的尺寸"，存这个级别等于零损失。
  const big=await _makeThumb(imageData,768,0.72)||imageData;
  const thumb=await _makeThumb(imageData,192,0.7)||null;
  await db.put('gallery',{
    id:uid(),personaId:S.curPersonaId||null,personaName:p?.name||null,
    imageData:big,thumb,prompt,params:{size},rating:0,tags:[],
    styles:styles&&styles.length?styles:undefined,
    createdAt:Date.now()
  });
  toast('已存入图库 ✨');
  _refreshPendingCount();
}

function openGalleryImport(){
  document.getElementById('gallery-import-file').value='';
  document.getElementById('gallery-import-prompt').value='';
  document.getElementById('gallery-import-source').value='';
  document.getElementById('modal-gallery-import').style.display='flex';
}
async function confirmGalleryImport(){
  const files=[...document.getElementById('gallery-import-file').files];
  if(!files.length){toast('请选择图片','warn');return}
  const prompt=document.getElementById('gallery-import-prompt').value.trim();
  const source=document.getElementById('gallery-import-source').value.trim();
  for(const file of files){
    const raw=await f2b(file);
    const imageData=await _makeThumb(raw,768,0.72)||raw;
    const thumb=await _makeThumb(raw,192,0.7)||null;
    await db.put('gallery',{
      id:uid(),personaId:null,personaName:source||'外部导入',
      imageData,thumb,prompt,params:{size:'—'},rating:0,tags:[],createdAt:Date.now()
    });
  }
  closeModal('modal-gallery-import');
  toast(files.length>1?`已存入 ${files.length} 张图片 ✨`:'图片已存入图库 ✨');
  _refreshPendingCount();
  if(document.getElementById('tab-gallery').classList.contains('active')) renderGallery();
}

async function _refreshPendingCount(){
  const allItems=await db.galleryMeta();
  const pending=allItems.filter(i=>!S.allAnalyzedIds.has(i.id)).length;
  const el=document.getElementById('gallery-pending-label');
  if(el) el.textContent=pending>0?`${pending} 张待分析`:'';
}

const dlImg=async url=>{
  const filename=`draw_${Date.now()}.png`;
  try{
    const blob=await (await fetch(url)).blob();
    saveBlob(blob,filename);
  }catch(e){
    toast('保存失败：'+e.message,'error');
  }
};

const _shrinkImg=(dataUrl,maxDim=768,quality=0.7)=>new Promise(res=>{
  const img=new Image();img.onload=()=>{
    let{width:w,height:h}=img;
    if(w>maxDim||h>maxDim){const r=Math.min(maxDim/w,maxDim/h);w=Math.round(w*r);h=Math.round(h*r)}
    const c=document.createElement('canvas');c.width=w;c.height=h;
    c.getContext('2d').drawImage(img,0,0,w,h);
    res(c.toDataURL('image/jpeg',quality).replace(/^data:image\/\w+;base64,/,''));
  };img.src=dataUrl;
});

// 缩小版 dataURL（**带前缀**，可以直接当 img.src）。两个用途：
//   列表缩略图 _makeThumb(img,192) —— 一张几 KB，一千张能一次铺开
//   入库大图   _makeThumb(img,768) —— 喂大师时本来就会压到这个尺寸，零损失
// 原图 1536×2048 有几 MB，一千张铺出来光解码就要 1.7 GB，页面必崩。
// 失败返回 null —— 调用方要能接受"没有缩略图"，别让一张坏图卡住整批。
const _makeThumb=(dataUrl,maxDim=192,quality=0.7)=>new Promise(res=>{
  const img=new Image();
  img.onload=()=>{
    try{
      let{width:w,height:h}=img;
      if(w>maxDim||h>maxDim){const r=Math.min(maxDim/w,maxDim/h);w=Math.round(w*r);h=Math.round(h*r)}
      const c=document.createElement('canvas');c.width=w;c.height=h;
      c.getContext('2d').drawImage(img,0,0,w,h);
      res(c.toDataURL('image/jpeg',quality));
    }catch(_e){res(null)}
  };
  img.onerror=()=>res(null);
  img.src=dataUrl;
});

// ── Master API ────────────────────────────────────────────────
async function callMaster(messages){
  if(!S.masterPresets.length) throw new Error('请先在设置里添加大师API预设');
  const presets=S.masterPresets;
  let startIdx=presets.findIndex(p=>p.id===S.curMasterId);
  if(startIdx<0) startIdx=0;
  let lastErr;
  for(let i=0;i<presets.length;i++){
    const preset=presets[(startIdx+i)%presets.length];
    if(i>0 && preset.skipFallback) continue;
    try{
      if(i>0) toast(`大师切换到"${preset.name}"...`,'warn');
      return await _callMasterWithPreset(preset,messages);
    }catch(err){lastErr=err;if(presets.length>1) console.warn(`[${ts()}] 大师预设"${preset.name}"失败:`,err.message)}
  }
  throw lastErr||new Error('所有大师预设均失败');
}

async function _callMasterWithPreset(preset,messages){
  const {key,url,model}=preset;
  if(!key) throw new Error(`预设"${preset.name}"未配置API Key`);
  const base=(url||'https://api.anthropic.com/v1').replace(/\/$/,'');
  const isAnthropic=base.includes('anthropic.com');
  const _fetch=async(targetUrl,opts)=>{
    try{return await fetch(targetUrl,opts)}catch(e){
      if(!S.localServer) throw e;
      console.log(`[master] 直连失败(${e.message})，走本地代理重试`);
      const h={...opts.headers,'X-Real-Target':targetUrl,'X-Real-Key':key};
      delete h['Authorization'];delete h['x-api-key'];
      return fetch(`${S.localServer}/api/llm-proxy`,{...opts,headers:h});
    }
  };
  if(isAnthropic){
    const sys=messages.find(m=>m.role==='system');
    const msgs=messages.filter(m=>m.role!=='system');
    const r=await _fetch(`${base}/messages`,{
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model:model||'claude-opus-4-7',system:sys?.content||'',messages:msgs,max_tokens:4096})
    });
    if(!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    const d=await r.json();return d.content?.[0]?.text||'';
  }
  const toOAI=content=>{
    if(!Array.isArray(content)) return content;
    return content.map(b=>b.type==='image'&&b.source?.type==='base64'
      ?{type:'image_url',image_url:{url:`data:${b.source.media_type};base64,${b.source.data}`}}
      :b);
  };
  const oaiMsgs=messages.map(m=>({...m,content:toOAI(m.content)}));
  const r=await _fetch(`${base}/chat/completions`,{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
    body:JSON.stringify({model:model||'claude-opus-4-7',messages:oaiMsgs,stream:false})
  });
  if(!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  const d=await r.json();return d.choices?.[0]?.message?.content||'';
}

// ── Character Presets ────────────────────────────────────────
async function loadCharacters(){
  S.characters=await db.getSetting('characters',[]);
  renderCharacterChips();
  renderRefArea();
}
async function saveCharacters(){
  await db.setSetting('characters',S.characters);
  renderCharacterChips();
  renderRefArea();
}
function getAllRefs(){
  const refs=[];
  for(const id of S.selRefCharIds){
    const ch=S.characters.find(c=>c.id===id);
    if(ch?.refImage) refs.push(ch.refImage);
  }
  refs.push(...S.customRefB64s);
  // 画风参考图追加到末尾
  if(S.curStyleRefId){
    const sr=S.styleRefs.find(r=>r.id===S.curStyleRefId);
    if(sr?.images?.length) refs.push(...sr.images);
  }
  return refs;
}

// ── Style Refs CRUD ───────────────────────────────────────────
// ⚠️ 这里用 allSafe(...,true) 而不是 all：库里只要有一条 irrecoverable 的记录，
//    getAll() 整条路失败（列表永远空），**连 put 都会被它带崩**（保存必失败）。
//    而且必须 purge —— 脏记录不删掉，库就一直写不进去。见 DrawDB.allSafe 的注释。
async function loadStyleRefs(){
  S.styleRefs=await db.allSafe('styleRefs',true);
}
async function saveStyleRef(name,images,description=''){
  const item={id:uid(),name,images,description,createdAt:Date.now()};
  await db.put('styleRefs',item);
  S.styleRefs=await db.allSafe('styleRefs',true);
  return item;
}
async function deleteStyleRef(id){
  await db.del('styleRefs',id);
  S.styleRefs=await db.allSafe('styleRefs',true);
  if(S.curStyleRefId===id) S.curStyleRefId=null;
}

function getActiveStyleRef(){
  return S.styleRefs.find(r=>r.id===S.curStyleRefId)||null;
}

let _pendingStyleRefB64s=[];

function renderStyleRefStrip(){
  const active=getActiveStyleRef();
  const nameEl=document.getElementById('style-ref-active-name');
  const clearBtn=document.getElementById('btn-style-ref-clear');
  const strip=document.getElementById('style-ref-strip');
  if(!nameEl||!strip) return;
  if(active){
    nameEl.textContent='当前：'+active.name;
    clearBtn.style.display='';
    strip.innerHTML='';
    active.images.forEach(b64=>{
      const img=document.createElement('img');
      img.src=b64;img.style.cssText='width:48px;height:48px;object-fit:cover;border-radius:4px;border:1px solid var(--border)';
      strip.appendChild(img);
    });
  } else {
    nameEl.textContent='未选择';
    clearBtn.style.display='none';
    strip.innerHTML='';
    // 显示已保存套装列表供快速选择
    S.styleRefs.forEach(sr=>{
      const btn=document.createElement('button');
      btn.className='btn-tiny';
      btn.textContent='';
      if(sr.images.length){const _i=document.createElement('i');_i.className='ic ic-image';btn.append(_i,' ');}
      btn.append(sr.name);
      btn.title='点击使用此画风参考';
      btn.onclick=()=>{S.curStyleRefId=sr.id;renderStyleRefStrip()};
      strip.appendChild(btn);
    });
    if(!S.styleRefs.length){
      const hint=document.createElement('span');
      hint.style.cssText='font-size:11px;color:var(--sub)';
      hint.textContent='点「管理」上传画风参考图';
      strip.appendChild(hint);
    }
  }
}

function renderNewStyleRefPreview(){
  const preview=document.getElementById('new-style-ref-preview');
  if(!preview) return;
  preview.innerHTML='';
  (_pendingStyleRefB64s||[]).forEach((b64,i)=>{
    const wrap=document.createElement('div');
    wrap.style.cssText='position:relative;display:inline-block';
    const img=document.createElement('img');
    img.src=b64;img.style.cssText='width:60px;height:60px;object-fit:cover;border-radius:4px;border:1px solid var(--border)';
    const del=document.createElement('button');
    del.innerHTML='<i class="ic ic-x"></i>';del.className='custom-ref-del';
    del.onclick=()=>{_pendingStyleRefB64s.splice(i,1);renderNewStyleRefPreview()};
    wrap.append(img,del);preview.appendChild(wrap);
  });
}

async function confirmSaveStyleRef(){
  const name=(document.getElementById('new-style-ref-name').value||'').trim();
  const desc=(document.getElementById('new-style-ref-desc').value||'').trim();
  if(!name){toast('请填写套装名称','warn');return}
  if(!_pendingStyleRefB64s||!_pendingStyleRefB64s.length){toast('请选择至少1张参考图','warn');return}
  // 写库这一步以前没有 catch —— 库一旦不可用（DrawDB 没打开、被别的标签页占着），
  // onclick 是个 async 函数、抛了没人接，**表现就是"按钮点了没反应"**，查都没法查。
  let item;
  try{
    item=await saveStyleRef(name,[..._pendingStyleRefB64s],desc);
  }catch(e){
    console.error('[画风参考] 保存失败：',e);
    toast(`❌ 保存失败：${e?.message||e}`,'warn');
    return;
  }
  _pendingStyleRefB64s=[];
  document.getElementById('new-style-ref-name').value='';
  document.getElementById('new-style-ref-desc').value='';
  document.getElementById('new-style-ref-preview').innerHTML='';
  document.getElementById('new-style-ref-input').value='';
  toast(`画风参考"${name}"已保存 ✨`);
  S.curStyleRefId=item.id;
  renderStyleRefStrip();
  renderStyleRefList();
}

function openStyleRefModal(){
  _pendingStyleRefB64s=[];
  document.getElementById('new-style-ref-name').value='';
  document.getElementById('new-style-ref-desc').value='';
  document.getElementById('new-style-ref-preview').innerHTML='';
  document.getElementById('new-style-ref-input').value='';
  renderStyleRefList();
  document.getElementById('modal-style-ref').style.display='flex';
}

function renderStyleRefList(){
  const list=document.getElementById('style-ref-list');
  if(!list) return;
  list.innerHTML='';
  if(!S.styleRefs.length){
    list.innerHTML='<div style="color:var(--sub);font-size:12px;padding:4px 0">还没有画风参考套装</div>';
    return;
  }
  S.styleRefs.forEach(sr=>{
    const el=document.createElement('div');
    el.style.cssText='display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)';
    const thumbs=document.createElement('div');
    thumbs.style.cssText='display:flex;gap:3px';
    sr.images.slice(0,3).forEach(b64=>{
      const img=document.createElement('img');
      img.src=b64;img.style.cssText='width:36px;height:36px;object-fit:cover;border-radius:3px;cursor:pointer';
      img.title='点击查看大图';
      img.onclick=()=>{const w=window.open();w.document.write(`<img src="${b64}" style="max-width:100%;max-height:100vh">`)}
      thumbs.appendChild(img);
    });
    const info=document.createElement('div');
    info.style.cssText='flex:1;font-size:12px;overflow:hidden;min-width:0';
    const nameRow=document.createElement('div');
    nameRow.style.cssText='overflow:hidden;white-space:nowrap;text-overflow:ellipsis';
    nameRow.textContent=sr.name;
    if(S.curStyleRefId===sr.id){const _i=document.createElement('i');_i.className='ic ic-check';nameRow.append(' ',_i);nameRow.style.color='var(--accent)';}
    info.appendChild(nameRow);
    if(sr.description){
      const descRow=document.createElement('div');
      descRow.style.cssText='font-size:11px;color:var(--sub);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;margin-top:1px';
      descRow.textContent=sr.description;
      info.appendChild(descRow);
    }
    const useBtn=document.createElement('button');
    useBtn.className='btn-tiny';
    useBtn.textContent=S.curStyleRefId===sr.id?'已激活':'使用';
    useBtn.onclick=()=>{
      S.curStyleRefId=(S.curStyleRefId===sr.id)?null:sr.id;
      renderStyleRefStrip();renderStyleRefList();
    };
    const editBtn=document.createElement('button');
    editBtn.className='btn-tiny';editBtn.innerHTML='<i class="ic ic-pen"></i>';editBtn.title='编辑名称和描述';
    editBtn.onclick=()=>{
      // 切换为内联编辑
      const nameInput=document.createElement('input');
      nameInput.value=sr.name;
      nameInput.style.cssText='font-size:12px;width:80px;padding:2px 4px;border:1px solid var(--border);border-radius:3px;background:var(--bg);color:var(--text)';
      const descInput=document.createElement('input');
      descInput.value=sr.description||'';
      descInput.placeholder='风格描述（空=通用提示）';
      descInput.style.cssText='font-size:11px;width:130px;padding:2px 4px;border:1px solid var(--border);border-radius:3px;background:var(--bg);color:var(--text)';
      const okBtn=document.createElement('button');
      okBtn.className='btn-tiny';okBtn.innerHTML='<i class="ic ic-check"></i>';okBtn.title='保存';
      okBtn.onclick=async()=>{
        const newName=nameInput.value.trim();
        if(!newName){toast('名称不能为空','warn');return;}
        sr.name=newName;sr.description=descInput.value.trim();
        await db.put('styleRefs',sr);
        S.styleRefs=await db.allSafe('styleRefs',true);
        renderStyleRefStrip();renderStyleRefList();
        toast('已保存 ✓');
      };
      const cancelBtn=document.createElement('button');
      cancelBtn.className='btn-tiny';cancelBtn.innerHTML='<i class="ic ic-x"></i>';cancelBtn.title='取消';
      cancelBtn.onclick=()=>renderStyleRefList();
      info.innerHTML='';
      info.style.cssText='flex:1;display:flex;flex-direction:column;gap:3px;min-width:0';
      info.append(nameInput,descInput);
      el.innerHTML='';
      el.append(thumbs,info,okBtn,cancelBtn);
    };
    const delBtn=document.createElement('button');
    delBtn.className='btn-tiny';delBtn.innerHTML='<i class="ic ic-trash"></i>';delBtn.title='删除';
    delBtn.onclick=async()=>{
      if(!confirm(`删除"${sr.name}"？`)) return;
      await deleteStyleRef(sr.id);
      renderStyleRefStrip();renderStyleRefList();
      toast('已删除');
    };
    // 「存进风格库」—— 画风参考是**图片**驱动的，一次只能激活一套；
    // 转成风格库条目后就能多选叠加、不挑模型（纯文本，generations 端点也能跑）、
    // 还能被「AI 帮我选风格」和主体筛选选中。参考图本身转不过去（风格库没有图片字段）。
    const toLibBtn=document.createElement('button');
    toLibBtn.className='btn-tiny';
    toLibBtn.id='sref2lib-'+sr.id;
    toLibBtn.innerHTML='<i class="ic ic-sparkles"></i> 存库';
    const _hasDesc=!!(sr.description||'').trim();
    toLibBtn.title=_hasDesc
      ? '把这个画风参考转成风格库条目（之后可多选叠加、不挑模型、能被 AI 选风格选中）'
      : '这套没填「风格描述」，转不了 —— 先点铅笔补一句';
    // ⚠️ 刻意**不用 disabled**：手机上点 disabled 按钮是「完全没反应也不解释」，
    //    比点下去弹一句原因差得多。所以只调透明度表示不可用。
    if(!_hasDesc) toLibBtn.style.opacity='.45';
    toLibBtn.onclick=()=>{
      if(!_hasDesc){toast('这套画风参考没填「风格描述」，转不了 —— 先点铅笔补一句','warn');return}
      saveStyleRefToLibrary(sr.id);
    };
    el.append(thumbs,info,toLibBtn,useBtn,editBtn,delBtn);
    list.appendChild(el);
  });
}

// 画风参考 → 风格库条目（2026-09-28 加）
// 风格库的 English prompt tokens 会**直接拼进出图 prompt**，混中文对 CLIP 系模型不友好，
// 所以优先让大师把中文描述翻成英文词条，顺带推断「适合主体」和「类别」。
// 没配大师 API 就退回原文（中文），并明确告诉她。
async function saveStyleRefToLibrary(srId){
  const sr=S.styleRefs.find(r=>r.id===srId);
  if(!sr) return;
  const desc=(sr.description||'').trim();
  if(!desc){toast('这套画风参考没填「风格描述」，转不成文字风格','warn');return}

  const all=await db.all('styles');
  const exist=all.find(s=>s.custom&&s['中文风格名']===sr.name);

  const btn=document.getElementById('sref2lib-'+srId);
  const oldHtml=btn?btn.innerHTML:'';
  if(btn){btn.disabled=true;btn.innerHTML='…'}
  try{
    let tokens=desc,subjects='',category='动画、漫画与插画亚种',usedAI=false;
    if(S.masterPresets.length){
      const sys='你是绘画风格词条编辑。用户给一段中文画风描述，你输出一个 JSON 对象，三个字段：\n'
        +'tokens：把描述转成**精简英文风格词条**，6~14 个词、逗号分隔。'
        +'只描述「怎么画」（线条/媒介/技法/色彩处理/质感/简化程度/构图倾向/情绪基调），'
        +'**绝对不要**写具体主体、姿态、服装、道具、场景。\n'
        +'subjects：这段描述适合画什么。只能从这个词表里挑，顿号分隔，最多 3 个：'
        +'人物、角色、场景、城市、静物、动物、产品、字体、服饰、自然、建筑、封面、图标、海报、玩具。\n'
        +'category：从下面这些里选**一个**最贴近的，原样输出：\n'+Object.keys(STYLE_CAT).join('\n')+'\n'
        +'只输出 JSON，不要解释、不要 markdown 代码块。';
      const reply=await callMaster([{role:'system',content:sys},
        {role:'user',content:'画风名称：'+sr.name+'\n画风描述：'+desc}]);
      const m=reply.match(/\{[\s\S]*\}/);
      if(m){
        try{
          const j=JSON.parse(m[0]);
          if(j.tokens&&String(j.tokens).trim()) tokens=String(j.tokens).trim();
          if(j.subjects) subjects=String(j.subjects).trim();
          if(j.category&&STYLE_CAT[j.category]) category=j.category;
          usedAI=true;
        }catch(e){console.warn('[画风参考→风格库] 大师返回的 JSON 没解析出来，退回原文：',e,reply.slice(0,120))}
      }
    }else{
      toast('没配大师 API，直接存原文（中文）—— 想要英文词条请先在设置里加大师预设','warn');
    }

    const obj={
      style_id:exist?exist.style_id:('custom_'+uid()),
      '中文风格名':sr.name,
      'English prompt tokens':tokens,
      '类别':category,
      '适合主体':subjects,
      '容易翻车':'','补救提示':'',
      builtin:false,custom:true,createdAt:Date.now(),
      '来源':'画风参考「'+sr.name+'」',
    };
    await db.put('styles',obj);
    const i=S.selStyles.findIndex(s=>s.style_id===obj.style_id);
    if(i>=0) S.selStyles[i]=obj;
    renderStyles(document.getElementById('style-search-input')?.value||'');
    renderSelectedStyles();
    toast((exist?'已更新':'已存入')+`风格库：「${sr.name}」${usedAI?'':'（原文）'} → ${tokens.slice(0,36)}${tokens.length>36?'…':''}`);
  }catch(e){
    console.error('[画风参考→风格库]',e);
    toast('转换失败：'+e.message,'error');
  }finally{
    if(btn){btn.disabled=false;btn.innerHTML=oldHtml}
  }
}

function renderRefArea(){
  const row=document.getElementById('ref-char-row');
  if(row){
    const charsWithRef=S.characters.filter(ch=>ch.refImage);
    row.innerHTML='';
    for(const ch of charsWithRef){
      const btn=document.createElement('button');
      const active=S.selRefCharIds.includes(ch.id);
      btn.className='ref-char-btn'+(active?' active':'');
      btn.title=active?`取消${ch.name}参考图`:`添加${ch.name}参考图`;
      const img=document.createElement('img');
      img.src=ch.refImage;img.className='ref-char-thumb';
      btn.append(img,document.createTextNode(ch.name));
      btn.onclick=()=>{
        const idx=S.selRefCharIds.indexOf(ch.id);
        if(idx>=0) S.selRefCharIds.splice(idx,1);
        else S.selRefCharIds.push(ch.id);
        renderRefArea();
      };
      row.appendChild(btn);
    }
  }
  const strip=document.getElementById('custom-ref-strip');
  if(strip){
    strip.innerHTML='';
    S.customRefB64s.forEach((b64,i)=>{
      const wrap=document.createElement('div');
      wrap.className='custom-ref-wrap';
      const thumb=document.createElement('img');
      thumb.src=b64;thumb.className='custom-ref-thumb';
      const del=document.createElement('button');
      del.innerHTML='<i class="ic ic-x"></i>';del.className='custom-ref-del';
      del.title='移除这张';
      del.onclick=()=>{S.customRefB64s.splice(i,1);renderRefArea();};
      wrap.append(thumb,del);
      strip.appendChild(wrap);
    });
  }
  const total=S.selRefCharIds.length+S.customRefB64s.length;
  const clearBtn=document.getElementById('btn-clear-ref');
  if(clearBtn) clearBtn.style.display=total>0?'':'none';
}

function renderCharacterChips(){
  const c=document.getElementById('character-chips');
  if(!c) return;
  c.innerHTML='';
  if(!S.characters.length){
    c.innerHTML='<span style="color:var(--sub);font-size:12px">还没有角色，点「管理角色」添加</span>';
    return;
  }
  for(const ch of S.characters){
    const chip=document.createElement('span');
    chip.className='char-chip'+(S.selCharIds.includes(ch.id)?' selected':'');
    chip.textContent=(ch.icon||'👤')+' '+ch.name;
    chip.title='点击选中/取消';
    chip.onclick=()=>{
      const idx=S.selCharIds.indexOf(ch.id);
      if(idx>=0) S.selCharIds.splice(idx,1);
      else S.selCharIds.push(ch.id);
      renderCharacterChips();
    };
    c.appendChild(chip);
  }
}

let editingCharId=null,editingCharRefB64=null;
function openCharModal(){
  editingCharId=null;editingCharRefB64=null;
  document.getElementById('char-form-title').textContent='添加角色';
  document.getElementById('char-name-input').value='';
  document.getElementById('char-prompt-input').value='';
  document.getElementById('char-ref-preview').innerHTML='<i class="ic ic-image"></i>';
  document.getElementById('btn-cancel-char-edit').style.display='none';
  renderCharList();
  document.getElementById('modal-chars').style.display='flex';
}
function renderCharList(){
  const list=document.getElementById('chars-list');
  list.innerHTML='';
  if(!S.characters.length){list.innerHTML='<div style="color:var(--sub);font-size:12px;padding:4px 0">还没有角色</div>';return}
  for(const ch of S.characters){
    const el=document.createElement('div');
    el.style.cssText='display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)';
    const thumb=ch.refImage
      ?`<img src="${ch.refImage}" style="width:32px;height:32px;border-radius:var(--rs);object-fit:cover;flex-shrink:0">`
      :`<div style="width:32px;height:32px;border-radius:var(--rs);background:var(--card2);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">${ch.icon||'👤'}</div>`;
    el.innerHTML=`${thumb}<span style="flex:1;font-size:13px">${ch.name}</span>`;
    const bEdit=document.createElement('button');bEdit.className='btn-tiny';bEdit.textContent='编辑';
    bEdit.onclick=()=>{
      editingCharId=ch.id;editingCharRefB64=ch.refImage||null;
      document.getElementById('char-form-title').textContent='编辑角色：'+ch.name;
      document.getElementById('char-name-input').value=ch.name;
      document.getElementById('char-prompt-input').value=ch.prompt||'';
      const prev=document.getElementById('char-ref-preview');
      prev.innerHTML=ch.refImage?`<img src="${ch.refImage}" style="width:100%;height:100%;object-fit:cover;border-radius:var(--rs)">`:'<i class="ic ic-image"></i>';
      document.getElementById('btn-cancel-char-edit').style.display='';
    };
    const bDel=document.createElement('button');bDel.className='btn-tiny';bDel.style.color='var(--err)';bDel.textContent='删';
    bDel.onclick=async()=>{
      if(!confirm(`删除角色"${ch.name}"？`)) return;
      S.characters=S.characters.filter(c=>c.id!==ch.id);
      S.selCharIds=S.selCharIds.filter(id=>id!==ch.id);
      await saveCharacters();renderCharList();renderRefArea();
    };
    el.append(bEdit,bDel);list.appendChild(el);
  }
}
async function saveChar(){
  const name=document.getElementById('char-name-input').value.trim();
  const prompt=document.getElementById('char-prompt-input').value.trim();
  if(!name){toast('请输入角色名','warn');return}
  if(editingCharId){
    const ch=S.characters.find(c=>c.id===editingCharId);
    if(ch){ch.name=name;ch.prompt=prompt;ch.refImage=editingCharRefB64||ch.refImage||null;}
  }else{
    S.characters.push({id:uid(),name,prompt,icon:'👤',refImage:editingCharRefB64||null});
  }
  await saveCharacters();
  editingCharId=null;editingCharRefB64=null;
  document.getElementById('char-form-title').textContent='添加角色';
  document.getElementById('char-name-input').value='';
  document.getElementById('char-prompt-input').value='';
  document.getElementById('char-ref-preview').innerHTML='<i class="ic ic-image"></i>';
  document.getElementById('btn-cancel-char-edit').style.display='none';
  renderCharList();renderRefArea();
  toast('角色已保存 ✓');
}

// ── Aesthetic Profile ────────────────────────────────────────
async function loadAestheticProfile(){
  S.aestheticProfile=await db.getSetting('aestheticProfile','')||'';
  S.lastAnalyzedIds=await db.getSetting('lastAnalyzedIds',[])||[];
  if(!await db.getSetting('allAnalyzedIds_v3')){
    await db.setSetting('allAnalyzedIds',[]);
    await db.setSetting('aestheticProfile','');
    await db.setSetting('allAnalyzedIds_v3',true);
  }
  S.allAnalyzedIds=new Set(await db.getSetting('allAnalyzedIds',[])||[]);
  S.seenScenes=new Set(await db.getSetting('seenScenes',[])||[]);
  S.seenNsfwScenes=new Set(await db.getSetting('seenNsfwScenes',[])||[]);
  S.masterHistory=await db.getSetting('masterHistory',[])||[];
  S.masterLastImg=await db.getSetting('masterLastImg',null)||null;
  S.masterPendingImgs=[];
  const el=document.getElementById('master-insight-content');
  if(el&&S.aestheticProfile) el.innerHTML=miniMd(S.aestheticProfile);
  const chat=document.getElementById('master-chat');
  if(chat&&S.masterHistory.length){
    for(const m of S.masterHistory){
      const div=document.createElement('div');
      div.className=`master-msg master-msg-${m.role}`;
      if(m._hasImage) div.insertAdjacentHTML('beforeend','<span style="opacity:.6;font-size:12px"><i class="ic ic-image"></i> 附图</span><br>');
      div.insertAdjacentHTML('beforeend',miniMd(m.content));
      const del=document.createElement('button');
      del.className='msg-del';del.innerHTML='<i class="ic ic-x"></i>';del.title='删除这条';
      del.onclick=e=>{e.stopPropagation();div.remove();_removeFromHistory(m)};
      const copy=document.createElement('button');
      copy.className='msg-del';copy.innerHTML='<i class="ic ic-clipboard"></i>';copy.title='复制';
      copy.onclick=e=>{e.stopPropagation();navigator.clipboard.writeText(m.content).then(()=>{copy.textContent='✓';setTimeout(()=>copy.innerHTML='<i class="ic ic-clipboard"></i>',1500)})};
      div.appendChild(copy);
      div.appendChild(del);
      chat.appendChild(div);
    }
    chat.scrollTop=chat.scrollHeight;
  }
}

async function analyzePreference(){
  const all=await db.allSafe('gallery');   // 别用 all()：一条坏记录会让整个分析静默失败
  if(all.length<2){toast('需要至少2张图片','warn');return}

  // 自动智能选图（最多8张）
  const unanalyzed=all.filter(g=>!S.allAnalyzedIds.has(g.id));
  let sample;
  if(unanalyzed.length>=8){
    const byDate=[...unanalyzed].sort((a,b)=>b.createdAt-a.createdAt).slice(0,6);
    const byRating=[...unanalyzed].filter(g=>(g.rating||0)>0).sort((a,b)=>(b.rating||0)-(a.rating||0)).slice(0,4);
    sample=[...new Map([...byDate,...byRating].map(g=>[g.id,g])).values()].slice(0,8);
  }else if(unanalyzed.length>0){
    const analyzed=all.filter(g=>S.allAnalyzedIds.has(g.id));
    const fill=[...analyzed].sort((a,b)=>(b.rating||0)-(a.rating||0)).slice(0,8-unanalyzed.length);
    sample=[...unanalyzed,...fill].slice(0,8);
  }else{
    const byDate=[...all].sort((a,b)=>b.createdAt-a.createdAt).slice(0,6);
    const byRating=[...all].filter(g=>(g.rating||0)>0).sort((a,b)=>(b.rating||0)-(a.rating||0)).slice(0,4);
    sample=[...new Map([...byDate,...byRating].map(g=>[g.id,g])).values()].slice(0,8);
  }

  const newCount=sample.filter(g=>!S.allAnalyzedIds.has(g.id)).length;

  toast(`正在分析 ${sample.length} 张图片...`,'info');

  const imgBlocks=[];
  for(const g of sample){
    const b64=await _shrinkImg(g.imageData);
    imgBlocks.push({type:'image',source:{type:'base64',media_type:'image/jpeg',data:b64}});
  }

  const pendingAfter=unanalyzed.length-newCount;
  const hint=newCount>0?`（${newCount}张新图${pendingAfter>0?`，还剩${pendingAfter}张待分析`:'，全部分析完毕'}）`:'（全部已分析，更新档案）';
  const prevProfile=S.aestheticProfile;
  const hasOld=prevProfile&&prevProfile.length>20;
  const promptText=hasOld
    ?`这是用户新增的${sample.length}张图片${hint}。\n\n她现有的审美档案如下：\n「${prevProfile}」\n\n请综合现有档案和这批新图片，更新她的审美偏好描述——保留旧档案中仍然成立的观察，融入新图片带来的新发现或强化的趋势。像写一个人的审美性格一样：什么样的画面会打动她、她偏爱的氛围和情绪、那些反复出现的视觉执念。200-350字，只输出正文。`
    :`这是用户精选的${sample.length}张图片${hint}。请用流畅自然的文字描述她的审美偏好——不用分固定类目，像写一个人的审美性格一样：什么样的画面会打动她、她偏爱的氛围和情绪、那些反复出现的视觉执念。150-250字，只输出正文。`;
  const textBlock={type:'text',text:promptText};
  const _baseSys='你是一个懂审美也懂情感的视觉观察者，善于从图片里读出一个人的偏好和气质。';
  const msgs=[
    {role:'system',content:S.masterPersona?`${S.masterPersona}\n\n${_baseSys}`:_baseSys},
    {role:'user',content:[...imgBlocks,textBlock]}
  ];
  const result=await callMaster(msgs);

  sample.forEach(g=>S.allAnalyzedIds.add(g.id));
  await db.setSetting('allAnalyzedIds',[...S.allAnalyzedIds]);
  const newIds=sample.map(g=>g.id);
  await db.setSetting('lastAnalyzedIds',newIds);
  S.lastAnalyzedIds=newIds;

  const similarity=(()=>{
    if(!prevProfile||!result) return 0;
    const bg=s=>{const r=new Set();for(let i=0;i<s.length-1;i++) r.add(s[i]+s[i+1]);return r};
    const sa=bg(prevProfile),sb=bg(result);let ov=0;
    for(const b of sa) if(sb.has(b)) ov++;
    return sa.size+sb.size?2*ov/(sa.size+sb.size):0;
  })();
  const simPct=Math.round(similarity*100);

  S.aestheticProfile=result;
  await db.setSetting('aestheticProfile',result);
  document.getElementById('master-insight-content').innerHTML=miniMd(result);
  console.log(`[审美档案] 已更新（相似度${simPct}%）:\n`+result);
  if(hasOld&&simPct>85){
    toast(`审美档案已趋稳定（${simPct}%相似），新图影响不大 📊`,'info');
  }else{
    toast(`审美档案已更新（分析${sample.length}张，${newCount}张新图）✨`);
  }
  if(document.getElementById('tab-gallery').classList.contains('active')) renderGallery();
  else _refreshPendingCount();
}

// 删除手动选择分析的相关函数
function _confirmAnalyze(){
  // 已废弃，保留空函数避免引用报错
}

function _cancelAnalyze(){
  // 已废弃，保留空函数避免引用报错
}

// ── AI Generate Prompt ───────────────────────────────────────
async function generatePromptWithAI(){
  if(S.aiGenBusy) return;
  const userDesc=(document.getElementById('user-desc')?.value||'').trim();
  if(!userDesc){toast('请先输入想画什么','warn');return}
  if(!S.masterPresets.length){toast('请先在设置里添加大师API预设','warn');return}

  const template=S.personas.find(p=>p.id===S.curPersonaId);
  const sysPrompt=template?.basePrompt?.trim()||
    '你是专业AI绘画prompt工程师。根据角色描述、审美偏好和用户想法，写出精炼的英文prompt，直接输出prompt文本，不要解释。';

  const charDesc=S.selCharIds.map(id=>S.characters.find(c=>c.id===id)).filter(Boolean)
    .map(c=>`[角色：${c.name}] ${c.prompt||''}`)
    .join('\n');

  const parts=[];
  if(charDesc) parts.push('角色描述：\n'+charDesc);
  if(S.aestheticProfile) parts.push('用户审美档案：\n'+S.aestheticProfile);
  // 🔴 2026-09-28 二次修断链：原先这里只写了「必须与它们一致」，**没说「合成一条」**。
  //    AI 看到 N 条风格就理解成「你要 N 张图」，于是每条各写一段，还自己加上
  //    "Here are the prompts:" 这种前言 —— 出图模型读到「这里有 4 个 prompt」就画了个四宫格。
  //    现在明确要求糅合成一条，并给出媒介打架时的取舍规则（否则 4 套冲突的画法词堆在一起，
  //    出图还是散）。
  if(S.selStyles.length){
    if(S.fusionMode){
      // 🔴 2026-09-28：融合模式**不能**走下面那套「糅合成一条」的规则 —— 两者的目标正好相反。
      //    非融合：N 个风格 → 糅成一种中间画法（冲突时以第一条为主，其余只借色调）。
      //    融合　：2 个风格 → **两套视觉语言解耦共存**（① 用在角色上、② 用在场景上）。
      //    如果这里还按"糅合"去要求，AI 写出来的描述会和后面槽位行的「共存」要求打架。
      //    另外这里**不要**让 AI 把画风词写进描述里：画风由 _buildFusionPrompt 另外拼成槽位行，
      //    写进来就重复了。AI 只负责写画面本身（有什么、在做什么、怎么构图）。
      const [c0,s0]=S.selStyles;
      let seg='【风格融合 · 两套视觉语言】这次做的是「角色视觉语言 × 场景视觉语言」的跨媒介融合，'
        +'两种画风要在同一张画面里**同时清晰可辨地共存**。\n'
        +'⚠️ 注意：这不是"把两者糅成一种中间画法"，而是**各管各的** —— '
        +'一套用在人物/主体上，另一套用在环境/背景上。\n'
        +`- ① 角色视觉语言（人物/主体）：${c0['中文风格名']}｜${c0['English prompt tokens']||''}\n`;
      if(s0) seg+=`- ② 场景视觉语言（环境/背景）：${s0['中文风格名']}｜${s0['English prompt tokens']||''}\n`;
      if(S.selStyles.length>2) seg+=`（另外还勾了 ${S.selStyles.length-2} 个，融合只用前 2 个，请忽略）\n`;
      seg+='\n你这次**只写画面描述**：画面里有什么、人物在做什么、环境长什么样、什么构图和视角。'
        +'**不要在描述里出现画风、媒介、笔触、材质、渲染方式这类词** —— '
        +'两套画风会由系统接在描述后面另外拼上，你写进来会重复，还可能跟「共存」的要求冲突。';
      parts.push(seg);
    } else {
      const names=S.selStyles.map(s=>s['中文风格名']);
      let seg='【已选定的画风】下面这些画风要**同时体现在同一张画**里。'
        +'你必须把它们糅合成**一条**完整的 prompt，而不是一个风格写一条。\n'
        +S.selStyles.map(s=>`- ${s['中文风格名']}：${s['English prompt tokens']||''}`).join('\n');
      if(S.selStyles.length>1){
        seg+='\n\n糅合规则：\n'
          +'1. 每个风格的核心视觉特征（媒介、材质、色调、光线、质感）都要落到这一条 prompt 里，一个都不能漏。\n'
          +'2. 如果其中有互相打架的（典型：水墨 / 油画这类「绘画媒介」和 3D 渲染 / 摄影这类「写实媒介」无法并存），'
          +'以第一条「'+names[0]+'」为主画法，其余风格只借用它们的色调、光线和氛围，'
          +'不要把冲突的媒介词并列写出来。\n'
          +'3. 从头到尾只描述同一幅画面、同一个瞬间，不要出现「第一张 / 第二张」这种分张写法。';
      }
      parts.push(seg);
    }
  }
  const _sr=getActiveStyleRef();
  if(_sr){
    parts.push('【已激活的画风参考图】"'+_sr.name+'"'
      +(_sr.description?`（${_sr.description}）`:'')
      +'\n出图时会一并带上这套参考图，写 prompt 时请配合这个画风，不要指定冲突的画法。');
  }
  parts.push('用户想要画的内容：'+userDesc);
  // 兜底：就算模板的 basePrompt 写得很随意，这一段也把「一条、别分条、别加前言」钉死。
  parts.push('输出要求：只输出一条英文 prompt 正文。'
    +'不要标题、不要编号、不要「Prompt 1 / 2」、不要「Here are the prompts」这类前言，'
    +'不要解释、不要 markdown 代码块、不要分段换行。');

  S.aiGenBusy=true;
  const btn=document.getElementById('btn-ai-gen');
  btn.disabled=true;btn.innerHTML='<i class="ic ic-sparkles"></i> 生成中...';
  const ta=document.getElementById('final-prompt-edit');
  ta.value='';ta.placeholder='AI正在生成...';

  try{
    const msgs=[
      {role:'system',content:sysPrompt},
      {role:'user',content:parts.join('\n\n')}
    ];
    const result=await callMaster(msgs);
    ta.value=result.trim();
    // 这批风格已经糅进 base 文本了，记下来让 buildPrompt 别再重复追加它们的 tokens。
    // （没选风格时这里就是空数组，顺手把上一轮的残留清掉。）
    S.mergedStyleIds=S.selStyles.map(s=>s.style_id).filter(Boolean);
    toast('Prompt已生成 ✨');
  }catch(e){
    toast('生成失败：'+e.message,'error');
  }finally{
    S.aiGenBusy=false;
    btn.disabled=false;btn.innerHTML='<i class="ic ic-sparkles"></i> AI 生成 Prompt';
    ta.placeholder='AI生成的Prompt会出现在这里，也可以直接编辑...';
  }
}

// ── 大师对话：按需把「她点名的风格」从本地风格库捞出来 ──────────────
// 🔴 2026-09-28：大师原先看不到风格库（system 里只有人设 + 审美偏好 + 当前角色名），
//    她想「用 HD083 号风格写一张」时大师只能凭空编 —— 而风格库明明是本地的、就在手边。
//    620 条全量注入要十几万字符，太贵也没必要 —— 改成**本地按需检索**：
//    她消息里点到风格编号或风格名时，才把那几条捞出来塞进上下文，通常 1~8 条。
const STYLE_HIT_MAX=8;

// 上一次 _stylesFromText() 遇到的「裸编号歧义」说明（没歧义就是 null）。
// 🔴 2026-09-28 踩到：她写「001 号风格」，命中 **8 条** —— A001 / C001 / D001 / F001 /
//    G001 / HD001 / M001 / P001 的数字部分**都是 001**，而 STYLE_HIT_MAX 正好是 8，
//    于是 8 条全被塞给大师，还按「以第一条为主画法」把 A001（八十年代OVA）当成了主角。
//    她明明说的是 HD001。**这就是"点名风格"最容易被静默搞错的地方。**
//    现在：**歧义的裸编号一律不采用**（宁可捞不到，也不能捞错），
//    并把候选 id 记在这里，让 masterSuggest 明确告诉她"说全 id"。
let _lastStyleAmbiguity=null;

async function _stylesFromText(text){
  _lastStyleAmbiguity=null;
  const msg=(text||'').trim();
  if(!msg) return [];
  let all=[];
  try{ all=await db.all('styles') }catch(e){ return [] }
  if(!all?.length){
    // 风格库的种子挂在「展开风格面板」那一步；她可能从没展开过就直接来大师页问。
    try{ await seedStyles(); all=await db.all('styles') }catch(e){ all=[] }
  }
  if(!all?.length) return [];

  const hits=new Map();   // style_id -> {s,score}
  const bump=(s,sc)=>{ const cur=hits.get(s.style_id); if(!cur||sc>cur.score) hits.set(s.style_id,{s,score:sc}) };

  // ① 编号。style_id 是 M001 / C019 / HD083 这种。
  //    她可能写全 id（HD083），也可能只写数字（「086 号」）—— 后者比对 id 的数字部分。
  //    ⚠️ 数字要卡「前后都不是字母数字」，否则 HD083 里的 083 会被当成裸编号重复命中。
  const fullIds=msg.toUpperCase().match(/[A-Z]{1,3}\d{2,4}/g)||[];
  const bareNums=[...new Set((msg.match(/(^|[^A-Za-z0-9])\d{2,4}(?![0-9])/g)||[])
    .map(x=>x.replace(/[^0-9]/g,'')))];
  // 先把「裸编号 → 候选 style_id 列表」建出来，好判歧义。
  // 前缀 ≤1 位的那批（M/P/C/A/G/R/D/S/F/T）都是 001 起，HD 那批也从 001 起 ——
  // 所以 **001~054 这种小数字必然撞号**，越大的数字越可能唯一。
  const bareMap=new Map();
  for(const s of all){
    const id=(s.style_id||'').toUpperCase();
    const num=(id.match(/\d+/g)||[]).join('');
    if(!num||!bareNums.includes(num)) continue;
    if(!bareMap.has(num)) bareMap.set(num,[]);
    bareMap.get(num).push(id);
  }
  const ambiguous=[];
  for(const [num,ids] of bareMap){
    if(ids.length===1) continue;
    // 歧义：这个数字对应的风格不止一条。只在**没有**写成全 id 的时候才算歧义
    //（她写 HD001 时 fullIds 命中，走的是 100 分那条路，不受影响）。
    if(ids.some(id=>fullIds.includes(id))) continue;
    ambiguous.push(`${num}（${ids.length} 条：${ids.slice(0,6).join('/')}${ids.length>6?'…':''}）`);
  }
  const ambiguousNums=new Set([...bareMap.entries()].filter(([num,ids])=>
    ids.length>1 && !ids.some(id=>fullIds.includes(id))).map(([num])=>num));
  if(ambiguous.length) _lastStyleAmbiguity=ambiguous;

  for(const s of all){
    const id=(s.style_id||'').toUpperCase();
    const num=(id.match(/\d+/g)||[]).join('');
    if(fullIds.includes(id)) bump(s,100);
    else if(num && bareNums.includes(num) && !ambiguousNums.has(num)) bump(s,60);
  }

  // ② 风格名。她更常说的是名字片段（「液态铬金属那种」）。
  //    两个方向都试：整名被消息包含（强）+ 名字包含消息里的中文片段（弱）。
  //    🔴 片段**至少 3 字**，别放到 2 字：实测库里风格名最短也有 4 字，
  //    而 2 字片段噪音极大 —— 「今天天气不错随便聊聊」里的「天气」会命中
  //    「天气频道动态图」，等于把无关风格硬塞给大师。3 字就没有这个误伤面了。
  const frags=[...new Set((msg.match(/[\u4e00-\u9fa5]{3,}/g)||[])
    .flatMap(seg=>{ const out=[]; for(let i=0;i+3<=seg.length;i++) out.push(seg.slice(i,i+3)); return out; }))];
  for(const s of all){
    const name=(s['中文风格名']||'').trim();
    if(!name) continue;
    if(msg.includes(name)){ bump(s,50); continue }
    for(const f of frags){ if(name.includes(f)){ bump(s,10+f.length); break } }
  }

  return [...hits.values()].sort((a,b)=>b.score-a.score).slice(0,STYLE_HIT_MAX).map(x=>x.s);
}

// 只给大师「写 prompt 用得上」的字段，省掉「适合做 / 容易翻车 / 补救提示 / 示例短语」那几栏。
function _fmtStyleForMaster(s){
  const L=[`- ${s.style_id}｜${s['中文风格名']}${s['类别']?'（'+s['类别']+'）':''}`];
  if(s['English prompt tokens']) L.push(`  tokens: ${s['English prompt tokens']}`);
  if(s['视觉DNA / 关键词'])     L.push(`  视觉DNA: ${s['视觉DNA / 关键词']}`);
  // 2026-09-28 补：从 HD 配置导入的风格（draw_config_handraw279.json）字段集不一样 ——
  //   它们没有「视觉DNA / 关键词」，但有「中文特征」。不补这一行，大师看到的就是
  //   「编号 + 名字 + tokens」，缺了最能说明"这风格长什么样"的那段中文描述。
  if(s['中文特征'])             L.push(`  中文特征: ${s['中文特征']}`);
  if(s['材质/色彩/光线'])       L.push(`  材质/色彩/光线: ${s['材质/色彩/光线']}`);
  if(s['适合主体'])             L.push(`  适合主体: ${s['适合主体']}`);
  if(s['组合角色'])             L.push(`  组合角色: ${s['组合角色']}`);
  if(s['建议强度'])             L.push(`  建议强度: ${s['建议强度']}`);
  // 「写实」是名称风格，展开方式和编号风格不一样 —— 不告诉她，大师会硬编一个编号出来。
  if(s.isRealistic)             L.push('  ⚠️ 这是「名称风格」：直接用名字（写实摄影 / 真实电影质感摄影），不要编编号、不要展开');
  return L.join('\n');
}

async function masterSuggest(userInput){
  const ctx=[];
  if(S.aestheticProfile) ctx.push('【用户审美偏好】\n'+S.aestheticProfile);
  const charDesc=S.selCharIds.map(id=>S.characters.find(c=>c.id===id)).filter(Boolean).map(c=>c.name).join('、');
  if(charDesc) ctx.push('【当前选中角色】'+charDesc);

  // 她这条消息里点到的风格 —— 没点到就一条都不加（不增加日常对话的开销）。
  const hitStyles=await _stylesFromText(userInput);
  if(hitStyles.length){
    // 🔴 2026-09-28 改：这里原来不管融不融合，都发**非融合**那套
    //    「以第一条为主画法，其余只借色调/光线/氛围」—— 跟融合的
    //    「两套视觉语言解耦共存」正好相反。她在大师页说「角色用 X、场景用 Y」时，
    //    大师会按"糅合"去写，跟工作台出图时追加的槽位行打架。
    //    （这是「移植功能要检查邻居」这条教训的第二处 —— 第一处是 generatePromptWithAI。）
    const seg='【她这条消息点到的风格】共 '+hitStyles.length+' 条，来自本地风格库：\n'
      +hitStyles.map(_fmtStyleForMaster).join('\n')
      +'\n\n写 prompt 时直接采用上面的 tokens 和视觉特征；回她时用编号称呼（如 '+hitStyles[0].style_id+'）。';
    if(S.fusionMode && hitStyles.length>=2){
      ctx.push(seg
        +'\n\n⚠️ 工作台的「风格融合」是**开着**的，所以这次是「角色视觉语言 × 场景视觉语言」的融合：'
        +'两套风格要**同时清晰可辨地共存**在一张画面里 —— 注意：**不是**把两者糅成一种中间画法，'
        +'也**不要**让第一条压过第二条。'
        +'\n- 她如果说清了「角色用 X、场景用 Y」，就照她的分配来；没说就按上面列出的顺序，'
        +'第 1 条当角色/主体语言、第 2 条当场景/环境语言。'
        +'\n- 🔴 **你只写画面描述**（画面里有什么、在做什么、环境什么样、什么构图和视角），'
        +'**不要把画风、媒介、笔触、材质、渲染方式这类词写进那段描述里** ——'
        +'两套画风由工作台在出图时另外拼成槽位行，你写进来会重复，还可能跟「共存」的要求冲突。'
        +'\n- 也就是说 ① 那一段请写成**纯画面描述（英文）**，不要写成"某某风格 + 某某风格"的混合体。'
        +'\n- ⚠️ 最后提醒她：工作台那边**要手动勾上这两个风格**（第 1 个当角色、第 2 个当场景），'
        +'融合才会生效 —— 光在聊天里说，工作台不会自动勾。');
    } else {
      ctx.push(seg
        +'\n\n如果她点到的几条在媒介上互相打架（例：水墨 vs 3D 渲染 vs 摄影），以第一条为主画法，'
        +'其余只借色调/光线/氛围，并**主动提醒她**这个冲突。');
      // 她一次点了 2 条以上、但工作台的融合开关是关着的 —— 很可能她其实想做融合，
      // 只是忘了开开关（或者不知道该开）。让大师点她一句，别让她白忙一场。
      if(hitStyles.length>=2){
        ctx.push('（补充：工作台的「风格融合」开关**现在是关着的**。'
          +'如果她其实想要「角色用 X、场景用 Y」那种跨风格融合，请提醒她：'
          +'先去工作台勾上「风格融合」、再勾 2 个风格（第 1 个当角色、第 2 个当场景），'
          +'然后回来按融合的写法重问一次。）');
      }
    }
  }
  // 裸编号撞号了（「001 号」在 A001/C001/…/HD001 里都存在）—— 必须说清楚，
  // 否则她会以为大师"没听懂"，其实是我们**故意没采用**那个歧义编号。
  if(_lastStyleAmbiguity){
    ctx.push('【⚠️ 她写的编号有歧义，本次没有采用】'
      +_lastStyleAmbiguity.join('；')
      +'\n同一个数字在多个风格里都存在（风格 id 形如 A001 / C001 / HD001，前缀不同）。'
      +'\n**请先回她一句**，说明这个编号对应好几条风格、需要说全 id（例如 HD001），'
      +'再按你判断最贴近她意图的那一条给建议 —— 但要标明你猜的是哪条。');
  }
  // 工作台已经勾上的风格也告诉她，免得大师的建议和她在工作台的选择各写各的。
  if(S.selStyles.length){
    ctx.push('【工作台当前已选风格】'+S.selStyles.map(s=>`${s.style_id}｜${s['中文风格名']}`).join('、')
      +'\n（她已经在工作台勾了这些，你写的建议不要和它们打架。）');
  }

  const _baseSys='根据用户想法和偏好给出精炼prompt建议。格式：①核心prompt（英文，可直接用）②可选加强词③一句创意建议';
  const systemContent=ctx.length>0
    ? `${S.masterPersona||_baseSys}\n\n${ctx.join('\n\n')}`
    : (S.masterPersona||_baseSys);

  const history=S.masterHistory.slice(-12).map(m=>({role:m.role,content:m.content}));
  const hasNewImgs=S.masterPendingImgs.length>0;

  console.log('[大师对话] 历史记录轮数:',S.masterHistory.length,'本次发送:',history.length);
  console.log('[大师对话] 历史内容:',history);

  let userContent;
  if(hasNewImgs){
    const imgBlocks=S.masterPendingImgs.map(b64=>({type:'image',source:{type:'base64',media_type:'image/jpeg',data:b64}}));
    userContent=[...imgBlocks,{type:'text',text:userInput}];
  }else if(S.masterLastImg){
    history.unshift(
      {role:'user',content:[{type:'image',source:{type:'base64',media_type:'image/jpeg',data:S.masterLastImg}},{type:'text',text:'[参考图片]'}]},
      {role:'assistant',content:'好的，我已看到这张参考图片。'}
    );
    userContent=userInput;
  }else{
    userContent=userInput;
  }

  const msgs=[
    {role:'system',content:systemContent},
    ...history,
    {role:'user',content:userContent}
  ];
  console.log('[大师对话] 发送给API的完整消息:',msgs);
  const result=await callMaster(msgs);
  const histEntry={role:'user',content:userInput};
  if(hasNewImgs){
    histEntry._hasImage=true;
    S.masterLastImg=S.masterPendingImgs[S.masterPendingImgs.length-1];
    db.setSetting('masterLastImg',S.masterLastImg);
    S.masterPendingImgs=[];
    _renderMasterImgPreview();
  }
  S.masterHistory.push(histEntry,{role:'assistant',content:result});
  if(S.masterHistory.length>24) S.masterHistory=S.masterHistory.slice(-24);
  db.setSetting('masterHistory',S.masterHistory);
  console.log('[大师对话] 保存后的历史记录:',S.masterHistory);
  return result;
}

// ── 灵感碰撞引擎（四维随机，纯本地，不调API） ─────────────────
const INSPIRE_SCENES=[
  '浴缸热水氤氲中','泳池水下','画室里一个是模特一个在画','钢琴旁','深夜办公桌上',
  '暴雨中的车内','试衣间里','更衣室大镜前','阳台月光下','温泉雾气中',
  '吊床上','旧书房壁炉旁','花房温室玻璃房里','屋顶露天浴池','厨房料理台上',
  '电梯里','飘窗上','舞蹈教室落地镜前','沙滩遮阳帐下','列车卧铺里',
  '深夜无人泳池','酒窖里','旋转楼梯上','窗台上看城市夜景','浴室蒸汽弥漫中',
  '画廊闭馆后只剩两人','天台躺椅上','雨中的露台','旧电影院最后一排',
  '被纱帘围住的户外大床','深夜厨房地板上','落地窗前城市灯火做背景',
  '海底（奇幻）','云层之上的秘密花园','巨大月亮前的屋顶','星空下的透明泡泡里',
  '旧唱片封面里','一张纸钞上','塔罗牌画面中','复古杂志封面','游戏加载界面里',
  '邮票方寸之间','博物馆展柜标本','老电影海报里','日历插画的某一页',
  '香水瓶的广告画面','一封信的配图中','两人的专属货币上',
  '古战场帐中甲胄半卸灯火摇曳','废弃教堂彩窗碎光洒落','他的黑色大衣裹住她只露出脸',
  '镜面湖水上的小船','倒塌的王座旁','悬崖边被风吹起的白纱中',
  '巨大的钟面前（时间意象）','大雪纷飞中只有两人的体温',
  '地铁末班车空荡车厢','废弃游乐园摩天轮顶','图书馆高架书梯上',
  '他的衬衫她穿着站在窗边','暴风雨后的天台积水倒映天空','教堂管风琴旁',
  '旧公寓天花板漏雨接水盆旁','沉船残骸内部透光','她靠在他摩托车上等他',
  '巨幅画布前颜料沾了一身','深秋落叶堆成的小山坡上','冰封湖面裂纹之下（奇幻）',
  '巨型花朵内部','钟表齿轮间','倒置的城市',
  '神庙废墟月光下','冰川中冻住的宫殿','沙漠中露出一半的巨型雕像旁',
  '暴雨天桥下避雨衣服湿透贴着','停电的房间只有手机屏幕光照亮彼此的脸',
  '凌晨四点空无一人的街只有路灯和两人的影子','台风天反锁在办公室过夜',
  '深夜药店白炽灯下只有两人','老旧居酒屋隔间帘子半掩',
  '樱花瓣落满头发的长椅上','黄昏天台晾衣绳间的缝隙','第一场雪的窗前地板上',
  '夏日蝉鸣的午后走廊尽头','超市货架间他从后面环住她的腰','一起洗碗水溅到脸上笑着亲',
  '他在灶台前做饭她跳上料理台勾住他脖子','醉酒后被公主抱回家的楼梯间',
  '分别前机场玻璃窗两侧手掌贴着手掌','刚吵完架他回来敲门她开门瞬间',
  '水下图书馆漂浮的书页之间','巨人张开的掌心里','琥珀内部被封存的姿态',
  '洗衣机嗡嗡转的深夜他把她抱上去','浴袍半解坐在酒店落地窗台上',
  '只穿他外套站在冰箱前找东西吃','按摩椅上她坐在他腿上挡住他看电视',
  '刚运动完汗湿T恤贴着身体的更衣室','泡温泉毛巾滑下来的瞬间',
  '他单手撑墙把她困在角落（壁咚）','沙发上她趴在他身上他掀起她衣服后摆画东西',
  '被子底下只露出纠缠的腿和散落的衣服','清晨赖床她夹住他不让起来',
  '他跪在浴缸边给她洗头发手指穿过发丝','镜子前他从后面环住她解开她的项链',
  '雷暴夜停电摸黑找到彼此的体温','午睡醒来发现被子里多了一个人',
  '秋天公园长椅她整个人缩进他大衣里','天文台穹顶下只有星光和两人的呼吸声',
  '维纳斯诞生的贝壳上相拥','罗马浴场大理石台阶水雾','日式露天温泉雪落肩头',
  '芭蕾舞台谢幕他托举她定格','探戈舞池激烈拥抱呼吸交缠','京剧后台水袖缠绕',
  '赛博朋克雨夜霓虹倒影','蒸汽朋克飞艇甲板云海','魔法阵召唤仪式被打断',
  '天空之城漂浮岛边缘','新海诚夕阳电车站台','移动城堡阳台俯瞰云海',
  '剑与魔法旅馆篝火前','科幻空间站失重舱漂浮','赛博义体维修台上','末日废土避难所角落',
  '愚人悬崖边要跳','魔术师变戏法藏戒指','女祭司她读书我从后环住','皇后花园她坐我跪旁','皇帝王座他坐我坐腿上',
  '教皇忏悔室隔板两侧','恋人伊甸园苹果树下','战车副驾我摸他侧脸','力量她驯狮我旁观','隐者山顶灯塔只有星空',
  '命运之轮旋转木马对视','正义法庭天平两端','倒吊人他倒挂我吻他','死神废墟他护我','节制瀑布下他喂我水',
  '恶魔锁链缠但笑着','高塔楼顶他拉住我','星星夜空裸足踩水','月亮狼嚎月下相拥','太阳花田奔跑',
  '审判天使降临重生','世界宇宙中心拥吻',
  '长安西市胡姬酒肆','罗马斗兽场贵宾席','埃及卡纳克神殿','维京长船北极光下',
  '庞贝火山灰定格前','雅典卫城帕特农','巴比伦空中花园','吴哥窟回廊',
  '民国上海和平饭店舞池','巴黎蒙马特红磨坊','威尼斯贡多拉船头','伦敦雾都煤气灯下',
  '柏林墙涂鸦前','纽约布鲁克林大桥日落','东京昭和小酒馆','香港80年代茶餐厅',
  '冰岛极光黑沙滩','撒哈拉沙丘日出','亚马逊雨林树冠层','挪威峡湾瀑布旁',
  '大堡礁珊瑚间','黄石间歇泉','乞力马扎罗雪顶','大峡谷悬崖边'
];
const INSPIRE_COMPOSITIONS=[
  '俯拍——从正上方看下去','透过纱帘/雾气/水汽看','逆光剪影只有轮廓',
  '水面倒影构图','从肩头越过看对方表情','极近——锁骨颈线肩膀',
  '两人之间留出呼吸的negative space','从镜子反射中看到的画面',
  '被画框/窗框/拱门裁切的构图','仰视——从下方看上去的力量感',
  '背影加回眸','侧脸轮廓线条','全身入画环境占大比例','脸贴脸的极近距离',
  '一个人完整入画另一个只露局部（手臂/胸膛/下巴）','鱼眼/广角轻微变形',
  '对称构图像宗教画','画中画——画面里有另一个画面','环形/圆形构图裁切',
  '极繁——画面塞满细节','极简——大面积留白只有两人',
  '他的手占前景虚焦她在焦点里清晰','从他背后发丝缝隙间看到她',
  '圣母子构图——她在他膝上被环抱他低头看她','双人侧卧面对面视线平行',
  '她骑坐在他腿上仰头看他——视线从下到上','斜对角线构图——两人占对角',
  '前景遮挡物只露出缝隙中的两人','螺旋构图——两人缠绕如双螺旋',
  '分屏/漫画格式多格并列','长卷横构图（手卷画感）','一明一暗半边脸',
  '背对镜头看远方我们只是风景一部分','从树叶缝隙偷看','窗外看进来室内剪影',
  '极远景两人是画面小点','航拍俯视上帝视角','侧面双人剪影夕阳逆光',
  '水下头发衣摆漂浮','透过雨水玻璃模糊'
];
const INSPIRE_STYLES=[
  '铜版蚀刻画风格','古典素描手稿（达芬奇/丢勒那种）','湿壁画质感','水墨晕染',
  '彩窗玻璃/教堂花窗','青铜浮雕','古典陶瓷釉彩','丝绸刺绣质感',
  '烫金+暗纹底','珐琅微绘','粉彩洛可可','木刻版画',
  'Moebius极繁线条插画','赛博朋克霓虹','复古胶片摄影颗粒感','宝丽来褪色感',
  '浮世绘（不含和服神社）','Art Nouveau新艺术曲线','80年代像素游戏风',
  '拼贴杂志collage','儿童绘本蜡笔涂鸦','哥特暗黑插画','凹版印刷质感',
  '织锦/缂丝/挂毯','暗调卡拉瓦乔式光影','印象派厚重笔触','极简线条一笔画',
  '3D黏土小人风格','水晶/宝石内部折射','老报纸印刷（带网点）',
  'CLAMP风繁复线条+透明水彩','Alphonse Mucha式圆形装饰框+花卉缠绕',
  '敦煌壁画飞天感','暗色天鹅绒油画质感（伦勃朗路线）',
  '黑白高对比版画+只有一处是红色','炭笔速写粗粝质感',
  '日式赛璐璐平涂高光','厚涂暗角电影感','金属浮雕冷银色调',
  '工笔白描（纯线条无渲染）','波斯细密画（细碎繁密+金边）',
  '哥特泥金抄本（中世纪手抄本插图）','拜占庭马赛克（金底+平面圣像感）',
  '俄罗斯圣像画（东正教icon暗金肃穆）','巴洛克天顶画（仰视透视极尽繁复）',
  '维多利亚博物图鉴（精细写实植物/解剖风）','唐卡（矿物色+金线+宗教仪式感）',
  '古希腊陶瓶画（红绘/黑绘+几何边框）','蓝晒法氰版（只有蓝白两色）',
  '剪纸风格（镂空+正负形）','银版摄影/达盖尔法（泛银灰+幽灵感）',
  '蒸汽朋克机械图纸（铜色+齿轮+工程制图线条）','微缩模型移轴感（人物像小人偶浅景深）'
];
const INSPIRE_TENSIONS=[
  '差一点就失控但被稳稳接住','想碰但还没碰的一厘米距离','被精心对待——每个触碰都有设计感',
  '禁忌——不该在这里做这件事','睡着了被凝视——完全不设防的信任','慵懒醒来的迷糊和柔软',
  '汗湿之后的疲倦和满足','占有——环住/不放手/标记','温柔到极致像捧着会碎的东西',
  '故意挑衅和撩拨','安静的对峙——有张力但不是愤怒','被保护在怀里的安全感',
  '重逢——好久没见的饥渴','第一次——紧张又期待','主导与交出控制权',
  '在别人看不到的角落偷偷来','事后的餍足和缱绻','一个人在上面一个人在仰望',
  '伤后被包扎——痛觉中的温柔','他跪下了——权力反转的瞬间',
  '她转身要走他从后面拉住手腕','无表情但眼眶红了——在忍的张力',
  '额头抵额头闭眼——暴风雨中心的平静','笑着哭——太幸福反而落泪',
  '被掐住下巴强迫对视','酒醉后卸下所有伪装','指尖描摹对方伤疤',
  '争吵到一半突然吻住','从高处坠落被稳稳接住的瞬间',
  '明明在笑但眼神在求救','帮对方系扣子的亲密日常',
  '"你先走我断后"的牺牲感','无言对坐各自沉默但手指缠在一起',
  '帮她吹干头发手指穿过发丝','给他剃胡子刀贴脸的信任','一起洗澡他帮她搓背',
  '她困了靠肩上睡他不敢动','吵架后他先低头抱进怀','他病了她喂药吹凉',
  '雨天共撑伞肩膀都湿','寒冬把手塞他口袋握住','夏夜摇扇他嫌热还搂着',
  '她踮脚他弯腰吻得刚好','深夜梦魇他抱醒轻拍','晨起她睡着他亲额头才起'
];

// ── 意外变量池（第五维度：天气/光线/时间/意外/色彩/氛围） ──────────────
const INSPIRE_WILDCARDS=[
  '暴雨倾盆','大雪纷飞','浓雾弥漫','金色夕阳','月食进行中',
  '雷暴闪电照亮一瞬','晨雾还没散','正午刺目阳光','台风前的诡异平静','彩虹刚出现',
  '凌晨3点','黄昏最后5分钟','破晓前最暗的时刻','午夜钟声刚响','日出第一缕光',
  '突然停电','有人来了','下一秒就要被发现','刚哭完眼睛还红着','酒喝到微醺',
  '全画面只用红与黑','偏蓝冷调只有皮肤是暖色','逆光全剪影只有轮廓线发光','暖黄烛光是唯一光源',
  '所有颜色都褪掉只剩一处红','整体过曝发白像记忆褪色','冷暖撞色左右分屏',
  '刚刚打完架还喘着','一方在哭另一方不知道该怎么办','笑到停不下来','沉默了很久终于开口',
  '其中一人受了伤','在倒计时最后一刻','醉得站不稳','刚从水里上来浑身湿透',
  '对方睡着了','发烧中意识模糊','全身沾满颜料/面粉/花瓣','刚刚交换了一个秘密',
];
const NSFW_WILDCARDS=[
  '红烛将灭最后一点光','窗外月光太亮看得一清二楚','隔壁有人声必须咬住声音',
  '刚沐浴完香气未散','酒后面颊绯红','衣衫半解来不及脱完','铜镜映出纠缠全貌',
  '帘外有脚步声经过','雨声盖住一切','汗湿的鬓发贴在脸上','冰与火——一只手冰凉一只手滚烫',
  '被绑住了手只能感受','蒙眼只凭触觉','花瓣铺满身下','嘴里含着什么不能说话',
  '事后余韵未消又开始','换了主导权','在镜前看着自己被对待','只用嘴不用手',
];

// ── 概念载体场景 → 风格锁定（避免不搭的随机组合） ──────────────
const CONCEPT_STYLE_LOCK={
  '塔罗牌画面中':['Art Nouveau新艺术曲线','哥特暗黑插画','烫金+暗纹底','珐琅微绘'],
  '复古杂志封面':['复古胶片摄影颗粒感','拼贴杂志collage','老报纸印刷（带网点）'],
  '游戏加载界面里':['赛博朋克霓虹','80年代像素游戏风','Moebius极繁线条插画'],
  '邮票方寸之间':['铜版蚀刻画风格','凹版印刷质感','木刻版画'],
  '博物馆展柜标本':['古典素描手稿（达芬奇/丢勒那种）','铜版蚀刻画风格','珐琅微绘'],
  '老电影海报里':['复古胶片摄影颗粒感','老报纸印刷（带网点）','Art Nouveau新艺术曲线'],
  '一张纸钞上':['铜版蚀刻画风格','凹版印刷质感','烫金+暗纹底'],
  '旧唱片封面里':['拼贴杂志collage','复古胶片摄影颗粒感','80年代像素游戏风'],
  '香水瓶的广告画面':['粉彩洛可可','Art Nouveau新艺术曲线','极简线条一笔画'],
  '一封信的配图中':['水墨晕染','古典素描手稿（达芬奇/丢勒那种）','炭笔速写粗粝质感'],
  '两人的专属货币上':['铜版蚀刻画风格','凹版印刷质感','烫金+暗纹底'],
  '日历插画的某一页':['CLAMP风繁复线条+透明水彩','儿童绘本蜡笔涂鸦','印象派厚重笔触']
};

// ── 春宫模式池（四维：场景×体位×画风×氛围） ──────────────
const NSFW_SCENES=[
  '锦帐春宵红烛未灭','浴池水雾氤氲莲花浮','书斋案上笔墨散落','铜镜前妆台凌乱',
  '竹榻午憩薄衾半覆','花船舱中水波轻晃','山间温泉岩壁遮蔽','月下庭院石榴树旁',
  '绣楼闺房帷幔低垂','雨夜客栈烛火摇曳','春日桃林花瓣纷飞','秋千架上裙裾飘散',
  '琴房屏风半掩','茶室矮几旁蒲团上','藏书阁梯上高处','画舫二层临水栏杆旁',
  '佛堂后禅房内','雪夜火炉旁兽皮褥上','端午浴兰汤中','七夕乞巧楼上',
  '马车厢内帘幕遮','深山道观丹房','戏台后更衣处','酒楼雅间屏风后',
  '荷塘中央小舟','瀑布后石洞内','竹林深处石凳上','寺庙藏经阁角落',
  '将军帐中铠甲半卸','闺中试新衣铜镜映双人','元宵灯会暗巷里','清晨被中赖床不起',
  '他书房她不请自来反锁门','浴桶中水溢出地板','窗边月光洒在白玉般身上','芭蕉叶影透过窗纸',
  '希腊神殿月桂树下','酒神祭典幕后','山海经神兽旁','敦煌飞天落入凡间',
  '舞台剧谢幕后更衣室','芭蕾排练厅把杆旁','歌剧包厢红丝绒帘内',
  '雨后森林蕨叶间铺满苔藓','古堡密室烛台摇曳',
  '深夜录音室隔音棉墙','暗房红灯下定影液气味','画室未干油画前颜料沾身','陶艺工作室泥湿手交缠'
];
const NSFW_POSES=[
  '骑乘——她在上仰身','后入——伏案或趴枕','相对而坐缠绕','侧卧面对面交缠',
  '她靠墙他抬起她一条腿','仰卧她双手被握住举过头','他跪地她坐高处俯视',
  '从后环抱手探入衣内','她趴在他胸口他手抚背脊','坐在他腿上面对面额抵额',
  '站立她背对他仰头靠他肩','她伏在案上他覆其上','悬腿坐桌沿他站立于前',
  '浴中她背靠他胸两人同向','他单膝跪地吻她小腹','交颈拥吻手指纠缠',
  '她蜷在他怀中被整个包裹','双手撑墙他从后贴近','他仰躺她俯身长发垂下遮住两人',
  '椅上她坐他腿上背对他','她双腿环住他腰被托起','侧入她一腿被抬起架他肩上',
  '他坐她跨坐面对手撑他肩','她趴着他沿脊椎一路吻下','两人侧卧他从后勾住她',
  '她被抵在门板上双腿悬空','秋千上前后摇晃间','他坐禅椅她缓缓落座','她弯腰扶案他掀裙',
  '水中浮力她轻盈环住他','相对跪坐她攀住他颈','他横抱她至榻上覆身而下',
  '鸳鸯交颈式双人蜷缩如阴阳','她仰卧他跪于侧低头含吻','背对镜子从镜中看见自己的表情'
];
const NSFW_STYLES=[
  '工笔白描纯线条','工笔淡彩——线条勾勒+浅绛赭石','仇英仿古设色','水墨渲染没骨法',
  '春册页小品——团扇形制','明刊版画木刻线条','清宫秘戏图工笔重彩','唐寅风流雅士笔意',
  '日本春画浮世绘变体','敦煌伎乐飞天感但世俗化','绢本淡墨只用墨色浓淡',
  '金粉描边暗底宫廷风','双钩填彩工致','减笔写意逸品风','界画建筑+人物工笔',
  '民国月份牌年画感','陈洪绑仕女画路线','改琦风纤细仕女','青绿山水中小人物点景',
  '铜版蚀刻西洋春宫画','彩色铅笔细密素描','炭笔速写激烈粗线条'
];
const NSFW_MOODS=[
  '薄纱滑落将脱未脱','酒醉微醺面若桃花','汗湿黏腻发丝贴颊','初试紧张轻咬下唇',
  '事后餍足慵懒半阖眼','晨起迷蒙尚带夜痕','强忍声音手捂口','失控边缘颤抖弓背',
  '温柔至极如捧瓷器','粗暴撕扯衣带散落一地','偷欢紧张怕被发现','久别重逢饥渴急切',
  '醋意占有——不许你看别人','调教耐心——他教她如何','她主导按住他不许动',
  '泪光盈盈但不是痛是太满','湿发贴面沐浴后的清洁和欲','冰与火——冰块滑过燥热的皮肤',
  '梦中——分不清梦境与现实','窥视——帘缝中不该看到的','只解罗衫一半余韵犹在',
  '蒙眼只剩触觉——不知下一处落在哪','他低头忍耐额角青筋','她反客为主将他推倒',
  '咬痕红印——标记过的痕迹','束缚——红绳或衣带缠绕','指尖颤抖解对方最后一颗扣',
  '镜中对视——从镜子里看自己沉沦的样子','花瓣散落身上像天然遮掩又不遮',
  '墨痕/胭脂沾染白皙肌肤如画','对坐品茶假装无事脚在桌下纠缠','雨声掩盖一切声音',
  '光影切割身体如雕塑','汗珠沿锁骨滑落被舔走','咬住肩膀忍住不出声怕被听见',
  '被压在墙上动弹不得只能承受','他舔掉她嘴角酒渍顺势吻下','衣服被扯烂扣子滚落一地',
  '在镜子前被迫看自己失控的表情','月光只照亮身体曲线其他隐入暗处',
  '冰块刺激她惊跳但被按住不许躲','指甲抓出红痕事后才发现'
];

// ── 洗牌式骰子（每条用完一轮再重洗，不重复） ──────────────
let _inspireNsfwMode=false;
const _INSPIRE_POOLS={scenes:INSPIRE_SCENES,comps:INSPIRE_COMPOSITIONS,styles:INSPIRE_STYLES,tensions:INSPIRE_TENSIONS};
const _NSFW_POOLS={scenes:NSFW_SCENES,comps:NSFW_POSES,styles:NSFW_STYLES,tensions:NSFW_MOODS};
function _shuffleArr(arr){const a=[...arr];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function _getShuffled(key,nsfw){
  const prefix=nsfw?'nsfw_shuffle_':'inspire_shuffle_';
  const pools=nsfw?_NSFW_POOLS:_INSPIRE_POOLS;
  const sk=prefix+key;
  try{const d=JSON.parse(localStorage.getItem(sk));if(d&&d.pool&&d.pool.length>0&&d.total===pools[key].length)return d}catch{}
  const pool=_shuffleArr(pools[key]);
  const d={pool,total:pools[key].length};
  localStorage.setItem(sk,JSON.stringify(d));return d;
}
function _drawOne(key,nsfw){
  const pools=nsfw?_NSFW_POOLS:_INSPIRE_POOLS;
  const prefix=nsfw?'nsfw_shuffle_':'inspire_shuffle_';
  const d=_getShuffled(key,nsfw);
  const item=d.pool.pop();
  if(d.pool.length===0)d.pool=_shuffleArr(pools[key]);
  localStorage.setItem(prefix+key,JSON.stringify(d));
  return item;
}

function _rollInspireDice(){
  const wildcard=arr=>arr[Math.floor(Math.random()*arr.length)];
  if(_inspireNsfwMode){
    // 春宫场景去重
    let scene;
    const unseenNsfw=NSFW_SCENES.filter(s=>!S.seenNsfwScenes.has(s));
    if(unseenNsfw.length===0){
      S.seenNsfwScenes.clear();
      db.setSetting('seenNsfwScenes',[]);
      toast('🎲 春宫场景全部摇过一轮，已重置！','info');
      scene=NSFW_SCENES[Math.floor(Math.random()*NSFW_SCENES.length)];
    }else{
      scene=unseenNsfw[Math.floor(Math.random()*unseenNsfw.length)];
    }
    S.seenNsfwScenes.add(scene);
    db.setSetting('seenNsfwScenes',[...S.seenNsfwScenes]);
    const pose=_drawOne('comps',true);
    const style=_drawOne('styles',true);
    const mood=_drawOne('tensions',true);
    const wild=wildcard(NSFW_WILDCARDS);
    return `春宫：${scene} × ${pose} × ${style} × ${mood}\n🎯 变量：${wild}——骰子摇出来的，你觉得怎么画👀`;
  }
  // 普通场景去重
  let scene;
  const unseen=INSPIRE_SCENES.filter(s=>!S.seenScenes.has(s));
  if(unseen.length===0){
    S.seenScenes.clear();
    db.setSetting('seenScenes',[]);
    toast('🎲 场景全部摇过一轮，已重置！','info');
    scene=INSPIRE_SCENES[Math.floor(Math.random()*INSPIRE_SCENES.length)];
  }else{
    scene=unseen[Math.floor(Math.random()*unseen.length)];
  }
  S.seenScenes.add(scene);
  db.setSetting('seenScenes',[...S.seenScenes]);
  const comp=_drawOne('comps');
  const style=CONCEPT_STYLE_LOCK[scene]?CONCEPT_STYLE_LOCK[scene][Math.floor(Math.random()*CONCEPT_STYLE_LOCK[scene].length)]:_drawOne('styles');
  const tension=_drawOne('tensions');
  const wild=wildcard(INSPIRE_WILDCARDS);
  return `我想看：${scene} × ${comp} × ${style} × ${tension}\n🎯 变量：${wild}——刚摇骰子摇出来的组合，你觉得怎么样👀`;
}

function miniMd(t){
  return t.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>');
}
function _removeFromHistory(msg){
  const idx=S.masterHistory.findIndex(m=>m.role===msg.role&&m.content===msg.content);
  if(idx>=0){S.masterHistory.splice(idx,1);db.setSetting('masterHistory',S.masterHistory)}
}
function _extractPromptLine(text){
  const m=text.match(/Prompt:\s*(.+?)(?:\n中文：|$)/s);
  return m?m[1].trim():null;
}
function _renderMasterImgPreview(){
  const prev=document.getElementById('master-img-preview');
  if(!prev) return;
  prev.innerHTML='';
  if(!S.masterPendingImgs.length){prev.style.display='none';return;}
  prev.style.display='flex';
  S.masterPendingImgs.forEach((b64,i)=>{
    const wrap=document.createElement('div');
    wrap.style.cssText='position:relative;display:inline-block';
    const img=document.createElement('img');
    img.src='data:image/jpeg;base64,'+b64;
    img.style.cssText='width:60px;height:60px;object-fit:cover;border-radius:6px;display:block';
    const rm=document.createElement('button');
    rm.className='preview-rm';rm.innerHTML='<i class="ic ic-x"></i>';
    rm.style.cssText='position:absolute;top:-4px;right:-4px;width:16px;height:16px;font-size:10px;line-height:1;padding:0;border-radius:50%;background:var(--err,#e57373);color:#fff;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center';
    rm.onclick=()=>{S.masterPendingImgs.splice(i,1);_renderMasterImgPreview()};
    wrap.append(img,rm);prev.appendChild(wrap);
  });
}

function addMasterMsg(role,text,isTemp=false,imgs=null){
  const chat=document.getElementById('master-chat');
  const el=document.createElement('div');
  el.className=`master-msg master-msg-${role}${isTemp?' temp':''}`;
  if(imgs&&role==='user'){
    const imgArr=Array.isArray(imgs)?imgs:[imgs];
    imgArr.forEach(b64=>{
      const img=document.createElement('img');
      img.className='msg-img';img.src='data:image/jpeg;base64,'+b64;
      el.appendChild(img);
    });
  }
  const txtDiv=document.createElement('div');
  txtDiv.innerHTML=miniMd(text);
  el.appendChild(txtDiv);
  if(!isTemp){
    // 如果是assistant消息且包含Prompt:行，加「填入工作台」按钮
    if(role==='assistant'){
      const extracted=_extractPromptLine(text);
      if(extracted){
        const fill=document.createElement('button');
        fill.className='msg-del msg-fill';fill.innerHTML='<i class="ic ic-play"></i> 填入';fill.title='填入工作台';
        fill.onclick=e=>{
          e.stopPropagation();
          const ta=document.getElementById('final-prompt-edit');
          if(ta){ta.value=extracted;ta.dispatchEvent(new Event('input'))}
          switchTab('studio');
          toast('已填入工作台 ✓');
          fill.textContent='✓';setTimeout(()=>fill.innerHTML='<i class="ic ic-play"></i> 填入',1500);
        };
        el.appendChild(fill);
      }
    }
    const del=document.createElement('button');
    del.className='msg-del';del.innerHTML='<i class="ic ic-x"></i>';del.title='删除这条';
    del.onclick=e=>{e.stopPropagation();el.remove();_removeFromHistory({role,content:text})};
    const copy=document.createElement('button');
    copy.className='msg-del';copy.innerHTML='<i class="ic ic-clipboard"></i>';copy.title='复制';
    copy.onclick=e=>{e.stopPropagation();navigator.clipboard.writeText(text).then(()=>{copy.textContent='✓';setTimeout(()=>copy.innerHTML='<i class="ic ic-clipboard"></i>',1500)})};
    el.appendChild(copy);
    el.appendChild(del);
  }
  chat.appendChild(el);
  chat.scrollTop=chat.scrollHeight;
  return el;
}

// ── Renders ───────────────────────────────────────────────────
function renderSidebar(){
  const list=document.getElementById('persona-list');
  list.innerHTML='';
  for(const p of S.personas){
    const el=document.createElement('div');
    el.className='persona-card'+(p.id===S.curPersonaId?' active':'');
    el.title=p.name+' (双击编辑)';
    const icon=p.icon||p.name.charAt(0);
    el.innerHTML=`<div class="persona-avatar-placeholder" style="font-size:${p.icon?'22px':'18px'}">${icon}</div><span class="persona-name">${p.name}</span>`;
    el.addEventListener('click',()=>selectPersona(p.id));
    el.addEventListener('dblclick',()=>openPersonaModal(p.id));
    list.appendChild(el);
  }
}

// 原本是个空函数（预留给「画图 Prompt 变化后要做什么」）。
// 2026-09-28 填上：显示拼出来的 prompt 的长度。
// 2026-09-28 二次修正：不再无条件按 CLIP 的 77 token 报警 —— 那对 gpt-image / DALL·E 用户是假警报。
//   改成先看当前预设的模型：CLIP 系才按 token 报硬上限；字符系按字符算；
//   认不出的模型只显示计数。大窗口模型额外给一条「太长会摊薄注意力」的软提示（黄）。
function updateFinalPrompt(){
  const el=document.getElementById('prompt-len-hint');
  if(!el) return;
  const full=buildPrompt();
  // 融合模式顺手刷新槽位摘要（主题取自「想画什么」、画幅取自「尺寸」，
  // 这两处一变摘要就该跟着变，否则她看到的是上一次的槽位）
  if(S.fusionMode){
    const slots=document.getElementById('fusion-slots');
    if(slots) slots.innerHTML=_fusionSummary();
  }
  if(!full){
    el.textContent='';
    el.removeAttribute('title');
    // 融合模式下空 prompt 只有两个原因：没勾满 2 个风格 / 画面内容和主题都没写。
    // 在长度提示那一行直接说清楚，省得她去猜。
    if(S.fusionMode){
      if(S.selStyles.length<2){ el.textContent='融合还需要再勾 '+(2-S.selStyles.length)+' 个风格'; el.style.color='var(--warn)'; }
      else { el.textContent='融合还缺画面内容 —— 「想画什么」或「画图 Prompt」写一句'; el.style.color='var(--warn)'; }
    }
    return;
  }
  // 融合 prompt 天生就长（固定的共存契约尾段约 900 字符），别按普通 prompt 那套
  // 「超 1200 字符就报黄」去吓她 —— 那是上游要求逐字附上的，不是她写多了。
  if(S.fusionMode){
    const n=_estTokens(full);
    el.textContent=`${full.length} 字符 / 约 ${n} token — 风格融合模式（含固定的「共存契约」尾段，偏长是正常的）`;
    el.style.color='var(--sub)';
    el.title='风格融合会在 prompt 末尾附上上游 handraw-style 的固定「共存契约」段落（约 900 字符）。\n'
      +'那段是他们要求逐字复制的，作用是让模型理解「两套视觉语言要解耦共存」，不建议删。\n'
      +'真正影响出图的是前半部分的槽位行（角色/场景/主题/情绪/画幅）。';
    return;
  }
  const model=_activeDrawModel();
  const lim=_promptLimit(model);
  const chars=full.length;
  const n=_estTokens(full);
  // 跟 buildPrompt 保持一致：已经糅进 base 的风格不再重复追加，长度提示里也不该算它们。
  const styleN=_estTokens(S.selStyles.filter(s=>!S.mergedStyleIds.includes(s.style_id))
    .map(s=>s['English prompt tokens']).join(', '));

  if(lim.unit==='token'){
    // CLIP 系：token 是硬上限，超了真掉词
    el.textContent = n<=75
      ? `约 ${n} token（${lim.label} 上限 77）`
      : `约 ${n} token — 超出 ${lim.label} 的 77 上限，排在后面的会被丢弃（当前风格占约 ${styleN}）`;
    el.style.color = n<=75 ? 'var(--sub)' : 'var(--err)';
  }else if(lim.limit&&chars>lim.limit){
    // 字符系真的超了（几乎只有 dall-e-2/3 会撞到）
    el.textContent = `${chars} 字符 — 超出 ${lim.label} 的 ${lim.limit} 字符上限，会被截断`;
    el.style.color='var(--err)';
  }else{
    // 大窗口模型：撞不到上限，但太长会摊薄注意力 —— 给软提示，不吓人
    const base = lim.limit
      ? `${chars} 字符 / 约 ${n} token（${lim.label} 上限 ${lim.limit} 字符）`
      : `${chars} 字符 / 约 ${n} token`;
    el.textContent = chars>1200 ? `${base} — 偏长，模型注意力会被摊薄，建议精简` : base;
    el.style.color = chars>1200 ? 'var(--warn)' : 'var(--sub)';
  }

  el.title='不同画图模型的 prompt 上限是两套体系：\n'
    +'· gpt-image / DALL·E 系按字符算（gpt-image 32000、dall-e-3 4000、dall-e-2 1000），一般撞不到。\n'
    +'· SD1.5 / SDXL 这类 CLIP 系只有 77 token 窗口，超出的部分会被静默丢掉。\n'
    +`当前预设：${model||'未配置模型'}（${lim.label||'认不出的模型，只显示计数'}）。\n`
    +'注：就算没到上限，prompt 太长也会摊薄模型注意力 —— 主体 + 2~4 个风格通常最稳。';
}

async function renderGallery(){
  const grid=document.getElementById('gallery-grid');
  grid.innerHTML='<div class="loading">加载中...</div>';
  const fp=document.getElementById('filter-persona')?.value||'';
  const fr=parseInt(document.getElementById('filter-rating')?.value||'0');
  const ft=(document.getElementById('filter-tag')?.value||'').trim().toLowerCase();
  const allItems=await db.galleryMeta();
  let items=[...allItems];
  if(fp) items=items.filter(i=>i.personaId===fp);
  if(fr) items=items.filter(i=>(i.rating||0)>=fr);
  if(ft) items=items.filter(i=>(i.tags||[]).some(t=>t.toLowerCase().includes(ft)));
  items.sort((a,b)=>b.createdAt-a.createdAt);

  const pendingCount=allItems.filter(i=>!S.allAnalyzedIds.has(i.id)).length;
  const pendingEl=document.getElementById('gallery-pending-label');
  if(pendingEl) pendingEl.textContent=pendingCount>0?`${pendingCount} 张待分析`:'';
  document.getElementById('gallery-stats').textContent=`共 ${items.length} 张`;

  const sel=document.getElementById('filter-persona');
  const cur=sel.value;
  sel.innerHTML='<option value="">全部模板</option>';
  S.personas.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name;sel.appendChild(o)});
  sel.value=cur;

  _galItems=items;
  _galShown=_galPageSize();
  _paintGallery();
}

function _paintGallery(){
  const grid=document.getElementById('gallery-grid');
  if(_galObserver){_galObserver.disconnect();_galObserver=null;}
  grid.innerHTML='';
  if(!_galItems.length){grid.innerHTML='<div class="empty-state">还没有图片，去工作台画一张吧 ✨</div>';_updateBatchBar();return}
  // 有缩略图的直接显示（一张几 KB，不碰数据库）；老记录还没缩略图，
  // 滚到跟前才读整条 —— 读出来顺手补一张存回去，所以老库会在翻看的过程中自己变小。
  _galObserver=new IntersectionObserver(entries=>{
    for(const entry of entries){
      if(!entry.isIntersecting) continue;
      const img=entry.target;
      _galObserver.unobserve(img);
      db.get('gallery',img.dataset.id).then(async r=>{
        if(!r) return;
        img.src=r.imageData;
        if(!r.thumb){
          const t=await _makeThumb(r.imageData,192,0.7);
          if(t){r.thumb=t;try{await db.put('gallery',r)}catch(_e){}}
        }
      }).catch(e=>console.warn('[图库] 这条图读不出来（外置图文件被清）：',img.dataset.id,e?.message||e));
    }
  },{rootMargin:'200px'});
  const analyzedSet=S.allAnalyzedIds;
  const selecting=S.gallerySelecting||S.analyzePicking;
  for(const item of _galItems.slice(0,_galShown)){
    const el=document.createElement('div');
    el.className='gallery-item'+(selecting&&S.gallerySelected.has(item.id)?' gal-selected':'');
    el.style.cssText='position:relative;overflow:hidden;border-radius:var(--r);cursor:pointer;background:var(--card2)';
    const badge=analyzedSet.size===0?''
      :analyzedSet.has(item.id)
        ?'<div class="gallery-badge analyzed"><i class="ic ic-check"></i></div>'
        :'<div class="gallery-badge new-img">NEW</div>';
    const cb=selecting?`<label class="gal-cb"><input type="checkbox" ${S.gallerySelected.has(item.id)?'checked':''}><span class="gal-check"></span></label>`:'';
    const delBtn=selecting?'':'<button class="gal-quick-del" title="删除"><i class="ic ic-x"></i></button>';
    el.innerHTML=`<img data-id="${item.id}"${item.thumb?` src="${item.thumb}"`:''} alt="" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover">${badge}${cb}${delBtn}<div class="gallery-item-overlay"><span class="gallery-item-rating">${'⭐'.repeat(item.rating||0)}</span><span class="gallery-item-persona">${item.personaName||''}</span></div>`;
    if(!item.thumb) _galObserver.observe(el.querySelector('img'));
    const qdel=el.querySelector('.gal-quick-del');
    if(qdel) qdel.addEventListener('click',e=>{e.stopPropagation();_quickDeleteGallery(item)});
    if(selecting){
      const cbInput=el.querySelector('.gal-cb input');
      cbInput.addEventListener('click',e=>e.stopPropagation());
      cbInput.addEventListener('change',()=>{
        if(cbInput.checked) S.gallerySelected.add(item.id); else S.gallerySelected.delete(item.id);
        el.classList.toggle('gal-selected',cbInput.checked);
        _updateBatchBar();
      });
      el.addEventListener('click',()=>{cbInput.checked=!cbInput.checked;cbInput.dispatchEvent(new Event('change'))});
    }else{
      el.addEventListener('click',()=>openDetail(item));
    }
    grid.appendChild(el);
  }
  if(_galItems.length>_galShown){
    const remaining=_galItems.length-_galShown;
    const btn=document.createElement('button');
    btn.className='gallery-load-more';
    btn.textContent=`加载更多（还有 ${remaining} 张）`;
    btn.onclick=()=>{_galShown+=_galPageSize();_paintGallery()};
    grid.appendChild(btn);
  }
  _updateBatchBar();
}

async function _quickDeleteGallery(item){
  if(!confirm('删除这张图片？')) return;
  await db.del('gallery',item.id);
  _galItems=_galItems.filter(i=>i.id!==item.id);
  S.gallerySelected.delete(item.id);
  document.getElementById('gallery-stats').textContent=`共 ${_galItems.length} 张`;
  _paintGallery();
  toast('已删除');
}

function toggleGallerySelect(){
  S.gallerySelecting=!S.gallerySelecting;
  if(!S.gallerySelecting) S.gallerySelected.clear();
  S.analyzePicking=false; // 退出分析模式
  const btn=document.getElementById('btn-gallery-select');
  btn.innerHTML=S.gallerySelecting?'<i class="ic ic-x"></i> 退出多选':'<i class="ic ic-check-square"></i> 多选';
  btn.classList.toggle('active',S.gallerySelecting);
  _paintGallery();
}

function _updateBatchBar(){
  const bar=document.getElementById('gallery-batch-bar');
  const analyzeBar=document.getElementById('gallery-analyze-bar');
  if(!bar||!analyzeBar) return;
  const n=S.gallerySelected.size;

  if(S.analyzePicking){
    bar.style.display='none';
    if(n===0){analyzeBar.style.display='none';return}
    analyzeBar.style.display='flex';
    analyzeBar.querySelector('.batch-count').textContent=`已选 ${n} 张`;
  }else if(S.gallerySelecting){
    analyzeBar.style.display='none';
    if(n===0){bar.style.display='none';return}
    bar.style.display='flex';
    bar.querySelector('.batch-count').textContent=`已选 ${n} 张`;
  }else{
    bar.style.display='none';
    analyzeBar.style.display='none';
  }
}

async function _batchDeleteGallery(){
  const ids=[...S.gallerySelected];
  if(!ids.length) return;
  if(!confirm(`确定删除选中的 ${ids.length} 张图片？`)) return;
  for(const id of ids) await db.del('gallery',id);
  S.gallerySelected.clear();
  toast(`已删除 ${ids.length} 张`);
  renderGallery();
}

function _batchSelectAll(){
  const visible=_galItems.slice(0,_galShown);
  const allSelected=visible.every(i=>S.gallerySelected.has(i.id));
  if(allSelected) visible.forEach(i=>S.gallerySelected.delete(i.id));
  else visible.forEach(i=>S.gallerySelected.add(i.id));
  _paintGallery();
}

// ── Actions ───────────────────────────────────────────────────
function selectPersona(id){
  if(S.curPersonaId===id){
    S.curPersonaId=null;
    renderSidebar();
    document.getElementById('current-persona-name').textContent='未选择模板';
    document.getElementById('persona-base-prompt').textContent='（暂无生成指导）';
    document.getElementById('btn-edit-persona-quick').style.display='none';
    return;
  }
  S.curPersonaId=id;
  renderSidebar();
  const p=S.personas.find(x=>x.id===id);
  document.getElementById('current-persona-name').textContent=p?.name||'未选择模板';
  document.getElementById('persona-base-prompt').textContent=p?.basePrompt||'（暂无生成指导）';
  const qBtn=document.getElementById('btn-edit-persona-quick');
  qBtn.style.display=id?'':'none';
}

// ── Persona Modal ─────────────────────────────────────────────
let editingPid=null;
function openPersonaModal(id=null){
  editingPid=id;
  const p=id?S.personas.find(x=>x.id===id):null;
  document.getElementById('modal-persona-title').textContent=id?'编辑 Prompt 模板':'新建 Prompt 模板';
  document.getElementById('persona-name-input').value=p?.name||'';
  document.getElementById('persona-icon-input').value=p?.icon||'';
  document.getElementById('persona-base-input').value=p?.basePrompt||'';
  document.getElementById('persona-notes-input').value=p?.notes||'';
  document.getElementById('btn-delete-persona').style.display=id?'':'none';
  document.getElementById('modal-persona').style.display='flex';
  setTimeout(()=>document.getElementById('persona-name-input').focus(),100);
}
async function savePersona(){
  const name=document.getElementById('persona-name-input').value.trim();
  if(!name){toast('请输入模板名称','warn');return}
  const existing=editingPid?S.personas.find(p=>p.id===editingPid):null;
  // {...existing} 是为了**保住历史字段**（比如已废弃的 defaultNeg）——
  // 用展开而不是逐字段重建，就不会在保存时把老记录里读不出来的东西悄悄抹掉。
  const obj={
    ...(existing||{}),
    id:editingPid||uid(),name,
    icon:document.getElementById('persona-icon-input').value.trim()||'🎨',
    basePrompt:document.getElementById('persona-base-input').value.trim(),
    notes:document.getElementById('persona-notes-input').value.trim(),
    createdAt:existing?.createdAt||Date.now(),updatedAt:Date.now()
  };
  await db.put('personas',obj);
  await loadPersonas();
  closeModal('modal-persona');
  selectPersona(obj.id);
  toast(editingPid?'模板已更新 ✓':'模板已创建 ✨');
}
async function deletePersona(){
  if(!editingPid) return;
  const p=S.personas.find(x=>x.id===editingPid);
  if(!confirm(`确定删除模板"${p?.name}"？`)) return;
  await db.del('personas',editingPid);
  if(S.curPersonaId===editingPid) S.curPersonaId=null;
  await loadPersonas();
  closeModal('modal-persona');
  toast('模板已删除');
}

// ── Template ──────────────────────────────────────────────────
async function saveTemplate(){
  const name=prompt('模版名称：');
  if(!name?.trim()) return;
  await db.put('templates',{
    id:uid(),name:name.trim(),personaId:S.curPersonaId,
    styles:[...S.selStyles],
    prompt:document.getElementById('final-prompt-edit').value||'',
    size:document.getElementById('param-size').value||'1024x1024',
    createdAt:Date.now()
  });
  toast(`模版"${name}"已保存 ✨`);
}
async function openTemplates(){
  const all=await db.all('templates');
  const list=document.getElementById('templates-list');
  list.innerHTML='';
  if(!all.length){list.innerHTML='<div class="empty-state">还没有保存的模版</div>';
  }else{
    all.sort((a,b)=>b.createdAt-a.createdAt).forEach(t=>{
      const el=document.createElement('div');
      el.className='template-item';
      const styleNames=(t.styles||[]).map(s=>s['中文风格名']||s.name).filter(Boolean);
      // 词条库 2026-09-28 整块删掉。老模版里可能还存着 tokens 字段，一律当没有 ——
      // 不要把历史记录当成"这里应该有个值"。
      const metaParts=[];
      if(styleNames.length) metaParts.push(styleNames.map(n=>'<i class="ic ic-palette"></i>'+n).join(' '));
      metaParts.push(fmt(t.createdAt));
      el.innerHTML=`<div class="template-name">${t.name}</div><div class="template-meta">${metaParts.join(' · ')}</div><div class="template-actions"></div>`;
      const bLoad=document.createElement('button');
      bLoad.className='btn-primary btn-sm';bLoad.textContent='载入';
      bLoad.onclick=()=>{
        S.selStyles=t.styles?[...t.styles]:[];
        S.mergedStyleIds=[];   // base 整个换了，上一轮的「已糅合」标记跟着作废
        if(t.prompt) document.getElementById('final-prompt-edit').value=t.prompt;
        if(t.size) document.getElementById('param-size').value=t.size;
        if(t.personaId) selectPersona(t.personaId);
        renderSelectedStyles();
        document.querySelectorAll('.style-tag').forEach(el=>el.classList.toggle('selected',S.selStyles.some(s=>s.style_id===el.dataset.sid)));
        closeModal('modal-templates');toast('模版已载入 ✨');
        S.lastTemplateName=t.name;
      };
      const bDel=document.createElement('button');
      bDel.className='btn-danger btn-sm';bDel.textContent='删除';
      bDel.onclick=async()=>{await db.del('templates',t.id);openTemplates()};
      el.querySelector('.template-actions').append(bLoad,bDel);
      list.appendChild(el);
    });
  }
  document.getElementById('modal-templates').style.display='flex';
}

// ── Detail Modal ──────────────────────────────────────────────
async function openDetail(item){
  let full;
  try{ full=await db.get('gallery',item.id) }
  catch(e){
    console.warn('[图库] 这条图打不开（外置图文件被清）：',item.id,e?.message||e);
    toast('这张图的数据已损坏，打不开了','warn');
    return;
  }
  if(!full) return;
  S.curDetail=full;
  document.getElementById('detail-image').src=full.imageData;
  document.getElementById('detail-persona').textContent=full.personaName||'无模板';
  document.getElementById('detail-date').textContent=fmt(full.createdAt);
  document.getElementById('detail-prompt').value=full.prompt||'';
  document.getElementById('detail-params').textContent=`尺寸：${full.params?.size||'—'}`;
  document.getElementById('btn-save-detail-prompt').style.display='none';
  renderStars(full.rating||0);
  renderDetailTags(full.tags||[]);
  renderDetailStyles(full.styles||[]);
  document.getElementById('modal-detail').style.display='flex';
}
function renderStars(cur){
  const c=document.getElementById('detail-rating');c.innerHTML='';
  for(let i=1;i<=5;i++){
    const s=document.createElement('span');
    s.className='star'+(i<=cur?' active':'');s.textContent='★';
    s.onclick=async()=>{if(!S.curDetail) return;S.curDetail.rating=i;await db.put('gallery',S.curDetail);renderStars(i);toast('⭐'.repeat(i))};
    c.appendChild(s);
  }
}
function renderDetailTags(tags){
  const c=document.getElementById('detail-tags');c.innerHTML='';
  for(const tag of tags){
    const el=document.createElement('span');
    el.className='detail-tag';el.textContent=tag;
    el.title='点击删除';
    el.onclick=async()=>{if(!S.curDetail) return;S.curDetail.tags=(S.curDetail.tags||[]).filter(t=>t!==tag);await db.put('gallery',S.curDetail);renderDetailTags(S.curDetail.tags)};
    c.appendChild(el);
  }
}
function renderDetailStyles(styles){
  const row=document.getElementById('detail-styles-row');
  const c=document.getElementById('detail-styles');
  if(!styles.length){row.style.display='none';return}
  row.style.display='';c.innerHTML='';
  for(const s of styles){
    const el=document.createElement('span');
    el.className='detail-tag';el.style.cssText='background:var(--purple);color:#fff;cursor:pointer';
    el.innerHTML='<i class="ic ic-palette"></i> '+s.name;el.title=s.tokens;
    el.onclick=()=>{navigator.clipboard.writeText(s.tokens);toast('已复制：'+s.name)};
    c.appendChild(el);
  }
}
async function addDetailTag(){
  const tag=prompt('添加标签：');if(!tag?.trim()||!S.curDetail) return;
  S.curDetail.tags=[...(S.curDetail.tags||[]),tag.trim()];
  await db.put('gallery',S.curDetail);renderDetailTags(S.curDetail.tags);
}
async function deleteDetail(){
  if(!S.curDetail||!confirm('确定删除这张图片？')) return;
  await db.del('gallery',S.curDetail.id);
  S.curDetail=null;closeModal('modal-detail');renderGallery();toast('已删除');
}
async function saveDetailPrompt(){
  if(!S.curDetail) return;
  S.curDetail.prompt=document.getElementById('detail-prompt').value.trim();
  await db.put('gallery',S.curDetail);
  document.getElementById('btn-save-detail-prompt').style.display='none';
  toast('已保存 ✓');
}
function useDetailPrompt(){
  if(!S.curDetail) return;
  S.curDetail.prompt=document.getElementById('detail-prompt').value.trim();
  switchTab('studio');
  document.getElementById('final-prompt-edit').value=S.curDetail.prompt||'';
  if(S.curDetail.styles&&S.curDetail.styles.length){
    S.selStyles=S.curDetail.styles.map(s=>({style_id:s.id,'中文风格名':s.name,'English prompt tokens':s.tokens}));
  }else{S.selStyles=[]}
  S.mergedStyleIds=[];   // 换了一份 prompt + 一套风格，融合标记作废
  renderSelectedStyles();renderStyles();
  closeModal('modal-detail');toast('Prompt已载入工作台'+(S.selStyles.length?' · 风格已恢复':''));
}

// ── Preset Management ─────────────────────────────────────────
function openSettings(){
  loadCfg();
  const lsEl=document.getElementById('input-local-server');
  if(lsEl) lsEl.value=S.localServer||'';
  const mpEl=document.getElementById('input-master-persona');
  if(mpEl) mpEl.value=S.masterPersona||'';
  renderDrawPresets();
  renderMasterPresets();
  document.getElementById('modal-settings').style.display='flex';
}

function renderDrawPresets(){_renderPresets(S.drawPresets,S.curDrawId,'draw-presets-list','draw')}
function renderMasterPresets(){_renderPresets(S.masterPresets,S.curMasterId,'master-presets-list','master')}

function _renderPresets(presets,curId,containerId,type){
  const c=document.getElementById(containerId);
  c.innerHTML='';
  if(!presets.length){
    c.innerHTML='<div style="color:var(--sub);font-size:12px;padding:6px 0">还没有预设，点"+ 添加"创建</div>';
    return;
  }
  presets.forEach(p=>c.appendChild(_buildPresetCard(p,p.id===curId,type)));
}

function _buildPresetCard(preset,isActive,type){
  const card=document.createElement('div');
  card.className='preset-card'+(isActive?' preset-active':'')+(preset.skipFallback?' preset-skip':'');

  const hdr=document.createElement('div');
  hdr.className='preset-card-hdr';
  hdr.innerHTML=`
    <span class="preset-check" title="点击切换为当前使用">${isActive?'<i class="ic ic-check"></i>':'○'}</span>
    <span class="preset-name" title="点击切换">${preset.name||'未命名'}</span>
    <button class="btn-tiny" data-a="rename" title="改名" style="padding:2px 5px"><i class="ic ic-pen"></i></button>
    <button class="btn-tiny" data-a="copy" title="复制预设" style="padding:2px 5px">复</button>
    <button class="btn-tiny" data-a="up" title="上移" style="padding:2px 5px">▲</button>
    <button class="btn-tiny" data-a="dn" title="下移" style="padding:2px 5px">▼</button>
    <button class="btn-tiny" data-a="toggle">展开</button>
    <button class="btn-tiny" data-a="del" style="color:var(--err);border-color:var(--err)">删</button>
  `;
  hdr.querySelector('.preset-check').onclick=()=>_setActive(preset,type);
  const nameEl=hdr.querySelector('.preset-name');
  nameEl.onclick=()=>_setActive(preset,type);
  hdr.querySelector('[data-a="rename"]').onclick=()=>{
    const arr=type==='draw'?S.drawPresets:S.masterPresets;
    const cur=arr.find(p=>p.id===preset.id);
    if(!cur) return;
    const n=prompt('改名：',cur.name||'');
    if(n?.trim()){cur.name=n.trim();savePresetsToLS();renderDrawPresets();renderMasterPresets()}
  };
  hdr.querySelector('[data-a="copy"]').onclick=()=>{
    const arr=type==='draw'?S.drawPresets:S.masterPresets;
    const idx=arr.findIndex(p=>p.id===preset.id);
    if(idx<0) return;
    const copy={...arr[idx],id:uid(),name:(arr[idx].name||'未命名')+' 副本'};
    arr.splice(idx+1,0,copy);
    savePresetsToLS();renderDrawPresets();renderMasterPresets();
    toast(`已复制预设"${arr[idx].name}" ✓`);
  };
  const _movePreset=(delta)=>{
    const arr=type==='draw'?S.drawPresets:S.masterPresets;
    const idx=arr.findIndex(p=>p.id===preset.id);
    const to=idx+delta;
    if(to<0||to>=arr.length) return;
    [arr[idx],arr[to]]=[arr[to],arr[idx]];
    savePresetsToLS();renderDrawPresets();renderMasterPresets();
  };
  hdr.querySelector('[data-a="up"]').onclick=()=>_movePreset(-1);
  hdr.querySelector('[data-a="dn"]').onclick=()=>_movePreset(1);
  hdr.querySelector('[data-a="toggle"]').onclick=()=>{
    const body=card.querySelector('.preset-body');
    body.classList.toggle('open');
    hdr.querySelector('[data-a="toggle"]').textContent=body.classList.contains('open')?'收起':'展开';
  };
  hdr.querySelector('[data-a="del"]').onclick=()=>{
    if(!confirm(`删除预设"${preset.name}"？`)) return;
    if(type==='draw'){S.drawPresets=S.drawPresets.filter(p=>p.id!==preset.id);if(S.curDrawId===preset.id)S.curDrawId=S.drawPresets[0]?.id||null}
    else{S.masterPresets=S.masterPresets.filter(p=>p.id!==preset.id);if(S.curMasterId===preset.id)S.curMasterId=S.masterPresets[0]?.id||null}
    savePresetsToLS();renderDrawPresets();renderMasterPresets();
  };

  const meta=document.createElement('div');
  meta.className='preset-meta';
  meta.textContent=`${(preset.url||'未配置URL').replace(/^https?:\/\//,'').slice(0,34)} · ${preset.model||'未配置模型'}${type==='draw'&&preset.quality?` · 画质 ${preset.quality}`:''}`;

  const body=document.createElement('div');
  body.className='preset-body';
  const _dfSel=(v,opt)=>(v||'images')===opt?'selected':'';
  const fmtRow=type==='draw'?`
    <div class="preset-row"><label>格式</label>
      <select data-f="format">
        <option value="images" ${_dfSel(preset.format,'images')}>images（标准）</option>
        <option value="chat" ${_dfSel(preset.format,'chat')}>chat（部分站子）</option>
        <option value="nvidia" ${_dfSel(preset.format,'nvidia')}>nvidia（NVIDIA NIM）</option>
      </select>
    </div>`:'' ;
  // 画质档位：留空=不传（上游默认）。只对 images / edits 两条通道有意义，
  // nvidia / chat 通道的请求体里根本没有 quality 这个字段。
  // ⚠️ xhigh / max 只有 gpt-image-2.5 系（sunburst / flare）认，切回 gpt-image-2
  //    或 dall-e-3 时要记得改回来，否则轻则被忽略、重则 400。
  const _qSel=v=>preset.quality===v?'selected':'';
  const qualityRow=type==='draw'?`
    <div class="preset-row"><label title="只对 images / edits 通道生效；留空=不传，由上游自己定">画质</label>
      <select data-f="quality">
        <option value="">不传（上游默认）</option>
        <optgroup label="gpt-image 系">
          <option value="auto" ${_qSel('auto')}>auto</option>
          <option value="low" ${_qSel('low')}>low</option>
          <option value="medium" ${_qSel('medium')}>medium</option>
          <option value="high" ${_qSel('high')}>high</option>
        </optgroup>
        <optgroup label="仅 2.5 系（sunburst / flare）">
          <option value="xhigh" ${_qSel('xhigh')}>xhigh</option>
          <option value="max" ${_qSel('max')}>max</option>
        </optgroup>
        <optgroup label="DALL·E 3">
          <option value="standard" ${_qSel('standard')}>standard</option>
          <option value="hd" ${_qSel('hd')}>hd</option>
        </optgroup>
      </select>
    </div>`:'';
  body.innerHTML=`
    <div class="preset-row"><label>Key</label><input type="password" data-f="key" value="${preset.key||''}" placeholder="sk-..."></div>
    <div class="preset-row"><label>URL</label><input type="text" data-f="url" value="${preset.url||''}" placeholder="https://api.xxx.com/v1"></div>
    <div class="preset-row"><label>模型</label><input type="text" data-f="model" value="${preset.model||''}" placeholder="${type==='draw'?'dall-e-3':'claude-opus-4-7'}"><button class="btn-tiny" data-a="fetch-models" title="用上面的 URL + Key 拉取可用模型列表" style="flex:none">获取</button></div>
    ${fmtRow}${qualityRow}
    <div class="preset-row" style="gap:8px;align-items:center">
      <label style="min-width:40px;text-align:right">备用</label>
      <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;color:var(--text)">
        <input type="checkbox" data-f="skipFallback" ${preset.skipFallback?'checked':''} style="width:auto;flex:none">
        跳过自动备用（保留在列表但失败时不轮询）
      </label>
    </div>
    ${type==='draw'?`<div class="preset-row" style="gap:8px;align-items:center">
      <label style="min-width:40px;text-align:right">异步</label>
      <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;color:var(--text)">
        <input type="checkbox" data-f="asyncMode" ${preset.asyncMode?'checked':''} style="width:auto;flex:none">
        异步出图（适合65535.space等长耗时站子，提交后轮询结果）
      </label>
    </div>
    <div class="preset-row" style="gap:8px;align-items:center">
      <label style="min-width:40px;text-align:right">拼图</label>
      <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;color:var(--text)">
        <input type="checkbox" data-f="singleImage" ${preset.singleImage?'checked':''} style="width:auto;flex:none">
        多参考图拼成一张传入（适合只支持单张image字段的站子，如小鸡）
      </label>
    </div>`:''}
    <div class="preset-body-actions">
      <button class="btn-primary btn-sm" data-a="save">保存</button>
      <button class="btn-outline btn-sm" data-a="use">保存并切换</button>
    </div>
  `;
  const doSave=()=>{
    body.querySelectorAll('[data-f]').forEach(el=>{
      if(el.type==='checkbox') preset[el.dataset.f]=el.checked;
      else preset[el.dataset.f]=el.value.trim();
    });
    savePresetsToLS();renderDrawPresets();renderMasterPresets();toast('预设已保存 ✓');
    if(type==='draw') updateFinalPrompt();   // 模型名变了，上限类型跟着变
  };
  body.querySelector('[data-a="save"]').onclick=doSave;
  body.querySelector('[data-a="use"]').onclick=()=>{doSave();_setActive(preset,type)};
  body.querySelector('[data-a="fetch-models"]').onclick=function(){_fetchPresetModels(preset,body,this)};

  card.append(hdr,meta,body);
  return card;
}

function _setActive(preset,type){
  if(type==='draw') S.curDrawId=preset.id;
  else S.curMasterId=preset.id;
  savePresetsToLS();
  renderDrawPresets();renderMasterPresets();
  if(type==='draw') updateFinalPrompt();   // 换预设=换模型，长度提示要跟着换口径
  toast(`已切换到"${preset.name}" ✓`);
}

// 用预设卡片里当前填的 URL + Key 拉模型列表（不用先保存）
async function _fetchPresetModels(preset,body,btn){
  const rd=f=>body.querySelector(`[data-f="${f}"]`)?.value.trim()||'';
  const key=rd('key'),rawUrl=rd('url');
  if(!rawUrl){toast('先填 URL 再获取模型','warn');return}
  const base=rawUrl.replace(/\/+$/,'');
  const target=/\/v\d+$/.test(base)?`${base}/models`:`${base}/v1/models`;
  const old=btn.textContent;btn.disabled=true;btn.textContent='…';
  toast('⏳ 获取模型列表…');
  try{
    let r=null;
    if(S.localServer){
      // 有本地服务器就走 llm-proxy-get（server-to-server，绕过站子 CORS）
      try{
        r=await fetch(`${S.localServer.replace(/\/+$/,'')}/api/llm-proxy-get?target=${encodeURIComponent(target)}&key=${encodeURIComponent(key)}`);
      }catch(e){console.log(`[${ts()}] 模型列表代理不可达(${e.message})，降级直连`)}
    }
    if(!r) r=await fetch(target,{headers:key?{Authorization:`Bearer ${key}`}:{}});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const d=await r.json();
    const models=(d.data||d.models||[]).map(m=>typeof m==='string'?m:(m.id||m.model||m.name)).filter(Boolean).sort();
    if(!models.length) throw new Error('返回里没有模型');
    console.log(`[${ts()}] 模型列表 ${models.length} 个 | ${target}`);
    _openModelPick(models,m=>{
      const el=body.querySelector('[data-f="model"]');
      if(el) el.value=m;
      toast(`已选模型：${m} ✓`);
    });
  }catch(e){
    console.log(`[${ts()}] 获取模型失败:`,e.message);
    toast(`❌ 获取失败：${e.message}`,'warn');
  }finally{btn.disabled=false;btn.textContent=old}
}

function _openModelPick(models,onPick){
  const ov=document.getElementById('modal-model-pick');
  const list=document.getElementById('model-pick-list');
  const search=document.getElementById('model-pick-search');
  if(!ov||!list) return;
  search.value='';
  const render=q=>{
    const kw=(q||'').toLowerCase();
    const arr=kw?models.filter(m=>m.toLowerCase().includes(kw)):models;
    list.innerHTML='';
    if(!arr.length){
      list.innerHTML='<div style="padding:14px;color:var(--sub);font-size:12px;text-align:center">无匹配结果</div>';
      return;
    }
    arr.slice(0,600).forEach(m=>{
      const d=document.createElement('div');
      d.className='model-pick-item';
      d.textContent=m;
      d.onclick=()=>{onPick(m);ov.style.display='none'};
      list.appendChild(d);
    });
  };
  render('');
  search.oninput=()=>render(search.value);
  ov.style.display='flex';
  setTimeout(()=>{try{search.focus()}catch(e){}},100);
}

function addDrawPreset(){
  const p={id:uid(),name:'新画图预设',key:'',url:'',model:'dall-e-3',format:'images'};
  S.drawPresets.push(p);if(!S.curDrawId) S.curDrawId=p.id;
  savePresetsToLS();renderDrawPresets();
  setTimeout(()=>card_expand(p.id),50);
}
function addMasterPreset(){
  const p={id:uid(),name:'新大师预设',key:'',url:'',model:'claude-opus-4-7'};
  S.masterPresets.push(p);if(!S.curMasterId) S.curMasterId=p.id;
  savePresetsToLS();renderMasterPresets();
  setTimeout(()=>card_expand(p.id),50);
}
function card_expand(pid){
  const all=document.querySelectorAll('.preset-body');
  all.forEach(b=>{if(b.closest('.preset-card')?.querySelector(`[data-pid="${pid}"]`)) b.classList.add('open')});
}

function importFromApp(){
  let added=0;
  try{
    const imgPresets=JSON.parse(localStorage.getItem('xinye_image_presets')||'[]');
    for(const p of imgPresets){
      if(!p.apiKey||!p.baseUrl) continue;
      if(S.drawPresets.find(x=>x.key===p.apiKey&&x.url===p.baseUrl)) continue;
      S.drawPresets.push({id:uid(),name:p.name||'画图预设',key:p.apiKey,url:p.baseUrl,model:p.model||'dall-e-3',format:p.apiFormat||'images'});
      if(!S.curDrawId) S.curDrawId=S.drawPresets[S.drawPresets.length-1].id;
      added++;
    }
  }catch(e){}
  try{
    const apiPresets=JSON.parse(localStorage.getItem('xinye_api_presets')||'[]');
    for(const p of apiPresets){
      if(!p.apiKey) continue;
      if(S.masterPresets.find(x=>x.key===p.apiKey)) continue;
      S.masterPresets.push({id:uid(),name:p.name||'主API',key:p.apiKey,url:p.baseUrl||'',model:p.model||'claude-opus-4-7'});
      if(!S.curMasterId) S.curMasterId=S.masterPresets[S.masterPresets.length-1].id;
      added++;
    }
  }catch(e){}
  if(added){savePresetsToLS();renderDrawPresets();renderMasterPresets();toast(`已导入 ${added} 个预设 ✓`);}
  else toast('未找到主App预设，请先在主App设置里保存预设','warn');
}

async function exportConfig(){
  const personas=await db.all('personas');
  const templates=await db.all('templates');
  const allStyles=await db.all('styles');
  const customStyles=allStyles.filter(s=>s.custom);
  const cfg={
    _v:1,_app:'draw',_date:new Date().toISOString().slice(0,16).replace('T',' '),
    drawPresets:S.drawPresets,curDrawId:S.curDrawId,
    masterPresets:S.masterPresets,curMasterId:S.curMasterId,
    personas,curPersonaId:S.curPersonaId,
    templates,customStyles,
    masterPersona:S.masterPersona||'',   // 同上：它在 localStorage 里，不塞进来就带不走
  };
  const blob=new Blob([JSON.stringify(cfg,null,2)],{type:'application/json'});
  saveBlob(blob,`draw_config_${new Date().toISOString().slice(0,10)}.json`);
  toast('配置已导出 ✓（包含预设/人设/模版，不含图库和词条）');
}

async function importConfig(file){
  try{
    const text=await file.text();
    const cfg=JSON.parse(text);
    if(cfg._app!=='draw') throw new Error('不是画图台的配置文件');
    if(cfg.drawPresets?.length){S.drawPresets=cfg.drawPresets;S.curDrawId=cfg.curDrawId||cfg.drawPresets[0]?.id}
    if(cfg.masterPresets?.length){S.masterPresets=cfg.masterPresets;S.curMasterId=cfg.curMasterId||cfg.masterPresets[0]?.id}
    if(cfg.personas?.length) for(const p of cfg.personas) await db.put('personas',p);
    if(cfg.customStyles?.length) for(const s of cfg.customStyles) await db.put('styles',s);
    if(cfg.templates?.length) for(const t of cfg.templates) await db.put('templates',t);
    if(typeof cfg.masterPersona==='string') localStorage.setItem('draw_masterPersona',cfg.masterPersona);
    savePresetsToLS();
    loadCfg();
    await loadPersonas();
    renderDrawPresets();renderMasterPresets();
    // 同上：loadCfg() 已经读回 S.masterPersona，但设置面板是开着的，输入框得跟着变
    const mpElCfg=document.getElementById('input-master-persona');
    if(mpElCfg) mpElCfg.value=S.masterPersona||'';
    toast(`配置已导入 ✓（${cfg._date||''}）`);
  }catch(e){toast('导入失败：'+e.message,'error')}
}

// ── Full DB Export / Import (跨域迁移) ─────────────────────────
const FULL_STORES=['gallery','styleRefs','tasks','settings','personas','tokens','templates','styles'];

async function exportFullDB(){
  const btn=document.getElementById('btn-export-full');
  if(btn){btn.disabled=true;btn.textContent='⏳ 导出中…'}
  try{
    const meta={_app:'draw-full',_v:1,_date:new Date().toISOString().slice(0,16).replace('T',' '),
      drawPresets:S.drawPresets,curDrawId:S.curDrawId,
      masterPresets:S.masterPresets,curMasterId:S.curMasterId,
      curPersonaId:S.curPersonaId,
      // ⚠️ 大师人设住在 **localStorage**（`draw_masterPersona`），**不在任何 IndexedDB store 里**
      //    —— 所以必须显式塞进 meta，否则「导出全部数据」带不走它（2026-09-29 补）。
      masterPersona:S.masterPersona||'',
    };
    // 用 Blob 数组 + cursor 逐条刷入，避免 getAll() 把整个 gallery 一次性加载到 JS 堆 OOM
    const blobs=[new Blob([JSON.stringify(meta).slice(0,-1)])];
    const counts=[]; let totalSkipped=0;
    for(const store of FULL_STORES){
      blobs.push(new Blob([`,"${store}":[`]));
      let first=true,count=0,skipped=0;
      await new Promise((res,rej)=>{
        const req=db._tx(store).openCursor();
        req.onsuccess=e=>{
          const cur=e.target.result;
          if(!cur) return res();
          // ⚠️ 读不出来的记录（外置图被清）必须在这里接住：异常从 onsuccess 逃走的话，
          //    这个 promise 既不 resolve 也不 reject → 导出永远卡住。
          //    导出是**只读**操作，跳过就行，不动她的库。
          try{
            blobs.push(new Blob([(first?'':',')+JSON.stringify(cur.value)]));
            first=false;count++;
          }catch(err){
            skipped++;
            console.warn(`[导出] ${store} 有一条读不出来，已跳过：`,cur.key,err?.message||err);
          }
          cur.continue();
        };
        req.onerror=e=>rej(e.target.error);
      });
      blobs.push(new Blob([']']));
      if(count) counts.push(`${store}(${count})`);
      if(skipped){counts.push(`${store} 跳过${skipped}条损坏`);totalSkipped+=skipped}
      if(btn) btn.textContent=`⏳ ${store}(${count})…`;
    }
    blobs.push(new Blob(['}']));
    const blob=new Blob(blobs,{type:'application/json'});
    saveBlob(blob,`draw_full_backup_${new Date().toISOString().slice(0,10)}.json`);
    toast(`全部数据已导出 ✓\n${counts.join('、')}${totalSkipped?`\n（有 ${totalSkipped} 条已损坏的记录没导出来）`:''}`);
  }catch(e){toast('导出失败：'+e.message,'error')}
  finally{if(btn){btn.disabled=false;btn.innerHTML='<i class="ic ic-storage"></i> 导出全部数据'}}
}

async function importFullDB(file){
  const statusEl=document.getElementById('import-full-status');
  const showProgress=msg=>{if(statusEl){statusEl.textContent=msg;statusEl.style.display='block'}};
  showProgress('⏳ 开始读取…');
  try{
    const stream=file.stream();
    const reader=stream.getReader();
    const decoder=new TextDecoder();
    let buf='',metaObj=null;
    const counts=[];
    const readChunk=async()=>{const{done,value}=await reader.read();if(done)return false;buf+=decoder.decode(value,{stream:true});return true};
    const firstStoreRe=new RegExp(`,"(${FULL_STORES.join('|')})":\\[`);
    while(!firstStoreRe.test(buf)){if(!await readChunk())break}
    const firstMatch=buf.match(firstStoreRe);
    if(firstMatch){
      const metaStr=buf.slice(0,firstMatch.index)+'}';
      metaObj=JSON.parse(metaStr);
      buf=buf.slice(firstMatch.index);
    }else{
      metaObj=JSON.parse(buf);buf='';
    }
    if(metaObj._app!=='draw-full') throw new Error('不是画图台完整备份文件');
    if(metaObj.drawPresets?.length){S.drawPresets=metaObj.drawPresets;S.curDrawId=metaObj.curDrawId||metaObj.drawPresets[0]?.id}
    if(metaObj.masterPresets?.length){S.masterPresets=metaObj.masterPresets;S.curMasterId=metaObj.curMasterId||metaObj.masterPresets[0]?.id}
    if(metaObj.curPersonaId) S.curPersonaId=metaObj.curPersonaId;
    // 大师人设住在 localStorage 里（见 exportFullDB 的注释）；老备份文件没有这个字段，跳过即可
    if(typeof metaObj.masterPersona==='string'){ localStorage.setItem('draw_masterPersona',metaObj.masterPersona);S.masterPersona=metaObj.masterPersona }
    showProgress('⏳ 预设已读取，开始导入数据…');
    for(const store of FULL_STORES){
      const storeStart=`,"${store}":[`;
      while(!buf.includes(storeStart)){if(!await readChunk())break}
      const si=buf.indexOf(storeStart);
      if(si<0) continue;
      buf=buf.slice(si+storeStart.length);
      let n=0,depth=0,inStr=false,esc=false,objStart=-1,closed=false;
      const processBuffer=async()=>{
        let i=0;
        // 🔴 2026-09-29：**每次重扫前必须把解析状态归零**。
        //    buf 每次都从「未完成记录的起点」开始（见下面收尾逻辑），所以从头扫是安全的；
        //    不归零的话，重扫一遍就多加一次 `{` —— depth 跨 chunk 重复累加、永远回不到 0，
        //    一条记录都解析不出来，buf 还会一路涨到 V8 的字符串上限。
        //    症状：572MB 的备份导入报 `Invalid string length`（手机导出正常、导入必失败）。
        depth=0;inStr=false;esc=false;objStart=-1;closed=false;
        while(i<buf.length){
          const c=buf[i];
          if(esc){esc=false;i++;continue}
          if(c==='\\'){esc=true;i++;continue}
          if(c==='"'){inStr=!inStr;i++;continue}
          if(inStr){i++;continue}
          if(c==='{'){if(depth===0)objStart=i;depth++;i++;continue}
          if(c==='}'){
            depth--;
            if(depth===0&&objStart>=0){
              const json=buf.slice(objStart,i+1);
              const row=JSON.parse(json);
              await db.put(store,row);
              n++;
              if(n%20===0) showProgress(`⏳ ${store} — 已导入 ${n} 条…`);
              objStart=-1;
              buf=buf.slice(i+1);
              i=0;continue;
            }
            i++;continue;
          }
          if(c===']'&&depth===0){buf=buf.slice(i+1);closed=true;break}
          i++;
        }
        // 收尾：切到「未完成记录的起点」。
        // ⚠️ 数组结束(`]`)时**不能清空 buf** —— `]` 后面可能还跟着下一个 store 的数据，
        //    那些字节已经从流里读出来了，清掉就永久丢失（下一个 store 的 `,"xxx":[`
        //    再也找不到 → 一路读到 EOF → buf 又爆）。
        if(closed){ /* 保留 buf，里面是下一个 store 的开头 */ }
        else if(depth>0&&objStart>=0) buf=buf.slice(objStart);
        else buf='';
      };
      await processBuffer();
      let guard=0;
      while(!closed&&(depth>0||!buf.includes(']'))){
        if(!await readChunk())break;
        await processBuffer();
        if(++guard>2000000) throw new Error(`${store} 解析卡住，文件可能已损坏`);
      }
      if(n) counts.push(`${store}(${n})`);
      showProgress(`✅ ${store}(${n}) 完成`);
    }
    reader.cancel();
    savePresetsToLS();
    loadCfg();
    await loadPersonas();
    renderDrawPresets();renderMasterPresets();
    // 🔴 2026-09-29：画风参考和审美档案以前**没有在这里重新加载** ——
    //    数据明明已经进库了，界面上却还是空的，她会以为"根本没导进来"（其实刷新一下就有）。
    S.styleRefs=await db.allSafe('styleRefs',true);
    renderStyleRefList();
    await loadAestheticProfile();
    // 🔴 2026-09-29：大师人设住在 localStorage，导入时已经写进 S.masterPersona 了，
    //    但输入框的 value 是另一回事 —— 不写回去，她打开设置面板会看到空的（以为没导进来）。
    //    跟 openSettings() 里那两行保持同一写法。
    const mpEl=document.getElementById('input-master-persona');
    if(mpEl) mpEl.value=S.masterPersona||'';
    showProgress('');
    if(statusEl) statusEl.style.display='none';
    toast(`全部数据已导入 ✓（${metaObj._date||''}）\n${counts.join('、')}`);
  }catch(e){showProgress('❌ '+e.message);toast('导入失败：'+e.message,'error');console.error(e)}
}

// ── Tab & Modal ───────────────────────────────────────────────
function switchTab(tab){
  document.querySelectorAll('.nav-tab').forEach(el=>el.classList.toggle('active',el.dataset.tab===tab));
  document.querySelectorAll('.tab-pane').forEach(el=>el.classList.toggle('active',el.id===`tab-${tab}`));
  if(tab==='gallery') renderGallery();
  if(tab==='master') setTimeout(()=>{const c=document.getElementById('master-chat');if(c)c.scrollTop=c.scrollHeight;},50);
}
const closeModal=id=>{document.getElementById(id).style.display='none'};
function openLightbox(src){
  const lb=document.getElementById('lightbox');
  document.getElementById('lightbox-img').src=src;
  lb.style.display='flex';
}
document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('lightbox')?.addEventListener('click',()=>{
    const lb=document.getElementById('lightbox');
    lb.style.display='none';
    document.getElementById('lightbox-img').src='';
  });
});

// ── Init ──────────────────────────────────────────────────────
async function loadPersonas(){
  S.personas=await db.all('personas');
  renderSidebar();
  if(S.curPersonaId&&!S.personas.find(p=>p.id===S.curPersonaId)) S.curPersonaId=null;
  if(!S.curPersonaId&&S.personas.length) selectPersona(S.personas[0].id);
  else if(S.curPersonaId) selectPersona(S.curPersonaId);
}

// ── Style Explorer ───────────────────────────────────────────
let _styleFilter='',_styleSubject='',_styleCatCollapsed={},_styleSeeded=false,_editingStyleId=null,_aiPickBusy=false;

// 「适合主体」宽类命中判断（_styleSubject 为空 = 不限）
// ⚠️ 没标主体的**保守显示**，不藏：内置 620 + HD 278 全都标了主体，
//    没标的只有她自己手加的自定义风格。因为缺个字段就让它「消失」太吓人。
function _subjectHit(s){
  if(!_styleSubject) return true;
  const g=SUBJECT_GROUPS.find(x=>x[0]===_styleSubject);
  if(!g) return true;
  const v=(s['适合主体']||'').trim();
  if(!v) return true;
  return g[1].some(k=>v.includes(k));
}

async function seedStyles(){
  if(_styleSeeded) return;
  const ver=await db.getSetting('styles_lib_version',0);
  if(ver>=STYLE_LIB_VER){_styleSeeded=true;return}
  try{
    const resp=await fetch('./assets/style_library.json');
    if(!resp.ok) throw new Error('fetch failed');
    const lib=await resp.json();
    const styles=lib.styles||lib;
    const tx=db.db.transaction('styles','readwrite');
    const store=tx.objectStore('styles');
    for(const s of styles) store.put({...s,builtin:true});
    await new Promise((res,rej)=>{tx.oncomplete=res;tx.onerror=rej});
    await db.setSetting('styles_lib_version',STYLE_LIB_VER);
    _styleSeeded=true;
    toast(`已加载 ${styles.length} 个稀有风格 ✨`);
  }catch(e){console.warn('[styles] 风格库加载失败:',e.message)}
}

// 风格搜索的匹配规则 —— renderStyles() 和 pickStylesWithAI() 共用，**别再各写一份**。
// 🔴 2026-09-28 补 `style_id`：她在大师页被告知「记得手动勾选 —— HD239、RT001」，
//    但这里原先只搜 `中文风格名` / `English prompt tokens` / `适合主体` 三个字段 ——
//    **编号根本搜不到**。搜「239」能出纯属侥幸：HD239 的中文名是
//    「#239 80s赛博朋克OVA赛璐璐」，里面恰好带着 239；而 RT001 的名字是光秃秃的
//    「写实」，所以连「001」都搜不到它。**大师让你按编号去勾，工作台却搜不到编号 —— 死链。**
//    现在：id 直接参与匹配；纯数字再比一次 id 里的数字部分。
function _styleSearchHit(s,q){
  if(!q) return true;
  const name=(s['中文风格名']||'').toLowerCase();
  if(name.includes(q)) return true;
  if((s['English prompt tokens']||'').toLowerCase().includes(q)) return true;
  if((s['适合主体']||'').toLowerCase().includes(q)) return true;
  const id=String(s.style_id||'').toLowerCase();
  if(id.includes(q)) return true;
  if(/^\d+$/.test(q) && (id.match(/\d+/g)||[]).some(n=>n.includes(q))) return true;
  return false;
}

async function renderStyles(search=''){
  const all=await db.all('styles');
  let items=all;
  if(_styleFilter) items=items.filter(s=>s['类别']===_styleFilter);
  if(_styleSubject) items=items.filter(_subjectHit);
  if(search) items=items.filter(s=>_styleSearchHit(s,String(search).trim().toLowerCase()));
  const groups={};
  for(const s of items)(groups[s['类别']]=groups[s['类别']]||[]).push(s);
  const container=document.getElementById('styles-categories');
  container.innerHTML='';
  const order=Object.keys(STYLE_CAT);
  for(const cat of order){
    const styles=groups[cat];
    if(!styles?.length) continue;
    const sec=document.createElement('div');
    sec.className='token-section'+(_styleCatCollapsed[cat]?' collapsed':'');
    const hdr=document.createElement('div');
    hdr.className='token-section-header';
    hdr.innerHTML=`<span>${STYLE_CAT[cat]||cat}</span><span class="token-count">${styles.length}</span>`;
    hdr.onclick=()=>{sec.classList.toggle('collapsed');_styleCatCollapsed[cat]=sec.classList.contains('collapsed')};
    const grid=document.createElement('div');
    grid.className='tokens-grid';
    for(const s of styles){
      const tag=document.createElement('span');
      const sel=S.selStyles.some(x=>x.style_id===s.style_id);
      tag.className='token-tag style-tag'+(sel?' selected':'')+(s.custom?' style-custom':'');
      tag.textContent=s['中文风格名'];
      tag.dataset.sid=s.style_id;
      tag.title=s['English prompt tokens'];
      tag.addEventListener('click',()=>toggleStyle(s));
      tag.addEventListener('mouseenter',e=>showStyleTip(s,e));
      tag.addEventListener('mouseleave',hideStyleTip);
      if(s.custom) tag.addEventListener('contextmenu',e=>{e.preventDefault();openEditStyle(s.style_id)});
      grid.appendChild(tag);
    }
    sec.append(hdr,grid);
    container.appendChild(sec);
  }
  if(!container.children.length){
    const why=[_styleFilter?'类别':null,_styleSubject?'主体':null,search?'搜索':null].filter(Boolean).join(' + ');
    container.innerHTML=why
      ? `<div style="color:var(--sub);font-size:12px;padding:8px 0">当前${why}筛选下没有风格，换个条件或点「全部」</div>`
      : '<div style="color:var(--sub);font-size:12px;padding:8px 0">风格库为空，点击上方 + 自定义 添加</div>';
  }
}

function renderStyleFilters(){
  const _redraw=()=>renderStyles(document.getElementById('style-search-input')?.value||'');
  const row=document.getElementById('style-filter-row');
  row.innerHTML='';
  const mk=(label,cat)=>{
    const btn=document.createElement('span');
    btn.className='token-tag'+(_styleFilter===cat?' selected':'');
    btn.textContent=label;
    btn.onclick=()=>{_styleFilter=(_styleFilter===cat?'':cat);renderStyleFilters();_redraw()};
    row.appendChild(btn);
  };
  mk('全部','');
  for(const [cat,label] of Object.entries(STYLE_CAT)) mk(label,cat);

  // 主体筛选行（2026-09-28 加）。和「类别」是正交的两个维度，可叠加。
  const srow=document.getElementById('style-subject-row');
  if(!srow) return;
  srow.innerHTML='';
  const mkS=(label,sub,tip)=>{
    const btn=document.createElement('span');
    btn.className='token-tag'+(_styleSubject===sub?' selected':'');
    btn.textContent=label;
    if(tip) btn.title=tip;
    btn.onclick=()=>{_styleSubject=(_styleSubject===sub?'':sub);renderStyleFilters();_redraw()};
    srow.appendChild(btn);
  };
  mkS('全部','','不限主体');
  for(const [label,keys] of SUBJECT_GROUPS) mkS(label,label,`只看适合「${label}」的风格（${keys.slice(0,8).join('、')}…）`);
}

function toggleStyle(style){
  const idx=S.selStyles.findIndex(s=>s.style_id===style.style_id);
  if(idx>=0){
    S.selStyles.splice(idx,1);
    document.querySelectorAll(`.style-tag[data-sid="${style.style_id}"]`).forEach(el=>el.classList.remove('selected'));
  }else{
    S.selStyles.push(style);
    document.querySelectorAll(`.style-tag[data-sid="${style.style_id}"]`).forEach(el=>el.classList.add('selected'));
  }
  renderSelectedStyles();
}

function renderSelectedStyles(){
  const area=document.getElementById('selected-styles');
  if(area){
    area.innerHTML='';
    S.selStyles.forEach((s,i)=>{
      const chip=document.createElement('span');
      chip.className='selected-chip';
      // 风格融合开着时，把「第几个 = 什么角色」直接写在 chip 上 ——
      // 否则她得自己数「哪个是第 1 个」，而顺序就是角色/场景的分配依据。
      let badge='';
      if(S.fusionMode){
        if(i===0) badge='<b style="font-weight:700">①角色 </b>';
        else if(i===1) badge='<b style="font-weight:700">②场景 </b>';
        else badge=`<span style="opacity:.6">${i+1}·不用 </span>`;
      }
      chip.innerHTML=`${badge}${s['中文风格名']}<button class="chip-remove" data-sid="${s.style_id}">×</button>`;
      chip.querySelector('.chip-remove').onclick=()=>{
        S.selStyles=S.selStyles.filter(x=>x.style_id!==s.style_id);
        document.querySelectorAll(`.style-tag[data-sid="${s.style_id}"]`).forEach(el=>el.classList.remove('selected'));
        renderSelectedStyles();
      };
      area.appendChild(chip);
    });
  }
  // 折叠时也能看见已选风格（header 小预览，可单个点 × 删除）
  const preview=document.getElementById('styles-selected-preview');
  if(preview){
    preview.innerHTML='';
    if(S.selStyles.length){
      S.selStyles.forEach((s,i)=>{
        const tag=document.createElement('span');
        tag.style.cssText='display:inline-flex;align-items:center;gap:3px;font-size:10px;padding:1px 5px 1px 6px;border-radius:10px;background:var(--purple);color:#fff;white-space:nowrap;max-width:90px';
        const name=document.createElement('span');
        name.style.cssText='overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        name.textContent=(S.fusionMode&&i<2?(i===0?'①':'②'):'')+s['中文风格名'];
        const x=document.createElement('span');
        x.textContent='×';
        x.style.cssText='cursor:pointer;opacity:.7;flex-shrink:0;font-size:11px';
        x.onclick=e=>{
          e.stopPropagation();
          S.selStyles=S.selStyles.filter(y=>y.style_id!==s.style_id);
          document.querySelectorAll(`.style-tag[data-sid="${s.style_id}"]`).forEach(el=>el.classList.remove('selected'));
          renderSelectedStyles();
        };
        tag.append(name,x);
        preview.appendChild(tag);
      });
    }
  }
  updateFinalPrompt();
  renderFusionPanel();
}

// ── 风格融合面板渲染（2026-09-28 加）──────────────────────────
// 三行 chip（情绪 / 留白 / 语言）+ 一行槽位摘要。
// chip 复用画图台现成的 .token-tag / .selected 样式，不新增 CSS。
function renderFusionPanel(){
  const panel=document.getElementById('fusion-panel');
  if(!panel) return;
  const tog=document.getElementById('fusion-toggle');
  if(tog) tog.checked=!!S.fusionMode;
  panel.style.display=S.fusionMode?'':'none';
  if(!S.fusionMode) return;

  const chip=(text,active,onClick,title)=>{
    const el=document.createElement('span');
    el.className='token-tag'+(active?' selected':'');
    el.textContent=text;
    if(title) el.title=title;
    el.onclick=onClick;
    return el;
  };

  // 情绪（15 选 N，可多选、可全不选）
  const mrow=document.getElementById('fusion-mood-row');
  if(mrow){
    mrow.innerHTML='';
    for(const [zhName,enName] of FUSION_MOODS){
      const on=S.fusionMoods.includes(zhName);
      mrow.appendChild(chip(zhName,on,()=>{
        S.fusionMoods=on?S.fusionMoods.filter(x=>x!==zhName):[...S.fusionMoods,zhName];
        saveFusionLS();renderFusionPanel();updateFinalPrompt();
      },enName));
    }
  }
  // 留白（单选，永远有一档选中；默认「正常」= 什么都不加）
  const wrow=document.getElementById('fusion-ws-row');
  if(wrow){
    wrow.innerHTML='';
    for(const [key,label,zhPrompt] of FUSION_WS){
      wrow.appendChild(chip(label,S.fusionWhitespace===key,()=>{
        S.fusionWhitespace=key;saveFusionLS();renderFusionPanel();updateFinalPrompt();
      },zhPrompt||'不加留白提示词'));
    }
  }
  // 语言（结构行 + 共存契约走中文还是英文；风格特征词两种语言下都是英文 tokens）
  const lrow=document.getElementById('fusion-lang-row');
  if(lrow){
    lrow.innerHTML='';
    lrow.appendChild(chip('中文',S.fusionLang!=='en',()=>{
      S.fusionLang='zh';saveFusionLS();renderFusionPanel();updateFinalPrompt();
    },'结构行 + 共存契约用中文'));
    lrow.appendChild(chip('English',S.fusionLang==='en',()=>{
      S.fusionLang='en';saveFusionLS();renderFusionPanel();updateFinalPrompt();
    },'结构行 + 共存契约用英文（风格特征词本来就是英文）'));
  }
  const slots=document.getElementById('fusion-slots');
  if(slots) slots.innerHTML=_fusionSummary();
}

function clearStyles(){
  S.selStyles=[];
  S.mergedStyleIds=[];   // 风格清空了，上一轮的「已糅合」标记作废
  document.querySelectorAll('.style-tag.selected').forEach(el=>el.classList.remove('selected'));
  renderSelectedStyles();
}

async function randomStyles(){
  const all=await db.all('styles');
  if(!all.length){toast('风格库未加载','warn');return}
  // 在当前筛选（类别 + 主体）内随机，没有筛选则全部范围
  let pool=all;
  if(_styleFilter) pool=pool.filter(s=>s['类别']===_styleFilter);
  if(_styleSubject) pool=pool.filter(_subjectHit);
  if(!pool.length){toast('当前筛选下没有风格','warn');return}
  clearStyles();
  const count=1+Math.floor(Math.random()*3);
  const shuffled=[...pool].sort(()=>Math.random()-0.5);
  for(let i=0;i<Math.min(count,shuffled.length);i++) S.selStyles.push(shuffled[i]);
  renderSelectedStyles();
  renderStyles(document.getElementById('style-search-input')?.value||'');
  const scope=[_styleFilter?(STYLE_CAT[_styleFilter]||_styleFilter):'全部',_styleSubject||null].filter(Boolean).join(' · ');
  toast(`🎲 [${scope}] 随机选了 ${S.selStyles.length} 个`);
}

// ── AI 选风格（2026-09-28 加）─────────────────────────────────
// 设计约定（和兔宝确认过）：
//   ① 只「勾风格」，**不改 prompt、不自动出图** —— 出图还是她自己按
//   ② 风格清单**带中文名 + 适合主体 + 特征词摘要**，否则大师光看名字会瞎选
//   ③ 全库 898 条全塞给大师太贵 → 先本地粗筛到 ~60 条，再让大师挑
async function pickStylesWithAI(){
  if(_aiPickBusy) return;
  if(!S.masterPresets.length){toast('请先在设置里添加大师API预设','warn');return}
  const desc=(document.getElementById('user-desc')?.value||'').trim();
  if(!desc){toast('先在上面「想画什么」里写一句','warn');return}

  // 候选池 = 当前筛选（类别 / 主体 / 搜索）后的结果；没筛选就是全库
  let all=await db.all('styles');
  // 🔴 2026-09-28：这个按钮挪出折叠区后，可以「面板从没展开过」就直接点 ——
  //    而风格库的种子逻辑原先挂在展开面板那一步，没展开过库里就是空的，
  //    一点就报「当前筛选下没有风格」，看着像按钮坏了。这里补一次种子。
  if(!all?.length){
    try{ await seedStyles(); all=await db.all('styles') }catch(e){ all=[] }
  }
  let pool=all;
  if(_styleFilter) pool=pool.filter(s=>s['类别']===_styleFilter);
  if(_styleSubject) pool=pool.filter(_subjectHit);
  const q=(document.getElementById('style-search-input')?.value||'').trim().toLowerCase();
  if(q) pool=pool.filter(s=>_styleSearchHit(s,q));
  if(!pool.length){toast('当前筛选下没有风格','warn');return}

  // 本地粗筛：按用户描述里的字，命中「中文风格名 / 适合主体 / 中文特征」的多少排序。
  // 权重刻意不等：名字命中 > 主体命中 > 特征词命中。
  // （理由：中文特征是一大段长文本，等权的话它靠「的/一/个」这种通用字就能刷高分，
  //   把真正相关的短名字挤下去。）
  const LIMIT=120;
  let cand=pool;
  if(pool.length>LIMIT){
    const chars=[...new Set(desc.replace(/[，。、,.!！?？:：\s]/g,'').split(''))].filter(Boolean);
    const score=s=>{
      const name=(s['中文风格名']||'').toLowerCase();
      const subj=(s['适合主体']||'').toLowerCase();
      const feat=(s['中文特征']||'').toLowerCase();
      let n=0;
      for(const ch of chars){
        if(name.includes(ch)) n+=3;
        else if(subj.includes(ch)) n+=2;
        else if(feat.includes(ch)) n+=1;
      }
      return n;
    };
    cand=[...pool].map(s=>({s,n:score(s)})).sort((a,b)=>b.n-a.n).slice(0,LIMIT).map(x=>x.s);
  }

  _aiPickBusy=true;
  const btn=document.getElementById('btn-pick-styles-ai');
  const oldHtml=btn?btn.innerHTML:'';
  if(btn){btn.disabled=true;btn.innerHTML='<i class="ic ic-sparkles"></i> 挑选中...'}
  try{
    const list=cand.map(s=>`${s.style_id} | ${s['中文风格名']} | 适合：${s['适合主体']||'—'} | ${(s['English prompt tokens']||'').slice(0,90)}`).join('\n');
    // 2026-09-28：融合模式下大师的角色变了 —— 不是"挑 2~4 个不冲突的"，
    //   而是"挑一对反差大的搭档"：第 1 个当角色视觉语言、第 2 个当场景视觉语言。
    //   上游风格融合的看点正是**两套视觉语言保持鲜明反差**，所以这里要主动要反差。
    const fusion=S.fusionMode;
    const sys='你是绘画风格顾问。用户会给出想画的内容和一份候选风格清单。'
      +(fusion
        ?'这次要做「风格融合」：请挑**恰好 2 个**风格，且**顺序有意义** —— 第 1 个会用作角色视觉语言、第 2 个用作场景视觉语言。'
          +'两者要反差鲜明（例如一个简笔涂鸦 × 一个写实质感），但放进同一个画面里不违和。'
        :'从中挑 2~4 个最合适、且彼此不冲突的风格（冲突的例子：一个要厚涂一个要平涂、一个写实一个极简）。')
      +'只输出一个 JSON 数组，元素必须来自候选清单里的 style_id，不要解释、不要 markdown 代码块。'
      +'例：["HD032","M012"]';
    const user='想画的内容：'+desc
      +(S.aestheticProfile?'\n\n用户审美偏好：\n'+S.aestheticProfile:'')
      +'\n\n候选风格（共 '+cand.length+' 条）：\n'+list;
    const reply=await callMaster([{role:'system',content:sys},{role:'user',content:user}]);
    const ids=reply.match(/[A-Z]{1,3}\d{2,4}/g)||[];
    const picked=[];
    const cap=fusion?2:Infinity;
    for(const id of ids){
      const s=cand.find(x=>x.style_id===id);
      if(s&&!picked.some(x=>x.style_id===id)){
        picked.push(s);
        if(picked.length>=cap) break;
      }
    }
    if(!picked.length){toast('大师没挑出有效风格，再试一次？','warn');return}
    if(fusion&&picked.length<2){toast(`大师只挑出 ${picked.length} 个，融合需要 2 个 —— 再点一次或手动补一个`,'warn')}
    clearStyles();
    for(const s of picked) toggleStyle(s);
    renderStyles(document.getElementById('style-search-input')?.value||'');
    if(fusion){
      toast(`✦ 融合搭档：①角色 ${picked[0]['中文风格名']}${picked[1]?' × ②场景 '+picked[1]['中文风格名']:''}`);
    }else{
      toast(`✦ AI 选了 ${picked.length} 个：${picked.map(s=>s['中文风格名']).join('、')}`);
    }
  }catch(e){
    console.error('[AI选风格]',e);
    toast('AI 选风格失败：'+e.message,'error');
  }finally{
    _aiPickBusy=false;
    if(btn){btn.disabled=false;btn.innerHTML=oldHtml}
  }
}

function showStyleTip(style,event){
  const tip=document.getElementById('style-tooltip');
  if(!tip) return;
  const tokens=style['English prompt tokens']||'';
  const strength=style['建议强度']||'—';
  const role=style['组合角色']||'';
  const subjects=style['适合主体']||'—';
  const risk=style['容易翻车']||'';
  const rescue=style['补救提示']||'';
  tip.innerHTML=`<div style="font-weight:600;margin-bottom:4px">${style['中文风格名']}</div>`
    +`<div style="color:var(--teal);font-size:12px;margin-bottom:4px;word-break:break-all">${tokens}</div>`
    +`<div style="font-size:11px;color:var(--sub)">强度 ${strength}${role?' · '+role:''}</div>`
    +`<div style="font-size:11px;color:var(--sub)">适合: ${subjects}</div>`
    +(risk?`<div style="font-size:11px;color:var(--warn);margin-top:4px"><i class="ic ic-alert"></i> ${risk}</div>`:'')
    +(rescue?`<div style="font-size:11px;color:var(--teal);margin-top:2px"><i class="ic ic-zap"></i> ${rescue}</div>`:'');
  tip.style.display='block';
  const rect=event.target.getBoundingClientRect();
  const left=Math.min(rect.left,window.innerWidth-310);
  const top=rect.bottom+6;
  tip.style.left=left+'px';
  tip.style.top=(top+300>window.innerHeight?rect.top-tip.offsetHeight-6:top)+'px';
}
function hideStyleTip(){const tip=document.getElementById('style-tooltip');if(tip)tip.style.display='none'}

function openAddStyle(){
  _editingStyleId=null;
  document.getElementById('modal-style-title').textContent='添加自定义风格';
  document.getElementById('style-name-input').value='';
  document.getElementById('style-tokens-input').value='';
  document.getElementById('style-category-select').value='材质与表面质感';
  document.getElementById('style-subject-input').value='';
  document.getElementById('style-risk-input').value='';
  document.getElementById('style-rescue-input').value='';
  document.getElementById('btn-delete-style').style.display='none';
  document.getElementById('modal-style').style.display='flex';
}

async function openEditStyle(styleId){
  const s=await db.get('styles',styleId);
  if(!s||s.builtin) return;
  _editingStyleId=styleId;
  document.getElementById('modal-style-title').textContent='编辑自定义风格';
  document.getElementById('style-name-input').value=s['中文风格名']||'';
  document.getElementById('style-tokens-input').value=s['English prompt tokens']||'';
  document.getElementById('style-category-select').value=s['类别']||'材质与表面质感';
  document.getElementById('style-subject-input').value=s['适合主体']||'';
  document.getElementById('style-risk-input').value=s['容易翻车']||'';
  document.getElementById('style-rescue-input').value=s['补救提示']||'';
  document.getElementById('btn-delete-style').style.display='';
  document.getElementById('modal-style').style.display='flex';
}

async function saveStyle(){
  const name=document.getElementById('style-name-input').value.trim();
  const tokens=document.getElementById('style-tokens-input').value.trim();
  if(!name||!tokens){toast('请填写风格名和英文词条','warn');return}
  const obj={
    style_id:_editingStyleId||'custom_'+uid(),
    '中文风格名':name,'English prompt tokens':tokens,
    '类别':document.getElementById('style-category-select').value,
    '适合主体':document.getElementById('style-subject-input').value.trim(),
    '容易翻车':document.getElementById('style-risk-input').value.trim(),
    '补救提示':document.getElementById('style-rescue-input').value.trim(),
    builtin:false,custom:true,createdAt:Date.now()
  };
  await db.put('styles',obj);
  const wasSelected=S.selStyles.findIndex(s=>s.style_id===obj.style_id);
  if(wasSelected>=0) S.selStyles[wasSelected]=obj;
  closeModal('modal-style');
  renderStyles(document.getElementById('style-search-input')?.value||'');
  renderSelectedStyles();
  toast(_editingStyleId?'风格已更新 ✓':'自定义风格已添加 ✨');
}

async function deleteStyle(){
  if(!_editingStyleId) return;
  if(!confirm('确定删除这个自定义风格？')) return;
  await db.del('styles',_editingStyleId);
  S.selStyles=S.selStyles.filter(s=>s.style_id!==_editingStyleId);
  renderSelectedStyles();
  closeModal('modal-style');
  renderStyles(document.getElementById('style-search-input')?.value||'');
  toast('风格已删除');
}

function bindEvents(){
  // 底栏角落显示当前这份代码的版本号。看到它没变 = 浏览器还在吃旧缓存，
  // 不是「推了没生效」—— 见文件顶部 DRAW_VER 的注释。
  const _verEl=document.getElementById('draw-version');
  if(_verEl) _verEl.textContent=DRAW_VER;
  document.querySelectorAll('.nav-tab').forEach(btn=>btn.addEventListener('click',()=>switchTab(btn.dataset.tab)));
  document.getElementById('btn-new-persona').onclick=()=>openPersonaModal();
  document.getElementById('btn-edit-persona-quick').onclick=()=>openPersonaModal(S.curPersonaId);
  document.getElementById('btn-save-persona').onclick=savePersona;
  document.getElementById('btn-delete-persona').onclick=deletePersona;
  document.getElementById('btn-cancel-persona').onclick=()=>closeModal('modal-persona');
  document.getElementById('btn-manage-chars').onclick=openCharModal;
  document.getElementById('btn-save-char').onclick=saveChar;
  document.getElementById('btn-cancel-char-edit').onclick=()=>{
    editingCharId=null;editingCharRefB64=null;
    document.getElementById('char-form-title').textContent='添加角色';
    document.getElementById('char-name-input').value='';
    document.getElementById('char-prompt-input').value='';
    document.getElementById('char-ref-preview').innerHTML='<i class="ic ic-image"></i>';
    document.getElementById('btn-cancel-char-edit').style.display='none';
  };
  document.getElementById('btn-pick-char-ref').onclick=()=>document.getElementById('char-ref-input').click();
  document.getElementById('btn-clear-char-ref').onclick=()=>{
    editingCharRefB64=null;
    document.getElementById('char-ref-preview').innerHTML='<i class="ic ic-image"></i>';
  };
  document.getElementById('char-ref-input').onchange=async e=>{
    const f=e.target.files[0];if(!f) return;
    editingCharRefB64=await f2b(f);
    document.getElementById('char-ref-preview').innerHTML=`<img src="${editingCharRefB64}" style="width:100%;height:100%;object-fit:cover;border-radius:var(--rs)">`;
    e.target.value='';
  };
  document.getElementById('btn-close-chars').onclick=()=>closeModal('modal-chars');
  document.getElementById('btn-ai-gen').onclick=generatePromptWithAI;
  // 手改画图 Prompt 时也要刷新长度提示（不然只有勾风格才会更新）
  document.getElementById('final-prompt-edit').addEventListener('input',updateFinalPrompt);
  // 折叠/展开风格面板 —— 抽成函数，因为「搜索框常驻」之后有两个入口要复用它
  // （点标题展开 + 一敲字就自动展开）。
  const _setStylesOpen=async(open)=>{
    const col=document.getElementById('styles-collapsible');
    const icon=document.getElementById('styles-toggle-icon');
    col.style.display=open?'':'none';
    icon.textContent=open?'▼':'▶';
    if(open){
      // seedStyles() 的闸门是版本号，_styleSeeded 之后会直接 return，重复调是安全的
      try{ await seedStyles() }catch(e){}
      renderStyleFilters();
      renderStyles(document.getElementById('style-search-input')?.value||'');
    }
  };
  document.getElementById('styles-toggle-hdr').onclick=async()=>{
    await _setStylesOpen(document.getElementById('styles-collapsible').style.display==='none');
  };
  // 🔴 2026-09-28：搜索框挪到折叠区**外面**常驻（她：「每次都要先点开折叠块才能看见」）。
  //    代价是"折叠着敲字"这件事现在存在了 —— 而结果渲染在折叠块里，
  //    她敲了字会什么都看不见。所以：**有输入就自动展开**。
  //    另外她可能从没展开过面板，这时库里还是空的（seedStyles 原本只挂在展开那一步），
  //    所以这里也补一次种子兜底。
  document.getElementById('style-search-input').oninput=async e=>{
    const q=e.target.value;
    if(!_styleSeeded){ try{ await seedStyles() }catch(_){} }
    if(q.trim() && document.getElementById('styles-collapsible').style.display==='none'){
      await _setStylesOpen(true);
      return;   // _setStylesOpen(true) 里已经带着当前关键词渲染过了，不用再渲染一次
    }
    renderStyles(q);
  };
  // 风格融合（2026-09-28）：开关一拨就立刻重算 prompt 与面板。
  // 关掉时 renderFusionPanel 会把面板藏起来，buildPrompt 也回到老分支。
  document.getElementById('fusion-toggle').onchange=e=>{
    S.fusionMode=e.target.checked;
    saveFusionLS();
    renderFusionPanel();
    renderSelectedStyles();   // 重画 chips（角色/场景标记要跟着开关走）
    updateFinalPrompt();
  };
  // 主题/画幅变了，融合槽位摘要要跟着变
  document.getElementById('user-desc').addEventListener('input',()=>{if(S.fusionMode) updateFinalPrompt()});
  document.getElementById('param-size').addEventListener('change',()=>{if(S.fusionMode) updateFinalPrompt()});
  document.getElementById('btn-save-style').onclick=saveStyle;
  document.getElementById('btn-delete-style').onclick=deleteStyle;
  document.getElementById('btn-cancel-style').onclick=()=>closeModal('modal-style');
  document.getElementById('btn-copy-prompt').onclick=()=>navigator.clipboard.writeText(buildPrompt()).then(()=>toast('已复制'));
  // 「清空」按钮（2026-09-29 加）—— 画图 Prompt 里常常是一整段 AI 生成的长 prompt，
  //   重新生成要再花一次额度，所以**有内容时先确认**；本来就是空的点了什么都不做。
  //   ⚠️ 清空时必须一并作废 S.mergedStyleIds：那份 base 已经没了，
  //      再跳过这批风格的 tokens 就是错的（跟 clearStyles() / 载入模板 / 图库详情载入同一道理）。
  document.getElementById('btn-clear-prompt').onclick=()=>{
    const ta=document.getElementById('final-prompt-edit');
    if(!ta.value.trim()) return;
    if(!confirm('清空「画图 Prompt」？里面的内容会删掉（AI 生成的那段要重新生成才有）。')) return;
    ta.value='';
    S.mergedStyleIds=[];
    updateFinalPrompt();
    toast('已清空画图 Prompt');
  };
  // 「想画什么」是她自己写的一句话，清掉不心疼，不弹确认；
  //   重算条件跟上面那个 input 监听器保持一致（只有融合模式才需要）。
  document.getElementById('btn-clear-desc').onclick=()=>{
    const ta=document.getElementById('user-desc');
    if(!ta.value) return;
    ta.value='';
    if(S.fusionMode) updateFinalPrompt();
    toast('已清空');
  };
  document.getElementById('btn-save-template').onclick=saveTemplate;
  document.getElementById('btn-load-template').onclick=openTemplates;
  document.getElementById('btn-close-templates').onclick=()=>closeModal('modal-templates');
  document.getElementById('btn-pick-ref').onclick=()=>document.getElementById('ref-image-input').click();
  document.getElementById('ref-image-input').onchange=async e=>{
    const files=[...e.target.files];if(!files.length) return;
    for(const f of files) S.customRefB64s.push(await f2b(f));
    e.target.value='';
    renderRefArea();
  };
  document.getElementById('btn-clear-ref').onclick=()=>{
    S.selRefCharIds=[];S.customRefB64s=[];
    document.getElementById('ref-image-input').value='';
    renderRefArea();
  };
  document.getElementById('btn-draw').onclick=doDraw;
  document.getElementById('btn-clear-tasks').onclick=async()=>{
    if(!confirm('清空所有生成记录？')) return;
    const tasks=await db.all('tasks');
    for(const t of tasks) db.del('tasks',t.id);
    document.getElementById('draw-results').innerHTML='';
    _updateClearBtn();
  };
  ['filter-persona','filter-rating','filter-tag'].forEach(id=>{
    const el=document.getElementById(id);
    el.addEventListener(el.tagName==='INPUT'?'input':'change',renderGallery);
  });
  document.getElementById('btn-gallery-import').onclick=openGalleryImport;
  document.getElementById('btn-confirm-gallery-import').onclick=confirmGalleryImport;
  document.getElementById('btn-cancel-gallery-import').onclick=()=>closeModal('modal-gallery-import');
  document.getElementById('btn-close-detail').onclick=()=>closeModal('modal-detail');
  document.getElementById('btn-use-prompt').onclick=useDetailPrompt;
  document.getElementById('btn-add-tag').onclick=addDetailTag;
  document.getElementById('btn-download-detail').onclick=()=>{if(S.curDetail) dlImg(S.curDetail.imageData)};
  document.getElementById('btn-delete-image').onclick=deleteDetail;
  document.getElementById('btn-save-detail-prompt').onclick=saveDetailPrompt;
  // 只绑正向（负向那一栏 2026-09-28 已删；写死成数组遍历的话，
  // getElementById 会返回 null，.oninput 直接抛，后面的绑定全不执行）
  document.getElementById('detail-prompt').oninput=()=>{
    document.getElementById('btn-save-detail-prompt').style.display='';
  };
  document.getElementById('btn-style-ref-manage').onclick=openStyleRefModal;
  document.getElementById('btn-style-ref-clear').onclick=()=>{
    S.curStyleRefId=null;renderStyleRefStrip();
  };
  document.getElementById('btn-save-style-ref').onclick=confirmSaveStyleRef;
  document.getElementById('new-style-ref-input').onchange=async e=>{
    const files=[...e.target.files].slice(0,3);
    if(!files.length) return;
    const added=[];
    for(const f of files) added.push(await f2b(f));
    e.target.value='';
    _pendingStyleRefB64s=(_pendingStyleRefB64s||[]).concat(added).slice(0,3);
    renderNewStyleRefPreview();
  };
  document.getElementById('btn-settings').onclick=openSettings;
  document.getElementById('btn-close-settings').onclick=()=>closeModal('modal-settings');
  document.getElementById('btn-close-model-pick').onclick=()=>closeModal('modal-model-pick');
  document.getElementById('btn-save-local-server').onclick=()=>{
    const v=(document.getElementById('input-local-server').value||'').trim().replace(/\/$/,'');
    localStorage.setItem('draw_localServer',v);S.localServer=v;toast(v?`已保存：${v}`:'已清除本地服务器地址');
  };
  document.getElementById('btn-save-master-persona').onclick=()=>{
    const v=(document.getElementById('input-master-persona').value||'').trim();
    localStorage.setItem('draw_masterPersona',v);S.masterPersona=v;toast(v?'人设已保存 ✓':'人设已清除');
  };
  document.getElementById('btn-import-settings').onclick=importFromApp;
  document.getElementById('btn-export-config').onclick=exportConfig;
  document.getElementById('input-import-config').onchange=e=>{const f=e.target.files[0];if(f){importConfig(f);e.target.value=''}};
  document.getElementById('btn-export-full').onclick=exportFullDB;
  document.getElementById('input-import-full').onchange=e=>{const f=e.target.files[0];if(f){importFullDB(f);e.target.value=''}};
  document.getElementById('btn-add-draw-preset').onclick=addDrawPreset;
  document.getElementById('btn-add-master-preset').onclick=addMasterPreset;
  document.getElementById('btn-clear-master-chat').onclick=()=>{
    if(confirm('清空大师对话？')) {
      document.getElementById('master-chat').innerHTML='';
      S.masterHistory=[];
      db.setSetting('masterHistory',[]);
      S.masterLastImg=null;S.masterPendingImgs=[];
      db.setSetting('masterLastImg',null);
      _renderMasterImgPreview();
    }
  };
  document.getElementById('master-insight-card').querySelector('.insight-header').onclick=e=>{
    if(e.target.closest('button')) return;
    document.getElementById('master-insight-card').classList.toggle('open');
  };
  document.getElementById('btn-analyze').onclick=async()=>{
    const btn=document.getElementById('btn-analyze');
    btn.disabled=true;btn.textContent='分析中...';
    try{await analyzePreference()}catch(e){toast(e.message,'error')}
    finally{btn.disabled=false;btn.textContent='分析我的偏好'}
  };
  document.getElementById('btn-analyze-aesthetic').onclick=async()=>{
    const btn=document.getElementById('btn-analyze-aesthetic');
    btn.disabled=true;btn.textContent='分析中...';
    try{await analyzePreference();switchTab('master')}catch(e){toast(e.message,'error')}
    finally{btn.disabled=false;btn.innerHTML='<i class="ic ic-sparkles"></i> 分析偏好'}
  };
  document.getElementById('btn-master-send').onclick=async()=>{
    const input=document.getElementById('master-input');
    const text=input.value.trim();
    if(!text||S.masterBusy) return;
    S.masterBusy=true;input.value='';
    const imgs=S.masterPendingImgs.length?[...S.masterPendingImgs]:null;
    addMasterMsg('user',text,false,imgs);
    const tmp=addMasterMsg('assistant','思考中...✨',true);
    try{const r=await masterSuggest(text);tmp.remove();addMasterMsg('assistant',r)}
    catch(e){tmp.remove();addMasterMsg('assistant','出错了：'+e.message)}
    finally{S.masterBusy=false}
  };
  document.getElementById('btn-inspire').onclick=()=>{
    const input=document.getElementById('master-input');
    input.value=_rollInspireDice();
    input.focus();
    toast(_inspireNsfwMode?'🔓 春宫骰子已填入':'🎲 已填入，可编辑后发送');
  };
  document.getElementById('btn-inspire-nsfw').onclick=()=>{
    _inspireNsfwMode=!_inspireNsfwMode;
    const btn=document.getElementById('btn-inspire-nsfw');
    btn.innerHTML=_inspireNsfwMode?'<i class="ic ic-unlock"></i>':'<i class="ic ic-lock"></i>';
    btn.title=_inspireNsfwMode?'春宫模式 ON — 再点关闭':'点击开启春宫模式';
    toast(_inspireNsfwMode?'🔓 春宫模式已开启':'🔒 已切回普通模式');
  };
  document.getElementById('master-input').onkeydown=e=>{
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();document.getElementById('btn-master-send').click()}
  };
  document.getElementById('master-input').addEventListener('paste',async e=>{
    const fromItems=Array.from(e.clipboardData.items).filter(i=>i.kind==='file'&&i.type.startsWith('image/')).map(i=>i.getAsFile()).filter(Boolean);
    const fromFiles=Array.from(e.clipboardData.files).filter(f=>f.type.startsWith('image/'));
    const files=fromItems.length?fromItems:fromFiles;
    if(!files.length) return;
    e.preventDefault();
    for(const file of files){
      if(S.masterPendingImgs.length>=5) break;
      const b64=await new Promise(res=>{const r=new FileReader();r.onload=ev=>_shrinkImg(ev.target.result,800,0.8).then(res);r.readAsDataURL(file)});
      S.masterPendingImgs.push(b64);
    }
    _renderMasterImgPreview();
  });
  document.getElementById('btn-master-img').onclick=()=>document.getElementById('master-img-input').click();
  document.getElementById('master-img-input').onchange=async e=>{
    const files=Array.from(e.target.files);if(!files.length) return;
    e.target.value='';
    for(const f of files){
      if(S.masterPendingImgs.length>=5) break;
      const b64=await new Promise(res=>{const r=new FileReader();r.onload=ev=>_shrinkImg(ev.target.result,800,0.8).then(res);r.readAsDataURL(f)});
      S.masterPendingImgs.push(b64);
    }
    _renderMasterImgPreview();
  };
  document.querySelectorAll('.modal-overlay').forEach(o=>o.addEventListener('click',e=>{if(e.target===o) o.style.display='none'}));
}

function _updateClearBtn(){
  const btn=document.getElementById('btn-clear-tasks');
  if(!btn) return;
  const hasTasks=document.getElementById('draw-results').children.length>0;
  btn.style.display=hasTasks?'':'none';
}

// 把字符串安全地塞进 innerHTML。只用于「从 DB 读回来、每次开页面都会重新注入」的文本（如失败原因）——
// 它跟 `_runDrawTask` 里那条一次性的错误提示不同：那条只在当前页面存活，这条会长期留在库里反复渲染。
const escHtml=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

async function restoreTaskCards(){
  const tasks=await db.all('tasks');
  if(!tasks.length) return;
  tasks.sort((a,b)=>b.createdAt-a.createdAt);
  const res=document.getElementById('draw-results');
  for(const t of tasks){
    const taskWrap=document.createElement('div');
    taskWrap.className='draw-task';
    taskWrap.dataset.taskId=t.id;
    const promptShort=t.prompt.length>100?t.prompt.slice(0,100)+'…':t.prompt;
    const labelText=t.tplName?`<i class="ic ic-file-text"></i> ${t.tplName} · ${t.n}张 · ${t.size}`:`<i class="ic ic-palette"></i> ${t.n}张 · ${t.size}`;
    const styleLabel=t.styles&&t.styles.length?`<span class="draw-task-styles">${t.styles.map(s=>'<i class="ic ic-palette"></i>'+s.name).join(' ')}</span>`:'';
    const styleRefLabel=t.styleRefName?`<span class="draw-task-styles"><i class="ic ic-image"></i> ${t.styleRefName}</span>`:'';
    // 2026-09-28：失败卡片现在也会入库（images 为空 + error），恢复时要能显示出来。
    //   ⚠️ t.images 必须用 (t.images||[]) 兜底：旧记录 / 脏记录缺这个字段时，
    //   原来的 `t.images.length` 会直接抛，一抛整个 restoreTaskCards 就中断 ——
    //   结果是「所有任务卡一起消失」，而不是只少一张。
    const imgList=(t.images||[]).filter(Boolean);
    const failCount=t.failCount||0;
    // ⚠️ 状态文案必须**短**、且和 `_runDrawTask` 里实时那套**逐字一致**。
    //    `.draw-task-status` 是 `flex:1`（flex-basis:0），375px 下头部那行挤满时它会被压到约
    //    一字符宽、逐字竖排 —— 这是改前就有的老毛病（"2张完成"同样被压成 5 行）。
    //    所以这里刻意不写 "✓2张 / ✗1张失败" 那种长句（那会到 14 行），只留同量级的短文案。
    const statusHtml=imgList.length
      ? (failCount>0
          ? `<span class="draw-task-status" style="color:var(--err)">${failCount}张失败</span>`
          : `<span class="draw-task-status"><i class="ic ic-check"></i> ${imgList.length}张完成</span>`)
      : `<span class="draw-task-status" style="color:var(--err)">全部失败</span>`;
    taskWrap.innerHTML=`<div class="draw-task-header">
      <div class="draw-task-top">
        <span class="draw-task-label">${labelText}</span>
        ${styleLabel}${styleRefLabel}
        ${statusHtml}
        <div class="draw-task-btns">
          <button class="draw-task-reroll" title="用同样的prompt重roll"><i class="ic ic-refresh"></i> 重roll</button>
          <button class="draw-task-copy" title="复制完整prompt"><i class="ic ic-clipboard"></i></button>
          <button class="draw-task-del" title="删除此卡片"><i class="ic ic-x"></i></button>
        </div>
      </div>
      <div class="draw-task-prompt" title="点击展开完整 prompt">${promptShort}</div>
    </div><div class="draw-task-body"></div>`;
    const body=taskWrap.querySelector('.draw-task-body');
    // 一张图都没有 = 上次全失败。把失败原因显示出来（escHtml：这是从 DB 读回来、
    // 每次开页面都会重新注入 innerHTML 的内容，不能当纯文本塞）。
    if(!imgList.length){
      body.innerHTML=`<div class="error-msg"><i class="ic ic-x-circle"></i> ${escHtml(t.error||'上次没画出来，可点「重roll」再试')}</div>`;
    }
    for(const imgData of imgList){
      const wrap=document.createElement('div');wrap.className='result-image-wrapper';
      const img=document.createElement('img');img.src=imgData;img.className='result-image';img.style.cursor='zoom-in';
      img.onclick=()=>openLightbox(imgData);
      const acts=document.createElement('div');acts.className='result-actions';
      const bSave=document.createElement('button');bSave.className='btn-primary btn-sm';bSave.textContent='存图库';
      bSave.onclick=()=>{saveToGallery(imgData,t.prompt,t.size,t.styles);bSave.textContent='已存 ✓';bSave.style.pointerEvents='none'};
      const bDl=document.createElement('button');bDl.className='btn-sm btn-primary';bDl.textContent='已下载 ✓';bDl.style.pointerEvents='none';
      acts.append(bSave,bDl);wrap.append(img,acts);body.appendChild(wrap);
    }
    const promptEl=taskWrap.querySelector('.draw-task-prompt');
    let expanded=false;
    promptEl.onclick=()=>{expanded=!expanded;promptEl.textContent=expanded?(t.fullPrompt||t.prompt):promptShort;promptEl.style.webkitLineClamp=expanded?'unset':'2'};
    taskWrap.querySelector('.draw-task-del').onclick=()=>{taskWrap.remove();db.del('tasks',t.id);_updateClearBtn()};
    taskWrap.querySelector('.draw-task-copy').onclick=()=>navigator.clipboard.writeText(t.fullPrompt||t.prompt).then(()=>toast('Prompt已复制 ✓'));
    taskWrap.querySelector('.draw-task-reroll').onclick=()=>{
      const existingEdit=taskWrap.querySelector('.draw-task-edit');
      if(existingEdit){existingEdit.remove();return;}
      const srOpts=S.styleRefs.map(sr=>`<option value="${sr.id}">${sr.name}</option>`).join('');
      const activeId=S.styleRefs.find(r=>r.name===t.styleRefName)?.id||'';
      const editDiv=document.createElement('div');
      editDiv.className='draw-task-edit';
      editDiv.innerHTML=`
        <div class="dte-row"><label>Prompt</label><textarea class="dte-pos" rows="3">${t.prompt}</textarea></div>
        <div class="dte-row"><label>画风参考</label><select class="dte-styleref"><option value="">无</option>${srOpts}</select></div>
        <div class="dte-actions">
          <label class="dte-count-label">张数<input class="dte-count" type="number" min="1" max="20" value="${t.n}"></label>
          <button class="btn-primary btn-sm dte-confirm"><i class="ic ic-refresh"></i> 确认重roll</button>
          <button class="btn-sm btn-outline dte-cancel">取消</button>
        </div>`;
      taskWrap.querySelector('.draw-task-header').after(editDiv);
      editDiv.querySelector('.dte-styleref').value=activeId;
      editDiv.querySelector('.dte-cancel').onclick=()=>editDiv.remove();
      editDiv.querySelector('.dte-confirm').onclick=()=>{
        const newPrompt=editDiv.querySelector('.dte-pos').value.trim();
        const newN=Math.max(1,Math.min(20,parseInt(editDiv.querySelector('.dte-count').value)||1));
        const newSrId=editDiv.querySelector('.dte-styleref').value;
        const oldSrImages=(S.styleRefs.find(r=>r.name===t.styleRefName)?.images)||[];
        const baseRefs=(t.refs||[]).filter(r=>!oldSrImages.includes(r));
        const newSr=S.styleRefs.find(r=>r.id===newSrId);
        const newRefs=newSr?[...baseRefs,...newSr.images]:baseRefs;
        editDiv.remove();
        _runDrawTask(newPrompt||t.prompt,t.size,newN,newRefs,taskWrap,null,t.styles,newSr?.name||null);
      };
      editDiv.querySelector('.dte-pos').focus();
    };
    res.appendChild(taskWrap);
  }
  _updateClearBtn();
}

// 主 APP 从备份恢复时，会把画图台的数据一起补回来（backup.js 的 restoreDrawData）。
// 那边导完紧接着 location.reload()，toast 留不住，所以走 localStorage 捎过来，在这里弹一次。
// 2026-09-28：在这之前画图台的数据是**只进备份、出不来**的，这个提示是配套的交代 ——
// 不弹的话她会以为「图库回来了但缩略图全空 = 坏了」，其实是图片本来就不在自动备份里。
function showDrawRestoreNotice(){
  let raw=null;
  try{ raw=localStorage.getItem('drawRestoreNotice'); }catch{ return; }
  if(!raw) return;
  // 先删再弹：万一 toast 本身抛了，也不会变成一个每次开页面都弹的提示
  try{ localStorage.removeItem('drawRestoreNotice'); }catch{}
  let n=null; try{ n=JSON.parse(raw); }catch{}
  if(!n||!Array.isArray(n.parts)||!n.parts.length) return;
  if(n.at&&Date.now()-n.at>2*86400000) return;   // 放太久的陈年提示就别突然冒出来了
  toast('从备份恢复：'+n.parts.join('；'),'warn',7000);
}

async function init(){
  // 每一步独立容错：本地数据坏一格（比如昨天清 Edge 缓存留下的半个 IndexedDB/LocalStorage），
  // 不该让整页变成空白 + 点不动。bindEvents 一定要跑到，那是"点得动"的前提。
  const step=async(n,fn)=>{ try{ await fn(); }catch(e){ console.error('[draw init] '+n+' 失败：',e); } };
  await step('db.open',()=>Promise.race([
    db.open(),
    new Promise((_,rej)=>setTimeout(()=>rej(new Error('打开数据库超时')),6000))
  ]));
  await step('loadCfg',()=>loadCfg());
  await step('loadPersonas',()=>loadPersonas());
  await step('loadCharacters',()=>loadCharacters());
  await step('loadAestheticProfile',()=>loadAestheticProfile());
  await step('loadStyleRefs',()=>loadStyleRefs());
  await step('bindEvents',()=>bindEvents());
  // 风格融合面板：把上次记住的开关/情绪/留白/语言恢复成 UI（loadCfg 只读了内存态）
  await step('renderFusionPanel',()=>renderFusionPanel());
  // 幂等补种「写实」风格 —— 必须**独立于** seedStyles() 的版本闸门，理由见 REALISTIC_STYLE 注释。
  // 放在 renderFusionPanel 之后：它只写库，不渲染，所以顺序上不影响任何面板。
  await step('seedRealisticStyle',()=>seedRealisticStyle());
  await step('renderStyleRefStrip',()=>renderStyleRefStrip());
  await step('restoreTaskCards',()=>restoreTaskCards());
  await step('restoreNotice',()=>showDrawRestoreNotice());
}
init().catch(console.error);

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
  _tx(s,m='readonly'){return this.db.transaction(s,m).objectStore(s)}
  _p(r){return new Promise((res,rej)=>{r.onsuccess=e=>res(e.target.result);r.onerror=e=>rej(e.target.error)})}
  all(s){return this._p(this._tx(s).getAll())}
  get(s,k){return this._p(this._tx(s).get(k))}
  put(s,o){return this._p(this._tx(s,'readwrite').put(o))}
  del(s,k){return this._p(this._tx(s,'readwrite').delete(k))}
  galleryMeta(){return new Promise((res,rej)=>{const items=[];const req=this._tx('gallery').openCursor();req.onsuccess=e=>{const cursor=e.target.result;if(cursor){const {imageData,...meta}=cursor.value;items.push(meta);cursor.continue();}else res(items);};req.onerror=e=>rej(e.target.error);});}
  async getSetting(k,def=null){const r=await this.get('settings',k);return r?r.value:def}
  setSetting(k,v){return this.put('settings',{key:k,value:v})}
  async tokensByCategory(){
    const all=await this.all('tokens');
    const m={};
    for(const t of all){(m[t.category]=m[t.category]||[]).push(t)}
    return m;
  }
}

// ── State ────────────────────────────────────────────────────
const db=new DrawDB();
const S={
  personas:[],curPersonaId:null,
  characters:[],selCharIds:[],
  aestheticProfile:'',lastAnalyzedIds:[],allAnalyzedIds:new Set(),
  selTokens:[],selStyles:[],lastTemplateName:'',
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
const GAL_PAGE=30;

const CAT={
  quality:'质量/风格',character:'人物外形',outfit:'服装',
  scene:'场景',action:'动作/姿态',expression:'表情/情绪',
  lighting:'光影',camera:'镜头/构图',effect:'特效',other:'其他'
};

const STYLE_CAT={
  '材质与表面质感':'M 材质','摄影工艺与影像缺陷':'P 摄影','电影、电视与影像类型':'C 电影',
  '动画、漫画与插画亚种':'A 动画','平面设计、印刷与海报亚种':'G 平面','工艺、地域视觉与历史媒介':'R 工艺',
  '数字、游戏、UI与计算机视觉':'D 数字','建筑、空间与场景气质':'S 空间',
  '时装、亚文化与人物造型':'F 时装','玩具、产品与收藏品呈现':'T 产品'
};
const STYLE_LIB_VER=1;

const INIT_TOKENS=[
  {id:'q1',text:'masterpiece',category:'quality'},{id:'q2',text:'best quality',category:'quality'},
  {id:'q3',text:'ultra-detailed',category:'quality'},{id:'q4',text:'8k',category:'quality'},
  {id:'q5',text:'anime style',category:'quality'},{id:'q6',text:'illustration',category:'quality'},
  {id:'q7',text:'digital art',category:'quality'},{id:'q8',text:'oil painting',category:'quality'},
  {id:'q9',text:'watercolor',category:'quality'},{id:'q10',text:'lineart',category:'quality'},
  {id:'q11',text:'chibi',category:'quality'},{id:'q12',text:'3D render',category:'quality'},
  {id:'q13',text:'photorealistic',category:'quality'},{id:'q14',text:'soft focus',category:'quality'},
  {id:'o1',text:'white dress',category:'outfit'},{id:'o2',text:'school uniform',category:'outfit'},
  {id:'o3',text:'casual clothes',category:'outfit'},{id:'o4',text:'hoodie',category:'outfit'},
  {id:'o5',text:'kimono',category:'outfit'},{id:'o6',text:'evening gown',category:'outfit'},
  {id:'o7',text:'swimsuit',category:'outfit'},{id:'o8',text:'bare shoulders',category:'outfit'},
  {id:'o9',text:'off-shoulder',category:'outfit'},{id:'o10',text:'pajamas',category:'outfit'},
  {id:'s1',text:'outdoor',category:'scene'},{id:'s2',text:'indoor',category:'scene'},
  {id:'s3',text:'forest',category:'scene'},{id:'s4',text:'beach',category:'scene'},
  {id:'s5',text:'city street',category:'scene'},{id:'s6',text:'cafe',category:'scene'},
  {id:'s7',text:'bedroom',category:'scene'},{id:'s8',text:'cherry blossoms',category:'scene'},
  {id:'s9',text:'starry night',category:'scene'},{id:'s10',text:'rainy day',category:'scene'},
  {id:'a1',text:'standing',category:'action'},{id:'a2',text:'sitting',category:'action'},
  {id:'a3',text:'lying down',category:'action'},{id:'a4',text:'looking at viewer',category:'action'},
  {id:'a5',text:'looking away',category:'action'},{id:'a6',text:'hand on hip',category:'action'},
  {id:'a7',text:'arms crossed',category:'action'},{id:'a8',text:'hugging',category:'action'},
  {id:'a9',text:'walking',category:'action'},{id:'a10',text:'sleeping',category:'action'},
  {id:'e1',text:'smile',category:'expression'},{id:'e2',text:'shy',category:'expression'},
  {id:'e3',text:'serious',category:'expression'},{id:'e4',text:'laughing',category:'expression'},
  {id:'e5',text:'blush',category:'expression'},{id:'e6',text:'sleepy',category:'expression'},
  {id:'e7',text:'crying',category:'expression'},{id:'e8',text:'surprised',category:'expression'},
  {id:'l1',text:'soft lighting',category:'lighting'},{id:'l2',text:'golden hour',category:'lighting'},
  {id:'l3',text:'dramatic lighting',category:'lighting'},{id:'l4',text:'rim light',category:'lighting'},
  {id:'l5',text:'moonlight',category:'lighting'},{id:'l6',text:'neon light',category:'lighting'},
  {id:'l7',text:'candlelight',category:'lighting'},{id:'l8',text:'backlight',category:'lighting'},
  {id:'c1',text:'portrait',category:'camera'},{id:'c2',text:'full body',category:'camera'},
  {id:'c3',text:'close-up',category:'camera'},{id:'c4',text:'upper body',category:'camera'},
  {id:'c5',text:'from above',category:'camera'},{id:'c6',text:'from below',category:'camera'},
  {id:'c7',text:'dynamic angle',category:'camera'},{id:'c8',text:'wide shot',category:'camera'},
  {id:'f1',text:'bokeh',category:'effect'},{id:'f2',text:'sparkles',category:'effect'},
  {id:'f3',text:'petals',category:'effect'},{id:'f4',text:'glitter',category:'effect'},
  {id:'f5',text:'blur background',category:'effect'},{id:'f6',text:'lens flare',category:'effect'},
];

// ── Utils ─────────────────────────────────────────────────────
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2);
const fmt=ts=>{const d=new Date(ts);return`${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`};
const p2=n=>String(n).padStart(2,'0');
const ts=()=>new Date().toTimeString().slice(0,8);
function toast(msg,type='info'){
  console.log(`[toast:${type}] ${msg}`);
  const el=document.getElementById('toast');
  el.textContent=msg;el.className=`show${type==='error'?' toast-error':type==='warn'?' toast-warn':''}`;
  clearTimeout(el._t);el._t=setTimeout(()=>el.className='',3000);
}
const f2b=f=>new Promise((res,rej)=>{const r=new FileReader();r.onload=e=>res(e.target.result);r.onerror=rej;r.readAsDataURL(f)});

function buildPrompt(){
  const base=(document.getElementById('final-prompt-edit')?.value||'').trim();
  const tokenPart=S.selTokens.map(t=>t.text).join(', ');
  const stylePart=S.selStyles.map(s=>s['English prompt tokens']).join(', ');
  return [base,tokenPart,stylePart].filter(Boolean).join(', ');
}

// ── API Config ────────────────────────────────────────────────
function loadCfg(){
  S.drawPresets=JSON.parse(localStorage.getItem('draw_drawPresets')||'[]');
  S.curDrawId=localStorage.getItem('draw_curDrawId')||S.drawPresets[0]?.id||null;
  S.masterPresets=JSON.parse(localStorage.getItem('draw_masterPresets')||'[]');
  S.curMasterId=localStorage.getItem('draw_curMasterId')||S.masterPresets[0]?.id||null;
  S.localServer=localStorage.getItem('draw_localServer')||'';
  S.masterPersona=localStorage.getItem('draw_masterPersona')||'';
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

// ── Draw API ──────────────────────────────────────────────────
async function doDraw(){
  const prompt=buildPrompt();
  if(!prompt){toast('先在工作台生成或填写Prompt','warn');return}
  if(!S.drawPresets.length){toast('先在设置里添加画图API预设','warn');return}
  const n=Math.max(1,Math.min(20,parseInt(document.getElementById('param-count').value)||1));
  const negPrompt=(document.getElementById('neg-prompt').value||'').trim();
  const size=document.getElementById('param-size').value||'1024x1024';
  const refs=getAllRefs(); // 快照参考图，重roll时复现
  const tplName=S.lastTemplateName;
  const styles=S.selStyles.map(s=>({id:s.style_id,name:s['中文风格名'],tokens:s['English prompt tokens']}));
  const styleRefName=getActiveStyleRef()?.name||null;
  S.lastTemplateName='';
  _runDrawTask(prompt,negPrompt,size,n,refs,null,tplName,styles,styleRefName);
}

async function _runDrawTask(prompt,negPrompt,size,n,refs,insertAfter,tplName,styles,styleRefName){
  const res=document.getElementById('draw-results');
  const taskWrap=document.createElement('div');
  taskWrap.className='draw-task';
  const taskId=uid();
  taskWrap.dataset.taskId=taskId;
  const promptShort=prompt.length>100?prompt.slice(0,100)+'…':prompt;
  const labelText=tplName?`📄 ${tplName} · ${n}张 · ${size}`:`🎨 ${n}张 · ${size}`;
  const styleLabel=styles&&styles.length?`<span class="draw-task-styles">${styles.map(s=>'🎨'+s.name).join(' ')}</span>`:'';
  const styleRefLabel=styleRefName?`<span class="draw-task-styles">🖼️ ${styleRefName}</span>`:'';
  taskWrap.innerHTML=`<div class="draw-task-header">
    <div class="draw-task-top">
      <span class="draw-task-label">${labelText}</span>
      ${styleLabel}${styleRefLabel}
      <span class="draw-task-status">生成中...</span>
      <div class="draw-task-btns">
        <button class="draw-task-stop" title="停止备用切换（当前请求继续完成）">■ 停止</button>
        <button class="draw-task-reroll" title="用同样的prompt重roll">🔄 重roll</button>
        <button class="draw-task-copy" title="复制完整prompt">📋</button>
        <button class="draw-task-save" title="存为模版">💾</button>
        <button class="draw-task-del" title="删除此卡片">✕</button>
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
    const srOpts=S.styleRefs.map(sr=>`<option value="${sr.id}"${sr.id===styleRefName?'':''}>🖼️ ${sr.name}</option>`).join('');
    // styleRefName 存的是名字，需要反查 id（首次传入是名字用于显示，重roll时需重查）
    const activeId=S.styleRefs.find(r=>r.name===styleRefName)?.id||'';
    const editDiv=document.createElement('div');
    editDiv.className='draw-task-edit';
    editDiv.innerHTML=`
      <div class="dte-row"><label>正向</label><textarea class="dte-pos" rows="3">${prompt}</textarea></div>
      <div class="dte-row"><label>负向</label><textarea class="dte-neg" rows="2">${negPrompt||''}</textarea></div>
      <div class="dte-row"><label>画风参考</label><select class="dte-styleref"><option value="">无</option>${srOpts}</select></div>
      <div class="dte-actions">
        <label class="dte-count-label">张数<input class="dte-count" type="number" min="1" max="20" value="${n}"></label>
        <button class="btn-primary btn-sm dte-confirm">🔄 确认重roll</button>
        <button class="btn-sm btn-outline dte-cancel">取消</button>
      </div>`;
    taskWrap.querySelector('.draw-task-header').after(editDiv);
    // 设置画风参考下拉默认值
    editDiv.querySelector('.dte-styleref').value=activeId;
    editDiv.querySelector('.dte-cancel').onclick=()=>editDiv.remove();
    editDiv.querySelector('.dte-confirm').onclick=()=>{
      const newPrompt=editDiv.querySelector('.dte-pos').value.trim();
      const newNeg=editDiv.querySelector('.dte-neg').value.trim();
      const newN=Math.max(1,Math.min(20,parseInt(editDiv.querySelector('.dte-count').value)||1));
      const newSrId=editDiv.querySelector('.dte-styleref').value;
      // 重新组合refs：原快照里去掉旧画风参考图，换上新选的
      const oldSrImages=(S.styleRefs.find(r=>r.name===styleRefName)?.images)||[];
      const baseRefs=refs.filter(r=>!oldSrImages.includes(r));
      const newSr=S.styleRefs.find(r=>r.id===newSrId);
      const newRefs=newSr?[...baseRefs,...newSr.images]:baseRefs;
      const newSrName=newSr?.name||null;
      editDiv.remove();
      _runDrawTask(newPrompt||prompt,newNeg,size,newN,newRefs,taskWrap,null,styles,newSrName);
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
      tokens:[...S.selTokens],styles:tplStyles,
      prompt,negPrompt,size,createdAt:Date.now()
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
    const jobs=Array.from({length:n},()=>_doSingleDraw(fullPrompt,negPrompt,size,refs,cancelled));
    const body=taskWrap.querySelector('.draw-task-body');
    body.innerHTML='';
    let done=0;
    const results=await Promise.allSettled(jobs.map(async p=>{
      const imgData=await p;
      done++;
      setStatus(`${done}/${n} 完成`);
      const wrap=document.createElement('div');
      wrap.className='result-image-wrapper';
      const img=document.createElement('img');
      img.src=imgData;img.className='result-image';img.style.cursor='zoom-in';
      img.onclick=()=>openLightbox(imgData);
      const acts=document.createElement('div');
      acts.className='result-actions';
      const bSave=document.createElement('button');
      bSave.className='btn-primary btn-sm';bSave.textContent='存图库';
      bSave.onclick=()=>{saveToGallery(imgData,prompt,negPrompt,size,styles);bSave.textContent='已存 ✓';bSave.style.pointerEvents='none'};
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
    else if(ok>0) setStatus(`✓ ${ok}张 / ✗ ${fail}张失败`);
    else{setStatus('全部失败','err');body.innerHTML=`<div class="error-msg">❌ ${results[0].reason?.message||'失败'}</div>`}
    if(ok>0) toast(`生成了 ${ok} 张 ✨`);
    const imgs=results.filter(r=>r.status==='fulfilled').map(r=>r.value);
    if(imgs.length) db.put('tasks',{id:taskId,prompt,fullPrompt,negPrompt,size,n,tplName,styles,styleRefName,images:imgs,createdAt:Date.now()}).then(_updateClearBtn);
  }catch(err){
    taskWrap.querySelector('.draw-task-body').innerHTML=`<div class="error-msg">❌ ${err.message}</div>`;
    setStatus('失败','err');
    toast(err.message,'error');
  }
}

async function _doSingleDraw(prompt,negPrompt,size,refs,cancelled){
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
      if(_refs.length) images=await _callEdits(preset,prompt,negPrompt,size,_refs,1);
      else if(preset.format==='nvidia') images=await _callNvidia(preset,prompt,size,1);
      else if(preset.format==='chat') images=await _callChat(preset,prompt,1);
      else images=await _callGenerations(preset,prompt,negPrompt,size,1);
      console.log(`[${ts()}] ✅ "${preset.name}" 出图`);
      return images[0];
    }catch(err){lastErr=err;if(presets.length>1) console.warn(`[${ts()}] 预设"${preset.name}"失败:`,err.message)}
  }
  throw lastErr||new Error('所有预设均失败');
}

async function _callGenerations(preset,prompt,negPrompt,size,n){
  const {key,url,model}=preset;
  if(!key||!url) throw new Error(`预设"${preset.name}"未配置Key或URL`);
  console.log(`[${ts()}] → generations | ${preset.name} | ${size} | n=${n} | ${url}/images/generations\n         prompt: ${prompt.slice(0,80)}`);
  const body={model:model||'dall-e-3',prompt,n,size,response_format:'b64_json'};
  if(negPrompt) body.negative_prompt=negPrompt;
  const _ac=new AbortController();const _at=setTimeout(()=>_ac.abort(),1500000);
  const targetUrl=`${url}/images/generations`;
  const opts={method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},body:JSON.stringify(body),signal:_ac.signal};
  let r;
  try{r=await fetch(targetUrl,opts)}catch(e){
    if(!S.localServer) throw e;
    console.log(`[${ts()}] generations 直连失败(${e.message})，走本地代理重试`);
    const h={...opts.headers,'X-Real-Target':targetUrl,'X-Real-Key':key};
    delete h['Authorization'];
    r=await fetch(`${S.localServer}/api/llm-proxy`,{...opts,headers:h});
  }
  clearTimeout(_at);
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
    const r=await fetch(`${S.localServer}/api/proxy-fetch?url=${encodeURIComponent(url)}`);
    if(r.ok) return r;
    console.warn(`[${ts()}] proxy-fetch失败(${r.status})，直接获取: ${url}`);
  }
  return fetch(url);
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

async function _callEdits(preset,prompt,negPrompt,size,refB64s,n){
  const {key,url,model}=preset;
  if(!key||!url) throw new Error(`预设"${preset.name}"未配置Key或URL`);
  console.log(`[${ts()}] → edits | ${preset.name} | ${size} | refs=${refB64s.length} | n=${n} | ${url}/images/edits\n         prompt: ${prompt.slice(0,80)}`);
  const fd=new FormData();
  for(let i=0;i<refB64s.length;i++){
    const blob=await fetch(refB64s[i]).then(r=>r.blob());
    fd.append('image[]',blob,`ref${i}.png`);
  }
  fd.append('model',model||'dall-e-3');
  fd.append('prompt',prompt);fd.append('n',n);fd.append('size',size);
  if(negPrompt) fd.append('negative_prompt',negPrompt);
  const _ac=new AbortController();const _at=setTimeout(()=>_ac.abort(),1500000);
  const targetUrl=`${url}/images/edits`;
  let r;
  try{r=await fetch(targetUrl,{method:'POST',headers:{'Authorization':`Bearer ${key}`},body:fd,signal:_ac.signal})}catch(e){
    if(!S.localServer) throw e;
    console.log(`[${ts()}] edits 直连失败(${e.message})，走本地代理重试`);
    r=await fetch(`${S.localServer}/api/proxy-image-edits`,{method:'POST',headers:{'X-Api-Url':targetUrl,'X-Api-Key':key},body:fd,signal:_ac.signal});
  }
  clearTimeout(_at);
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

async function saveToGallery(imageData,prompt,negPrompt,size,styles){
  const p=S.personas.find(x=>x.id===S.curPersonaId);
  await db.put('gallery',{
    id:uid(),personaId:S.curPersonaId||null,personaName:p?.name||null,
    imageData,prompt,negPrompt,params:{size},rating:0,tags:[],
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
    const imageData=await f2b(file);
    await db.put('gallery',{
      id:uid(),personaId:null,personaName:source||'外部导入',
      imageData,prompt,negPrompt:'',params:{size:'—'},rating:0,tags:[],createdAt:Date.now()
    });
  }
  closeModal('modal-gallery-import');
  toast(files.length>1?`已存入 ${files.length} 张图片 ✨`:'图片已存入图库 ✨');
  _refreshPendingCount();
  if(document.getElementById('tab-gallery').classList.contains('active')) renderGallery();
}

function clearTokens(){
  S.selTokens=[];
  document.querySelectorAll('.token-tag.selected').forEach(el=>el.classList.remove('selected'));
  renderSelectedTokens();
}

async function _refreshPendingCount(){
  const allItems=await db.galleryMeta();
  const pending=allItems.filter(i=>!S.allAnalyzedIds.has(i.id)).length;
  const el=document.getElementById('gallery-pending-label');
  if(el) el.textContent=pending>0?`${pending} 张待分析`:'';
}

const dlImg=url=>{const a=document.createElement('a');a.href=url;a.download=`draw_${Date.now()}.png`;a.click()};

const _shrinkImg=(dataUrl,maxDim=768,quality=0.7)=>new Promise(res=>{
  const img=new Image();img.onload=()=>{
    let{width:w,height:h}=img;
    if(w>maxDim||h>maxDim){const r=Math.min(maxDim/w,maxDim/h);w=Math.round(w*r);h=Math.round(h*r)}
    const c=document.createElement('canvas');c.width=w;c.height=h;
    c.getContext('2d').drawImage(img,0,0,w,h);
    res(c.toDataURL('image/jpeg',quality).replace(/^data:image\/\w+;base64,/,''));
  };img.src=dataUrl;
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
async function loadStyleRefs(){
  S.styleRefs=await db.all('styleRefs');
}
async function saveStyleRef(name,images,description=''){
  const item={id:uid(),name,images,description,createdAt:Date.now()};
  await db.put('styleRefs',item);
  S.styleRefs=await db.all('styleRefs');
  return item;
}
async function deleteStyleRef(id){
  await db.del('styleRefs',id);
  S.styleRefs=await db.all('styleRefs');
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
      btn.textContent=(sr.images.length?'🖼️ ':'')+sr.name;
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
    del.textContent='✕';del.className='custom-ref-del';
    del.onclick=()=>{_pendingStyleRefB64s.splice(i,1);renderNewStyleRefPreview()};
    wrap.append(img,del);preview.appendChild(wrap);
  });
}

async function confirmSaveStyleRef(){
  const name=(document.getElementById('new-style-ref-name').value||'').trim();
  const desc=(document.getElementById('new-style-ref-desc').value||'').trim();
  if(!name){toast('请填写套装名称','warn');return}
  if(!_pendingStyleRefB64s||!_pendingStyleRefB64s.length){toast('请选择至少1张参考图','warn');return}
  const item=await saveStyleRef(name,[..._pendingStyleRefB64s],desc);
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
    nameRow.textContent=sr.name+(S.curStyleRefId===sr.id?' ✓':'');
    if(S.curStyleRefId===sr.id) nameRow.style.color='var(--accent)';
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
    editBtn.className='btn-tiny';editBtn.textContent='✏️';editBtn.title='编辑名称和描述';
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
      okBtn.className='btn-tiny';okBtn.textContent='✓';okBtn.title='保存';
      okBtn.onclick=async()=>{
        const newName=nameInput.value.trim();
        if(!newName){toast('名称不能为空','warn');return;}
        sr.name=newName;sr.description=descInput.value.trim();
        await db.put('styleRefs',sr);
        S.styleRefs=await db.all('styleRefs');
        renderStyleRefStrip();renderStyleRefList();
        toast('已保存 ✓');
      };
      const cancelBtn=document.createElement('button');
      cancelBtn.className='btn-tiny';cancelBtn.textContent='✕';cancelBtn.title='取消';
      cancelBtn.onclick=()=>renderStyleRefList();
      info.innerHTML='';
      info.style.cssText='flex:1;display:flex;flex-direction:column;gap:3px;min-width:0';
      info.append(nameInput,descInput);
      el.innerHTML='';
      el.append(thumbs,info,okBtn,cancelBtn);
    };
    const delBtn=document.createElement('button');
    delBtn.className='btn-tiny';delBtn.textContent='🗑';delBtn.title='删除';
    delBtn.onclick=async()=>{
      if(!confirm(`删除"${sr.name}"？`)) return;
      await deleteStyleRef(sr.id);
      renderStyleRefStrip();renderStyleRefList();
      toast('已删除');
    };
    el.append(thumbs,info,useBtn,editBtn,delBtn);
    list.appendChild(el);
  });
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
      del.textContent='✕';del.className='custom-ref-del';
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
  document.getElementById('char-ref-preview').innerHTML='🖼️';
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
      prev.innerHTML=ch.refImage?`<img src="${ch.refImage}" style="width:100%;height:100%;object-fit:cover;border-radius:var(--rs)">`:'🖼️';
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
  document.getElementById('char-ref-preview').innerHTML='🖼️';
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
  S.masterHistory=await db.getSetting('masterHistory',[])||[];
  S.masterLastImg=await db.getSetting('masterLastImg',null)||null;
  S.masterPendingImg=null;
  const el=document.getElementById('master-insight-content');
  if(el&&S.aestheticProfile) el.innerHTML=miniMd(S.aestheticProfile);
  const chat=document.getElementById('master-chat');
  if(chat&&S.masterHistory.length){
    for(const m of S.masterHistory){
      const div=document.createElement('div');
      div.className=`master-msg master-msg-${m.role}`;
      if(m._hasImage) div.insertAdjacentHTML('beforeend','<span style="opacity:.6;font-size:12px">🖼️ 附图</span><br>');
      div.insertAdjacentHTML('beforeend',miniMd(m.content));
      const del=document.createElement('button');
      del.className='msg-del';del.textContent='✕';del.title='删除这条';
      del.onclick=e=>{e.stopPropagation();div.remove();_removeFromHistory(m)};
      const copy=document.createElement('button');
      copy.className='msg-del';copy.textContent='📋';copy.title='复制';
      copy.onclick=e=>{e.stopPropagation();navigator.clipboard.writeText(m.content).then(()=>{copy.textContent='✓';setTimeout(()=>copy.textContent='📋',1500)})};
      div.appendChild(copy);
      div.appendChild(del);
      chat.appendChild(div);
    }
    chat.scrollTop=chat.scrollHeight;
  }
}

async function analyzePreference(){
  const all=await db.all('gallery');
  if(all.length<2){toast('需要至少2张图片','warn');return}

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

  const imgBlocks=await Promise.all(sample.map(async g=>{
    const b64=await _shrinkImg(g.imageData);
    return{type:'image',source:{type:'base64',media_type:'image/jpeg',data:b64}};
  }));
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
  parts.push('用户想要画的内容：'+userDesc);

  S.aiGenBusy=true;
  const btn=document.getElementById('btn-ai-gen');
  btn.disabled=true;btn.textContent='✨ 生成中...';
  const ta=document.getElementById('final-prompt-edit');
  ta.value='';ta.placeholder='AI正在生成...';

  try{
    const msgs=[
      {role:'system',content:sysPrompt},
      {role:'user',content:parts.join('\n\n')}
    ];
    const result=await callMaster(msgs);
    ta.value=result.trim();
    if(template?.defaultNeg){
      const neg=document.getElementById('neg-prompt');
      if(!neg.value) neg.value=template.defaultNeg;
    }
    toast('Prompt已生成 ✨');
  }catch(e){
    toast('生成失败：'+e.message,'error');
  }finally{
    S.aiGenBusy=false;
    btn.disabled=false;btn.textContent='✨ AI 生成 Prompt';
    ta.placeholder='AI生成的Prompt会出现在这里，也可以直接编辑...';
  }
}

async function masterSuggest(userInput){
  const ctx=[];
  if(S.aestheticProfile) ctx.push('用户审美偏好：'+S.aestheticProfile);
  const charDesc=S.selCharIds.map(id=>S.characters.find(c=>c.id===id)).filter(Boolean).map(c=>c.name).join('、');
  if(charDesc) ctx.push('当前选中角色：'+charDesc);
  const _suggestBase='根据用户想法和偏好给出精炼prompt建议。格式：①核心prompt（英文，可直接用）②可选加强词③一句创意建议';
  const history=S.masterHistory.slice(-10).map(m=>({role:m.role,content:m.content}));
  const hasNewImg=!!S.masterPendingImg;
  const imgB64=hasNewImg?S.masterPendingImg:S.masterLastImg;
  const userText=`${ctx.join('\n')}\n\n用户想法：${userInput}`;
  let userContent;
  if(imgB64){
    const imgBlock={type:'image',source:{type:'base64',media_type:'image/jpeg',data:imgB64}};
    if(hasNewImg){
      userContent=[imgBlock,{type:'text',text:userText}];
    }else{
      history.unshift(
        {role:'user',content:[imgBlock,{type:'text',text:'[参考图片]'}]},
        {role:'assistant',content:'好的，我已看到这张参考图片。'}
      );
      userContent=userText;
    }
  }else{
    userContent=userText;
  }
  const msgs=[
    {role:'system',content:S.masterPersona?`${S.masterPersona}\n\n${_suggestBase}`:_suggestBase},
    ...history,
    {role:'user',content:userContent}
  ];
  const result=await callMaster(msgs);
  const histEntry={role:'user',content:userInput};
  if(hasNewImg){
    histEntry._hasImage=true;
    S.masterLastImg=S.masterPendingImg;
    db.setSetting('masterLastImg',S.masterPendingImg);
    S.masterPendingImg=null;
    document.getElementById('master-img-preview').style.display='none';
  }
  S.masterHistory.push(histEntry,{role:'assistant',content:result});
  if(S.masterHistory.length>20) S.masterHistory=S.masterHistory.slice(-20);
  db.setSetting('masterHistory',S.masterHistory);
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
  '香水瓶的广告画面','一封信的配图中','两人的专属货币上'
];
const INSPIRE_COMPOSITIONS=[
  '俯拍——从正上方看下去','透过纱帘/雾气/水汽看','逆光剪影只有轮廓',
  '水面倒影构图','从肩头越过看对方表情','极近——锁骨颈线肩膀',
  '两人之间留出呼吸的negative space','从镜子反射中看到的画面',
  '被画框/窗框/拱门裁切的构图','仰视——从下方看上去的力量感',
  '背影加回眸','侧脸轮廓线条','全身入画环境占大比例','脸贴脸的极近距离',
  '一个人完整入画另一个只露局部（手臂/胸膛/下巴）','鱼眼/广角轻微变形',
  '对称构图像宗教画','画中画——画面里有另一个画面','环形/圆形构图裁切',
  '极繁——画面塞满细节','极简——大面积留白只有两人'
];
const INSPIRE_STYLES=[
  '铜版蚀刻画风格','古典素描手稿（达芬奇/丢勒那种）','湿壁画质感','水墨晕染',
  '彩窗玻璃/教堂花窗','青铜浮雕','古典陶瓷釉彩','丝绸刺绣质感',
  '烫金+暗纹底','珐琅微绘','粉彩洛可可','木刻版画',
  'Moebius极繁线条插画','赛博朋克霓虹','复古胶片摄影颗粒感','宝丽来褪色感',
  '浮世绘（不含和服神社）','Art Nouveau新艺术曲线','80年代像素游戏风',
  '拼贴杂志collage','儿童绘本蜡笔涂鸦','哥特暗黑插画','凹版印刷质感',
  '织锦/缂丝/挂毯','暗调卡拉瓦乔式光影','印象派厚重笔触','极简线条一笔画',
  '3D黏土小人风格','水晶/宝石内部折射','老报纸印刷（带网点）'
];
const INSPIRE_TENSIONS=[
  '差一点就失控但被稳稳接住','想碰但还没碰的一厘米距离','被精心对待——每个触碰都有设计感',
  '禁忌——不该在这里做这件事','睡着了被凝视——完全不设防的信任','慵懒醒来的迷糊和柔软',
  '汗湿之后的疲倦和满足','占有——环住/不放手/标记','温柔到极致像捧着会碎的东西',
  '故意挑衅和撩拨','安静的对峙——有张力但不是愤怒','被保护在怀里的安全感',
  '重逢——好久没见的饥渴','第一次——紧张又期待','主导与交出控制权',
  '在别人看不到的角落偷偷来','事后的餍足和缱绻','一个人在上面一个人在仰望'
];

function _rollInspireDice(){
  const r=arr=>arr[Math.floor(Math.random()*arr.length)];
  const scene=r(INSPIRE_SCENES);
  const comp=r(INSPIRE_COMPOSITIONS);
  const style=r(INSPIRE_STYLES);
  const tension=r(INSPIRE_TENSIONS);
  return `我想看：${scene} × ${comp} × ${style} × ${tension}——帮我构思一下`;
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
function addMasterMsg(role,text,isTemp=false,imgB64=null){
  const chat=document.getElementById('master-chat');
  const el=document.createElement('div');
  el.className=`master-msg master-msg-${role}${isTemp?' temp':''}`;
  if(imgB64&&role==='user'){
    const img=document.createElement('img');
    img.className='msg-img';img.src='data:image/jpeg;base64,'+imgB64;
    el.appendChild(img);
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
        fill.className='msg-del msg-fill';fill.textContent='▶ 填入';fill.title='填入工作台';
        fill.onclick=e=>{
          e.stopPropagation();
          const ta=document.getElementById('final-prompt-edit');
          if(ta){ta.value=extracted;ta.dispatchEvent(new Event('input'))}
          switchTab('studio');
          toast('已填入工作台 ✓');
          fill.textContent='✓';setTimeout(()=>fill.textContent='▶ 填入',1500);
        };
        el.appendChild(fill);
      }
    }
    const del=document.createElement('button');
    del.className='msg-del';del.textContent='✕';del.title='删除这条';
    del.onclick=e=>{e.stopPropagation();el.remove();_removeFromHistory({role,content:text})};
    const copy=document.createElement('button');
    copy.className='msg-del';copy.textContent='📋';copy.title='复制';
    copy.onclick=e=>{e.stopPropagation();navigator.clipboard.writeText(text).then(()=>{copy.textContent='✓';setTimeout(()=>copy.textContent='📋',1500)})};
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

async function renderTokens(filter=''){
  const cats=await db.tokensByCategory();
  const container=document.getElementById('tokens-categories');
  container.innerHTML='';
  const order=['quality','character','outfit','scene','action','expression','lighting','camera','effect','other'];
  for(const cat of order){
    let tokens=(cats[cat]||[]);
    if(filter) tokens=tokens.filter(t=>t.text.toLowerCase().includes(filter.toLowerCase()));
    if(!tokens.length) continue;
    tokens.sort((a,b)=>(b.useCount||0)-(a.useCount||0));
    const sec=document.createElement('div');
    sec.className='token-section';
    const hdr=document.createElement('div');
    hdr.className='token-section-header';
    hdr.innerHTML=`<span>${CAT[cat]||cat}</span><span class="token-count">${tokens.length}</span>`;
    hdr.onclick=()=>sec.classList.toggle('collapsed');
    const grid=document.createElement('div');
    grid.className='tokens-grid';
    for(const t of tokens){
      const tag=document.createElement('span');
      const sel=S.selTokens.some(s=>s.id===t.id);
      tag.className='token-tag'+(sel?' selected':'');
      tag.textContent=t.text;tag.dataset.id=t.id;
      tag.title=`点击添加 | 已用${t.useCount||0}次 | 右键删除`;
      tag.addEventListener('click',()=>toggleToken(t));
      tag.addEventListener('contextmenu',e=>{e.preventDefault();if(confirm(`删除"${t.text}"？`)){db.del('tokens',t.id).then(()=>{S.selTokens=S.selTokens.filter(s=>s.id!==t.id);renderSelectedTokens();renderTokens(document.getElementById('token-search-input').value)})}});
      grid.appendChild(tag);
    }
    sec.append(hdr,grid);container.appendChild(sec);
  }
}

function renderSelectedTokens(){
  const area=document.getElementById('selected-tokens');
  area.innerHTML='';
  for(const t of S.selTokens){
    const chip=document.createElement('span');
    chip.className='selected-chip';
    chip.innerHTML=`${t.text}<button class="chip-remove" data-id="${t.id}">×</button>`;
    chip.querySelector('.chip-remove').addEventListener('click',()=>{
      S.selTokens=S.selTokens.filter(s=>s.id!==t.id);
      document.querySelectorAll(`.token-tag[data-id="${t.id}"]`).forEach(el=>el.classList.remove('selected'));
      renderSelectedTokens();
    });
    area.appendChild(chip);
  }
  updateFinalPrompt();
}

function updateFinalPrompt(){}

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
  _galShown=GAL_PAGE;
  _paintGallery();
}

function _paintGallery(){
  const grid=document.getElementById('gallery-grid');
  if(_galObserver){_galObserver.disconnect();_galObserver=null;}
  grid.innerHTML='';
  if(!_galItems.length){grid.innerHTML='<div class="empty-state">还没有图片，去工作台画一张吧 ✨</div>';_updateBatchBar();return}
  _galObserver=new IntersectionObserver(entries=>{
    for(const entry of entries){
      if(!entry.isIntersecting) continue;
      const img=entry.target;
      _galObserver.unobserve(img);
      db.get('gallery',img.dataset.id).then(r=>{if(r) img.src=r.imageData;});
    }
  },{rootMargin:'200px'});
  const analyzedSet=S.allAnalyzedIds;
  const selecting=S.gallerySelecting;
  for(const item of _galItems.slice(0,_galShown)){
    const el=document.createElement('div');
    el.className='gallery-item'+(selecting&&S.gallerySelected.has(item.id)?' gal-selected':'');
    el.style.cssText='position:relative;overflow:hidden;border-radius:var(--r);cursor:pointer;background:var(--card2)';
    const badge=analyzedSet.size===0?''
      :analyzedSet.has(item.id)
        ?'<div class="gallery-badge analyzed">✓</div>'
        :'<div class="gallery-badge new-img">NEW</div>';
    const cb=selecting?`<label class="gal-cb"><input type="checkbox" ${S.gallerySelected.has(item.id)?'checked':''}><span class="gal-check"></span></label>`:'';
    const delBtn=selecting?'':'<button class="gal-quick-del" title="删除">✕</button>';
    el.innerHTML=`<img data-id="${item.id}" alt="" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover">${badge}${cb}${delBtn}<div class="gallery-item-overlay"><span class="gallery-item-rating">${'⭐'.repeat(item.rating||0)}</span><span class="gallery-item-persona">${item.personaName||''}</span></div>`;
    _galObserver.observe(el.querySelector('img'));
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
    btn.onclick=()=>{_galShown+=GAL_PAGE;_paintGallery()};
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
  const btn=document.getElementById('btn-gallery-select');
  btn.textContent=S.gallerySelecting?'✕ 退出多选':'☑ 多选';
  btn.classList.toggle('active',S.gallerySelecting);
  _paintGallery();
}

function _updateBatchBar(){
  const bar=document.getElementById('gallery-batch-bar');
  if(!bar) return;
  const n=S.gallerySelected.size;
  if(!S.gallerySelecting||n===0){bar.style.display='none';return}
  bar.style.display='flex';
  bar.querySelector('.batch-count').textContent=`已选 ${n} 张`;
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
  if(p?.defaultNeg){
    const neg=document.getElementById('neg-prompt');
    if(!neg.value) neg.value=p.defaultNeg;
  }
  const qBtn=document.getElementById('btn-edit-persona-quick');
  qBtn.style.display=id?'':'none';
}

function toggleToken(token){
  const idx=S.selTokens.findIndex(s=>s.id===token.id);
  if(idx>=0){
    S.selTokens.splice(idx,1);
    document.querySelectorAll(`.token-tag[data-id="${token.id}"]`).forEach(el=>el.classList.remove('selected'));
  }else{
    S.selTokens.push({id:token.id,text:token.text});
    document.querySelectorAll(`.token-tag[data-id="${token.id}"]`).forEach(el=>el.classList.add('selected'));
    db.get('tokens',token.id).then(t=>{if(t){t.useCount=(t.useCount||0)+1;db.put('tokens',t)}});
  }
  renderSelectedTokens();
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
  document.getElementById('persona-neg-input').value=p?.defaultNeg||'';
  document.getElementById('persona-notes-input').value=p?.notes||'';
  document.getElementById('btn-delete-persona').style.display=id?'':'none';
  document.getElementById('modal-persona').style.display='flex';
  setTimeout(()=>document.getElementById('persona-name-input').focus(),100);
}
async function savePersona(){
  const name=document.getElementById('persona-name-input').value.trim();
  if(!name){toast('请输入模板名称','warn');return}
  const existing=editingPid?S.personas.find(p=>p.id===editingPid):null;
  const obj={
    id:editingPid||uid(),name,
    icon:document.getElementById('persona-icon-input').value.trim()||'🎨',
    basePrompt:document.getElementById('persona-base-input').value.trim(),
    defaultNeg:document.getElementById('persona-neg-input').value.trim(),
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

// ── Token Modal ───────────────────────────────────────────────
function openAddToken(){
  document.getElementById('token-text-input').value='';
  document.getElementById('modal-token').style.display='flex';
  setTimeout(()=>document.getElementById('token-text-input').focus(),100);
}
async function saveToken(){
  const text=document.getElementById('token-text-input').value.trim();
  if(!text){toast('请输入词条内容','warn');return}
  const cat=document.getElementById('token-category-select').value;
  await db.put('tokens',{id:uid(),text,category:cat,useCount:0,createdAt:Date.now()});
  renderTokens(document.getElementById('token-search-input').value);
  closeModal('modal-token');
  toast('词条已添加 ✨');
}

// ── Template ──────────────────────────────────────────────────
async function saveTemplate(){
  const name=prompt('模版名称：');
  if(!name?.trim()) return;
  await db.put('templates',{
    id:uid(),name:name.trim(),personaId:S.curPersonaId,
    tokens:[...S.selTokens],styles:[...S.selStyles],
    prompt:document.getElementById('final-prompt-edit').value||'',
    negPrompt:document.getElementById('neg-prompt').value||'',
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
      const metaParts=[`${t.tokens?.length||0}个词条`];
      if(styleNames.length) metaParts.push(styleNames.map(n=>'🎨'+n).join(' '));
      metaParts.push(fmt(t.createdAt));
      el.innerHTML=`<div class="template-name">${t.name}</div><div class="template-meta">${metaParts.join(' · ')}</div><div class="template-actions"></div>`;
      const bLoad=document.createElement('button');
      bLoad.className='btn-primary btn-sm';bLoad.textContent='载入';
      bLoad.onclick=()=>{
        S.selTokens=t.tokens?[...t.tokens]:[];
        S.selStyles=t.styles?[...t.styles]:[];
        if(t.prompt) document.getElementById('final-prompt-edit').value=t.prompt;
        if(t.negPrompt) document.getElementById('neg-prompt').value=t.negPrompt;
        if(t.size) document.getElementById('param-size').value=t.size;
        if(t.personaId) selectPersona(t.personaId);
        renderSelectedTokens();renderSelectedStyles();
        document.querySelectorAll('.token-tag:not(.style-tag)').forEach(el=>el.classList.toggle('selected',S.selTokens.some(s=>s.id===el.dataset.id)));
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
  const full=await db.get('gallery',item.id);
  if(!full) return;
  S.curDetail=full;
  document.getElementById('detail-image').src=full.imageData;
  document.getElementById('detail-persona').textContent=full.personaName||'无模板';
  document.getElementById('detail-date').textContent=fmt(full.createdAt);
  document.getElementById('detail-prompt').value=full.prompt||'';
  document.getElementById('detail-neg').value=full.negPrompt||'';
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
    el.textContent='🎨 '+s.name;el.title=s.tokens;
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
  S.curDetail.negPrompt=document.getElementById('detail-neg').value.trim();
  await db.put('gallery',S.curDetail);
  document.getElementById('btn-save-detail-prompt').style.display='none';
  toast('已保存 ✓');
}
function useDetailPrompt(){
  if(!S.curDetail) return;
  S.curDetail.prompt=document.getElementById('detail-prompt').value.trim();
  S.curDetail.negPrompt=document.getElementById('detail-neg').value.trim();
  switchTab('studio');
  document.getElementById('final-prompt-edit').value=S.curDetail.prompt||'';
  document.getElementById('neg-prompt').value=S.curDetail.negPrompt||'';
  S.selTokens=[];
  if(S.curDetail.styles&&S.curDetail.styles.length){
    S.selStyles=S.curDetail.styles.map(s=>({style_id:s.id,'中文风格名':s.name,'English prompt tokens':s.tokens}));
  }else{S.selStyles=[]}
  renderSelectedTokens();renderSelectedStyles();renderStyles();
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
    <span class="preset-check" title="点击切换为当前使用">${isActive?'✓':'○'}</span>
    <span class="preset-name" title="点击切换">${preset.name||'未命名'}</span>
    <button class="btn-tiny" data-a="rename" title="改名" style="padding:2px 5px">✏</button>
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
  meta.textContent=`${(preset.url||'未配置URL').replace(/^https?:\/\//,'').slice(0,34)} · ${preset.model||'未配置模型'}`;

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
  body.innerHTML=`
    <div class="preset-row"><label>Key</label><input type="password" data-f="key" value="${preset.key||''}" placeholder="sk-..."></div>
    <div class="preset-row"><label>URL</label><input type="text" data-f="url" value="${preset.url||''}" placeholder="https://api.xxx.com/v1"></div>
    <div class="preset-row"><label>模型</label><input type="text" data-f="model" value="${preset.model||''}" placeholder="${type==='draw'?'dall-e-3':'claude-opus-4-7'}"></div>
    ${fmtRow}
    <div class="preset-row" style="gap:8px;align-items:center">
      <label style="min-width:40px;text-align:right">备用</label>
      <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;color:var(--text)">
        <input type="checkbox" data-f="skipFallback" ${preset.skipFallback?'checked':''} style="width:auto;flex:none">
        跳过自动备用（保留在列表但失败时不轮询）
      </label>
    </div>
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
  };
  body.querySelector('[data-a="save"]').onclick=doSave;
  body.querySelector('[data-a="use"]').onclick=()=>{doSave();_setActive(preset,type)};

  card.append(hdr,meta,body);
  return card;
}

function _setActive(preset,type){
  if(type==='draw') S.curDrawId=preset.id;
  else S.curMasterId=preset.id;
  savePresetsToLS();
  renderDrawPresets();renderMasterPresets();
  toast(`已切换到"${preset.name}" ✓`);
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
  const allTokens=await db.all('tokens');
  const templates=await db.all('templates');
  const defaultIds=new Set(INIT_TOKENS.map(t=>t.id));
  const customTokens=allTokens.filter(t=>!defaultIds.has(t.id));
  const allStyles=await db.all('styles');
  const customStyles=allStyles.filter(s=>s.custom);
  const cfg={
    _v:1,_app:'draw',_date:new Date().toISOString().slice(0,16).replace('T',' '),
    drawPresets:S.drawPresets,curDrawId:S.curDrawId,
    masterPresets:S.masterPresets,curMasterId:S.curMasterId,
    personas,curPersonaId:S.curPersonaId,
    customTokens,templates,customStyles,
  };
  const blob=new Blob([JSON.stringify(cfg,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=`draw_config_${new Date().toISOString().slice(0,10)}.json`;
  a.click();URL.revokeObjectURL(a.href);
  toast('配置已导出 ✓（包含预设/人设/词条/模版，不含图库）');
}

async function importConfig(file){
  try{
    const text=await file.text();
    const cfg=JSON.parse(text);
    if(cfg._app!=='draw') throw new Error('不是画图台的配置文件');
    if(cfg.drawPresets?.length){S.drawPresets=cfg.drawPresets;S.curDrawId=cfg.curDrawId||cfg.drawPresets[0]?.id}
    if(cfg.masterPresets?.length){S.masterPresets=cfg.masterPresets;S.curMasterId=cfg.curMasterId||cfg.masterPresets[0]?.id}
    if(cfg.personas?.length) for(const p of cfg.personas) await db.put('personas',p);
    if(cfg.customTokens?.length) for(const t of cfg.customTokens) await db.put('tokens',t);
    if(cfg.customStyles?.length) for(const s of cfg.customStyles) await db.put('styles',s);
    if(cfg.templates?.length) for(const t of cfg.templates) await db.put('templates',t);
    savePresetsToLS();
    loadCfg();
    await loadPersonas();
    await renderTokens();
    renderDrawPresets();renderMasterPresets();
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
    };
    // 用 Blob 数组 + cursor 逐条刷入，避免 getAll() 把整个 gallery 一次性加载到 JS 堆 OOM
    const blobs=[new Blob([JSON.stringify(meta).slice(0,-1)])];
    const counts=[];
    for(const store of FULL_STORES){
      blobs.push(new Blob([`,"${store}":[`]));
      let first=true,count=0;
      await new Promise((res,rej)=>{
        const req=db._tx(store).openCursor();
        req.onsuccess=e=>{
          const cur=e.target.result;
          if(cur){
            blobs.push(new Blob([(first?'':',')+JSON.stringify(cur.value)]));
            first=false;count++;
            cur.continue();
          }else{res()}
        };
        req.onerror=e=>rej(e.target.error);
      });
      blobs.push(new Blob([']']));
      if(count) counts.push(`${store}(${count})`);
      if(btn) btn.textContent=`⏳ ${store}(${count})…`;
    }
    blobs.push(new Blob(['}']));
    const blob=new Blob(blobs,{type:'application/json'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=`draw_full_backup_${new Date().toISOString().slice(0,10)}.json`;
    a.click();URL.revokeObjectURL(a.href);
    toast(`全部数据已导出 ✓\n${counts.join('、')}`);
  }catch(e){toast('导出失败：'+e.message,'error')}
  finally{if(btn){btn.disabled=false;btn.textContent='📦 导出全部数据'}}
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
    showProgress('⏳ 预设已读取，开始导入数据…');
    for(const store of FULL_STORES){
      const storeStart=`,"${store}":[`;
      while(!buf.includes(storeStart)){if(!await readChunk())break}
      const si=buf.indexOf(storeStart);
      if(si<0) continue;
      buf=buf.slice(si+storeStart.length);
      let n=0,depth=0,inStr=false,esc=false,objStart=-1;
      const processBuffer=async()=>{
        let i=0;
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
          if(c===']'&&depth===0){buf=buf.slice(i+1);break}
          i++;
        }
        if(depth>0&&objStart>=0) buf=buf.slice(objStart);
        else if(depth===0) buf='';
      };
      await processBuffer();
      while(depth>0||(!buf.includes(']')&&depth===0)){
        if(!await readChunk())break;
        await processBuffer();
      }
      if(n) counts.push(`${store}(${n})`);
      showProgress(`✅ ${store}(${n}) 完成`);
    }
    reader.cancel();
    savePresetsToLS();
    loadCfg();
    await loadPersonas();
    await renderTokens();
    renderDrawPresets();renderMasterPresets();
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
async function seedTokens(){
  const ex=await db.all('tokens');
  if(!ex.length) for(const t of INIT_TOKENS) await db.put('tokens',{...t,useCount:0,createdAt:Date.now()});
}

// ── Style Explorer ───────────────────────────────────────────
let _styleFilter='',_styleCatCollapsed={},_styleSeeded=false,_editingStyleId=null;

async function seedStyles(){
  if(_styleSeeded) return;
  const ver=await db.getSetting('styles_lib_version',0);
  if(ver>=STYLE_LIB_VER){_styleSeeded=true;return}
  try{
    const resp=await fetch('./data/style_library.json');
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

async function renderStyles(search=''){
  const all=await db.all('styles');
  let items=all;
  if(_styleFilter) items=items.filter(s=>s['类别']===_styleFilter);
  if(search){
    const q=search.toLowerCase();
    items=items.filter(s=>(s['中文风格名']||'').toLowerCase().includes(q)||(s['English prompt tokens']||'').toLowerCase().includes(q));
  }
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
  if(!container.children.length) container.innerHTML='<div style="color:var(--sub);font-size:12px;padding:8px 0">风格库为空，点击上方 + 自定义 添加</div>';
}

function renderStyleFilters(){
  const row=document.getElementById('style-filter-row');
  row.innerHTML='';
  const mk=(label,cat)=>{
    const btn=document.createElement('span');
    btn.className='token-tag'+(_styleFilter===cat?' selected':'');
    btn.textContent=label;
    btn.onclick=()=>{_styleFilter=(_styleFilter===cat?'':cat);renderStyleFilters();renderStyles(document.getElementById('style-search-input')?.value||'')};
    row.appendChild(btn);
  };
  mk('全部','');
  for(const [cat,label] of Object.entries(STYLE_CAT)) mk(label,cat);
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
    for(const s of S.selStyles){
      const chip=document.createElement('span');
      chip.className='selected-chip';
      chip.innerHTML=`${s['中文风格名']}<button class="chip-remove" data-sid="${s.style_id}">×</button>`;
      chip.querySelector('.chip-remove').onclick=()=>{
        S.selStyles=S.selStyles.filter(x=>x.style_id!==s.style_id);
        document.querySelectorAll(`.style-tag[data-sid="${s.style_id}"]`).forEach(el=>el.classList.remove('selected'));
        renderSelectedStyles();
      };
      area.appendChild(chip);
    }
  }
  // 折叠时也能看见已选风格（header 小预览，可单个点 × 删除）
  const preview=document.getElementById('styles-selected-preview');
  if(preview){
    preview.innerHTML='';
    if(S.selStyles.length){
      for(const s of S.selStyles){
        const tag=document.createElement('span');
        tag.style.cssText='display:inline-flex;align-items:center;gap:3px;font-size:10px;padding:1px 5px 1px 6px;border-radius:10px;background:var(--purple);color:#fff;white-space:nowrap;max-width:90px';
        const name=document.createElement('span');
        name.style.cssText='overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        name.textContent=s['中文风格名'];
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
      }
    }
  }
}

function clearStyles(){
  S.selStyles=[];
  document.querySelectorAll('.style-tag.selected').forEach(el=>el.classList.remove('selected'));
  renderSelectedStyles();
}

async function randomStyles(){
  const all=await db.all('styles');
  if(!all.length){toast('风格库未加载','warn');return}
  // 在当前筛选分类内随机，没有筛选则全部范围
  const pool=_styleFilter?all.filter(s=>s['类别']===_styleFilter):all;
  if(!pool.length){toast('当前分类没有风格','warn');return}
  clearStyles();
  const count=1+Math.floor(Math.random()*3);
  const shuffled=[...pool].sort(()=>Math.random()-0.5);
  for(let i=0;i<Math.min(count,shuffled.length);i++) S.selStyles.push(shuffled[i]);
  renderSelectedStyles();
  renderStyles(document.getElementById('style-search-input')?.value||'');
  const scope=_styleFilter?(STYLE_CAT[_styleFilter]||_styleFilter):'全部';
  toast(`🎲 [${scope}] 随机选了 ${S.selStyles.length} 个`);
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
    +(risk?`<div style="font-size:11px;color:var(--warn);margin-top:4px">⚠ ${risk}</div>`:'')
    +(rescue?`<div style="font-size:11px;color:var(--teal);margin-top:2px">💡 ${rescue}</div>`:'');
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
    document.getElementById('char-ref-preview').innerHTML='🖼️';
    document.getElementById('btn-cancel-char-edit').style.display='none';
  };
  document.getElementById('btn-pick-char-ref').onclick=()=>document.getElementById('char-ref-input').click();
  document.getElementById('btn-clear-char-ref').onclick=()=>{
    editingCharRefB64=null;
    document.getElementById('char-ref-preview').innerHTML='🖼️';
  };
  document.getElementById('char-ref-input').onchange=async e=>{
    const f=e.target.files[0];if(!f) return;
    editingCharRefB64=await f2b(f);
    document.getElementById('char-ref-preview').innerHTML=`<img src="${editingCharRefB64}" style="width:100%;height:100%;object-fit:cover;border-radius:var(--rs)">`;
    e.target.value='';
  };
  document.getElementById('btn-close-chars').onclick=()=>closeModal('modal-chars');
  document.getElementById('btn-ai-gen').onclick=generatePromptWithAI;
  document.getElementById('tokens-toggle-hdr').onclick=()=>{
    const col=document.getElementById('tokens-collapsible');
    const icon=document.getElementById('tokens-toggle-icon');
    const open=col.style.display==='none';
    col.style.display=open?'':'none';
    icon.textContent=open?'▼':'▶';
    if(open) renderTokens(document.getElementById('token-search-input').value);
  };
  document.getElementById('btn-save-token').onclick=saveToken;
  document.getElementById('btn-cancel-token').onclick=()=>closeModal('modal-token');
  document.getElementById('token-search-input').oninput=e=>renderTokens(e.target.value);
  document.getElementById('token-text-input').onkeydown=e=>{if(e.key==='Enter') saveToken()};
  document.getElementById('styles-toggle-hdr').onclick=async()=>{
    const col=document.getElementById('styles-collapsible');
    const icon=document.getElementById('styles-toggle-icon');
    const open=col.style.display==='none';
    col.style.display=open?'':'none';
    icon.textContent=open?'▼':'▶';
    if(open){await seedStyles();renderStyleFilters();renderStyles(document.getElementById('style-search-input')?.value||'')}
  };
  document.getElementById('style-search-input').oninput=e=>renderStyles(e.target.value);
  document.getElementById('btn-save-style').onclick=saveStyle;
  document.getElementById('btn-delete-style').onclick=deleteStyle;
  document.getElementById('btn-cancel-style').onclick=()=>closeModal('modal-style');
  document.getElementById('btn-copy-prompt').onclick=()=>navigator.clipboard.writeText(buildPrompt()).then(()=>toast('已复制'));
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
  ['detail-prompt','detail-neg'].forEach(id=>{
    document.getElementById(id).oninput=()=>{
      document.getElementById('btn-save-detail-prompt').style.display='';
    };
  });
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
      S.masterLastImg=null;S.masterPendingImg=null;
      db.setSetting('masterLastImg',null);
      document.getElementById('master-img-preview').style.display='none';
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
    finally{btn.disabled=false;btn.textContent='✨ 分析偏好'}
  };
  document.getElementById('btn-master-send').onclick=async()=>{
    const input=document.getElementById('master-input');
    const text=input.value.trim();
    if(!text||S.masterBusy) return;
    S.masterBusy=true;input.value='';
    const imgB64=S.masterPendingImg||null;
    addMasterMsg('user',text,false,imgB64);
    const tmp=addMasterMsg('assistant','思考中...✨',true);
    try{const r=await masterSuggest(text);tmp.remove();addMasterMsg('assistant',r)}
    catch(e){tmp.remove();addMasterMsg('assistant','出错了：'+e.message)}
    finally{S.masterBusy=false}
  };
  document.getElementById('btn-inspire').onclick=()=>{
    const input=document.getElementById('master-input');
    input.value=_rollInspireDice();
    input.focus();
    toast('🎲 已填入，可编辑后发送');
  };
  document.getElementById('master-input').onkeydown=e=>{
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();document.getElementById('btn-master-send').click()}
  };
  document.getElementById('master-input').addEventListener('paste',async e=>{
    const item=Array.from(e.clipboardData.items).find(i=>i.type.startsWith('image/'));
    if(!item) return;
    e.preventDefault();
    const file=item.getAsFile();
    const reader=new FileReader();
    reader.onload=async ev=>{
      const b64=await _shrinkImg(ev.target.result,800,0.8);
      S.masterPendingImg=b64;
      const prev=document.getElementById('master-img-preview');
      prev.querySelector('img').src='data:image/jpeg;base64,'+b64;
      prev.style.display='flex';
    };
    reader.readAsDataURL(file);
  });
  document.getElementById('btn-master-img').onclick=()=>document.getElementById('master-img-input').click();
  document.getElementById('master-img-input').onchange=async e=>{
    const f=e.target.files[0];if(!f) return;
    e.target.value='';
    const reader=new FileReader();
    reader.onload=async ev=>{
      const b64=await _shrinkImg(ev.target.result,800,0.8);
      S.masterPendingImg=b64;
      const prev=document.getElementById('master-img-preview');
      prev.querySelector('img').src='data:image/jpeg;base64,'+b64;
      prev.style.display='flex';
    };
    reader.readAsDataURL(f);
  };
  document.getElementById('master-img-preview').querySelector('.preview-rm').onclick=()=>{
    S.masterPendingImg=null;
    document.getElementById('master-img-preview').style.display='none';
  };
  document.querySelectorAll('.modal-overlay').forEach(o=>o.addEventListener('click',e=>{if(e.target===o) o.style.display='none'}));
}

function _updateClearBtn(){
  const btn=document.getElementById('btn-clear-tasks');
  if(!btn) return;
  const hasTasks=document.getElementById('draw-results').children.length>0;
  btn.style.display=hasTasks?'':'none';
}

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
    const labelText=t.tplName?`📄 ${t.tplName} · ${t.n}张 · ${t.size}`:`🎨 ${t.n}张 · ${t.size}`;
    const styleLabel=t.styles&&t.styles.length?`<span class="draw-task-styles">${t.styles.map(s=>'🎨'+s.name).join(' ')}</span>`:'';
    const styleRefLabel=t.styleRefName?`<span class="draw-task-styles">🖼️ ${t.styleRefName}</span>`:'';
    taskWrap.innerHTML=`<div class="draw-task-header">
      <div class="draw-task-top">
        <span class="draw-task-label">${labelText}</span>
        ${styleLabel}${styleRefLabel}
        <span class="draw-task-status">✓ ${t.images.length}张完成</span>
        <div class="draw-task-btns">
          <button class="draw-task-reroll" title="用同样的prompt重roll">🔄 重roll</button>
          <button class="draw-task-copy" title="复制完整prompt">📋</button>
          <button class="draw-task-del" title="删除此卡片">✕</button>
        </div>
      </div>
      <div class="draw-task-prompt" title="点击展开完整 prompt">${promptShort}</div>
    </div><div class="draw-task-body"></div>`;
    const body=taskWrap.querySelector('.draw-task-body');
    for(const imgData of t.images){
      const wrap=document.createElement('div');wrap.className='result-image-wrapper';
      const img=document.createElement('img');img.src=imgData;img.className='result-image';img.style.cursor='zoom-in';
      img.onclick=()=>openLightbox(imgData);
      const acts=document.createElement('div');acts.className='result-actions';
      const bSave=document.createElement('button');bSave.className='btn-primary btn-sm';bSave.textContent='存图库';
      bSave.onclick=()=>{saveToGallery(imgData,t.prompt,t.negPrompt,t.size,t.styles);bSave.textContent='已存 ✓';bSave.style.pointerEvents='none'};
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
      const srOpts=S.styleRefs.map(sr=>`<option value="${sr.id}">🖼️ ${sr.name}</option>`).join('');
      const activeId=S.styleRefs.find(r=>r.name===t.styleRefName)?.id||'';
      const editDiv=document.createElement('div');
      editDiv.className='draw-task-edit';
      editDiv.innerHTML=`
        <div class="dte-row"><label>正向</label><textarea class="dte-pos" rows="3">${t.prompt}</textarea></div>
        <div class="dte-row"><label>负向</label><textarea class="dte-neg" rows="2">${t.negPrompt||''}</textarea></div>
        <div class="dte-row"><label>画风参考</label><select class="dte-styleref"><option value="">无</option>${srOpts}</select></div>
        <div class="dte-actions">
          <label class="dte-count-label">张数<input class="dte-count" type="number" min="1" max="20" value="${t.n}"></label>
          <button class="btn-primary btn-sm dte-confirm">🔄 确认重roll</button>
          <button class="btn-sm btn-outline dte-cancel">取消</button>
        </div>`;
      taskWrap.querySelector('.draw-task-header').after(editDiv);
      editDiv.querySelector('.dte-styleref').value=activeId;
      editDiv.querySelector('.dte-cancel').onclick=()=>editDiv.remove();
      editDiv.querySelector('.dte-confirm').onclick=()=>{
        const newPrompt=editDiv.querySelector('.dte-pos').value.trim();
        const newNeg=editDiv.querySelector('.dte-neg').value.trim();
        const newN=Math.max(1,Math.min(20,parseInt(editDiv.querySelector('.dte-count').value)||1));
        const newSrId=editDiv.querySelector('.dte-styleref').value;
        const oldSrImages=(S.styleRefs.find(r=>r.name===t.styleRefName)?.images)||[];
        const baseRefs=(t.refs||[]).filter(r=>!oldSrImages.includes(r));
        const newSr=S.styleRefs.find(r=>r.id===newSrId);
        const newRefs=newSr?[...baseRefs,...newSr.images]:baseRefs;
        editDiv.remove();
        _runDrawTask(newPrompt||t.prompt,newNeg,t.size,newN,newRefs,taskWrap,null,t.styles,newSr?.name||null);
      };
      editDiv.querySelector('.dte-pos').focus();
    };
    res.appendChild(taskWrap);
  }
  _updateClearBtn();
}

async function init(){
  await db.open();
  await seedTokens();
  loadCfg();
  await loadPersonas();
  await loadCharacters();
  await loadAestheticProfile();
  await loadStyleRefs();
  bindEvents();
  renderStyleRefStrip();
  await restoreTaskCards();
}
init().catch(console.error);

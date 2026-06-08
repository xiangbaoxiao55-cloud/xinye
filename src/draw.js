// ── DrawDB ──────────────────────────────────────────────────
class DrawDB {
  constructor(){this.db=null}
  open(){
    return new Promise((res,rej)=>{
      const r=indexedDB.open('DrawDB',1);
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
  selTokens:[],
  selRefCharIds:[],customRefB64s:[],
  curDetail:null,masterHistory:[],
  drawing:false,masterBusy:false,aiGenBusy:false,cfg:{},
  drawPresets:[],curDrawId:null,
  masterPresets:[],curMasterId:null,
};

let _galItems=[];
let _galShown=30;
const GAL_PAGE=30;

const CAT={
  quality:'质量/风格',character:'人物外形',outfit:'服装',
  scene:'场景',action:'动作/姿态',expression:'表情/情绪',
  lighting:'光影',camera:'镜头/构图',effect:'特效',other:'其他'
};

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
  return [base,tokenPart].filter(Boolean).join(', ');
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
  if(S.drawing) return;
  const prompt=buildPrompt();
  if(!prompt){toast('先在工作台生成或填写Prompt','warn');return}
  if(!S.drawPresets.length){toast('先在设置里添加画图API预设','warn');return}

  S.drawing=true;
  const btn=document.getElementById('btn-draw');
  btn.textContent='✦ 生成中...';btn.disabled=true;
  const res=document.getElementById('draw-results');
  res.innerHTML='<div class="loading-spinner"></div>';

  try{
    const negPrompt=(document.getElementById('neg-prompt').value||'').trim();
    const size=document.getElementById('param-size').value||'1024x1024';
    const n=parseInt(document.getElementById('param-count').value||'1');

    const presets=S.drawPresets;
    let startIdx=presets.findIndex(p=>p.id===S.curDrawId);
    if(startIdx<0) startIdx=0;
    let images,lastErr,successPreset;
    for(let i=0;i<presets.length;i++){
      const preset=presets[(startIdx+i)%presets.length];
      if(i>0 && preset.skipFallback) continue;
      try{
        if(i>0) toast(`"${presets[(startIdx+i-1)%presets.length].name}"失败，切备用"${preset.name}"...`,'warn');
        const _refs=getAllRefs();
        if(_refs.length) images=await _callEdits(preset,prompt,negPrompt,size,_refs,n);
        else if(preset.format==='chat') images=await _callChat(preset,prompt,n);
        else images=await _callGenerations(preset,prompt,negPrompt,size,n);
        successPreset=preset;break;
      }catch(err){lastErr=err;if(presets.length>1) console.warn(`[${ts()}] 预设"${preset.name}"失败:`,err.message)}
    }
    if(!images) throw lastErr||new Error('所有预设均失败');
    console.log(`[${ts()}] ✅ 出图成功 → "${successPreset?.name}" (${images.length}张)`);

    res.innerHTML='';
    for(const imgData of images){
      const wrap=document.createElement('div');
      wrap.className='result-image-wrapper';
      const img=document.createElement('img');
      img.src=imgData;img.className='result-image';
      const acts=document.createElement('div');
      acts.className='result-actions';
      const bSave=document.createElement('button');
      bSave.className='btn-primary btn-sm';bSave.textContent='存图库';
      bSave.onclick=()=>saveToGallery(imgData,prompt,negPrompt,size);
      const bDl=document.createElement('button');
      bDl.className='btn-outline btn-sm';bDl.textContent='下载';
      bDl.onclick=()=>dlImg(imgData);
      acts.append(bSave,bDl);wrap.append(img,acts);res.appendChild(wrap);
    }
    toast(`生成了 ${images.length} 张（${successPreset?.name}）✨`);
  }catch(err){
    res.innerHTML=`<div class="error-msg">❌ ${err.message}</div>`;
    toast(err.message,'error');
  }finally{
    S.drawing=false;btn.textContent='✦ 生成图片';btn.disabled=false;
  }
}

async function _callGenerations(preset,prompt,negPrompt,size,n){
  const {key,url,model}=preset;
  if(!key||!url) throw new Error(`预设"${preset.name}"未配置Key或URL`);
  console.log(`[${ts()}] → generations | ${preset.name} | ${size} | n=${n} | ${url}/images/generations\n         prompt: ${prompt.slice(0,80)}`);
  const body={model:model||'dall-e-3',prompt,n,size,response_format:'b64_json'};
  if(negPrompt) body.negative_prompt=negPrompt;
  const _ac=new AbortController();const _at=setTimeout(()=>_ac.abort(),1500000);
  const r=await fetch(`${url}/images/generations`,{
    method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${key}`},
    body:JSON.stringify(body),signal:_ac.signal
  }).finally(()=>clearTimeout(_at));
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

async function _callEdits(preset,prompt,negPrompt,size,refB64s,n){
  const {key,url,model}=preset;
  if(!key||!url) throw new Error(`预设"${preset.name}"未配置Key或URL`);
  console.log(`[${ts()}] → edits | ${preset.name} | ${size} | refs=${refB64s.length} | n=${n} | ${url}/images/edits\n         prompt: ${prompt.slice(0,80)}`);
  const fd=new FormData();
  for(let i=0;i<refB64s.length;i++){
    const raw=refB64s[i].replace(/^data:image\/\w+;base64,/,'');
    const bin=atob(raw);const bytes=new Uint8Array(bin.length);
    for(let j=0;j<bin.length;j++) bytes[j]=bin.charCodeAt(j);
    fd.append('image[]',new Blob([bytes],{type:'image/png'}),`ref${i}.png`);
  }
  fd.append('model',model||'dall-e-3');
  fd.append('prompt',prompt);fd.append('n',n);fd.append('size',size);
  if(negPrompt) fd.append('negative_prompt',negPrompt);
  const _ac=new AbortController();const _at=setTimeout(()=>_ac.abort(),1500000);
  const r=await fetch(`${url}/images/edits`,{
    method:'POST',headers:{'Authorization':`Bearer ${key}`},body:fd,signal:_ac.signal
  }).finally(()=>clearTimeout(_at));
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

async function saveToGallery(imageData,prompt,negPrompt,size){
  const p=S.personas.find(x=>x.id===S.curPersonaId);
  await db.put('gallery',{
    id:uid(),personaId:S.curPersonaId||null,personaName:p?.name||null,
    imageData,prompt,negPrompt,params:{size},rating:0,tags:[],createdAt:Date.now()
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
  const file=document.getElementById('gallery-import-file').files[0];
  if(!file){toast('请选择图片','warn');return}
  const imageData=await f2b(file);
  const prompt=document.getElementById('gallery-import-prompt').value.trim();
  const source=document.getElementById('gallery-import-source').value.trim();
  await db.put('gallery',{
    id:uid(),personaId:null,personaName:source||'外部导入',
    imageData,prompt,negPrompt:'',params:{size:'—'},rating:0,tags:[],createdAt:Date.now()
  });
  closeModal('modal-gallery-import');
  toast('图片已存入图库 ✨');
  _refreshPendingCount();
  if(document.getElementById('tab-gallery').classList.contains('active')) renderGallery();
}

function clearTokens(){
  S.selTokens=[];
  document.querySelectorAll('.token-tag.selected').forEach(el=>el.classList.remove('selected'));
  renderSelectedTokens();
}

async function _refreshPendingCount(){
  const allItems=await db.all('gallery');
  const pending=allItems.filter(i=>!S.allAnalyzedIds.has(i.id)).length;
  const el=document.getElementById('gallery-pending-label');
  if(el) el.textContent=pending>0?`${pending} 张待分析`:'';
}

const dlImg=url=>{const a=document.createElement('a');a.href=url;a.download=`draw_${Date.now()}.png`;a.click()};

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
      body:JSON.stringify({model:model||'claude-opus-4-7',system:sys?.content||'',messages:msgs,max_tokens:1024})
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
    body:JSON.stringify({model:model||'claude-opus-4-7',messages:oaiMsgs,max_tokens:1024,stream:false})
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
  return refs;
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
  if(!await db.getSetting('allAnalyzedIds_v2')){
    await db.setSetting('allAnalyzedIds',[]);
    await db.setSetting('allAnalyzedIds_v2',true);
  }
  S.allAnalyzedIds=new Set(await db.getSetting('allAnalyzedIds',[])||[]);
  S.masterHistory=await db.getSetting('masterHistory',[])||[];
  const el=document.getElementById('master-insight-content');
  if(el&&S.aestheticProfile) el.innerHTML=miniMd(S.aestheticProfile);
  const chat=document.getElementById('master-chat');
  if(chat&&S.masterHistory.length){
    for(const m of S.masterHistory){
      const div=document.createElement('div');
      div.className=`master-msg master-msg-${m.role}`;
      div.innerHTML=miniMd(m.content);
      const del=document.createElement('button');
      del.className='msg-del';del.textContent='✕';del.title='删除这条';
      del.onclick=e=>{e.stopPropagation();div.remove()};
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

  const _shrink=(dataUrl,maxDim=768,quality=0.7)=>new Promise(res=>{
    const img=new Image();img.onload=()=>{
      let{width:w,height:h}=img;
      if(w>maxDim||h>maxDim){const r=Math.min(maxDim/w,maxDim/h);w=Math.round(w*r);h=Math.round(h*r)}
      const c=document.createElement('canvas');c.width=w;c.height=h;
      c.getContext('2d').drawImage(img,0,0,w,h);
      res(c.toDataURL('image/jpeg',quality).replace(/^data:image\/\w+;base64,/,''));
    };img.src=dataUrl;
  });
  const imgBlocks=await Promise.all(sample.map(async g=>{
    const b64=await _shrink(g.imageData);
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

  S.aestheticProfile=result;
  await db.setSetting('aestheticProfile',result);
  document.getElementById('master-insight-content').innerHTML=miniMd(result);
  console.log('[审美档案] 已更新:\n'+result);
  toast(`审美档案已更新（分析${sample.length}张，${newCount}张新图）✨`);
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
  const msgs=[
    {role:'system',content:S.masterPersona?`${S.masterPersona}\n\n${_suggestBase}`:_suggestBase},
    ...S.masterHistory.slice(-10),
    {role:'user',content:`${ctx.join('\n')}\n\n用户想法：${userInput}`}
  ];
  const result=await callMaster(msgs);
  S.masterHistory.push({role:'user',content:userInput},{role:'assistant',content:result});
  if(S.masterHistory.length>20) S.masterHistory=S.masterHistory.slice(-20);
  db.setSetting('masterHistory',S.masterHistory);
  return result;
}

async function masterInspire(){
  const themes=['春日樱花','夏夜星空','秋日午后','冬雪温柔','梦幻森林','城市霓虹','古典庭院','海边黄昏','雨天咖啡馆','月光竹林'];
  const theme=themes[Math.floor(Math.random()*themes.length)];
  const ctx=S.aestheticProfile?`审美偏好：${S.aestheticProfile}`:'';
  const _inspireBase='善于创造充满诗意美感的画面，给出有创意的AI绘画方向。';
  const msgs=[
    {role:'system',content:S.masterPersona?`${S.masterPersona}\n\n${_inspireBase}`:_inspireBase},
    {role:'user',content:`主题「${theme}」${ctx?'，'+ctx:''}。给一个有创意的AI绘画方向。包括：场景氛围、构图想法、色彩建议、推荐prompt关键词5-8个英文词。中文描述，温柔诗意，100字内。`}
  ];
  return callMaster(msgs);
}

function miniMd(t){
  return t.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\n/g,'<br>');
}
function addMasterMsg(role,text,isTemp=false){
  const chat=document.getElementById('master-chat');
  const el=document.createElement('div');
  el.className=`master-msg master-msg-${role}${isTemp?' temp':''}`;
  el.innerHTML=miniMd(text);
  if(!isTemp){
    const del=document.createElement('button');
    del.className='msg-del';del.textContent='✕';del.title='删除这条';
    del.onclick=e=>{e.stopPropagation();el.remove()};
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
  const allItems=await db.all('gallery');
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
  grid.innerHTML='';
  if(!_galItems.length){grid.innerHTML='<div class="empty-state">还没有图片，去工作台画一张吧 ✨</div>';return}
  const analyzedSet=S.allAnalyzedIds;
  for(const item of _galItems.slice(0,_galShown)){
    const el=document.createElement('div');
    el.className='gallery-item';
    const badge=analyzedSet.size===0?''
      :analyzedSet.has(item.id)
        ?'<div class="gallery-badge analyzed">✓</div>'
        :'<div class="gallery-badge new-img">NEW</div>';
    el.innerHTML=`<img src="${item.imageData}" alt="">${badge}<div class="gallery-item-overlay"><span class="gallery-item-rating">${'⭐'.repeat(item.rating||0)}</span><span class="gallery-item-persona">${item.personaName||''}</span></div>`;
    el.addEventListener('click',()=>openDetail(item));
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
    tokens:[...S.selTokens],
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
      el.innerHTML=`<div class="template-name">${t.name}</div><div class="template-meta">${t.tokens?.length||0}个词条 · ${fmt(t.createdAt)}</div><div class="template-actions"></div>`;
      const bLoad=document.createElement('button');
      bLoad.className='btn-primary btn-sm';bLoad.textContent='载入';
      bLoad.onclick=()=>{
        S.selTokens=t.tokens?[...t.tokens]:[];
        if(t.prompt) document.getElementById('final-prompt-edit').value=t.prompt;
        if(t.negPrompt) document.getElementById('neg-prompt').value=t.negPrompt;
        if(t.size) document.getElementById('param-size').value=t.size;
        if(t.personaId) selectPersona(t.personaId);
        renderSelectedTokens();
        document.querySelectorAll('.token-tag').forEach(el=>el.classList.toggle('selected',S.selTokens.some(s=>s.id===el.dataset.id)));
        closeModal('modal-templates');toast('模版已载入 ✨');
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
function openDetail(item){
  S.curDetail=item;
  document.getElementById('detail-image').src=item.imageData;
  document.getElementById('detail-persona').textContent=item.personaName||'无模板';
  document.getElementById('detail-date').textContent=fmt(item.createdAt);
  document.getElementById('detail-prompt').value=item.prompt||'';
  document.getElementById('detail-neg').value=item.negPrompt||'';
  document.getElementById('detail-params').textContent=`尺寸：${item.params?.size||'—'}`;
  document.getElementById('btn-save-detail-prompt').style.display='none';
  renderStars(item.rating||0);
  renderDetailTags(item.tags||[]);
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
  S.selTokens=[];renderSelectedTokens();
  closeModal('modal-detail');toast('Prompt已载入工作台');
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
  const fmtRow=type==='draw'?`
    <div class="preset-row"><label>格式</label>
      <select data-f="format">
        <option value="images" ${preset.format!=='chat'?'selected':''}>images（标准）</option>
        <option value="chat" ${preset.format==='chat'?'selected':''}>chat（部分站子）</option>
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
  const cfg={
    _v:1,_app:'draw',_date:new Date().toISOString().slice(0,16).replace('T',' '),
    drawPresets:S.drawPresets,curDrawId:S.curDrawId,
    masterPresets:S.masterPresets,curMasterId:S.curMasterId,
    personas,curPersonaId:S.curPersonaId,
    customTokens,templates,
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
    if(cfg.templates?.length) for(const t of cfg.templates) await db.put('templates',t);
    savePresetsToLS();
    loadCfg();
    await loadPersonas();
    await renderTokens();
    renderDrawPresets();renderMasterPresets();
    toast(`配置已导入 ✓（${cfg._date||''}）`);
  }catch(e){toast('导入失败：'+e.message,'error')}
}

// ── Tab & Modal ───────────────────────────────────────────────
function switchTab(tab){
  document.querySelectorAll('.nav-tab').forEach(el=>el.classList.toggle('active',el.dataset.tab===tab));
  document.querySelectorAll('.tab-pane').forEach(el=>el.classList.toggle('active',el.id===`tab-${tab}`));
  if(tab==='gallery') renderGallery();
}
const closeModal=id=>{document.getElementById(id).style.display='none'};

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
  document.getElementById('btn-add-draw-preset').onclick=addDrawPreset;
  document.getElementById('btn-add-master-preset').onclick=addMasterPreset;
  document.getElementById('btn-clear-master-chat').onclick=()=>{
    if(confirm('清空大师对话？')) {
      document.getElementById('master-chat').innerHTML='';
      S.masterHistory=[];
      db.setSetting('masterHistory',[]);
    }
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
    addMasterMsg('user',text);
    const tmp=addMasterMsg('assistant','思考中...✨',true);
    try{const r=await masterSuggest(text);tmp.remove();addMasterMsg('assistant',r)}
    catch(e){tmp.remove();addMasterMsg('assistant','出错了：'+e.message)}
    finally{S.masterBusy=false}
  };
  document.getElementById('btn-inspire').onclick=async()=>{
    if(S.masterBusy) return;S.masterBusy=true;
    const tmp=addMasterMsg('assistant','💡 寻找灵感中...✨',true);
    try{const r=await masterInspire();tmp.remove();addMasterMsg('assistant','💡 今日灵感\n\n'+r)}
    catch(e){tmp.remove();addMasterMsg('assistant','出错了：'+e.message)}
    finally{S.masterBusy=false}
  };
  document.getElementById('master-input').onkeydown=e=>{
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();document.getElementById('btn-master-send').click()}
  };
  document.querySelectorAll('.modal-overlay').forEach(o=>o.addEventListener('click',e=>{if(e.target===o) o.style.display='none'}));
}

async function init(){
  await db.open();
  await seedTokens();
  loadCfg();
  await loadPersonas();
  await loadCharacters();
  await loadAestheticProfile();
  bindEvents();
}
init().catch(console.error);

import { settings, saveSettings } from './state.js';

// ── 6维标签库（已过滤重口/血腥/严重羞辱） ────────────────────────────────
const DIMS = [
  { id: 'position', name: '体位', tags: [
    '69式','口交·吹','口交·舔穴','深喉','坐脸','舔后穴','舔耳','手交','手指插穴','后穴手指',
    '阴道性交','肛交','腿交','乳交','足交','磨蹭','骑乘','前列腺按摩','双龙入洞','无套',
    '含着不动','互相手淫','成结','传教士','后入','侧入','反向骑乘','站立式','折叠按压',
    '驛弁','趴压','莲花位','剪刀脚','椅子位','抬腿扛肩','蹲骑','打桩机','推车',
    '面对面站立','浴缸骑乘','膝盖上','壁尻','背后抱立'
  ]},
  { id: 'scenario', name: '场景', tags: [
    '桌上','地板上','抵在墙上','浴缸里','车震','厨房里','镜子前','户外','公共场所','半公开场',
    '淋浴间','电车','被撞见','被看着','远程性爱','电话做爱','色情短信','电梯里','更衣室',
    '图书馆','办公室','教室','酒店房间','楼梯间','电影院','后台/化妆间','飞机厕所','储藏间',
    '温泉','泳池','洗手间隔间','衣帽间','阳台','停车场','屋顶','小巷','雨中','森林/野外',
    '海边/沙滩','帐篷里','废墟','停电中','暴风雨天','倒计时','来客中','通话中','视频会议中',
    '工作中','清晨刚醒','晨炮','久别重逢','経期','排卵日','KTV包厢','地下室',
    '深夜便利店','教堂','雪屋·小木屋'
  ]},
  { id: 'props', name: '道具', tags: [
    '口塞','蒙眼','肛塞','肛珠','假阳具','羽毛','冰块','蜡烛','乳夹','分腿器',
    '震动棒','跳蛋','手铐','散鞭','绳','项圈','牵绳','阴茎笼','阴茎环','穿戴式',
    '皮带','领带','围巾','束腰','尾巴肛塞','口枷','吸乳器','阴蒂吸吮器',
    '弹力绳拍','衣夹','薄荷油','震动子弹','双头假阳','抽插机器',
    '巧克力酱','蜂蜜','奶油','水果','棒棒糖','冰棒',
    '女装','乳胶衣','皮革','情趣内衣','女仆装','丝袜','泳装','旗袍','軍装',
    '体操服','网袜','口红','牙刷','电动牙刷'
  ]},
  { id: 'roleplay', name: '设定', tags: [
    '合意强制','daddy癖','主从关系','权力不对等','宠物play','小猫play','小狗play','马驹play',
    '发情期','催眠','痴女','姐弟','妈妈','爸爸','老师','上司','处女癖','第一次',
    '制服play','着装play','傲娇','病娇','執着','逆強','女攻','扶她/双性',
    '性転','身体互换','時間停止','百合','孕/怀孕','三人行','让你怀孕',
    '監視','吸血鬼×人类','审讯官×囚犯','皇帝×臣','房东×租客','教练×运动员',
    '摄影师×模特','画家×模特','客人×服务员','快递员×收件人','修理工','邻居',
    '陌生人/一夜情','前任','青梅竹马','债主×欠债者','司机×乘客','偶像×粉丝',
    '管家×主人','神父×信徒','黑帮','海盗','骑士×公主','古代宫廷','民国/旧上海',
    '维多利亚时代','战时','末世','监狱','校园','异世界','地下组织',
    '背德/禁忌关系','上下级恋爱','假装情侣','已婚出轨','知道是错的但停不下来',
    '交易性关系','复仇','替身/影武者','修女','巫女','护士','AI×人类','时间循环'
  ]},
  { id: 'physical', name: '身体', tags: [
    '怒操','粗暴操','温柔做','懒洋洋地做','激情做','慢慢做','速战速决','马拉松做爱',
    '咬','打屁股','揪头发','抓挠留痕','留痕','淤青/痕迹','吮痕','挠痒',
    '束缚','绳缚','温度play','感官play','感官剥夺',
    '同时高潮','连续高潮','干高潮','强制高潮','寸止','过度刺激','刺激到哭',
    '高潮控制','禁止高潮','毁掉的高潮','潮吹',
    '中出','颜射','灌种','种付癖','精液play','吞精','精液标记','精液嘴对嘴',
    '大量射精','连续射精','精液浴','倒数射精','射精管理','射精禁止','男性潮吹','榨精','逆榨精',
    '口水癖','唾液','母乳','母乳喷射','扩张','玩奶头',
    '交配','脑子操坏了','催情剂','春药','大腿舞','事后照顾','吸血',
    '衣服里藏玩具','按摩','做爱时拍照','录像','半穿着操','一方穿一方脱','纹身癖'
  ]},
  { id: 'mental', name: '精神', tags: [
    'BDSM','贞操控制','鸡巴崇拜','主导方','模糊同意','纯洁癖','受虐癖','施虐癖',
    '疼痛癖','权力关系','夸奖癖','两难束缚','惩罚','奖励',
    'sub低落','臣服方','sub空间','top低落','服务型臣服','驯服brat',
    '说骚话','羞辱','身体崇拜','崇拜','自由使用','标记/宣示所有权',
    '宠溺','占有欲操','仇恨操','吃醋后操','和好炮','忍不住就地操','边哭边操','求饶',
    '窥视癖','露出','偷拍','睡眠诱导','自慰指示','ASMR','双耳录音',
    '条件反射训练','服从测试','心理倒错','不许看·看着我','暗示'
  ]}
];

const FORTUNE_CUSTOM_KEY = 'fortuneCustomTags';
const FORTUNE_HISTORY_KEY = () => (window.__APP_ID__ === 'choubao' ? 'choubao' : 'xinye') + '_fortuneHistory';

function _getCustomTags() {
  return settings[FORTUNE_CUSTOM_KEY] || {};
}

function _saveCustomTags(obj) {
  settings[FORTUNE_CUSTOM_KEY] = obj;
  saveSettings();
}

function _getAllTags(dimId) {
  const dim = DIMS.find(d => d.id === dimId);
  if (!dim) return [];
  const custom = _getCustomTags()[dimId] || [];
  return [...dim.tags, ...custom];
}

// ── 随机转盘 ──────────────────────────────────────────────────────────
export function spinFortune(activeDimIds) {
  const dims = activeDimIds
    ? DIMS.filter(d => activeDimIds.includes(d.id))
    : DIMS;
  const result = {};
  for (const dim of dims) {
    const tags = _getAllTags(dim.id);
    if (tags.length) result[dim.id] = { name: dim.name, tag: tags[Math.floor(Math.random() * tags.length)] };
  }
  _saveHistory(result);
  return result;
}

export function formatFortuneResult(result) {
  return Object.values(result).map(r => `${r.name}：${r.tag}`).join(' · ');
}

function _saveHistory(result) {
  try {
    const key = FORTUNE_HISTORY_KEY();
    const history = JSON.parse(localStorage.getItem(key) || '[]');
    history.unshift({ time: Date.now(), result });
    if (history.length > 100) history.length = 100;
    localStorage.setItem(key, JSON.stringify(history));
  } catch {}
}

// ── UI 浮层 ───────────────────────────────────────────────────────────
let _overlay = null;

export function showFortuneWheel(onSendToChat) {
  if (_overlay) return;

  const overlay = document.createElement('div');
  overlay.className = 'fortune-overlay';
  _overlay = overlay;

  const panel = document.createElement('div');
  panel.className = 'fortune-panel';

  const title = document.createElement('div');
  title.className = 'fortune-title';
  title.textContent = '🎰 命运转盘';
  panel.appendChild(title);

  const dimToggles = document.createElement('div');
  dimToggles.className = 'fortune-dim-toggles';
  const activeDims = new Set(DIMS.map(d => d.id));
  for (const dim of DIMS) {
    const chip = document.createElement('button');
    chip.className = 'fortune-dim-chip active';
    chip.textContent = dim.name;
    chip.dataset.dimId = dim.id;
    chip.onclick = () => {
      if (activeDims.has(dim.id)) { activeDims.delete(dim.id); chip.classList.remove('active'); }
      else { activeDims.add(dim.id); chip.classList.add('active'); }
    };
    dimToggles.appendChild(chip);
  }
  panel.appendChild(dimToggles);

  const cardsWrap = document.createElement('div');
  cardsWrap.className = 'fortune-cards';
  panel.appendChild(cardsWrap);

  const btnRow = document.createElement('div');
  btnRow.className = 'fortune-btn-row';

  const btnSpin = document.createElement('button');
  btnSpin.className = 'fortune-btn fortune-btn-spin';
  btnSpin.textContent = '🎰 转！';
  btnSpin.onclick = () => _doSpin(cardsWrap, activeDims, btnSend);
  btnRow.appendChild(btnSpin);

  const btnSend = document.createElement('button');
  btnSend.className = 'fortune-btn fortune-btn-send';
  btnSend.textContent = '💬 发给聊天';
  btnSend.disabled = true;
  btnSend.onclick = () => {
    if (btnSend._result && onSendToChat) {
      onSendToChat(btnSend._result);
      _closeFortune();
    }
  };
  btnRow.appendChild(btnSend);

  panel.appendChild(btnRow);

  const btnRow2 = document.createElement('div');
  btnRow2.className = 'fortune-btn-row';

  const btnTags = document.createElement('button');
  btnTags.className = 'fortune-btn fortune-btn-tags';
  btnTags.textContent = '⚙️ 管理标签';
  btnTags.onclick = () => _showTagManager(panel);
  btnRow2.appendChild(btnTags);

  const btnHistory = document.createElement('button');
  btnHistory.className = 'fortune-btn fortune-btn-history';
  btnHistory.textContent = '📜 历史';
  btnHistory.onclick = () => _showHistory(panel);
  btnRow2.appendChild(btnHistory);

  const btnClose = document.createElement('button');
  btnClose.className = 'fortune-btn fortune-btn-close';
  btnClose.textContent = '✕ 关闭';
  btnClose.onclick = _closeFortune;
  btnRow2.appendChild(btnClose);

  panel.appendChild(btnRow2);
  overlay.appendChild(panel);

  overlay.addEventListener('click', e => { if (e.target === overlay) _closeFortune(); });
  document.body.appendChild(overlay);

  setTimeout(() => _doSpin(cardsWrap, activeDims, btnSend), 300);
}

function _closeFortune() {
  if (_overlay) {
    _overlay.classList.add('hiding');
    setTimeout(() => { _overlay?.remove(); _overlay = null; }, 350);
  }
}

function _doSpin(container, activeDims, btnSend) {
  const ids = [...activeDims];
  if (!ids.length) return;
  const result = spinFortune(ids);
  btnSend._result = result;
  btnSend.disabled = false;

  container.innerHTML = '';
  const entries = Object.entries(result);
  entries.forEach(([, val], i) => {
    const card = document.createElement('div');
    card.className = 'fortune-card';
    card.style.animationDelay = `${i * 0.15}s`;

    const label = document.createElement('div');
    label.className = 'fortune-card-label';
    label.textContent = val.name;
    card.appendChild(label);

    const tag = document.createElement('div');
    tag.className = 'fortune-card-tag';
    tag.textContent = val.tag;
    card.appendChild(tag);

    container.appendChild(card);
  });
}

// ── 标签管理（显示全部：内置+自定义） ──────────────────────────────────
function _showTagManager(panel) {
  let mgr = panel.querySelector('.fortune-tag-mgr');
  if (mgr) { mgr.remove(); return; }

  panel.querySelector('.fortune-history-panel')?.remove();

  mgr = document.createElement('div');
  mgr.className = 'fortune-tag-mgr';

  const mgrTitle = document.createElement('div');
  mgrTitle.className = 'fortune-mgr-title';
  mgrTitle.textContent = '标签管理';
  mgr.appendChild(mgrTitle);

  const dimSelect = document.createElement('select');
  dimSelect.className = 'fortune-dim-select';
  for (const dim of DIMS) {
    const opt = document.createElement('option');
    opt.value = dim.id;
    opt.textContent = `${dim.name}（内置${dim.tags.length} + 自定义${(_getCustomTags()[dim.id] || []).length}）`;
    dimSelect.appendChild(opt);
  }
  mgr.appendChild(dimSelect);

  const addRow = document.createElement('div');
  addRow.className = 'fortune-add-row';
  const addInput = document.createElement('input');
  addInput.className = 'fortune-add-input';
  addInput.placeholder = '输入新标签…';
  addRow.appendChild(addInput);
  const addBtn = document.createElement('button');
  addBtn.className = 'fortune-btn';
  addBtn.textContent = '+ 添加';
  addBtn.onclick = () => {
    const val = addInput.value.trim();
    if (!val) return;
    const custom = _getCustomTags();
    const dimId = dimSelect.value;
    if (!custom[dimId]) custom[dimId] = [];
    if (custom[dimId].includes(val) || DIMS.find(d => d.id === dimId)?.tags.includes(val)) return;
    custom[dimId].push(val);
    _saveCustomTags(custom);
    addInput.value = '';
    _renderAllTagsList(tagList, dimId, () => _updateDimSelectLabel(dimSelect, dimId));
    _updateDimSelectLabel(dimSelect, dimId);
  };
  addRow.appendChild(addBtn);
  mgr.appendChild(addRow);

  const tagList = document.createElement('div');
  tagList.className = 'fortune-tag-list';
  mgr.appendChild(tagList);

  const _renderAll = () => {
    _renderAllTagsList(tagList, dimSelect.value, () => _updateDimSelectLabel(dimSelect, dimSelect.value));
  };
  dimSelect.onchange = _renderAll;
  _renderAll();

  panel.appendChild(mgr);
}

function _renderAllTagsList(container, dimId, onCustomChange) {
  const dim = DIMS.find(d => d.id === dimId);
  if (!dim) return;
  const custom = (_getCustomTags()[dimId] || []).slice();
  const builtIn = dim.tags;
  container.innerHTML = '';

  for (const tag of builtIn) {
    const row = document.createElement('div');
    row.className = 'fortune-tag-row fortune-tag-builtin';
    const span = document.createElement('span');
    span.textContent = tag;
    row.appendChild(span);
    const badge = document.createElement('span');
    badge.className = 'fortune-tag-badge';
    badge.textContent = '内置';
    row.appendChild(badge);
    container.appendChild(row);
  }
  for (const tag of custom) {
    const row = document.createElement('div');
    row.className = 'fortune-tag-row fortune-tag-custom';
    const span = document.createElement('span');
    span.textContent = tag;
    row.appendChild(span);
    const badge = document.createElement('span');
    badge.className = 'fortune-tag-badge';
    badge.textContent = '自定义';
    row.appendChild(badge);
    const del = document.createElement('button');
    del.className = 'fortune-del-btn';
    del.textContent = '✕';
    del.onclick = () => {
      const c = _getCustomTags();
      c[dimId] = (c[dimId] || []).filter(t => t !== tag);
      _saveCustomTags(c);
      _renderAllTagsList(container, dimId, onCustomChange);
      if (onCustomChange) onCustomChange();
    };
    row.appendChild(del);
    container.appendChild(row);
  }
  if (!builtIn.length && !custom.length) {
    container.innerHTML = '<div class="fortune-empty">该维度暂无标签</div>';
  }
}

function _updateDimSelectLabel(select, dimId) {
  const opt = select.querySelector(`option[value="${dimId}"]`);
  const dim = DIMS.find(d => d.id === dimId);
  if (opt && dim) {
    opt.textContent = `${dim.name}（内置${dim.tags.length} + 自定义${(_getCustomTags()[dimId] || []).length}）`;
  }
}

// ── 历史 ──────────────────────────────────────────────────────────────
function _showHistory(panel) {
  let hp = panel.querySelector('.fortune-history-panel');
  if (hp) { hp.remove(); return; }

  panel.querySelector('.fortune-tag-mgr')?.remove();

  hp = document.createElement('div');
  hp.className = 'fortune-history-panel';

  const hTitle = document.createElement('div');
  hTitle.className = 'fortune-mgr-title';
  hTitle.textContent = '转盘历史';
  hp.appendChild(hTitle);

  const history = JSON.parse(localStorage.getItem(FORTUNE_HISTORY_KEY()) || '[]');
  if (!history.length) {
    hp.innerHTML += '<div class="fortune-empty">还没转过~</div>';
  } else {
    for (const entry of history.slice(0, 30)) {
      const row = document.createElement('div');
      row.className = 'fortune-history-row';
      const time = new Date(entry.time);
      const ts = `${(time.getMonth()+1).toString().padStart(2,'0')}/${time.getDate().toString().padStart(2,'0')} ${time.getHours().toString().padStart(2,'0')}:${time.getMinutes().toString().padStart(2,'0')}`;
      row.innerHTML = `<span class="fortune-history-time">${ts}</span><span class="fortune-history-tags">${formatFortuneResult(entry.result)}</span>`;
      hp.appendChild(row);
    }
  }

  const clearBtn = document.createElement('button');
  clearBtn.className = 'fortune-btn';
  clearBtn.textContent = '🗑️ 清空历史';
  clearBtn.style.marginTop = '8px';
  clearBtn.onclick = () => {
    localStorage.removeItem(FORTUNE_HISTORY_KEY());
    hp.remove();
  };
  hp.appendChild(clearBtn);

  panel.appendChild(hp);
}

// ── 给 chat.js 的接口 ────────────────────────────────────────────────
export function getDimensions() {
  return DIMS.map(d => ({ id: d.id, name: d.name, count: _getAllTags(d.id).length }));
}

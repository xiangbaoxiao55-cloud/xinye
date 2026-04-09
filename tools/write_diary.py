
content = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>&#23567;&#26085;&#35760;</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #fdf8f4; --bg2: #faf3ed; --card: #ffffff; --border: #efe5dc;
  --coral: #e0897d; --coral-light: #fce8e4; --coral-mid: #f5aba0;
  --pink: #f48fb1; --pink-light: #fde0ee;
  --text: #3a2820; --text-mid: #7a5f55; --text-light: #b8a098;
  --shadow: 0 2px 18px rgba(160,90,70,0.08);
  --shadow-sm: 0 1px 8px rgba(160,90,70,0.06);
  --radius: 18px; --radius-sm: 12px; --tab-h: 62px; --header-h: 54px;
}
html, body { height: 100%; height: 100svh; font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif; background: var(--bg); color: var(--text); overflow: hidden; }
.app { display: flex; flex-direction: column; height: 100%; height: 100svh; }

/* Header */
.header { height: var(--header-h); display: flex; align-items: center; padding: 0 14px; gap: 10px; background: var(--bg); border-bottom: 1px solid var(--border); flex-shrink: 0; z-index: 20; }
.btn-back { width: 38px; height: 38px; border-radius: 50%; background: var(--coral-light); border: none; color: var(--coral); font-size: 18px; cursor: pointer; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-weight: 700; line-height: 1; }
.btn-back:active { background: var(--coral-mid); color: #fff; }
.header-title { flex: 1; font-size: 16px; font-weight: 700; color: var(--text); }
.btn-icon-sm { width: 38px; height: 38px; border-radius: 50%; border: 1.5px solid var(--border); background: var(--card); color: var(--text-mid); font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.btn-icon-sm.active { background: var(--coral-light); border-color: var(--coral); color: var(--coral); }

/* Search */
.search-wrap { background: var(--bg); padding: 8px 14px 10px; border-bottom: 1px solid var(--border); flex-shrink: 0; display: none; }
.search-wrap.show { display: block; }
.search-input { width: 100%; padding: 9px 16px; border: 1.5px solid var(--border); border-radius: 22px; font-size: 14px; font-family: inherit; background: var(--card); color: var(--text); outline: none; }
.search-input:focus { border-color: var(--coral); }

/* Panels */
.panels { flex: 1; overflow: hidden; position: relative; }
.panel { position: absolute; inset: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 14px 14px 24px; display: none; }
.panel.active { display: block; }
.panel::-webkit-scrollbar { width: 3px; }
.panel::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

/* Tab bar */
.tab-bar { display: flex; height: var(--tab-h); background: var(--card); border-top: 1px solid var(--border); flex-shrink: 0; padding-bottom: env(safe-area-inset-bottom, 0); }
.tab-btn { flex: 1; border: none; background: none; cursor: pointer; font-family: inherit; font-size: 13px; color: var(--text-light); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; }
.tab-icon { font-size: 20px; line-height: 1; }
.tab-btn.active { color: var(--coral); }
.tab-btn.active.tab-xinye { color: var(--pink); }

/* Cards */
.card { background: var(--card); border-radius: var(--radius); box-shadow: var(--shadow); padding: 16px 18px; margin-bottom: 12px; }
.card-label { font-size: 11px; font-weight: 700; color: var(--text-light); letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 12px; }

/* Date nav */
.date-nav-row { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 10px; }
.nav-btn { width: 36px; height: 36px; border-radius: 50%; background: var(--card); border: 1.5px solid var(--border); color: var(--text-mid); cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; box-shadow: var(--shadow-sm); font-weight: 600; line-height: 1; }
.nav-btn:active { background: var(--coral-light); border-color: var(--coral); color: var(--coral); }
.date-center { text-align: center; cursor: pointer; padding: 4px 8px; border-radius: 10px; }
.date-center:active { background: var(--coral-light); }
.date-main { font-size: 16px; font-weight: 700; color: var(--text); }
.date-sub { font-size: 12px; color: var(--text-light); margin-top: 1px; }
.today-chip { display: inline-block; background: var(--coral); color: #fff; font-size: 11px; padding: 3px 12px; border-radius: 20px; cursor: pointer; margin-bottom: 12px; }
input#datePicker { position: absolute; opacity: 0; pointer-events: none; width: 0; height: 0; }

/* Mood */
.mood-row { display: flex; gap: 6px; flex-wrap: wrap; }
.mood-btn { flex: 1; min-width: 54px; border: 1.5px solid var(--border); border-radius: 12px; padding: 8px 4px; font-size: 12px; cursor: pointer; background: var(--bg); color: var(--text-mid); font-family: inherit; text-align: center; line-height: 1.4; }
.mood-btn .mood-em { font-size: 18px; display: block; margin-bottom: 2px; }
.mood-btn:active { border-color: var(--coral); }
.mood-btn.selected { background: var(--coral-light); border-color: var(--coral); color: var(--coral); font-weight: 600; }

/* Diary area */
.diary-area { width: 100%; border: 1.5px solid var(--border); border-radius: var(--radius-sm); padding: 14px 16px; font-size: 15px; font-family: inherit; color: var(--text); background: var(--bg2); outline: none; resize: none; min-height: 160px; line-height: 1.85; display: block; }
.diary-area:focus { border-color: var(--coral); background: var(--bg); }
.autosave-row { display: flex; align-items: center; justify-content: flex-end; margin-top: 8px; min-height: 18px; }
.autosave-hint { font-size: 12px; color: var(--text-light); }
.autosave-hint.flash { color: var(--coral); }

/* Thoughts */
.thought-input-row { display: flex; gap: 8px; margin-bottom: 10px; }
.thought-input { flex: 1; border: 1.5px solid var(--border); border-radius: var(--radius-sm); padding: 10px 14px; font-size: 14px; font-family: inherit; color: var(--text); background: var(--bg2); outline: none; }
.thought-input:focus { border-color: var(--coral); }
.thought-save-btn { background: var(--coral); color: #fff; border: none; border-radius: var(--radius-sm); padding: 10px 16px; font-size: 15px; cursor: pointer; font-family: inherit; white-space: nowrap; }
.thought-save-btn:active { opacity: 0.75; }
.thought-cards { display: flex; flex-direction: column; gap: 8px; }
.thought-card { background: var(--bg2); border-radius: var(--radius-sm); padding: 11px 14px; border-left: 3px solid var(--coral-light); display: flex; gap: 10px; align-items: flex-start; }
.thought-card-body { flex: 1; }
.thought-card-text { font-size: 14px; line-height: 1.65; color: var(--text); white-space: pre-wrap; word-break: break-word; }
.thought-card-meta { font-size: 11px; color: var(--text-light); margin-top: 4px; }
.thought-del { background: none; border: none; color: var(--text-light); cursor: pointer; font-size: 16px; padding: 2px 4px; line-height: 1; flex-shrink: 0; }
.thought-del:active { color: var(--coral); }
.no-thoughts { font-size: 13px; color: var(--text-light); padding: 4px 0; }

/* On this day */
.otd-empty { font-size: 13px; color: var(--text-light); padding: 4px 0; }
.otd-items { display: flex; flex-direction: column; gap: 8px; }
.otd-item { background: var(--bg2); border-radius: var(--radius-sm); padding: 12px 14px; border-left: 3px solid var(--border); cursor: pointer; }
.otd-item:active { border-left-color: var(--coral-mid); }
.otd-item-year { font-size: 11px; color: var(--text-light); margin-bottom: 5px; font-weight: 600; }
.otd-item-text { font-size: 14px; line-height: 1.6; color: var(--text-mid); white-space: pre-wrap; word-break: break-word; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }

/* Export strip */
.export-strip { display: flex; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
.btn-exp { background: var(--card); border: 1.5px solid var(--border); border-radius: 22px; padding: 8px 16px; font-size: 13px; color: var(--text-mid); cursor: pointer; font-family: inherit; box-shadow: var(--shadow-sm); }
.btn-exp:active { border-color: var(--coral); color: var(--coral); }

/* Timeline */
.tl-entry { background: var(--card); border-radius: var(--radius); box-shadow: var(--shadow); padding: 15px 18px; margin-bottom: 10px; cursor: pointer; }
.tl-entry-date { font-size: 12px; color: var(--text-light); display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.tl-entry-preview { font-size: 14px; line-height: 1.65; color: var(--text); white-space: pre-wrap; word-break: break-word; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; }
.tl-entry-meta { font-size: 12px; color: var(--text-light); margin-top: 5px; }
.tl-empty { text-align: center; color: var(--text-light); padding: 50px 0; font-size: 14px; }
mark { background: #ffdcc8; border-radius: 3px; padding: 0 1px; }

/* Xinye */
.xinye-banner { text-align: center; padding: 6px 0 16px; font-size: 16px; font-weight: 700; color: var(--pink); }
.xinye-entry { background: var(--card); border-radius: var(--radius); box-shadow: var(--shadow); padding: 16px 18px; margin-bottom: 10px; border-left: 4px solid #f8bbd0; }
.xinye-entry-date { font-size: 12px; color: var(--pink); margin-bottom: 8px; font-weight: 600; }
.xinye-entry-text { font-size: 14px; line-height: 1.85; color: var(--text); white-space: pre-wrap; word-break: break-word; }
.xinye-entry-preview { font-size: 14px; line-height: 1.65; color: var(--text); white-space: pre-wrap; word-break: break-word; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; }
.xinye-entry-expand { background: none; border: none; font-size: 12px; color: var(--pink); cursor: pointer; padding: 4px 0 0; }
.xinye-empty { text-align: center; color: var(--text-light); padding: 50px 0; font-size: 14px; }
/* Dual view (same-day) */
.dual-card { background: var(--card); border-radius: var(--radius); box-shadow: var(--shadow); padding: 16px 18px; margin-bottom: 12px; border-left: 4px solid #f8bbd0; display: none; }
.dual-card-label { font-size: 11px; font-weight: 700; color: var(--pink); letter-spacing: 0.08em; margin-bottom: 10px; }
.dual-card-text { font-size: 14px; line-height: 1.85; color: var(--text); white-space: pre-wrap; word-break: break-word; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 5; -webkit-box-orient: vertical; }
.dual-card-link { background: none; border: none; font-size: 12px; color: var(--pink); cursor: pointer; padding: 6px 0 0; display: block; }

/* Xinye edit */
.xinye-edit-card { background: var(--card); border-radius: var(--radius); box-shadow: var(--shadow); padding: 16px 18px; margin-bottom: 12px; }
.xinye-edit-row { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }
.xinye-edit-date { flex: 1; border: 1.5px solid var(--border); border-radius: var(--radius-sm); padding: 9px 12px; font-size: 14px; font-family: inherit; color: var(--text); background: var(--bg2); outline: none; }
.xinye-edit-date:focus { border-color: var(--pink); }
.xinye-save-btn2 { background: var(--pink); color: #fff; border: none; border-radius: var(--radius-sm); padding: 9px 16px; font-size: 14px; cursor: pointer; font-family: inherit; white-space: nowrap; }
.xinye-save-btn2:active { opacity: 0.75; }
.xinye-entry-btns { display: flex; gap: 6px; margin-top: 8px; }
.xinye-entry-edit { background: var(--pink-light); color: var(--pink); border: none; border-radius: 8px; padding: 4px 10px; font-size: 12px; cursor: pointer; font-family: inherit; }
.xinye-entry-del { background: none; color: var(--text-light); border: none; border-radius: 8px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.xinye-entry-del:active { color: var(--coral); }

/* Export modal */
.export-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 9990; display: none; align-items: flex-end; justify-content: center; }
.export-modal-overlay.show { display: flex; }
.export-modal { background: var(--card); border-radius: 22px 22px 0 0; padding: 20px 18px 32px; width: 100%; max-width: 540px; display: flex; flex-direction: column; gap: 10px; }
.export-modal-title { font-size: 14px; font-weight: 700; color: var(--text); }
.export-modal-ta { flex: 1; border: 1.5px solid var(--border); border-radius: 12px; padding: 10px 12px; font-size: 12px; font-family: monospace; color: var(--text-mid); background: var(--bg2); resize: none; height: 180px; outline: none; }
.export-modal-hint { font-size: 12px; color: var(--text-light); line-height: 1.5; }
.export-modal-btns { display: flex; gap: 8px; flex-wrap: wrap; }
.btn-modal-dl { flex: 1; background: var(--coral); color: #fff; border: none; border-radius: 12px; padding: 12px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; min-width: 80px; }
.btn-modal-copy { flex: 1; background: var(--bg2); color: var(--text-mid); border: 1.5px solid var(--border); border-radius: 12px; padding: 12px; font-size: 14px; cursor: pointer; font-family: inherit; min-width: 80px; }
.btn-modal-close { background: var(--bg2); color: var(--text-light); border: none; border-radius: 12px; padding: 12px 14px; font-size: 14px; cursor: pointer; font-family: inherit; }

#toast { position: fixed; bottom: calc(var(--tab-h) + 12px); left: 50%; transform: translateX(-50%); background: #3a2820; color: #fff; padding: 8px 18px; border-radius: 22px; font-size: 13px; z-index: 9999; opacity: 0; transition: opacity 0.25s; pointer-events: none; white-space: nowrap; }
#toast.show { opacity: 1; }

@media (min-width: 600px) {
  .app { max-width: 600px; margin: 0 auto; border-left: 1px solid var(--border); border-right: 1px solid var(--border); }
}
</style>
</head>
<body>
<input type="date" id="datePicker" onchange="onDatePicked()"/>
<div id="toast"></div>

<!-- Export modal (for mobile fallback) -->
<div class="export-modal-overlay" id="exportModalOverlay">
  <div class="export-modal">
    <div class="export-modal-title">&#x1F4E6; &#22791;&#20221;&#25968;&#25454;</div>
    <textarea class="export-modal-ta" id="exportTA" readonly></textarea>
    <div class="export-modal-hint">&#25163;&#26426;&#31471;&#65306;&#38271;&#25353;&#25991;&#26412;&#20840;&#36873; &#8594; &#22797;&#21046;&#65292;&#20445;&#23384;&#21040;&#22791;&#24208;&#25991;&#20214;&#12290;&#25110;&#28857;&#19979;&#26041;"&#22797;&#21046;"&#25353;&#38062;&#12290;</div>
    <div class="export-modal-btns">
      <button class="btn-modal-dl" onclick="doDownload()">&#19979;&#36733;&#25991;&#20214;</button>
      <button class="btn-modal-copy" onclick="copyExport()">&#22797;&#21046;&#25991;&#26412;</button>
      <button class="btn-modal-close" onclick="closeExportModal()">&#20851;&#38381;</button>
    </div>
  </div>
</div>

<div class="app">
  <div class="header">
    <button class="btn-back" onclick="goBack()">&#8249;</button>
    <div class="header-title">&#23567;&#26085;&#35760;</div>
    <button class="btn-icon-sm" id="btnSearch" onclick="toggleSearch()">&#128269;</button>
  </div>
  <div class="search-wrap" id="searchWrap">
    <input class="search-input" id="searchInput" placeholder="&#25628;&#32034;&#25152;&#26377;&#26085;&#35760;&#8230;" type="search" oninput="onSearch()"/>
  </div>
  <div class="panels">
    <!-- Write -->
    <div class="panel active" id="panelWrite">
      <div class="date-nav-row">
        <button class="nav-btn" onclick="navDay(-1)">&#8249;</button>
        <div class="date-center" onclick="openDatePicker()">
          <div class="date-main" id="dateMain"></div>
          <div class="date-sub" id="dateSub"></div>
        </div>
        <button class="nav-btn" onclick="navDay(1)">&#8250;</button>
      </div>
      <div style="text-align:center">
        <span class="today-chip" id="todayChip" style="display:none" onclick="goToday()">&#22238;&#21040;&#20170;&#22825;</span>
      </div>
      <div class="card">
        <div class="card-label">&#20170;&#22825;&#30340;&#24515;&#24773;</div>
        <div class="mood-row">
          <button class="mood-btn" data-mood="1" onclick="setMood(1)"><span class="mood-em">&#128547;</span>&#24456;&#38590;&#21463;</button>
          <button class="mood-btn" data-mood="2" onclick="setMood(2)"><span class="mood-em">&#128532;</span>&#26377;&#28857;&#20302;&#33853;</button>
          <button class="mood-btn" data-mood="3" onclick="setMood(3)"><span class="mood-em">&#128524;</span>&#36824;&#22909;</button>
          <button class="mood-btn" data-mood="4" onclick="setMood(4)"><span class="mood-em">&#128578;</span>&#19981;&#38169;</button>
          <button class="mood-btn" data-mood="5" onclick="setMood(5)"><span class="mood-em">&#128522;</span>&#24456;&#26834;</button>
        </div>
      </div>
      <div class="card">
        <div class="card-label">&#20170;&#22825;&#24819;&#35828;&#30340;&#35805;</div>
        <textarea class="diary-area" id="diaryArea" placeholder="&#26085;&#35760;&#12289;&#27969;&#27700;&#36134;&#12289;&#24515;&#24773;&#8230;&#37117;&#34892;&#65292;&#33258;&#21160;&#20445;&#23384;&#30340;"></textarea>
        <div class="autosave-row"><span class="autosave-hint" id="autosaveHint"></span></div>
      </div>
      <div class="card">
        <div class="card-label">&#30382;&#30382;&#24565;</div>
        <div class="thought-input-row">
          <input class="thought-input" id="thoughtInput" type="text" placeholder="&#38543;&#25163;&#35760;&#19968;&#26465;&#65292;&#22238;&#36710;&#23384;" maxlength="500"/>
          <button class="thought-save-btn" onclick="saveThought()">&#23384;</button>
        </div>
        <div class="thought-cards" id="thoughtCards"></div>
      </div>
      <div class="card">
        <div class="card-label">&#128336; &#21382;&#21490;&#19978;&#30340;&#20170;&#22825;</div>
        <div id="otdContent"><div class="otd-empty">&#24448;&#24180;&#30340;&#20170;&#22825;&#36824;&#27809;&#26377;&#35760;&#24405;&#65374;</div></div>
      </div>
      <div class="dual-card" id="xinyeOfDayCard">
        <div class="dual-card-label">&#128153; &#28824;&#20063;&#30340;&#26085;&#35760;&#183;&#36825;&#19968;&#22825;</div>
        <div class="dual-card-text" id="xinyeOfDayText"></div>
        <button class="dual-card-link" id="xinyeOfDayEdit" onclick="">&#8594; &#32534;&#36753;&#27492;&#26085;&#28824;&#20063;&#26085;&#35760;</button>
      </div>
      <div class="export-strip">
        <button class="btn-exp" onclick="exportAll()">&#128230; &#23548;&#20986;&#22791;&#20221;</button>
        <button class="btn-exp" onclick="triggerImport()">&#128194; &#23548;&#20837;&#22791;&#20221;</button>
        <input type="file" id="importFile" accept=".json" style="display:none" onchange="onImport(event)"/>
      </div>
    </div><!-- /panelWrite -->

    <!-- Timeline -->
    <div class="panel" id="panelTimeline">
      <div id="tlContent"></div>
    </div>

    <!-- Xinye -->
    <div class="panel" id="panelXinye">
      <div class="xinye-banner">&#128153; &#28824;&#20063;&#30340;&#26085;&#35760;</div>
      <div class="xinye-edit-card">
        <div class="card-label">&#25163;&#21160;&#20889;&#20837;</div>
        <div class="xinye-edit-row">
          <input type="date" id="xinyeEditDate" class="xinye-edit-date"/>
          <span style="font-size:12px;color:var(--text-light)">&#36873;&#26085;&#26399;&#21518;&#31896;&#36148;&#20869;&#23481;</span>
        </div>
        <textarea class="diary-area" id="xinyeEditArea" placeholder="&#25226;&#28754;&#20063;&#26085;&#35760;&#20869;&#23481;&#31896;&#36148;&#21040;&#36825;&#37324;&#8230;"></textarea>
        <div style="text-align:right;margin-top:8px">
          <button class="xinye-save-btn2" onclick="saveXinyeEntry()">&#20445;&#23384;&#21040;&#36825;&#19968;&#22825;</button>
        </div>
      </div>
      <div id="xinyeContent"></div>
    </div>
  </div><!-- /panels -->

  <div class="tab-bar">
    <button class="tab-btn active" id="tabWrite" onclick="switchTab('Write')">
      <span class="tab-icon">&#9997;&#65039;</span><span>&#20889;&#20170;&#22825;</span>
    </button>
    <button class="tab-btn" id="tabTimeline" onclick="switchTab('Timeline')">
      <span class="tab-icon">&#128214;</span><span>&#32763;&#32763;</span>
    </button>
    <button class="tab-btn tab-xinye" id="tabXinye" onclick="switchTab('Xinye')">
      <span class="tab-icon">&#128153;</span><span>&#28824;&#20063;</span>
    </button>
  </div>
</div><!-- /app -->

<script>
const WEEKDAYS = ['\u65e5','\u4e00','\u4e8c','\u4e09','\u56db','\u4e94','\u516d'];
const MOOD_EM  = {1:'\ud83d\ude23',2:'\ud83d\ude14',3:'\ud83d\ude0c',4:'\ud83d\ude42',5:'\ud83d\ude0a'};

let curDate = todayDate();
let curData = emptyDay();
let curTab  = 'Write';
let searchQ = '';
let _autoSaveT=null, _searchT=null, _toastT=null;

function todayDate(){ const d=new Date(); d.setHours(0,0,0,0); return d; }
function emptyDay(){ return {note:'',noteTime:null,mood:null,thoughts:[],weather:null}; }
function dkey(d){ return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
function mmdd(d){ return pad(d.getMonth()+1)+'-'+pad(d.getDate()); }
function pad(n){ return String(n).padStart(2,'0'); }
function isToday(d){ const t=new Date(); return d.getFullYear()===t.getFullYear()&&d.getMonth()===t.getMonth()&&d.getDate()===t.getDate(); }
function fmtDateFull(ts){ const d=new Date(ts); return d.getFullYear()+'/'+pad(d.getMonth()+1)+'/'+pad(d.getDate())+' '+pad(d.getHours())+':'+pad(d.getMinutes()); }
function fmtDateLong(d){ return d.getFullYear()+'\u5e74'+(d.getMonth()+1)+'\u6708'+d.getDate()+'\u65e5'; }
function fmtDateShort(k){ const[y,m,d]=k.split('-'); return y+'\u5e74'+parseInt(m)+'\u6708'+parseInt(d)+'\u65e5'; }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

/* ---- Storage ---- */
function loadDay(key){
  const r2=localStorage.getItem('diary2_'+key);
  if(r2){ try{return JSON.parse(r2);}catch(e){} }
  const r1=localStorage.getItem('rbdiary_'+key);
  if(r1){ try{
    const old=JSON.parse(r1);
    const m={note:old.note||'',noteTime:old.note?Date.now():null,mood:old.mood||null,thoughts:[],weather:old.weather||null};
    localStorage.setItem('diary2_'+key,JSON.stringify(m)); return m;
  }catch(e){} }
  return emptyDay();
}
function saveDay(key,data){
  localStorage.setItem('diary2_'+key,JSON.stringify(data));
  let old={}; try{old=JSON.parse(localStorage.getItem('rbdiary_'+key)||'{}');}catch(e){}
  old.note=data.note; old.mood=data.mood;
  localStorage.setItem('rbdiary_'+key,JSON.stringify(old));
}
function allDiaryKeys(){
  const seen=new Set();
  for(let i=0;i<localStorage.length;i++){
    const k=localStorage.key(i);
    if(!k) continue;
    if(k.startsWith('diary2_')) seen.add(k.slice(7));
    else if(k.startsWith('rbdiary_')) seen.add(k.slice(8));
  }
  return [...seen].filter(k=>/^\d{4}-\d{2}-\d{2}$/.test(k)).sort().reverse();
}
function allXinyeKeys(){
  const keys=[];
  for(let i=0;i<localStorage.length;i++){
    const k=localStorage.key(i);
    if(k&&k.startsWith('xinye_diary_')){ const d=k.slice(12); if(/^\d{4}-\d{2}-\d{2}$/.test(d)) keys.push(d); }
  }
  return keys.sort().reverse();
}

/* ---- Load day ---- */
function loadCurrentDay(){
  curData=loadDay(dkey(curDate));
  renderDateHeader(); renderMood(); renderDiaryArea(); renderThoughts(); renderOTD(); renderXinyeOfDay();
}
function renderDateHeader(){
  document.getElementById('dateMain').textContent=fmtDateLong(curDate);
  document.getElementById('dateSub').textContent='\u661f\u671f'+WEEKDAYS[curDate.getDay()];
  document.getElementById('todayChip').style.display=isToday(curDate)?'none':'inline-block';
  document.getElementById('datePicker').value=dkey(curDate);
}
function navDay(delta){ curDate.setDate(curDate.getDate()+delta); loadCurrentDay(); }
function goToday(){ curDate=todayDate(); loadCurrentDay(); }
function openDatePicker(){ const dp=document.getElementById('datePicker'); try{dp.showPicker();}catch(e){dp.click();} }
function onDatePicked(){
  const v=document.getElementById('datePicker').value; if(!v) return;
  const[y,m,d]=v.split('-').map(Number); curDate=new Date(y,m-1,d,0,0,0,0); loadCurrentDay();
}

/* ---- Mood ---- */
function renderMood(){
  document.querySelectorAll('.mood-btn').forEach(b=>b.classList.toggle('selected',parseInt(b.dataset.mood)===curData.mood));
}
function setMood(n){
  curData.mood=(curData.mood===n)?null:n;
  saveDay(dkey(curDate),curData); renderMood();
}

/* ---- Diary textarea ---- */
function renderDiaryArea(){
  document.getElementById('diaryArea').value=curData.note||'';
  const h=document.getElementById('autosaveHint');
  h.textContent=curData.noteTime?('\u5df2\u4fdd\u5b58 '+fmtDateFull(curData.noteTime)):'';
}
document.getElementById('diaryArea').addEventListener('input',()=>{
  clearTimeout(_autoSaveT);
  document.getElementById('autosaveHint').textContent='\u2026';
  _autoSaveT=setTimeout(()=>{
    curData.note=document.getElementById('diaryArea').value;
    curData.noteTime=Date.now();
    saveDay(dkey(curDate),curData);
    const h=document.getElementById('autosaveHint');
    h.textContent='\u5df2\u4fdd\u5b58 '+fmtDateFull(curData.noteTime);
    h.classList.add('flash'); setTimeout(()=>h.classList.remove('flash'),1800);
  },900);
});

/* ---- Thoughts ---- */
function renderThoughts(){
  const C=document.getElementById('thoughtCards');
  const thoughts=curData.thoughts||[];
  if(!thoughts.length){ C.innerHTML='<div class="no-thoughts">\u8fd8\u6ca1\u6709\u788e\u788e\u5ff5\uff5e</div>'; return; }
  C.innerHTML=[...thoughts].reverse().map(t=>`
    <div class="thought-card">
      <div class="thought-card-body">
        <div class="thought-card-text">${esc(t.text)}</div>
        <div class="thought-card-meta">${fmtDateFull(t.time)}</div>
      </div>
      <button class="thought-del" onclick="deleteThought(${t.id})">\u00d7</button>
    </div>`).join('');
}
function saveThought(){
  const inp=document.getElementById('thoughtInput');
  const text=inp.value.trim(); if(!text) return;
  if(!curData.thoughts) curData.thoughts=[];
  curData.thoughts.push({id:Date.now(),text,time:Date.now()});
  inp.value='';
  saveDay(dkey(curDate),curData); renderThoughts(); showToast('\u788e\u788e\u5ff5\u5df2\u5b58 \u2713');
}
function deleteThought(id){
  curData.thoughts=(curData.thoughts||[]).filter(t=>t.id!==id);
  saveDay(dkey(curDate),curData); renderThoughts();
}
document.getElementById('thoughtInput').addEventListener('keydown',e=>{
  if(e.key==='Enter'){ e.preventDefault(); saveThought(); }
});

/* ---- On This Day ---- */
function renderOTD(){
  const today=mmdd(curDate); const curY=curDate.getFullYear();
  const past=allDiaryKeys()
    .filter(k=>{ const p=k.split('-'); return p.length===3&&parseInt(p[0])!==curY&&(p[1]+'-'+p[2])===today; })
    .map(k=>{ const d=loadDay(k); return {year:parseInt(k.split('-')[0]),key:k,note:d.note||'',thoughts:d.thoughts||[],mood:d.mood}; })
    .filter(e=>e.note||e.thoughts.length>0);
  const el=document.getElementById('otdContent');
  if(!past.length){ el.innerHTML='<div class="otd-empty">\u5f80\u5e74\u7684\u4eca\u5929\u8fd8\u6ca1\u6709\u8bb0\u5f55\uff5e</div>'; return; }
  el.innerHTML='<div class="otd-items">'+past.map(e=>{
    const ms=e.mood?(MOOD_EM[e.mood]+' '):'';
    const preview=e.note||(e.thoughts[0]?.text||'');
    return `<div class="otd-item" onclick="navToKey('${e.key}')">
      <div class="otd-item-year">${ms}${e.year}\u5e74</div>
      <div class="otd-item-text">${esc(preview)}</div>
    </div>`;
  }).join('')+'</div>';
}
function navToKey(key){
  const[y,m,d]=key.split('-').map(Number); curDate=new Date(y,m-1,d,0,0,0,0); loadCurrentDay();
}

/* ---- Timeline ---- */
function renderTimeline(query){
  const keys=allDiaryKeys();
  let entries=keys.map(k=>{const d=loadDay(k);return{key:k,note:d.note||'',thoughts:d.thoughts||[],mood:d.mood};})
    .filter(e=>e.note.trim()||e.thoughts.length>0);
  if(query){
    const q=query.toLowerCase();
    entries=entries.filter(e=>e.note.toLowerCase().includes(q)||e.thoughts.some(t=>t.text.toLowerCase().includes(q)));
  }
  const C=document.getElementById('tlContent');
  if(!entries.length){ C.innerHTML=`<div class="tl-empty">${query?'\u6ca1\u6709\u627e\u5230\u201c'+esc(query)+'\u201d':'\u8fd8\u6ca1\u6709\u65e5\u8bb0\uff0c\u5148\u53bb\u5199\u5427\uff5e'}</div>`; return; }
  C.innerHTML=entries.map(e=>{
    const ms=e.mood?(' <span>'+MOOD_EM[e.mood]+'</span>'):'';
    const preview=e.note.trim()||(e.thoughts[0]?.text||'');
    const tcount=e.thoughts.length;
    const meta=(!e.note.trim()&&tcount>1)?('\u5171 '+tcount+' \u6761\u788e\u788e\u5ff5'):(e.note.trim()&&tcount?('\u53e6\u6709 '+tcount+' \u6761\u788e\u788e\u5ff5'):'');
    return `<div class="tl-entry" onclick="goToDateWrite('${e.key}')">
      <div class="tl-entry-date">${fmtDateShort(e.key)}${ms}</div>
      <div class="tl-entry-preview">${highlight(esc(preview),query)}</div>
      ${meta?`<div class="tl-entry-meta">${esc(meta)}</div>`:''}
    </div>`;
  }).join('');
}
function highlight(html,q){
  if(!q) return html;
  return html.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),m=>`<mark>${m}</mark>`);
}
function goToDateWrite(key){ navToKey(key); switchTab('Write'); }

/* ---- Xinye ---- */
function renderXinye(){
  const keys=allXinyeKeys();
  const C=document.getElementById('xinyeContent');
  if(!keys.length){ C.innerHTML='<div class="xinye-empty">\u7098\u4e5f\u8fd8\u6ca1\u5199\u65e5\u8bb0\uff5e<br><span style="font-size:12px">\u53ef\u4ee5\u5728\u4e0a\u65b9\u624b\u52a8\u5199\u5165\u2193</span></div>'; return; }
  C.innerHTML=keys.map(k=>{
    const text=localStorage.getItem('xinye_diary_'+k)||'';
    const id='x_'+k.replace(/-/g,'');
    return `<div class="xinye-entry">
      <div class="xinye-entry-date">\ud83d\udc99 ${fmtDateShort(k)}</div>
      <div class="xinye-entry-preview" id="prev_${id}">${esc(text)}</div>
      <div class="xinye-entry-text" id="full_${id}" style="display:none">${esc(text)}</div>
      <button class="xinye-entry-expand" id="exp_${id}" onclick="toggleXinyeExpand('${id}')">⤵ \u5c55\u5f00\u5168\u6587</button>
      <div class="xinye-entry-btns">
        <button class="xinye-entry-edit" onclick="editXinyeEntry('${k}')">✏\ufe0f \u8f7d\u5165\u7f16\u8f91</button>
        <button class="xinye-entry-del" onclick="deleteXinyeEntry('${k}')">× \u5220\u9664</button>
      </div>
    </div>`;
  }).join('');
}
function toggleXinyeExpand(id){
  const prev=document.getElementById('prev_'+id);
  const full=document.getElementById('full_'+id);
  const btn=document.getElementById('exp_'+id);
  const isOpen=full.style.display!=='none';
  prev.style.display=isOpen?'':'none';
  full.style.display=isOpen?'none':'';
  btn.textContent=isOpen?'\u2935 \u5c55\u5f00\u5168\u6587':'\u2191 \u6536\u8d77';
}
function saveXinyeEntry(){
  const date=document.getElementById('xinyeEditDate').value;
  const text=document.getElementById('xinyeEditArea').value.trim();
  if(!date){ showToast('\u8bf7\u5148\u9009\u62e9\u65e5\u671f'); return; }
  if(!text){ showToast('\u5185\u5bb9\u4e0d\u80fd\u4e3a\u7a7a'); return; }
  localStorage.setItem('xinye_diary_'+date,text);
  document.getElementById('xinyeEditArea').value='';
  renderXinye();
  showToast('\u7098\u4e5f\u65e5\u8bb0\u5df2\u4fdd\u5b58 \u2713');
}
function editXinyeEntry(k){
  document.getElementById('xinyeEditDate').value=k;
  document.getElementById('xinyeEditArea').value=localStorage.getItem('xinye_diary_'+k)||'';
  document.getElementById('panelXinye').scrollTop=0;
  document.getElementById('xinyeEditArea').focus();
}
function deleteXinyeEntry(k){
  if(!confirm('\u5220\u9664\u8fd9\u7bc7\u7098\u4e5f\u65e5\u8bb0\uff1f')) return;
  localStorage.removeItem('xinye_diary_'+k);
  renderXinye(); renderXinyeOfDay();
}
function renderXinyeOfDay(){
  const k=dkey(curDate);
  const text=localStorage.getItem('xinye_diary_'+k)||'';
  const card=document.getElementById('xinyeOfDayCard');
  const el=document.getElementById('xinyeOfDayText');
  const btn=document.getElementById('xinyeOfDayEdit');
  card.style.display='block';
  if(text){
    el.style.display='';
    el.textContent=text;
    btn.textContent='\u2192 \u7f16\u8f91\u6b64\u65e5\u7098\u4e5f\u65e5\u8bb0';
    btn.onclick=()=>{ switchTab('Xinye'); editXinyeEntry(k); };
  } else {
    el.style.display='none';
    btn.textContent='\u2795 \u7098\u4e5f\u8fd8\u6ca1\u5199\u8fd9\u5929\uff0c\u53bb\u5199\u5165';
    btn.onclick=()=>{ switchTab('Xinye'); document.getElementById('xinyeEditDate').value=k; document.getElementById('xinyeEditArea').focus(); };
  }
}

/* ---- Search ---- */
function toggleSearch(){
  const wrap=document.getElementById('searchWrap');
  const show=wrap.classList.toggle('show');
  document.getElementById('btnSearch').classList.toggle('active',show);
  if(show){ document.getElementById('searchInput').focus(); if(curTab!=='Timeline') switchTab('Timeline'); }
  else{ searchQ=''; document.getElementById('searchInput').value=''; renderTimeline(''); }
}
function onSearch(){
  clearTimeout(_searchT);
  _searchT=setTimeout(()=>{
    searchQ=document.getElementById('searchInput').value.trim();
    if(curTab!=='Timeline') switchTab('Timeline');
    renderTimeline(searchQ);
  },280);
}

/* ---- Tab ---- */
function switchTab(tab){
  curTab=tab;
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.getElementById('tab'+tab).classList.add('active');
  document.getElementById('panel'+tab).classList.add('active');
  if(tab==='Timeline') renderTimeline(searchQ);
  if(tab==='Xinye'){
    renderXinye();
    // Set default date on edit area
    if(!document.getElementById('xinyeEditDate').value){
      document.getElementById('xinyeEditDate').value=dkey(curDate);
    }
  }
}

/* ---- Export / Import ---- */
let _exportJSON = '';
function exportAll(){
  const dk=allDiaryKeys(); const xk=allXinyeKeys();
  const out={version:2,exported:new Date().toISOString(),diary:{},xinye:{}};
  dk.forEach(k=>{out.diary[k]=loadDay(k);}); xk.forEach(k=>{out.xinye[k]=localStorage.getItem('xinye_diary_'+k);});
  _exportJSON=JSON.stringify(out,null,2);
  document.getElementById('exportTA').value=_exportJSON;
  document.getElementById('exportModalOverlay').classList.add('show');
}
function doDownload(){
  const filename='diary_backup_'+dkey(new Date())+'.json';
  const blob=new Blob([_exportJSON],{type:'application/json'});
  // Capacitor (Android/HarmonyOS APK) — direct write to Download folder
  if(window.Capacitor?.Plugins?.Filesystem){
    const {Filesystem}=window.Capacitor.Plugins;
    const base64=btoa(unescape(encodeURIComponent(_exportJSON)));
    Filesystem.writeFile({path:'Download/'+filename,data:base64,directory:'EXTERNAL_STORAGE',recursive:true})
      .then(()=>showToast('\u2705 \u5df2\u4fdd\u5b58\u5230\u624b\u673a Download \u6587\u4ef6\u5939'))
      .catch(e=>showToast('\u4fdd\u5b58\u5931\u8d25\uff1a'+e.message));
    return;
  }
  // Web Share API (Android browser)
  if(navigator.share&&navigator.canShare){
    const file=new File([blob],filename,{type:'application/json'});
    if(navigator.canShare({files:[file]})){
      navigator.share({files:[file],title:filename})
        .then(()=>showToast('\u5206\u4eab\u6210\u529f \u2713'))
        .catch(err=>{ if(err.name!=='AbortError') openBlobTab(blob); });
      return;
    }
  }
  openBlobTab(blob);
}
function openBlobTab(blob){
  const url=URL.createObjectURL(blob);
  const w=window.open(url,'_blank');
  if(!w){
    const a=document.createElement('a');
    a.href=url; a.download='diary_backup_'+dkey(new Date())+'.json';
    document.body.appendChild(a); a.click();
    setTimeout(()=>document.body.removeChild(a),2000);
  }
  showToast('\u5df2\u5728\u65b0\u9875\u9762\u6253\u5f00\uff0c\u957f\u6309\u9875\u9762\u2192\u4fdd\u5b58');
}
function copyExport(){
  const ta=document.getElementById('exportTA');
  ta.focus(); ta.select(); ta.setSelectionRange(0,ta.value.length);
  let ok=false;
  try{ ok=document.execCommand('copy'); }catch(e){}
  if(ok){ showToast('\u5df2\u590d\u5236 \u2713'); return; }
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(_exportJSON)
      .then(()=>showToast('\u5df2\u590d\u5236 \u2713'))
      .catch(()=>showToast('\u8bf7\u957f\u6309\u6587\u672c\u6846 \u2192 \u5168\u9009 \u2192 \u590d\u5236'));
  } else { showToast('\u8bf7\u957f\u6309\u6587\u672c\u6846 \u2192 \u5168\u9009 \u2192 \u590d\u5236'); }
}
function closeExportModal(){ document.getElementById('exportModalOverlay').classList.remove('show'); }

function triggerImport(){ document.getElementById('importFile').click(); }
function onImport(ev){
  const file=ev.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      const data=JSON.parse(e.target.result);
      let diaryCount=0, xinyeCount=0;

      // --- Import diary entries ---
      // Version 2 format: { version:2, diary:{}, xinye:{} }
      if(data.version===2){
        Object.entries(data.diary||{}).forEach(([k,v])=>{
          if(!/^\d{4}-\d{2}-\d{2}$/.test(k)||!v) return;
          localStorage.setItem('diary2_'+k,JSON.stringify(v));
          let old={}; try{old=JSON.parse(localStorage.getItem('rbdiary_'+k)||'{}');}catch(_){}
          old.note=v.note; old.mood=v.mood; localStorage.setItem('rbdiary_'+k,JSON.stringify(old));
          diaryCount++;
          // xinyeDiary may also live here in v2
          if(v.xinyeDiary&&typeof v.xinyeDiary==='string') storeXinye(k,v.xinyeDiary);
        });
      } else {
        // Old flat format: date keys or rbdiary_ keys at root
        Object.entries(data).forEach(([k,v])=>{
          const dk=k.startsWith('rbdiary_')?k.slice(8):k;
          if(/^\d{4}-\d{2}-\d{2}$/.test(dk)&&v&&typeof v==='object'&&!Array.isArray(v)&&!('version' in v)){
            const m={note:v.note||'',noteTime:v.note?Date.now():null,mood:v.mood||null,thoughts:v.thoughts||[],weather:v.weather||null};
            localStorage.setItem('diary2_'+dk,JSON.stringify(m));
            localStorage.setItem('rbdiary_'+dk,JSON.stringify(v));
            diaryCount++;
            // *** KEY FIX: read xinyeDiary field embedded in each date entry ***
            if(v.xinyeDiary&&typeof v.xinyeDiary==='string') storeXinye(dk,v.xinyeDiary);
          }
        });
      }

      // --- Import xinye entries (super-broad scan handles any format) ---
      function storeXinye(dateKey, val){
        if(!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return;
        let text=typeof val==='string'?val:(val&&(val.text||val.content||val.note)||'');
        if(!text) return;
        localStorage.setItem('xinye_diary_'+dateKey,text); xinyeCount++;
      }
      // Scan nested xinye objects (version 2 data.xinye and any nested key named xinye)
      function scanForXinye(obj,depth){
        if(!obj||typeof obj!=='object'||depth>4) return;
        Object.entries(obj).forEach(([k,v])=>{
          if(k==='xinye'&&v&&typeof v==='object'){
            Object.entries(v).forEach(([dk,dv])=>storeXinye(dk,dv));
          }
          if(k.startsWith('xinye_diary_')) storeXinye(k.slice(12),v);
          if(v&&typeof v==='object') scanForXinye(v,depth+1);
        });
      }
      scanForXinye(data,0);

      loadCurrentDay();
      renderXinye();
      if(curTab==='Timeline') renderTimeline(searchQ);
      const msg='\u5bfc\u5165\u6210\u529f\uff1a\u65e5\u8bb0 '+diaryCount+' \u7bc7\uff0c\u7098\u4e5f\u65e5\u8bb0 '+xinyeCount+' \u7bc7 \u2713';
      showToast(msg);
    }catch(err){ showToast('\u5bfc\u5165\u5931\u8d25\uff1a'+err.message); }
    ev.target.value='';
  };
  reader.readAsText(file);
}

/* ---- Back ---- */
function goBack(){
  const ret=localStorage.getItem('diary_returnTo');
  if(ret==='chat'){ localStorage.removeItem('diary_returnTo'); localStorage.setItem('diary_gotoChat','1'); }
  if(history.length>1) history.back(); else window.location.href='../index.html';
}

/* ---- Toast ---- */
function showToast(msg){
  const el=document.getElementById('toast'); el.textContent=msg; el.classList.add('show');
  clearTimeout(_toastT); _toastT=setTimeout(()=>el.classList.remove('show'),2200);
}

/* ---- Init ---- */
(function(){
  loadCurrentDay();
  const p=new URLSearchParams(location.search);
  if(p.get('tab')==='xinye') switchTab('Xinye');
})();
</script>
</body>
</html>"""

with open(r'd:\Download\Claude code\tools\growth-dashboard.html', 'w', encoding='utf-8') as f:
    f.write(content)
print('Done, length:', len(content))

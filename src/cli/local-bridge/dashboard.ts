export function localBridgeDashboardHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>repo-harness · 执行助手控制台</title>
<style>
:root{color-scheme:dark;--bg:#070b10;--panel:#0f1620;--panel2:#131c28;--line:rgba(255,255,255,.08);--text:#f3f6f9;--muted:#95a0ab;--faint:#6d7784;--green:#34d399;--amber:#fbbf24;--red:#f87171;--blue:#60a5fa;--radius:16px}
*{box-sizing:border-box}html,body{height:100%;margin:0}body{background:radial-gradient(circle at 80% -10%,rgba(52,211,153,.14),transparent 32%),linear-gradient(160deg,#05080c,#0a1118 55%,#06090d);color:var(--text);font:14px/1.5 Inter,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif}
button,input,textarea{font:inherit}button{cursor:pointer}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.app{min-height:100vh;display:grid;grid-template-rows:64px 1fr}
.top{display:flex;align-items:center;gap:12px;padding:0 18px;border-bottom:1px solid var(--line);background:rgba(8,12,18,.88);backdrop-filter:blur(16px);position:sticky;top:0;z-index:20}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;min-width:180px}
.logo{width:28px;height:28px;border-radius:9px;display:grid;place-items:center;background:rgba(52,211,153,.12);color:var(--green);border:1px solid rgba(52,211,153,.28)}
.top-actions{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.chip,.btn,.pill{border:1px solid var(--line);background:rgba(255,255,255,.04);color:var(--text);border-radius:12px;padding:8px 12px}
.chip{display:inline-flex;align-items:center;gap:8px;min-height:36px}.chip strong{font-weight:700}
.btn{min-height:38px}.btn.primary{background:linear-gradient(180deg,#2f9f6b,#1f7a51);border-color:rgba(52,211,153,.4)}.btn.danger{background:rgba(248,113,113,.12);border-color:rgba(248,113,113,.35);color:#fecaca}.btn.ghost{background:transparent}
.dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 0 4px rgba(52,211,153,.12)}.dot.amber{background:var(--amber);box-shadow:0 0 0 4px rgba(251,191,36,.12)}.dot.red{background:var(--red);box-shadow:0 0 0 4px rgba(248,113,113,.12)}.dot.blue{background:var(--blue);box-shadow:0 0 0 4px rgba(96,165,250,.12)}.dot.gray{background:#7b8794}
.body{display:grid;grid-template-columns:220px 1fr;min-height:0}
.side{border-right:1px solid var(--line);padding:16px 12px;background:rgba(8,12,18,.55)}
.nav{display:grid;gap:6px}.nav button{text-align:left;width:100%;padding:11px 12px;border-radius:12px;border:1px solid transparent;background:transparent;color:var(--text)}.nav button.active,.nav button:hover{background:rgba(255,255,255,.05);border-color:var(--line)}
.nav .count{margin-left:6px;display:inline-grid;place-items:center;min-width:20px;height:20px;border-radius:999px;background:rgba(248,113,113,.18);color:#fecaca;font-size:12px;font-weight:700}
.main{padding:24px 28px 48px;overflow:auto}.main>.view{width:min(1240px,100%);margin:0 auto}
.view{display:none}.view.active{display:block}
.page-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:16px}.page-head h1{margin:0 0 4px;font-size:24px}.page-head p{margin:0;color:var(--muted)}
.grid{display:grid;gap:14px}.grid.two{grid-template-columns:1.4fr .9fr}.grid.cards{grid-template-columns:repeat(3,1fr)}.grid.stats{grid-template-columns:repeat(4,minmax(0,1fr))}
.panel{background:rgba(15,22,32,.92);border:1px solid var(--line);border-radius:var(--radius);padding:16px;box-shadow:0 18px 40px rgba(0,0,0,.22)}
.panel h2,.panel h3{margin:0 0 8px}.muted{color:var(--muted)}.faint{color:var(--faint)}
.stat strong{display:block;font-size:22px;margin-top:4px}.stat span{color:var(--muted);font-size:12px}
.plugin-card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:start}
.action-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;padding:10px 0;border-top:1px solid var(--line)}
.action-row:first-child{border-top:0;padding-top:0}
.composer textarea,.composer input,.input,textarea,input[type=text],input[type=number]{width:100%;border:1px solid var(--line);background:rgba(0,0,0,.22);color:var(--text);border-radius:12px;padding:12px 14px}
.composer textarea{min-height:120px;resize:vertical}
.composer .row{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px;align-items:center}
.mode-card{display:grid;gap:6px}.mode-card .label{font-weight:800;font-size:16px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;font-size:12px;font-weight:700;border-radius:999px}
.pill.green{background:rgba(52,211,153,.12);color:#a7f3d0;border-color:rgba(52,211,153,.28)}
.pill.amber{background:rgba(251,191,36,.12);color:#fde68a;border-color:rgba(251,191,36,.28)}
.pill.red{background:rgba(248,113,113,.12);color:#fecaca;border-color:rgba(248,113,113,.28)}
.pill.blue{background:rgba(96,165,250,.12);color:#bfdbfe;border-color:rgba(96,165,250,.28)}
.pill.gray{background:rgba(255,255,255,.05);color:#cbd5e1}
.steps{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
.step{padding:6px 10px;border-radius:999px;border:1px solid var(--line);color:var(--faint);font-size:12px}.step.done{color:#a7f3d0;border-color:rgba(52,211,153,.3)}.step.active{color:#bfdbfe;border-color:rgba(96,165,250,.35)}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.list{display:grid;gap:10px}
.card-row{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:start;padding:14px;border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,.02)}
.card-row h3{margin:0 0 6px;font-size:15px}.card-row p{margin:0 0 6px;color:var(--muted)}
.evidence{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.evidence span{font-size:12px;padding:4px 8px;border-radius:999px;background:rgba(255,255,255,.04);border:1px solid var(--line);color:var(--muted)}
details.advanced{margin-top:12px;border-top:1px dashed var(--line);padding-top:10px}.advanced summary{cursor:pointer;color:var(--muted)}
.toast{position:fixed;right:18px;bottom:18px;background:#111827;border:1px solid var(--line);padding:12px 14px;border-radius:12px;opacity:0;transform:translateY(8px);transition:.2s;z-index:50;max-width:360px}.toast.show{opacity:1;transform:none}
.empty{padding:22px;border:1px dashed var(--line);border-radius:14px;color:var(--muted);text-align:center}
.section-title{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.warn{padding:10px 12px;border-radius:12px;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.25);color:#fde68a;margin-bottom:12px}
.errbox{padding:12px 14px;border-radius:12px;background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.28);color:#fecaca;margin:10px 0}
.errbox h4{margin:0 0 6px;font-size:14px}.errbox .muted{color:#fca5a5}
.setup{padding:14px 16px;border-radius:14px;background:rgba(96,165,250,.08);border:1px solid rgba(96,165,250,.28);margin-bottom:14px}
.files{display:grid;gap:6px;margin-top:8px}.file-row{display:flex;justify-content:space-between;gap:10px;padding:6px 8px;border-radius:8px;background:rgba(255,255,255,.03);border:1px solid var(--line);font-size:12px}
.opbar{margin-bottom:12px;padding:10px 12px;border-radius:12px;border:1px solid var(--line);background:rgba(255,255,255,.03);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.opbar.running{border-color:rgba(96,165,250,.35);background:rgba(96,165,250,.08)}
.opbar.ok{border-color:rgba(52,211,153,.35);background:rgba(52,211,153,.08)}
.opbar.err{border-color:rgba(248,113,113,.35);background:rgba(248,113,113,.08)}
.btn:disabled{opacity:.55;cursor:not-allowed}
.busy-banner{font-size:12px;color:var(--muted)}
.refresh-meta{font-size:12px;color:var(--faint);margin-left:auto}
.composer h2{font-size:20px}.composer .hint{color:var(--muted);margin:0 0 10px;font-size:13px}
.decision-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:12px 0}.decision-box{padding:12px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.025)}.decision-box strong{display:block;margin-bottom:5px}.decision-box p{margin:0;color:var(--muted)}
.flow{display:flex;align-items:stretch;gap:6px;margin:12px 0;overflow:auto}.flow-step{min-width:130px;flex:1;padding:9px 10px;border-radius:10px;border:1px solid var(--line);background:rgba(255,255,255,.025);color:var(--muted);font-size:12px}.flow-arrow{display:grid;place-items:center;color:var(--faint)}
@media(max-width:980px){.body{grid-template-columns:1fr}.side{display:none}.grid.two,.grid.cards,.grid.stats,.decision-grid{grid-template-columns:1fr}.top{flex-wrap:wrap;height:auto;padding:10px 12px}}
</style>
</head>
<body>
<div class="app">
  <header class="top">
    <div class="brand"><span class="logo">∞</span><span>执行助手控制台</span></div>
    <button class="chip" id="repoChip" onclick="switchView('repositories')">仓库 · <strong id="topRepo">—</strong></button>
    <span class="chip"><span class="dot" id="readyDot"></span><strong id="topReady">检查中</strong></span>
    <span class="chip"><span class="dot" id="connectorDot"></span><span id="topConnector">连接</span></span>
    <button class="chip" onclick="switchView('capabilities')">插件 <strong id="topPlugins">—</strong></button>
    <button class="chip" onclick="switchView('inbox')">需要处理 <span class="count" id="topHandoffs">0</span></button>
    <div class="top-actions">
      <button class="btn ghost" onclick="refreshAll()">刷新</button>
      <button class="btn ghost" onclick="switchView('advanced')">高级</button>
    </div>
  </header>
  <div class="body">
    <aside class="side">
      <nav class="nav">
        <button class="active" data-view="home">⌂ 指挥中心</button>
        <button data-view="inbox">△ 需要处理 <span class="count" id="sideHandoffs">0</span></button>
        <button data-view="work">▷ 当前任务</button>
        <button data-view="capabilities">◇ 能力 / 插件 <span class="count" id="sidePlugins" style="display:none">0</span></button>
        <button data-view="automation">⚙ 模型与工具</button>
        <button data-view="readiness">◎ 系统状态</button>
        <button data-view="repositories">□ 仓库</button>
        <button data-view="advanced">⌁ 高级诊断</button>
      </nav>
    </aside>
    <main class="main">
      <section class="view active" id="view-home"></section>
      <section class="view" id="view-inbox"></section>
      <section class="view" id="view-work"></section>
      <section class="view" id="view-capabilities"></section>
      <section class="view" id="view-automation"></section>
      <section class="view" id="view-readiness"></section>
      <section class="view" id="view-repositories"></section>
      <section class="view" id="view-advanced"></section>
    </main>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
function safeGet(k){try{return sessionStorage.getItem(k)||''}catch(_e){return ''}}
function safeSet(k,v){try{if(v)sessionStorage.setItem(k,v);else sessionStorage.removeItem(k)}catch(_e){}}
function queryRepoId(){try{return new URLSearchParams(location.search).get('repoId')||''}catch(_e){return ''}}
function setQueryRepoId(id){try{var u=new URL(location.href);if(id)u.searchParams.set('repoId',id);else u.searchParams.delete('repoId');history.replaceState(null,'',u)}catch(_e){}}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]})}
function arr(v){return Array.isArray(v)?v:[]}
function obj(v){return v&&typeof v==='object'&&!Array.isArray(v)?v:{}}
function toast(msg){var t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');setTimeout(function(){t.classList.remove('show')},2800)}
function pill(tone,label){return '<span class="pill '+esc(tone||'gray')+'">'+esc(label||'')+'</span>'}
function setDot(id,tone){document.getElementById(id).className='dot '+(tone&&tone!=='green'?tone:'')}

var selectedRepoId=queryRepoId()||safeGet('repoHarnessSelectedRepoId')||'';
var commandCenter=null;
var automationSettings=null;
var selectedWorkId=safeGet('repoHarnessSelectedWorkId')||'';
var selectedHandoffId='';
var selectedPluginId=safeGet('repoHarnessSelectedPluginId')||'';
var modePreview=null;
var advancedRaw=null;
var lastFacade=null;
var lastOperation=null; // {phase,statusLabel,summary,errorMessage,at}
var pluginActionResult=null;
var busy=false;
var pollTimer=null;
var refreshInFlight=false;
var lastRefreshedAt='';
var pageVisible=!document.hidden;
var workExtras={}; // workId -> {changedFiles, error, summary}

document.addEventListener('visibilitychange',function(){
  pageVisible=!document.hidden;
  if(!pageVisible){
    if(pollTimer){clearInterval(pollTimer);pollTimer=null}
    return;
  }
  ensurePoll();
  if(shouldPoll())refreshAll({silent:true});
});

function repoQuery(){return selectedRepoId?'?repoId='+encodeURIComponent(selectedRepoId):''}
function rememberRepo(id){selectedRepoId=id||'';safeSet('repoHarnessSelectedRepoId',selectedRepoId);setQueryRepoId(selectedRepoId)}
function rememberWork(id){selectedWorkId=id||'';safeSet('repoHarnessSelectedWorkId',selectedWorkId)}
function api(path,opts){opts=opts||{};var headers=Object.assign({'content-type':'application/json'},opts.headers||{});return fetch(path,Object.assign({},opts,{credentials:'same-origin',headers:headers})).then(function(r){return r.json().catch(function(){return{}}).then(function(body){if(!r.ok){var msg=(body.error&&body.error.title)||body.summary||body.errorMessage||body.error||body.message||('请求失败 '+r.status);if(!msg||msg==='undefined')msg='请求失败，请查看高级诊断';var err=new Error(msg);err.payload=body;err.status=r.status;throw err}return body})})}
function setBusy(on,label){
  busy=!!on;
  document.querySelectorAll('button.btn').forEach(function(b){
    if(on)b.setAttribute('disabled','disabled');else b.removeAttribute('disabled');
  });
  if(on){
    lastOperation={phase:'running',statusLabel:label||'执行中',summary:label||'正在处理…',at:new Date().toISOString()};
    renderOpBar();
  }
}
function setLastOp(res,fallback){
  res=obj(res);
  var feedback=obj(res.feedback);
  var phase=feedback.phase||res.phase||(res.status==='ok'?'succeeded':(res.status==='failed'||res.status==='blocked'||res.status==='approval_required')?'failed':'succeeded');
  var next='';
  var actions=arr(feedback.suggestedNextActions||res.suggestedNextActions);
  if(actions.length)next=actions[0].label||'';
  if(feedback.error&&feedback.error.nextActions&&feedback.error.nextActions[0])next=next||feedback.error.nextActions[0];
  lastOperation={
    phase:phase,
    statusLabel:feedback.statusLabel||res.statusLabel||fallback||'已更新',
    summary:feedback.summary||res.summary||fallback||'操作已完成',
    errorMessage:(feedback.error&&feedback.error.title)||res.errorMessage||'',
    error:feedback.error||res.error||null,
    next:next,
    changedFiles:feedback.changedFiles||res.changedFiles||null,
    at:new Date().toISOString()
  };
  // Remember changed files / errors against active work for card rendering.
  var wid=selectedWorkId||(res.data&&(res.data.work&&(res.data.work.workId||res.data.work.id)||res.data.workId));
  if(wid){
    workExtras[wid]=workExtras[wid]||{};
    if(lastOperation.changedFiles)workExtras[wid].changedFiles=lastOperation.changedFiles;
    if(lastOperation.error)workExtras[wid].error=lastOperation.error;
    if(lastOperation.summary)workExtras[wid].summary=lastOperation.summary;
  }
  lastFacade=res;
  renderOpBar();
}
function renderOpBar(){
  var nodes=document.querySelectorAll('#opBar');
  if(!nodes.length)return;
  var html='';
  if(lastOperation){
    var cls=lastOperation.phase==='running'||lastOperation.phase==='queued'||lastOperation.phase==='waiting'||lastOperation.phase==='submitting'?'running':(lastOperation.phase==='failed'||lastOperation.phase==='timed_out'||lastOperation.phase==='blocked'||lastOperation.phase==='needs_attention')?'err':'ok';
    html='<div class="opbar '+cls+'">'+
      '<span class="pill '+(cls==='ok'?'green':cls==='err'?'red':'blue')+'">'+esc(lastOperation.statusLabel)+'</span>'+
      '<span>'+esc(lastOperation.summary||'')+'</span>'+
      (lastOperation.errorMessage?'<span class="muted">'+esc(lastOperation.errorMessage)+'</span>':'')+
      (lastOperation.next?'<span class="muted">下一步：'+esc(lastOperation.next)+'</span>':'')+
      (busy?'<span class="busy-banner">请稍候，勿重复点击…</span>':'')+
      (lastRefreshedAt?'<span class="refresh-meta">刷新于 '+esc(lastRefreshedAt)+'</span>':'')+
    '</div>';
    if(lastOperation.error&&lastOperation.error.title){
      html+=renderErrorBox(lastOperation.error);
    }
  } else if(lastRefreshedAt){
    html='<div class="opbar"><span class="refresh-meta">刷新于 '+esc(lastRefreshedAt)+'</span></div>';
  }
  nodes.forEach(function(n){n.innerHTML=html});
}
function renderErrorBox(err){
  err=obj(err);
  if(!err.title)return '';
  var next=arr(err.nextActions).map(function(a){return '<span class="pill amber">'+esc(a)+'</span>'}).join(' ');
  return '<div class="errbox"><h4>'+esc(err.title)+'</h4><div class="muted">'+esc(err.explanation||'')+'</div>'+(next?'<div class="actions" style="margin-top:8px">'+next+'</div>':'')+
    '<details class="advanced"><summary>高级详情（仅调试）</summary><pre class="mono" style="white-space:pre-wrap;font-size:12px">'+esc(JSON.stringify(err,null,2))+'</pre></details></div>';
}
function renderChangedFiles(summary){
  summary=obj(summary);
  if(!summary.total&&!arr(summary.files).length)return '';
  var files=arr(summary.files).slice(0,12);
  return '<div style="margin-top:10px"><div class="section-title"><strong>改动文件</strong>'+pill('blue',summary.summaryLabel||((summary.total||files.length)+' 个文件'))+'</div>'+
    '<div class="files">'+files.map(function(f){
      return '<div class="file-row"><span class="mono">'+esc(f.path)+'</span><span class="pill gray">'+esc(f.statusLabel||f.status||'修改')+'</span></div>';
    }).join('')+'</div>'+
    (files.length<(summary.total||0)?'<div class="faint" style="margin-top:6px">仅显示前 '+files.length+' 项</div>':'')+
  '</div>';
}
function shouldPoll(){
  if(!pageVisible||refreshInFlight)return false;
  var work=obj(commandCenter&&commandCenter.currentWork);
  if(!work||!work.id)return false;
  var phase=work.phase||'';
  return phase==='running'||phase==='queued'||phase==='waiting'||phase==='submitting'||work.tone==='blue'||work.statusLabel==='进行中'||work.statusLabel==='待开始';
}
function ensurePoll(){
  if(!pageVisible||pollTimer)return;
  pollTimer=setInterval(function(){
    if(!shouldPoll()){
      if(pollTimer){clearInterval(pollTimer);pollTimer=null}
      return;
    }
    refreshAll({silent:true});
  },3500);
}

function switchView(name){
  document.querySelectorAll('.nav button').forEach(function(b){b.classList.toggle('active',b.dataset.view===name)});
  document.querySelectorAll('.view').forEach(function(v){v.classList.toggle('active',v.id==='view-'+name)});
  renderAll();
}
document.querySelectorAll('.nav button[data-view]').forEach(function(b){b.addEventListener('click',function(){switchView(b.dataset.view)})});

function btn(label, attrs, cls){
  return '<button class="btn'+(cls?(' '+cls):'')+'" '+attrs+'>'+esc(label)+'</button>';
}
function stepsHtml(steps){
  return '<div class="steps">'+arr(steps).map(function(s){return '<span class="step '+(s.done?'done':'')+(s.active?' active':'')+'">'+esc(s.label)+'</span>'}).join('')+'</div>';
}

function evidenceHtml(labels){
  if(!arr(labels).length)return '';
  return '<div class="evidence">'+arr(labels).map(function(x){return '<span>'+esc(x)+'</span>'}).join('')+'</div>';
}

function advancedBlock(data){
  if(!data)return '';
  return '<details class="advanced"><summary>高级详情</summary><pre class="mono" style="white-space:pre-wrap;color:var(--muted);font-size:12px">'+esc(JSON.stringify(data,null,2))+'</pre></details>';
}

function renderChrome(){
  var cc=obj(commandCenter), ready=obj(cc.readiness), repo=obj(cc.currentRepository);
  var plug=obj(cc.pluginSummary);
  document.getElementById('topRepo').textContent=repo.name||'未选择';
  document.getElementById('topReady').textContent=ready.label||'未知';
  setDot('readyDot', ready.state==='blocked'?'red':ready.state==='needs_setup'?'amber':'green');
  document.getElementById('topConnector').textContent=ready.connectorLabel||'连接';
  setDot('connectorDot', ready.connectorTone||'gray');
  var n=ready.pendingHandoffCount||arr(cc.handoffs).length||0;
  document.getElementById('topHandoffs').textContent=n;
  document.getElementById('sideHandoffs').textContent=n;
  var readyPlugins=plug.ready||0, totalPlugins=plug.total||arr(cc.plugins).length||0;
  document.getElementById('topPlugins').textContent=totalPlugins?(readyPlugins+'/'+totalPlugins):'—';
  var need=plug.needsAttention||0;
  var sidePlugins=document.getElementById('sidePlugins');
  if(sidePlugins){
    if(need>0){sidePlugins.style.display='inline-grid';sidePlugins.textContent=String(need)}
    else {sidePlugins.style.display='none'}
  }
}

function renderHome(){
  var cc=obj(commandCenter), ready=obj(cc.readiness), work=obj(cc.currentWork), handoffs=arr(cc.handoffs).slice(0,3);
  var repo=obj(cc.currentRepository);
  var setup=obj(cc.setupGuide);
  var warnings=arr(cc.warnings).map(function(w){return '<div class="warn">'+esc(w)+'</div>'}).join('');
  var mode=obj(modePreview||cc.modePreviewDefault);
  var el=document.getElementById('view-home');
  var setupHtml=setup.needed
    ? '<div class="setup"><strong>'+esc(setup.title||'需要先设置仓库')+'</strong><p class="muted" style="margin:6px 0 10px">'+esc(setup.body||'')+'</p>'+btn(setup.actionLabel||'去设置仓库','data-nav="repositories"','primary')+'</div>'
    : '';
  el.innerHTML=
    '<div id="opBar"></div>'+
    warnings+
    setupHtml+
    '<div class="page-head"><div><h1>指挥中心</h1><p>描述目标，开始执行，然后只关注当前进度和需要你决定的事项。</p></div>'+
      '<div class="muted">当前仓库：<strong>'+esc(repo.name||'未选择')+'</strong>'+(repo.branchLabel?' · '+esc(repo.branchLabel):'')+(repo.dirtyLabel?' · '+esc(repo.dirtyLabel):'')+'</div></div>'+
    '<div class="panel composer">'+
      '<div class="section-title"><div><h2>你想让它完成什么？</h2><p class="hint">直接描述目标。路径、验收标准和执行模式由系统先判断，你仍可在开始前预览。</p></div>'+pill(ready.state==='ready'?'green':ready.state==='needs_setup'?'amber':'red',ready.label||'未知')+'</div>'+
      '<textarea id="taskObjective" placeholder="例如：优化 Controller 首页的信息层级，让当前任务和待决定事项更容易找到，不改变后端行为。"></textarea>'+
      '<details class="advanced" style="margin-top:10px"><summary>补充验收标准和允许修改的路径</summary>'+
        '<div class="row" style="margin-top:10px"><input class="input" id="taskAcceptance" placeholder="验收标准（可选，用分号分隔）" style="flex:1"></div>'+
        '<div class="row"><input class="input" id="taskPaths" placeholder="允许修改的路径（可选，逗号分隔）" style="flex:1"><input class="input" id="taskFiles" type="number" min="0" placeholder="预计文件数" style="width:140px"></div>'+
      '</details>'+
      '<div class="row" style="margin-top:14px">'+
        '<button class="btn primary" id="btnStart" onclick="startTask()">开始执行</button>'+
        '<button class="btn" id="btnPreview" onclick="previewMode()">预览执行方式</button>'+
        '<button class="btn ghost" onclick="diagnoseFirst()">只做诊断</button>'+
        '<span class="muted" style="margin-left:auto">建议：<strong>'+esc(mode.label||'直接执行')+'</strong></span>'+
      '</div>'+
    '</div>'+
    '<div class="grid two" style="margin-top:16px">'+
      renderWorkCard(work, '当前任务')+
      '<div class="panel"><div class="section-title"><h2>需要处理</h2>'+btn('查看全部','data-nav="inbox"','ghost')+'</div>'+
        (handoffs.length?handoffs.map(function(h){return handoffMini(h)}).join(''):'<div class="empty">目前没有需要你拍板的事项</div>')+
      '</div>'+
    '</div>'+
    '<div class="panel" style="margin-top:16px">'+
      '<div class="section-title"><div><h2>运行状态</h2><p class="muted" style="margin:0">'+esc(ready.headline||ready.description||'系统状态可用')+'</p></div>'+pill(ready.connectorTone||'gray',ready.connectorLabel||'连接')+'</div>'+
      '<div class="actions">'+btn('系统状态','data-nav="readiness"')+btn('能力与插件','data-nav="capabilities"')+btn('模型与工具','data-nav="automation"')+btn('切换仓库','data-nav="repositories"')+'</div>'+
    '</div>'+
    renderGoalLoopPanel(cc.goalLoop);
  bindNav(el);
  renderOpBar();
}

function renderGoalLoopPanel(gl){
  gl=obj(gl);
  var goals=arr(gl.goals);
  var inv=arr(gl.invokableProviders);
  var handoff=arr(gl.handoffOnlyProviders);
  var active=gl.activeCount||goals.length||0;
  return '<details class="panel advanced" style="margin-top:16px">'+
    '<summary style="display:flex;align-items:center;gap:10px;list-style:none">'+
      '<strong>自动化目标</strong>'+pill(active?'blue':'gray',active+' 个活跃目标')+
      '<span class="muted">'+inv.length+' 个提供方可直接调用 · '+handoff.length+' 个仅支持 Handoff</span>'+
      '<span class="muted" style="margin-left:auto">展开查看</span>'+
    '</summary>'+
    '<div style="margin-top:14px">'+
      (gl.automationSummary?'<p class="muted">'+esc(gl.automationSummary)+'</p>':'')+
      (goals.length?goals.slice(0,3).map(function(g){
        return '<div class="card-row" style="margin-top:10px"><div>'+
          '<h3>'+esc(g.title||'目标')+'</h3>'+
          '<p class="muted">阶段：'+esc(g.stage)+' · 提供方：'+esc(g.providerSelected||'—')+'</p>'+
          (g.whatIsBlocked?'<p class="muted">阻塞：'+esc(g.whatIsBlocked)+'</p>':'')+
          (g.whatHappensNext?'<p class="faint">下一步：'+esc(g.whatHappensNext)+'</p>':'')+
        '</div>'+pill(g.approvalRequired?'amber':g.handoffPacketAvailable?'blue':'green',g.handoffPacketAvailable?'有 Handoff 包':g.stage)+'</div>';
      }).join(''):'<div class="empty">暂无活跃自动化目标</div>')+
      '<div class="actions">'+btn('打开模型与工具','data-nav="automation"')+'</div>'+
    '</div>'+
  '</details>';
}

function mergeWorkExtras(work){
  work=obj(work);
  var extra=obj(workExtras[work.id]);
  if(extra.changedFiles&&!work.changedFiles)work.changedFiles=extra.changedFiles;
  if(extra.error&&!work.error)work.error=extra.error;
  if(extra.summary&&!work.latestSummary)work.latestSummary=extra.summary;
  return work;
}

function renderWorkCard(work, title){
  work=mergeWorkExtras(obj(work));
  if(!work.id){
    return '<div class="panel"><div class="section-title"><h2>'+esc(title||'当前任务')+'</h2></div><div class="empty">还没有任务。在左侧描述目标并点击“开始”。</div></div>';
  }
  var v=obj(work.latestVerification);
  var id=esc(work.id);
  var primary=work.primaryActionLabel||work.nextAction||'继续';
  var primaryKind='continue';
  var suggested=arr(work.suggestedActions);
  if(suggested.length&&suggested[0].kind)primaryKind=suggested[0].kind;
  return '<div class="panel work-card" data-work-id="'+id+'">'+
    '<div class="section-title"><h2>'+esc(title||'当前任务')+'</h2>'+pill(work.tone, work.statusLabel||work.phaseLabel||'状态')+'</div>'+
    '<h3 style="margin:0 0 6px">'+esc(work.title||work.objective||'未命名任务')+'</h3>'+
    '<div class="muted">模式：'+esc(work.modeLabel||'—')+' · 阶段：'+esc(work.phaseLabel||work.statusLabel||'—')+'</div>'+
    '<div class="muted" style="margin-top:4px">最近动作：'+esc(work.latestAction||primary)+'</div>'+
    (work.latestSummary?'<p class="muted" style="margin:8px 0 0">'+esc(work.latestSummary)+'</p>':'')+
    stepsHtml(work.progressSteps)+
    (v.summary?'<div style="margin-top:8px">'+pill(v.tone,v.label)+' <span class="muted">'+esc(v.summary)+'</span></div>':'')+
    (work.error?renderErrorBox(work.error):'')+
    renderChangedFiles(work.changedFiles)+
    (work.delegateSummary?'<p class="muted" style="margin-top:8px">'+esc(work.delegateSummary)+'</p>':'')+
    evidenceHtml(work.evidenceLabels)+
    (arr(work.acceptanceCriteria).length?'<p class="faint" style="margin-top:8px">验收：'+esc(arr(work.acceptanceCriteria).join(' · '))+'</p>':'')+
    '<div class="actions">'+
      btn(primary,'data-work-act="'+(primaryKind==='verify'?'verify':primaryKind==='finalize'?'finalize':primaryKind==='repair'?'repair':'continue')+'" data-work-id="'+id+'"','primary')+
      btn('验证','data-work-act="verify" data-work-id="'+id+'"')+
      btn('委派 Codex','data-work-act="delegate-codex" data-work-id="'+id+'"')+
      btn('请 Grok 审阅','data-work-act="delegate-grok" data-work-id="'+id+'"')+
      btn('修复诊断','data-work-act="repair" data-work-id="'+id+'"')+
      btn('收尾','data-work-act="finalize" data-work-id="'+id+'"')+
      btn('停止','data-work-act="stop" data-work-id="'+id+'"','danger')+
      btn('打开详情','data-open-work="'+id+'"','ghost')+
    '</div>'+
    advancedBlock(work.advanced)+
  '</div>';
}

function handoffMini(h){
  var id=esc(h.id);
  var d=obj(h.decision);
  return '<div class="card-row" style="margin-bottom:8px">'+
    '<div><div style="margin-bottom:6px">'+pill(h.tone,d.typeLabel||h.severityLabel||'需要决定')+'</div><h3>'+esc(h.title)+'</h3>'+
      '<p><strong>需要你决定：</strong>'+esc(d.requestedAction||h.reason||'请打开查看详情')+'</p>'+
      '<div class="faint">'+esc(d.afterApproval||h.recommendedDecision||'请先阅读详情')+'</div></div>'+
    '<div class="actions" style="flex-direction:column">'+
      btn(d.canApproveAndContinue?'查看审批详情':'查看并决定','data-open-handoff="'+id+'"','primary')+
    '</div></div>';
}

function renderInbox(){
  var items=arr(obj(commandCenter).handoffs);
  var detail=selectedHandoffId?items.find(function(x){return x.id===selectedHandoffId}):null;
  if(!detail&&items.length){selectedHandoffId=items[0].id;detail=items[0]}
  var root=document.getElementById('view-inbox');
  root.innerHTML=
    '<div class="page-head"><div><h1>需要处理</h1><p>这里只展示真正阻塞执行的业务决定、不可逆操作和无法自动恢复的问题。</p></div><button class="btn" onclick="refreshAll()">刷新</button></div>'+
    '<div class="grid two">'+
      '<div class="list">'+(items.length?items.map(function(h){
        var id=esc(h.id);var d=obj(h.decision);
        return '<div class="panel" style="padding:14px;cursor:pointer;border-color:'+(selectedHandoffId===h.id?'rgba(96,165,250,.45)':'')+'" data-open-handoff="'+id+'">'+
          '<div class="section-title"><h3 style="margin:0">'+esc(h.title)+'</h3>'+pill(h.tone,d.typeLabel||h.severityLabel)+'</div>'+
          '<p class="muted"><strong>需要决定：</strong>'+esc(d.requestedAction||h.reason)+'</p>'+
          '<p class="faint"><strong>处理后：</strong>'+esc(d.afterApproval||h.recommendedDecision||'—')+'</p></div>';
      }).join(''):'<div class="empty">没有待审批或待决定事项。你可以回到指挥中心开始新任务。</div>')+'</div>'+
      '<div class="panel" id="handoffDetail">'+(detail?renderHandoffDetail(detail):'<div class="empty">选择左侧事项查看详情</div>')+'</div>'+
    '</div>';
  bindActions(root);
}

function renderHandoffDetail(h){
  var id=esc(h.id);var d=obj(h.decision);
  var primary=d.canApproveAndContinue
    ? btn(d.primaryActionLabel||'批准并继续执行','data-handoff-act="approve" data-handoff-id="'+id+'"','primary')
    : btn(d.primaryActionLabel||'记录决定','data-handoff-act="resolve" data-handoff-id="'+id+'"','primary');
  return '<div class="section-title"><div><h2>'+esc(h.title)+'</h2><div>'+pill(h.tone,d.typeLabel||h.severityLabel)+' '+pill(d.necessityLabel==='必须确认'?'amber':'gray',d.necessityLabel||'需要判断')+'</div></div>'+pill(h.tone,h.statusLabel)+'</div>'+
    '<div class="setup" style="margin:12px 0"><strong>你正在批准 / 决定什么</strong><p class="muted" style="margin:6px 0 0">'+esc(d.requestedAction||h.reason||'—')+'</p></div>'+
    '<div class="decision-grid">'+
      '<div class="decision-box"><strong>是否有必要</strong><p>'+esc(d.necessityExplanation||h.reason||'—')+'</p></div>'+
      '<div class="decision-box"><strong>会产生什么影响</strong><p>'+esc(d.impact||'—')+'</p></div>'+
      '<div class="decision-box"><strong>批准 / 记录后</strong><p>'+esc(d.afterApproval||'—')+'</p></div>'+
      '<div class="decision-box"><strong>不批准会怎样</strong><p>'+esc(d.ifRejected||'—')+'</p></div>'+
    '</div>'+
    '<div class="flow"><div class="flow-step">1. 当前停在安全点</div><div class="flow-arrow">→</div><div class="flow-step">2. 阅读对象、必要性和影响</div><div class="flow-arrow">→</div><div class="flow-step">3. '+esc(d.canApproveAndContinue?'批准后创建任务':'记录决定或补充信息')+'</div><div class="flow-arrow">→</div><div class="flow-step">4. 打开任务详情并显示下一步</div></div>'+
    '<p><strong>为什么停下来</strong><br><span class="muted">'+esc(h.reason)+'</span></p>'+
    '<p><strong>相关任务</strong><br><span class="muted">'+esc(h.workTitle||'尚未创建任务')+'</span></p>'+
    '<div class="setup" style="margin:10px 0"><strong>系统建议</strong><p class="muted" style="margin:6px 0 0">'+esc(h.recommendedDecision||'请阅读后自行判断')+'</p></div>'+
    (arr(h.attemptedActions).length?'<p><strong>已尝试</strong><br><span class="muted">'+esc(h.attemptedActions.join(' · '))+'</span></p>':'')+
    evidenceHtml(h.evidenceLabels)+
    '<div class="actions">'+primary+
      (d.canApproveAndContinue?btn('仅记录其他决定','data-handoff-act="resolve" data-handoff-id="'+id+'"'):'')+
      btn('确认已知晓','data-handoff-act="ack" data-handoff-id="'+id+'"')+
      btn('暂不处理','data-handoff-act="dismiss" data-handoff-id="'+id+'"')+
      (h.continuationPrompt?btn('复制人工继续提示','data-copy="1" data-copy-text="'+esc(h.continuationPrompt)+'"'):'')+
      (h.advanced&&h.advanced.workId?btn('查看相关任务','data-open-work="'+esc(h.advanced.workId)+'"'):'')+
    '</div>'+
    advancedBlock(h.advanced);
}

function renderWork(){
  var work=null;
  if(selectedWorkId){
    var all=[obj(commandCenter).currentWork].concat(arr(obj(commandCenter).recentWork));
    work=all.find(function(w){return w&&w.id===selectedWorkId})||obj(commandCenter).currentWork;
  } else {
    work=obj(commandCenter).currentWork;
  }
  var recent=arr(obj(commandCenter).recentWork);
  var root=document.getElementById('view-work');
  root.innerHTML=
    '<div class="page-head"><div><h1>任务详情</h1><p>用自然语言理解进度，不必关心内部 ID。</p></div></div>'+
    renderWorkCard(work,'任务')+
    '<div class="panel" style="margin-top:14px"><div class="section-title"><h2>最近任务</h2></div>'+
      (recent.length?recent.map(function(w){
        return '<div class="card-row" style="margin-bottom:8px"><div><h3>'+esc(w.title)+'</h3><div class="muted">'+esc(w.modeLabel)+' · '+esc(w.statusLabel)+'</div></div>'+
          btn('打开','data-open-work="'+esc(w.id)+'"')+'</div>';
      }).join(''):'<div class="empty">暂无任务记录</div>')+
    '</div>';
  bindActions(root);
}

function renderConnectorHowToFix(fresh){
  fresh=obj(fresh);
  var steps=arr(fresh.howToFix);
  if(!steps.length && !fresh.summary) return '';
  var actions=arr(fresh.suggestedActions);
  return '<div class="panel" style="margin-top:14px">'+
    '<div class="section-title"><h2 style="margin:0">连接器诊断</h2>'+pill(fresh.severity==='error'?'red':fresh.severity==='warning'?'amber':fresh.severity==='ok'?'green':'blue', fresh.severity||'info')+'</div>'+
    '<p class="muted">'+esc(fresh.summary||'')+'</p>'+
    (arr(fresh.expectedFacadeTools).length?'<p class="faint">期望 facade：'+esc(arr(fresh.expectedFacadeTools).join(' · '))+'</p>':'')+
    (arr(fresh.missingLocalTools).length?'<p class="muted">本地缺失：'+esc(arr(fresh.missingLocalTools).join(', '))+'</p>':'')+
    (arr(fresh.missingConnectorTools).length?'<p class="muted">连接器快照缺失：'+esc(arr(fresh.missingConnectorTools).join(', '))+'</p>':'')+
    (steps.length
      ? '<details class="advanced" style="margin-top:10px"><summary>如何修复</summary><ol style="margin:10px 0 0 18px;color:var(--muted);font-size:13px;line-height:1.55">'+
        steps.map(function(s){return '<li>'+esc(s)+'</li>';}).join('')+
        '</ol>'+
        (actions.length?'<p class="faint" style="margin-top:10px">建议：'+esc(actions.join(' · '))+'</p>':'')+
        '</details>'
      : '')+
  '</div>';
}

function renderReadiness(){
  var ready=obj(obj(commandCenter).readiness);
  var fresh=obj(ready.connectorFreshness);
  document.getElementById('view-readiness').innerHTML=
    '<div class="page-head"><div><h1>系统状态</h1><p>用白话告诉你 repo-harness 是否可用。</p></div>'+
      '<div class="actions"><button class="btn primary" onclick="diagnoseFirst()">诊断</button><button class="btn" onclick="repairDryRun()">预览修复</button></div></div>'+
    '<div class="panel" style="margin-bottom:14px"><h2>'+esc(ready.headline||'')+'</h2><p class="muted">'+esc(ready.description||'')+'</p></div>'+
    '<div class="grid cards">'+arr(ready.sections).map(function(s){
      return '<div class="panel"><div class="section-title"><h3 style="margin:0">'+esc(s.title)+'</h3>'+pill(s.tone,s.statusLabel)+'</div><p class="muted">'+esc(s.detail)+'</p></div>';
    }).join('')+'</div>'+
    renderConnectorHowToFix(fresh);
}

function renderRepositories(){
  var repos=arr(obj(commandCenter).repositories);
  var root=document.getElementById('view-repositories');
  root.innerHTML=
    '<div class="page-head"><div><h1>仓库</h1><p>选择当前工作仓库。显示名称、分支和是否干净会直接影响你是否能开始任务。</p></div>'+
      '<button class="btn primary" onclick="toggleAddRepo()">添加本地仓库</button></div>'+
    '<div class="panel" id="repoAdd" style="display:none;margin-bottom:14px">'+
      '<div class="row" style="display:grid;grid-template-columns:1.4fr .8fr auto;gap:10px">'+
        '<input class="input" id="repoPath" placeholder="./YourRepo">'+
        '<input class="input" id="repoName" placeholder="显示名称（可选）">'+
        '<button class="btn primary" onclick="registerRepo()">注册</button>'+
      '</div></div>'+
    (repos.length?'':'<div class="setup"><strong>还没有仓库</strong><p class="muted" style="margin:6px 0 0">添加一个本地 Git 仓库后，指挥中心才能启动任务。</p></div>')+
    '<div class="list">'+repos.map(function(r){
      return '<div class="panel card-row"><div><h3>'+esc(r.name)+'</h3><div class="muted mono">'+esc(r.path)+'</div>'+
        '<div class="muted" style="margin-top:6px">'+(r.branchLabel?('分支 '+esc(r.branchLabel)):'')+(r.dirtyLabel?' · '+esc(r.dirtyLabel):'')+(r.readinessLabel?' · '+esc(r.readinessLabel):'')+'</div></div>'+
        '<div class="actions">'+
          btn(r.current?'当前仓库':'设为当前','data-select-repo="'+esc(r.id)+'"',r.current?'primary':'')+
          btn('删除注册','data-remove-repo="'+esc(r.id)+'" data-remove-repo-name="'+esc(r.name||r.id)+'"','danger')+
        '</div>'+
        advancedBlock(r.advanced)+
      '</div>';
    }).join('')+'</div>';
  bindActions(root);
}

function rememberPlugin(id){
  selectedPluginId=id||'';
  safeSet('repoHarnessSelectedPluginId', selectedPluginId);
}

function pluginById(id){
  return arr(obj(commandCenter).plugins).find(function(p){return p.id===id})||null;
}

function renderCapabilities(){
  var cc=obj(commandCenter);
  var plugins=arr(cc.plugins);
  var summary=obj(cc.pluginSummary);
  var selected=selectedPluginId?pluginById(selectedPluginId):null;
  if(selectedPluginId&&!selected&&plugins.length){
    selected=plugins[0];
    rememberPlugin(selected.id);
  }
  var ready=summary.ready||plugins.filter(function(p){return p.status==='ready'}).length;
  var need=summary.needsAttention||plugins.filter(function(p){return p.status!=='ready'&&p.status!=='disabled'}).length;
  var failed=plugins.filter(function(p){return p.status==='failed'||p.status==='disabled'}).length;
  var root=document.getElementById('view-capabilities');
  root.innerHTML=
    '<div class="page-head"><div><h1>能力 / 插件</h1><p>预览并管理 repo-harness 可调用的助手插件；普通动作直接执行，不可逆操作需要强确认。</p></div>'+
      '<div class="actions"><button class="btn" onclick="refreshPlugins()">检查连接</button></div></div>'+
    '<div class="grid stats" style="margin-bottom:14px">'+
      '<div class="panel stat"><span>能力总数</span><strong>'+plugins.length+'</strong></div>'+
      '<div class="panel stat"><span>可用</span><strong>'+ready+'</strong></div>'+
      '<div class="panel stat"><span>需要配置</span><strong>'+need+'</strong></div>'+
      '<div class="panel stat"><span>不可用</span><strong>'+failed+'</strong></div>'+
    '</div>'+
    '<div class="grid two">'+
      '<div class="list">'+
        (plugins.length?plugins.map(function(p){
          var active=selected&&selected.id===p.id;
          return '<div class="panel plugin-card" style="cursor:pointer;border-color:'+(active?'rgba(96,165,250,.45)':'')+'" data-open-plugin="'+esc(p.id)+'">'+
            '<div><h3 style="margin:0 0 6px">'+esc(p.name)+'</h3>'+
              '<div class="muted">'+esc(p.description||'')+'</div>'+
              '<div class="muted" style="margin-top:6px">'+esc(p.nextStep||'')+'</div>'+
              (arr(p.capabilityLabels).length?'<div class="evidence" style="margin-top:8px">'+arr(p.capabilityLabels).map(function(c){return '<span>'+esc(c)+'</span>'}).join('')+'</div>':'')+
            '</div>'+
            '<div style="text-align:right">'+pill(p.tone,p.statusLabel)+
              '<div class="actions" style="margin-top:8px;justify-content:flex-end">'+btn(active?'已选中':'查看', 'data-open-plugin="'+esc(p.id)+'"', active?'primary':'')+'</div>'+
            '</div></div>';
        }).join(''):'<div class="empty">当前仓库没有发现插件</div>')+
      '</div>'+
      '<div class="panel" id="pluginDetail">'+renderPluginDetail(selected)+'</div>'+
    '</div>'+
    (pluginActionResult?'<div class="panel" style="margin-top:14px"><div class="section-title"><h2>最近动作结果</h2></div><pre class="mono" style="white-space:pre-wrap;font-size:12px;color:var(--muted)">'+esc(JSON.stringify(pluginActionResult,null,2))+'</pre></div>':'');
  bindActions(root);
}

function renderPluginDetail(p){
  if(!p||!p.id){
    return '<div class="empty">选择左侧插件查看能力、健康状态与可执行动作</div>';
  }
  var actions=arr(p.actions);
  var previewActions=actions.filter(function(a){return a.canPreview});
  var otherActions=actions.filter(function(a){return !a.canPreview});
  return '<div class="section-title"><h2 style="margin:0">'+esc(p.name)+'</h2>'+pill(p.tone,p.statusLabel)+'</div>'+
    '<p class="muted">'+esc(p.nextStep||'')+'</p>'+
    '<div class="meta muted" style="display:flex;gap:10px;flex-wrap:wrap;margin:8px 0 12px">'+
      '<span>提供方：'+esc(p.provider||'—')+'</span>'+
      '<span>健康：'+esc(p.healthLabel||'—')+'</span>'+
      '<span>生命周期：'+esc(p.lifecycleLabel||'—')+'</span>'+
      '<span>动作：'+esc(String(p.actionCount||actions.length))+'</span>'+
    '</div>'+
    (arr(p.warnings).length?'<div class="warn">'+esc(arr(p.warnings).join(' · '))+'</div>':'')+
    (arr(p.capabilityLabels).length?'<p><strong>能力域</strong></p><div class="evidence">'+arr(p.capabilityLabels).map(function(c){return '<span>'+esc(c)+'</span>'}).join('')+'</div>':'')+
    '<div style="margin-top:14px"><div class="section-title"><h3 style="margin:0">预览 / 状态动作</h3><span class="muted">只读或配置检查，优先使用</span></div>'+
      (previewActions.length?previewActions.map(function(a){return pluginActionRow(p.id,a,true)}).join(''):'<div class="empty">没有可预览动作</div>')+
    '</div>'+
    '<div style="margin-top:14px"><div class="section-title"><h3 style="margin:0">写入动作</h3><span class="muted">只有不可逆操作需要强确认</span></div>'+
      (otherActions.length?otherActions.map(function(a){return pluginActionRow(p.id,a,false)}).join(''):'<div class="empty">没有写入动作</div>')+
    '</div>'+
    advancedBlock(p.advanced);
}

function pluginActionRow(pluginId, action, isPreview){
  var id=esc(pluginId), aid=esc(action.id);
  return '<div class="action-row">'+
    '<div><div><strong>'+esc(action.title||action.id)+'</strong> '+pill(action.readOnly?'green':action.risk==='destructive'?'red':'amber', action.riskLabel)+'</div>'+
      '<div class="muted">'+esc(action.description||'')+'</div>'+
      '<div class="faint">'+esc(action.confirmationLabel||'')+'</div></div>'+
    '<div class="actions">'+
      btn(isPreview?'运行预览':'执行', 'data-plugin-act="run" data-plugin-id="'+id+'" data-action-id="'+aid+'"', isPreview?'primary':'')+
    '</div></div>';
}

function fmtDuration(ms){
  if(typeof ms!=='number'||!isFinite(ms)||ms<0)return '—';
  if(ms<1000)return Math.round(ms)+' ms';
  var sec=ms/1000;
  if(sec<60)return (sec<10?sec.toFixed(1):Math.round(sec))+' s';
  var min=Math.floor(sec/60), rem=Math.round(sec%60);
  return min+'m '+rem+'s';
}

function renderConnectivitySection(payload){
  payload=obj(payload);
  var conn=obj(payload.connectivity);
  var summary=obj(conn.summary);
  if(!summary.headline)return '';
  var latest=obj(conn.latestEvent);
  var attr=obj(latest.attribution||summary.latestAttribution);
  var observations=arr(latest.observations);
  var jobs=arr(latest.jobTimings);
  var counts=obj(summary.attributionCounts);
  var evidence=arr(attr.evidence);
  return '<div class="panel" style="margin-bottom:14px">'+
    '<div class="section-title"><h2 style="margin:0">连接稳定性</h2>'+pill(summary.tone||attr.tone||'gray', summary.statusLabel||attr.overallStatusLabel||'观察中')+'</div>'+
    '<p class="muted">'+esc(summary.headline||'')+'</p>'+
    '<div class="muted" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:8px">'+
      '<span>归因：'+esc(attr.categoryLabel||'—')+'</span>'+
      '<span>置信度：'+esc(attr.confidenceLabel||'—')+'</span>'+
      '<span>最近探测：'+esc(summary.latestObservedAt||'—')+'</span>'+
      '<span>样本：'+esc(String(summary.eventsStored||0))+'</span>'+
    '</div>'+
    '<div class="evidence" style="margin-top:10px">'+
      '<span>公网路径 '+esc(String(counts.public_path||0))+'</span>'+
      '<span>Gateway '+esc(String(counts.gateway||0))+'</span>'+
      '<span>Local Bridge '+esc(String(counts.local_bridge||0))+'</span>'+
      '<span>Controller '+esc(String(counts.controller||0))+'</span>'+
      '<span>连接器/未知 '+esc(String(counts.connector_or_unknown||0))+'</span>'+
    '</div>'+
    (observations.length?'<div class="grid cards" style="margin-top:14px">'+observations.map(function(item){
      item=obj(item);
      return '<div class="panel" style="padding:12px;background:rgba(255,255,255,.02)">'+
        '<div class="section-title"><strong>'+esc(item.label||item.component||'组件')+'</strong>'+pill(item.tone||'gray', item.stateLabel||item.state||'未知')+'</div>'+
        '<p class="muted" style="margin:0">'+esc(item.detail||'')+'</p>'+
      '</div>';
    }).join('')+'</div>':'')+
    (jobs.length?'<div style="margin-top:14px"><div class="section-title"><h3 style="margin:0">最近 durable Job 时序</h3><span class="muted">基于 queued/dispatched/started/finished 持久时间戳</span></div><div class="list">'+jobs.map(function(job){
      job=obj(job);
      return '<div class="card-row" style="padding:12px"><div><h3 style="margin:0 0 6px">'+esc(job.operation||job.jobId||'job')+'</h3>'+
        '<p class="muted">Job '+esc(job.jobId||'—')+' · '+esc(job.statusLabel||job.status||'未知')+' · '+esc(job.stageLabel||'—')+'</p>'+
        '<div class="evidence">'+
          '<span>排队 '+esc(fmtDuration(job.queuedDelayMs))+'</span>'+
          '<span>派发到启动 '+esc(fmtDuration(job.dispatchToStartMs))+'</span>'+
          '<span>执行 '+esc(fmtDuration(job.executionDurationMs))+'</span>'+
          '<span>总计 '+esc(fmtDuration(job.totalMs))+'</span>'+
        '</div></div>'+pill((job.status==='failed'||job.status==='timed_out'||job.status==='orphaned'||job.status==='stale')?'red':(job.status==='running'||job.status==='dispatched')?'blue':'gray', job.statusLabel||job.status||'')+'</div>';
    }).join('')+'</div></div>':'')+
    (evidence.length?'<details class="advanced" style="margin-top:14px"><summary>归因证据</summary><ul style="margin:10px 0 0 18px;color:var(--muted);font-size:13px;line-height:1.55">'+evidence.map(function(line){return '<li>'+esc(line)+'</li>';}).join('')+'</ul></details>':'')+
  '</div>';
}

function renderAdvanced(){
  var root=document.getElementById('view-advanced');
  var payload=advancedRaw||lastFacade||{note:'点击“读取原始快照”加载调试数据。日常任务请使用指挥中心。'};
  root.innerHTML=
    '<div class="page-head"><div><h1>高级诊断</h1><p>仅用于排错。默认任务流请回到指挥中心，不要从这里开始日常开发。</p></div>'+
      '<div class="actions"><button class="btn" onclick="loadAdvanced()">读取原始快照</button>'+
      '<button class="btn" onclick="copyText(JSON.stringify(advancedRaw||lastFacade||{},null,2))">复制 JSON</button>'+
      btn('返回指挥中心','data-nav="home"','primary')+'</div></div>'+
    renderConnectivitySection(payload)+
    '<div class="panel"><div class="warn">调试信息默认折叠，避免干扰主流程。</div>'+
      '<details class="advanced" open><summary>原始 JSON（调试）</summary>'+
      '<pre class="mono" style="white-space:pre-wrap;font-size:12px;color:var(--muted);max-height:60vh;overflow:auto">'+esc(JSON.stringify(payload,null,2))+'</pre></details></div>';
  bindNav(root);
}

function renderAutomation(){
  var root=document.getElementById('view-automation');
  if(!root)return;
  var s=obj(automationSettings);
  if(!s.schemaVersion){
    root.innerHTML='<div class="page-head"><div><h1>模型与工具提供方</h1><p>配置 LLM、本地工具与路由偏好。</p></div>'+
      '<button class="btn primary" onclick="loadAutomationSettings()">加载配置</button></div>'+
      '<div class="empty">正在读取 Automation Settings…</div>';
    loadAutomationSettings();
    return;
  }
  var ov=obj(s.overview);
  var providers=arr(s.providers);
  var tools=arr(s.localTools);
  var creds=arr(s.credentials);
  var routing=obj(s.routing);
  var warnings=arr(s.warnings).map(function(w){return '<div class="warn">'+esc(w)+'</div>'}).join('');
  root.innerHTML=
    '<div class="page-head"><div><h1>模型与工具提供方</h1><p>控制 goal loop 可用哪些 LLM / 本地工具、优先级与安全策略。密钥只读状态，永不展示值。</p></div>'+
      '<div class="actions"><button class="btn" onclick="loadAutomationSettings()">刷新</button>'+
      '<button class="btn" onclick="previewRoute()">预览路由</button>'+
      '<button class="btn danger" onclick="resetProviders()">恢复默认</button></div></div>'+
    warnings+
    '<div class="panel" style="margin-bottom:14px"><h2>总览</h2>'+
      '<p class="muted">'+esc(ov.plainLanguageSummary||'')+'</p>'+
      '<div class="grid stats" style="margin-top:10px">'+
        '<div class="stat"><span>Goal loop</span><strong>'+(ov.goalLoopEnabled?'开':'关')+'</strong></div>'+
        '<div class="stat"><span>Live API（有效）</span><strong>'+(ov.liveModelProvidersEffective?'开':'关')+'</strong></div>'+
        '<div class="stat"><span>直接可用</span><strong>'+esc(String(ov.directProvidersReady||0))+'</strong></div>'+
        '<div class="stat"><span>需配置</span><strong>'+esc(String(ov.providersNeedingConfig||0))+'</strong></div>'+
      '</div>'+
      '<p class="faint" style="margin-top:10px">环境 Live 标志：'+(ov.liveModelProvidersEnv?'已设置':'未设置')+' · GUI 偏好：'+(ov.liveModelProvidersPreference?'已开启':'未开启')+' · 两者同时满足才允许远程 API 直接调度。</p>'+
      '<div class="actions" style="margin-top:10px">'+
        '<button class="btn" onclick="toggleLivePref('+(ov.liveModelProvidersPreference?'false':'true')+')">'+(ov.liveModelProvidersPreference?'关闭 GUI Live 偏好':'开启 GUI Live 偏好')+'</button>'+
        '<button class="btn" onclick="toggleGoalLoop('+(ov.goalLoopEnabled?'false':'true')+')">'+(ov.goalLoopEnabled?'暂停 Goal Loop':'启用 Goal Loop')+'</button>'+
      '</div>'+
      '<p class="muted" style="margin-top:10px">默认路由：小改动 <strong>'+esc(obj(ov.defaultRoutes).small_edit||'—')+'</strong> · 实现 <strong>'+esc(obj(ov.defaultRoutes).normal_code_task||'—')+'</strong> · 修复 <strong>'+esc(obj(ov.defaultRoutes).repair||'—')+'</strong> · 规划 <strong>'+esc(obj(ov.defaultRoutes).planning||'—')+'</strong></p>'+
    '</div>'+
    '<div class="panel" style="margin-bottom:14px"><div class="section-title"><h2>LLM 提供方</h2></div><div class="list">'+
      providers.map(function(p){return providerCardHtml(p)}).join('')+
    '</div></div>'+
    '<div class="panel" style="margin-bottom:14px"><div class="section-title"><h2>API 凭证状态</h2><span class="muted">env 或页面存储 · 永不显示明文</span></div>'+
      (creds.length?creds.map(function(c){
        return '<div class="card-row" style="margin-bottom:8px"><div>'+
          '<h3>'+esc(c.displayName)+'</h3>'+
          '<p class="muted">URL：'+esc(c.baseUrl||'—')+' · model：'+esc(c.model||'—')+'</p>'+
          '<p class="muted">env：'+(arr(c.presentEnvVars).length?esc(arr(c.presentEnvVars).join(', ')):'未设置')+
            ' · 页面密钥：'+(c.storedAuthPresent?esc(c.storedKeyHint||'已保存'):'未保存')+'</p>'+
          '<p class="faint">模式：'+esc(c.storageMode)+'</p>'+
          '<details class="advanced"><summary>Shell 示例</summary><pre class="mono" style="white-space:pre-wrap;font-size:12px;color:var(--muted)">'+esc(c.setupExample||'')+'</pre></details>'+
        '</div>'+pill(c.authPresent?'green':'amber', c.authPresent?'已配置':'缺失')+'</div>';
      }).join(''):'<div class="empty">无 API 凭证条目</div>')+
    '</div>'+
    '<div class="panel" style="margin-bottom:14px"><div class="section-title"><h2>本地执行工具</h2></div><div class="list">'+
      tools.map(function(t){
        return '<div class="card-row" style="margin-bottom:8px"><div>'+
          '<h3>'+esc(t.displayName)+'</h3>'+
          '<p class="muted">'+esc(t.summary||'')+'</p>'+
          (t.executablePath?'<p class="faint mono">'+esc(t.executablePath)+(t.version?(' · '+esc(t.version)):'')+'</p>':'')+
          '<div class="evidence">'+(arr(t.usedByWorkflows).map(function(w){return '<span>'+esc(w)+'</span>'}).join(''))+'</div>'+
        '</div><div class="actions" style="flex-direction:column">'+
          pill(t.status==='detected'?'green':t.status==='disabled'?'gray':'amber', t.status)+
          (t.enabled
            ? '<button class="btn" onclick="setToolEnabled(\\''+esc(t.toolId)+'\\',false)">禁用</button>'
            : '<button class="btn primary" onclick="setToolEnabled(\\''+esc(t.toolId)+'\\',true)">启用</button>')+
          '<button class="btn ghost" onclick="healthTool(\\''+esc(t.toolId)+'\\')">健康检查</button>'+
        '</div></div>';
      }).join('')+
    '</div></div>'+
    '<div class="panel" style="margin-bottom:14px"><div class="section-title"><h2>路由偏好</h2><button class="btn" onclick="resetRouting()">使用自动路由</button></div>'+
      '<p class="muted">自动路由会按提供方优先级、能力和健康状态选择；显式路由会覆盖通用优先级。Handoff-only（ChatGPT）只能作为回退。</p>'+
      ['implementation','repair','planning','review','browser_planning','ios_analysis'].map(function(key){
        var order=arr(obj(routing.orders)[key]);
        return '<div style="margin:10px 0;padding:10px;border:1px solid var(--line);border-radius:12px">'+
          '<strong>'+esc(key)+'</strong><div class="muted mono" style="margin-top:6px">'+esc(order.join(' → ')||'—')+'</div></div>';
      }).join('')+
      '<p class="faint">若无可直接调用提供方：repo-harness 会创建 continuation packet，而不是假装调用 ChatGPT 会话。</p>'+
    '</div>'; 
  bindNav(root);
}

function providerCardHtml(p){
  p=obj(p);
  var id=esc(p.providerId);
  var handoff=!!p.handoffOnly;
  var api=obj(p.apiSettings);
  var apiForm='';
  if(api.configurable){
    var keyHint=api.hasStoredApiKey?('已保存密钥 '+(api.storedKeyHint||'••••')):(p.credential&&p.credential.envAuthPresent?'使用环境变量':'未配置密钥');
    apiForm=
      '<div class="setup" style="margin-top:10px">'+
        '<strong>API 配置</strong>'+
        '<p class="faint" style="margin:4px 0 8px">密钥仅存 controllerHome，不进 git；列表接口永不回显明文。</p>'+
        '<label class="faint">Base URL</label>'+
        '<input class="input" id="api-url-'+id+'" value="'+esc(api.baseUrl||api.defaultBaseUrl||'')+'" placeholder="'+esc(api.defaultBaseUrl||'https://…')+'">'+
        '<label class="faint" style="display:block;margin-top:8px">Model</label>'+
        '<input class="input" id="api-model-'+id+'" value="'+esc(api.model||api.defaultModel||'')+'" placeholder="'+esc(api.defaultModel||'model-id')+'">'+
        '<label class="faint" style="display:block;margin-top:8px">API Key（留空则保留原密钥）</label>'+
        '<input class="input" id="api-key-'+id+'" type="password" autocomplete="off" placeholder="'+esc(keyHint)+'">'+
        '<div class="actions" style="margin-top:8px">'+
          '<button class="btn primary" onclick="saveProviderApi(\\''+id+'\\')">保存 API 配置</button>'+
          (api.hasStoredApiKey?'<button class="btn danger" onclick="clearProviderApiKey(\\''+id+'\\')">清除已存密钥</button>':'')+
        '</div>'+
        '<p class="faint" style="margin-top:6px">状态：'+esc(keyHint)+
          (p.credential&&p.credential.envAuthPresent?' · 环境变量已就绪':'')+
        '</p>'+
      '</div>';
  }
  return '<div class="card-row" style="margin-bottom:10px;grid-template-columns:1fr"><div>'+
    '<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:start">'+
      '<div>'+
        '<div class="section-title" style="margin:0"><h3 style="margin:0">'+esc(p.displayName)+'</h3>'+pill(p.directDispatch?'green':handoff?'blue':p.status==='disabled'?'gray':'amber', p.statusLabel)+'</div>'+
        '<p class="muted">'+esc(p.kindLabel)+' · 优先级 '+esc(String(p.priority))+'</p>'+
        '<p class="muted">'+esc(p.explanation||p.summary||'')+'</p>'+
        '<div class="evidence">'+(arr(p.capabilities).slice(0,8).map(function(c){return '<span>'+esc(c)+'</span>'}).join(''))+'</div>'+
        '<p class="faint" style="margin-top:6px">文件直接改动：'+(p.safety&&p.safety.canMutateFilesDirectly?'是':'否')+
          ' · harness apply：'+(p.safety&&p.safety.requiresRepoHarnessApply?'是':'否')+
          ' · 外部副作用：'+esc((p.safety&&p.safety.externalSideEffects)||'approval_required')+'</p>'+
        (p.lastErrorSummary?'<p class="faint">最近错误码：'+esc(p.lastErrorSummary)+'</p>':'')+
        (handoff?'<div class="setup" style="margin-top:8px"><strong>Direct dispatch：不支持</strong><p class="muted" style="margin:6px 0 0">'+esc(p.explanation||'')+'</p></div>':'')+
        apiForm+
      '</div>'+
      '<div class="actions" style="flex-direction:column">'+
        (!handoff?(p.enabled
          ? '<button class="btn" onclick="setProviderEnabled(\\''+id+'\\',false)">禁用</button>'
          : '<button class="btn primary" onclick="setProviderEnabled(\\''+id+'\\',true)">启用</button>'):'<span class="pill blue">Handoff-only</span>')+
        (!handoff?'<button class="btn ghost" onclick="moveProvider(\\''+id+'\\',\\'up\\')">优先级↑</button><button class="btn ghost" onclick="moveProvider(\\''+id+'\\',\\'down\\')">优先级↓</button>':'')+
        '<button class="btn ghost" onclick="healthProvider(\\''+id+'\\')">健康检查</button>'+
      '</div>'+
    '</div>'+
  '</div></div>';
}

function loadAutomationSettings(){
  return api('/api/console/automation-settings'+repoQuery()).then(function(res){
    automationSettings=res;
    renderAutomation();
  }).catch(function(e){toast(e.message||'加载配置失败')});
}
function setProviderEnabled(id,on){
  setBusy(true,on?'启用提供方':'禁用提供方');
  api('/api/console/providers/'+encodeURIComponent(id)+'/'+(on?'enable':'disable')+repoQuery(),{method:'POST',body:'{}'}).then(function(){
    toast(on?'已启用':'已禁用');return loadAutomationSettings();
  }).catch(function(e){toast(e.message)}).finally(function(){setBusy(false)});
}
function moveProvider(id,dir){
  setBusy(true,'调整优先级');
  api('/api/console/providers/'+encodeURIComponent(id)+'/priority'+repoQuery(),{method:'POST',body:JSON.stringify({direction:dir})}).then(function(){
    toast('优先级已更新');return loadAutomationSettings();
  }).catch(function(e){toast(e.message)}).finally(function(){setBusy(false)});
}
function healthProvider(id){
  api('/api/console/providers/health'+repoQuery(),{method:'POST',body:JSON.stringify({providerId:id})}).then(function(res){
    toast((res.health&&res.health.summary)||'健康检查完成');
    advancedRaw=res; 
  }).catch(function(e){toast(e.message)});
}
function saveProviderApi(id){
  var urlEl=document.getElementById('api-url-'+id);
  var modelEl=document.getElementById('api-model-'+id);
  var keyEl=document.getElementById('api-key-'+id);
  var body={
    baseUrl:urlEl?String(urlEl.value||'').trim():undefined,
    model:modelEl?String(modelEl.value||'').trim():undefined
  };
  if(keyEl&&String(keyEl.value||'').trim())body.apiKey=String(keyEl.value).trim();
  setBusy(true,'保存 API 配置');
  api('/api/console/providers/'+encodeURIComponent(id)+'/api-settings'+repoQuery(),{method:'POST',body:JSON.stringify(body)}).then(function(res){
    toast('已保存 '+id+(res.storedKeyHint?(' · 密钥 '+res.storedKeyHint):''));
    if(keyEl)keyEl.value='';
    return loadAutomationSettings();
  }).catch(function(e){toast(e.message)}).finally(function(){setBusy(false)});
}
function clearProviderApiKey(id){
  if(!confirm('清除页面保存的 API Key？（环境变量密钥不受影响）'))return;
  setBusy(true,'清除密钥');
  api('/api/console/providers/'+encodeURIComponent(id)+'/api-settings'+repoQuery(),{method:'POST',body:JSON.stringify({clearApiKey:true})}).then(function(){
    toast('已清除存储密钥');return loadAutomationSettings();
  }).catch(function(e){toast(e.message)}).finally(function(){setBusy(false)});
}
function setToolEnabled(id,on){
  setBusy(true,on?'启用工具':'禁用工具');
  api('/api/console/local-tools/'+encodeURIComponent(id)+'/'+(on?'enable':'disable')+repoQuery(),{method:'POST',body:'{}'}).then(function(){
    toast(on?'工具已启用':'工具已禁用');return loadAutomationSettings();
  }).catch(function(e){toast(e.message)}).finally(function(){setBusy(false)});
}
function healthTool(id){
  api('/api/console/local-tools/health'+repoQuery(),{method:'POST',body:JSON.stringify({toolId:id})}).then(function(res){
    toast((res.tool&&res.tool.summary)||'工具检查完成');
  }).catch(function(e){toast(e.message)});
}
function toggleLivePref(on){
  setBusy(true,'更新 Live 偏好');
  api('/api/console/provider-config'+repoQuery(),{method:'POST',body:JSON.stringify({preferLiveModelProviders:!!on})}).then(function(){
    toast(on?'已开启 GUI Live 偏好（仍需环境变量）':'已关闭 GUI Live 偏好');return loadAutomationSettings();
  }).catch(function(e){toast(e.message)}).finally(function(){setBusy(false)});
}
function toggleGoalLoop(on){
  setBusy(true,'更新 Goal Loop');
  api('/api/console/provider-config'+repoQuery(),{method:'POST',body:JSON.stringify({goalLoopEnabled:!!on})}).then(function(){
    toast(on?'Goal Loop 已启用':'Goal Loop 已暂停');return loadAutomationSettings();
  }).catch(function(e){toast(e.message)}).finally(function(){setBusy(false)});
}
function previewRoute(){
  api('/api/console/executor-route-preview'+repoQuery(),{method:'POST',body:JSON.stringify({task_intent:'code_implementation'})}).then(function(res){
    toast(res.explanation||res.whyThisProvider||'路由预览完成');
    advancedRaw=res;
  }).catch(function(e){toast(e.message)});
}
function resetProviders(){
  if(!confirm('恢复提供方默认配置？（不会删除环境变量）'))return;
  setBusy(true,'恢复默认');
  api('/api/console/providers/reset'+repoQuery(),{method:'POST',body:'{}'}).then(function(){
    toast('已恢复默认');return loadAutomationSettings();
  }).catch(function(e){toast(e.message)}).finally(function(){setBusy(false)});
}
function resetRouting(){
  if(!confirm('移除显式路由并恢复按提供方优先级、能力与健康状态自动选择？'))return;
  setBusy(true,'恢复自动路由');
  api('/api/console/executor-routing/reset'+repoQuery(),{method:'POST',body:'{}'}).then(function(){
    toast('已恢复自动路由');return loadAutomationSettings();
  }).catch(function(e){toast(e.message)}).finally(function(){setBusy(false)});
}

function bindNav(root){
  if(!root)return;
  root.querySelectorAll('[data-nav]').forEach(function(el){
    el.addEventListener('click',function(){switchView(el.getAttribute('data-nav'))});
  });
  bindActions(root);
}

function bindActions(root){
  if(!root)return;
  root.querySelectorAll('[data-work-act]').forEach(function(el){
    el.addEventListener('click',function(ev){ev.stopPropagation();workAction(el.getAttribute('data-work-act'),el.getAttribute('data-work-id'))});
  });
  root.querySelectorAll('[data-open-work]').forEach(function(el){
    el.addEventListener('click',function(ev){ev.stopPropagation();openWork(el.getAttribute('data-open-work'))});
  });
  root.querySelectorAll('[data-open-handoff]').forEach(function(el){
    el.addEventListener('click',function(ev){ev.stopPropagation();openHandoff(el.getAttribute('data-open-handoff'))});
  });
  root.querySelectorAll('[data-handoff-act]').forEach(function(el){
    el.addEventListener('click',function(ev){ev.stopPropagation();handoffAction(el.getAttribute('data-handoff-act'),el.getAttribute('data-handoff-id'))});
  });
  root.querySelectorAll('[data-select-repo]').forEach(function(el){
    el.addEventListener('click',function(ev){ev.stopPropagation();selectRepo(el.getAttribute('data-select-repo'))});
  });
  root.querySelectorAll('[data-remove-repo]').forEach(function(el){
    el.addEventListener('click',function(ev){
      ev.stopPropagation();
      removeRepo(el.getAttribute('data-remove-repo'), el.getAttribute('data-remove-repo-name'));
    });
  });
  root.querySelectorAll('[data-open-plugin]').forEach(function(el){
    el.addEventListener('click',function(ev){ev.stopPropagation();openPlugin(el.getAttribute('data-open-plugin'))});
  });
  root.querySelectorAll('[data-plugin-act]').forEach(function(el){
    el.addEventListener('click',function(ev){
      ev.stopPropagation();
      runPluginAction(el.getAttribute('data-plugin-id'), el.getAttribute('data-action-id'));
    });
  });
  root.querySelectorAll('[data-copy]').forEach(function(el){
    el.addEventListener('click',function(ev){ev.stopPropagation();copyText(el.getAttribute('data-copy-text')||'')});
  });
}

function renderAll(){
  if(!commandCenter){
    document.getElementById('view-home').innerHTML='<div class="panel"><h2>正在读取控制台状态</h2><p class="muted">如果长时间无响应，请刷新或打开高级诊断。</p><button class="btn" onclick="refreshAll()">重新载入</button></div>';
    return;
  }
  try{
    renderChrome();
    renderHome();
    renderInbox();
    renderWork();
    renderCapabilities();
    renderAutomation();
    renderReadiness();
    renderRepositories();
    renderAdvanced();
  }catch(e){
    toast(e.message||String(e));
  }
}

function openWork(id){rememberWork(id);switchView('work');refreshWorkDetail(id)}
function openHandoff(id){selectedHandoffId=id;switchView('inbox');renderInbox()}
function openPlugin(id){
  rememberPlugin(id);
  switchView('capabilities');
  renderCapabilities();
  // Refresh detail from console API for latest health/actions.
  api('/api/console/plugins/'+encodeURIComponent(id)+repoQuery()).then(function(res){
    if(res&&res.plugin){
      commandCenter=commandCenter||{};
      var list=arr(commandCenter.plugins);
      var idx=list.findIndex(function(p){return p.id===id});
      if(idx>=0)list[idx]=res.plugin; else list.push(res.plugin);
      commandCenter.plugins=list;
      commandCenter.pluginSummary=obj(commandCenter.pluginSummary);
      renderCapabilities();
    }
  }).catch(function(){});
}
function refreshPlugins(){
  api('/api/console/plugins'+repoQuery()).then(function(res){
    commandCenter=commandCenter||{};
    commandCenter.plugins=arr(res.plugins);
    commandCenter.pluginSummary=obj(res.summary);
    renderChrome();
    renderCapabilities();
    toast('插件状态已刷新');
  }).catch(function(e){toast(e.message)});
}
function runPluginAction(pluginId, actionId){
  if(busy){toast('上一步仍在处理，请稍候');return}
  var plugin=pluginById(pluginId)||{};
  var action=arr(plugin.actions).find(function(a){return a.id===actionId})||{id:actionId,title:actionId};
  var confirmAuth=false;
  var confirmationText=undefined;
  if(action.requiredConfirmationText||action.confirmation==='strong_confirmation'){
    var required=action.requiredConfirmationText||('CONFIRM '+actionId);
    var typed=prompt('该动作不可逆，请输入强确认文本：'+required,'');
    if(typed==null)return;
    if(typed!==required){toast('确认文本不匹配');return}
    confirmationText=typed;
    confirmAuth=true;
  }
  var requestId='gui-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);
  setBusy(true,'运行插件动作…');
  api('/api/plugins/'+encodeURIComponent(pluginId)+'/actions/'+encodeURIComponent(actionId)+repoQuery(),{
    method:'POST',
    body:JSON.stringify({
      requestId:requestId,
      arguments:{},
      confirmAuthorization:confirmAuth,
      confirmationText:confirmationText
    })
  }).then(function(res){
    pluginActionResult={
      at:new Date().toISOString(),
      pluginId:pluginId,
      actionId:actionId,
      accepted:res.accepted,
      deduplicated:res.deduplicated,
      job:res.job,
      action:res.action
    };
    setLastOp({phase:'succeeded',statusLabel:'动作已提交',summary:'插件动作 '+(action.title||actionId)+' 已提交'},'插件动作已提交');
    toast(res.deduplicated?'动作已去重复用':'插件动作已提交');
    return refreshAll({silent:true}).then(function(){renderCapabilities()});
  }).catch(function(e){
    pluginActionResult={at:new Date().toISOString(),pluginId:pluginId,actionId:actionId,error:e.message,payload:e.payload||null};
    setLastOp(e.payload||{phase:'failed',summary:e.message},e.message);
    toast(e.message);
    renderCapabilities();
  }).finally(function(){setBusy(false)});
}
function copyText(text){if(!text){toast('没有可复制内容');return}navigator.clipboard.writeText(text).then(function(){toast('已复制')}).catch(function(){toast('复制失败')})}
function toggleAddRepo(){var el=document.getElementById('repoAdd');if(el)el.style.display=el.style.display==='none'?'block':'none'}

function taskPayload(){
  var objective=(document.getElementById('taskObjective')||{}).value||'';
  var acceptance=((document.getElementById('taskAcceptance')||{}).value||'').split(/[;；\\n]/).map(function(s){return s.trim()}).filter(Boolean);
  var paths=((document.getElementById('taskPaths')||{}).value||'').split(',').map(function(s){return s.trim()}).filter(Boolean);
  var files=Number((document.getElementById('taskFiles')||{}).value||0)||undefined;
  return {
    objective:objective.trim(),
    acceptanceCriteria:acceptance,
    allowedPaths:paths,
    expectedFiles:files,
    scopeClear:true
  };
}

function previewMode(){
  if(busy){toast('上一步仍在处理，请稍候');return}
  var body=taskPayload();
  if(!body.objective){toast('请先输入任务目标');return}
  setBusy(true,'预览模式…');
  api('/api/console/mode-preview'+repoQuery(),{method:'POST',body:JSON.stringify(body)}).then(function(res){
    modePreview=res.modePreview||res;
    setLastOp({phase:'succeeded',statusLabel:'模式已预览',summary:'建议：'+(modePreview.label||'直接执行')+'。'+(modePreview.explanation||'')},'模式已预览');
    renderHome();
    toast('建议模式：'+(modePreview.label||''));
  }).catch(function(e){setLastOp(e.payload||{phase:'failed',summary:e.message},e.message);toast(e.message||'预览失败')}).finally(function(){setBusy(false)});
}

function startTask(){
  if(busy){toast('上一步仍在处理，请勿重复提交');return}
  var body=taskPayload();
  if(!body.objective){toast('请先输入任务目标');return}
  setBusy(true,'正在提交任务…');
  api('/api/console/work/start'+repoQuery(),{method:'POST',body:JSON.stringify(body)}).then(function(res){
    setLastOp(res,'任务已提交');
    var data=obj(res.data);
    if(data.work&&data.work.workId){rememberWork(data.work.workId)}
    else if(data.work&&data.work.id){rememberWork(data.work.id)}
    else if(data.workId){rememberWork(data.workId)}
    toast(res.summary||(res.status==='blocked'?'已创建待决定事项':'任务已提交'));
    return refreshAll();
  }).then(function(){
    if(arr(obj(commandCenter).handoffs).length&&!selectedWorkId)switchView('inbox');
    else if(selectedWorkId)switchView('work');
    else switchView('home');
  }).catch(function(e){
    setLastOp(e.payload||{phase:'failed',summary:e.message||'启动失败'},e.message||'启动失败');
    toast(e.message||'启动失败');
  }).finally(function(){setBusy(false)});
}

function diagnoseFirst(){
  if(busy){toast('上一步仍在处理，请稍候');return}
  setBusy(true,'正在诊断…');
  api('/api/console/repair'+repoQuery(),{method:'POST',body:JSON.stringify({operation:'diagnose',dryRun:true})}).then(function(res){
    setLastOp(res,'诊断完成');toast(res.summary||'诊断完成');switchView('readiness');
  }).catch(function(e){setLastOp(e.payload||{phase:'failed',summary:e.message},e.message);toast(e.message)}).finally(function(){setBusy(false)});
}
function repairDryRun(){
  if(busy){toast('上一步仍在处理，请稍候');return}
  setBusy(true,'正在预览修复…');
  api('/api/console/repair'+repoQuery(),{method:'POST',body:JSON.stringify({operation:'repair',dryRun:true})}).then(function(res){
    setLastOp(res,'已生成修复预览');advancedRaw=res;toast(res.summary||'已生成修复预览');switchView('advanced');
  }).catch(function(e){setLastOp(e.payload||{phase:'failed',summary:e.message},e.message);toast(e.message)}).finally(function(){setBusy(false)});
}

function workAction(kind,workId){
  if(busy){toast('上一步仍在处理，请稍候');return}
  rememberWork(workId);
  if(kind==='continue')return postWork('/api/console/work/continue',{workId:workId},'继续任务');
  if(kind==='verify')return postWork('/api/console/work/verify',{workId:workId},'运行验证');
  if(kind==='finalize')return postWork('/api/console/work/finalize',{workId:workId},'收尾任务');
  if(kind==='stop')return postWork('/api/console/work/stop',{workId:workId,reason:'stopped from console'},'停止任务');
  if(kind==='repair'){
    setBusy(true,'正在诊断…');
    return api('/api/console/repair'+repoQuery(),{method:'POST',body:JSON.stringify({operation:'diagnose',dryRun:true,workId:workId})}).then(function(res){setLastOp(res,'诊断完成');toast(res.summary||'诊断完成')}).catch(function(e){setLastOp(e.payload||{phase:'failed',summary:e.message},e.message);toast(e.message)}).finally(function(){setBusy(false)});
  }
  if(kind==='delegate-codex')return postWork('/api/console/work/delegate',{workId:workId,target:'codex',available:true},'委派 Codex');
  if(kind==='delegate-grok')return postWork('/api/console/work/delegate',{workId:workId,target:'grok'},'准备 Grok 审阅包');
}
function postWork(path,body,label){
  setBusy(true,label||'处理中…');
  return api(path+repoQuery(),{method:'POST',body:JSON.stringify(body)}).then(function(res){
    setLastOp(res,label||'已更新');
    // Clarify handoff-only / request-packet outcomes for small-brain delegation.
    if(res&&res.data&&res.data.directExecutionAvailable===false){
      toast((res.summary||'已准备外部审阅请求')+'（非自动执行）');
    } else {
      toast(res.summary||'已更新');
    }
    return refreshAll();
  }).catch(function(e){setLastOp(e.payload||{phase:'failed',summary:e.message},e.message);toast(e.message)}).finally(function(){setBusy(false)});
}
function refreshWorkDetail(id){
  api('/api/console/work/'+encodeURIComponent(id)+repoQuery()).then(function(res){
    if(res.work){
      // merge into command center recent
      commandCenter=commandCenter||{};
      commandCenter.currentWork=res.work;
      renderWork();
    }
  }).catch(function(){});
}

function handoffAction(kind,id){
  if(busy){toast('上一步仍在处理，请稍候');return}
  var item=arr(obj(commandCenter).handoffs).find(function(h){return h.id===id})||{};
  var d=obj(item.decision);var body={};
  if(kind==='approve'){
    var approvalText='确认'+(d.primaryActionLabel||'批准并创建任务')+'？\\n\\n批准对象：'+(d.requestedAction||item.title||'当前操作')+'\\n影响：'+(d.impact||'按当前任务范围执行')+'\\n后续：'+(d.afterApproval||'打开任务详情');
    if(!confirm(approvalText))return;
  }
  if(kind==='resolve'){
    var decision=prompt('记录你的决定。注意：此操作只保存决定并移出待处理，不会自动继续任务。',item.recommendedDecision||'');
    if(decision==null)return;
    if(!String(decision).trim()){toast('请填写决定内容');return}
    body={decision:decision,resolver:'user'};
  }
  if(kind==='dismiss'){
    if(!confirm('确认暂不处理此事项？它会从待处理列表移除，相关操作不会执行。'))return;
    body={decision:'dismissed',resolver:'user'};
  }
  setBusy(true,kind==='approve'?'正在批准并创建任务…':kind==='resolve'?'仅记录决定…':kind==='dismiss'?'暂不处理…':'更新中…');
  api('/api/console/inbox/'+encodeURIComponent(id)+'/'+kind+repoQuery(),{method:'POST',body:JSON.stringify(body)}).then(function(res){
    if(kind==='approve'){
      setLastOp(res,'已批准并创建任务');
      var data=obj(obj(res.actionResult).data);var work=obj(data.work);
      if(work.workId)rememberWork(work.workId);else if(work.id)rememberWork(work.id);
      toast(res.summary||'已批准并创建任务');
    } else {
      setLastOp({phase:'succeeded',statusLabel:kind==='resolve'?'已记录决定':kind==='dismiss'?'已暂不处理':'已确认',summary:kind==='resolve'?'决定已保存；未触发任何后续执行':kind==='dismiss'?'事项已移出列表，相关操作未执行':'已确认已知晓'}, '已更新');
      toast(kind==='resolve'?'已记录决定（未自动继续）':kind==='dismiss'?'已暂不处理':'已确认');
    }
    selectedHandoffId='';
    return refreshAll().then(function(){if(kind==='approve'&&selectedWorkId)switchView('work')});
  }).catch(function(e){setLastOp(e.payload||{phase:'failed',summary:e.message||'更新失败'},e.message||'更新失败');toast(e.message||'更新失败')}).finally(function(){setBusy(false)});
}

function selectRepo(id){
  rememberRepo(id);
  toast('已切换仓库');
  refreshAll().then(function(){switchView('home')});
}
function registerRepo(){
  var path=(document.getElementById('repoPath')||{}).value||'';
  var name=(document.getElementById('repoName')||{}).value||'';
  if(!path.trim()){toast('请输入仓库路径');return}
  api('/api/repositories/register',{method:'POST',body:JSON.stringify({path:path.trim(),displayName:name.trim()||undefined})}).then(function(res){
    var repo=obj(res.repository);if(repo.repoId)rememberRepo(repo.repoId);
    toast('仓库已注册');return refreshAll();
  }).catch(function(e){toast(e.message)});
}
function removeRepo(id, name){
  if(!id)return;
  var label=name||id;
  if(!confirm('从控制台删除「'+label+'」的注册？\\n不会删除磁盘上的仓库文件，仅从 Controller 注册表中移除（可重新注册）。'))return;
  if(busy)return;
  setBusy(true,'删除注册中');
  api('/api/repositories/'+encodeURIComponent(id)+'/remove',{method:'POST',body:JSON.stringify({})}).then(function(res){
    if(selectedRepoId===id){
      var remaining=arr(res.repositories);
      var next=remaining.find(function(r){return r.id&&r.id!==id})||remaining[0];
      rememberRepo(next&&next.id?next.id:'');
    }
    toast(res.summary||'已删除仓库注册');
    return refreshAll();
  }).catch(function(e){
    var msg=e.message||'删除失败';
    if(String(msg).indexOf('REPOSITORY_SELF_PROTECTED')===0||(e.payload&&e.payload.errorMessage)){
      msg=(e.payload&&e.payload.errorMessage)||'不能删除当前进程所在仓库的注册（自我保护）';
    }
    toast(msg);
  }).finally(function(){setBusy(false)});
}
function loadAdvanced(){
  api('/api/console/advanced'+repoQuery()).then(function(res){advancedRaw=res;renderAdvanced();toast('原始快照已刷新')}).catch(function(e){toast(e.message)});
}

function refreshAll(opts){
  opts=opts||{};
  if(refreshInFlight)return Promise.resolve();
  refreshInFlight=true;
  return api('/api/console/command-center'+repoQuery()).then(function(res){
    commandCenter=res;
    lastRefreshedAt=new Date().toLocaleTimeString();
    var repo=obj(res.currentRepository);
    if(repo.id)rememberRepo(repo.id);
    if(!selectedWorkId&&res.currentWork&&res.currentWork.id)rememberWork(res.currentWork.id);
    // Merge extras into current work for card display after silent polls.
    if(res.currentWork&&res.currentWork.id)res.currentWork=mergeWorkExtras(res.currentWork);
    var loadSettings=(!opts.silent||!automationSettings)
      ? api('/api/console/automation-settings'+repoQuery()).then(function(s){automationSettings=s}).catch(function(){/* optional */})
      : Promise.resolve();
    return loadSettings.then(function(){
      if(!opts.silent)renderAll();
      else {
        renderChrome();
        renderOpBar();
        try{renderHome();renderWork();renderInbox()}catch(_e){renderAll()}
      }
      ensurePoll();
    });
  }).catch(function(e){
    if(opts.silent){
      lastOperation={phase:'failed',statusLabel:'重连中',summary:e.message||'控制台暂时不可用，正在重试…',at:new Date().toISOString()};
      renderOpBar();
      return;
    }
    commandCenter={
      readiness:{state:'blocked',label:'读取失败',headline:'控制台不可用',description:e.message||'本地 API 暂时不可用',connectorLabel:'未知',connectorTone:'red',pendingHandoffCount:0,sections:[]},
      handoffs:[],recentWork:[],repositories:[],warnings:[e.message||'读取失败'],modePreviewDefault:{label:'—',explanation:''},
      setupGuide:{needed:true,title:'控制台暂不可用',body:e.message||'请确认 controller 已启动。',actionLabel:'重试'}
    };
    setLastOp({phase:'failed',statusLabel:'读取失败',summary:e.message||'本地 API 暂时不可用',error:{title:'控制器暂不可用',explanation:e.message||'本地 API 暂时不可用',nextActions:['刷新页面','重启 controller']}},e.message);
    renderAll();
    toast(e.message||'读取失败');
  }).finally(function(){refreshInFlight=false});
}

window.onerror=function(message){toast(String(message));return false};
refreshAll();
</script>
</body>
</html>`;
}

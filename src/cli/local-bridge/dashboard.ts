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
.main{padding:18px;overflow:auto}
.view{display:none}.view.active{display:block}
.page-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:16px}.page-head h1{margin:0 0 4px;font-size:24px}.page-head p{margin:0;color:var(--muted)}
.grid{display:grid;gap:14px}.grid.two{grid-template-columns:1.4fr .9fr}.grid.cards{grid-template-columns:repeat(3,1fr)}
.panel{background:rgba(15,22,32,.92);border:1px solid var(--line);border-radius:var(--radius);padding:16px;box-shadow:0 18px 40px rgba(0,0,0,.22)}
.panel h2,.panel h3{margin:0 0 8px}.muted{color:var(--muted)}.faint{color:var(--faint)}
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
.opbar{margin-bottom:12px;padding:10px 12px;border-radius:12px;border:1px solid var(--line);background:rgba(255,255,255,.03);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.opbar.running{border-color:rgba(96,165,250,.35);background:rgba(96,165,250,.08)}
.opbar.ok{border-color:rgba(52,211,153,.35);background:rgba(52,211,153,.08)}
.opbar.err{border-color:rgba(248,113,113,.35);background:rgba(248,113,113,.08)}
.btn:disabled{opacity:.55;cursor:not-allowed}
.busy-banner{font-size:12px;color:var(--muted)}
@media(max-width:980px){.body{grid-template-columns:1fr}.side{display:none}.grid.two,.grid.cards{grid-template-columns:1fr}.top{flex-wrap:wrap;height:auto;padding:10px 12px}}
</style>
</head>
<body>
<div class="app">
  <header class="top">
    <div class="brand"><span class="logo">∞</span><span>执行助手控制台</span></div>
    <button class="chip" id="repoChip" onclick="switchView('repositories')">仓库 · <strong id="topRepo">—</strong></button>
    <span class="chip"><span class="dot" id="readyDot"></span><strong id="topReady">检查中</strong></span>
    <span class="chip"><span class="dot" id="connectorDot"></span><span id="topConnector">连接</span></span>
    <button class="chip" onclick="switchView('inbox')">待决定 <span class="count" id="topHandoffs">0</span></button>
    <div class="top-actions">
      <button class="btn ghost" onclick="refreshAll()">刷新</button>
      <button class="btn ghost" onclick="switchView('advanced')">高级</button>
    </div>
  </header>
  <div class="body">
    <aside class="side">
      <nav class="nav">
        <button class="active" data-view="home">⌂ 指挥中心</button>
        <button data-view="inbox">△ 待决定 <span class="count" id="sideHandoffs">0</span></button>
        <button data-view="work">▷ 当前任务</button>
        <button data-view="readiness">◎ 系统状态</button>
        <button data-view="repositories">□ 仓库</button>
        <button data-view="advanced">⌁ 高级诊断</button>
      </nav>
    </aside>
    <main class="main">
      <section class="view active" id="view-home"></section>
      <section class="view" id="view-inbox"></section>
      <section class="view" id="view-work"></section>
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
var selectedWorkId=safeGet('repoHarnessSelectedWorkId')||'';
var selectedHandoffId='';
var modePreview=null;
var advancedRaw=null;
var lastFacade=null;
var lastOperation=null; // {phase,statusLabel,summary,errorMessage,at}
var busy=false;
var pollTimer=null;

function repoQuery(){return selectedRepoId?'?repoId='+encodeURIComponent(selectedRepoId):''}
function rememberRepo(id){selectedRepoId=id||'';safeSet('repoHarnessSelectedRepoId',selectedRepoId);setQueryRepoId(selectedRepoId)}
function rememberWork(id){selectedWorkId=id||'';safeSet('repoHarnessSelectedWorkId',selectedWorkId)}
function api(path,opts){opts=opts||{};var headers=Object.assign({'content-type':'application/json'},opts.headers||{});return fetch(path,Object.assign({},opts,{credentials:'same-origin',headers:headers})).then(function(r){return r.json().catch(function(){return{}}).then(function(body){if(!r.ok){var msg=body.summary||body.errorMessage||body.error||body.message||('请求失败 '+r.status);var err=new Error(msg);err.payload=body;err.status=r.status;throw err}return body})})}
function setBusy(on,label){busy=!!on;document.querySelectorAll('.btn.primary, .btn.danger').forEach(function(b){if(on)b.setAttribute('disabled','disabled');else b.removeAttribute('disabled')});if(on){lastOperation={phase:'running',statusLabel:label||'执行中',summary:label||'正在处理…',at:new Date().toISOString()};renderOpBar()}}
function setLastOp(res,fallback){var phase=res&&res.phase||(res&&res.status==='ok'?'succeeded':res&&(res.status==='failed'||res.status==='blocked')?'failed':'succeeded');lastOperation={phase:phase,statusLabel:(res&&(res.statusLabel||res.digest&&res.digest.statusLabel))||fallback||'已更新',summary:(res&&(res.summary||res.digest&&res.digest.summary))||fallback||'操作已完成',errorMessage:res&&(res.errorMessage||res.errorClass||(res.digest&&res.digest.errorMessage))||'',next:res&&(res.next||(res.suggestedNextActions&&res.suggestedNextActions[0]&&res.suggestedNextActions[0].label))||'',at:new Date().toISOString()};lastFacade=res;renderOpBar()}
function renderOpBar(){var nodes=document.querySelectorAll('#opBar');if(!nodes.length)return;var html='';if(lastOperation){var cls=lastOperation.phase==='running'||lastOperation.phase==='queued'||lastOperation.phase==='waiting'?'running':(lastOperation.phase==='failed'||lastOperation.phase==='timed_out'||lastOperation.phase==='blocked')?'err':'ok';html='<div class="opbar '+cls+'"><span class="pill '+(cls==='ok'?'green':cls==='err'?'red':'blue')+'">'+esc(lastOperation.statusLabel)+'</span><span>'+esc(lastOperation.summary)+'</span>'+(lastOperation.errorMessage?'<span class="muted">'+esc(lastOperation.errorMessage)+'</span>':'')+(lastOperation.next?'<span class="muted">下一步：'+esc(lastOperation.next)+'</span>':'')+(busy?'<span class="busy-banner">请稍候…</span>':'')+'</div>'}nodes.forEach(function(n){n.innerHTML=html})}
function ensurePoll(){if(pollTimer)return;pollTimer=setInterval(function(){var work=obj(commandCenter&&commandCenter.currentWork);if(!work||!work.id)return;if(work.tone==='blue'||work.statusLabel==='进行中'||work.statusLabel==='待开始'){refreshAll({silent:true})}},4000)}

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
  document.getElementById('topRepo').textContent=repo.name||'未选择';
  document.getElementById('topReady').textContent=ready.label||'未知';
  setDot('readyDot', ready.state==='blocked'?'red':ready.state==='needs_setup'?'amber':'green');
  document.getElementById('topConnector').textContent=ready.connectorLabel||'连接';
  setDot('connectorDot', ready.connectorTone||'gray');
  var n=ready.pendingHandoffCount||arr(cc.handoffs).length||0;
  document.getElementById('topHandoffs').textContent=n;
  document.getElementById('sideHandoffs').textContent=n;
}

function renderHome(){
  var cc=obj(commandCenter), ready=obj(cc.readiness), work=obj(cc.currentWork), handoffs=arr(cc.handoffs).slice(0,3);
  var warnings=arr(cc.warnings).map(function(w){return '<div class="warn">'+esc(w)+'</div>'}).join('');
  var mode=obj(modePreview||cc.modePreviewDefault);
  var el=document.getElementById('view-home');
  el.innerHTML=
    '<div id="opBar"></div>'+
    warnings+
    '<div class="page-head"><div><h1>指挥中心</h1><p>输入目标，系统会建议直接执行、可恢复的后台任务，或需要你先决定。</p></div></div>'+
    '<div class="grid two">'+
      '<div class="panel composer">'+
        '<h2>你想完成什么？</h2>'+
        '<textarea id="taskObjective" placeholder="例如：优化会员购买页信息密度，保持现有业务逻辑不变。"></textarea>'+
        '<div class="row"><input class="input" id="taskAcceptance" placeholder="验收标准（可选，用分号分隔）" style="flex:1"></div>'+
        '<div class="row"><input class="input" id="taskPaths" placeholder="允许修改的路径（可选，逗号分隔）" style="flex:1"><input class="input" id="taskFiles" type="number" min="0" placeholder="预计改动文件数" style="width:150px"></div>'+
        '<div class="row">'+
          '<button class="btn primary" onclick="startTask()">开始</button>'+
          '<button class="btn" onclick="previewMode()">预览模式</button>'+
          '<button class="btn" onclick="diagnoseFirst()">先诊断</button>'+
        '</div>'+
        '<div class="mode-card" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)">'+
          '<div class="muted">建议模式</div>'+
          '<div class="label">'+esc(mode.label||'直接执行')+'</div>'+
          '<div class="muted">'+esc(mode.explanation||'')+'</div>'+
        '</div>'+
      '</div>'+
      '<div class="panel">'+
        '<div class="section-title"><h2>系统状态</h2>'+pill(ready.state==='ready'?'green':ready.state==='needs_setup'?'amber':'red', ready.label||'未知')+'</div>'+
        '<p class="muted">'+esc(ready.headline||'')+'</p>'+
        '<p class="faint">'+esc(ready.description||'')+'</p>'+
        '<div class="actions">'+btn('查看详情','data-nav="readiness"')+btn('处理待决定','data-nav="inbox"')+'</div>'+
      '</div>'+
    '</div>'+
    '<div class="grid two" style="margin-top:14px">'+
      renderWorkCard(work, '当前任务')+
      '<div class="panel"><div class="section-title"><h2>待决定</h2>'+btn('全部','data-nav="inbox"','ghost')+'</div>'+
        (handoffs.length?handoffs.map(function(h){return handoffMini(h)}).join(''):'<div class="empty">没有需要你判断的事项</div>')+
      '</div>'+
    '</div>';
  bindNav(el);
  renderOpBar();
}

function renderWorkCard(work, title){
  work=obj(work);
  if(!work.id){
    return '<div class="panel"><div class="section-title"><h2>'+esc(title||'当前任务')+'</h2></div><div class="empty">还没有任务。在左侧描述目标并点击“开始”。</div></div>';
  }
  var v=obj(work.latestVerification);
  var id=esc(work.id);
  return '<div class="panel work-card" data-work-id="'+id+'">'+
    '<div class="section-title"><h2>'+esc(title||'当前任务')+'</h2>'+pill(work.tone, work.statusLabel)+'</div>'+
    '<h3 style="margin:0 0 6px">'+esc(work.title)+'</h3>'+
    '<div class="muted">模式：'+esc(work.modeLabel)+' · 下一步：'+esc(work.nextAction)+'</div>'+
    stepsHtml(work.progressSteps)+
    (v.summary?'<div style="margin-top:8px">'+pill(v.tone,v.label)+' <span class="muted">'+esc(v.summary)+'</span></div>':'')+
    (work.delegateSummary?'<p class="muted" style="margin-top:8px">'+esc(work.delegateSummary)+'</p>':'')+
    evidenceHtml(work.evidenceLabels)+
    '<div class="actions">'+
      btn('继续','data-work-act="continue" data-work-id="'+id+'"','primary')+
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
  return '<div class="card-row" style="margin-bottom:8px">'+
    '<div><h3>'+esc(h.title)+'</h3><p>'+esc(h.reason)+'</p><div class="muted">建议：'+esc(h.recommendedDecision)+'</div></div>'+
    '<div class="actions" style="flex-direction:column">'+
      btn('打开','data-open-handoff="'+id+'"','primary')+
      btn('解决','data-handoff-act="resolve" data-handoff-id="'+id+'"')+
    '</div></div>';
}

function renderInbox(){
  var items=arr(obj(commandCenter).handoffs);
  var detail=selectedHandoffId?items.find(function(x){return x.id===selectedHandoffId}):null;
  var root=document.getElementById('view-inbox');
  root.innerHTML=
    '<div class="page-head"><div><h1>待决定</h1><p>只显示需要你判断的事项，不是日志列表。</p></div><button class="btn" onclick="refreshAll()">刷新</button></div>'+
    '<div class="grid two">'+
      '<div class="list">'+(items.length?items.map(function(h){
        var id=esc(h.id);
        return '<div class="panel" style="padding:14px;cursor:pointer;border-color:'+(selectedHandoffId===h.id?'rgba(96,165,250,.45)':'')+'" data-open-handoff="'+id+'">'+
          '<div class="section-title"><h3 style="margin:0">'+esc(h.title)+'</h3>'+pill(h.tone,h.severityLabel)+'</div>'+
          '<p class="muted">'+esc(h.reason)+'</p></div>';
      }).join(''):'<div class="empty">没有待处理决策</div>')+'</div>'+
      '<div class="panel" id="handoffDetail">'+(detail?renderHandoffDetail(detail):'<div class="empty">选择左侧事项查看详情</div>')+'</div>'+
    '</div>';
  bindActions(root);
}

function renderHandoffDetail(h){
  var id=esc(h.id);
  return '<div class="section-title"><h2>'+esc(h.title)+'</h2>'+pill(h.tone,h.statusLabel)+'</div>'+
    '<p><strong>原因</strong><br><span class="muted">'+esc(h.reason)+'</span></p>'+
    '<p><strong>当前状态</strong><br><span class="muted">'+esc(h.workTitle||'—')+'</span></p>'+
    '<p><strong>建议决定</strong><br><span class="muted">'+esc(h.recommendedDecision)+'</span></p>'+
    '<p><strong>继续提示</strong><br><span class="muted mono" style="white-space:pre-wrap">'+esc(h.continuationPrompt||'')+'</span></p>'+
    (arr(h.attemptedActions).length?'<p><strong>已尝试</strong><br><span class="muted">'+esc(h.attemptedActions.join(' · '))+'</span></p>':'')+
    evidenceHtml(h.evidenceLabels)+
    '<div class="actions">'+
      btn('确认已知晓','data-handoff-act="ack" data-handoff-id="'+id+'"')+
      btn('解决并记录','data-handoff-act="resolve" data-handoff-id="'+id+'"','primary')+
      btn('忽略','data-handoff-act="dismiss" data-handoff-id="'+id+'"')+
      btn('复制继续提示','data-copy="1" data-copy-text="'+esc(h.continuationPrompt||'')+'"')+
      (h.advanced&&h.advanced.workId?btn('继续任务','data-open-work="'+esc(h.advanced.workId)+'"'):'')+
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
    '<div class="page-head"><div><h1>仓库</h1><p>选择或注册本地仓库，不需要理解注册表内部字段。</p></div>'+
      '<button class="btn primary" onclick="toggleAddRepo()">添加本地仓库</button></div>'+
    '<div class="panel" id="repoAdd" style="display:none;margin-bottom:14px">'+
      '<div class="row" style="display:grid;grid-template-columns:1.4fr .8fr auto;gap:10px">'+
        '<input class="input" id="repoPath" placeholder="/Users/you/DevProjects/YourRepo">'+
        '<input class="input" id="repoName" placeholder="显示名称（可选）">'+
        '<button class="btn primary" onclick="registerRepo()">注册</button>'+
      '</div></div>'+
    '<div class="list">'+repos.map(function(r){
      return '<div class="panel card-row"><div><h3>'+esc(r.name)+'</h3><div class="muted mono">'+esc(r.path)+'</div></div>'+
        '<div class="actions">'+btn(r.current?'当前仓库':'设为当前','data-select-repo="'+esc(r.id)+'"',r.current?'primary':'')+'</div>'+
        advancedBlock(r.advanced)+
      '</div>';
    }).join('')+'</div>';
  bindActions(root);
}

function renderAdvanced(){
  var root=document.getElementById('view-advanced');
  root.innerHTML=
    '<div class="page-head"><div><h1>高级诊断</h1><p>开发/排错视图。默认任务流请回到指挥中心。</p></div>'+
      '<div class="actions"><button class="btn" onclick="loadAdvanced()">读取原始快照</button>'+btn('返回指挥中心','data-nav="home"')+'</div></div>'+
    '<div class="panel"><pre class="mono" style="white-space:pre-wrap;font-size:12px;color:var(--muted)">'+esc(JSON.stringify(advancedRaw||lastFacade||{note:'点击“读取原始快照”'},null,2))+'</pre></div>';
  bindNav(root);
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
    renderReadiness();
    renderRepositories();
    renderAdvanced();
  }catch(e){
    toast(e.message||String(e));
  }
}

function openWork(id){rememberWork(id);switchView('work');refreshWorkDetail(id)}
function openHandoff(id){selectedHandoffId=id;switchView('inbox');renderInbox()}
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
  var body=taskPayload();
  if(!body.objective){toast('请先输入任务目标');return}
  api('/api/console/mode-preview'+repoQuery(),{method:'POST',body:JSON.stringify(body)}).then(function(res){
    modePreview=res.modePreview||res;
    renderHome();
    toast('已更新建议模式：'+(modePreview.label||''));
  }).catch(function(e){toast(e.message)});
}

function startTask(){
  if(busy){toast('上一步仍在处理，请稍候');return}
  var body=taskPayload();
  if(!body.objective){toast('请先输入任务目标');return}
  setBusy(true,'正在启动任务…');
  api('/api/console/work/start'+repoQuery(),{method:'POST',body:JSON.stringify(body)}).then(function(res){
    setLastOp(res,'任务已提交');
    var data=obj(res.data);
    if(data.work&&data.work.workId){rememberWork(data.work.workId)}
    else if(data.work&&data.work.id){rememberWork(data.work.id)}
    toast(res.summary||'任务已提交');
    return refreshAll();
  }).then(function(){if(selectedWorkId)switchView('work')}).catch(function(e){setLastOp(e.payload||{phase:'failed',summary:e.message},e.message);toast(e.message)}).finally(function(){setBusy(false)});
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
  var body={};
  if(kind==='resolve'){
    var decision=prompt('记录你的决定','继续执行');
    if(decision==null)return;
    body={decision:decision,resolver:'user'};
  }
  if(kind==='dismiss'){
    body={decision:'dismissed',resolver:'user'};
  }
  setBusy(true,'更新待决定事项…');
  api('/api/console/inbox/'+encodeURIComponent(id)+'/'+kind+repoQuery(),{method:'POST',body:JSON.stringify(body)}).then(function(res){
    setLastOp({phase:'succeeded',statusLabel:kind==='resolve'?'已解决':kind==='dismiss'?'已忽略':'已确认',summary:kind==='resolve'?'已记录你的决定':kind==='dismiss'?'已忽略该事项':'已确认已知晓'}, '已更新');
    toast(kind==='resolve'?'已解决':kind==='dismiss'?'已忽略':'已确认');
    selectedHandoffId='';
    return refreshAll();
  }).catch(function(e){setLastOp(e.payload||{phase:'failed',summary:e.message},e.message);toast(e.message)}).finally(function(){setBusy(false)});
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
function loadAdvanced(){
  api('/api/console/advanced'+repoQuery()).then(function(res){advancedRaw=res;renderAdvanced();toast('原始快照已刷新')}).catch(function(e){toast(e.message)});
}

function refreshAll(opts){
  opts=opts||{};
  return api('/api/console/command-center'+repoQuery()).then(function(res){
    commandCenter=res;
    var repo=obj(res.currentRepository);
    if(repo.id)rememberRepo(repo.id);
    if(!selectedWorkId&&res.currentWork&&res.currentWork.id)rememberWork(res.currentWork.id);
    if(!opts.silent)renderAll();
    else {renderChrome();renderOpBar()}
    ensurePoll();
  }).catch(function(e){
    if(opts.silent)return;
    commandCenter={
      readiness:{state:'blocked',label:'读取失败',headline:'控制台不可用',description:e.message||'本地 API 暂时不可用',connectorLabel:'未知',connectorTone:'red',pendingHandoffCount:0,sections:[]},
      handoffs:[],recentWork:[],repositories:[],warnings:[e.message||'读取失败'],modePreviewDefault:{label:'—',explanation:''}
    };
    setLastOp({phase:'failed',statusLabel:'读取失败',summary:e.message||'本地 API 暂时不可用',errorMessage:e.message},e.message);
    renderAll();
    toast(e.message||'读取失败');
  });
}

window.onerror=function(message){toast(String(message));return false};
refreshAll();
</script>
</body>
</html>`;
}

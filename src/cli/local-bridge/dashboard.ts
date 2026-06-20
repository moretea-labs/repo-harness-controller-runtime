function escapeJsonForScript(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function localBridgeDashboardHtml(token: string): string {
  const encodedToken = escapeJsonForScript(token);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>repo-harness Controller</title>
  <style>
    :root{color-scheme:light dark;--bg:#f4f5f7;--panel:#fff;--text:#16181d;--muted:#697180;--line:#e1e5ea;--accent:#2563eb;--danger:#c4322b;--ok:#11845b;--warn:#b76000;--soft:#eef2f7}
    @media(prefers-color-scheme:dark){:root{--bg:#0f1114;--panel:#181b20;--text:#f4f5f6;--muted:#9aa4b2;--line:#30353d;--accent:#7aa7ff;--danger:#ff817a;--ok:#5dd6a5;--warn:#ffc46b;--soft:#222730}}
    *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    header{position:sticky;top:0;z-index:10;display:flex;justify-content:space-between;gap:16px;align-items:center;padding:14px 22px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--panel) 94%,transparent);backdrop-filter:blur(14px)}
    h1,h2,h3,p{margin:0} h1{font-size:19px} h2{font-size:15px;margin-bottom:12px} h3{font-size:14px}.muted{color:var(--muted)}
    .shell{max-width:1540px;margin:auto;padding:18px;display:grid;gap:16px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;box-shadow:0 1px 2px rgba(0,0,0,.04)}.notice{display:none;border-radius:12px;padding:11px 13px;border:1px solid var(--line)}.notice.warn{display:block;border-color:color-mix(in srgb,var(--warn) 50%,var(--line));background:color-mix(in srgb,var(--warn) 8%,var(--panel))}.notice.ok{display:block;border-color:color-mix(in srgb,var(--ok) 45%,var(--line));background:color-mix(in srgb,var(--ok) 7%,var(--panel))}
    .summary{display:grid;grid-template-columns:repeat(5,minmax(140px,1fr));gap:10px}.metric{background:var(--soft);border:1px solid var(--line);border-radius:11px;padding:11px}.metric strong{display:block;font-size:20px;margin-top:4px}
    .top-grid{display:grid;grid-template-columns:minmax(400px,1.15fr) minmax(340px,.85fr);gap:16px}.bottom-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    .toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.row-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
    button,select,input,textarea{font:inherit}button{border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:9px;padding:7px 10px;cursor:pointer}button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.danger{color:var(--danger)}button:disabled{opacity:.45;cursor:not-allowed}
    input,select,textarea{width:100%;border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:9px;padding:9px 10px}textarea{min-height:82px;resize:vertical}label{display:grid;gap:5px;color:var(--muted);font-size:12px}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.span-2{grid-column:1/-1}
    .board{display:grid;grid-template-columns:repeat(5,minmax(240px,1fr));gap:12px;overflow:auto;padding-bottom:5px}.column{min-width:240px;background:color-mix(in srgb,var(--bg) 76%,var(--panel));border:1px solid var(--line);border-radius:12px;padding:10px}.column-title{display:flex;justify-content:space-between;color:var(--muted);font-weight:650;margin-bottom:8px}
    .card,.row{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px;display:grid;gap:8px}.card{margin-bottom:8px}.list{display:grid;gap:8px;max-height:520px;overflow:auto}
    .meta{display:flex;gap:6px;flex-wrap:wrap}.badge{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:999px;padding:2px 7px;font-size:11px;color:var(--muted)}.badge.ok{color:var(--ok)}.badge.warn{color:var(--warn)}.badge.danger{color:var(--danger)}
    .progress{height:7px;border-radius:999px;background:var(--soft);overflow:hidden}.progress>i{display:block;height:100%;background:var(--accent)}
    a{color:var(--accent);text-decoration:none}pre{margin:0;padding:12px;background:#090b0e;color:#d9e1eb;border-radius:10px;max-height:520px;overflow:auto;white-space:pre-wrap;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
    dialog{width:min(1080px,95vw);border:1px solid var(--line);border-radius:14px;background:var(--panel);color:var(--text);padding:0}dialog::backdrop{background:rgba(0,0,0,.48)}.dialog-head{display:flex;justify-content:space-between;align-items:flex-start;padding:14px 16px;border-bottom:1px solid var(--line)}.dialog-body{padding:16px;display:grid;gap:12px}.log-grid{display:grid;grid-template-columns:1fr 280px;gap:12px}.events{max-height:520px;overflow:auto;display:grid;gap:7px}.event{padding:8px;border:1px solid var(--line);border-radius:8px;font-size:12px}.empty{text-align:center;color:var(--muted);padding:18px 4px}.status-dot{width:8px;height:8px;border-radius:50%;background:var(--ok);display:inline-block}
    @media(max-width:980px){.top-grid,.bottom-grid,.log-grid{grid-template-columns:1fr}.summary{grid-template-columns:repeat(2,1fr)}.form-grid{grid-template-columns:1fr}.span-2{grid-column:auto}}
  </style>
</head>
<body>
<header>
  <div><h1>repo-harness Controller</h1><div class="muted" id="repoLabel">加载中…</div></div>
  <div class="toolbar"><span class="status-dot"></span><span class="muted" id="surfaceLabel">仅本机</span><button id="refreshBtn">刷新</button></div>
</header>
<main class="shell">
  <section class="summary" id="summary"></section>
  <section class="notice" id="connectorNotice"></section>
  <section class="top-grid">
    <div class="panel">
      <div class="row-head"><div><h2>启动 Codex / Claude 会话</h2><p class="muted">自动创建小型 Issue、Task、独立 worktree 和持久 Run。</p></div><span class="badge" id="timeoutPolicy"></span></div>
      <form id="quickForm" class="form-grid" style="margin-top:12px">
        <label>标题<input name="title" required placeholder="例如：修复时间线刷新问题" /></label>
        <label>执行器<select name="agent"><option value="codex">Codex</option><option value="claude">Claude</option></select></label>
        <label class="span-2">目标<textarea name="objective" required placeholder="只描述一个可独立验收的任务"></textarea></label>
        <label class="span-2">允许路径（逗号或换行）<input name="allowedPaths" placeholder="ios/Domain/**, ios/Tests/**" /></label>
        <label>检查（逗号分隔）<input name="checks" placeholder="ios-domain-tests" /></label>
        <label>风险<select name="risk"><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
        <label>执行时限<select name="timeoutMs" id="quickTimeout"><option value="1800000">30 分钟</option><option value="3600000" selected>60 分钟</option><option value="7200000">2 小时</option><option value="14400000">4 小时</option></select></label>
        <label>隔离方式<select name="isolate"><option value="true">独立 worktree</option><option value="false">当前工作区（需确认）</option></select></label>
        <div class="span-2 toolbar"><button class="primary" type="submit">创建并启动</button><span class="muted">超时参数会原样写入 Run，不会静默回退。</span></div>
      </form>
    </div>
    <div class="panel"><h2>待审批与最近 Job</h2><div id="jobs" class="list"></div></div>
  </section>
  <section class="panel"><div class="row-head"><div><h2>Issue / Task 看板</h2><p class="muted">每个任务独立启动、审核和验证，不把整个 Issue 塞进一个长会话。</p></div><label style="min-width:150px">默认任务时限<select id="taskTimeout"><option value="1800000">30 分钟</option><option value="3600000" selected>60 分钟</option><option value="7200000">2 小时</option><option value="14400000">4 小时</option></select></label></div><div id="board" class="board" style="margin-top:12px"></div></section>
  <section class="bottom-grid">
    <div class="panel"><h2>正在运行与最近 Run</h2><div id="runs" class="list"></div></div>
    <div class="panel"><h2>命名检查</h2><div id="checks" class="list"></div></div>
  </section>
</main>
<dialog id="logDialog">
  <div class="dialog-head"><div><h3 id="logTitle">Run</h3><div class="muted" id="logStatus"></div></div><div class="toolbar"><button id="cancelRunBtn" class="danger">终止</button><button id="retryRunBtn">重新执行</button><button id="closeLog">关闭</button></div></div>
  <div class="dialog-body"><div class="log-grid"><pre id="logOutput">加载中…</pre><div id="eventOutput" class="events"></div></div></div>
</dialog>
<script>
const TOKEN=${encodedToken};
const api=async(path,options={})=>{const headers={...(options.headers||{}),'x-repo-harness-local-token':TOKEN};if(options.body&&!headers['content-type'])headers['content-type']='application/json';const response=await fetch(path,{...options,headers});const data=await response.json().catch(()=>({error:'Invalid response'}));if(!response.ok)throw new Error(data.error||data.message||response.statusText);return data;};
const esc=(v)=>String(v??'').replace(/[&<>"']/g,(m)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const parseList=(v)=>String(v||'').split(/[\n,]/).map(x=>x.trim()).filter(Boolean);
const fmtMs=(ms)=>{if(ms===null||ms===undefined)return '—';if(ms>=3600000)return (ms/3600000).toFixed(ms%3600000?1:0)+' 小时';if(ms>=60000)return Math.ceil(ms/60000)+' 分钟';return Math.ceil(ms/1000)+' 秒';};
const age=(iso)=>iso?fmtMs(Math.max(0,Date.now()-Date.parse(iso))):'—';
let snapshot=null,activeRun=null,logTimer=null,previousStatuses={};
function column(status){if(['ready','planned','analysis','backlog','launch_blocked'].includes(status))return '待执行';if(status==='running')return '执行中';if(['review','integrated','verifying','changes_requested','verified'].includes(status))return '审核';if(['blocked','cancelled'].includes(status))return '阻塞';return '完成';}
function renderSummary(){const board=snapshot.board||{};const runs=snapshot.runs||[];const metrics=[['活跃 Issue',(board.issues||[]).filter(i=>!['done','cancelled'].includes(i.status)).length],['Ready Task',(board.readyTasks||[]).length],['运行中',runs.filter(r=>r.status==='running').length],['待审核',runs.filter(r=>r.status==='succeeded').length],['失败',runs.filter(r=>r.status==='failed').length]];document.querySelector('#summary').innerHTML=metrics.map(x=>'<div class="metric"><span class="muted">'+x[0]+'</span><strong>'+x[1]+'</strong></div>').join('');}
function renderBoard(){const cols=['待执行','执行中','审核','阻塞','完成'];const tasks=[];for(const issue of snapshot.board.issues||[])for(const task of issue.tasks||[])tasks.push({issue,task});document.querySelector('#board').innerHTML=cols.map(c=>{const items=tasks.filter(x=>column(x.task.status)===c);return '<div class="column"><div class="column-title"><span>'+c+'</span><span>'+items.length+'</span></div>'+(items.map(({issue,task})=>{const launchable=['ready','changes_requested'].includes(task.status);return '<div class="card"><strong>'+esc(task.title)+'</strong><div class="muted">'+esc(issue.id)+' / '+esc(task.id)+'</div><div class="meta"><span class="badge">'+esc(task.status)+'</span><span class="badge">'+esc(task.risk)+'</span><span class="badge">'+esc(task.recommendedAgent)+'</span></div><div class="muted">'+esc(task.objective||'')+'</div>'+(launchable?'<div class="toolbar"><button class="primary" onclick="launchTask(\''+esc(issue.id)+'\',\''+esc(task.id)+'\',\'codex\')">Codex</button><button onclick="launchTask(\''+esc(issue.id)+'\',\''+esc(task.id)+'\',\'claude\')">Claude</button></div>':'')+'</div>';}).join('')||'<div class="empty">暂无</div>')+'</div>';}).join('');}
function renderJobs(){document.querySelector('#jobs').innerHTML=(snapshot.localJobs||[]).slice(0,24).map(job=>{const pending=job.status==='pending_approval';return '<div class="row"><div class="row-head"><strong>'+esc(job.action)+'</strong><span class="badge '+(job.status==='failed'?'danger':pending?'warn':'')+'">'+esc(job.status)+'</span></div><div class="muted">'+esc(job.jobId)+'</div>'+(job.runId?'<div>Run：<button onclick="showLog(\''+esc(job.runId)+'\')">'+esc(job.runId)+'</button></div>':'')+(job.error?'<div class="badge danger">'+esc(job.error)+'</div>':'')+(pending?'<div class="toolbar"><button class="primary" onclick="approveJob(\''+esc(job.jobId)+'\')">批准并执行</button><button class="danger" onclick="cancelJob(\''+esc(job.jobId)+'\')">取消</button></div>':'')+'</div>';}).join('')||'<div class="empty">暂无 Job</div>';}
function runProgress(run){if(!run.timeoutMs||!run.startedAt)return '';const elapsed=run.timing?.elapsedMs??Math.max(0,Date.now()-Date.parse(run.startedAt));const pct=Math.min(100,Math.round(elapsed/run.timeoutMs*100));return '<div class="progress"><i style="width:'+pct+'%"></i></div><div class="muted">已运行 '+fmtMs(elapsed)+(run.timing?.remainingMs!==null&&run.timing?.remainingMs!==undefined?' · 剩余约 '+fmtMs(run.timing.remainingMs):'')+' · 上限 '+fmtMs(run.timeoutMs)+'</div>';}
function renderRuns(){const runs=snapshot.runs||[];document.querySelector('#runs').innerHTML=runs.slice(0,40).map(run=>{const running=run.status==='running';const retry=['failed','cancelled','unknown','waiting_for_user'].includes(run.status);return '<div class="row"><div class="row-head"><div><strong>'+esc(run.issueId)+' / '+esc(run.taskId)+'</strong><div class="muted">'+esc(run.runId)+' · '+esc(run.agent)+' / '+esc(run.provider)+'</div></div><span class="badge '+(run.status==='failed'?'danger':run.status==='succeeded'?'ok':running?'warn':'')+'">'+esc(run.status)+'</span></div>'+runProgress(run)+(run.error?'<div class="badge danger">'+esc(run.error)+'</div>':'')+'<div class="toolbar"><button onclick="showLog(\''+esc(run.runId)+'\')">日志与事件</button>'+(running&&run.provider==='local'?'<button class="danger" onclick="cancelRun(\''+esc(run.runId)+'\')">终止</button>':'')+(retry?'<button onclick="retryRun(\''+esc(run.runId)+'\')">60 分钟重试</button>':'')+(run.github?.url?'<a href="'+esc(run.github.url)+'" target="_blank">GitHub Session</a>':'')+(run.github?.pullRequestUrl?'<a href="'+esc(run.github.pullRequestUrl)+'" target="_blank">PR</a>':'')+'</div></div>';}).join('')||'<div class="empty">暂无 Run</div>';}
function renderChecks(){document.querySelector('#checks').innerHTML=(snapshot.checks||[]).map(check=>'<div class="row"><div class="row-head"><strong>'+esc(check.id)+'</strong><button onclick="runCheck(\''+esc(check.id)+'\')">运行</button></div><div class="muted">'+esc(check.description)+'</div></div>').join('')||'<div class="empty">未配置命名检查</div>';}
function notifyTransitions(){for(const run of snapshot.runs||[]){const before=previousStatuses[run.runId];if(before==='running'&&['succeeded','failed'].includes(run.status)&&Notification.permission==='granted')new Notification('repo-harness：'+run.status,{body:run.issueId+' / '+run.taskId});previousStatuses[run.runId]=run.status;}}
function renderConnector(){const c=snapshot.connector||{};const el=document.querySelector('#connectorNotice');if(c.healthy&&!c.needsReconnect){el.className='notice ok';el.innerHTML='<strong>MCP Controller 已就绪</strong><div class="muted">'+esc(c.configuredServerName||'未记录连接器名称')+' · '+esc(c.runtimeProfile)+' · '+esc(c.runtimeSurface)+' · '+esc(c.toolCount??'—')+' 个工具</div>';return;}el.className='notice warn';const reason=c.needsReconnect?'公网地址已变化，需要在 ChatGPT 中刷新或重建 Connector。':c.runtimeStatus==='not_started'?'MCP keepalive 尚未启动；本地面板仍可执行任务。':'当前 MCP 工具面与 Controller V2 不一致。';el.innerHTML='<strong>ChatGPT Connector 可能仍使用旧工具快照</strong><div>'+esc(reason)+'</div><div class="muted">当前：'+esc(c.runtimeProfile||'—')+' / '+esc(c.runtimeSurface||'—')+'；期望：controller / '+esc(snapshot.toolSurface)+'</div>';}
async function refresh(){try{snapshot=await api('/api/snapshot');document.querySelector('#repoLabel').textContent=snapshot.repoRoot;document.querySelector('#surfaceLabel').textContent=snapshot.toolSurface+' · 仅本机';document.querySelector('#timeoutPolicy').textContent='默认 '+fmtMs(snapshot.timeoutPolicy.defaultTimeoutMs)+' / 最大 '+fmtMs(snapshot.timeoutPolicy.maxTimeoutMs);renderSummary();renderConnector();renderBoard();renderJobs();renderRuns();renderChecks();notifyTransitions();}catch(error){alert(error.message);}}
async function createJob(request){const result=await api('/api/jobs',{method:'POST',body:JSON.stringify(request)});await refresh();return result;}
window.launchTask=async(issueId,taskId,agent)=>{try{await createJob({action:'launch-task',payload:{issueId,taskId,agent,isolate:true,timeoutMs:Number(document.querySelector('#taskTimeout').value)},requestedBy:'local-ui'});}catch(e){alert(e.message);}};
window.approveJob=async(id)=>{try{await api('/api/jobs/'+encodeURIComponent(id)+'/approve',{method:'POST'});await refresh();}catch(e){alert(e.message);}};
window.cancelJob=async(id)=>{try{await api('/api/jobs/'+encodeURIComponent(id)+'/cancel',{method:'POST'});await refresh();}catch(e){alert(e.message);}};
window.runCheck=async(id)=>{try{await createJob({action:'run-check',payload:{checkId:id},requestedBy:'local-ui'});}catch(e){alert(e.message);}};
window.cancelRun=async(id)=>{if(!confirm('终止这个本地 Run？'))return;try{await api('/api/runs/'+encodeURIComponent(id)+'/cancel',{method:'POST'});await refresh();}catch(e){alert(e.message);}};
window.retryRun=async(id)=>{try{const run=await api('/api/runs/'+encodeURIComponent(id)+'/retry',{method:'POST',body:JSON.stringify({timeoutMs:3600000,isolate:true})});await refresh();showLog(run.runId);}catch(e){alert(e.message);}};
window.showLog=async(id)=>{activeRun=id;document.querySelector('#logDialog').showModal();document.querySelector('#logTitle').textContent=id;await updateLog();clearInterval(logTimer);logTimer=setInterval(updateLog,1500);};
async function updateLog(){if(!activeRun)return;try{const [run,log,events]=await Promise.all([api('/api/runs/'+encodeURIComponent(activeRun)),api('/api/runs/'+encodeURIComponent(activeRun)+'/log'),api('/api/runs/'+encodeURIComponent(activeRun)+'/events')]);document.querySelector('#logStatus').textContent=run.status+' · '+run.agent+' · 已运行 '+fmtMs(run.timing?.elapsedMs)+' · 上限 '+fmtMs(run.timeoutMs);document.querySelector('#logOutput').textContent=log.log||'(暂无输出)';document.querySelector('#eventOutput').innerHTML=(events.events||[]).slice().reverse().map(e=>'<div class="event"><strong>'+esc(e.type)+'</strong><div>'+esc(e.message||'')+'</div><div class="muted">'+esc(e.at)+'</div></div>').join('')||'<div class="empty">暂无事件</div>';const running=run.status==='running';document.querySelector('#cancelRunBtn').style.display=running&&run.provider==='local'?'inline-block':'none';document.querySelector('#retryRunBtn').style.display=['failed','cancelled','unknown','waiting_for_user'].includes(run.status)?'inline-block':'none';if(!running){clearInterval(logTimer);await refresh();}}catch(e){document.querySelector('#logOutput').textContent=e.message;}}
document.querySelector('#quickForm').addEventListener('submit',async(event)=>{event.preventDefault();const f=new FormData(event.currentTarget);try{await createJob({action:'quick-agent-session',requestedBy:'local-ui',payload:{title:f.get('title'),objective:f.get('objective'),agent:f.get('agent'),allowedPaths:parseList(f.get('allowedPaths')),checks:parseList(f.get('checks')),risk:f.get('risk'),isolate:f.get('isolate')==='true',timeoutMs:Number(f.get('timeoutMs'))}});event.currentTarget.reset();document.querySelector('#quickTimeout').value='3600000';}catch(e){alert(e.message);}});
document.querySelector('#refreshBtn').onclick=refresh;document.querySelector('#closeLog').onclick=()=>{document.querySelector('#logDialog').close();activeRun=null;clearInterval(logTimer);};document.querySelector('#cancelRunBtn').onclick=()=>activeRun&&cancelRun(activeRun);document.querySelector('#retryRunBtn').onclick=()=>activeRun&&retryRun(activeRun);
if('Notification'in window&&Notification.permission==='default')Notification.requestPermission().catch(()=>{});refresh();setInterval(refresh,5000);
</script>
</body>
</html>`;
}

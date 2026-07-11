import { readFileSync, writeFileSync } from 'node:fs';

function replaceOnce(source, oldValue, newValue, label) {
  const first = source.indexOf(oldValue);
  if (first < 0) throw new Error(`missing patch anchor: ${label}`);
  if (source.indexOf(oldValue, first + oldValue.length) >= 0) throw new Error(`ambiguous patch anchor: ${label}`);
  return source.slice(0, first) + newValue + source.slice(first + oldValue.length);
}

function patch(path, edits) {
  let source = readFileSync(path, 'utf8');
  for (const [label, oldValue, newValue] of edits) source = replaceOnce(source, oldValue, newValue, label);
  writeFileSync(path, source);
}

patch('src/cli/local-bridge/console-view-models.ts', [
  [
    'work summary access mode',
    "  mode: ModePreviewViewModel['mode'];\n  statusLabel: string;",
    "  mode: ModePreviewViewModel['mode'];\n  accessMode: 'request' | 'full_access';\n  accessModeLabel: string;\n  statusLabel: string;",
  ],
  [
    'command center access mode',
    "  generatedAt: string;\n  readiness: SystemReadinessViewModel;",
    "  generatedAt: string;\n  accessMode: 'request' | 'full_access';\n  accessModeLabel: string;\n  accessModeDescription: string;\n  readiness: SystemReadinessViewModel;",
  ],
]);

patch('src/cli/local-bridge/facade-api.ts', [
  [
    'access policy imports',
    "import type { RepositoryRecord } from '../repositories/types';",
    "import type { RepositoryRecord } from '../repositories/types';\nimport {\n  accessModeDescriptor,\n  isAccessMode,\n  readRepositoryAccessPolicy,\n  writeRepositoryAccessPolicy,\n  type AccessMode,\n} from '../../runtime/control-plane/governance/access-policy';",
  ],
  [
    'work summary access mode mapping',
    "    modeLabel: mode.label,\n    mode: mode.mode,\n    statusLabel: status.label,",
    "    modeLabel: mode.label,\n    mode: mode.mode,\n    accessMode: work.constraints.accessMode ?? 'request',\n    accessModeLabel: accessModeDescriptor(work.constraints.accessMode ?? 'request').shortLabel,\n    statusLabel: status.label,",
  ],
  [
    'command center access descriptor',
    "  const goalLoop = buildGoalLoopStatusView(ctx);\n  const banner = readiness.connectorFreshness?.severity === 'warning' || readiness.connectorFreshness?.severity === 'error'",
    "  const goalLoop = buildGoalLoopStatusView(ctx);\n  const accessPolicy = readRepositoryAccessPolicy(ctx.controllerHome, ctx.repository.repoId);\n  const accessDescriptor = accessModeDescriptor(accessPolicy.mode);\n  const banner = readiness.connectorFreshness?.severity === 'warning' || readiness.connectorFreshness?.severity === 'error'",
  ],
  [
    'command center access fields',
    "    schemaVersion: 1,\n    generatedAt: new Date().toISOString(),\n    readiness,",
    "    schemaVersion: 1,\n    generatedAt: new Date().toISOString(),\n    accessMode: accessPolicy.mode,\n    accessModeLabel: accessDescriptor.shortLabel,\n    accessModeDescription: accessDescriptor.description,\n    readiness,",
  ],
  [
    'console access functions',
    "export function startConsoleWork(\n  ctx: ConsoleFacadeContext,",
    "export function getConsoleAccessPolicy(ctx: ConsoleFacadeContext) {\n  const policy = readRepositoryAccessPolicy(ctx.controllerHome, ctx.repository.repoId);\n  return { policy, descriptor: accessModeDescriptor(policy.mode) };\n}\n\nexport function setConsoleAccessPolicy(\n  ctx: ConsoleFacadeContext,\n  input: { mode: unknown; confirmAuthorization?: boolean; confirmationText?: string },\n) {\n  if (!isAccessMode(input.mode)) throw new Error('ACCESS_MODE_INVALID: mode must be request or full_access');\n  if (input.confirmAuthorization !== true) {\n    throw new Error('ACCESS_MODE_AUTHORIZATION_REQUIRED: changing repository access requires explicit confirmation');\n  }\n  if (input.mode === 'full_access' && input.confirmationText !== 'enable-full-access') {\n    throw new Error('FULL_ACCESS_STRONG_CONFIRMATION_REQUIRED: confirmation text must equal enable-full-access');\n  }\n  const policy = writeRepositoryAccessPolicy(ctx.controllerHome, ctx.repository.repoId, input.mode, 'user');\n  return { policy, descriptor: accessModeDescriptor(policy.mode) };\n}\n\nexport function startConsoleWork(\n  ctx: ConsoleFacadeContext,",
  ],
  [
    'console start input access mode',
    "    destructive?: boolean;\n    approvalConfirmed?: boolean;",
    "    destructive?: boolean;\n    accessMode?: AccessMode;\n    approvalConfirmed?: boolean;",
  ],
  [
    'console start constraints',
    "      checks: input.checkIds,\n      modeInput: {",
    "      checks: input.checkIds,\n      constraints: input.accessMode ? { accessMode: input.accessMode } : undefined,\n      modeInput: {",
  ],
]);

patch('src/cli/local-bridge/server.ts', [
  [
    'server access facade imports',
    "  getAutomationSettings,\n  getConsolePlugin,",
    "  getAutomationSettings,\n  getConsoleAccessPolicy,\n  getConsolePlugin,",
  ],
  [
    'server access setter import',
    "  resolveConsoleHandoff,\n  startConsoleWork,",
    "  resolveConsoleHandoff,\n  setConsoleAccessPolicy,\n  startConsoleWork,",
  ],
  [
    'server access endpoints',
    "  app.post(\"/api/console/mode-preview\", (request, response) => {",
    "  app.get(\"/api/console/access-policy\", (request, response) => {\n    try {\n      response.json(getConsoleAccessPolicy(consoleCtx(request)));\n    } catch (error) {\n      response.status(400).json({ error: errorMessage(error) });\n    }\n  });\n\n  app.post(\"/api/console/access-policy\", (request, response) => {\n    try {\n      const body = request.body && typeof request.body === \"object\" && !Array.isArray(request.body)\n        ? request.body as Record<string, unknown>\n        : {};\n      response.json(setConsoleAccessPolicy(consoleCtx(request), {\n        mode: body.mode,\n        confirmAuthorization: body.confirmAuthorization === true,\n        confirmationText: queryString(body.confirmationText),\n      }));\n    } catch (error) {\n      response.status(400).json({ error: errorMessage(error) });\n    }\n  });\n\n  app.post(\"/api/console/mode-preview\", (request, response) => {",
  ],
  [
    'server start access mode',
    "        destructive: body.destructive === true,\n        approvalConfirmed: body.approvalConfirmed === true,",
    "        destructive: body.destructive === true,\n        accessMode: body.accessMode === 'full_access' ? 'full_access' : body.accessMode === 'request' ? 'request' : undefined,\n        approvalConfirmed: body.approvalConfirmed === true,",
  ],
]);

patch('src/cli/local-bridge/dashboard.ts', [
  [
    'access picker css',
    ".mode-card{display:grid;gap:6px}.mode-card .label{font-weight:800;font-size:16px}\n.pill{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;font-size:12px;font-weight:700;border-radius:999px}",
    ".mode-card{display:grid;gap:6px}.mode-card .label{font-weight:800;font-size:16px}\n.access-panel{margin-top:12px;padding:12px;border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,.025)}.access-picker{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px}.access-option{display:grid;gap:3px;text-align:left;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.025);color:var(--text)}.access-option strong{font-size:14px}.access-option span{font-size:12px;color:var(--muted)}.access-option.active{border-color:rgba(52,211,153,.5);background:rgba(52,211,153,.1)}.access-option.full.active{border-color:rgba(251,191,36,.55);background:rgba(251,191,36,.09)}\n.pill{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;font-size:12px;font-weight:700;border-radius:999px}",
  ],
  [
    'top access chip',
    "    <button class=\"chip\" id=\"repoChip\" onclick=\"switchView('repositories')\">仓库 · <strong id=\"topRepo\">—</strong></button>\n    <span class=\"chip\"><span class=\"dot\" id=\"readyDot\"></span><strong id=\"topReady\">检查中</strong></span>",
    "    <button class=\"chip\" id=\"repoChip\" onclick=\"switchView('repositories')\">仓库 · <strong id=\"topRepo\">—</strong></button>\n    <button class=\"chip\" id=\"accessChip\" onclick=\"focusAccessMode()\">权限 · <strong id=\"topAccessMode\">Request</strong></button>\n    <span class=\"chip\"><span class=\"dot\" id=\"readyDot\"></span><strong id=\"topReady\">检查中</strong></span>",
  ],
  [
    'selected access variable',
    "var selectedRepoId=queryRepoId()||safeGet('repoHarnessSelectedRepoId')||'';\nvar commandCenter=null;",
    "var selectedRepoId=queryRepoId()||safeGet('repoHarnessSelectedRepoId')||'';\nvar selectedAccessMode='request';\nvar commandCenter=null;",
  ],
  [
    'render chrome access mode',
    "  document.getElementById('topRepo').textContent=repo.name||'未选择';\n  document.getElementById('topReady').textContent=ready.label||'未知';",
    "  document.getElementById('topRepo').textContent=repo.name||'未选择';\n  document.getElementById('topAccessMode').textContent=cc.accessModeLabel||(selectedAccessMode==='full_access'?'Full Access':'Request');\n  document.getElementById('topReady').textContent=ready.label||'未知';",
  ],
  [
    'render home access vars',
    "  var mode=obj(modePreview||cc.modePreviewDefault);\n  var el=document.getElementById('view-home');",
    "  var mode=obj(modePreview||cc.modePreviewDefault);\n  var accessMode=selectedAccessMode||cc.accessMode||'request';\n  var accessLabel=accessMode==='full_access'?'Full Access':'Request';\n  var accessDescription=accessMode==='full_access'\n    ? '允许当前仓库内文件修改、命令、依赖和本地 Git；远程、破坏性、仓库外路径和密钥仍需确认或保持禁止。'\n    : '在安全边界内执行；需要命令、依赖、本地 Git 或更高权限时向你请求。';\n  var el=document.getElementById('view-home');",
  ],
  [
    'render home access picker',
    "      '<textarea id=\"taskObjective\" placeholder=\"例如：优化 Controller 首页的信息层级，让当前任务和待决定事项更容易找到，不改变后端行为。\"></textarea>'+\n      '<details class=\"advanced\" style=\"margin-top:10px\"><summary>补充验收标准和允许修改的路径</summary>'+",
    "      '<textarea id=\"taskObjective\" placeholder=\"例如：优化 Controller 首页的信息层级，让当前任务和待决定事项更容易找到，不改变后端行为。\"></textarea>'+\n      '<div class=\"access-panel\" id=\"accessModePanel\"><div class=\"section-title\" style=\"margin:0\"><div><strong>权限等级</strong><div class=\"faint\">本设置对当前仓库的新任务生效</div></div>'+pill(accessMode==='full_access'?'amber':'green',accessLabel)+'</div>'+\n        '<div class=\"access-picker\">'+\n          '<button class=\"access-option '+(accessMode==='request'?'active':'')+'\" onclick=\"setAccessMode(\\'request\\')\"><strong>Request</strong><span>需要提升权限时请求确认</span></button>'+\n          '<button class=\"access-option full '+(accessMode==='full_access'?'active':'')+'\" onclick=\"setAccessMode(\\'full_access\\')\"><strong>Full Access</strong><span>当前仓库内正常开发不再反复询问</span></button>'+\n        '</div><p class=\"muted\" style=\"margin:9px 0 0\">'+esc(accessDescription)+'</p></div>'+\n      '<details class=\"advanced\" style=\"margin-top:10px\"><summary>补充验收标准和允许修改的路径</summary>'+",
  ],
  [
    'work card access mode',
    "    '<div class=\"muted\">模式：'+esc(work.modeLabel||'—')+' · 阶段：'+esc(work.phaseLabel||work.statusLabel||'—')+'</div>'+",
    "    '<div class=\"muted\">模式：'+esc(work.modeLabel||'—')+' · 权限：'+esc(work.accessModeLabel||(work.accessMode==='full_access'?'Full Access':'Request'))+' · 阶段：'+esc(work.phaseLabel||work.statusLabel||'—')+'</div>'+",
  ],
  [
    'access functions',
    "function taskPayload(){",
    "function focusAccessMode(){var el=document.getElementById('accessModePanel');if(el)el.scrollIntoView({behavior:'smooth',block:'center'})}\nfunction setAccessMode(mode){\n  if(busy||mode===selectedAccessMode)return;\n  if(mode==='full_access'){\n    var ok=confirm('启用 Full Access？\\n\\n允许：当前仓库内文件修改、命令、依赖和本地 Git。\\n仍需确认：远程写入、破坏性操作、仓库外路径。\\n始终禁止：原始密钥和凭据。');\n    if(!ok)return;\n  }\n  setBusy(true,'更新权限等级…');\n  api('/api/console/access-policy'+repoQuery(),{method:'POST',body:JSON.stringify({mode:mode,confirmAuthorization:true,confirmationText:mode==='full_access'?'enable-full-access':undefined})}).then(function(res){\n    var policy=obj(res.policy);var descriptor=obj(res.descriptor);\n    selectedAccessMode=policy.mode==='full_access'?'full_access':'request';\n    commandCenter=commandCenter||{};commandCenter.accessMode=selectedAccessMode;commandCenter.accessModeLabel=descriptor.shortLabel||(selectedAccessMode==='full_access'?'Full Access':'Request');commandCenter.accessModeDescription=descriptor.description||'';\n    toast('权限已切换为 '+commandCenter.accessModeLabel);renderChrome();renderHome();\n  }).catch(function(e){toast(e.message||'权限更新失败')}).finally(function(){setBusy(false)});\n}\n\nfunction taskPayload(){",
  ],
  [
    'task payload access mode',
    "    expectedFiles:files,\n    scopeClear:true",
    "    expectedFiles:files,\n    accessMode:selectedAccessMode,\n    scopeClear:true",
  ],
  [
    'refresh access mode',
    "    commandCenter=res;\n    lastRefreshedAt=new Date().toLocaleTimeString();",
    "    commandCenter=res;\n    selectedAccessMode=res.accessMode==='full_access'?'full_access':'request';\n    lastRefreshedAt=new Date().toLocaleTimeString();",
  ],
]);

writeFileSync('tests/cli/local-bridge-access-mode.test.ts', `import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { localBridgeDashboardHtml } from '../../src/cli/local-bridge/dashboard';
import {
  buildCommandCenter,
  getConsoleAccessPolicy,
  setConsoleAccessPolicy,
  startConsoleWork,
  type ConsoleFacadeContext,
} from '../../src/cli/local-bridge/facade-api';
import { ensureControllerHome } from '../../src/cli/repositories/controller-home';
import { registerRepository } from '../../src/cli/repositories/registry';
import { getWorkContract } from '../../src/runtime/control-plane/facade';

const roots: string[] = [];

function fixture(): ConsoleFacadeContext {
  const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-console-access-repo-'));
  const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-console-access-home-'));
  roots.push(repoRoot, controllerHome);
  Bun.spawnSync(['git', 'init', '-b', 'main'], { cwd: repoRoot });
  ensureControllerHome(controllerHome);
  const repository = registerRepository({ path: repoRoot, controllerHome, displayName: 'console access', repoIdOverride: 'repo-console-access' });
  return { controllerHome, repository };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('local bridge access mode', () => {
  test('dashboard exposes Request and Full Access controls', () => {
    const html = localBridgeDashboardHtml();
    expect(html).toContain('权限等级');
    expect(html).toContain('Request');
    expect(html).toContain('Full Access');
    expect(html).toContain('/api/console/access-policy');
  });

  test('console policy requires strong confirmation for Full Access', () => {
    const ctx = fixture();
    expect(getConsoleAccessPolicy(ctx).policy.mode).toBe('request');
    expect(() => setConsoleAccessPolicy(ctx, { mode: 'full_access', confirmAuthorization: true })).toThrow('FULL_ACCESS_STRONG_CONFIRMATION_REQUIRED');
    expect(setConsoleAccessPolicy(ctx, { mode: 'full_access', confirmAuthorization: true, confirmationText: 'enable-full-access' }).policy.mode).toBe('full_access');
  });

  test('console task captures selected access mode', () => {
    const ctx = fixture();
    const result = startConsoleWork(ctx, {
      objective: 'Update four local files',
      expectedFiles: 4,
      scopeClear: true,
      accessMode: 'full_access',
      requiresApproval: true,
    });
    expect(result.status).toBe('ok');
    const workId = String((result.data.work as { workId?: string }).workId ?? '');
    expect(getWorkContract({ controllerHome: ctx.controllerHome, repoId: ctx.repository.repoId }, workId)?.constraints.accessMode).toBe('full_access');
  });

  test('command center reports the repository default', async () => {
    const ctx = fixture();
    setConsoleAccessPolicy(ctx, { mode: 'full_access', confirmAuthorization: true, confirmationText: 'enable-full-access' });
    const commandCenter = await buildCommandCenter(ctx, []);
    expect(commandCenter.accessMode).toBe('full_access');
    expect(commandCenter.accessModeLabel).toBe('Full Access');
  });
});
`);

console.log('access mode console patch applied');

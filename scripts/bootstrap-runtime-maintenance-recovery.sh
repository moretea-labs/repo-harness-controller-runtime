#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$PWD}"
repo_id="${REPO_HARNESS_REPO_ID:-}"
controller_home="${REPO_HARNESS_CONTROLLER_HOME:-$repo_root/_ops/controller-home}"
quarantine_root="$repo_root/.ai/harness/local-jobs-quarantine"
min_age_minutes="${REPO_HARNESS_RECOVERY_MIN_AGE_MINUTES:-10}"
cancel_pending="${REPO_HARNESS_RECOVERY_CANCEL_PENDING_APPROVALS:-false}"
now_ms="$(node -e 'console.log(Date.now())')"

mkdir -p "$quarantine_root"

node - "$repo_root" "$repo_id" "$controller_home" "$quarantine_root" "$min_age_minutes" "$now_ms" "$cancel_pending" <<'NODE'
const fs = require('fs');
const path = require('path');

const [, , repoRoot, repoId, controllerHome, quarantineRoot, rawMinAge, rawNow, rawCancelPending] = process.argv;
const minAgeMinutes = Number(rawMinAge || '10');
const nowMs = Number(rawNow || Date.now());
const cancelPending = String(rawCancelPending || 'false').toLowerCase() === 'true';
const activeStatuses = new Set(['approved', 'dispatched', 'running']);
const pendingStatuses = new Set(['pending_approval']);
const applied = [];
const inspectedRoots = [];

function iso() { return new Date().toISOString(); }
function safeName(value) { return String(value || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function isPidAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}
function ageMinutes(job, dir) {
  const raw = job.heartbeatAt || job.updatedAt || job.startedAt || job.createdAt;
  const parsed = raw ? Date.parse(raw) : NaN;
  const fallback = fs.existsSync(dir) ? fs.statSync(dir).mtimeMs : nowMs;
  return Math.max(0, Math.round((nowMs - (Number.isFinite(parsed) ? parsed : fallback)) / 60000));
}
function moveToQuarantine(targetPath, id, reason, rootLabel) {
  const target = path.join(quarantineRoot, `${iso().replace(/[:.]/g, '-')}-${safeName(rootLabel)}-${safeName(id)}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.renameSync(targetPath, target);
  } catch (error) {
    if (error && error.code === 'EXDEV') {
      fs.cpSync(targetPath, target, { recursive: true, force: false, errorOnExist: true });
      fs.rmSync(targetPath, { recursive: true, force: true });
    } else {
      throw error;
    }
  }
  applied.push({ root: rootLabel, id, action: 'quarantine', target, reason });
}
function terminalize(dir, job, status, reason, rootLabel) {
  const file = path.join(dir, 'job.json');
  atomicWriteJson(file, {
    ...job,
    status,
    updatedAt: iso(),
    finishedAt: iso(),
    error: job.error || `Terminalized by bootstrap runtime maintenance: ${reason}`,
    outcome: job.outcome || { infrastructureError: { code: 'BOOTSTRAP_MAINTENANCE_TERMINALIZED', message: reason } },
  });
  applied.push({ root: rootLabel, id: job.jobId || path.basename(dir), action: 'terminalize', status, reason });
}
function rootCandidates() {
  const roots = [{ label: 'repository', root: path.join(repoRoot, '.ai/harness/local-jobs') }];
  if (repoId) {
    roots.push({
      label: `controller-${repoId}`,
      root: path.join(controllerHome, 'repositories', repoId, 'local-jobs'),
    });
  }
  return roots;
}
function normalizeExistingRoot(root) {
  if (!fs.existsSync(root)) return null;
  try {
    return fs.realpathSync.native(root);
  } catch {
    return path.resolve(root);
  }
}
function inspectActiveIndex(localJobsRoot, rootLabel) {
  const activeIndex = path.join(localJobsRoot, 'active-index.json');
  if (!fs.existsSync(activeIndex)) return;
  try {
    const parsed = readJson(activeIndex);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.jobIds)) {
      moveToQuarantine(activeIndex, 'active-index.json', 'invalid active-index.json shape', rootLabel);
    }
  } catch (error) {
    moveToQuarantine(activeIndex, 'active-index.json', `unreadable active-index.json: ${error.message}`, rootLabel);
  }
}
function processLocalJobsRoot(localJobsRoot, rootLabel) {
  inspectedRoots.push({ label: rootLabel, root: localJobsRoot, exists: fs.existsSync(localJobsRoot) });
  if (!fs.existsSync(localJobsRoot)) return;
  if (!fs.statSync(localJobsRoot).isDirectory()) {
    moveToQuarantine(localJobsRoot, path.basename(localJobsRoot), 'local-jobs path is not a directory', rootLabel);
    fs.mkdirSync(localJobsRoot, { recursive: true });
    return;
  }

  inspectActiveIndex(localJobsRoot, rootLabel);

  for (const entry of fs.readdirSync(localJobsRoot, { withFileTypes: true })) {
    if (entry.name === 'active-index.json') continue;
    const entryPath = path.join(localJobsRoot, entry.name);
    if (!entry.isDirectory()) {
      moveToQuarantine(entryPath, entry.name, 'unexpected non-directory entry in local-jobs root', rootLabel);
      continue;
    }
    const file = path.join(entryPath, 'job.json');
    if (!fs.existsSync(file)) {
      moveToQuarantine(entryPath, entry.name, 'missing job.json', rootLabel);
      continue;
    }
    let job;
    try { job = readJson(file); } catch (error) {
      moveToQuarantine(entryPath, entry.name, `unreadable job.json: ${error.message}`, rootLabel);
      continue;
    }
    const status = String(job.status || 'unknown');
    if (pendingStatuses.has(status)) {
      const age = ageMinutes(job, entryPath);
      if (cancelPending && age >= minAgeMinutes) {
        terminalize(entryPath, job, 'cancelled', `pending approval cancelled by explicit bootstrap flag ageMinutes=${age}`, rootLabel);
      }
      continue;
    }
    if (!activeStatuses.has(status)) continue;
    const age = ageMinutes(job, entryPath);
    const deadlineExpired = job.deadlineAt && Date.parse(job.deadlineAt) < nowMs;
    const workerAlive = isPidAlive(job.workerPid || job.ownerPid);
    if ((deadlineExpired || !workerAlive) && age >= minAgeMinutes) {
      terminalize(entryPath, job, 'orphaned', `workerAlive=${workerAlive} deadlineExpired=${Boolean(deadlineExpired)} ageMinutes=${age}`, rootLabel);
    }
  }

  const activeIds = [];
  for (const entry of fs.readdirSync(localJobsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const job = readJson(path.join(localJobsRoot, entry.name, 'job.json'));
      const status = String(job.status || '');
      const keepActive = ['approved', 'dispatched', 'running'].includes(status) || (status === 'pending_approval' && !cancelPending);
      if (keepActive && job.jobId) activeIds.push(job.jobId);
    } catch {}
  }

  atomicWriteJson(path.join(localJobsRoot, 'active-index.json'), {
    schemaVersion: 1,
    ownerPid: process.pid,
    updatedAt: iso(),
    jobIds: [...new Set(activeIds)].sort().reverse(),
  });
}

const seen = new Set();
for (const candidate of rootCandidates()) {
  const normalized = normalizeExistingRoot(candidate.root) || path.resolve(candidate.root);
  if (seen.has(normalized)) continue;
  seen.add(normalized);
  processLocalJobsRoot(candidate.root, candidate.label);
}

const auditDir = path.join(repoRoot, '.ai/harness/controller');
fs.mkdirSync(auditDir, { recursive: true });
fs.appendFileSync(
  path.join(auditDir, 'bootstrap-runtime-maintenance.jsonl'),
  JSON.stringify({ at: iso(), repoId: repoId || null, inspectedRoots, minAgeMinutes, cancelPending, applied }) + '\n',
);

if (!repoId) {
  console.error('[repo-harness-recovery] REPO_HARNESS_REPO_ID is not set; skipped controller-home local-jobs root to avoid cross-repository cleanup.');
}
console.log(JSON.stringify({ status: 'ok', repoId: repoId || null, inspectedRoots, applied }, null, 2));
NODE

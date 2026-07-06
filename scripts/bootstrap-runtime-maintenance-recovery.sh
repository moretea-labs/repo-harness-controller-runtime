#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$PWD}"
local_jobs_root="$repo_root/.ai/harness/local-jobs"
quarantine_root="$repo_root/.ai/harness/local-jobs-quarantine"
min_age_minutes="${REPO_HARNESS_RECOVERY_MIN_AGE_MINUTES:-10}"
cancel_pending="${REPO_HARNESS_RECOVERY_CANCEL_PENDING_APPROVALS:-false}"
now_ms="$(node -e 'console.log(Date.now())')"

if [[ ! -d "$local_jobs_root" ]]; then
  echo "[repo-harness-recovery] no local-jobs directory: $local_jobs_root"
  exit 0
fi

mkdir -p "$quarantine_root"

node - "$repo_root" "$local_jobs_root" "$quarantine_root" "$min_age_minutes" "$now_ms" "$cancel_pending" <<'NODE'
const fs = require('fs');
const path = require('path');

const [, , repoRoot, localJobsRoot, quarantineRoot, rawMinAge, rawNow, rawCancelPending] = process.argv;
const minAgeMinutes = Number(rawMinAge || '10');
const nowMs = Number(rawNow || Date.now());
const cancelPending = String(rawCancelPending || 'false').toLowerCase() === 'true';
const activeStatuses = new Set(['approved', 'dispatched', 'running']);
const pendingStatuses = new Set(['pending_approval']);
const applied = [];

function iso() { return new Date().toISOString(); }
function safeName(value) { return String(value || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
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
function quarantine(dir, id, reason) {
  const target = path.join(quarantineRoot, `${iso().replace(/[:.]/g, '-')}-${safeName(id)}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(dir, target);
  applied.push({ id, action: 'quarantine', target, reason });
}
function terminalize(dir, job, status, reason) {
  const file = path.join(dir, 'job.json');
  writeJson(file, {
    ...job,
    status,
    updatedAt: iso(),
    finishedAt: iso(),
    error: job.error || `Terminalized by bootstrap runtime maintenance: ${reason}`,
    outcome: job.outcome || { infrastructureError: { code: 'BOOTSTRAP_MAINTENANCE_TERMINALIZED', message: reason } },
  });
  applied.push({ id: job.jobId || path.basename(dir), action: 'terminalize', status, reason });
}

for (const entry of fs.readdirSync(localJobsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const dir = path.join(localJobsRoot, entry.name);
  const file = path.join(dir, 'job.json');
  if (!fs.existsSync(file)) {
    quarantine(dir, entry.name, 'missing job.json');
    continue;
  }
  let job;
  try { job = readJson(file); } catch (error) {
    quarantine(dir, entry.name, `unreadable job.json: ${error.message}`);
    continue;
  }
  const status = String(job.status || 'unknown');
  if (pendingStatuses.has(status)) {
    const age = ageMinutes(job, dir);
    if (cancelPending && age >= minAgeMinutes) terminalize(dir, job, 'cancelled', `pending approval cancelled by explicit bootstrap flag ageMinutes=${age}`);
    continue;
  }
  if (!activeStatuses.has(status)) continue;
  const age = ageMinutes(job, dir);
  const deadlineExpired = job.deadlineAt && Date.parse(job.deadlineAt) < nowMs;
  const workerAlive = isPidAlive(job.workerPid || job.ownerPid);
  if ((deadlineExpired || !workerAlive) && age >= minAgeMinutes) {
    terminalize(dir, job, 'orphaned', `workerAlive=${workerAlive} deadlineExpired=${Boolean(deadlineExpired)} ageMinutes=${age}`);
  }
}

const activeIds = [];
for (const entry of fs.readdirSync(localJobsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  try {
    const job = readJson(path.join(localJobsRoot, entry.name, 'job.json'));
    if (['pending_approval', 'approved', 'dispatched', 'running'].includes(String(job.status || '')) && job.jobId) activeIds.push(job.jobId);
  } catch {}
}
writeJson(path.join(localJobsRoot, 'active-index.json'), {
  schemaVersion: 1,
  ownerPid: process.pid,
  updatedAt: iso(),
  jobIds: [...new Set(activeIds)].sort().reverse(),
});

const auditDir = path.join(repoRoot, '.ai/harness/controller');
fs.mkdirSync(auditDir, { recursive: true });
fs.appendFileSync(path.join(auditDir, 'bootstrap-runtime-maintenance.jsonl'), JSON.stringify({ at: iso(), minAgeMinutes, cancelPending, applied }) + '\n');
console.log(JSON.stringify({ status: 'ok', applied }, null, 2));
NODE

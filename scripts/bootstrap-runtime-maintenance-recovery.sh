#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${1:-$PWD}"
REPO_ID="${REPO_HARNESS_REPO_ID:-repo_123b7cf58b6b17b5cbe46a56}"
MIN_AGE_MINUTES="${REPO_HARNESS_RECOVERY_MIN_AGE_MINUTES:-0}"
CANCEL_PENDING="${REPO_HARNESS_RECOVERY_CANCEL_PENDING_APPROVALS:-false}"
CONTROLLER_HOME="${REPO_HARNESS_CONTROLLER_HOME:-$REPO_ROOT/_ops/controller-home}"

cd "$REPO_ROOT"

python3 - <<'PY' "$REPO_ROOT" "$REPO_ID" "$MIN_AGE_MINUTES" "$CANCEL_PENDING" "$CONTROLLER_HOME"
from __future__ import annotations
import json, os, shutil, sys, time
from datetime import datetime, timezone
from pathlib import Path

repo_root = Path(sys.argv[1]).resolve()
repo_id = sys.argv[2]
min_age_minutes = max(0, int(float(sys.argv[3])))
cancel_pending = sys.argv[4].lower() == 'true'
controller_home = Path(sys.argv[5]).resolve()
now = datetime.now(timezone.utc)

active_statuses = {'pending_approval', 'approved', 'dispatched', 'running'}
terminal_statuses = {'succeeded', 'failed', 'timed_out', 'orphaned', 'stale', 'cancelled'}

roots = [
    ('repository', repo_root / '.ai' / 'harness' / 'local-jobs'),
    ('controller', controller_home / 'repositories' / repo_id / 'local-jobs'),
]
records_root = controller_home / 'repositories' / repo_id / 'execution-jobs' / 'records'
audit_path = repo_root / '.ai' / 'harness' / 'controller' / 'bootstrap-runtime-maintenance-recovery.jsonl'
quarantine_root = repo_root / '.ai' / 'harness' / 'quarantine' / 'local-jobs'

def iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

def age_minutes(value: str | None) -> int | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except Exception:
        return None
    return max(0, int((now - parsed).total_seconds() // 60))

def atomic_write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f'.{os.getpid()}.tmp')
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')
    tmp.replace(path)

def append_event(job_dir: Path, message: str, data: dict | None = None) -> None:
    event_path = job_dir / 'events.jsonl'
    event_path.parent.mkdir(parents=True, exist_ok=True)
    with event_path.open('a', encoding='utf-8') as handle:
        handle.write(json.dumps({'at': iso(), 'type': 'job_failed', 'message': message, 'data': data or {}}) + '\n')

def inside(root: Path, path: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except Exception:
        return False

def execution_record_exists(execution_job_id: str) -> bool:
    if not execution_job_id:
        return False
    return (records_root / f'{execution_job_id}.json').exists()

def terminalize(job_path: Path, job: dict, reason: str, code: str, data: dict | None = None) -> dict:
    job['status'] = 'cancelled' if job.get('status') == 'pending_approval' and cancel_pending else 'failed'
    job['finishedAt'] = iso()
    job.pop('workerPid', None)
    job['error'] = reason
    outcome = job.get('outcome') if isinstance(job.get('outcome'), dict) else {}
    outcome['infrastructureError'] = {'code': code, 'message': reason}
    job['outcome'] = outcome
    atomic_write_json(job_path, job)
    append_event(job_path.parent, reason, {'repairedBy': 'bootstrap-runtime-maintenance-recovery', **(data or {})})
    return job

def quarantine(root_kind: str, root: Path, entry: Path, reason: str) -> Path:
    if not inside(root, entry):
        raise RuntimeError(f'unsafe quarantine path escapes local-jobs root: {entry}')
    stamp = iso().replace(':', '-').replace('.', '-')
    target = quarantine_root / f'{stamp}-{root_kind}-{entry.name}'
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(entry), str(target))
    return target

def rebuild_active_index(root: Path) -> list[str]:
    job_ids: list[str] = []
    if root.exists():
        for entry in sorted(root.iterdir()):
            if not entry.is_dir() or entry.name in {'.repo-harness-owner.json', 'active-index.json'}:
                continue
            job_path = entry / 'job.json'
            if not job_path.exists():
                continue
            try:
                job = json.loads(job_path.read_text())
            except Exception:
                continue
            if job.get('status') in active_statuses:
                job_ids.append(str(job.get('jobId') or entry.name))
    atomic_write_json(root / 'active-index.json', {
        'schemaVersion': 1,
        'ownerPid': os.getpid(),
        'updatedAt': iso(),
        'jobIds': sorted(set(job_ids), reverse=True),
    })
    return job_ids

applied: list[dict] = []
for root_kind, root in roots:
    if not root.exists():
        continue
    for entry in sorted(root.iterdir()):
        if entry.name in {'.repo-harness-owner.json', 'active-index.json'}:
            continue
        if not entry.is_dir():
            target = quarantine(root_kind, root, entry, 'unexpected local-jobs entry')
            applied.append({'action': 'quarantine', 'rootKind': root_kind, 'path': str(entry), 'target': str(target), 'reason': 'unexpected local-jobs entry'})
            continue
        job_path = entry / 'job.json'
        if not job_path.exists():
            target = quarantine(root_kind, root, entry, 'missing job.json')
            applied.append({'action': 'quarantine', 'rootKind': root_kind, 'path': str(entry), 'target': str(target), 'reason': 'missing job.json'})
            continue
        try:
            job = json.loads(job_path.read_text())
        except Exception:
            target = quarantine(root_kind, root, entry, 'unreadable job.json')
            applied.append({'action': 'quarantine', 'rootKind': root_kind, 'path': str(entry), 'target': str(target), 'reason': 'unreadable job.json'})
            continue
        status = job.get('status')
        if status not in active_statuses:
            continue
        age = age_minutes(job.get('updatedAt') or job.get('createdAt'))
        old_enough = age is None or age >= min_age_minutes
        if not old_enough:
            continue
        result = job.get('result') if isinstance(job.get('result'), dict) else {}
        execution_job_id = result.get('executionJobId') if isinstance(result.get('executionJobId'), str) else ''
        if execution_job_id and not execution_record_exists(execution_job_id):
            reason = f'Bootstrap terminalized Local Job {job.get("jobId") or entry.name}: projected Execution Job {execution_job_id} is missing.'
            terminalize(job_path, job, reason, 'MISSING_PROJECTED_EXECUTION_JOB', {'executionJobId': execution_job_id, 'rootKind': root_kind})
            applied.append({'action': 'terminalize', 'rootKind': root_kind, 'jobId': job.get('jobId') or entry.name, 'reason': reason})
            continue
        if status == 'pending_approval' and not cancel_pending:
            continue
        if status in {'approved', 'dispatched', 'pending_approval'} or (status == 'running' and not job.get('workerPid')):
            reason = f'Bootstrap terminalized stale active Local Job {job.get("jobId") or entry.name}: status={status}, ageMinutes={age}.'
            terminalize(job_path, job, reason, 'BOOTSTRAP_MAINTENANCE_TERMINALIZED', {'rootKind': root_kind, 'ageMinutes': age})
            applied.append({'action': 'terminalize', 'rootKind': root_kind, 'jobId': job.get('jobId') or entry.name, 'reason': reason})

active_indexes = []
for root_kind, root in roots:
    if root.exists():
        active_indexes.append({'rootKind': root_kind, 'root': str(root), 'activeJobIds': rebuild_active_index(root)})

audit_path.parent.mkdir(parents=True, exist_ok=True)
with audit_path.open('a', encoding='utf-8') as handle:
    handle.write(json.dumps({
        'schemaVersion': 1,
        'at': iso(),
        'repoId': repo_id,
        'minAgeMinutes': min_age_minutes,
        'cancelPendingApprovals': cancel_pending,
        'inspectedRoots': [{'kind': kind, 'path': str(root), 'exists': root.exists()} for kind, root in roots],
        'applied': applied,
        'activeIndexes': active_indexes,
    }, ensure_ascii=False) + '\n')

print(json.dumps({'ok': True, 'repoId': repo_id, 'appliedCount': len(applied), 'applied': applied, 'activeIndexes': active_indexes}, indent=2, ensure_ascii=False))
PY

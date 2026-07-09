import { randomUUID } from 'crypto';
import { closeSync, mkdirSync, openSync, readSync, statSync } from 'fs';
import { join } from 'path';
import { repositoryControllerRoot } from '../../cli/repositories/controller-home';
import type { ExecutionJob } from '../execution/jobs/types';
import { readJsonFile, sanitizeFileComponent, writeJsonAtomic } from '../shared/json-files';

export interface ExecutionArtifactRecord {
  schemaVersion: 1;
  artifactId: string;
  repoId: string;
  jobId: string;
  kind: 'job-result' | 'job-error' | 'command-output' | 'evidence';
  mediaType: 'application/json' | 'text/plain';
  path: string;
  byteLength: number;
  createdAt: string;
}

function artifactRoot(controllerHome: string, repoId: string): string {
  const root = join(repositoryControllerRoot(controllerHome, repoId), 'artifacts');
  mkdirSync(root, { recursive: true });
  return root;
}

function artifactDataPath(controllerHome: string, repoId: string, artifactId: string): string {
  return join(artifactRoot(controllerHome, repoId), 'data', `${sanitizeFileComponent(artifactId)}.json`);
}

function metadataPath(controllerHome: string, repoId: string, artifactId: string): string {
  return join(artifactRoot(controllerHome, repoId), 'records', `${sanitizeFileComponent(artifactId)}.json`);
}

export function writeExecutionArtifact(
  controllerHome: string,
  job: ExecutionJob,
  kind: ExecutionArtifactRecord['kind'],
  value: unknown,
): ExecutionArtifactRecord {
  const artifactId = `ART-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const dataPath = artifactDataPath(controllerHome, job.repoId, artifactId);
  writeJsonAtomic(dataPath, value);
  const record: ExecutionArtifactRecord = {
    schemaVersion: 1,
    artifactId,
    repoId: job.repoId,
    jobId: job.jobId,
    kind,
    mediaType: 'application/json',
    path: dataPath,
    byteLength: statSync(dataPath).size,
    createdAt: new Date().toISOString(),
  };
  writeJsonAtomic(metadataPath(controllerHome, job.repoId, artifactId), record);
  return record;
}

export function readExecutionArtifact(
  controllerHome: string,
  repoId: string,
  artifactId: string,
  maxBytes = 512 * 1024,
): { artifact: ExecutionArtifactRecord; content: unknown; truncated: boolean } {
  const artifact = readJsonFile<ExecutionArtifactRecord>(metadataPath(controllerHome, repoId, artifactId));
  if (artifact.repoId !== repoId || artifact.artifactId !== artifactId) throw new Error('ARTIFACT_IDENTITY_MISMATCH');
  const bounded = Math.max(1_024, Math.min(maxBytes, 2 * 1024 * 1024));
  // Derive the path from trusted identifiers. Never follow a path stored in mutable metadata.
  const dataPath = artifactDataPath(controllerHome, repoId, artifactId);
  const byteLength = statSync(dataPath).size;
  const length = Math.min(byteLength, bounded);
  const buffer = Buffer.alloc(length);
  const descriptor = openSync(dataPath, 'r');
  try { readSync(descriptor, buffer, 0, length, 0); } finally { closeSync(descriptor); }
  if (byteLength <= bounded) {
    return { artifact: { ...artifact, path: dataPath, byteLength }, content: JSON.parse(buffer.toString('utf8')), truncated: false };
  }
  return {
    artifact: { ...artifact, path: dataPath, byteLength },
    content: {
      preview: buffer.toString('utf8'),
      byteLength,
      message: 'Artifact content is larger than the requested bound. Request a larger bounded window if needed.',
    },
    truncated: true,
  };
}

export function boundExecutionResult(
  controllerHome: string,
  job: ExecutionJob,
  result: Record<string, unknown>,
  kind: ExecutionArtifactRecord['kind'] = 'job-result',
): { result: Record<string, unknown>; artifact?: ExecutionArtifactRecord } {
  const configured = typeof job.payload.maxOutputBytes === 'number' ? job.payload.maxOutputBytes : 512 * 1024;
  const maxBytes = Math.max(16 * 1024, Math.min(configured, 2 * 1024 * 1024));
  const serialized = JSON.stringify(result);
  const bytes = Buffer.byteLength(serialized);

  if (kind === 'job-error') {
    const artifact = writeExecutionArtifact(controllerHome, job, kind, result);
    return {
      artifact,
      result: {
        externalized: true,
        byteLength: bytes,
        artifactId: artifact.artifactId,
        artifactKind: artifact.kind,
        detailPointer: {
          tool: 'get_artifact',
          repoId: job.repoId,
          artifactId: artifact.artifactId,
          maxBytes,
        },
        next: `Call get_artifact with repo_id=${job.repoId} and artifact_id=${artifact.artifactId}.`,
      },
    };
  }

  if (bytes <= maxBytes) return { result };
  const artifact = writeExecutionArtifact(controllerHome, job, kind, result);
  return {
    artifact,
    result: {
      truncated: true,
      byteLength: bytes,
      artifactId: artifact.artifactId,
      artifactKind: artifact.kind,
      preview: serialized.slice(0, Math.min(16 * 1024, serialized.length)),
      next: `Call get_artifact with repo_id=${job.repoId} and artifact_id=${artifact.artifactId}.`,
    },
  };
}

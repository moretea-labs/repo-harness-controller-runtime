import { dirname, isAbsolute, relative, resolve } from "path";

export interface PathSafetyResult {
  readonly ok: boolean;
  readonly path?: string;
  readonly error?: string;
}

export function ensureRepoRelativePath(path: string): PathSafetyResult {
  if (!path || path.trim() === "") {
    return { ok: false, error: "path is required" };
  }
  if (path.includes("\0")) {
    return { ok: false, error: "path contains NUL byte" };
  }
  if (isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path)) {
    return { ok: false, error: `absolute paths are not allowed: ${path}` };
  }
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (segments.includes("..")) {
    return { ok: false, error: `path traversal is not allowed: ${path}` };
  }
  if (normalized === "." || normalized.startsWith("./")) {
    return { ok: false, error: `path must be repo-relative without ./ prefix: ${path}` };
  }
  return { ok: true, path: normalized };
}

export function resolveInsideRepo(repoRoot: string, path: string): PathSafetyResult {
  const relativePath = ensureRepoRelativePath(path);
  if (!relativePath.ok || !relativePath.path) return relativePath;

  const root = resolve(repoRoot);
  const target = resolve(root, relativePath.path);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, error: `resolved path escapes repo root: ${path}` };
  }
  return { ok: true, path: target };
}

export function resolveParentInsideRepo(repoRoot: string, path: string): PathSafetyResult {
  const target = resolveInsideRepo(repoRoot, path);
  if (!target.ok || !target.path) return target;
  return { ok: true, path: dirname(target.path) };
}

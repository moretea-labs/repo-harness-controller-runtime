import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('interactive sync routing policy', () => {
  test('router marks interactive write tools as sync-by-default and supports wait', () => {
    const source = readFileSync(join(import.meta.dir, '../../src/runtime/gateway/mcp/router.ts'), 'utf8');
    expect(source).toContain('INTERACTIVE_SYNC_WRITE_TOOLS');
    expect(source).toContain('repository_safe_patch_apply');
    expect(source).toContain('begin_edit_session');
    expect(source).toContain('apply_patch');
    expect(source).toContain('wantsAsyncExecution');
    expect(source).toContain('waitForExecutionJob');
    expect(source).toContain('buildJobOperationDigest');
    expect(source).toContain('buildAcceptedQueuedDigest');
  });

  test('core toolset exposes interactive development tools', () => {
    const source = readFileSync(join(import.meta.dir, '../../src/cli/mcp/toolset.ts'), 'utf8');
    expect(source).toContain('repository_safe_patch_apply');
    expect(source).toContain('repository_git_create_branch');
    expect(source).toContain('work_wait');
    expect(source).toContain('git_commit_paths');
  });
});

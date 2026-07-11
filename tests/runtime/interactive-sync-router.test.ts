import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { STABLE_CONTROLLER_TOOL_NAMES } from '../../src/cli/mcp/toolset-names';

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

  test('stable controller surface exposes interactive development tools', () => {
    expect(STABLE_CONTROLLER_TOOL_NAMES).toContain('repository_safe_patch_apply');
    expect(STABLE_CONTROLLER_TOOL_NAMES).toContain('repository_git_create_branch');
    expect(STABLE_CONTROLLER_TOOL_NAMES).toContain('work_wait');
    expect(STABLE_CONTROLLER_TOOL_NAMES).toContain('git_commit_paths');
  });
});

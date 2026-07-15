import { describe, expect, test } from 'bun:test';
import type { McpToolDefinition } from '../../src/cli/mcp/tools';
import {
  classifyRepositoryCommand,
  classifyRepositoryCommandReplay,
} from '../../src/cli/repositories/command-classifier';
import { operationMetadataForTool } from '../../src/runtime/gateway/mcp/router';

const commandDefinition = {
  name: 'repository_command_execute',
  description: 'execute command',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: false, destructiveHint: false },
} as McpToolDefinition;

const writeClaims = [{ resourceKey: 'workspace:checkout-a', mode: 'write' as const }];

describe('repository command replay policy', () => {
  test('keeps validation locking conservative while marking bun test replayable', () => {
    expect(classifyRepositoryCommand(['bun', 'test', 'tests/runtime/example.test.ts']).risk).toBe('workspace_write');
    expect(classifyRepositoryCommandReplay(['bun', 'test', 'tests/runtime/example.test.ts'])).toMatchObject({
      replayable: true,
      idempotent: true,
      retryPolicy: 'idempotent_request',
    });

    const metadata = operationMetadataForTool(
      'repository_command_execute',
      commandDefinition,
      writeClaims,
      60_000,
      { command: ['bun', 'test', 'tests/runtime/example.test.ts'] },
      'main',
    );
    expect(metadata).toMatchObject({
      mode: 'mutating',
      replayable: true,
      idempotent: true,
      retryPolicy: 'idempotent_request',
    });
    expect(metadata.resourceClaims).toEqual(writeClaims);
  });

  test('propagates read-only command semantics even when the tool owns a workspace lease', () => {
    const metadata = operationMetadataForTool(
      'repository_command_execute',
      commandDefinition,
      writeClaims,
      60_000,
      { command: ['git', 'status', '--short'] },
      'main',
    );
    expect(metadata).toMatchObject({
      mode: 'readonly',
      replayable: true,
      idempotent: true,
      retryPolicy: 'safe_retry',
      approvalPolicy: 'none',
    });
  });

  test('keeps repository mutations fail-closed after execution starts', () => {
    expect(classifyRepositoryCommandReplay(['git', 'commit', '-m', 'change'])).toMatchObject({
      replayable: false,
      idempotent: false,
      retryPolicy: 'none',
    });
    const metadata = operationMetadataForTool(
      'repository_command_execute',
      commandDefinition,
      writeClaims,
      60_000,
      { command: ['git', 'commit', '-m', 'change'] },
      'main',
    );
    expect(metadata).toMatchObject({
      mode: 'mutating',
      replayable: false,
      idempotent: false,
      retryPolicy: 'none',
      approvalPolicy: 'request',
    });
  });
});

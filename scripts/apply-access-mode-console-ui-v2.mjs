import './apply-access-mode-console-ui.mjs';
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

writeFileSync('src/cli/mcp/toolset-names.ts', `import { FACADE_TOOLS } from '../../runtime/control-plane/facade/types';

/** Preferred ChatGPT-facing facade tools. Must stay small and stable. */
export const PREFERRED_FACADE_TOOL_NAMES = [...FACADE_TOOLS] as const;

/** Default tools/list for the controller core toolset. */
export const DEFAULT_CONTROLLER_TOOL_NAMES = [
  'rh_status',
  'rh_inbox',
  'rh_context',
  'rh_work',
  'repository_access_get',
  'repository_access_set',
  'repository_list',
  'repository_get',
  'repository_register',
  'repository_latest_source_diagnose',
  'repository_bootstrap_local_project',
] as const;
`);

patch('src/cli/mcp/toolset.ts', [
  [
    'toolset names import',
    "import { FACADE_TOOLS } from '../../runtime/control-plane/facade/types';\nimport type { McpToolset } from './types';",
    "import { DEFAULT_CONTROLLER_TOOL_NAMES, PREFERRED_FACADE_TOOL_NAMES } from './toolset-names';\nexport { DEFAULT_CONTROLLER_TOOL_NAMES, PREFERRED_FACADE_TOOL_NAMES } from './toolset-names';\nimport type { McpToolset } from './types';",
  ],
  [
    'preferred names declaration',
    "/** Preferred ChatGPT-facing facade tools. Must stay small and stable. */\nexport const PREFERRED_FACADE_TOOL_NAMES = [...FACADE_TOOLS] as const;\n\n",
    "",
  ],
  [
    'default names declaration',
    "/**\n * Default tools/list for controller profile (`--toolset core`).\n * Facade entrypoints plus only indispensable repository bootstrap/selection tools.\n */\nexport const DEFAULT_CONTROLLER_TOOL_NAMES = [\n  'rh_status',\n  'rh_inbox',\n  'rh_context',\n  'rh_work',\n  'repository_access_get',\n  'repository_access_set',\n  'repository_list',\n  'repository_get',\n  'repository_register',\n  'repository_latest_source_diagnose',\n  'repository_bootstrap_local_project',\n] as const;\n\n",
    "",
  ],
]);

patch('src/cli/local-bridge/connector-freshness.ts', [
  [
    'connector names import',
    "import { PREFERRED_FACADE_TOOL_NAMES, DEFAULT_CONTROLLER_TOOL_NAMES } from '../mcp/toolset';",
    "import { PREFERRED_FACADE_TOOL_NAMES, DEFAULT_CONTROLLER_TOOL_NAMES } from '../mcp/toolset-names';",
  ],
]);

console.log('toolset initialization cycle removed');

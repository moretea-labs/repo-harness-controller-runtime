from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f'anchor not found in {path}: {old[:100]!r}')
    file.write_text(text.replace(old, new, 1))

replace_once(
    'src/runtime/evidence/event-ledger.ts',
    "  entityType: 'job' | 'plugin' | 'schedule' | 'occurrence' | 'portfolio' | 'campaign' | 'candidate-finding' | 'release' | 'lease' | 'schedule-decision';",
    "  entityType: 'job' | 'plugin' | 'schedule' | 'occurrence' | 'portfolio' | 'campaign' | 'candidate-finding' | 'release' | 'lease' | 'schedule-decision' | 'assistant-action-proposal';",
)

path = Path('src/runtime/safe-tooling/workspace-auth.ts')
text = path.read_text()
old = '''export function prepareWorkspaceAuthLogin(
  controllerHome: string,
  input: WorkspaceAuthLoginInput = {},
): Record<string, unknown> {
  bootstrapManagedRuntimeEnv();
  const service = normalizeService(input.service);'''
new = '''export function prepareWorkspaceAuthLogin(
  controllerHomeOrInput: string | WorkspaceAuthLoginInput = {},
  maybeInput: WorkspaceAuthLoginInput = {},
): Record<string, unknown> {
  bootstrapManagedRuntimeEnv();
  const controllerHome = typeof controllerHomeOrInput === 'string'
    ? controllerHomeOrInput
    : process.env.REPO_HARNESS_CONTROLLER_HOME?.trim() || process.cwd();
  const input = typeof controllerHomeOrInput === 'string' ? maybeInput : controllerHomeOrInput;
  const service = normalizeService(input.service);'''
if old not in text:
    raise SystemExit('workspace auth compatibility anchor not found')
path.write_text(text.replace(old, new, 1))
print('Applied OAuth/History type and compatibility fixes.')

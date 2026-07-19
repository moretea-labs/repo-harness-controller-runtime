from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f'anchor not found in {path}: {old[:120]!r}')
    file.write_text(text.replace(old, new, 1))

replace_once(
    'src/runtime/assistant/standing-grants.ts',
    "  for (const grant of active) {\n    let applied = 0;",
    "  for (const grant of active) {\n    let applied = current.filter((proposal) => proposal.runId === input.runId && proposal.standingGrantId === grant.grantId).length;",
)
replace_once(
    'tests/runtime/assistant-model-standing-grants.test.ts',
    "    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not-json' } }] }), { status: 200 })) as typeof fetch;",
    "    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not-json' } }] }), { status: 200 })) as unknown as typeof fetch;",
)
print('Fixed Standing Grant per-run accounting and fetch typing.')

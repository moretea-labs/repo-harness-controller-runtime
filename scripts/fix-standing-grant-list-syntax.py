from pathlib import Path

path = Path('src/runtime/assistant/standing-grants.ts')
text = path.read_text()
old = """  return {
    grants
      .filter((grant) => !input.status || grant.status === input.status)"""
new = """  return {
    grants: grants
      .filter((grant) => !input.status || grant.status === input.status)"""
if old not in text:
    raise SystemExit('standing grant list syntax anchor not found')
path.write_text(text.replace(old, new, 1))
print('Corrected derived Standing Grant list property syntax.')

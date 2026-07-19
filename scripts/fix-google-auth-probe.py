from pathlib import Path

shared = Path('src/runtime/plugins/google-shared.ts')
text = shared.read_text()
old = '''      provider: 'google-workspace',
      ready: probed,
      authenticated: true,'''
new = '''      provider: 'google-workspace',
      ready: true,
      authenticated: true,'''
if old not in text:
    raise SystemExit('Google auth probe readiness anchor not found')
shared.write_text(text.replace(old, new, 1))

test = Path('tests/runtime/gmail-assistant-routines.test.ts')
text = test.read_text()
old = '''    const result = await googleApiRequest<{ labels: Array<{ id: string }> }>({'''
new = '''    const configured: GmailPluginConfig = { schemaVersion: 1, enabled: true, provider: 'google-workspace' };
    const beforeProbe = resolveGoogleAuth('gmail', configured);
    expect(beforeProbe.ready).toBe(true);
    expect(beforeProbe.probed).toBe(false);

    const result = await googleApiRequest<{ labels: Array<{ id: string }> }>({'''
if old not in text:
    raise SystemExit('Google auth test anchor not found')
text = text.replace(old, new, 1)
text = text.replace("    const config: GmailPluginConfig = { schemaVersion: 1, enabled: true, provider: 'google-workspace' };\n    const auth = resolveGoogleAuth('gmail', config);", "    const auth = resolveGoogleAuth('gmail', configured);", 1)
test.write_text(text)
print('Fixed first-use Google credential probe semantics.')

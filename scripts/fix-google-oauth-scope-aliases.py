from pathlib import Path

path = Path('src/runtime/safe-tooling/google-oauth-broker.ts')
text = path.read_text()
old = """function validateScopes(service: GoogleOAuthService, scopes: string[]): string[] {
  const normalized = [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))];
  const invalid = normalized.filter((scope) => !ALLOWED_SCOPES[service].has(scope));"""
new = """const OAUTH_SCOPE_ALIASES: Record<string, string> = {
  'gmail.readonly': 'https://www.googleapis.com/auth/gmail.readonly',
  'gmail.compose': 'https://www.googleapis.com/auth/gmail.compose',
  'gmail.modify': 'https://www.googleapis.com/auth/gmail.modify',
  'gmail.send': 'https://www.googleapis.com/auth/gmail.send',
  'calendar.events.readonly': 'https://www.googleapis.com/auth/calendar',
  'calendar.events.write': 'https://www.googleapis.com/auth/calendar',
  'calendar.events.delete': 'https://www.googleapis.com/auth/calendar',
  'tasks.readonly': 'https://www.googleapis.com/auth/tasks',
  'tasks.write': 'https://www.googleapis.com/auth/tasks',
  'tasks.delete': 'https://www.googleapis.com/auth/tasks',
};

function validateScopes(service: GoogleOAuthService, scopes: string[]): string[] {
  const normalized = [...new Set(scopes.map((scope) => OAUTH_SCOPE_ALIASES[scope.trim()] ?? scope.trim()).filter(Boolean))];
  const invalid = normalized.filter((scope) => !ALLOWED_SCOPES[service].has(scope));"""
if old not in text:
    raise SystemExit('Google OAuth scope validation anchor not found')
path.write_text(text.replace(old, new, 1))
print('Normalized Google OAuth scope aliases in the broker.')

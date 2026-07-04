# Mobile Intent and iPhone Shortcuts Entry Point

repo-harness exposes a narrowly-scoped mobile intent endpoint for local voice/text automation, including iPhone Shortcuts and Siri phrases.

## Server Mode

The normal Controller UI remains loopback-only:

```bash
repo-harness controller ui --repo .
```

To allow a phone on the same trusted LAN to reach only the mobile intent endpoint, bind the server to a wildcard address and explicitly enable the LAN gate:

```bash
repo-harness controller ui --repo . --host 0.0.0.0 --mobile-lan
```

When `--mobile-lan` is enabled, non-loopback requests are still rejected for `/`, `/api/*`, and the visual dashboard. Only `/mobile/intent` may be called from a non-loopback host, and every request must pass device-token authentication plus replay checks.

## Device Enrollment

Create device tokens from the local UI API. The returned token is shown once; repo-harness stores only its SHA-256 hash in `.repo-harness/mobile-intents.json`.

```bash
curl -sS \
  -H "x-repo-harness-local-token: <local-ui-token>" \
  -H "content-type: application/json" \
  -d '{
    "name": "Greyson iPhone",
    "scopes": ["plugins:read", "jobs:read", "plugin:gmail:configure", "plugin:gmail:send_message"]
  }' \
  http://127.0.0.1:8766/api/mobile/devices
```

Device scopes are intentionally explicit:

- `plugins:read` lists plugin status and action schemas.
- `jobs:read` polls a submitted durable Execution Job.
- `plugin:*:*` permits all plugin actions.
- `plugin:<plugin-id>:*` permits all actions for one plugin.
- `plugin:<plugin-id>:<action-id>` permits one action.

Revoke a device immediately when a phone or Shortcut is no longer trusted:

```bash
curl -sS \
  -X POST \
  -H "x-repo-harness-local-token: <local-ui-token>" \
  http://127.0.0.1:8766/api/mobile/devices/<device-id>/revoke
```

## Shortcut Request Contract

Every `/mobile/intent` request must include these headers:

```text
Authorization: Bearer <one-time-returned-device-token>
x-repo-harness-device-id: <device-id>
x-repo-harness-timestamp: <ISO-8601 timestamp>
x-repo-harness-nonce: <unique random nonce, 8-128 safe characters>
x-repo-harness-signature: <optional HMAC-SHA256>
```

The timestamp must be within five minutes of the Controller clock. Each nonce may be used once within the ten-minute nonce window. The optional signature is computed over:

```text
<timestamp>.<nonce>.<raw-json-body>
```

using the device token as the HMAC key. Hex, base64url, and `sha256=<hex>` signatures are accepted. If the signature header is present, it must match the raw body or the request is rejected.

## Intent Bodies

List plugins:

```json
{ "intent": "list_plugins" }
```

Submit a plugin action:

```json
{
  "intent": "plugin_action",
  "pluginId": "gmail",
  "actionId": "configure",
  "requestId": "shortcut-gmail-config-1",
  "confirmAuthorization": true,
  "arguments": {
    "enabled": true,
    "provider": "mock",
    "account_email": "assistant@example.com"
  }
}
```

Poll a durable Execution Job:

```json
{ "intent": "poll_job", "jobId": "JOB-..." }
```

Write actions still follow the plugin confirmation policy. If a Shortcut calls a strong-confirmation action without confirmation, the endpoint returns `409` with `approvalRequired: true`, the action risk, and the required confirmation text.

## iPhone Shortcuts Shape

A Shortcut should:

1. Dictate or receive text.
2. Build the JSON body for one allowed plugin action.
3. Generate a timestamp and random nonce.
4. Optionally compute HMAC-SHA256 over `<timestamp>.<nonce>.<raw-json-body>`.
5. POST to `http://<mac-lan-ip>:8766/mobile/intent`.
6. Speak the `approvalRequired` message or store the returned `job.jobId` for polling.

Tokens are scoped per device and can be revoked without changing the Local Controller token.

# App Store Connect API Plugin

repo-harness exposes App Store Connect as a native official-API plugin instead of relying on interactive web automation for Apple Developer portal tasks.

## Design boundary

Use this plugin for structured App Store Connect operations that Apple exposes through the official API:

- Read apps, app metadata records, App Store versions, builds, and TestFlight beta groups.
- Preview App Info Localization metadata changes before applying them.
- Patch App Info Localization fields such as `name`, `subtitle`, `privacyPolicyUrl`, and `privacyPolicyText` after explicit authorization.

Do not use this plugin to store Apple secrets or to emulate a browser login. If a workflow is not covered by the official API, it should fall back to a separately controlled browser capability with domain allowlists and human approval.

## Plugin ID

```text
app_store_connect
```

## Configuration

Non-secret defaults are stored in:

```text
.repo-harness/plugins/app-store-connect.json
```

Example action arguments for `configure`:

```json
{
  "enabled": true,
  "provider": "app-store-connect-api",
  "issuer_id": "00000000-0000-0000-0000-000000000000",
  "key_id": "ABC123DEFG",
  "private_key_path": "/Users/example/.secrets/appstoreconnect/AuthKey_ABC123DEFG.p8",
  "default_app_id": "1234567890",
  "default_locale": "zh-Hans"
}
```

The API private key content is never persisted by repo-harness. The recommended persistent setup is to store only the local `.p8` file path with `private_key_path`; the file content remains on disk and is read only at runtime. You can also override credentials with environment variables:

```bash
export REPO_HARNESS_ASC_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----'
export REPO_HARNESS_ASC_PRIVATE_KEY_PATH="$HOME/.config/repo-harness/AuthKey_ABC123DEFG.p8"
```

`REPO_HARNESS_ASC_ISSUER_ID`, `REPO_HARNESS_ASC_KEY_ID`, and `REPO_HARNESS_ASC_PRIVATE_KEY_PATH` can override configured identity/path fields. Do not commit `.p8` files or inline private key content.

## Actions

Read-only actions:

- `auth_status`
- `list_apps`
- `list_app_store_versions`
- `get_app_info`
- `list_builds`
- `list_beta_groups`
- `preview_app_info_localization_update`

Remote-write action:

- `update_app_info_localization`

`update_app_info_localization` requires normal plugin authorization. Use `dry_run: true` first to return the exact PATCH path and JSON body without sending it.

Example dry run:

```json
{
  "localization_id": "app-info-localization-id",
  "name": "药准时",
  "subtitle": "用药提醒与记录",
  "dry_run": true
}
```

The resulting request is shaped as:

```json
{
  "method": "PATCH",
  "path": "/v1/appInfoLocalizations/app-info-localization-id",
  "body": {
    "data": {
      "type": "appInfoLocalizations",
      "id": "app-info-localization-id",
      "attributes": {
        "name": "药准时",
        "subtitle": "用药提醒与记录"
      }
    }
  }
}
```

## Safety model

- JWTs are generated in memory for each request using ES256.
- Private keys are read from environment or a local path and are not written into plugin config or manifests.
- Manifests only report whether issuer/key identity is configured, not the values themselves.
- Remote writes are blocked from automated schedule/reconciliation origins by the generic plugin store policy.
- Metadata writes support dry-run output before the authorized remote mutation.

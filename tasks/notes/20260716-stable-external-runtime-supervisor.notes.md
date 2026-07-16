# Stable External Runtime Supervisor — implementation notes

## Decisions

- The Supervisor is a lifecycle owner, not a replacement source of truth. It projects `active-slot.json` and `runtime-generation.json`, and keeps the existing restart coordinator readable as a compatibility projection.
- The Supervisor starts immutable release bundles. Child process identity includes PID, start time, executable fingerprint, Controller Home, slot/generation metadata, instance ID, and owner epoch. Uncertain identity fails closed.
- Accepted operations are written to `supervisor/operations/` before child shutdown. The loopback Rescue MCP and normal `rh_status`/`rh_work` facade return the operation ID and `stable_domain_retry` reconnect contract.
- A Controller Home with an installed stable release must not let Gateway/MCP hot paths spawn a competing Daemon. Homes without a release retain the existing lifecycle as fallback.
- Empty public-endpoint configuration means `--tunnel none`; stable Supervisor startup never opportunistically creates a quick tunnel.
- Blue/green candidate Homes receive the stable release before the existing slot verification/cutover flow runs. Active-slot authority and runtime-generation authority remain canonical.

## Verification evidence

- Targeted Supervisor contract and Rescue MCP tests pass.
- TypeScript checking passes.
- Temporary real-machine smoke proved stable release process paths, authenticated fixed Rescue MCP tools, operation completion, Gateway recovery, Daemon recovery, and clean shutdown.

## Open delivery checks

- Full repository gates and architecture/task sync must pass before merge.
- Run independent code review on the feature diff and resolve actionable findings.

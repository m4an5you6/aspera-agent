---
kind: upgrade-guide
description: "Aspera preparation commands share a download deadline and retain supervised exits, complete logs and reusable uv materials across SSH interruptions."
---

# Aspera preparation command recovery

English | [中文](guide.zh.md)

## Change

The preparation Host supervises commands independently of SSH when Python is available. Commands and download retries share `toolTimeoutMs`, capped by the remaining installation round. Reconnection reads the original command; confirmed timeouts return diagnostic results to the same Agent instead of requiring another installation. Missing exit evidence still blocks mutations. Shell-only Python bootstrap uses the system `timeout` utility and direct log files.

`prepare_preparation_tool` prepares the release's exact uv with verified executable, wheel and partial-download reuse. It returns paths for program revalidation. Existing training environments and fixed releases are preserved. Independent version-1 preparation and material records retain identities and logs; submission protocol 4, local fleet 6 and Session formats stay unchanged.

## Migration

1. Update Host resources and generated types together. Keep the original EXE, experiment ID, preparation Session, release and command directory. A preparation retry reconciles the saved command before permitting another mutation; never delete its pending record to bypass an uncertain exit.
2. Review `preparationCommandReadTimeoutMs`, `preparationCommandRecoveryTimeoutMs` and `preparationCommandStopGraceMs`, defaulting to 30000, 60000 and 5000 milliseconds. Polling uses `pollIntervalMs` with a 10000-millisecond cap. Downloads must honor `ASPERA_PREPARATION_REMAINING_MS` and `ASPERA_PREPARATION_DEADLINE_MS`, including every internal retry.
3. Use `prepare_preparation_tool` for uv before custom downloads. Preserve its server cache, including incomplete material. Pass returned directories to `verify_preparation_environment`; installation text or a successful download does not establish readiness. See [preparation command recovery](../../../../extensions/aspera/packages/dispatch/README.md#preparation-command-recovery).

---
kind: upgrade-guide
description: "Aspera checks GPU identity and controller authorization before reuse and supports preparation-owned idle controller repair."
---

# Aspera controller readiness

English | [中文](guide.zh.md)

## Change

Preparation compares actual GPU UUIDs and character devices with the controller's startup authorization. A healthy control endpoint alone does not establish compatibility. The selected preparation Agent receives concrete differences and can call `repair_preparation_controller`; successful program verification remains required before handover. New node controllers check GPU identity again when allocating an experiment.

Authenticated health responses advertise `controller-readiness-v1` and `controller-maintenance-v1`. Maintenance atomically refuses occupied controllers and fences new admission before an identity-bound stop. `controllerRepairMaxAttempts` defaults to two attempts per experiment, server and role. Independent version-1 repair receipts preserve the limit, attempts and ambiguous outcomes; identical or recovered operations do not reset the count. Local fleet storage remains generation 6, submissions protocol 4, and Session formats unchanged.

Local password SSH transport reconnects after transient failures before authentication within one operation deadline. Dispatch exposes the [handshake limits](../../../../extensions/aspera/packages/dispatch/README.md#use-this-package); existing preparations use the current local limits while preserving their original installation and release records. Authentication, host-key and authenticated-operation failures never trigger replay. The connection-check deadline remains 20 seconds.

Preparation uses the execution sandbox's namespaces and full confinement for acceptance. Containers that allow a basic bubblewrap probe but refuse `/proc` mounting after `--unshare-user` fail before handover. The original preparation Session receives the exact command output and required platform action; account repairs require program revalidation. Isolation and device grants are retained.

## Migration

1. Update application resources, generated types and custom `FleetDriver` consumers together; providers implement `inspectController`. Existing application executables can use the matching resource update.
2. Keep each experiment's original release and submission. Legacy controllers can be inspected through selected, credential-free process settings. Reuse requires recorded startup GPU identity, matching current devices and the original release. A legacy controller that needs a restart but lacks safe maintenance support requires confirmed task release and an operator stop; preparation never replaces its sealed release.
3. Inspect any interrupted repair before retrying. A confirmed stop receipt or identity-matched replacement allows recovery; missing exit evidence blocks another stop or launch. Repair counts persist across retries.
4. Copy an already submitted experiment if its GPU identity or device requirements changed. Its fixed plan and submission are not rewritten, and execution is not automatically rerun. See [controller readiness and recovery](../../../../extensions/aspera/docs/state-and-api.md#controller-readiness).
5. Resolve namespace or `/proc` permission refusals through compatible account configuration or the cloud platform, then retry preparation. Keep the required isolation flags. Already submitted experiments retain their original release; after confirmed resource release, copy one to use updated execution resources.

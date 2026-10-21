---
kind: upgrade-guide
description: "Aspera checks GPU identity and controller authorization before reuse and supports preparation-owned idle controller repair."
---

# Aspera controller readiness

English | [中文](guide.zh.md)

## Change

Preparation compares actual GPU UUIDs and character devices with the controller's startup authorization. A healthy control endpoint alone does not establish compatibility. The selected preparation Agent receives concrete differences and can call `repair_preparation_controller`; successful program verification remains required before handover. New node controllers check GPU identity again when allocating an experiment.

Authenticated health responses advertise `controller-readiness-v1` and `controller-maintenance-v1`. Maintenance atomically refuses occupied controllers and fences new admission before an identity-bound stop. An exited controller uses SSH release evidence and counterpart maintenance; a closed control port does not require cloud-policy changes. Controllers use release-specific profiles in their original homes, retaining old bindings, tasks and Sessions. `controllerRepairMaxAttempts` defaults to two attempts per experiment, server and role. Independent version-2 repair receipts preserve version-1 history, limits and ambiguous outcomes; identical or recovered operations do not reset counts. Local fleet storage remains generation 6, submissions protocol 4, and Session formats unchanged.

Password SSH reconnects after transient pre-authentication failures within one deadline. Existing preparations use current [handshake limits](../../../../extensions/aspera/packages/dispatch/README.md#use-this-package), retaining original installation and release records. Authentication, host-key and authenticated-operation failures never trigger replay. Connection checks remain limited to 20 seconds.

Preparation verifies the execution sandbox's full isolation, including dropping all capabilities. A refused `/proc` mount after `--unshare-user` receives a measured compatibility diagnosis. When feasible, the preparation Agent calls `repair_preparation_sandbox` to install an immutable private-PID/proc launcher, then requests program revalidation. Executable-path fields retain its location; version-1 descriptors and receipts retain identity and recovery evidence. Host policy stays unchanged. [Sandbox compatibility repair](../../../../extensions/aspera/packages/dispatch/README.md#sandbox-compatibility-repair) owns limits, unresolved outcomes and controller coexistence.

Recovery checks old tasks before startup and closes only confirmed exits. See [controlled interruption migration](../aspera-experiment-interruption/guide.md) for task outcomes, node scope, pending tasks and Remote consumers.

## Migration

1. Update resources, generated types and custom `FleetDriver` consumers together; providers implement `inspectController`. Existing executables support matching resource updates. Configure [local running records](../../../../extensions/aspera/docs/state-and-api.md#local-running-records) without rewriting experiments.
2. Keep original releases and submissions. Legacy inspection reads selected, credential-free startup settings. Reuse requires matching startup GPU identity, current devices and release. Missing safe maintenance requires confirmed release and an operator stop; preparation retains sealed releases.
3. Inspect any interrupted repair before retrying. A confirmed stop receipt or identity-matched replacement allows recovery; missing exit evidence blocks another stop or launch. Repair counts persist across retries.
4. For an offline endpoint or old profile binding, retry preparation in its original Session. Call `repair_preparation_controller`, then `verify_preparation_environment`; retain old profiles and receipts. Unconfirmed release remains blocked. Submitted experiments with changed GPU requirements need copying; plans, submissions and execution stay fixed. See [controller readiness and recovery](../../../../extensions/aspera/docs/state-and-api.md#controller-readiness).
5. Retry failed preparation in its original Session for sandbox diagnosis and repair. Preserve every isolation flag and fully revalidate the launcher. If a compatible private PID/proc parent is unavailable, request specific cloud-platform permissions. To update submitted experiments' execution resources, confirm release and copy the experiment.

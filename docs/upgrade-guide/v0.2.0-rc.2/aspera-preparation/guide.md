---
kind: upgrade-guide
description: "Aspera automatically configures selected SSH accounts and writes local fleet storage generation 5."
---

# Aspera environment preparation

English | [中文](guide.zh.md)

## Change

The local preparation Agent can install and configure Node, pinned pnpm, Python 3, bubblewrap and required user-space dependencies using the selected SSH account's existing permissions. The dispatch configuration removes `allowedSystemPackages`; `preparationOutputChars` limits each command's model-visible stdout and stderr. Sandbox and GPU verification still gate remote handover.

The local fleet store writes generation 5 and reads generations 1–4. Remote submissions remain protocol 4. Server probes can report a connected account with an incomplete environment; their `inventory` field is optional. Matching generated Remote consumers must handle this result.

Large managed Python helpers use fixed short SSH entries and complete UTF-8 input packets. Custom `PreparationStorageTransport.run` and `EnvironmentStorageOwner.ssh` implementations must forward the optional input argument; success output, exit/cancellation semantics and original operation identities remain unchanged. Preparation assessment, offline inspection, storage registration and reference release share this path; command-channel failure never authorizes automatic replay.

## Migration

Controller reuse requires the experiment's exact fixed release. Matching features cannot substitute another implementation; preparation requests controlled idle repair without rewriting the original release.

1. Keep existing application and remote release directories while experiments use them. Remove `allowedSystemPackages` from custom `@aspera/dispatch` configuration and deploy the matching application, generated Remotes and dependency lockfile.
2. Use an SSH account whose existing permissions cover the intended environment preparation. Inspect the preparation records for executed commands, diagnostics and verification results. Host-kernel or GPU-device restrictions require the reported platform action.
3. Retry failed generation-4 preparations to retain their experiment, Session, models and directories. The original remote release must still have its matching manifest and required entrypoints. Known releases whose application and DSH manifests both omit `engines` use their recorded version requirements. If the release is unavailable or its requirements are unknown, copy the experiment; retries do not substitute the current build.
4. Inspect any preparation command reported as having an unknown outcome before retrying. A saved remote exit record allows verification to resume without repeating that command.
5. Confirm environment verification and remote handover in the experiment details. See the [dispatch reference](../../../../extensions/aspera/packages/dispatch/README.md).
6. Update matching desktop resources while retaining the original executable. The embedded deployment archive is verified against installed extension files and no longer depends on the user's pnpm metadata cache. Source builds fetch missing pinned metadata. Retry a local snapshot failure in place only when the retained preparation journal confirms that no release or remote placement was captured; captured releases still require their original material. Package-manager failures written only to stdout now retain their diagnostic text.

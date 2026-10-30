---
kind: upgrade-guide
description: "Aspera public inference checks run from the local Host with private credentials and durable one-time requests."
---

# Aspera public inference verification

English | [中文](guide.zh.md)

## Change

Execution Agents use `verify_inference_service` after registering a healthy published service. The local Host verifies the saved public mapping with a fixed harmless prompt; node routing failures do not replace Host observations. Credentials stay outside Agent inputs and logs. Completion requires real service identity, authentication, model-list and generation checks.

The gateway preserves validated fixed request lengths and unknown-length streaming, enforcing declared and actual body limits.

Host `publicServiceVerificationRoute` defaults to `direct`: a request-owned dispatcher preserves global proxy settings. `inherit` follows existing HTTP proxy policy. TLS and Bearer checks remain mandatory. Transport failures retain bounded cause codes; route changes never replay saved or uncertain generations.

Persistence acknowledgement: independent version-1 `ServiceVerification` records bind the original request, service command, model, release, deadline and Host claim. Both remote records and the local committed-result copy survive reconnects. A lost generation response remains unknown; recovery does not replay it. Records join archiving and experiment cleanup. No Session, protocol-4 or fleet-6 migration is required.

Private execution outcomes also save admitted server/service pairs for serving recovery. Monitors ignore prior failed attempts, retain failures of admitted services and keep allocation when admission cannot be confirmed. Older pinned releases remain unchanged.

## Migration

The inference page exposes explicit key retrieval and defaults to PowerShell (`ConvertTo-Json`, `Invoke-RestMethod`), with cURL available. Replace `YOUR_API_KEY` or choose Copy command with key; ordinary copying preserves the placeholder. Call the model generates; Service health check probes the gateway. Manage confirms stops; released attempts enter history. Both service entries deduplicate original/recovery aliases, preserving observation times. No remote or record migration is needed.

Explicit key retrieval remains available after status-read failure and preserves connection errors. Desktop copying requires owned-frame clipboard permission. Fully quit Aspera, then apply the [desktop script update](../../../../extensions/aspera/apps/desktop/README.md#build-and-verify); retain the executable and runtime archive. Clipboard reads and other frames remain denied.

The execution Agent also receives `stop_inference_service`. It confirms `released=true` before starting corrected code with a new service ID. Stops retain checkpoints and logs; repeating an old start never restarts that service. This uses existing protocol-4 service records. Desktop updates leave running Agents pinned to their original tools.

For separate inference recovery, `inspect_inference_checkpoints` and `prepare_inference_checkpoint` create read-only hardlink snapshots from released, sealed native adapters. Independent version-1 `InferenceCheckpointSnapshot` records bind source identities, hashes and publication recovery; archiving/deletion preserve original results, Session and fleet generations.

1. Use a release declaring `asperaServiceVerificationVersion: 1`, `asperaServiceLifecycleVersion: 1`, `asperaInferenceCheckpointVersion: 1` and their capabilities `public-inference-verification-v1`, `inference-service-lifecycle-v1`, `inference-checkpoint-snapshots-v1`; preparation checks controller compatibility before reuse.
2. Update all tool and record consumers, keeping public service credentials private. Existing service APIs retain their return types.
3. Preserve old releases and results. Confirm resource release before copying an experiment to use the new tools. See [public inference verification](../../../../extensions/aspera/docs/public-inference.md) for waiting, records and recovery.

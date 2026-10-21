---
kind: upgrade-guide
description: "Aspera DeepSeek phase snapshots use reusable plugin inputs and preserve earlier resolved snapshots during recovery."
---

# Aspera DeepSeek model snapshots

English | [中文](guide.zh.md)

## Change

DeepSeek phase preparation could fail before creating its Agent with `retryPolicy: unknown key "initialDelayMs"`. Admission saved the provider's resolved settings, but phase startup supplied those settings as plugin configuration. Resolved retry delays are flat; plugin inputs require `retryPolicy.backoff`. Resolved thinking and file policies also use different field names.

Admission now saves reusable plugin inputs with explicit defaults. Startup verifies the original receipt hash before converting earlier resolved snapshots in memory. It preserves configuration bytes, hashes, credential references, selected models and Sessions. Mixed or invalid settings remain errors. Private snapshot version `1`, fleet domain `6`, submission protocol `4` and Session formats stay unchanged. [State and API documentation](../../../../extensions/aspera/docs/state-and-api.md#persistent-ownership) owns compatibility details.

## Migration

1. Update desktop runtime resources and fully quit and reopen Aspera. Keep the existing EXE and credential store. Do not edit saved snapshot JSON or recompute its hash.
2. Retry preparation for experiments that failed before release capture or remote handover. Startup reads their original snapshots through the compatibility conversion.
3. Preserve already fixed remote releases. A local update does not add the compatibility reader to an existing sealed release. If that release cannot start its saved model, confirm old task release and copy the experiment onto the updated runtime.
4. Run `pnpm run test:desktop:deepseek` from `extensions/aspera` with the unpacked desktop available. Both new and retained profiles must complete a standard Agent replay and preparation, planning and execution replays using captured and legacy snapshots through the original EXE and a local Messages fixture.

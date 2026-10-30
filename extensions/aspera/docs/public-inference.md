# Public inference verification

English | [中文](public-inference.zh.md)

## Agent and program responsibilities

The execution Agent registers its own loopback service with `start_inference_service(publish=true)` and the saved node mapping. After local health becomes healthy, it calls `verify_inference_service` with `server_id` and JSON containing `operationId`, `serviceId` and `maxTokens` (1–256). The tool waits internally for program verification; it does not expose credentials or create another Agent.

The local Host checks the registered public URL because a node may be unable to reach its own platform mapping. It verifies a fresh service/experiment nonce, rejection of absent and invalid credentials, the registered model listing and an actual response to a fixed harmless test prompt. It sends no experiment Goal, chat history or arbitrary Agent prompt. Redirects are refused and response sizes use configured limits. The Agent reads these observations and decides its next action. Local health and Agent-written reports alone cannot establish public access.

Host profile setting `publicServiceVerificationRoute` defaults to `direct`: verification owns a dispatcher for the registered URL and leaves the process-wide proxy unchanged. Choose `inherit` when these checks must use the existing HTTP proxy policy. Both modes keep TLS verification, credential handling and redirect refusal. Results record the route and bounded transport error codes, without proxy credentials. A route change does not replay a saved or uncertain generation request.

<a id="use-the-inference-page"></a>
## Use the inference page

Experiment details and the sidebar share one service view. Select an active service to read its address, registered model API name and independent process/public observations. Process times are state updates; external checks keep their own recorded times. A failed read retains saved content and cannot establish current health. Released attempts stay in collapsed history, including failed starts; an unreleased abnormal service remains current.

Call the model provides an OpenAI-compatible `POST /v1/chat/completions` template with the registered model and a short message. Service health check uses the authenticated gateway's `GET /_aspera/health` without generation. PowerShell is selected by default: assign the key directly, serialize the request with `ConvertTo-Json` and send UTF-8 bytes through `Invoke-RestMethod`. Windows PowerShell 5.1 uses `Invoke-WebRequest` and decodes response bytes as UTF-8 before parsing JSON, including responses without a charset. cURL remains available for Bash. Replace `YOUR_API_KEY`, or select Copy command with key to retrieve the current credential and copy a runnable command. Missing public mapping or model identity disables the corresponding example rather than inventing values. Viewing, switching or copying examples sends no model request and does not establish generation acceptance.

Show or Copy on API Key explicitly retrieves that service's calling credential. An unconfirmed status still permits this request; the interface checks service identity again, and obtaining a key does not clear the status error. Released, stopping or unpublished services cannot retrieve a key. Displayed templates, ordinary snapshots and non-secret form state never contain it. Copy command with key puts the credential only in the requested clipboard text; switching the service, example or page discards pending copy replies. Service/page changes clear revealed keys. Request test instead uses the Aspera connection and defaults to the registered backend health path. Its GET/POST inputs and results remain separate for each service. A successful managed request does not prove external reachability.

Manage → Stop service explains the calling impact before submitting the existing stop operation. The page retains current membership until resource release is confirmed; a lost reply stays unconfirmed. Model files, results and logs are retained. Service actions always address the actual owning experiment, including recovery tasks shown under an original experiment.

## Service replacement

The execution Agent calls `stop_inference_service` with the assigned `server_id` and original `service_id` when its backend needs correction. The authenticated node checks experiment ownership, closes that service's public gateway, stops its owned process and checks cleanup. A successful stop preserves model files, checkpoints, environment and logs. The Agent waits for `released=true`, then starts its corrected command with a new service ID and repeats local health and public verification. The original service ID remains bound to its original command; repeating start does not restart a stopped record. An unconfirmed exit or lost reply requires inspecting or repeating the original stop, without launching a replacement or signalling a PID from an ordinary command.

## Retained checkpoint recovery

A separate inference task can use a retained adapter without reactivating its source experiment. The Agent calls `inspect_inference_checkpoints` with an assigned server and original experiment ID, selects the required native step, then calls `prepare_inference_checkpoint` with the returned checkpoint ID and a persistent operation ID. The node requires a released source allocation, commands and services, an existing checkpoint seal, stable directory ownership and unchanged file/mount identities. Hashing runs outside the node mutation lock; publication rechecks those observations.

The snapshot contains only `adapter_config.json`, `adapter_model.safetensors` and `trainer_state.json`. It creates same-volume hardlinks without modifying the source or downloading weights; cross-volume requests fail explicitly. The program mounts the snapshot read-only in commands and registered services. Load the returned `adapterPath` in the backend command; register the workspace-relative `snapshot.destination` as `model_path`. Optimizer/scheduler files are excluded. This is an inference snapshot, not evidence of new training. Original results and releases remain unchanged. The Agent chooses and runs inference, then requests the same independent public checks.

An interrupted publication blocks writable commands and service starts. Repeat the exact operation ID to recover its saved request; another operation cannot bypass it. A completed snapshot keeps its own file links if the original aliases are later removed. Removing this experiment deletes only its aliases and records. A changed snapshot remains blocked rather than silently refreshing its identity.

Known valid Content-Length headers are preserved when forwarding request bodies, so a backend can read a fixed-length upload without a chunked decoder. Unknown-length uploads remain streaming. Declared and measured byte limits are both enforced; the public Bearer key is never forwarded upstream.

## Waiting and recovery

The node saves an independent version-1 request before the Host claims it. Request identity, service command, fixed release, model name, URL and original deadline remain fixed. The Host saves its bounded result before committing it remotely. A repeated request returns the original result; a claimed generation is never automatically sent again. Reopening the Host can recommit its saved result without another generation. Lost responses without recoverable evidence remain unknown. Polling uses existing finalization limits; the service request timeout supplies the original deadline.

Successful Host observations retain their original check time and remain distinct from node-to-public routing failures. Current process identity, local health and allocation release still apply. Completion requires the program-owned authentication and generation receipt for each active published service. Interruption and deletion stop the service through existing release controls; deletion waits for local verification before removing its copy.

At successful completion, the execution outcome saves the exact server/service pairs admitted for serving. Monitoring and restart recovery follow those identities, so released startup failures remain history rather than terminating a healthy replacement. An admitted service failure or missing identity still fails monitoring. A missing admission retains allocation without guessing or restarting services.

## Records and compatibility

Persistence acknowledgement: `ServiceVerification` is an independent version-1 record under each remote run's `service-verifications-v1` and the local `$DSH_HOME/aspera-service-verifications/<experimentId>`. Credentials are absent from saved results and Session events. Node records join offline archiving and experiment cleanup. Protocol 4, fleet generation 6, Session data and old submissions remain unchanged.

`asperaServiceVerificationVersion: 1` requires `public-inference-verification-v1` during preparation and controller reuse. Old experiments retain their release; confirm release before copying to the new implementation. The original executable can use updated desktop resources.

`asperaServiceLifecycleVersion: 1` requires `inference-service-lifecycle-v1` before controller reuse. These tools use the existing protocol-4 service stop operation and existing service records; no new persistent generation is introduced. A running Agent keeps its pinned tool definitions when desktop resources change.

Snapshot persistence acknowledgement: independent version-1 `InferenceCheckpointSnapshot` records live under each run's `inference-checkpoints-v1`. They bind the unchanged operation request, source experiment/command/native step, file hashes and identities, destination, publication state and original time. Records join offline archiving and experiment deletion. `asperaInferenceCheckpointVersion: 1` requires `inference-checkpoint-snapshots-v1`; old fixed releases do not acquire these tools through a desktop update. No Session or fleet storage generation changes.

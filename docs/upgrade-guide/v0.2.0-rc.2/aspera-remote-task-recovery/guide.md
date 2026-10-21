---
kind: upgrade-guide
description: "Aspera retains remote task recovery identities after local experiment deletion and unifies exit verification."
---

# Recover remote tasks after deleting local experiments

English | [中文](guide.zh.md)

## Change

Local experiment deletion retains a private remote-task identity until every original node confirms release. Server cards show deleted tasks awaiting release and offer verification or explicit interruption. Verification does not stop active work. Interruption preserves existing environments, models, data and logs.

Pending operations resume their original receipts after restarting Aspera. When a controller is offline, the preparation repair tool uses the same identity and exit checks as manual interruption. Missing submission identity, unreachable original nodes and ambiguous process ownership retain occupancy and report the missing evidence.

Existing deletion journals remain readable. Historical tasks require verification of their original submission, fixed release and node allocation before recovery. Deleted experiments stay deleted. No automatic training restart occurs.

## Migration

The private `aspera_remote_tasks` version-1 domain stores connection references and submission digests independently of fleet generation 6. Submission protocol 4 and Session formats are unchanged. Generated Remote clients include remote-task status and settlement operations; rebuild clients with the updated dispatch package.

Use the server card's Verify and release action for deleted tasks. Interrupt remote task explicitly permits stopping that task. A blocked result retains occupancy and lists missing evidence; retry uses the original operation. Connection checks remain read-only and do not settle tasks.

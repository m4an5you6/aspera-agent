---
kind: upgrade-guide
description: "Aspera allows removing unused coordinator registrations and automatically registers SSH host keys on first use."
---

# Aspera server registration and first SSH connection

English | [中文](guide.zh.md)

## Change

Aspera permits removing an unused coordinator from the local server list. Each new experiment explicitly selects its coordinator from its participants; historical experiments retain their saved coordinator, Session and remote release. Pending work and unconfirmed command or handover outcomes still prevent removal. Remote files are retained; unused owned credentials are removed.

Local connection checks and preparation automatically register previously unseen SSH host keys through trust on first use. Existing or revoked keys are not replaced. Password login and delegated node connections retain strict key checks. Connection checks modify only the local trust record and read remote state; they invoke no model and install no dependencies. Custom `FleetDriver` providers must implement `prepareSshHostKey`.

## Migration

1. Deploy the matching Aspera application and generated clients. Keep historical experiment and remote release directories. Existing fleet records remain readable; remote submission protocol and Session format do not change.
2. Use **Delete server** for an unused server registration. Stop or reconcile pending work first when removal is blocked. Select the coordinator when creating each experiment; existing experiments retain their original destinations. See the [management upgrade](../aspera-management/guide.md).
3. Use **Check connection** for a newly configured server. Its first host key is saved in the selected `known_hosts` file. Verify the connection result and any dependency diagnostics. Investigate a changed or revoked key; automatic registration never clears that warning.
4. Update custom `FleetDriver` implementations to supply `prepareSshHostKey(target, signal?)`. See the [dispatch reference](../../../../extensions/aspera/packages/dispatch/README.md).

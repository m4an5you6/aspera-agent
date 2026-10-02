---
kind: upgrade-guide
description: "Aspera 0.1.1 separates server storage preferences from frozen experiment directories and writes protocol 3."
---

# Aspera storage and network preparation

English | [中文](guide.zh.md)

## Change

Aspera 0.1.1 uses protocol and storage generation 3 independently of the application version. New server settings default to automatic storage selection and accept an optional internal network address. Preparation records the selected mount, directories and verified network addresses before remote admission. Generated Remote consumers must use the matching extension build.

## Migration

1. Finish existing remote work and confirm process cleanup before replacing a control service. Historical protocol 1 and 2 receipts retain their original version fields and hashes.
2. Install the complete Aspera 0.1.1 build. Existing explicit remote directories retain their layout; new servers use private control state and separately selected experiment storage.
3. Copy interrupted old preparation records to a new experiment to use automatic preparation. Check the saved directories and network results in experiment details.
4. Optional external inference mappings require this build on the coordinator and nodes (`public-inference-v1`). Finish existing work and stop old controllers before deploying the new build. Add the platform HTTPS URL and internal mapped port, then create or copy an experiment; existing submissions retain their saved settings. Old records without these optional fields remain readable.
5. Retain the build identifier and executable/runtime checksums when distributing multiple builds with application version 0.1.1. Packaging provides a complete application directory without a ZIP.

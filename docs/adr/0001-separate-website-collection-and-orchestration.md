---
status: proposed
---

# Separate website, collection, and orchestration services

Split the current launcher/server into three independently restartable boundaries: a Website Service owns immutable website artifacts, acquisitions, task catalogs, and deployments; the existing server becomes a Collection Service that owns collection registrations/frozen revision copies, participant runs, attempts, and evidence; and a Manager Service owns Study Revisions, publication, and lifecycle coordination. The browser extension talks only to the Collection Service during a task, and service integration uses versioned HTTP contracts rather than shared writable files, injected runtime configuration, or shutdown markers. This keeps website acquisition and evidence collection independently deployable while ensuring that collection can continue when the Manager is unavailable.

## Considered options

- Keep the current launcher and only move its functions into modules: rejected because configuration and lifecycle would still share one process and filesystem.
- Make the Manager a reverse proxy for all traffic: rejected because it would put orchestration in the evidence and website data paths.
- Let the Collection Service query the Website Service for every task request: rejected because a Website Service outage would prevent access to already-created Participant Runs and would make historical task configuration mutable.

## Consequences

Study publication becomes an idempotent, recoverable multi-service workflow. A published Study Revision contains a frozen website/task snapshot, each deployment is served at its own stable origin so root-relative SPA navigation remains inside that deployment, and completing one Participant Run never shuts down any service or retires the study. Retirement first closes Collection Service admission atomically with run creation, waits for existing Participant Runs to become terminal, and only then releases the Website Deployment.

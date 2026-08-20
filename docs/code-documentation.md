# Code Documentation Guidelines

Use JSDoc for every exported class, exported function, service method, route helper, storage helper, and non-obvious private function.

Good comments should explain intent, trust boundaries, side effects, and why a decision exists. Avoid comments that only repeat the code.

Document especially:

- Docker and shell execution boundaries.
- Webhook authentication and payload mapping.
- Project checkout path deletion and safety guards.
- Storage behavior and migration assumptions.
- Deployment lifecycle and log/status propagation.
- Controller-to-agent protocol decisions as they are introduced.

When adding a new module, start with a short module-level class or function comment that explains where it fits in the controller/agent/storage architecture.

## Future Secret Manager Plan

Updater can grow into a lightweight internal secret manager for deployments, similar in spirit to a small Infisical subset. The intended scope is deploy-time secret resolution, not a runtime secret API that application containers call directly.

Preferred flow:

```text
Updater vault -> deployment agent -> Docker secret -> container /run/secrets/...
```

Planned model:

- Store reusable secrets centrally in the controller database, encrypted with the existing controller secret key.
- Let projects reference secrets by namespace/key instead of storing plaintext values in project compose settings.
- Resolve secret references during deploy and create Docker Swarm secrets on the target manager.
- Render compose overlays with `external: true` secret references so secret values are not written into persisted compose files.
- Mount secrets into services at stable `/run/secrets/...` paths.
- Expose secure defaults through `KEY_FILE=/run/secrets/...` environment variables.
- Keep plain runtime environment injection available only as an explicit compatibility mode, because values become visible through Docker inspect and process environments.
- Consider an opt-in startup wrapper mode that reads secret files and exports normal env vars before launching the original process. This helps images that do not support `*_FILE`, but it is fragile because overriding entrypoint/command can break image startup behavior.

Important constraints:

- Docker secrets are Swarm-only; standalone Compose deployments need a different fallback, such as file-backed compose secrets.
- Docker secrets are immutable; secret updates should create a new content-addressed/versioned secret and clean up old Updater-managed versions after a successful deployment.
- Application containers should not depend on Updater being online at runtime.
- A full Infisical replacement would require RBAC, audit logs, leases, approvals, rotation workflows, and external integrations. Those are out of scope for the first internal vault version.

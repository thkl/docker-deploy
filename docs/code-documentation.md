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

# Roadmap: Coolify-Lite Migration

## Goal

Migrate Deploy from a small Express-rendered admin page into a structured Angular frontend with a stable backend API. The product direction is a lightweight Docker Compose deployment panel: repository compose files stay source-controlled, while Deploy manages deployment triggers, generated overrides, Traefik configuration, and operational visibility.

## Principles

- Keep each project repository as the source of truth for its base `docker-compose.yaml`.
- Let Deploy own generated overlays such as `docker-compose.updater.yml`, `docker-compose.traefik.yml`, and future storage overrides.
- Avoid editing project compose files directly unless explicitly requested.
- Prefer event-driven deploys: GitLab webhook, CI trigger, and manual deploy.
- Keep polling out of the design.
- Move persistent state from JSON files to SQLite with migrations.
- Treat checkout paths as target-server paths, not controller-local paths.
- Run all project filesystem and Docker actions through an agent/worker on the target server.
- Support one controller managing many agents: one local agent on the controller host and remote agents on other servers.
- Keep runtime inspection event-driven or user-requested; do not add background polling loops.

## Target Architecture

The product should split into a controller and agents.

Controller:

- Serves the Angular UI and structured API.
- Owns SQLite state, project configuration, server records, deployment history, and logs.
- Receives webhooks and CI/manual deploy requests.
- Dispatches jobs to the selected server agent.
- Never reads, writes, deletes, or verifies project checkout paths directly.

Agent:

- Runs on a target Docker server.
- Owns Docker socket access and host path access.
- Starts short-lived worker containers with the proper host mounts for clone, pull, compose import, deploy, stop, delete checkout, and cleanup tasks.
- Streams job status and logs back to the controller.

Topology:

```text
controller
  -> local agent
  -> remote agent 1
  -> remote agent 2
```

For remote servers, the controller talks to the agent over HTTP for commands and short-lived WebSockets for log streams. Messages should stay encrypted and signed at the application layer so this can work on private HTTP networks without TLS certificate management.

Hard rule:

```text
Controller never touches project checkout paths directly.
```

All project actions run through an agent/worker container on the selected target server.

## Phase 0: Storage Migration

Replace JSON storage with SQLite before the agent model grows more state.

Initial tables:

- [x] `settings`
- [x] `servers`
- [x] `agents`
- [x] `projects`
- [x] `project_traefik_settings`
- [x] `deployments`
- [x] `deployment_logs`

Requirements:

- [x] Add a migration runner.
- [x] Import existing `config.json`, `settings.json`, and `deployments.json` on first startup.
- [x] Keep API response shapes stable during the migration.
- [x] Store project secrets carefully; encrypted storage can be added after the schema is stable.

## Phase 1: Backend API Foundation

Create a structured API before migrating the UI.

Endpoints:

- [x] `GET /api/projects`
- [x] `POST /api/projects`
- [x] `GET /api/projects/:name`
- [x] `PUT /api/projects/:name`
- [x] `POST /api/projects/:name/deploy`
- [x] `POST /api/deploy/:name`
- [x] `GET /api/projects/:name/deployments`
- [x] `GET /api/projects/:name/compose/inspect`
- [x] `GET /api/projects/:name/status`
- [x] `GET /api/projects/:name/runtime-logs?service=...`

Response shapes:

- [ ] Standardize success responses as:

```json
{ "data": {} }
```

- [ ] Standardize error responses as:

```json
{ "error": { "message": "...", "code": "..." } }
```

- [ ] Config should move toward grouped sections:

```json
{
  "project": {},
  "git": {},
  "deployment": {},
  "traefik": {},
  "compose": {}
}
```

- [x] Each project must include a target server reference:

```json
{
  "project": {},
  "serverId": "local",
  "git": {},
  "deployment": {},
  "traefik": {},
  "compose": {}
}
```

## Phase 1.5: Stable Project Identity

Move project identity from repository/project name to a stable UUID.

Requirements:

- [x] Add `projects.id` as the primary stable project identifier.
- [x] Keep `projects.name` editable and unique, but never use it as a foreign key.
- [x] Migrate existing projects by generating UUIDs.
- [x] Migrate existing deployment rows from `project_name` references to `project_id` references.
- [x] Link deployments and runtime operations by `project_id`.
- [ ] Link future cached runtime status, runtime logs, compose inspection cache, and cleanup metadata by `project_id` when those tables are added.
- [x] Keep compatibility aliases during migration so existing URLs by project name can redirect or resolve to the UUID-backed project.
- [x] After migration, project rename must not break deployment history, logs, status, or agent routing.

API direction:

- [x] Prefer UUID routes for new UI navigation, for example `/api/projects/:id`.
- [x] Keep name-based webhook and CI lookup as resolver logic that maps repository payloads or path names to the internal project UUID.

## Phase 2: Angular App Shell

Add an Angular frontend under `frontend/` and serve its production build from Express.

Initial routes:

- [x] `/projects`
- [x] `/projects/:id/overview`
- [x] `/projects/:id/settings`
- [x] Compose settings inside `/projects/:id/settings`
- [x] Deployments/logs inside `/projects/:id/overview`
- [x] Dedicated `/projects/:id/compose`, `/projects/:id/deployments`, and `/projects/:id/logs` child routes.

Layout:

- [x] Left navigation: Projects and Settings.
- [x] Activity navigation.
- [x] Project list entries show the selected target agent/server.
- [x] Project overview has a status and command bar with deploy/runtime actions.
- [x] Main area uses dense operational views.
- [x] Browser-driven dark mode via `prefers-color-scheme`.

## Phase 3: Project Dashboard

Replace the current HTML table with an Angular project dashboard.

Show:

- [x] Project name
- [x] Target agent/server
- [x] Host path
- [x] Proxy hostname
- [x] Compose source
- [x] Latest deployment state
- [x] Last deployment time
- [x] Actions: Deploy, Open, Settings

This becomes the main Coolify-lite landing screen.

## Phase 4: Project Detail

Each project should have tabs or child routes:

- [x] **Overview:** status, hostname, configured path, latest deployment summary.
- [x] **Deployments:** deploy history and worker output in the overview log area.
- [x] **Compose:** detected compose file, generated overrides, services, networks, volumes in settings.
- [x] **Proxy:** Traefik settings and generated label preview in settings.
- [x] **Settings:** tokens, paths, CI trigger snippet.
- [x] Split these into dedicated child routes if the UI grows again.

## Phase 5: Compose Intelligence

Add backend compose inspection.

Detect:

- [x] Base compose file
- [x] Services
- [x] Exposed and published ports
- [x] Host-network ports/exposed-port behavior
- [x] Bind mounts
- [x] Named volumes
- [x] Networks
- [x] Relative bind mounts
- [x] Compose storage mappings
- [x] Sensitive environment values stored encrypted and rendered as Docker secrets or compatibility runtime env injection.

Manage generated files only:

- [x] `docker-compose.updater.yml`
- [x] Traefik settings merged into Deploy-owned compose output.
- [ ] Separate `docker-compose.storage.yml`
- [x] The UI should preview generated overrides before deployment.
- [x] Compose import and inspection must execute through the target server agent. The controller only receives structured results and file content from the agent.

## Phase 6: Deployment History

Persist deployment runs.

Suggested shape:

```json
{
  "id": "...",
  "project": "my-app",
  "trigger": "webhook",
  "status": "running",
  "startedAt": "...",
  "finishedAt": null,
  "output": "..."
}
```

Supported triggers:

- [x] `webhook`
- [x] `ci`
- [x] `manual`

Supported statuses:

- [ ] `queued`
- [x] `running`
- [x] `succeeded`
- [x] `failed`

This lets the UI show real deployment state instead of only "worker dispatched".

- [x] Deployment history should be stored in SQLite and keyed by project and server/agent so the UI can show where a deployment ran.

## Phase 6.5: Servers And Agents

Add servers as first-class configuration.

Server UI:

- [x] List servers and online/offline state.
- [x] Show local agent by default.
- [x] Add remote agent install/connect instructions.
- [x] Show agent version, last heartbeat, and active job.
- [x] Move server management into its own top-level UI category.
- [x] Show host diagnostics from agents: CPU load, memory, disk, and metric timestamp when available.
- [x] Push server health updates to the UI over the global event stream.
- [x] Ping all configured remote agents every 5 minutes.

Agent protocol:

- [x] Agent exposes HTTP endpoints for health, pairing, and encrypted job commands.
- [x] Controller authenticates with signed and encrypted command envelopes.
- [x] Controller sends jobs: import compose, deploy, stop, delete checkout, cleanup, inspect status, runtime logs, and runtime actions.
- [x] Agent exposes short-lived WebSocket streams for deployment logs and runtime container logs.
- [x] Controller persists deployment job events in SQLite.
- [x] Controller pushes latest runtime status to clients over the global event stream.

- [x] Local execution should use the same protocol shape as remote execution, even if implemented in-process first.

## Phase 6.6: Runtime Status And Logs

Add agent-side runtime inspection for deployed Docker Compose projects.

Service status:

- [x] Controller asks the selected target agent for project status on demand.
- [x] Agent inspects containers through Docker Compose or Docker inspect on the target server.
- Return structured status:
  - [x] `running`
  - [x] `partial`
  - [x] `stopped`
  - [x] `unknown`
  - [x] `error`
- [x] Include service-level details: service name, container name/id, state, health, image, ports, and checked time.
- [x] UI shows status indicators in the project list and project overview.
- [x] Deploy success triggers one immediate status refresh.
- [x] Add a manual refresh button.
- [x] Keep runtime status event-driven or user-requested instead of adding broad UI polling.

Runtime logs:

- [x] Keep deployment logs and runtime container logs separate.
- [x] Deployment logs remain the build/pull/up/down output for a deploy job.
- [x] Runtime logs come from running containers after deployment.
- [x] Runtime logs load only when the user opens the log panel or clicks live logs.
- [x] Agent should support tailing logs, for example `docker compose logs --tail <n> <service>`.
- [x] Agent should support short-lived live streams, for example `docker compose logs --follow`.
- [x] Stop runtime log streaming when the user leaves the page or stops live logs.
- [x] UI should support service selection, tail count, live toggle, and auto-scroll.

Suggested API shape:

- [x] `GET /api/projects/:name/status`
- [x] `GET /api/projects/:name/runtime-logs?service=app&tail=200`
- [x] WebSocket stream for live runtime logs.

Agent job additions:

- [x] `inspectStatus`
- [x] `runtimeLogs`
- [x] `runtimeAction`

## Phase 6.7: Server-Level Traefik Management

Add guarded Traefik management for target servers without making accidental global proxy changes easy.

Discovery and status:

- [x] Detect Traefik availability per server.
- [x] Show Traefik container/network status in the server view.
- [x] Generate and diagnose project-level Traefik labels.

Management workflow:

- [x] Inventory Traefik containers, static config paths, dynamic config paths, entrypoints, cert resolvers, Docker provider network, and ACME storage.
- [x] Show read-only server-level Traefik configuration before offering edits.
- [x] Add explicit backup/export before writing any Traefik config.
- [ ] Manage common defaults: entrypoints, cert resolvers, Docker network, wildcard domains, and ACME email/storage.
- [x] Validate generated Traefik config with the target agent before applying.
- [ ] Apply changes through the target server agent and keep rollback instructions/output.
- [x] Surface affected projects before changing a shared Traefik network or entrypoint.

## Phase 7: Storage Cleanup And Data Mapping

Add advanced cleanup support only after compose inspection exists.

Behavior:

- [x] Detect relative bind mounts such as `./data:/app/data`.
- [x] Offer rewrite to `/root/docker-data/<project>/...`.
- [x] Generate Deploy-owned compose output instead of changing the repository compose file.
- [x] Block repository cleanup if unsafe bind mounts remain.
- [x] Allow cleanup after deploy only when data paths are externalized.
- [x] Deploy from a Deploy-managed temporary checkout and persist rendered Compose files outside the checkout.

Example target layout:

```text
/root/docker-data/
  my-app/
    data/
    config/
    uploads/
```

## First Implementation Slice

1. [x] Keep the Angular app and current API stable.
2. [x] Move backend persistence from JSON to SQLite with migrations.
3. [x] Add `servers` and create a default local server.
4. [x] Add a local agent abstraction and route compose import, deploy, stop, delete checkout, and cleanup through it.
5. [x] Add remote agent WebSocket connection support.
6. [x] Update project settings so each project selects a target server.
7. [x] Migrate projects to stable UUIDs and link deployments/logs by project ID.
8. [x] Show each project's target agent/server in the left project panel.

## Explicit Non-Goals For Now

- [x] Full Docker Compose editor. Built as a Deploy-owned compose builder/editor instead of direct repository edits.
- [x] Editing repository-owned compose files directly remains avoided.
- [x] Polling GitLab for changes remains avoided.
- [ ] Multi-user permissions.
- [x] Controller-side direct filesystem access to project checkout paths remains avoided for project actions.

## Current Remaining Work

- [x] Add an Activity page backed by the global controller event stream.
- [x] Show last webhook receipt/match/ignore/error details per project.
- [ ] Finish moving page-specific live updates onto the global event stream where it makes sense, while keeping raw log streams separate if needed.
- [x] Add encrypted-at-rest storage for project secrets.
- [ ] Add explicit `queued` deployment status if deployments become queued before workers start.
- [x] Split compose/deployments/logs into dedicated child routes if the overview becomes crowded again.
- [x] Add cleanup-after-deploy enforcement based on externalized storage mappings.
- [ ] Build guarded server-level Traefik management for entrypoints, cert resolvers, networks, and static/dynamic config.
- [x] Rename the user-facing product to Deploy while keeping legacy `.updater`, `docker-compose.updater.yml`, and `UPDATER_*` compatibility.

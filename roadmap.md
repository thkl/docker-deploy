# Roadmap: Coolify-Lite Migration

## Goal

Migrate the updater from a small Express-rendered admin page into a structured Angular frontend with a stable backend API. The product direction is a lightweight Docker Compose deployment panel: repository compose files stay source-controlled, while the updater manages deployment triggers, generated overrides, Traefik configuration, and operational visibility.

## Principles

- Keep each project repository as the source of truth for its base `docker-compose.yaml`.
- Let the updater own generated overlays such as `docker-compose.updater.yml`, `docker-compose.traefik.yml`, and future storage overrides.
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

- `settings`
- `servers`
- `agents`
- `projects`
- `project_traefik_settings`
- `deployments`
- `deployment_logs`

Requirements:

- Add a migration runner.
- Import existing `config.json`, `settings.json`, and `deployments.json` on first startup.
- Keep API response shapes stable during the migration.
- Store project secrets carefully; encrypted storage can be added after the schema is stable.

## Phase 1: Backend API Foundation

Create a structured API before migrating the UI.

Endpoints:

- `GET /api/projects`
- `POST /api/projects`
- `GET /api/projects/:name`
- `PUT /api/projects/:name`
- `POST /api/projects/:name/deploy`
- `POST /api/deploy/:name`
- `GET /api/projects/:name/deployments`
- `GET /api/projects/:name/compose`
- `GET /api/projects/:name/services`
- `GET /api/projects/:name/logs?service=...`

Response shapes:

```json
{ "data": {} }
```

```json
{ "error": { "message": "...", "code": "..." } }
```

Config should move toward grouped sections:

```json
{
  "project": {},
  "git": {},
  "deployment": {},
  "traefik": {},
  "compose": {}
}
```

Each project must include a target server reference:

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

- Add `projects.id` as the primary stable project identifier.
- Keep `projects.name` editable and unique, but never use it as a foreign key.
- Migrate existing projects by generating UUIDs.
- Migrate existing deployment rows from `project_name` references to `project_id` references.
- Link all future project-owned data by `project_id`, including deployments, deployment logs, runtime status, runtime logs, compose inspection cache, cleanup metadata, and future settings tables.
- Keep compatibility aliases during migration so existing URLs by project name can redirect or resolve to the UUID-backed project.
- After migration, project rename must not break deployment history, logs, status, or agent routing.

API direction:

- Prefer UUID routes for new UI navigation, for example `/api/projects/:id`.
- Keep name-based webhook and CI lookup as resolver logic that maps repository payloads or path names to the internal project UUID.

## Phase 2: Angular App Shell

Add an Angular frontend under `frontend/` and serve its production build from Express.

Initial routes:

- `/projects`
- `/projects/:id/overview`
- `/projects/:id/settings`
- `/projects/:id/compose`
- `/projects/:id/deployments`
- `/projects/:id/logs`

Layout:

- Left navigation: Projects, Activity, Settings.
- Project list entries should show the selected target agent/server.
- Top bar: selected project, deploy action, latest status.
- Main area: dense operational views.
- Browser-driven dark mode via `prefers-color-scheme`.

## Phase 3: Project Dashboard

Replace the current HTML table with an Angular project dashboard.

Show:

- Project name
- Target agent/server
- Host path
- Proxy hostname
- Compose source
- Latest deployment state
- Last deployment time
- Actions: Deploy, Open, Settings

This becomes the main Coolify-lite landing screen.

## Phase 4: Project Detail

Each project should have tabs or child routes:

- **Overview:** status, hostname, configured path, latest deployment summary.
- **Deployments:** deploy history and worker output.
- **Compose:** detected compose file, generated overrides, services, networks, volumes.
- **Proxy:** Traefik settings and generated label preview.
- **Settings:** tokens, paths, CI trigger snippet.

## Phase 5: Compose Intelligence

Add backend compose inspection.

Detect:

- Base compose file
- Services
- Exposed and published ports
- Bind mounts
- Named volumes
- Networks
- Relative bind mounts

Manage generated files only:

- `docker-compose.updater.yml`
- `docker-compose.traefik.yml`
- Future `docker-compose.storage.yml`

The UI should preview generated overrides before deployment.

Compose import and inspection must execute through the target server agent. The controller only receives structured results and file content from the agent.

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

- `webhook`
- `ci`
- `manual`

Supported statuses:

- `queued`
- `running`
- `success`
- `failed`

This lets the UI show real deployment state instead of only "worker dispatched".

Deployment history should be stored in SQLite and keyed by project and server/agent so the UI can show where a deployment ran.

## Phase 6.5: Servers And Agents

Add servers as first-class configuration.

Server UI:

- List servers and online/offline state.
- Show local agent by default.
- Add remote agent install/connect instructions.
- Show agent version, last heartbeat, and active job.

Agent protocol:

- Agent exposes HTTP endpoints for health, pairing, and encrypted job commands.
- Controller authenticates with signed and encrypted command envelopes.
- Controller sends jobs: import compose, deploy, stop, delete checkout, cleanup, inspect status, and runtime logs.
- Agent exposes short-lived WebSocket streams for deployment logs and runtime container logs.
- Controller persists deployment job events in SQLite and may cache latest runtime status.

Local execution should use the same protocol shape as remote execution, even if implemented in-process first.

## Phase 6.6: Runtime Status And Logs

Add agent-side runtime inspection for deployed Docker Compose projects.

Service status:

- Controller asks the selected target agent for project status on demand.
- Agent inspects containers through Docker Compose or Docker inspect on the target server.
- Return structured status:
  - `running`
  - `partial`
  - `stopped`
  - `unknown`
  - `error`
- Include service-level details: service name, container name/id, state, health, image, ports, and checked time.
- UI shows status indicators in the project list and project overview.
- Deploy success triggers one immediate status refresh.
- Add a manual refresh button.
- Do not poll in the background when the UI is not viewing the project.

Runtime logs:

- Keep deployment logs and runtime container logs separate.
- Deployment logs remain the build/pull/up/down output for a deploy job.
- Runtime logs come from running containers after deployment.
- Runtime logs load only when the user opens the log panel or clicks live logs.
- Agent should support tailing logs, for example `docker compose logs --tail <n> <service>`.
- Agent should support short-lived live streams, for example `docker compose logs --follow`.
- Stop runtime log streaming when the user leaves the page or stops live logs.
- UI should support service selection, tail count, live toggle, and auto-scroll.

Suggested API shape:

- `GET /api/projects/:name/status`
- `GET /api/projects/:name/runtime-logs?service=app&tail=200`
- WebSocket stream for live runtime logs.

Agent job additions:

- `inspectStatus`
- `runtimeLogs`

## Phase 7: Storage Cleanup And Data Mapping

Add advanced cleanup support only after compose inspection exists.

Behavior:

- Detect relative bind mounts such as `./data:/app/data`.
- Offer rewrite to `/root/docker-data/<project>/...`.
- Generate a storage override instead of changing the repository compose file.
- Block repository cleanup if unsafe bind mounts remain.
- Allow cleanup after deploy only when data paths are externalized.

Example target layout:

```text
/root/docker-data/
  my-app/
    data/
    config/
    uploads/
```

## First Implementation Slice

1. Keep the Angular app and current API stable.
2. Move backend persistence from JSON to SQLite with migrations.
3. Add `servers` and create a default local server.
4. Add a local agent abstraction and route compose import, deploy, stop, delete checkout, and cleanup through it.
5. Add remote agent WebSocket connection support.
6. Update project settings so each project selects a target server.
7. Migrate projects to stable UUIDs and link deployments/logs by project ID.
8. Show each project's target agent/server in the left project panel.

## Explicit Non-Goals For Now

- Full Docker Compose editor.
- Editing repository-owned compose files directly.
- Polling GitLab for changes.
- Multi-user permissions.
- Controller-side direct filesystem access to project checkout paths.

# Roadmap: Coolify-Lite Migration

## Goal

Migrate the updater from a small Express-rendered admin page into a structured Angular frontend with a stable backend API. The product direction is a lightweight Docker Compose deployment panel: repository compose files stay source-controlled, while the updater manages deployment triggers, generated overrides, Traefik configuration, and operational visibility.

## Principles

- Keep each project repository as the source of truth for its base `docker-compose.yaml`.
- Let the updater own generated overlays such as `docker-compose.updater.yml`, `docker-compose.traefik.yml`, and future storage overrides.
- Avoid editing project compose files directly unless explicitly requested.
- Prefer event-driven deploys: GitLab webhook, CI trigger, and manual deploy.
- Keep polling out of the design.
- Preserve the current JSON config initially, but shape the API so a database can replace it later.

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
- Top bar: selected project, deploy action, latest status.
- Main area: dense operational views.
- Browser-driven dark mode via `prefers-color-scheme`.

## Phase 3: Project Dashboard

Replace the current HTML table with an Angular project dashboard.

Show:

- Project name
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

1. Add Angular workspace under `frontend/`.
2. Keep Express API in `src/`.
3. Serve Angular production assets from Express.
4. Rebuild the current UI in Angular:
   - Project list
   - Add/edit modal
   - Deploy now button
   - Save and deploy
   - Traefik settings
   - Stored compose override
   - Dark mode
5. Add deployment history after the Angular UI is stable.

## Explicit Non-Goals For Now

- Full Docker Compose editor.
- Editing repository-owned compose files directly.
- Polling GitLab for changes.
- Multi-user permissions.
- Replacing JSON config with a database before the API is stable.

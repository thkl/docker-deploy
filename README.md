# Docker Deploy

Docker Deploy is a lightweight Docker Compose deployment panel. It connects a controller UI to one or more Docker hosts, pulls project repositories, builds and starts Compose applications, stores deployment history, and manages generated Compose overrides for Traefik routing.

## Features

- Angular project dashboard with settings, overview, deployment history, runtime status, and logs.
- SQLite-backed project, server, Traefik, deployment, and log storage.
- Local and remote agent model so Docker and checkout access happen on the target server.
- Manual deploy, GitLab webhook deploy, and token-protected CI deploy endpoint.
- Docker Compose import and inspection through the target agent.
- Docker Compose validation with effective YAML preview before deployment.
- Visual Compose builder with services, networks, volumes, host bind mounts, dependencies, restart policy, environment, ports, healthcheck-preserving advanced YAML, and raw YAML mode.
- Sensitive environment values stored encrypted and deployed as Docker secret files or compatibility runtime env values.
- Traefik integration that writes labels and proxy-network membership into the stored override YAML.
- Traefik availability checks, cached server capabilities, and on-demand routing diagnostics.
- Runtime status, published/exposed ports, host-network detection, recent logs, and live log streaming.
- Optional checkout cleanup after deploy, guarded by Compose inspection so checkout-local data bind mounts must be externalized first.

## Run The Controller

```bash
pnpm install
pnpm run build:all
docker compose up -d
```

The controller listens on `PORT`, defaulting to `3999`.

Optional admin token:

```bash
DEPLOY_ADMIN_TOKEN=change-me
```

When set, browser API requests must authenticate with that token.

Project webhook secrets and CI deploy tokens are encrypted in SQLite with a controller-local AES-256-GCM key stored at:

```text
./data/controller-secret-key.json
```

Keep this file with the controller data volume. Existing `UPDATER_SECRET_KEY` or new `DEPLOY_SECRET_KEY` can also provide a 32-byte base64 key explicitly.

## Run A Remote Agent

On a Docker host managed by the controller:

```bash
docker compose -f docker-compose-agent.yaml up -d
```

The agent listens on `DEPLOY_AGENT_PORT`, defaulting to `3998`, and writes pairing data to:

```text
./data/agent/agent-pairing.json
```

In the controller UI, open global settings, add the agent URL, paste the pairing token, and save/pair. Remote jobs are encrypted and signed between controller and agent.

## Add A Project

1. Open the UI.
2. Create a project.
3. Select the target server.
4. Set the repository URL and host checkout path.
5. Configure either repository Compose usage or a stored Compose override.
6. Save or Save & deploy.

The target path is a persistent project root on the selected Docker server, not the controller machine. Deployments clone into a temporary checkout managed by Deploy below that root.

## Compose Builder

Use Project settings -> Docker Compose -> Builder.

- **Services:** image/build, restart policy, ports, environment, sensitive environment, service volumes, networks, dependencies, profiles, command, advanced YAML.
- **Networks:** define the networks services may select.
- **Volumes:** define named volumes and review host bind mappings such as `./data:/data`.
- **Traefik:** select the target service and Docker network from the builder-defined lists.

The builder prevents removing services, networks, or named volumes while another setting references them. It also warns about missing references, duplicates, `network_mode` conflicts, missing Traefik host/port values, and Traefik targeting host-networked services.

Raw YAML mode remains available for Compose options the builder cannot safely edit.

Sensitive environment variables are kept outside the raw Compose YAML. In **Docker secret file** mode, Deploy sets `KEY_FILE=/run/secrets/<service>_<key>` and mounts the value as a Compose secret file. The application must read the `_FILE` variable. In **Runtime env** mode, Deploy injects `KEY=value` during deployment for legacy apps that only read normal environment variables; this is less secure because Docker can expose container environment values.

Example:

```
const dbPass =
    process.env.DB_PASS ??
    readFileSync(process.env.DB_PASS_FILE!, 'utf8').trim();
```

## Compose Validation

Use Project settings -> Docker Compose -> **Validate compose** before deploying.

Validation runs through the selected target agent and uses the same effective Compose input as deployment:

- stored override YAML when one is configured
- repository Compose file when no override is configured
- generated Traefik overlay when Traefik is enabled and not already written into the override

The result shows whether Compose is valid, any Docker Compose error output, warnings for missing external networks, and the normalized effective YAML from `docker compose config --no-interpolate`.

`Save & deploy` validates after saving and blocks deployment when Compose is invalid.

## Traefik Setup

For Traefik routing:

1. Define the proxy network in the builder, usually as an external network.
2. Attach the application service to that network.
3. Enable Traefik.
4. Select the service, network, hostname, internal container port, entrypoint, and cert resolver.
5. Save the project.

The UI writes Traefik labels into the stored override YAML:

```yaml
labels:
  - "traefik.enable=true"
  - "traefik.providers.docker.network=frontend"
  - "traefik.http.routers.app.rule=Host(`app.example.com`)"
  - "traefik.http.services.app.loadbalancer.server.port=3000"
```

For Traefik to reach the app, the Traefik container and the app container must share the selected Docker network. Avoid `network_mode: host` for services that should be proxied by Traefik.

## Traefik Diagnostics

Open Project settings -> Docker Compose -> Builder -> Traefik and click **Run diagnostics**.

The diagnostic checks:

- A running Traefik container exists.
- The selected Docker network exists.
- Traefik is attached to the selected network.
- The target service container exists in the deployed Compose project.
- The target service is attached to the selected network.
- The target service responds on the configured internal port from that network.

This is aimed at common `504 Gateway Timeout` failures where Traefik matched the router but cannot connect to the backend.

## Deploy From CI

Set a CI deploy token in project settings, then call:

```bash
curl -X POST \
  -H "Authorization: Bearer $DEPLOY_TOKEN" \
  https://deploy.example.com/api/deploy/<project-id-or-name>
```

## Deploy From GitLab Webhook

Set the project webhook secret in project settings, then configure a GitLab Push Hook pointing to:

```text
https://deploy.example.com/webhook
```

The webhook resolver maps incoming GitLab project data to the configured project and dispatches a deploy.

## Runtime Operations

Project overview can inspect the deployed Compose runtime and show:

- running/stopped/partial status
- service containers
- healthcheck status
- published and exposed ports
- network mode
- recent logs
- live log stream

Status and logs are requested through the selected target agent.

## Cleanup After Deploy

Each deploy uses a fresh temporary checkout under the project root:

```text
/root/docker-apps/my-project/
  .updater/
    tmpdeploy/
    compose/docker-compose.deploy.yml
    inspect/
  data/
```

Enable cleanup in Settings when project data no longer lives inside the temporary repository checkout. Before deleting `.updater/tmpdeploy`, the controller asks the selected agent to inspect the effective Compose file. Cleanup runs only when there are no unsafe checkout-local bind mounts such as `./data:/data`.

On startup, the controller also sweeps stale `.updater/tmpdeploy` folders for configured projects when cleanup is enabled. This handles self-updates where the controller restarted before the original deploy callback could delete the temporary checkout.

If a Compose file references `env_file: .env`, the worker uses `.env` from the persistent project root when the cloned repository does not contain one. The persisted deploy compose is rewritten to reference that project-root `.env`, so later runtime actions still work after temporary checkout cleanup.

If a Compose file uses an absolute build context that points at the project root, for example `build.context: /root/docker-apps/my-project`, the worker rewrites only that build context to `.updater/tmpdeploy`. Relative bind mounts such as `./data:/app/data` are rewritten to the persistent project root, for example `/root/docker-apps/my-project/data:/app/data`.

Use the Compose builder storage mapping preview to move relative data paths to an external host path such as `/root/docker-apps/<project>/data`. If unsafe mounts remain, the deploy still succeeds and the deployment log explains why checkout cleanup was skipped.

## Development

Backend:

```bash
pnpm run build
```

Frontend:

```bash
pnpm --dir frontend build
```

Full build:

```bash
pnpm run build:all
```

## Notes

- Docker socket access is powerful. Run the controller and agents only where that trust boundary is acceptable.
- Project roots, temporary checkouts, and Docker commands execute on the selected target server.
- Stored Compose overrides intentionally replace repository Compose files for deployment.
- The generated `.updater/compose/docker-compose.deploy.yml` is the persisted deploy source after each successful render.
- `.updater`, `docker-compose.updater.yml`, and `UPDATER_*` environment names are kept as compatibility names for existing installs.

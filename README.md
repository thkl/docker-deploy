# Docker Updater

Docker Updater is a lightweight Docker Compose deployment panel. It connects a controller UI to one or more Docker hosts, pulls project repositories, builds and starts Compose applications, stores deployment history, and manages generated Compose overrides for Traefik routing.

## Features

- Angular project dashboard with settings, overview, deployment history, runtime status, and logs.
- SQLite-backed project, server, Traefik, deployment, and log storage.
- Local and remote agent model so Docker and checkout access happen on the target server.
- Manual deploy, GitLab webhook deploy, and token-protected CI deploy endpoint.
- Docker Compose import and inspection through the target agent.
- Visual Compose builder with services, networks, volumes, host bind mounts, dependencies, restart policy, environment, ports, healthcheck-preserving advanced YAML, and raw YAML mode.
- Traefik integration that writes labels and proxy-network membership into the stored override YAML.
- Traefik availability checks, cached server capabilities, and on-demand routing diagnostics.
- Runtime status, published/exposed ports, host-network detection, recent logs, and live log streaming.

## Run The Controller

```bash
pnpm install
pnpm run build:all
docker compose up -d
```

The controller listens on `PORT`, defaulting to `3999`.

Optional admin token:

```bash
UPDATER_ADMIN_TOKEN=change-me
```

When set, browser API requests must authenticate with that token.

## Run A Remote Agent

On a Docker host managed by the controller:

```bash
docker compose -f docker-compose-agent.yaml up -d
```

The agent listens on `UPDATER_AGENT_PORT`, defaulting to `3998`, and writes pairing data to:

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

The target path is a path on the selected Docker server, not the controller machine.

## Compose Builder

Use Project settings -> Docker Compose -> Builder.

- **Services:** image/build, restart policy, ports, environment, service volumes, networks, dependencies, profiles, command, advanced YAML.
- **Networks:** define the networks services may select.
- **Volumes:** define named volumes and review host bind mappings such as `./data:/data`.
- **Traefik:** select the target service and Docker network from the builder-defined lists.

The builder prevents removing services, networks, or named volumes while another setting references them. It also warns about missing references, duplicates, `network_mode` conflicts, missing Traefik host/port values, and Traefik targeting host-networked services.

Raw YAML mode remains available for Compose options the builder cannot safely edit.

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
  https://updater.example.com/api/deploy/<project-id-or-name>
```

## Deploy From GitLab Webhook

Set the project webhook secret in project settings, then configure a GitLab Push Hook pointing to:

```text
https://updater.example.com/webhook
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
- Project checkout paths and Docker commands execute on the selected target server.
- Stored Compose overrides intentionally replace repository Compose files for deployment.
- The generated `docker-compose.updater.yml` is the deploy source when an override is saved.

import { GlobalSettings, ProjectSettings } from "./types.js";

/**
 * Quotes a scalar for the generated YAML fragment.
 */
function yamlQuote(value: string | number | boolean) {
    return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Converts a project name into a Traefik-safe router identifier.
 */
function traefikRouterName(repoName: string) {
    return repoName.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/**
 * Builds the shell block that writes a Docker Compose override containing
 * Traefik labels and network configuration.
 */
export function renderTraefikOverrideScript(repoName: string, settings: ProjectSettings, globalSettings: GlobalSettings) {
    const traefik = settings.traefik;
    if (!traefik?.enabled) {
        return "";
    }

    const serviceName = traefik.service || repoName;
    const routerName = traefikRouterName(repoName);
    const network = traefik.network || globalSettings.defaultTraefikNetwork;
    const deploymentStrategy = settings.deploymentStrategy === "swarm" ? "swarm" : "compose";
    const rule = `Host(\`${traefik.hostname}\`)`;
    const labels: Array<[string, string | number | boolean]> = [
        ["traefik.enable", "true"],
        ...(deploymentStrategy === "swarm"
            ? [["traefik.swarm.network", network], ["traefik.docker.network", network]] as Array<[string, string]>
            : [["traefik.docker.network", network]] as Array<[string, string]>),
        [`traefik.http.routers.${routerName}.rule`, rule],
        [`traefik.http.routers.${routerName}.entrypoints`, traefik.entryPoints || globalSettings.defaultTraefikEntryPoints],
        [`traefik.http.routers.${routerName}.tls`, "true"],
        [`traefik.http.routers.${routerName}.tls.certresolver`, traefik.certResolver || globalSettings.defaultTraefikCertResolver],
        [`traefik.http.services.${routerName}.loadbalancer.server.port`, traefik.port || 80]
    ];

    // Wildcard certificate labels follow Traefik's domains[0] syntax.
    if (traefik.wildcardCertificate && traefik.wildcardDomain) {
        labels.push(
            [`traefik.http.routers.${routerName}.tls.domains[0].main`, traefik.wildcardDomain],
            [`traefik.http.routers.${routerName}.tls.domains[0].sans`, `*.${traefik.wildcardDomain}`]
        );
    }

    if (traefik.websocket) {
        labels.push(
            [`traefik.http.middlewares.${routerName}-websocket.headers.customrequestheaders.Connection`, "Upgrade"],
            [`traefik.http.middlewares.${routerName}-websocket.headers.customrequestheaders.Upgrade`, "websocket"],
            [`traefik.http.routers.${routerName}.middlewares`, `${routerName}-websocket`]
        );
    }
  
    // When Traefik fronts the service, published host ports usually create
    // conflicts and are not needed.
    const resetPorts = traefik.removePublishedPorts !== false ? "\n    ports: !reset []" : "";

    const labelIndent = deploymentStrategy === "swarm" ? "        " : "      ";
    const labelContent = labels.map(([key, value]) => `${labelIndent}${yamlQuote(key)}: ${yamlQuote(value)}`).join("\n");

    const serviceLabelContent = deploymentStrategy === "swarm"
        ? `    deploy:
      mode: replicated
      replicas: 1
      placement:
        constraints:
          - ${yamlQuote("node.role == worker")}
      labels:
${labelContent}`
        : `    labels:
${labelContent}`;

    const overrideContent = `services:
  ${yamlQuote(serviceName)}:
${serviceLabelContent}
    networks:
      - ${yamlQuote(network)}
${resetPorts}

networks:
  ${yamlQuote(network)}:
    external: true
`;

    return `
                echo "--> Writing Traefik compose override..."
                cat > docker-compose.traefik.yml << 'TRAEFIK_EOF'
${overrideContent}TRAEFIK_EOF
                if [ -f docker-compose.updater.source.yml ]; then
                    if grep -q "# updater-traefik-start" docker-compose.updater.source.yml; then
                        echo "--> Stored Docker Compose override already contains Traefik settings."
                        COMPOSE_FILES="-f docker-compose.updater.yml"
                    else
                        echo "--> Merging Traefik settings into stored Docker Compose override..."
                        docker compose -f docker-compose.updater.source.yml -f docker-compose.traefik.yml config --no-interpolate > docker-compose.updater.yml
                        COMPOSE_FILES="-f docker-compose.updater.yml"
                    fi
                else
                    COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.traefik.yml"
                fi`;
}

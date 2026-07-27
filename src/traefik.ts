import { ProjectSettings } from "./types.js";

function yamlQuote(value: string | number | boolean) {
    return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function traefikRouterName(repoName: string) {
    return repoName.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function renderTraefikOverrideScript(repoName: string, settings: ProjectSettings) {
    const traefik = settings.traefik;
    if (!traefik?.enabled) {
        return "";
    }

    const serviceName = traefik.service || repoName;
    const routerName = traefikRouterName(repoName);
    const network = traefik.network || "proxy";
    const rule = `Host(\`${traefik.hostname}\`)`;
    const wildcardLabels = traefik.wildcardCertificate && traefik.wildcardDomain
        ? `
      "traefik.http.routers.${routerName}.tls.domains[0].main": ${yamlQuote(traefik.wildcardDomain)}
      "traefik.http.routers.${routerName}.tls.domains[0].sans": ${yamlQuote(`*.${traefik.wildcardDomain}`)}`
        : "";
 
    const websocketLabels = traefik.websocket
        ? `
      "traefik.http.middlewares.${routerName}-websocket.headers.customrequestheaders.Connection": "Upgrade"
      "traefik.http.middlewares.${routerName}-websocket.headers.customrequestheaders.Upgrade": "websocket"
      "traefik.http.routers.${routerName}.middlewares": "${routerName}-websocket@docker"`
        : "";
  
    const resetPorts = traefik.removePublishedPorts !== false ? "\n    ports: !reset []" : "";

    const overrideContent = `services:
  ${yamlQuote(serviceName)}:
    labels:
      "traefik.enable": "true"
      "traefik.providers.docker.network": ${yamlQuote(network)}
      "traefik.http.routers.${routerName}.rule": ${yamlQuote(rule)}
      "traefik.http.routers.${routerName}.entrypoints": ${yamlQuote(traefik.entryPoints || "websecure")}
      "traefik.http.routers.${routerName}.tls": "true"
      "traefik.http.routers.${routerName}.tls.certresolver": ${yamlQuote(traefik.certResolver || "letsencrypt")}
${wildcardLabels}
      "traefik.http.services.${routerName}.loadbalancer.server.port": ${yamlQuote(traefik.port || 80)}
${websocketLabels}
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
                COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.traefik.yml"`;
}

import { AgentManager } from "./agentManager.js";
import { ComposeInspection, ComposeValidation, DockerTopology, GlobalSettings, ProjectPreflightCheck, ProjectPreflightResult, ProjectPreflightStatus, ProjectPreflightTarget, ProjectSettings, ServerCapabilities } from "./types.js";

/**
 * Runs non-mutating deployment readiness checks against the same target agent
 * path used by deployment.
 */
export async function runProjectPreflight(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, agentManager: AgentManager): Promise<ProjectPreflightResult> {
    const deploymentTargets = targetDeploymentServerIds(appSettings, agentManager);
    const checks: ProjectPreflightCheck[] = [
        projectSourceCheck(appSettings),
        registryConfigurationCheck(appSettings, globalSettings)
    ];
    const targets = await Promise.all(deploymentTargets.map((serverId) => runTargetPreflight(projectName, { ...appSettings, serverId }, globalSettings, agentManager)));

    return {
        ...(appSettings.id ? { projectId: appSettings.id } : {}),
        projectName,
        checkedAt: new Date().toISOString(),
        status: worstStatus([...checks, ...targets.flatMap((target) => target.checks)]),
        checks,
        targets
    };
}

async function runTargetPreflight(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, agentManager: AgentManager): Promise<ProjectPreflightTarget> {
    const serverId = appSettings.serverId ?? "local";
    const agent = agentManager.getClient(serverId);
    const checks: ProjectPreflightCheck[] = [];

    let docker: DockerTopology | null = null;
    try {
        docker = await agent.inspectDocker();
        checks.push(dockerCheck(serverId, docker));
        checks.push(swarmRoleCheck(serverId, appSettings, docker));
    } catch (error) {
        checks.push(fail("docker.reachable", "Target server", `Could not inspect Docker on ${serverId}: ${readErrorMessage(error)}`, serverId));
        return { serverId, status: "fail", checks };
    }

    if (registryEnabled(appSettings)) {
        try {
            const registry = await agent.testRegistry(globalSettings);
            checks.push({
                key: "registry.login",
                label: "Registry login",
                status: registry.ok ? registry.skipped ? "warn" : "pass" : "fail",
                detail: registry.detail,
                target: serverId
            });
        } catch (error) {
            checks.push(fail("registry.login", "Registry login", `Could not test registry access: ${readErrorMessage(error)}`, serverId));
        }
    }

    let validation: ComposeValidation | null = null;
    try {
        validation = await agent.validateCompose(projectName, appSettings, globalSettings);
        checks.push(composeValidationCheck(serverId, validation));
        for (const warning of validation.warnings) {
            checks.push(warn("compose.warning", "Compose warning", warning, serverId));
        }
    } catch (error) {
        checks.push(fail("compose.validate", "Compose validation", `Could not validate compose: ${readErrorMessage(error)}`, serverId));
    }

    let inspection: ComposeInspection | null = null;
    if (validation?.valid) {
        try {
            inspection = await agent.inspectCompose(projectName, appSettings, globalSettings);
            checks.push(composeInspectionCheck(serverId, inspection));
            checks.push(...swarmImageChecks(serverId, appSettings, inspection));
            checks.push(bindMountCheck(serverId, inspection));
        } catch (error) {
            checks.push(fail("compose.inspect", "Compose inspection", `Could not inspect compose services: ${readErrorMessage(error)}`, serverId));
        }
    }

    if (appSettings.traefik?.enabled) {
        try {
            const traefik = await agent.detectTraefik(globalSettings);
            checks.push(...traefikPreflightChecks(serverId, projectName, appSettings, globalSettings, inspection, traefik));
        } catch (error) {
            checks.push(fail("traefik.detect", "Traefik", `Could not inspect Traefik readiness: ${readErrorMessage(error)}`, serverId));
        }
    } else {
        checks.push(pass("traefik.disabled", "Traefik", "Traefik is disabled for this project.", serverId));
    }

    return {
        serverId,
        status: worstStatus(checks),
        checks
    };
}

function projectSourceCheck(appSettings: ProjectSettings): ProjectPreflightCheck {
    if (appSettings.composeOverride?.trim()) {
        return pass("project.source", "Deployment source", "Stored Docker Compose content is configured.");
    }
    if (appSettings.repositoryUrl?.trim()) {
        return pass("project.source", "Deployment source", "Repository URL is configured.");
    }
    return warn("project.source", "Deployment source", "No repository URL is configured; deploy depends on an existing Git checkout at the project path.");
}

function registryConfigurationCheck(appSettings: ProjectSettings, globalSettings: GlobalSettings): ProjectPreflightCheck {
    if (!registryEnabled(appSettings)) {
        return pass("registry.config", "Registry configuration", "Registry deployment is disabled for this project.");
    }

    if (!globalSettings.registryAddress.trim()) {
        return fail("registry.config", "Registry configuration", "Registry deployment is enabled, but no controller registry address is configured.");
    }
    if (globalSettings.registryUsername.trim() && !globalSettings.registryPassword?.trim()) {
        return fail("registry.config", "Registry configuration", "Registry username is configured, but the password is empty.");
    }
    return pass("registry.config", "Registry configuration", `Registry address is configured: ${globalSettings.registryAddress.trim()}.`);
}

function dockerCheck(serverId: string, docker: DockerTopology): ProjectPreflightCheck {
    if (!docker.available) {
        return fail("docker.available", "Docker", docker.error || "Docker is not available on the target server.", serverId);
    }

    return pass("docker.available", "Docker", `Docker is available on ${serverId} (${docker.mode}).`, serverId);
}

function swarmRoleCheck(serverId: string, appSettings: ProjectSettings, docker: DockerTopology): ProjectPreflightCheck {
    if (appSettings.deploymentStrategy !== "swarm") {
        return pass("docker.mode", "Docker mode", `Compose deployment can run with Docker mode ${docker.mode}.`, serverId);
    }

    return docker.mode === "swarm-manager" && docker.swarmControlAvailable !== false
        ? pass("docker.swarm-manager", "Swarm manager", "Target can dispatch Swarm stack deployments.", serverId)
        : fail("docker.swarm-manager", "Swarm manager", `Swarm stack deployment needs a manager target; detected ${docker.mode}.`, serverId);
}

function composeValidationCheck(serverId: string, validation: ComposeValidation): ProjectPreflightCheck {
    if (!validation.valid) {
        return fail("compose.validate", "Compose validation", validation.error || "Docker Compose validation failed.", serverId);
    }

    return pass("compose.validate", "Compose validation", `Effective ${validation.source === "storedOverride" ? "stored" : "repository"} compose is valid${validation.composeFile ? ` (${validation.composeFile})` : ""}.`, serverId);
}

function composeInspectionCheck(serverId: string, inspection: ComposeInspection): ProjectPreflightCheck {
    if (!inspection.services.length) {
        return fail("compose.services", "Compose services", "Compose file does not define any services.", serverId);
    }

    return pass("compose.services", "Compose services", `${inspection.services.length} service(s), ${inspection.networks.length} network(s), ${inspection.volumes.length} volume(s) detected.`, serverId);
}

function swarmImageChecks(serverId: string, appSettings: ProjectSettings, inspection: ComposeInspection): ProjectPreflightCheck[] {
    if (appSettings.deploymentStrategy !== "swarm") {
        return [];
    }

    const deployFromRegistry = Boolean(appSettings.registry?.deployFromRegistry);
    return inspection.services.flatMap((service) => {
        if (service.image) {
            return [pass(`swarm.image.${service.name}`, `Swarm image: ${service.name}`, `${service.name} has image ${service.image}.`, serverId)];
        }
        if (deployFromRegistry && service.build) {
            return [pass(`swarm.image.${service.name}`, `Swarm image: ${service.name}`, `${service.name} will be rewritten to a registry image from build context ${service.build}.`, serverId)];
        }
        return [fail(`swarm.image.${service.name}`, `Swarm image: ${service.name}`, `${service.name} needs a pullable image, or registry deployment from a build context must be enabled.`, serverId)];
    });
}

function bindMountCheck(serverId: string, inspection: ComposeInspection): ProjectPreflightCheck {
    const riskyMounts = inspection.services.flatMap((service) => service.mounts.filter((mount) => !mount.safeForCleanup).map((mount) => `${service.name}: ${mount.raw}`));
    if (!riskyMounts.length && !inspection.storageMappings.length) {
        return pass("compose.bind-mounts", "Bind mounts", "No project-root bind mounts that would block cleanup were detected.", serverId);
    }

    return warn(
        "compose.bind-mounts",
        "Bind mounts",
        `${riskyMounts.length + inspection.storageMappings.length} bind mount(s) may keep temporary or release checkouts in use: ${[...riskyMounts, ...inspection.storageMappings.map((mapping) => `${mapping.service}: ${mapping.source}:${mapping.target}`)].slice(0, 4).join("; ")}.`,
        serverId
    );
}

function traefikPreflightChecks(
    serverId: string,
    projectName: string,
    appSettings: ProjectSettings,
    globalSettings: GlobalSettings,
    inspection: ComposeInspection | null,
    traefikInventory: ServerCapabilities["traefik"]
): ProjectPreflightCheck[] {
    const traefik = appSettings.traefik;
    if (!traefik?.enabled) {
        return [pass("traefik.disabled", "Traefik", "Traefik is disabled for this project.", serverId)];
    }

    const serviceName = traefik.service || projectName;
    const network = traefik.network || globalSettings.defaultTraefikNetwork || "proxy";
    const strategy = appSettings.deploymentStrategy === "swarm" ? "swarm" : "compose";
    const checks: ProjectPreflightCheck[] = [
        traefikInventory.available
            ? pass("traefik.available", "Traefik workload", `Traefik was detected on ${serverId}.`, serverId)
            : warn("traefik.available", "Traefik workload", "No local Traefik workload was detected. This can be normal when Traefik runs on another Swarm node, but routing cannot be fully verified from this target.", serverId),
        traefikProviderModeCheck(serverId, strategy, traefikInventory.providerMode),
        traefikServiceCheck(serverId, serviceName, inspection),
        pass("traefik.network-attachment", "Target network attachment", `Deploy will attach ${serviceName} to ${network} through the generated Traefik compose override.`, serverId)
    ];

    const networkDetail = traefikInventory.networkDetails?.find((candidate) => candidate.name === network);
    if (networkDetail) {
        checks.push(pass("traefik.network", "Traefik network", `${network} exists (${[networkDetail.driver, networkDetail.scope].filter(Boolean).join(", ") || "driver unknown"}, attachable=${String(networkDetail.attachable ?? "unknown")}).`, serverId));
        if (strategy === "compose" && networkDetail.driver === "overlay" && networkDetail.attachable === false) {
            checks.push(fail("traefik.network.attachable", "Compose network attach", `${network} is a non-attachable overlay network. Compose containers cannot join it reliably; use Swarm stack deployment or recreate the overlay as attachable.`, serverId));
        }
    } else if (traefikInventory.networks?.includes(network) || (network === globalSettings.defaultTraefikNetwork && traefikInventory.networkPresent)) {
        checks.push(pass("traefik.network", "Traefik network", `${network} was detected in the Traefik inventory.`, serverId));
    } else {
        checks.push(warn("traefik.network", "Traefik network", `${network} was not found in the Traefik inventory. Compose validation also reports missing external networks separately.`, serverId));
    }

    if (traefik.entryPoints && traefikInventory.entryPoints?.length && !csvIncludes(traefikInventory.entryPoints, traefik.entryPoints)) {
        checks.push(warn("traefik.entrypoints", "Traefik entrypoints", `${traefik.entryPoints} is configured for this project, but detected entrypoints are ${traefikInventory.entryPoints.join(", ")}.`, serverId));
    } else {
        checks.push(pass("traefik.entrypoints", "Traefik entrypoints", traefik.entryPoints ? `${traefik.entryPoints} is configured.` : "Default entrypoints will be used.", serverId));
    }

    if (traefik.certResolver && traefikInventory.certResolvers?.length && !traefikInventory.certResolvers.includes(traefik.certResolver)) {
        checks.push(warn("traefik.certresolver", "Traefik cert resolver", `${traefik.certResolver} is configured for this project, but detected resolvers are ${traefikInventory.certResolvers.join(", ")}.`, serverId));
    } else {
        checks.push(pass("traefik.certresolver", "Traefik cert resolver", traefik.certResolver ? `${traefik.certResolver} is configured.` : "Default cert resolver will be used.", serverId));
    }

    return checks;
}

function traefikProviderModeCheck(serverId: string, strategy: "compose" | "swarm", providerMode: ServerCapabilities["traefik"]["providerMode"]): ProjectPreflightCheck {
    if (!providerMode || providerMode === "unknown") {
        return warn("traefik.provider", "Traefik provider", "Traefik provider mode could not be detected.", serverId);
    }
    if (providerMode === "mixed") {
        return pass("traefik.provider", "Traefik provider", "Traefik has Docker and Swarm provider signals.", serverId);
    }
    if (strategy === "swarm" && providerMode === "docker") {
        return fail("traefik.provider", "Traefik provider", "Swarm stack labels require Traefik's Swarm provider, but only Docker provider signals were detected.", serverId);
    }
    if (strategy === "compose" && providerMode === "swarm") {
        return fail("traefik.provider", "Traefik provider", "Compose container labels require Traefik's Docker provider, but only Swarm provider signals were detected.", serverId);
    }
    return pass("traefik.provider", "Traefik provider", `Traefik provider mode ${providerMode} matches ${strategy} deployment.`, serverId);
}

function traefikServiceCheck(serverId: string, serviceName: string, inspection: ComposeInspection | null): ProjectPreflightCheck {
    if (!inspection) {
        return warn("traefik.service", "Target service", "Service existence could not be verified because compose inspection did not finish.", serverId);
    }

    const service = inspection.services.find((candidate) => candidate.name === serviceName);
    return service
        ? pass("traefik.service", "Target service", `${serviceName} exists in the Compose model.`, serverId)
        : fail("traefik.service", "Target service", `${serviceName} is not defined in the Compose model. Set the Traefik service to one of: ${inspection.services.map((candidate) => candidate.name).join(", ") || "none"}.`, serverId);
}

function csvIncludes(values: string[], csvValue: string) {
    const requested = csvValue.split(",").map((value) => value.trim()).filter(Boolean);
    return requested.every((value) => values.includes(value));
}

function registryEnabled(appSettings: ProjectSettings) {
    return Boolean(appSettings.registry?.publish || appSettings.registry?.deployFromRegistry);
}

function targetDeploymentServerIds(appSettings: ProjectSettings, agentManager: AgentManager) {
    const ids = targetServerIds(appSettings);
    if (appSettings.deploymentStrategy !== "swarm") {
        return ids;
    }

    const managerId = agentManager.findSwarmManagerServerId(ids);
    return [managerId ?? ids[0] ?? "local"];
}

function targetServerIds(appSettings: ProjectSettings) {
    const ids = (appSettings.serverIds?.length ? appSettings.serverIds : [appSettings.serverId ?? "local"])
        .map((serverId) => serverId.trim())
        .filter(Boolean);
    return [...new Set(ids.length ? ids : ["local"])];
}

function pass(key: string, label: string, detail: string, target?: string): ProjectPreflightCheck {
    return { key, label, status: "pass", detail, ...(target ? { target } : {}) };
}

function warn(key: string, label: string, detail: string, target?: string): ProjectPreflightCheck {
    return { key, label, status: "warn", detail, ...(target ? { target } : {}) };
}

function fail(key: string, label: string, detail: string, target?: string): ProjectPreflightCheck {
    return { key, label, status: "fail", detail, ...(target ? { target } : {}) };
}

function worstStatus(checks: ProjectPreflightCheck[]): ProjectPreflightStatus {
    if (checks.some((check) => check.status === "fail")) {
        return "fail";
    }
    if (checks.some((check) => check.status === "warn")) {
        return "warn";
    }
    return "pass";
}

function readErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

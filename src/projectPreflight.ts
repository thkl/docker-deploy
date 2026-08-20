import { AgentManager } from "./agentManager.js";
import { ComposeInspection, ComposeValidation, DockerTopology, GlobalSettings, ProjectPreflightCheck, ProjectPreflightResult, ProjectPreflightStatus, ProjectPreflightTarget, ProjectSettings, ServerCapabilities } from "./types.js";

/**
 * Runs non-mutating deployment readiness checks against the same target agent
 * path used by deployment.
 */
export async function runProjectPreflight(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, agentManager: AgentManager, vaultSecretIds = new Set<string>()): Promise<ProjectPreflightResult> {
    const deploymentTargets = targetDeploymentServerIds(appSettings, agentManager);
    const checks: ProjectPreflightCheck[] = [
        projectSourceCheck(appSettings),
        vaultSecretReferenceCheck(appSettings, vaultSecretIds),
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

function vaultSecretReferenceCheck(appSettings: ProjectSettings, vaultSecretIds: Set<string>): ProjectPreflightCheck {
    const vaultRefs = (appSettings.envSecrets ?? []).filter((secret) => secret.source === "vault");
    if (!vaultRefs.length) {
        return pass("secrets.vault", "Vault secrets", "No Updater vault secrets are referenced.", undefined, "Deploy will use only project-local secret values.", "No action needed.");
    }

    const missing = vaultRefs.filter((secret) => !secret.vaultSecretId || !vaultSecretIds.has(secret.vaultSecretId));
    if (missing.length) {
        return fail(
            "secrets.vault",
            "Vault secrets",
            `Missing vault secret references: ${missing.map((secret) => `${secret.service}.${secret.key}`).join(", ")}.`,
            undefined,
            "Deploy resolves Updater vault references in the controller before sending the job to the target agent.",
            "Select an existing Updater secret for each missing reference, or switch the entry back to a manual value."
        );
    }

    return pass(
        "secrets.vault",
        "Vault secrets",
        `${vaultRefs.length} vault secret reference(s) are configured.`,
        undefined,
        "Deploy can resolve these references before creating Docker secrets or runtime environment values.",
        "No action needed."
    );
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
            checks.push(check(
                "registry.login",
                "Registry login",
                registry.ok ? registry.skipped ? "warn" : "pass" : "fail",
                registry.detail,
                "The target Docker host must be able to authenticate to the registry before Deploy can push or pull private images.",
                registry.skipped
                    ? "Configure registry credentials if this registry is private. Anonymous public registries can ignore this warning."
                    : registry.ok
                        ? "No action needed."
                        : "Fix the controller registry address, username, or password, then run preflight again.",
                serverId
            ));
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
        return pass("project.source", "Deployment source", "Stored Docker Compose content is configured.", undefined, "Deploy will use the compose YAML saved in this project.", "No action needed.");
    }
    if (appSettings.repositoryUrl?.trim()) {
        return pass("project.source", "Deployment source", "Repository URL is configured.", undefined, "Deploy can clone or update the repository before rendering compose.", "No action needed.");
    }
    return warn("project.source", "Deployment source", "No repository URL is configured; deploy depends on an existing Git checkout at the project path.", undefined, "Deploy will only work if the target path already contains a usable project checkout or stored compose is enough.", "Add a repository URL or keep a maintained checkout at the project path.");
}

function registryConfigurationCheck(appSettings: ProjectSettings, globalSettings: GlobalSettings): ProjectPreflightCheck {
    if (!registryEnabled(appSettings)) {
        return pass("registry.config", "Registry configuration", "Registry deployment is disabled for this project.", undefined, "Deploy will build/use images directly on the target host instead of publishing to a registry.", "No action needed.");
    }

    if (!globalSettings.registryAddress.trim()) {
        return fail("registry.config", "Registry configuration", "Registry deployment is enabled, but no controller registry address is configured.", undefined, "Deploy cannot tag, push, pull, or pass Swarm registry auth without the registry address.", "Set the registry address in global settings.");
    }
    if (globalSettings.registryUsername.trim() && !globalSettings.registryPassword?.trim()) {
        return fail("registry.config", "Registry configuration", "Registry username is configured, but the password is empty.", undefined, "Docker login will fail because Deploy has a username but no password/token.", "Set the registry password/token in global settings.");
    }
    return pass("registry.config", "Registry configuration", `Registry address is configured: ${globalSettings.registryAddress.trim()}.`, undefined, "Deploy can construct registry image names for this project.", "No action needed.");
}

function dockerCheck(serverId: string, docker: DockerTopology): ProjectPreflightCheck {
    if (!docker.available) {
        return fail("docker.available", "Docker", docker.error || "Docker is not available on the target server.", serverId, "Deploy needs Docker access on the selected target server.", "Check the agent connection and Docker daemon on this target.");
    }

    return pass("docker.available", "Docker", `Docker is available on ${serverId} (${docker.mode}).`, serverId, "The target agent can talk to Docker.", "No action needed.");
}

function swarmRoleCheck(serverId: string, appSettings: ProjectSettings, docker: DockerTopology): ProjectPreflightCheck {
    if (appSettings.deploymentStrategy !== "swarm") {
        return pass("docker.mode", "Docker mode", `Compose deployment can run with Docker mode ${docker.mode}.`, serverId, "Single-host Compose deploys can run on a standalone Docker host or a Swarm node.", "No action needed.");
    }

    return docker.mode === "swarm-manager" && docker.swarmControlAvailable !== false
        ? pass("docker.swarm-manager", "Swarm manager", "Target can dispatch Swarm stack deployments.", serverId, "Swarm stacks must be deployed from a manager node.", "No action needed.")
        : fail("docker.swarm-manager", "Swarm manager", `Swarm stack deployment needs a manager target; detected ${docker.mode}.`, serverId, "Workers cannot run docker stack deploy.", "Select a Swarm manager agent for this project or pair one in Servers.");
}

function composeValidationCheck(serverId: string, validation: ComposeValidation): ProjectPreflightCheck {
    if (!validation.valid) {
        return fail("compose.validate", "Compose validation", validation.error || "Docker Compose validation failed.", serverId, "Deploy renders the effective compose file before building or deploying. If this fails, deployment will stop before changing containers.", "Fix the compose YAML, missing files, or missing external resources reported here.");
    }

    return pass("compose.validate", "Compose validation", `Effective ${validation.source === "storedOverride" ? "stored" : "repository"} compose is valid${validation.composeFile ? ` (${validation.composeFile})` : ""}.`, serverId, "Docker Compose accepted the generated deployment model.", "No action needed.");
}

function composeInspectionCheck(serverId: string, inspection: ComposeInspection): ProjectPreflightCheck {
    if (!inspection.services.length) {
        return fail("compose.services", "Compose services", "Compose file does not define any services.", serverId, "Deploy has nothing to build, run, or publish.", "Add at least one service to the compose file.");
    }

    return pass("compose.services", "Compose services", `${inspection.services.length} service(s), ${inspection.networks.length} network(s), ${inspection.volumes.length} volume(s) detected.`, serverId, "Deploy can inspect the generated compose model.", "No action needed.");
}

function swarmImageChecks(serverId: string, appSettings: ProjectSettings, inspection: ComposeInspection): ProjectPreflightCheck[] {
    if (appSettings.deploymentStrategy !== "swarm") {
        return [];
    }

    const deployFromRegistry = Boolean(appSettings.registry?.deployFromRegistry);
    return inspection.services.flatMap((service) => {
        if (service.image) {
            return [pass(`swarm.image.${service.name}`, `Swarm image: ${service.name}`, `${service.name} has image ${service.image}.`, serverId, "Swarm services must be image based because Swarm cannot build from compose build contexts.", "No action needed.")];
        }
        if (deployFromRegistry && service.build) {
            return [pass(`swarm.image.${service.name}`, `Swarm image: ${service.name}`, `${service.name} will be rewritten to a registry image from build context ${service.build}.`, serverId, "Deploy will build/publish the service image, strip the build context, and deploy the stack from the registry image.", "No action needed.")];
        }
        return [fail(`swarm.image.${service.name}`, `Swarm image: ${service.name}`, `${service.name} needs a pullable image, or registry deployment from a build context must be enabled.`, serverId, "Swarm stack deploy will reject services that only have a build context.", "Set an image, or enable registry publish/deploy from registry and provide a build context.")];
    });
}

function bindMountCheck(serverId: string, inspection: ComposeInspection): ProjectPreflightCheck {
    const riskyMounts = inspection.services.flatMap((service) => service.mounts.filter((mount) => !mount.safeForCleanup).map((mount) => `${service.name}: ${mount.raw}`));
    if (!riskyMounts.length && !inspection.storageMappings.length) {
        return pass("compose.bind-mounts", "Bind mounts", "No project-root bind mounts that would block cleanup were detected.", serverId, "Cleanup can safely remove temporary/release checkouts after deployment.", "No action needed.");
    }

    return warn(
        "compose.bind-mounts",
        "Bind mounts",
        `${riskyMounts.length + inspection.storageMappings.length} bind mount(s) may keep temporary or release checkouts in use: ${[...riskyMounts, ...inspection.storageMappings.map((mapping) => `${mapping.service}: ${mapping.source}:${mapping.target}`)].slice(0, 4).join("; ")}.`,
        serverId,
        "Bind mounts that point into Deploy-managed checkout folders can keep those folders busy and make cleanup unsafe.",
        "Move persistent data mounts outside the project checkout, or use the storage override suggestions in settings."
    );
}

function traefikProviderUnknownWarning(serverId: string) {
    return warn(
        "traefik.provider",
        "Traefik provider",
        "Traefik provider mode could not be detected.",
        serverId,
        "Preflight found Traefik, but could not determine whether it watches Docker container labels, Swarm service labels, or both. Deploy can still succeed, but routing depends on Traefik being configured for the same deployment mode as this project.",
        "If routing works now, this warning is informational. To remove it, expose Traefik static config or command args to the Docker inventory, or ensure Traefik is configured with the Docker provider for Compose projects and the Swarm provider for Swarm stacks."
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
            ? pass("traefik.available", "Traefik workload", `Traefik was detected on ${serverId}.`, serverId, "A Traefik container or Swarm service is visible from this target Docker host.", "No action needed.")
            : warn("traefik.available", "Traefik workload", "No local Traefik workload was detected. This can be normal when Traefik runs on another Swarm node, but routing cannot be fully verified from this target.", serverId, "Preflight cannot inspect Traefik's provider/network settings from this node.", "If Traefik runs elsewhere in the Swarm and routing works, this can be ignored. Otherwise run preflight from a manager/node that can see Traefik."),
        traefikProviderModeCheck(serverId, strategy, traefikInventory.providerMode),
        traefikServiceCheck(serverId, serviceName, inspection),
        pass("traefik.network-attachment", "Target network attachment", `Deploy will attach ${serviceName} to ${network} through the generated Traefik compose override.`, serverId, "This check verifies the generated deploy model, not an already-running container.", "No action needed.")
    ];

    const networkDetail = traefikInventory.networkDetails?.find((candidate) => candidate.name === network);
    if (networkDetail) {
        checks.push(pass("traefik.network", "Traefik network", `${network} exists (${[networkDetail.driver, networkDetail.scope].filter(Boolean).join(", ") || "driver unknown"}, attachable=${String(networkDetail.attachable ?? "unknown")}).`, serverId, "The external Docker network required by Traefik is present on this target.", "No action needed."));
        if (strategy === "compose" && networkDetail.driver === "overlay" && networkDetail.attachable === false) {
            checks.push(fail("traefik.network.attachable", "Compose network attach", `${network} is a non-attachable overlay network. Compose containers cannot join it reliably; use Swarm stack deployment or recreate the overlay as attachable.`, serverId, "Docker blocks standalone containers from joining non-attachable Swarm overlay networks.", "Use Swarm stack deployment for this project, or recreate/update the overlay network as attachable."));
        }
    } else if (traefikInventory.networks?.includes(network) || (network === globalSettings.defaultTraefikNetwork && traefikInventory.networkPresent)) {
        checks.push(pass("traefik.network", "Traefik network", `${network} was detected in the Traefik inventory.`, serverId, "Traefik appears to know about the configured network.", "No action needed."));
    } else {
        checks.push(warn("traefik.network", "Traefik network", `${network} was not found in the Traefik inventory. Compose validation also reports missing external networks separately.`, serverId, "Deploy will reference this external network for routing.", "Create the network on the target, select the correct Traefik network, or rely on the Compose validation warning if it already names the missing network."));
    }

    if (traefik.entryPoints && traefikInventory.entryPoints?.length && !csvIncludes(traefikInventory.entryPoints, traefik.entryPoints)) {
        checks.push(warn("traefik.entrypoints", "Traefik entrypoints", `${traefik.entryPoints} is configured for this project, but detected entrypoints are ${traefikInventory.entryPoints.join(", ")}.`, serverId, "A router using an entrypoint Traefik does not expose will not receive traffic.", "Pick one of the detected entrypoints or update Traefik static config."));
    } else {
        checks.push(pass("traefik.entrypoints", "Traefik entrypoints", traefik.entryPoints ? `${traefik.entryPoints} is configured.` : "Default entrypoints will be used.", serverId, "The project has an entrypoint value for generated router labels.", "No action needed."));
    }

    if (traefik.certResolver && traefikInventory.certResolvers?.length && !traefikInventory.certResolvers.includes(traefik.certResolver)) {
        checks.push(warn("traefik.certresolver", "Traefik cert resolver", `${traefik.certResolver} is configured for this project, but detected resolvers are ${traefikInventory.certResolvers.join(", ")}.`, serverId, "A router using an unknown certificate resolver may fail to issue TLS certificates.", "Pick one of the detected resolvers or update Traefik static config."));
    } else {
        checks.push(pass("traefik.certresolver", "Traefik cert resolver", traefik.certResolver ? `${traefik.certResolver} is configured.` : "Default cert resolver will be used.", serverId, "The project has a cert resolver value for generated TLS labels.", "No action needed."));
    }

    return checks;
}

function traefikProviderModeCheck(serverId: string, strategy: "compose" | "swarm", providerMode: ServerCapabilities["traefik"]["providerMode"]): ProjectPreflightCheck {
    if (!providerMode || providerMode === "unknown") {
        return traefikProviderUnknownWarning(serverId);
    }
    if (providerMode === "mixed") {
        return pass("traefik.provider", "Traefik provider", "Traefik has Docker and Swarm provider signals.", serverId, "Traefik appears able to read both container labels and Swarm service labels.", "No action needed.");
    }
    if (strategy === "swarm" && providerMode === "docker") {
        return fail("traefik.provider", "Traefik provider", "Swarm stack labels require Traefik's Swarm provider, but only Docker provider signals were detected.", serverId, "Swarm labels are stored on services under deploy.labels. Traefik's Docker provider watches containers and will ignore those labels.", "Enable Traefik's Swarm provider or deploy this project with Compose.");
    }
    if (strategy === "compose" && providerMode === "swarm") {
        return fail("traefik.provider", "Traefik provider", "Compose container labels require Traefik's Docker provider, but only Swarm provider signals were detected.", serverId, "Compose labels live on containers. Traefik's Swarm provider watches services and will ignore those labels.", "Enable Traefik's Docker provider or deploy this project as a Swarm stack.");
    }
    return pass("traefik.provider", "Traefik provider", `Traefik provider mode ${providerMode} matches ${strategy} deployment.`, serverId, "Traefik is watching the kind of labels Deploy will generate.", "No action needed.");
}

function traefikServiceCheck(serverId: string, serviceName: string, inspection: ComposeInspection | null): ProjectPreflightCheck {
    if (!inspection) {
        return warn("traefik.service", "Target service", "Service existence could not be verified because compose inspection did not finish.", serverId, "Deploy needs the Traefik service name to match a service in the generated compose model.", "Fix the compose inspection error first, then rerun preflight.");
    }

    const service = inspection.services.find((candidate) => candidate.name === serviceName);
    return service
        ? pass("traefik.service", "Target service", `${serviceName} exists in the Compose model.`, serverId, "Generated Traefik labels can be attached to this service.", "No action needed.")
        : fail("traefik.service", "Target service", `${serviceName} is not defined in the Compose model. Set the Traefik service to one of: ${inspection.services.map((candidate) => candidate.name).join(", ") || "none"}.`, serverId, "Traefik labels must be attached to an actual service name.", "Update the project's Traefik service field to match one of the compose services.");
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

function pass(key: string, label: string, detail: string, target?: string, description?: string, recommendation?: string): ProjectPreflightCheck {
    return check(key, label, "pass", detail, description, recommendation, target);
}

function warn(key: string, label: string, detail: string, target?: string, description?: string, recommendation?: string): ProjectPreflightCheck {
    return check(key, label, "warn", detail, description, recommendation, target);
}

function fail(key: string, label: string, detail: string, target?: string, description?: string, recommendation?: string): ProjectPreflightCheck {
    return check(key, label, "fail", detail, description, recommendation, target);
}

function check(key: string, label: string, status: ProjectPreflightStatus, detail: string, description?: string, recommendation?: string, target?: string): ProjectPreflightCheck {
    return {
        key,
        label,
        status,
        detail,
        ...(description ? { description } : {}),
        ...(recommendation ? { recommendation } : {}),
        ...(target ? { target } : {})
    };
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

import { GlobalSettings, ProjectEnvironmentSecret, ProjectPayload, ProjectSettings, TraefikSettings } from "./types.js";

const metadataBegin = "# deploy-metadata: begin";
const metadataEnd = "# deploy-metadata: end";
const metadataPrefix = "# deploy-metadata: ";

interface ProjectComposeMetadata {
    format: "deploy.project-compose";
    version: 1;
    exportedAt: string;
    project: {
        name: string;
        serverId: string;
        serverIds: string[];
        path: string;
    };
    git: {
        repositoryUrl: string;
    };
    deployment: {
        strategy: "compose" | "swarm";
    };
    traefik?: TraefikSettings;
    compose: {
        envSecrets: Array<Pick<ProjectEnvironmentSecret, "service" | "key" | "mode" | "source" | "vaultSecretId" | "infisicalSecretName" | "infisicalSecretPath" | "exposure" | "helperCommand">>;
    };
}

export function renderProjectComposeExport(input: {
    name: string;
    settings: ProjectSettings;
    globalSettings: GlobalSettings;
    compose: string;
}) {
    const metadata: ProjectComposeMetadata = {
        format: "deploy.project-compose",
        version: 1,
        exportedAt: new Date().toISOString(),
        project: {
            name: input.name,
            serverId: input.settings.serverId ?? "local",
            serverIds: targetServerIds(input.settings),
            path: input.settings.path ?? defaultProjectPath(input.globalSettings, input.name)
        },
        git: {
            repositoryUrl: input.settings.repositoryUrl ?? ""
        },
        deployment: {
            strategy: input.settings.deploymentStrategy === "swarm" ? "swarm" : "compose"
        },
        ...(input.settings.traefik ? { traefik: input.settings.traefik } : {}),
        compose: {
            envSecrets: (input.settings.envSecrets ?? []).map((secret) => ({
                service: secret.service,
                key: secret.key,
                mode: secret.mode,
                source: secret.source ?? "inline",
                ...(secret.vaultSecretId ? { vaultSecretId: secret.vaultSecretId } : {}),
                ...(secret.infisicalSecretName ? { infisicalSecretName: secret.infisicalSecretName } : {}),
                ...(secret.infisicalSecretPath ? { infisicalSecretPath: secret.infisicalSecretPath } : {}),
                exposure: secret.mode === "docker_secret" && secret.exposure === "env" ? "env" as const : "file" as const,
                helperCommand: secret.mode === "docker_secret" && secret.exposure === "env" ? secret.helperCommand ?? "" : ""
            }))
        }
    };

    const encoded = Buffer.from(JSON.stringify(metadata), "utf8").toString("base64url");
    const chunks = encoded.match(/.{1,96}/g) ?? [encoded];
    const metadataLines = [
        metadataBegin,
        ...chunks.map((chunk) => `${metadataPrefix}${chunk}`),
        metadataEnd,
        "# This file is valid Docker Compose YAML. Deploy metadata above is ignored by Docker Compose.",
        ""
    ];

    return `${metadataLines.join("\n")}${stripProjectComposeMetadata(input.compose).trim()}\n`;
}

export function parseProjectComposeImport(content: string): ProjectPayload {
    const { metadata, compose } = parseProjectComposeFile(content);
    const projectName = metadata?.project.name || "imported-project";
    const serverIds = metadata?.project.serverIds?.length ? metadata.project.serverIds : [metadata?.project.serverId || "local"];
    const traefik = metadata?.traefik;

    return {
        name: projectName,
        serverId: serverIds[0] ?? "local",
        serverIds,
        repositoryUrl: metadata?.git.repositoryUrl ?? "",
        token: "",
        deployToken: "",
        path: metadata?.project.path ?? "",
        composeOverride: compose.trim(),
        envSecrets: (metadata?.compose.envSecrets ?? []).map((secret) => ({
            service: secret.service,
            key: secret.key,
            value: "",
            mode: secret.mode,
            source: secret.source ?? "inline",
            ...(secret.vaultSecretId ? { vaultSecretId: secret.vaultSecretId } : {}),
            ...(secret.infisicalSecretName ? { infisicalSecretName: secret.infisicalSecretName } : {}),
            ...(secret.infisicalSecretPath ? { infisicalSecretPath: secret.infisicalSecretPath } : {}),
            exposure: secret.mode === "docker_secret" && secret.exposure === "env" ? "env" as const : "file" as const,
            helperCommand: secret.mode === "docker_secret" && secret.exposure === "env" ? secret.helperCommand ?? "" : ""
        })),
        deploymentStrategy: metadata?.deployment.strategy === "swarm" ? "swarm" : "compose",
        traefikEnabled: Boolean(traefik?.enabled),
        traefikHostname: traefik?.hostname ?? "",
        traefikService: traefik?.service ?? "",
        traefikPort: traefik?.port ? String(traefik.port) : "",
        traefikEntryPoints: traefik?.entryPoints ?? "",
        traefikCertResolver: traefik?.certResolver ?? "",
        traefikNetwork: traefik?.network ?? "",
        traefikWildcardCertificate: Boolean(traefik?.wildcardCertificate),
        traefikWildcardDomain: traefik?.wildcardDomain ?? "",
        traefikWebsocket: Boolean(traefik?.websocket),
        traefikRemovePublishedPorts: traefik?.removePublishedPorts !== false,
        project: {
            name: projectName,
            serverId: serverIds[0] ?? "local",
            serverIds,
            path: metadata?.project.path ?? ""
        },
        git: {
            repositoryUrl: metadata?.git.repositoryUrl ?? "",
            token: ""
        },
        deployment: {
            deployToken: "",
            strategy: metadata?.deployment.strategy === "swarm" ? "swarm" : "compose"
        },
        compose: {
            override: compose.trim(),
            envSecrets: (metadata?.compose.envSecrets ?? []).map((secret) => ({
                service: secret.service,
                key: secret.key,
                value: "",
                mode: secret.mode,
                source: secret.source ?? "inline",
                ...(secret.vaultSecretId ? { vaultSecretId: secret.vaultSecretId } : {}),
                ...(secret.infisicalSecretName ? { infisicalSecretName: secret.infisicalSecretName } : {}),
                ...(secret.infisicalSecretPath ? { infisicalSecretPath: secret.infisicalSecretPath } : {}),
                exposure: secret.mode === "docker_secret" && secret.exposure === "env" ? "env" as const : "file" as const,
                helperCommand: secret.mode === "docker_secret" && secret.exposure === "env" ? secret.helperCommand ?? "" : ""
            }))
        },
        traefik: traefik ?? { enabled: false }
    };
}

function parseProjectComposeFile(content: string) {
    const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
    const beginIndex = lines.findIndex((line) => line.trim() === metadataBegin);
    if (beginIndex < 0) {
        return { metadata: null as ProjectComposeMetadata | null, compose: content };
    }

    const endIndex = lines.findIndex((line, index) => index > beginIndex && line.trim() === metadataEnd);
    if (endIndex < 0) {
        throw new Error("Deploy metadata block is missing its end marker.");
    }

    const encoded = lines
        .slice(beginIndex + 1, endIndex)
        .map((line) => line.trim())
        .filter((line) => line.startsWith(metadataPrefix))
        .map((line) => line.slice(metadataPrefix.length).trim())
        .join("");

    const metadata = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as ProjectComposeMetadata;
    if (metadata.format !== "deploy.project-compose" || metadata.version !== 1) {
        throw new Error("Unsupported Deploy project compose metadata.");
    }

    const composeLines = [
        ...lines.slice(0, beginIndex),
        ...lines.slice(endIndex + 1).filter((line, index) => !(index === 0 && line.startsWith("# This file is valid Docker Compose YAML.")))
    ];
    return { metadata, compose: composeLines.join("\n").trim() };
}

function stripProjectComposeMetadata(content: string) {
    return parseProjectComposeFile(content).compose;
}

function targetServerIds(settings: ProjectSettings) {
    const ids = (settings.serverIds?.length ? settings.serverIds : [settings.serverId ?? "local"])
        .map((serverId) => serverId.trim())
        .filter(Boolean);
    return [...new Set(ids.length ? ids : ["local"])];
}

function defaultProjectPath(settings: GlobalSettings, projectName: string) {
    return `${settings.dataRoot.replace(/\/+$/, "")}/${projectName}`;
}

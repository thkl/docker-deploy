import { Express, NextFunction, Request, Response } from "express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer, type AuthInfo } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { AgentManager } from "./agentManager.js";
import { AdminAuth } from "./auth.js";
import { ConfigStore } from "./configStore.js";
import { DeploymentRecord, DeploymentStore } from "./deploymentStore.js";
import { defaultGlobalSettings, GlobalSettingsStore } from "./globalSettingsStore.js";
import { ProjectMcpTokenStore } from "./projectMcpTokenStore.js";
import { ProjectSettings, RuntimeStatus } from "./types.js";

const maxLogCharacters = 100_000;

interface DeploymentMcpDependencies {
    adminAuth: AdminAuth;
    configStore: ConfigStore;
    deploymentStore: DeploymentStore;
    globalSettingsStore: GlobalSettingsStore;
    agentManager: AgentManager;
    projectMcpTokenStore: ProjectMcpTokenStore;
}

/** Registers a read-only MCP endpoint for deployment runtime information. */
export function registerDeploymentMcpRoute(app: Express, dependencies: DeploymentMcpDependencies) {
    const handler = createMcpHandler(({ authInfo }) => {
        const projectScopeId = authInfo?.clientId.startsWith("project:")
            ? authInfo.clientId.slice("project:".length)
            : undefined;
        const server = new McpServer({ name: "docker-deploy", version: "1.0.0" });

        server.registerTool(
            "list_projects",
            {
                description: "List configured projects and the deployment targets assigned to each project.",
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
            },
            async () => {
                const projects = Object.entries(dependencies.configStore.readConfig())
                    .filter(([, settings]) => !projectScopeId || settings.id === projectScopeId)
                    .map(([name, settings]) => ({
                        id: settings.id,
                        name,
                        serverIds: targetServerIds(settings),
                        deploymentStrategy: settings.deploymentStrategy === "swarm" ? "swarm" : "compose"
                    }));
                return textResult(projects);
            }
        );

        server.registerTool(
            "get_project_containers",
            {
                description: "Get the current runtime state and Compose containers or Swarm services for a project on each deployment target. A serverId can limit the result to one configured target.",
                inputSchema: z.object({
                    project: z.string().min(1).describe("Project name or project ID."),
                    serverId: z.string().min(1).optional().describe("Optional deployment target ID from list_projects.")
                }),
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
            },
            async ({ project, serverId }) => {
                const resolved = resolveAuthorizedProject(dependencies.configStore, project, projectScopeId);
                if (!resolved) {
                    return projectLookupError(projectScopeId);
                }

                const serverIds = requestedTargets(targetServerIds(resolved.settings), serverId);
                if (!serverIds) {
                    return errorResult(`Server '${serverId}' is not configured as a target for project '${resolved.name}'.`);
                }

                const { settings, globalSettings } = inspectionSettings(resolved.settings, dependencies.globalSettingsStore);
                const results = await Promise.all(serverIds.map(async (targetId) => {
                    try {
                        const status = await dependencies.agentManager.getClient(targetId).inspectStatus(resolved.name, settings, globalSettings);
                        return { serverId: targetId, ...publicRuntimeStatus(status, resolved.settings.deploymentStrategy === "swarm") };
                    } catch (error) {
                        return {
                            serverId: targetId,
                            status: "error" as const,
                            checkedAt: new Date().toISOString(),
                            services: [],
                            error: errorMessage(error, "Could not inspect project runtime status.")
                        };
                    }
                }));

                return textResult({ project: { id: resolved.settings.id, name: resolved.name }, results });
            }
        );

        server.registerTool(
            "get_project_container_logs",
            {
                description: "Read recent logs from a container or service belonging to a project. The target must be assigned to the project. Tail is limited to 10–2000 lines.",
                inputSchema: z.object({
                    project: z.string().min(1).describe("Project name or project ID."),
                    container: z.string().min(1).describe("Container ID, container name, or service name from get_project_containers."),
                    serverId: z.string().min(1).optional().describe("Optional deployment target ID from list_projects."),
                    tail: z.number().int().min(10).max(2000).default(200).describe("Number of recent log lines to return (10–2000).")
                }),
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
            },
            async ({ project, container, serverId, tail }) => {
                const resolved = resolveAuthorizedProject(dependencies.configStore, project, projectScopeId);
                if (!resolved) {
                    return projectLookupError(projectScopeId);
                }

                const serverIds = requestedTargets(targetServerIds(resolved.settings), serverId);
                if (!serverIds) {
                    return errorResult(`Server '${serverId}' is not configured as a target for project '${resolved.name}'.`);
                }

                const { settings, globalSettings } = inspectionSettings(resolved.settings, dependencies.globalSettingsStore);
                const results = await Promise.all(serverIds.map(async (targetId) => {
                    try {
                        const client = dependencies.agentManager.getClient(targetId);
                        const runtime = await client.inspectStatus(resolved.name, settings, globalSettings);
                        const selected = runtime.services.find((service) => matchesContainer(service, container.trim()));
                        if (!selected) {
                            return { serverId: targetId, error: "No matching container or service was found for this project." };
                        }

                        const logs = resolved.settings.deploymentStrategy === "swarm"
                            ? await client.runtimeLogs(resolved.name, settings, globalSettings, selected.service, tail)
                            : selected.containerId
                                ? await client.containerLogs(selected.containerId, tail)
                                : null;

                        if (!logs) {
                            return { serverId: targetId, service: selected.service, error: "The matching container has no container ID, so its logs are unavailable." };
                        }

                        const output = clampLog(logs.output);
                        return {
                            serverId: targetId,
                            service: selected.service,
                            containerName: selected.containerName,
                            ...(resolved.settings.deploymentStrategy === "swarm"
                                ? { serviceId: selected.containerId }
                                : { containerId: selected.containerId }),
                            logTarget: logs.containerId,
                            tail: logs.tail,
                            checkedAt: logs.checkedAt,
                            output: output.value,
                            truncated: output.truncated
                        };
                    } catch (error) {
                        return { serverId: targetId, error: errorMessage(error, "Could not read container logs.") };
                    }
                }));

                return textResult({ project: { id: resolved.settings.id, name: resolved.name }, results });
            }
        );

        server.registerTool(
            "get_last_deployment_log",
            {
                description: "Get the most recent deployment summary and log for a project. The log is returned from the end and capped at 100,000 characters.",
                inputSchema: z.object({
                    project: z.string().min(1).describe("Project name or project ID."),
                    tailLines: z.number().int().min(1).max(2000).default(500).describe("Maximum number of recent log lines to return (1–2000).")
                }),
                annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
            },
            async ({ project, tailLines }) => {
                const resolved = resolveAuthorizedProject(dependencies.configStore, project, projectScopeId);
                if (!resolved) {
                    return projectLookupError(projectScopeId);
                }

                const deployment = dependencies.deploymentStore.latest(resolved.settings.id ?? resolved.name);
                if (!deployment) {
                    return textResult({ project: { id: resolved.settings.id, name: resolved.name }, deployment: null });
                }

                const logTail = tailDeploymentLog(deployment.log, tailLines);
                return textResult({
                    project: { id: resolved.settings.id, name: resolved.name },
                    deployment: {
                        id: deployment.id,
                        runId: deployment.runId,
                        serverId: deployment.serverId,
                        trigger: deployment.trigger,
                        status: deployment.status,
                        phase: deployment.phase,
                        startedAt: deployment.startedAt,
                        finishedAt: deployment.finishedAt,
                        exitCode: deployment.exitCode,
                        error: deployment.error,
                        targets: deployment.targets?.map(publicDeploymentTarget),
                        log: logTail.value,
                        logTruncated: logTail.truncated
                    }
                });
            }
        );

        return server;
    }, { responseMode: "json" });

    const nodeHandler = toNodeHandler(handler);
    app.all("/mcp", (req: Request, res: Response, next: NextFunction) => {
        authenticateMcpRequest(req, res, next, dependencies);
    }, (req: Request, res: Response) => {
        void nodeHandler(req, res, req.body);
    });
}

type AuthenticatedMcpRequest = Request & { auth?: AuthInfo };

function authenticateMcpRequest(req: Request, res: Response, next: NextFunction, dependencies: DeploymentMcpDependencies) {
    const token = readBearerToken(req);
    if (dependencies.adminAuth.required && token && dependencies.adminAuth.isValidToken(token)) {
        (req as AuthenticatedMcpRequest).auth = { token, clientId: "admin", scopes: ["mcp:all"] };
        next();
        return;
    }

    const projectId = dependencies.projectMcpTokenStore.projectIdForToken(token);
    if (!projectId || !token) {
        res.setHeader("WWW-Authenticate", "Bearer");
        res.status(401).json({ error: "A valid project MCP token or configured admin token is required." });
        return;
    }

    (req as AuthenticatedMcpRequest).auth = { token, clientId: `project:${projectId}`, scopes: ["project:read"] };
    next();
}

function inspectionSettings(settings: ProjectSettings, globalSettingsStore: GlobalSettingsStore) {
    const globalSettings = globalSettingsStore.readSettings();
    return {
        settings: {
            ...(settings.id ? { id: settings.id } : {}),
            ...(settings.path ? { path: settings.path } : {}),
            ...(settings.deploymentStrategy ? { deploymentStrategy: settings.deploymentStrategy } : {})
        } satisfies ProjectSettings,
        globalSettings: {
            ...defaultGlobalSettings,
            dataRoot: globalSettings.dataRoot
        }
    };
}

function targetServerIds(settings: ProjectSettings) {
    const ids = (settings.serverIds?.length ? settings.serverIds : [settings.serverId ?? "local"])
        .map((serverId) => serverId.trim())
        .filter(Boolean);
    return [...new Set(ids.length ? ids : ["local"])];
}

function requestedTargets(targets: string[], requested?: string) {
    if (!requested) {
        return targets;
    }
    return targets.includes(requested) ? [requested] : null;
}

function resolveAuthorizedProject(configStore: ConfigStore, projectRef: string, projectScopeId?: string) {
    const project = configStore.resolveProject(projectRef.trim());
    return project && (!projectScopeId || project.settings.id === projectScopeId) ? project : undefined;
}

function projectLookupError(projectScopeId?: string) {
    return errorResult(projectScopeId ? "This MCP token is not authorized for the requested project." : "The requested project was not found.");
}

function readBearerToken(req: Request) {
    const header = req.headers.authorization ?? "";
    const value = Array.isArray(header) ? header[0] : header;
    return value.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
}

function matchesContainer(service: RuntimeStatus["services"][number], value: string) {
    return service.service === value || service.containerId === value || service.containerName === value;
}

function publicRuntimeStatus(status: RuntimeStatus, isSwarm: boolean) {
    return {
        status: status.status,
        checkedAt: status.checkedAt,
        services: status.services.map(({ containerId, ...service }) => ({
            ...service,
            ...(containerId ? { [isSwarm ? "serviceId" : "containerId"]: containerId } : {})
        })),
        ...(status.scaleToZero ? { scaleToZero: status.scaleToZero } : {}),
        ...(status.error ? { error: status.error } : {})
    };
}

function publicDeploymentTarget(target: DeploymentRecord) {
    return {
        serverId: target.serverId,
        status: target.status,
        phase: target.phase,
        startedAt: target.startedAt,
        finishedAt: target.finishedAt,
        exitCode: target.exitCode,
        error: target.error
    };
}

function tailDeploymentLog(log: string, lines: number) {
    const allLines = log.split(/\r?\n/);
    const lineTail = allLines.slice(-lines).join("\n");
    const clamped = clampLog(lineTail);
    return { ...clamped, truncated: clamped.truncated || allLines.length > lines };
}

function clampLog(output: string) {
    if (output.length <= maxLogCharacters) {
        return { value: output, truncated: false };
    }
    return { value: output.slice(-maxLogCharacters), truncated: true };
}

function textResult(value: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string) {
    return { content: [{ type: "text" as const, text: message }], isError: true };
}

function errorMessage(error: unknown, fallback: string) {
    return error instanceof Error && error.message ? error.message : fallback;
}

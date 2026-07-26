import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import express, { Request, Response, NextFunction } from 'express';
import { exec } from "node:child_process";
import crypto from 'crypto';

interface AuthenticatedRequest extends Request {
    rawBody?: Buffer;
}

interface ProjectSettings {
    token: string;
    path?: string;
    traefik?: TraefikSettings;
}

type ProjectConfig = Record<string, ProjectSettings>;

interface TraefikSettings {
    enabled: boolean;
    hostname?: string;
    service?: string;
    port?: number;
    entryPoints?: string;
    certResolver?: string;
    network?: string;
    websocket?: boolean;
}

class App {

    app = express();
    port: number;
    configPath = join("./data", "config.json");

    constructor() {
        this.port = parseInt(process.env.PORT || "3999");
    }


    verifySignature(repoToken: string, req: Request, res: Response) {

        try {

            const authReq = req as AuthenticatedRequest;
            // 1. Grab the Standard Webhook Spec headers sent by GitLab
            const webhookId = req.headers['webhook-id'] as string;
            const webhookTimestamp = req.headers['webhook-timestamp'] as string;
            const webhookSignatureHeader = req.headers['webhook-signature'] as string;
            const secretKeyRaw = repoToken.replace(/^whsec_/, '');
            const secretBuffer = Buffer.from(secretKeyRaw, 'base64');
            const rawBodyString = authReq.rawBody ? authReq.rawBody.toString('utf8') : '';
            const messageToSign = `${webhookId}.${webhookTimestamp}.${rawBodyString}`;
            const computedHmac = crypto
                .createHmac('sha256', secretBuffer)
                .update(messageToSign)
                .digest('base64');

            const expectedSignature = `v1,${computedHmac}`;
            const signaturesReceived = webhookSignatureHeader.split(' ');
            let isSignatureValid = false;

            for (const sig of signaturesReceived) {
                if (sig.length === expectedSignature.length &&
                    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSignature))) {
                    isSignatureValid = true;
                    break;
                }
            }

            if (!isSignatureValid) {
                console.warn('Unauthorized: Invalid cryptographic signature.');
                res.status(403).send('Forbidden: Invalid webhook signature.');
                return false;
            }

            const currentTimestamp = Math.floor(Date.now() / 1000);
            const requestTimestamp = parseInt(webhookTimestamp, 10);
            if (Math.abs(currentTimestamp - requestTimestamp) > 300) {
                console.warn('Unauthorized: Webhook timestamp drifted too far (Replay Attack protection).');
                res.status(403).send('Forbidden: Expired signature timestamp.');
                return false;
            }

        } catch (err) {
            console.error('Signature calculation crash:', err);
            res.status(500).send('Internal validation error.');
            return false;
        }
        return true;
    }


    fetchProfile(app: string) {
        try {
            return this.readConfig()[app];
        } catch (e) {
            console.log("Error reading config")
        }
    }

    readConfig(): ProjectConfig {
        if (!existsSync(this.configPath)) {
            return {};
        }

        const content = readFileSync(this.configPath, "utf8").trim();
        if (!content) {
            return {};
        }

        const parsed = JSON.parse(content);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Config must be an object keyed by repository name.");
        }

        return parsed as ProjectConfig;
    }

    writeConfig(config: ProjectConfig) {
        mkdirSync(join("./data"), { recursive: true });
        writeFileSync(this.configPath, `${JSON.stringify(config, null, 2)}\n`);
    }

    maskToken(token: string) {
        if (token.length <= 8) {
            return "********";
        }

        return `${token.slice(0, 6)}...${token.slice(-4)}`;
    }

    normalizeProjectName(name?: string) {
        const repoName = name?.trim();
        if (!repoName) {
            throw new Error("Repository name is required.");
        }

        if (!/^[a-zA-Z0-9._-]+$/.test(repoName)) {
            throw new Error("Repository name can only contain letters, numbers, dots, underscores, and hyphens.");
        }

        return repoName;
    }

    normalizeOptionalName(name?: string) {
        const value = name?.trim();
        if (!value) {
            return "";
        }

        if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
            throw new Error("Names can only contain letters, numbers, dots, underscores, and hyphens.");
        }

        return value;
    }

    normalizeTraefikSettings(body: {
        traefikEnabled?: boolean;
        traefikHostname?: string;
        traefikService?: string;
        traefikPort?: string | number;
        traefikEntryPoints?: string;
        traefikCertResolver?: string;
        traefikNetwork?: string;
        traefikWebsocket?: boolean;
    }): TraefikSettings | undefined {
        if (!body.traefikEnabled) {
            return undefined;
        }

        const hostname = body.traefikHostname?.trim();
        if (!hostname) {
            throw new Error("Traefik hostname is required when Traefik is enabled.");
        }

        if (!/^[a-zA-Z0-9.-]+$/.test(hostname)) {
            throw new Error("Traefik hostname can only contain letters, numbers, dots, and hyphens.");
        }

        const port = Number(body.traefikPort);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error("Traefik service port must be a number between 1 and 65535.");
        }

        const entryPoints = body.traefikEntryPoints?.trim() || "websecure";
        const certResolver = body.traefikCertResolver?.trim() || "letsencrypt";
        const network = body.traefikNetwork?.trim() || "proxy";
        const service = this.normalizeOptionalName(body.traefikService);

        if (!/^[a-zA-Z0-9._,-]+$/.test(entryPoints)) {
            throw new Error("Traefik entry points can only contain letters, numbers, dots, underscores, hyphens, and commas.");
        }

        if (!/^[a-zA-Z0-9._-]+$/.test(certResolver)) {
            throw new Error("Traefik cert resolver can only contain letters, numbers, dots, underscores, and hyphens.");
        }

        if (!/^[a-zA-Z0-9._-]+$/.test(network)) {
            throw new Error("Traefik network can only contain letters, numbers, dots, underscores, and hyphens.");
        }

        return {
            enabled: true,
            hostname,
            ...(service ? { service } : {}),
            port,
            entryPoints,
            certResolver,
            network,
            websocket: Boolean(body.traefikWebsocket)
        };
    }

    shellQuote(value: string | number | boolean) {
        return `'${String(value).replace(/'/g, `'\\''`)}'`;
    }

    traefikRouterName(repoName: string) {
        return repoName.replace(/[^a-zA-Z0-9_-]/g, "-");
    }

    yamlQuote(value: string | number | boolean) {
        return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }

    renderTraefikOverrideScript(repoName: string, settings: ProjectSettings) {
        const traefik = settings.traefik;
        if (!traefik?.enabled) {
            return "";
        }

        const serviceName = traefik.service || repoName;
        const routerName = this.traefikRouterName(repoName);
        const network = traefik.network || "proxy";
        const rule = `Host(\`${traefik.hostname}\`)`;
        const websocketLabels = traefik.websocket
            ? `
      "traefik.http.middlewares.${routerName}-websocket.headers.customrequestheaders.Connection": "Upgrade"
      "traefik.http.middlewares.${routerName}-websocket.headers.customrequestheaders.Upgrade": "websocket"
      "traefik.http.routers.${routerName}.middlewares": "${routerName}-websocket@docker"`
            : "";

        const overrideContent = `services:
  ${this.yamlQuote(serviceName)}:
    labels:
      "traefik.enable": "true"
      "traefik.docker.network": ${this.yamlQuote(network)}
      "traefik.http.routers.${routerName}.rule": ${this.yamlQuote(rule)}
      "traefik.http.routers.${routerName}.entrypoints": ${this.yamlQuote(traefik.entryPoints || "websecure")}
      "traefik.http.routers.${routerName}.tls": "true"
      "traefik.http.routers.${routerName}.tls.certresolver": ${this.yamlQuote(traefik.certResolver || "letsencrypt")}
      "traefik.http.services.${routerName}.loadbalancer.server.port": ${this.yamlQuote(traefik.port || 80)}
${websocketLabels}
    networks:
      - ${this.yamlQuote(network)}

networks:
  ${this.yamlQuote(network)}:
    external: true
`;

        return `
                echo "--> Writing Traefik compose override..."
                cat > docker-compose.traefik.yml << 'TRAEFIK_EOF'
${overrideContent}TRAEFIK_EOF
                COMPOSE_FILES="-f $COMPOSE_FILE -f docker-compose.traefik.yml"`;
    }

    renderAdminPage() {
        return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Webhook Updater Projects</title>
    <style>
        :root {
            color-scheme: light;
            --bg: #f5f7f4;
            --panel: #ffffff;
            --ink: #18201c;
            --muted: #657068;
            --line: #d9e0d8;
            --accent: #176b52;
            --accent-dark: #0f4d3b;
            --danger: #a43f35;
            --shadow: 0 18px 50px rgba(24, 32, 28, 0.12);
        }

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            min-height: 100vh;
            background: var(--bg);
            color: var(--ink);
            font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            line-height: 1.5;
        }

        main {
            width: min(1120px, calc(100% - 32px));
            margin: 0 auto;
            padding: 40px 0;
        }

        header {
            display: flex;
            justify-content: space-between;
            align-items: flex-end;
            gap: 24px;
            margin-bottom: 28px;
        }

        h1 {
            margin: 0;
            font-size: clamp(2rem, 5vw, 3.6rem);
            line-height: 1;
            letter-spacing: 0;
        }

        .subtitle {
            margin: 12px 0 0;
            max-width: 64ch;
            color: var(--muted);
        }

        .status {
            min-width: 180px;
            padding: 10px 14px;
            border: 1px solid var(--line);
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.72);
            color: var(--muted);
            text-align: center;
            font-size: 0.92rem;
        }

        .layout {
            display: grid;
            grid-template-columns: minmax(0, 1fr) 360px;
            gap: 24px;
            align-items: start;
        }

        section {
            background: var(--panel);
            border-radius: 8px;
            box-shadow: var(--shadow);
            overflow: hidden;
        }

        .section-header {
            display: flex;
            justify-content: space-between;
            gap: 16px;
            padding: 20px 22px;
            border-bottom: 1px solid var(--line);
        }

        h2 {
            margin: 0;
            font-size: 1rem;
        }

        .count {
            color: var(--muted);
            font-size: 0.92rem;
        }

        table {
            width: 100%;
            border-collapse: collapse;
        }

        th,
        td {
            padding: 16px 22px;
            border-bottom: 1px solid var(--line);
            text-align: left;
            vertical-align: top;
        }

        th {
            color: var(--muted);
            font-size: 0.78rem;
            font-weight: 700;
            text-transform: uppercase;
        }

        tr:last-child td {
            border-bottom: 0;
        }

        .repo {
            font-weight: 750;
        }

        code {
            display: inline-block;
            max-width: 36ch;
            overflow-wrap: anywhere;
            color: #31443b;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 0.88rem;
        }

        .project-actions {
            width: 92px;
        }

        .empty {
            padding: 42px 22px;
            color: var(--muted);
            text-align: center;
        }

        form {
            padding: 22px;
        }

        label {
            display: grid;
            gap: 7px;
            margin-bottom: 16px;
            color: #34423a;
            font-size: 0.9rem;
            font-weight: 650;
        }

        .checkbox-label {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .checkbox-label input {
            width: 18px;
            min-height: 18px;
            accent-color: var(--accent);
        }

        input {
            width: 100%;
            min-height: 42px;
            border: 1px solid #c8d2cb;
            border-radius: 7px;
            padding: 10px 12px;
            color: var(--ink);
            font: inherit;
            background: #fbfcfb;
        }

        input:focus {
            outline: 3px solid rgba(23, 107, 82, 0.18);
            border-color: var(--accent);
        }

        .checkbox-label input {
            width: 18px;
            min-height: 18px;
        }

        fieldset {
            margin: 20px 0 16px;
            padding: 16px;
            border: 1px solid var(--line);
            border-radius: 8px;
        }

        legend {
            padding: 0 6px;
            color: var(--ink);
            font-size: 0.92rem;
            font-weight: 750;
        }

        .fieldset-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 0 12px;
        }

        .full-field {
            grid-column: 1 / -1;
        }

        .hint {
            margin-top: -8px;
            margin-bottom: 16px;
            color: var(--muted);
            font-size: 0.84rem;
        }

        button {
            width: 100%;
            min-height: 44px;
            border: 0;
            border-radius: 7px;
            background: var(--accent);
            color: white;
            font: inherit;
            font-weight: 750;
            cursor: pointer;
        }

        button:hover {
            background: var(--accent-dark);
        }

        .icon-button {
            width: auto;
            min-height: 34px;
            padding: 7px 11px;
            background: #e7eee9;
            color: var(--accent-dark);
            font-size: 0.86rem;
        }

        .icon-button:hover {
            background: #d9e6df;
        }

        .form-actions {
            display: grid;
            grid-template-columns: 1fr auto;
            gap: 10px;
            align-items: center;
        }

        .secondary-button {
            display: none;
            width: auto;
            min-width: 92px;
            padding: 0 14px;
            border: 1px solid var(--line);
            background: white;
            color: var(--accent-dark);
        }

        .secondary-button.visible {
            display: inline-block;
        }

        .secondary-button:hover {
            background: #f0f5f2;
        }

        button:disabled {
            cursor: wait;
            opacity: 0.7;
        }

        .message {
            min-height: 22px;
            margin-top: 14px;
            color: var(--muted);
            font-size: 0.9rem;
        }

        .message.error {
            color: var(--danger);
        }

        @media (max-width: 820px) {
            main {
                width: min(100% - 24px, 680px);
                padding: 24px 0;
            }

            header,
            .layout {
                display: block;
            }

            .status {
                margin-top: 18px;
                text-align: left;
            }

            section + section {
                margin-top: 20px;
            }

            table,
            thead,
            tbody,
            tr,
            th,
            td {
                display: block;
            }

            thead {
                position: absolute;
                width: 1px;
                height: 1px;
                overflow: hidden;
                clip: rect(0 0 0 0);
            }

            tr {
                padding: 14px 0;
                border-bottom: 1px solid var(--line);
            }

            tr:last-child {
                border-bottom: 0;
            }

            td {
                border: 0;
                padding: 5px 22px;
            }

            td::before {
                display: block;
                margin-bottom: 2px;
                color: var(--muted);
                font-size: 0.72rem;
                font-weight: 750;
                text-transform: uppercase;
                content: attr(data-label);
            }

            .fieldset-grid {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <main>
        <header>
            <div>
                <h1>Projects</h1>
                <p class="subtitle">Configured GitLab repositories that can trigger build-first Docker Compose updates.</p>
            </div>
            <div class="status" id="status">Loading projects</div>
        </header>

        <div class="layout">
            <section aria-labelledby="projects-heading">
                <div class="section-header">
                    <h2 id="projects-heading">Configured Projects</h2>
                    <span class="count" id="count">0 projects</span>
                </div>
                <div id="project-list" class="empty">Loading configured projects...</div>
            </section>

            <section aria-labelledby="add-heading">
                <div class="section-header">
                    <h2 id="add-heading">Add Project</h2>
                </div>
                <form id="project-form">
                    <label>
                        Repository name
                        <input name="name" required autocomplete="off" placeholder="my-service">
                    </label>
                    <label>
                        Webhook secret token
                        <input name="token" required autocomplete="off" placeholder="whsec_...">
                    </label>
                    <p class="hint" id="token-hint">Required for new projects.</p>
                    <label>
                        Host path
                        <input name="path" autocomplete="off" placeholder="/root/docker-apps/my-service">
                    </label>
                    <p class="hint">Leave path empty to use /root/docker-apps/&lt;repository name&gt;.</p>
                    <fieldset>
                        <legend>Traefik reverse proxy</legend>
                        <label class="checkbox-label">
                            <input type="checkbox" name="traefikEnabled">
                            Enable Traefik labels
                        </label>
                        <label class="full-field">
                            Hostname
                            <input name="traefikHostname" autocomplete="off" placeholder="app.example.com">
                        </label>
                        <div class="fieldset-grid">
                            <label>
                                Compose service
                                <input name="traefikService" autocomplete="off" placeholder="web">
                            </label>
                            <label>
                                Internal port
                                <input name="traefikPort" type="number" min="1" max="65535" autocomplete="off" placeholder="3000">
                            </label>
                            <label>
                                Entry points
                                <input name="traefikEntryPoints" autocomplete="off" placeholder="websecure">
                            </label>
                            <label>
                                Cert resolver
                                <input name="traefikCertResolver" autocomplete="off" placeholder="letsencrypt">
                            </label>
                            <label class="full-field">
                                Docker network
                                <input name="traefikNetwork" autocomplete="off" placeholder="proxy">
                            </label>
                        </div>
                        <label class="checkbox-label">
                            <input type="checkbox" name="traefikWebsocket">
                            Add websocket upgrade headers
                        </label>
                    </fieldset>
                    <div class="form-actions">
                        <button type="submit" id="submit-button">Save project</button>
                        <button type="button" class="secondary-button" id="cancel-edit">Cancel</button>
                    </div>
                    <div class="message" id="message" role="status"></div>
                </form>
            </section>
        </div>
    </main>

    <script>
        const list = document.getElementById("project-list");
        const count = document.getElementById("count");
        const status = document.getElementById("status");
        const form = document.getElementById("project-form");
        const message = document.getElementById("message");
        const submitButton = document.getElementById("submit-button");
        const cancelEditButton = document.getElementById("cancel-edit");
        const tokenHint = document.getElementById("token-hint");
        const formTitle = document.getElementById("add-heading");
        let editingName = "";
        let currentProjects = [];

        function escapeHtml(value) {
            return String(value).replace(/[&<>"']/g, (char) => ({
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#039;"
            }[char]));
        }

        function renderProjects(projects) {
            currentProjects = projects;
            count.textContent = projects.length === 1 ? "1 project" : projects.length + " projects";
            status.textContent = "Ready";

            if (!projects.length) {
                list.className = "empty";
                list.textContent = "No projects are configured yet.";
                return;
            }

            list.className = "";
            list.innerHTML = '<table><thead><tr><th>Repository</th><th>Path</th><th>Proxy</th><th>Token</th><th class="project-actions">Action</th></tr></thead><tbody>' +
                projects.map((project) => '<tr>' +
                    '<td data-label="Repository"><div class="repo">' + escapeHtml(project.name) + '</div></td>' +
                    '<td data-label="Path"><code>' + escapeHtml(project.path || "/root/docker-apps/" + project.name) + '</code></td>' +
                    '<td data-label="Proxy">' + (project.traefik && project.traefik.enabled ? '<code>' + escapeHtml(project.traefik.hostname) + '</code>' : '<span class="count">Off</span>') + '</td>' +
                    '<td data-label="Token"><code>' + escapeHtml(project.token) + '</code></td>' +
                    '<td data-label="Action"><button class="icon-button" type="button" data-edit="' + escapeHtml(project.name) + '">Edit</button></td>' +
                '</tr>').join("") +
                '</tbody></table>';
        }

        function setAddMode() {
            editingName = "";
            form.reset();
            formTitle.textContent = "Add Project";
            submitButton.textContent = "Save project";
            cancelEditButton.classList.remove("visible");
            form.elements.token.required = true;
            tokenHint.textContent = "Required for new projects.";
            message.className = "message";
            message.textContent = "";
        }

        function setEditMode(project) {
            editingName = project.name;
            formTitle.textContent = "Edit Project";
            submitButton.textContent = "Update project";
            cancelEditButton.classList.add("visible");
            form.elements.name.value = project.name;
            form.elements.token.value = "";
            form.elements.token.required = false;
            form.elements.path.value = project.path || "";
            form.elements.traefikEnabled.checked = Boolean(project.traefik && project.traefik.enabled);
            form.elements.traefikHostname.value = (project.traefik && project.traefik.hostname) || "";
            form.elements.traefikService.value = (project.traefik && project.traefik.service) || "";
            form.elements.traefikPort.value = (project.traefik && project.traefik.port) || "";
            form.elements.traefikEntryPoints.value = (project.traefik && project.traefik.entryPoints) || "";
            form.elements.traefikCertResolver.value = (project.traefik && project.traefik.certResolver) || "";
            form.elements.traefikNetwork.value = (project.traefik && project.traefik.network) || "";
            form.elements.traefikWebsocket.checked = Boolean(project.traefik && project.traefik.websocket);
            tokenHint.textContent = "Leave blank to keep the current webhook secret.";
            message.className = "message";
            message.textContent = "Editing " + project.name + ".";
            form.elements.name.focus();
        }

        async function loadProjects() {
            status.textContent = "Loading projects";
            const response = await fetch("/api/projects");
            if (!response.ok) {
                throw new Error("Could not load projects.");
            }
            const projects = await response.json();
            renderProjects(projects);
        }

        list.addEventListener("click", (event) => {
            const button = event.target.closest("[data-edit]");
            if (!button) {
                return;
            }

            const project = currentProjects.find((item) => item.name === button.dataset.edit);
            if (project) {
                setEditMode(project);
            }
        });

        cancelEditButton.addEventListener("click", setAddMode);

        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const button = form.querySelector("button");
            const formData = new FormData(form);
            const payload = {
                name: String(formData.get("name") || "").trim(),
                token: String(formData.get("token") || "").trim(),
                path: String(formData.get("path") || "").trim(),
                traefikEnabled: formData.has("traefikEnabled"),
                traefikHostname: String(formData.get("traefikHostname") || "").trim(),
                traefikService: String(formData.get("traefikService") || "").trim(),
                traefikPort: String(formData.get("traefikPort") || "").trim(),
                traefikEntryPoints: String(formData.get("traefikEntryPoints") || "").trim(),
                traefikCertResolver: String(formData.get("traefikCertResolver") || "").trim(),
                traefikNetwork: String(formData.get("traefikNetwork") || "").trim(),
                traefikWebsocket: formData.has("traefikWebsocket")
            };

            button.disabled = true;
            message.className = "message";
            message.textContent = editingName ? "Updating project..." : "Saving project...";
            const wasEditing = Boolean(editingName);

            try {
                const response = await fetch(editingName ? "/api/projects/" + encodeURIComponent(editingName) : "/api/projects", {
                    method: editingName ? "PUT" : "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                const result = await response.json();
                if (!response.ok) {
                    throw new Error(result.error || (editingName ? "Could not update project." : "Could not save project."));
                }

                setAddMode();
                message.textContent = wasEditing ? "Project updated." : "Project saved.";
                await loadProjects();
            } catch (error) {
                message.className = "message error";
                message.textContent = error instanceof Error ? error.message : "Could not save project.";
            } finally {
                button.disabled = false;
            }
        });

        loadProjects().catch((error) => {
            status.textContent = "Config unavailable";
            list.className = "empty";
            list.textContent = error instanceof Error ? error.message : "Could not load projects.";
        });
    </script>
</body>
</html>`;
    }

    init() {

        this.app.use(express.json({
            verify: (req: Request, res: Response, buf: Buffer) => {
                if (buf && buf.length) {
                    (req as AuthenticatedRequest).rawBody = buf;
                }
            }
        }));

        this.app.use(express.urlencoded({
            extended: true,
            verify: (req: Request, res: Response, buf: Buffer) => {
                if (buf && buf.length) {
                    (req as AuthenticatedRequest).rawBody = buf;
                }
            }
        }));


        this.app.get('/health', (req: Request, res: Response) => {
            res.status(200).send('I am alive');
        });

        this.app.get('/', (req: Request, res: Response) => {
            res.type("html").send(this.renderAdminPage());
        });

        this.app.get('/api/projects', (req: Request, res: Response, next: NextFunction) => {
            try {
                const projects = Object.entries(this.readConfig())
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([name, settings]) => ({
                        name,
                        path: settings.path ?? "",
                        token: this.maskToken(settings.token ?? ""),
                        traefik: settings.traefik ?? { enabled: false }
                    }));

                res.json(projects);
            } catch (error) {
                next(error);
            }
        });

        this.app.post('/api/projects', (req: Request, res: Response, next: NextFunction) => {
            try {
                const { name, token, path } = req.body as { name?: string; token?: string; path?: string };
                const repoName = this.normalizeProjectName(name);
                const repoToken = token?.trim();
                const repoPath = path?.trim();
                const traefik = this.normalizeTraefikSettings(req.body);

                if (!repoToken) {
                    res.status(400).json({ error: "Webhook secret token is required." });
                    return;
                }

                const config = this.readConfig();
                config[repoName] = {
                    token: repoToken,
                    ...(repoPath ? { path: repoPath } : {}),
                    ...(traefik ? { traefik } : {})
                };
                this.writeConfig(config);

                res.status(201).json({ name: repoName });
            } catch (error) {
                res.status(400).json({ error: error instanceof Error ? error.message : "Could not save project." });
            }
        });

        this.app.put('/api/projects/:name', (req: Request, res: Response) => {
            try {
                const rawCurrentName = req.params.name;
                const currentName = this.normalizeProjectName(Array.isArray(rawCurrentName) ? rawCurrentName[0] : rawCurrentName);
                const { name, token, path } = req.body as { name?: string; token?: string; path?: string };
                const nextName = this.normalizeProjectName(name);
                const nextToken = token?.trim();
                const nextPath = path?.trim();
                const traefik = this.normalizeTraefikSettings(req.body);
                const config = this.readConfig();
                const existing = config[currentName];

                if (!existing) {
                    res.status(404).json({ error: "Project does not exist." });
                    return;
                }

                if (nextName !== currentName && config[nextName]) {
                    res.status(409).json({ error: "A project with that repository name already exists." });
                    return;
                }

                if (nextName !== currentName) {
                    delete config[currentName];
                }

                config[nextName] = {
                    token: nextToken || existing.token,
                    ...(nextPath ? { path: nextPath } : {}),
                    ...(traefik ? { traefik } : {})
                };
                this.writeConfig(config);

                res.json({ name: nextName });
            } catch (error) {
                res.status(400).json({ error: error instanceof Error ? error.message : "Could not update project." });
            }
        });

        this.app.post('/webhook', (req: Request, res: Response) => {
            const event = req.headers['x-gitlab-event'];

            if (event === 'Push Hook') {
                const repoName = req.body.repository.name;
                const appSettings = this.fetchProfile(repoName);
                if (!appSettings) {
                    throw new Error("No config for this repository");
                }

                const repoToken = appSettings.token;
                const hostAppsPath = appSettings.path ?? `/root/docker-apps/${repoName}`;
                const traefikOverrideScript = this.renderTraefikOverrideScript(repoName, appSettings);
                const quotedHostAppsPath = this.shellQuote(hostAppsPath);
                const quotedHostAppsVolume = this.shellQuote(`${hostAppsPath}:${hostAppsPath}`);

                if (this.verifySignature(repoToken, req, res)) {

                    console.log(`Spinning up Ephemeral Build Worker for ${repoName}...`);

                    const dockerRunCommand = `docker run -i --rm \
            -v /var/run/docker.sock:/var/run/docker.sock \
            -v ${quotedHostAppsVolume} \
            -v ~/.ssh:/root/.ssh:ro \
            alpine:latest sh << 'EOF'
                apk add --no-cache docker-cli docker-cli-compose docker-cli-buildx git openssh-client > /dev/null 2>&1

                cd ${quotedHostAppsPath}
                echo "--> Fetching latest changes..."
                git pull

                COMPOSE_FILE="docker-compose.yaml"
                if [ ! -f "$COMPOSE_FILE" ] && [ -f docker-compose.yml ]; then
                    COMPOSE_FILE="docker-compose.yml"
                fi
                if [ ! -f "$COMPOSE_FILE" ] && [ -f compose.yaml ]; then
                    COMPOSE_FILE="compose.yaml"
                fi
                if [ ! -f "$COMPOSE_FILE" ] && [ -f compose.yml ]; then
                    COMPOSE_FILE="compose.yml"
                fi
                if [ ! -f "$COMPOSE_FILE" ]; then
                    echo "--> CRITICAL: No Docker Compose file found."
                    exit 1
                fi
                COMPOSE_FILES="-f $COMPOSE_FILE"
${traefikOverrideScript}
                
                echo "--> Testing build for new changes..."
                docker compose $COMPOSE_FILES build
                if [ $? -eq 0 ]; then
                    echo "--> Build succeeded! Safely dropping old container via compose..."
                    docker compose $COMPOSE_FILES down
                    
                    echo "--> Starting newly built container..."
                    docker compose $COMPOSE_FILES up -d --no-build
                    echo "--> Deployment successful."
                else
                    echo "--> CRITICAL: Build failed! Keeping the old container running."
                    exit 1
                fi
EOF`;

                    exec(dockerRunCommand, (error, stdout, stderr) => {
                        if (error) {
                            console.error(`Deployment Aborted: ${error.message}`);
                            if (stderr) console.error(`Worker Inner Error (stderr):\n${stderr}`);
                            if (stdout) console.log(`Worker Partial Output (stdout):\n${stdout}`);
                            return;
                        }
                        console.log(`Worker output:\n${stdout}`);
                    });
                }

                res.status(200).send('Build worker dispatched');
            }
        });

        this.app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
            console.error(error);
            res.status(500).json({ error: error.message || "Internal server error." });
        });

        this.app.listen(this.port, () => console.log('Build-First Webhook Factory active.'));
    }
}

new App().init();

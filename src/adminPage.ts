export function renderAdminPage() {
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
            width: 170px;
        }

        .action-group {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
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

        input,
        textarea {
            width: 100%;
            min-height: 42px;
            border: 1px solid #c8d2cb;
            border-radius: 7px;
            padding: 10px 12px;
            color: var(--ink);
            font: inherit;
            background: #fbfcfb;
        }

        textarea {
            min-height: 180px;
            resize: vertical;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 0.86rem;
            line-height: 1.45;
        }

        input:focus,
        textarea:focus {
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
                        CI deploy token
                        <input name="deployToken" autocomplete="off" placeholder="random deploy token">
                    </label>
                    <p class="hint" id="deploy-token-hint">Optional bearer token for CI-triggered deployments.</p>
                    <label>
                        Host path
                        <input name="path" autocomplete="off" placeholder="/root/docker-apps/my-service">
                    </label>
                    <p class="hint">Leave path empty to use /root/docker-apps/&lt;repository name&gt;.</p>
                    <label>
                        Stored Docker Compose override
                        <textarea name="composeOverride" spellcheck="false" placeholder="services:&#10;  web:&#10;    environment:&#10;      NODE_ENV: production"></textarea>
                    </label>
                    <p class="hint">Optional YAML written as docker-compose.updater.yml during deployment.</p>
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
                            <input type="checkbox" name="traefikWildcardCertificate">
                            Use wildcard certificate
                        </label>
                        <label class="full-field">
                            Wildcard certificate domain
                            <input name="traefikWildcardDomain" autocomplete="off" placeholder="bla.network">
                        </label>
                        <label class="checkbox-label">
                            <input type="checkbox" name="traefikWebsocket">
                            Add websocket upgrade headers
                        </label>
                        <label class="checkbox-label">
                            <input type="checkbox" name="traefikRemovePublishedPorts" checked>
                            Remove published ports from compose
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
        const deployTokenHint = document.getElementById("deploy-token-hint");
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
            list.innerHTML = '<table><thead><tr><th>Repository</th><th>Path</th><th>Proxy</th><th>Compose</th><th>Token</th><th class="project-actions">Action</th></tr></thead><tbody>' +
                projects.map((project) => '<tr>' +
                    '<td data-label="Repository"><div class="repo">' + escapeHtml(project.name) + '</div></td>' +
                    '<td data-label="Path"><code>' + escapeHtml(project.path || "/root/docker-apps/" + project.name) + '</code></td>' +
                    '<td data-label="Proxy">' + (project.traefik && project.traefik.enabled ? '<code>' + escapeHtml(project.traefik.hostname) + '</code>' : '<span class="count">Off</span>') + '</td>' +
                    '<td data-label="Compose">' + (project.hasComposeOverride ? '<span class="count">Stored</span>' : '<span class="count">Project file</span>') + '</td>' +
                    '<td data-label="Token"><code>' + escapeHtml(project.token) + '</code></td>' +
                    '<td data-label="Action"><div class="action-group">' +
                        '<button class="icon-button" type="button" data-deploy="' + escapeHtml(project.name) + '">Deploy</button>' +
                        '<button class="icon-button" type="button" data-edit="' + escapeHtml(project.name) + '">Edit</button>' +
                    '</div></td>' +
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
            deployTokenHint.textContent = "Optional bearer token for CI-triggered deployments.";
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
            form.elements.deployToken.value = "";
            form.elements.path.value = project.path || "";
            form.elements.composeOverride.value = project.composeOverride || "";
            form.elements.traefikEnabled.checked = Boolean(project.traefik && project.traefik.enabled);
            form.elements.traefikHostname.value = (project.traefik && project.traefik.hostname) || "";
            form.elements.traefikService.value = (project.traefik && project.traefik.service) || "";
            form.elements.traefikPort.value = (project.traefik && project.traefik.port) || "";
            form.elements.traefikEntryPoints.value = (project.traefik && project.traefik.entryPoints) || "";
            form.elements.traefikCertResolver.value = (project.traefik && project.traefik.certResolver) || "";
            form.elements.traefikNetwork.value = (project.traefik && project.traefik.network) || "";
            form.elements.traefikWildcardCertificate.checked = Boolean(project.traefik && project.traefik.wildcardCertificate);
            form.elements.traefikWildcardDomain.value = (project.traefik && project.traefik.wildcardDomain) || "";
            form.elements.traefikWebsocket.checked = Boolean(project.traefik && project.traefik.websocket);
            form.elements.traefikRemovePublishedPorts.checked = !project.traefik || project.traefik.removePublishedPorts !== false;
            tokenHint.textContent = "Leave blank to keep the current webhook secret.";
            deployTokenHint.textContent = "Leave blank to keep the current CI deploy token.";
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
            const editButton = event.target.closest("[data-edit]");
            const deployButton = event.target.closest("[data-deploy]");
            if (!editButton && !deployButton) {
                return;
            }

            if (editButton) {
                const project = currentProjects.find((item) => item.name === editButton.dataset.edit);
                if (!project) {
                    return;
                }
                setEditMode(project);
                return;
            }

            deployProject(deployButton);
        });

        async function deployProject(button) {
            const projectName = button.dataset.deploy;
            button.disabled = true;
            message.className = "message";
            message.textContent = "Deploying " + projectName + "...";

            try {
                const response = await fetch("/api/projects/" + encodeURIComponent(projectName) + "/deploy", {
                    method: "POST"
                });
                const result = await response.json();
                if (!response.ok) {
                    throw new Error(result.error || "Could not start deployment.");
                }

                message.textContent = "Deployment started for " + projectName + ".";
            } catch (error) {
                message.className = "message error";
                message.textContent = error instanceof Error ? error.message : "Could not start deployment.";
            } finally {
                button.disabled = false;
            }
        }

        cancelEditButton.addEventListener("click", setAddMode);

        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const button = form.querySelector("button");
            const formData = new FormData(form);
            const payload = {
                name: String(formData.get("name") || "").trim(),
                token: String(formData.get("token") || "").trim(),
                deployToken: String(formData.get("deployToken") || "").trim(),
                path: String(formData.get("path") || "").trim(),
                composeOverride: String(formData.get("composeOverride") || "").trim(),
                traefikEnabled: formData.has("traefikEnabled"),
                traefikHostname: String(formData.get("traefikHostname") || "").trim(),
                traefikService: String(formData.get("traefikService") || "").trim(),
                traefikPort: String(formData.get("traefikPort") || "").trim(),
                traefikEntryPoints: String(formData.get("traefikEntryPoints") || "").trim(),
                traefikCertResolver: String(formData.get("traefikCertResolver") || "").trim(),
                traefikNetwork: String(formData.get("traefikNetwork") || "").trim(),
                traefikWildcardCertificate: formData.has("traefikWildcardCertificate"),
                traefikWildcardDomain: String(formData.get("traefikWildcardDomain") || "").trim(),
                traefikWebsocket: formData.has("traefikWebsocket"),
                traefikRemovePublishedPorts: form.elements.traefikRemovePublishedPorts.checked
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

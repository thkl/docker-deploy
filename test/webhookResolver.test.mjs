import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveWebhookProject, webhookCommitMessages, webhookRequestsSkipDeploy } from "../dist/webhookResolver.js";

test("resolves a project from the GitLab project HTTP URL", () => {
    const settings = {
        id: "configured-project",
        repositoryUrl: "https://gitlab.example.com/group/canary.git",
        token: "secret"
    };

    const resolved = resolveWebhookProject({
        project: {
            id: 42,
            http_url: "https://gitlab.example.com/group/canary"
        }
    }, { canary: settings });

    assert.deepEqual(resolved, { projectName: "canary", appSettings: settings });
});

test("reads commit messages from a GitLab push payload", () => {
    const payload = {
        commits: [
            { id: "one", message: "Add the feature" },
            { id: "two", message: "Fix deployment\n\n[skip-deploy]" }
        ]
    };

    assert.deepEqual(webhookCommitMessages(payload), ["Add the feature", "Fix deployment\n\n[skip-deploy]"]);
    assert.equal(webhookRequestsSkipDeploy(payload), true);
});

test("does not skip deployment when the marker is absent", () => {
    assert.equal(webhookRequestsSkipDeploy({ commits: [{ message: "Regular push" }] }), false);
    assert.equal(webhookRequestsSkipDeploy({ commits: [{ title: "[skip-deploy]" }] }), false);
});

test("matches the skip marker case-insensitively across commit messages", () => {
    assert.equal(webhookRequestsSkipDeploy({ commits: [{ message: "Release [SKIP-DEPLOY]" }] }), true);
});

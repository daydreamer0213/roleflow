const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createLogger, workflowLogContext } = require("../src/core/observability");
const { resolveLiveInheritedContext } = require("../src/dashboard/server");
const { BossSiteAdapter } = require("../src/adapters/sites/boss");

const root = path.join(__dirname, "..", ".runtime", `observability-context-smoke-${Date.now()}`);

async function main() {
  try {
    const logger = createLogger({
      root,
      component: "context-test",
      context: {
        runId: "run-parent",
        planId: 10,
        requestId: "request-parent",
        apiKey: "sk-parent-context-secret"
      }
    });
    const child = logger.child({
      batchId: 20,
      planId: 11,
      authorization: "Bearer child-context-secret"
    });
    const grandchild = child.child({
      requestId: "request-child",
      resumeText: "private resume context"
    });

    grandchild.info("context_inherited", {
      runId: undefined,
      batchId: undefined,
      planId: 12,
      requestId: "request-event"
    });

    assert.strictEqual(child.logDir, logger.logDir);
    const inherited = logger.listRecent(10).find((row) => row.event === "context_inherited");
    assert(inherited);
    assert.strictEqual(inherited.component, "context-test");
    assert.strictEqual(inherited.runId, "run-parent");
    assert.strictEqual(inherited.batchId, 20);
    assert.strictEqual(inherited.planId, 12);
    assert.strictEqual(inherited.requestId, "request-event");
    assert.strictEqual(inherited.apiKey, "[REDACTED]");
    assert.strictEqual(inherited.authorization, "[REDACTED]");
    assert.strictEqual(inherited.resumeText, "[REDACTED]");

    const runA = logger.child({ runId: "run-a", batchId: "batch-a" });
    const runB = logger.child({ runId: "run-b", batchId: "batch-b" });
    await Promise.all(Array.from({ length: 20 }, (_, index) => Promise.all([
      new Promise((resolve) => setImmediate(() => {
        runA.info(`parallel_a_${index}`, { requestId: `a-${index}` });
        resolve();
      })),
      new Promise((resolve) => setImmediate(() => {
        runB.info(`parallel_b_${index}`, { requestId: `b-${index}` });
        resolve();
      }))
    ])));

    const parallelRows = logger.listRecent(100).filter((row) => row.event.startsWith("parallel_"));
    assert.strictEqual(parallelRows.length, 40);
    for (const row of parallelRows) {
      const isRunA = row.event.startsWith("parallel_a_");
      assert.strictEqual(row.runId, isRunA ? "run-a" : "run-b");
      assert.strictEqual(row.batchId, isRunA ? "batch-a" : "batch-b");
    }

    const rawLogs = fs.readdirSync(logger.logDir)
      .map((file) => fs.readFileSync(path.join(logger.logDir, file), "utf8"))
      .join("\n");
    for (const secret of ["sk-parent-context-secret", "child-context-secret", "private resume context"]) {
      assert(!rawLogs.includes(secret), `context secret leaked into logs: ${secret}`);
    }

    const workflowLogger = logger.child(workflowLogContext({
      id: "workflow-1",
      scanRunId: "scan-1",
      scanBatchId: 31,
      communicationBatchId: 42
    }));
    workflowLogger.info("workflow_context_linked");
    const workflowRow = logger.listRecent(10).find((row) => row.event === "workflow_context_linked");
    assert.deepStrictEqual({
      workflowRunId: workflowRow.workflowRunId,
      scanRunId: workflowRow.scanRunId,
      scanBatchId: workflowRow.scanBatchId,
      communicationBatchId: workflowRow.communicationBatchId
    }, {
      workflowRunId: "workflow-1",
      scanRunId: "scan-1",
      scanBatchId: 31,
      communicationBatchId: 42
    });

    assert.deepStrictEqual(workflowLogContext({ workflowRunId: "workflow-2" }), {
      workflowRunId: "workflow-2",
      scanRunId: null,
      scanBatchId: null,
      communicationBatchId: null
    });

    const dashboardSource = fs.readFileSync(
      path.join(__dirname, "..", "src", "dashboard", "server.js"),
      "utf8"
    );
    assert.doesNotMatch(
      dashboardSource,
      /platform_filter_unresolved[\s\S]{0,300}\bcodes\s*:/,
      "production unresolved-filter diagnostics must not emit raw codes"
    );
    assert.strictEqual(typeof resolveLiveInheritedContext, "function");

    const originalPreflight = BossSiteAdapter.prototype.preflight;
    const originalInspectInheritedSearchPage = BossSiteAdapter.prototype.inspectInheritedSearchPage;
    const diagnosticEvents = [];
    try {
      BossSiteAdapter.prototype.preflight = async () => ({
        tabId: "fixture-search-tab",
        isSearchPage: true
      });
      BossSiteAdapter.prototype.inspectInheritedSearchPage = async () => ({
        url: "https://www.zhipin.com/web/geek/jobs?city=100010000&industry=100020&query=raw-secret-query",
        catalog: { fields: {} },
        urlOptions: []
      });
      await resolveLiveInheritedContext({
        db: {
          prepare() {
            return { get() { return null; } };
          }
        },
        plan: {
          id: 9,
          profileId: 7,
          profileVersionId: 11,
          plan: {
            keywords: [{ word: "RAG工程师", priority: "A", reason: "fixture" }]
          }
        },
        matchingContext: { matchingCard: {} },
        logger: {
          info(event, fields = {}) { diagnosticEvents.push({ event, fields }); },
          warn(event, fields = {}) { diagnosticEvents.push({ event, fields }); }
        }
      });
    } finally {
      BossSiteAdapter.prototype.preflight = originalPreflight;
      BossSiteAdapter.prototype.inspectInheritedSearchPage = originalInspectInheritedSearchPage;
    }

    const scopeResolved = diagnosticEvents.find((row) => row.event === "inherited_scope_resolved");
    assert(scopeResolved);
    assert.deepStrictEqual(Object.keys(scopeResolved.fields).sort(), [
      "keywordCatalogHash",
      "recognizedFilterCount",
      "scopeId",
      "site",
      "unresolvedFilterCount"
    ]);
    const unresolvedFilter = diagnosticEvents.find((row) => row.event === "platform_filter_unresolved");
    assert(unresolvedFilter);
    assert.deepStrictEqual(Object.keys(unresolvedFilter.fields).sort(), [
      "param",
      "scopeId",
      "site",
      "unresolvedValueCount"
    ]);
    assert.strictEqual(unresolvedFilter.fields.param, "industry");
    assert.strictEqual(unresolvedFilter.fields.unresolvedValueCount, 1);
    assert.strictEqual(scopeResolved.fields.scopeId.length, 10);

    const serializedDiagnostics = JSON.stringify(diagnosticEvents);
    for (const sensitive of [
      "codes",
      "filterParams",
      "templateUrl",
      "browserState",
      "https://www.zhipin.com/web/geek/jobs?",
      "100020",
      "raw-secret-query",
      "candidateProfile",
      "resumeText",
      "description",
      "cookie",
      "apiKey"
    ]) {
      assert(!serializedDiagnostics.includes(sensitive), `inherited scope diagnostics leaked: ${sensitive}`);
    }

    console.log("observability_context_smoke ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

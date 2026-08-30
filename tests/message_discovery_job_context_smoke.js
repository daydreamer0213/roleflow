const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  openDb,
  createBatch,
  upsertJob
} = require("../src/core/storage");
const {
  ensureProgressCard,
  listMessageDiscoveryCandidates
} = require("../src/core/candidate_progress");
const {
  createMessageDiscoveryJobContextResolver
} = require("../src/application/message_discovery/job_context");

const root = fs.mkdtempSync(path.join("D:\\DevData", "RoleFlow-message-job-context-"));
let db;

(async () => {
  try {
    db = openDb(path.join(root, "context.sqlite"));
    await cacheHitSmoke();
    await cacheBindingFailureSmoke();
    await fetchedContextSmoke();
    await incompleteContextSmoke();
    console.log("message_discovery_job_context_smoke ok");
  } finally {
    try { db?.close(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function cacheHitSmoke() {
  const fixture = seedProfilePlan("cache");
  const jobId = seedJob(fixture, "cache-job", { complete: true });
  const card = ensureProgressCard(db, { ...fixture, jobId, source: "boss", now: fixture.now });
  const wrongJobId = seedJob(fixture, "wrong-cache-job", { complete: true });
  ensureProgressCard(db, { ...fixture, jobId: wrongJobId, source: "boss", now: fixture.now });
  const wrongCandidate = listMessageDiscoveryCandidates(db, { profileId: fixture.profileId })
    .find((item) => item.jobId === wrongJobId);
  const calls = [];
  const target = trustedTarget("cache-job");
  const resolver = createMessageDiscoveryJobContextResolver({
    db,
    profileId: fixture.profileId,
    messageReader: {
      async readSelectedJobTarget(selected) {
        calls.push(["target", selected]);
        return target;
      },
      async assertActiveBindings() {
        calls.push(["binding"]);
      }
    },
    detailReader: {
      async readSelectedJobDetail() {
        calls.push(["detail"]);
        throw new Error("cache hit must not read BOSS detail");
      }
    },
    async analyzeJob() {
      calls.push(["analyze"]);
      throw new Error("cache hit must not invoke analysis");
    }
  });
  const conversationKey = digest("cache-thread");
  const selected = { marker: "selected-cache" };
  const result = await resolver({
    target: { tabId: 42, conversationKey },
    selected,
    candidate: wrongCandidate
  });
  assert.deepStrictEqual(calls, [["target", selected], ["binding"]]);
  assert.strictEqual(result.cardId, card.id);
  assert.strictEqual(result.card.threadKey, conversationKey);
  assert.strictEqual(result.job.sourceId, "cache-job");
  assert.strictEqual(result.job.analysis.semanticStatus, "complete");
  assert.strictEqual(result.threadKey, conversationKey);
  assert.strictEqual(result.contextSource, "local_cache");
}

async function cacheBindingFailureSmoke() {
  const fixture = seedProfilePlan("cache-binding-failure");
  const jobId = seedJob(fixture, "cache-binding-failure-job", { complete: true });
  const card = ensureProgressCard(db, { ...fixture, jobId, source: "boss", now: fixture.now });
  let detailCalls = 0;
  const bindingError = Object.assign(new Error("fixed tabs changed"), {
    code: "BOSS_MESSAGE_DETAIL_BASELINE_NOT_RESTORED"
  });
  const resolver = createMessageDiscoveryJobContextResolver({
    db,
    profileId: fixture.profileId,
    messageReader: {
      async readSelectedJobTarget() {
        return trustedTarget("cache-binding-failure-job");
      },
      async assertActiveBindings() {
        throw bindingError;
      }
    },
    detailReader: {
      async readSelectedJobDetail() {
        detailCalls += 1;
        throw new Error("cache hit must not read BOSS detail");
      }
    },
    async analyzeJob() {
      throw new Error("cache hit must not invoke analysis");
    }
  });
  await assert.rejects(
    () => resolver({
      target: { tabId: 42, conversationKey: digest("cache-binding-failure-thread") },
      selected: { marker: "selected-cache-binding-failure" }
    }),
    (error) => error === bindingError
  );
  assert.strictEqual(detailCalls, 0);
  assert.strictEqual(
    listMessageDiscoveryCandidates(db, { profileId: fixture.profileId })
      .find((item) => item.jobId === jobId).threadKey,
    "",
    "a failed cache binding check must not bind the conversation to the progress card"
  );
  assert.strictEqual(card.threadKey, "");
}

async function fetchedContextSmoke() {
  const fixture = seedProfilePlan("fetched");
  const jobId = seedJob(fixture, "fetched-job");
  const card = ensureProgressCard(db, { ...fixture, jobId, source: "boss", now: fixture.now });
  const secret = "private-secret";
  const target = trustedTarget("fetched-job", secret);
  const calls = [];
  const logs = [];
  const controller = new AbortController();
  const resolver = createMessageDiscoveryJobContextResolver({
    db,
    profileId: fixture.profileId,
    messageReader: {
      async readSelectedJobTarget() {
        calls.push("target");
        assertDatabaseIdle();
        return target;
      },
      async assertActiveBindings() {
        calls.push("binding");
        assertDatabaseIdle();
      }
    },
    detailReader: {
      async readSelectedJobDetail(input) {
        calls.push("detail");
        assertDatabaseIdle();
        assert.strictEqual(input.communicationTabId, 43);
        assert.strictEqual(input.jobTarget.navigationUrl, target.navigationUrl);
        return detail("fetched-job");
      }
    },
    analyzeJob: completeAnalysisAdapter(calls, controller.signal),
    modelConfig: { provider: "fixture" },
    root,
    logger: captureLogger(logs)
  });
  const conversationKey = digest("fetched-thread");
  const candidate = listMessageDiscoveryCandidates(db, { profileId: fixture.profileId })
    .find((item) => item.jobId === jobId);
  assert.strictEqual(candidate.contextComplete, false);
  const result = await resolver({
    target: { tabId: 43, conversationKey },
    selected: { marker: "selected-fetched" },
    candidate,
    signal: controller.signal
  });
  assert.deepStrictEqual(calls, ["target", "binding", "detail", "analyze"]);
  assert.strictEqual(result.cardId, card.id);
  assert.strictEqual(result.card.threadKey, conversationKey);
  assert.strictEqual(result.job.description, detail("fetched-job").description.trim());
  assert.strictEqual(result.job.analysis.semanticStatus, "complete");
  assert.strictEqual(result.contextSource, "message_discovery_detail");

  const rawBatch = db.prepare("SELECT * FROM batches WHERE keyword = 'message-discovery-detail' AND profile_id = ?")
    .get(fixture.profileId);
  assert(rawBatch, "detail fetch must create a raw observation batch");
  assert.strictEqual(Number(rawBatch.search_plan_id), fixture.planId);
  const raw = db.prepare("SELECT * FROM job_observations WHERE batch_id = ? AND job_id = ?")
    .get(rawBatch.id, jobId);
  assert.strictEqual(raw.url, "https://www.zhipin.com/job_detail/fetched-job.html");
  assert.strictEqual(raw.description, detail("fetched-job").description.trim());
  assert.strictEqual(JSON.parse(raw.analysis_json).semanticStatus, "pending");
  assertNoSecret(secret, logs);
}

async function incompleteContextSmoke() {
  const fixture = seedProfilePlan("incomplete");
  const jobId = seedJob(fixture, "incomplete-job");
  ensureProgressCard(db, { ...fixture, jobId, source: "boss", now: fixture.now });
  const calls = [];
  const resolver = createMessageDiscoveryJobContextResolver({
    db,
    profileId: fixture.profileId,
    messageReader: {
      async readSelectedJobTarget() { return trustedTarget("incomplete-job"); },
      async assertActiveBindings() {}
    },
    detailReader: { async readSelectedJobDetail() { calls.push("detail"); return detail("incomplete-job"); } },
    analyzeJob: partialAnalysisAdapter(calls)
  });
  await assert.rejects(
    () => resolver({
      target: { tabId: 44, conversationKey: digest("incomplete-thread") },
      selected: { marker: "selected-incomplete" }
    }),
    (error) => error.code === "MESSAGE_DISCOVERY_JOB_ANALYSIS_INCOMPLETE"
  );
  assert.deepStrictEqual(calls, ["detail", "analyze"]);

  const shortFixture = seedProfilePlan("short");
  const shortJobId = seedJob(shortFixture, "short-job");
  ensureProgressCard(db, { ...shortFixture, jobId: shortJobId, source: "boss", now: shortFixture.now });
  let analyzed = false;
  const shortResolver = createMessageDiscoveryJobContextResolver({
    db,
    profileId: shortFixture.profileId,
    messageReader: {
      async readSelectedJobTarget() { return trustedTarget("short-job"); },
      async assertActiveBindings() {}
    },
    detailReader: { async readSelectedJobDetail() { return { ...detail("short-job"), description: "too short" }; } },
    async analyzeJob() { analyzed = true; }
  });
  await assert.rejects(
    () => shortResolver({
      target: { tabId: 45, conversationKey: digest("short-thread") },
      selected: { marker: "selected-short" }
    }),
    (error) => error.code === "MESSAGE_DISCOVERY_JOB_DETAIL_INCOMPLETE"
  );
  assert.strictEqual(analyzed, false);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM batches WHERE profile_id = ?").get(shortFixture.profileId).n, 0);

  const secret = "private-secret-in-error";
  const secretFixture = seedProfilePlan("secret-error");
  const secretJobId = seedJob(secretFixture, "secret-job");
  ensureProgressCard(db, { ...secretFixture, jobId: secretJobId, source: "boss", now: secretFixture.now });
  const logs = [];
  const secretResolver = createMessageDiscoveryJobContextResolver({
    db,
    profileId: secretFixture.profileId,
    messageReader: {
      async readSelectedJobTarget() { return trustedTarget("secret-job", secret); },
      async assertActiveBindings() {}
    },
    detailReader: {
      async readSelectedJobDetail() {
        return { ...detail("secret-job"), canonicalUrl: `https://www.zhipin.com/job_detail/secret-job.html?securityId=${secret}` };
      }
    },
    async analyzeJob() { throw new Error("invalid URL must stop before analysis"); },
    logger: captureLogger(logs)
  });
  await assert.rejects(
    () => secretResolver({
      target: { tabId: 46, conversationKey: digest("secret-thread") },
      selected: { marker: "selected-secret" }
    }),
    (error) => error.code === "MESSAGE_DISCOVERY_JOB_URL_INVALID" && !error.message.includes(secret)
  );
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM batches WHERE profile_id = ?").get(secretFixture.profileId).n, 0);
  assertNoSecret(secret, logs);
}

function seedProfilePlan(suffix) {
  const now = "2026-08-16T08:00:00.000Z";
  const profileId = Number(db.prepare(`INSERT INTO candidate_profiles(
    display_name, profile_json, source_hash, created_at, updated_at
  ) VALUES (?, '{}', NULL, ?, ?)`).run(`Candidate ${suffix}`, now, now).lastInsertRowid);
  const planId = Number(db.prepare(`INSERT INTO search_plans(
    profile_id, name, plan_json, profile_version_id, is_active, created_at, updated_at
  ) VALUES (?, ?, '{}', NULL, 1, ?, ?)`).run(profileId, `Plan ${suffix}`, now, now).lastInsertRowid);
  return { profileId, planId, now };
}

function seedJob(fixture, sourceId, { complete = false } = {}) {
  const batchId = complete ? createBatch(db, "boss", "seed-complete", "complete context", {
    profileId: fixture.profileId,
    searchPlanId: fixture.planId
  }) : null;
  return upsertJob(db, {
    source: "boss",
    sourceId,
    keyword: "AI Engineer",
    title: "AI Engineer",
    company: "Context Co",
    location: "Guangzhou",
    salary: "20-30K",
    experience: "3-5年",
    education: "本科",
    bossActiveText: "今日活跃",
    url: `https://www.zhipin.com/job_detail/${sourceId}.html`,
    tags: ["Node.js"],
    description: complete ? detail(sourceId).description : "",
    qualityTags: [],
    analysis: complete
      ? { semanticStatus: "complete", recommendation: "primary", marker: "cached" }
      : {}
  }, batchId);
}

function detail(sourceId) {
  return {
    sourceId,
    canonicalUrl: `https://www.zhipin.com/job_detail/${sourceId}.html`,
    title: "AI Engineer",
    company: "Context Co",
    location: "Guangzhou",
    salary: "20-30K",
    experience: "3-5年",
    education: "本科",
    bossActiveText: "今日活跃",
    tags: ["Node.js", "RAG"],
    description: "Build and maintain reliable Node.js and RAG applications with retrieval evaluation, production diagnostics, testing, observability, and full delivery ownership. ".repeat(2)
  };
}

function trustedTarget(jobId, securityId = "fixture-secret") {
  return {
    jobId,
    canonicalUrl: `https://www.zhipin.com/job_detail/${jobId}.html`,
    navigationUrl: `https://www.zhipin.com/job_detail/${jobId}.html?securityId=${securityId}`
  };
}

function completeAnalysisAdapter(calls, expectedSignal = null) {
  return async ({ input, deps }) => {
    calls.push("analyze");
    assertDatabaseIdle();
    assert.strictEqual(input.purpose, undefined);
    assert.strictEqual(deps.messageContextAnalysis, true);
    if (expectedSignal) assert.strictEqual(deps.signal, expectedSignal);
    persistAnalysis(input, { semanticStatus: "complete", recommendation: "primary", marker: "fresh" });
  };
}

function partialAnalysisAdapter(calls) {
  return async ({ input, deps }) => {
    calls.push("analyze");
    assertDatabaseIdle();
    assert.strictEqual(input.purpose, undefined);
    assert.strictEqual(deps.messageContextAnalysis, true);
    persistAnalysis(input, { semanticStatus: "partial", recommendation: "review" });
  };
}

function persistAnalysis(input, analysis) {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(input.jobId);
  const batchId = createBatch(db, "boss", "analysis-retry", "message context analysis fixture", {
    profileId: Number(db.prepare("SELECT profile_id FROM search_plans WHERE id = ?").get(input.planId).profile_id),
    searchPlanId: input.planId
  });
  upsertJob(db, {
    source: row.source,
    sourceId: row.source_id,
    keyword: row.keyword,
    title: row.title,
    company: row.company,
    location: row.location,
    salary: row.salary,
    experience: row.experience,
    education: row.education,
    bossActiveText: row.boss_active_text,
    url: row.url,
    tags: JSON.parse(row.tags_json),
    description: row.description,
    qualityTags: JSON.parse(row.quality_tags_json),
    analysis
  }, batchId);
}

function assertDatabaseIdle() {
  db.exec("BEGIN IMMEDIATE");
  db.exec("ROLLBACK");
}

function assertNoSecret(secret, logs) {
  const rows = ["jobs", "job_observations", "batches", "events"].flatMap((table) =>
    db.prepare(`SELECT * FROM ${table}`).all()
  );
  assert(!JSON.stringify({ rows, logs }).includes(secret), "navigation secret must not be persisted or logged");
}

function captureLogger(logs) {
  return Object.fromEntries(["info", "warn", "error"].map((level) => [
    level,
    (...args) => logs.push([level, ...args])
  ]));
}

function digest(value) {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

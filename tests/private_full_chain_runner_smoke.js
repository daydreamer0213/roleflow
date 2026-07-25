const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const runner = require("../scripts/private-full-chain-runner");
const { loadConfigs } = require("../src/config");
const { createJobAnalysisRunner } = require("../src/core/job_analysis");
const { normalizeMatchingCard } = require("../src/core/matching_card");
const { profileToRuntimeConfigs } = require("../src/core/search_plan");
const { scoreJob, decisionState } = require("../src/core/scoring");
const { openDb, decisionBucket } = require("../src/core/storage");
const { mapWithConcurrency } = require("../src/core/async_pool");
const { assertResumeIdentityRedacted } = require("../src/core/resume_privacy");
const { deriveBenchmarkMetrics } = require("../scripts/lib/benchmark_metrics");
const genericFixtures = require("./fixtures/generic_evidence_matching.json");

const PRIVATE_PARENT = "D:\\DevData\\RoleFlow-private-benchmark";
const testRoot = path.join(PRIVATE_PARENT, `synthetic-private-full-chain-runner-${process.pid}`);
const siblingBaselineRoot = path.join(PRIVATE_PARENT, `synthetic-private-full-chain-baseline-${process.pid}`);
const externalRoot = path.join("D:\\DevData\\RoleFlow-private-runner-fixtures", `synthetic-private-full-chain-runner-${process.pid}`);
const externalPdf = path.join(externalRoot, "synthetic-resume.pdf");

function privatePath(...parts) {
  return path.join(testRoot, ...parts);
}

function gateOptions(overrides = {}) {
  return {
    mode: "prepare",
    privateRoot: testRoot,
    pdf: externalPdf,
    identity: privatePath("identity.private.json"),
    output: privatePath("prepared"),
    gitProof: { clean: true, commit: "39557f2" },
    ...overrides
  };
}

function authorizedEnv(overrides = {}) {
  return {
    ALLOW_PRIVATE_RESUME_BENCHMARK: "YES",
    ALLOW_LIVE_MODEL_BENCHMARK: "YES",
    ...overrides
  };
}

function expectGate(code, options, env = authorizedEnv()) {
  let providerCalls = 0;
  const result = runner.validatePrivateFullChainRequest(options, env, () => {
    providerCalls += 1;
    return { provider: "real-test-provider" };
  });
  assert.strictEqual(result.ok, false, `${code} must reject`);
  assert.strictEqual(result.code, code);
  assert.strictEqual(providerCalls, 0, "path, authorization, or worktree failures must not resolve a provider");
}

function expectGateOk(options, env = authorizedEnv()) {
  let providerCalls = 0;
  const result = runner.validatePrivateFullChainRequest(options, env, () => { providerCalls += 1; });
  assert.strictEqual(result.ok, true, `documented shape must pass: ${result.code}`);
  assert.strictEqual(providerCalls, 0, "pure request validation must not resolve a provider");
  return result;
}

function candidateWorktreeIsClean() {
  const { execFileSync } = require("node:child_process");
  return !execFileSync("git", ["status", "--porcelain"], { cwd: path.resolve(__dirname, ".."), encoding: "utf8", windowsHide: true }).trim();
}

function textAt(text, x, y) {
  return `BT /F1 12 Tf 1 0 0 1 ${x} ${y} Tm (${text}) Tj ET`;
}

function streamObject(content) {
  return `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`;
}

function makeSyntheticPdf() {
  const content = [
    textAt("Education: Example University computer science", 72, 480),
    textAt("Project: Project Beta observability", 72, 540),
    textAt("Name: Synthetic Candidate", 72, 720),
    textAt("Experience: Example Company platform work", 72, 600),
    textAt("Phone: 13800138000", 72, 690),
    textAt("Skills: Node.js testing automation", 72, 510),
    textAt("Summary: product-minded engineer", 72, 630),
    textAt("Email: candidate@example.com", 72, 660),
    textAt("Project: Project Alpha migration", 72, 570)
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    streamObject(content),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output, "ascii"));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output, "ascii");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "ascii");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function valueSha256(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function liveOptions(mode, side, overrides = {}) {
  const options = {
    mode,
    side,
    privateRoot: testRoot,
    output: privatePath("runs", side),
    modelSettingsRoot: "D:\\Guo\\ZhiPing",
    modelDescriptor: { provider: "synthetic-provider" },
    gitProof: { clean: true, commit: side === "baseline" ? "1".repeat(40) : "2".repeat(40) },
    ...overrides
  };
  return options;
}

function applyDerivedMetrics(result) {
  const derived = deriveBenchmarkMetrics(result.rows);
  assert.strictEqual(derived.ok, true);
  return { ...result, ...derived.metrics };
}

async function injectedLiveFlowSmoke(identityPath) {
  const selected = [genericFixtures[0], genericFixtures[1], genericFixtures[3], genericFixtures[4]];
  const confirmedProfile = {
    ...selected[0].candidateProfile,
    education: [],
    credentials: [],
    strengths: []
  };
  const confirmedCard = normalizeMatchingCard(selected[0].matchingCard, { source: "user", editedByUser: true });
  const redactedText = [
    "候选人：[姓名已遮盖]",
    "经历：某淘宝旗舰店，负责店铺经营与投放复盘。",
    "技能：店铺运营、投放复盘。"
  ].join("\n");
  const resumePath = privatePath("input", "resume.redacted.txt");
  const jobsPath = privatePath("input", "jobs.private.json");
  const labelsPath = privatePath("labels", "jobs.reviewed.json");
  const profilePath = privatePath("input", "confirmed-profile.private.json");
  const cardPath = privatePath("input", "confirmed-card.private.json");
  const manifest = {
    runMode: "private-init-manifest",
    baselineCommit: "1".repeat(40),
    candidateCommit: "2".repeat(40),
    sharedFileBlobs: {}
  };
  const jobs = selected.map((fixture) => ({
    id: fixture.id,
    source: "boss",
    sourceId: fixture.id,
    keyword: "合成关键词",
    title: fixture.job.title,
    company: "Synthetic Corp",
    location: "广州",
    salary: fixture.job.salary,
    experience: fixture.job.experience,
    education: "本科",
    bossActiveText: "今日活跃",
    url: `https://www.zhipin.com/job_detail/synthetic-${fixture.id}.html`,
    tags: fixture.job.tags,
    description: fixture.job.description,
    capturedAt: "2026-07-25T00:00:00.000Z"
  }));
  const labels = {
    labelsVersion: "private-real-jd-labels.v1",
    userConfirmed: true,
    confirmedAt: "2026-07-25T00:00:00.000Z",
    jobsSha256: valueSha256(jobs),
    rows: selected.map((fixture) => ({
      id: fixture.id,
      expectedRecommendation: fixture.expected.recommendation,
      expectedBucket: fixture.expected.bucket,
      rationale: `人工冻结标签：${fixture.scenario}`
    }))
  };
  fs.mkdirSync(path.dirname(resumePath), { recursive: true });
  fs.mkdirSync(path.dirname(labelsPath), { recursive: true });
  fs.writeFileSync(resumePath, redactedText, "utf8");
  fs.writeFileSync(jobsPath, JSON.stringify(jobs, null, 2), "utf8");
  fs.writeFileSync(labelsPath, JSON.stringify(labels, null, 2), "utf8");
  fs.writeFileSync(privatePath("run-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  const fakeModelConfig = {
    provider: "synthetic-provider",
    providers: {
      "synthetic-provider": {
        model: "offline-synthetic-model",
        baseUrl: "https://example.invalid/v1",
        timeoutMs: 4321
      }
    }
  };
  const captured = {
    resumeInputs: [],
    cardProfile: null,
    matchInputs: [],
    fifthCardBySide: {},
    dbPaths: [],
    formalProviderResolutions: 0
  };
  const byId = new Map(selected.map((fixture) => [fixture.id, fixture]));
  const adapter = {
    understandJob: async (input) => {
      const fixture = byId.get(input.job.sourceId);
      assert(fixture, `missing synthetic fixture ${input.job.sourceId}`);
      return { jobId: input.job.sourceId, ...fixture.jobUnderstanding };
    },
    matchJob: async (input) => {
      captured.matchInputs.push(input);
      const fixture = byId.get(input.jobUnderstanding.jobId);
      return {
        ...fixture.matchDecision,
        fitReasons: [
          ...(fixture.matchDecision.fitReasons || []),
          `Synthetic Candidate ${fixture.job.description.slice(0, 48)}`
        ]
      };
    }
  };
  const commonModules = {
    analyzeResumeProfile: async (input) => {
      captured.resumeInputs.push(input);
      return confirmedProfile;
    },
    buildCandidateMatchCard: async ({ profile }) => {
      captured.cardProfile = profile;
      return selected[0].matchingCard;
    },
    normalizeMatchingCard,
    createJobAnalysisRunner,
    scoreJob,
    decisionState,
    decisionBucket,
    assertResumeIdentityRedacted,
    openDb: (dbPath) => {
      captured.dbPaths.push(dbPath);
      return openDb(dbPath);
    },
    mapWithConcurrency,
    resolveRuntimeModelConfig: () => {
      captured.formalProviderResolutions += 1;
      throw new Error("formal provider resolution must remain unused in injected tests");
    }
  };
  const seamFor = (side) => ({
    modelConfig: fakeModelConfig,
    baseConfigs: loadConfigs(path.resolve(__dirname, "..")),
    adapter,
    modules: {
      ...commonModules,
      profileToRuntimeConfigs: (...args) => {
        captured.fifthCardBySide[side] = args[4];
        return side === "baseline"
          ? profileToRuntimeConfigs(args[0], args[1], args[2], args[3])
          : profileToRuntimeConfigs(...args);
      }
    }
  });

  const unredactedPath = privatePath("input", "resume.unredacted.txt");
  fs.writeFileSync(unredactedPath, "Synthetic Candidate candidate@example.com 13800138000", "utf8");
  await assert.rejects(
    () => runner.runPrivateFullChain(liveOptions("profile-live", "candidate", {
      resumeText: unredactedPath,
      identity: identityPath
    }), authorizedEnv(), seamFor("candidate")),
    (error) => error.code === "PRIVATE_FULL_CHAIN_INPUT_IDENTITY"
  );
  assert.strictEqual(captured.resumeInputs.length, 0, "identity redaction failure must precede the profile analyzer");

  const profileBaseline = await runner.runPrivateFullChain(liveOptions("profile-live", "baseline", {
    resumeText: resumePath,
    identity: identityPath
  }), authorizedEnv(), seamFor("baseline"));
  const profileCandidate = await runner.runPrivateFullChain(liveOptions("profile-live", "candidate", {
    resumeText: resumePath,
    identity: identityPath
  }), authorizedEnv(), seamFor("candidate"));
  assert.strictEqual(captured.resumeInputs.length, 2);
  assert.strictEqual(captured.resumeInputs[0].resume.text.includes("测试候选人"), false);
  assert.strictEqual(captured.resumeInputs[0].strictPrivacy, true);
  assert.strictEqual(profileBaseline.resumeContentSha256, profileCandidate.resumeContentSha256);
  assert.strictEqual(profileBaseline.profileSha256, profileCandidate.profileSha256);
  assert.deepStrictEqual(profileBaseline.profile, confirmedProfile);
  assert.deepStrictEqual(profileCandidate.profile, confirmedProfile);

  await assert.rejects(
    () => runner.runPrivateFullChain(liveOptions("card-live", "baseline", {
      profile: privatePath("runs", "baseline", "profile.json")
    }), authorizedEnv(), { ...seamFor("baseline"), modules: { ...commonModules, buildCandidateMatchCard: undefined } }),
    (error) => error.code === "PRIVATE_FULL_CHAIN_CARD_UNSUPPORTED"
  );
  const draft = await runner.runPrivateFullChain(liveOptions("card-live", "candidate", {
    profile: privatePath("runs", "candidate", "profile.json")
  }), authorizedEnv(), seamFor("candidate"));
  assert.strictEqual(draft.status, "draft");
  assert.strictEqual(draft.userConfirmed, false);
  assert.strictEqual(draft.profileSha256, profileCandidate.profileSha256);
  assert.deepStrictEqual(captured.cardProfile, confirmedProfile);

  const profileEnvelope = {
    status: "confirmed",
    userConfirmed: true,
    confirmedAt: "2026-07-25T00:00:00.000Z",
    profileSha256: valueSha256(confirmedProfile),
    profile: confirmedProfile
  };
  const cardEnvelope = {
    id: "private-confirmed-card-v1",
    status: "confirmed",
    userConfirmed: true,
    confirmedAt: "2026-07-25T00:00:00.000Z",
    profileSha256: profileEnvelope.profileSha256,
    card: confirmedCard
  };
  fs.writeFileSync(profilePath, JSON.stringify(profileEnvelope, null, 2), "utf8");
  fs.writeFileSync(cardPath, JSON.stringify(cardEnvelope, null, 2), "utf8");
  const draftCardPath = privatePath("input", "draft-card.private.json");
  fs.writeFileSync(draftCardPath, JSON.stringify({ ...cardEnvelope, status: "draft", userConfirmed: false }), "utf8");
  await assert.rejects(
    () => runner.runPrivateFullChain(liveOptions("match-live", "candidate", {
      profile: profilePath, matchingCard: draftCardPath, jobs: jobsPath, labels: labelsPath
    }), authorizedEnv(), seamFor("candidate")),
    (error) => error.code === "PRIVATE_FULL_CHAIN_CARD_UNCONFIRMED"
  );
  assert.strictEqual(captured.dbPaths.length, 0, "unconfirmed card must fail before SQLite creation");

  const baseline = await runner.runPrivateFullChain(liveOptions("match-live", "baseline", {
    profile: profilePath, matchingCard: cardPath, jobs: jobsPath, labels: labelsPath
  }), authorizedEnv(), seamFor("baseline"));
  const candidate = await runner.runPrivateFullChain(liveOptions("match-live", "candidate", {
    profile: profilePath, matchingCard: cardPath, jobs: jobsPath, labels: labelsPath
  }), authorizedEnv(), seamFor("candidate"));
  assert.deepStrictEqual(captured.fifthCardBySide.baseline, confirmedCard);
  assert.deepStrictEqual(captured.fifthCardBySide.candidate, confirmedCard);
  assert.strictEqual(baseline.matchingCardProvided, true);
  assert.strictEqual(baseline.matchingCardConsumed, false);
  assert.strictEqual(candidate.matchingCardProvided, true);
  assert.strictEqual(candidate.matchingCardConsumed, true);
  assert.strictEqual(captured.dbPaths.length, 2);
  assert.notStrictEqual(captured.dbPaths[0], captured.dbPaths[1]);
  await assert.rejects(
    () => runner.runPrivateFullChain(liveOptions("match-live", "candidate", {
      profile: profilePath, matchingCard: cardPath, jobs: jobsPath, labels: labelsPath
    }), authorizedEnv(), seamFor("candidate")),
    (error) => error.code === "PRIVATE_FULL_CHAIN_CACHE_EXISTS"
  );
  assert.strictEqual(captured.dbPaths.length, 2, "same-side cache reuse must fail before opening SQLite");
  assert.deepStrictEqual(new Set(candidate.rows.map((row) => row.id)), new Set(labels.rows.map((row) => row.id)));
  const capturedMatch = captured.matchInputs.find((input) => input.candidateMatchCard);
  assert.deepStrictEqual(capturedMatch.candidateProfile, confirmedProfile);
  assert.deepStrictEqual(capturedMatch.candidateMatchCard, confirmedCard);
  for (const field of [
    "resumeContentSha256", "identityManifestSha256", "fixtureProfileSha256",
    "fixtureMatchingCardSha256", "fixtureJobSetSha256", "fixtureLabelsSha256", "modelIdentitySha256"
  ]) {
    assert.strictEqual(baseline[field], candidate[field], `${field} must match across sides`);
  }
  const serializedRows = JSON.stringify(candidate.rows);
  for (const job of jobs) assert(!serializedRows.includes(job.description), "match rows must not copy full JD text");
  assert(!serializedRows.includes("Synthetic Candidate"), "match rows must not copy identity-bearing model text");
  assert(!serializedRows.includes(jobs[0].description.slice(0, 48)), "match rows must not copy partial JD excerpts");
  assert.strictEqual(captured.formalProviderResolutions, 0);

  const compared = runner.comparePrivateFullChainResults(baseline, candidate);
  assert.strictEqual(compared.ok, true);
  assert.strictEqual(compared.report.accepted, true);
  assert.deepStrictEqual(compared.report.profile, {
    baselineSha256: baseline.fixtureProfileSha256,
    candidateSha256: candidate.fixtureProfileSha256,
    baselineReviewStatus: "confirmed",
    candidateReviewStatus: "confirmed"
  });
  assert.strictEqual(compared.report.card.baselineConsumed, false);
  assert.strictEqual(compared.report.card.candidateConsumed, true);
  for (const field of ["enteredNotRecommended", "exitedNotRecommended", "enteredPrimary", "hardBlockerChanges"]) {
    assert(Array.isArray(compared.report[field]), `${field} must be reported`);
  }

  const forgedSummary = { ...candidate, total: candidate.total + 1 };
  assert.strictEqual(runner.comparePrivateFullChainResults(baseline, forgedSummary).code, "BENCHMARK_COMPARE_METRICS");
  const duplicateId = { ...candidate, rows: [...candidate.rows, { ...candidate.rows[0] }] };
  assert.strictEqual(runner.comparePrivateFullChainResults(baseline, duplicateId).code, "BENCHMARK_COMPARE_METRICS");
  const tamperedLabels = structuredClone(candidate);
  tamperedLabels.rows[0].expectedRecommendation = "caution";
  tamperedLabels.rows[0].actualRecommendation = "caution";
  tamperedLabels.rows[0].expectedBucket = "talk";
  tamperedLabels.rows[0].actualBucket = "talk";
  tamperedLabels.rows[0].pass = true;
  Object.assign(tamperedLabels, deriveBenchmarkMetrics(tamperedLabels.rows).metrics);
  assert.strictEqual(runner.comparePrivateFullChainResults(baseline, tamperedLabels).code, "BENCHMARK_COMPARE_FIXTURE_SET");
  const truncated = structuredClone(candidate);
  truncated.rows.pop();
  Object.assign(truncated, deriveBenchmarkMetrics(truncated.rows).metrics);
  assert.strictEqual(runner.comparePrivateFullChainResults(baseline, truncated).code, "BENCHMARK_COMPARE_FIXTURE_SET");
  const mismatchedIdentity = { ...candidate, resumeContentSha256: "f".repeat(64) };
  assert.strictEqual(runner.comparePrivateFullChainResults(baseline, mismatchedIdentity).ok, false);
  const invalidBundle = privatePath("cli-invalid-identity");
  const invalidBaseline = path.join(invalidBundle, "runs", "baseline", "match-result.json");
  const invalidCandidate = path.join(invalidBundle, "runs", "candidate", "match-result.json");
  const invalidReport = path.join(invalidBundle, "reports", "full-chain-compare.json");
  fs.mkdirSync(path.dirname(invalidBaseline), { recursive: true });
  fs.mkdirSync(path.dirname(invalidCandidate), { recursive: true });
  fs.writeFileSync(invalidBaseline, JSON.stringify(baseline), "utf8");
  fs.writeFileSync(invalidCandidate, JSON.stringify(mismatchedIdentity), "utf8");
  const { spawnSync } = require("node:child_process");
  const invalidCli = spawnSync(process.execPath, [
    path.resolve(__dirname, "..", "scripts", "private-full-chain-runner.js"),
    "--compare", "--baseline", invalidBaseline, "--candidate", invalidCandidate, "--report", invalidReport
  ], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
  assert.notStrictEqual(invalidCli.status, 0);
  assert(!fs.existsSync(invalidReport), "identity mismatch must not generate an accepted report");

  const rejectedCandidate = structuredClone(candidate);
  Object.assign(rejectedCandidate.rows[0], {
    actualRecommendation: "caution",
    actualBucket: "talk",
    pass: false
  });
  const rejected = runner.comparePrivateFullChainResults(baseline, applyDerivedMetrics(rejectedCandidate));
  assert.strictEqual(rejected.ok, true);
  assert.strictEqual(rejected.report.accepted, false);

  const cliBundle = privatePath("cli-rejected");
  const cliBaseline = path.join(cliBundle, "runs", "baseline", "match-result.json");
  const cliCandidate = path.join(cliBundle, "runs", "candidate", "match-result.json");
  const cliReport = path.join(cliBundle, "reports", "full-chain-compare.json");
  fs.mkdirSync(path.dirname(cliBaseline), { recursive: true });
  fs.mkdirSync(path.dirname(cliCandidate), { recursive: true });
  fs.writeFileSync(cliBaseline, JSON.stringify(baseline), "utf8");
  fs.writeFileSync(cliCandidate, JSON.stringify(applyDerivedMetrics(rejectedCandidate)), "utf8");
  const cli = spawnSync(process.execPath, [
    path.resolve(__dirname, "..", "scripts", "private-full-chain-runner.js"),
    "--compare", "--baseline", cliBaseline, "--candidate", cliCandidate, "--report", cliReport
  ], { cwd: path.resolve(__dirname, ".."), encoding: "utf8", env: { ...process.env, ALLOW_LIVE_MODEL_BENCHMARK: "" } });
  assert.notStrictEqual(cli.status, 0, "business rejection must exit non-zero");
  assert.strictEqual(JSON.parse(fs.readFileSync(cliReport, "utf8")).accepted, false);
  assert(fs.existsSync(cliReport.replace(/\.json$/i, ".md")));
}

async function main() {
  fs.rmSync(testRoot, { recursive: true, force: true });
  fs.rmSync(siblingBaselineRoot, { recursive: true, force: true });
  fs.rmSync(externalRoot, { recursive: true, force: true });
  try {
    expectGate("PRIVATE_FULL_CHAIN_MODE_REQUIRED", gateOptions({ mode: "" }));
    expectGate("PRIVATE_FULL_CHAIN_PRIVATE_ROOT_REQUIRED", gateOptions({ privateRoot: "" }));
    expectGate("PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN", gateOptions({ privateRoot: "D:\\unsafe-private-root" }));
    expectGate("PRIVATE_FULL_CHAIN_RESUME_REQUIRED", gateOptions({ pdf: "" }));
    expectGate("PRIVATE_FULL_CHAIN_IDENTITY_REQUIRED", gateOptions({ identity: "" }));
    expectGate("PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED", gateOptions({ output: "" }));
    expectGate("PRIVATE_FULL_CHAIN_NOT_AUTHORIZED", gateOptions(), {});

    const live = gateOptions({
      mode: "profile-live",
      side: "candidate",
      resumeText: privatePath("input", "resume.redacted.txt"),
      output: privatePath("runs", "candidate"),
      modelSettingsRoot: "D:\\Guo\\ZhiPing",
      modelDescriptor: { provider: "real-test-provider" }
    });
    delete live.pdf;
    expectGate("PRIVATE_FULL_CHAIN_MODEL_NOT_AUTHORIZED", live, {
      ALLOW_PRIVATE_RESUME_BENCHMARK: "YES"
    });
    expectGate("PRIVATE_FULL_CHAIN_MODEL_SETTINGS_ROOT_REQUIRED", { ...live, modelSettingsRoot: "" });
    expectGate("PRIVATE_FULL_CHAIN_MODEL_SETTINGS_ROOT_FORBIDDEN", { ...live, modelSettingsRoot: privatePath("forbidden-settings") });
    expectGate("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", gateOptions({ gitProof: { clean: false, commit: "39557f2" } }));
    expectGate("PRIVATE_FULL_CHAIN_REAL_MODEL_REQUIRED", { ...live, modelDescriptor: { provider: "mock" } });

    expectGateOk({
      mode: "card-live", privateRoot: testRoot, side: "candidate", profile: privatePath("runs", "candidate", "profile.json"),
      output: privatePath("runs", "candidate"), modelSettingsRoot: "D:\\Guo\\ZhiPing", modelDescriptor: { provider: "real" }, gitProof: { clean: true, commit: "39557f2" }
    });
    expectGateOk({
      mode: "match-live", privateRoot: testRoot, side: "baseline", profile: privatePath("input", "confirmed-profile.private.json"),
      matchingCard: privatePath("input", "confirmed-card.private.json"), jobs: privatePath("input", "jobs.private.json"), labels: privatePath("labels", "jobs.reviewed.json"),
      output: privatePath("runs", "baseline"), modelSettingsRoot: "D:\\Guo\\ZhiPing", modelDescriptor: { provider: "real" }, gitProof: { clean: true, commit: "39557f2" }
    });
    expectGate("PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN", gateOptions({ privateRoot: path.resolve(__dirname, "..") }));
    expectGate("PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN", gateOptions({ privateRoot: "D:\\" }));
    expectGate("PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN", gateOptions({ privateRoot: "https://example.invalid/private" }));

    const bundle = privatePath("bundle");
    expectGateOk({
      mode: "compare", baseline: path.join(bundle, "runs", "baseline", "match-result.json"),
      candidate: path.join(bundle, "runs", "candidate", "match-result.json"), report: path.join(bundle, "reports", "full-chain-compare.json")
    }, {});
    expectGate("PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED", {
      mode: "compare", baseline: path.join(bundle, "runs", "baseline", "match-result.json"),
      candidate: path.join(privatePath("other-bundle"), "runs", "candidate", "match-result.json"), report: path.join(bundle, "reports", "full-chain-compare.json")
    }, {});
    expectGate("PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN", {
      mode: "init-manifest", privateRoot: testRoot, baselineWorktree: privatePath("baseline"), candidateWorktree: "D:\\Guo\\ZhiPing", output: privatePath("run-manifest.json")
    }, {});
    expectGateOk({
      mode: "init-manifest", privateRoot: testRoot, baselineWorktree: siblingBaselineRoot,
      candidateWorktree: "D:\\DevData\\RoleFlow-worktrees\\claude-generic-evidence-matching-live-fix", output: privatePath("run-manifest.json")
    }, {});
    expectGate("PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN", {
      mode: "init-manifest", privateRoot: testRoot, baselineWorktree: testRoot,
      candidateWorktree: "D:\\DevData\\RoleFlow-worktrees\\claude-generic-evidence-matching-live-fix", output: privatePath("run-manifest.json")
    }, {});

    fs.mkdirSync(testRoot, { recursive: true });
    const danglingAlias = privatePath("dangling-junction");
    fs.symlinkSync(path.join(externalRoot, "missing-junction-target"), danglingAlias, "junction");
    expectGate("PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN", gateOptions({
      privateRoot: path.join(danglingAlias, "bundle"),
      identity: path.join(danglingAlias, "bundle", "identity.private.json"),
      output: path.join(danglingAlias, "bundle", "output")
    }));
    const pdfPath = externalPdf;
    const identityPath = privatePath("identity.private.json");
    fs.mkdirSync(externalRoot, { recursive: true });
    const gitProbe = path.join(externalRoot, "git-was-called.txt");
    fs.writeFileSync(path.join(externalRoot, "git.cmd"), `@echo off\necho called > "${gitProbe}"\nexit /b 1\n`, "utf8");
    const { spawnSync } = require("node:child_process");
    const cliFailure = spawnSync(process.execPath, [path.resolve(__dirname, "..", "scripts", "private-full-chain-runner.js"), "--prepare", "--private-root", "D:\\unsafe-private-root"], {
      encoding: "utf8", cwd: path.resolve(__dirname, ".."), env: { ...authorizedEnv(), PATH: `${externalRoot};${process.env.PATH}` }
    });
    assert.notStrictEqual(cliFailure.status, 0);
    assert(`${cliFailure.stdout}${cliFailure.stderr}`.includes("PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN"));
    assert(!fs.existsSync(gitProbe), "CLI must finish pure path/authorization validation before spawning git");
    const copiedScripts = path.join(externalRoot, "baseline-runner-blob", "scripts");
    fs.mkdirSync(path.join(copiedScripts, "lib"), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "..", "scripts", "private-full-chain-runner.js"), path.join(copiedScripts, "private-full-chain-runner.js"));
    fs.copyFileSync(path.resolve(__dirname, "..", "scripts", "lib", "benchmark_metrics.js"), path.join(copiedScripts, "lib", "benchmark_metrics.js"));
    const copiedRunner = require(path.join(copiedScripts, "private-full-chain-runner.js"));
    const copiedManifestGate = copiedRunner.validatePrivateFullChainRequest({
      mode: "init-manifest", privateRoot: testRoot, baselineWorktree: privatePath("baseline-worktree"),
      candidateWorktree: "D:\\DevData\\RoleFlow-worktrees\\claude-generic-evidence-matching-live-fix", output: privatePath("run-manifest.json")
    }, {}, null);
    assert.strictEqual(copiedManifestGate.ok, true, "the same runner blob must recognize the literal candidate path outside its own checkout");
    fs.writeFileSync(pdfPath, makeSyntheticPdf());
    fs.writeFileSync(identityPath, JSON.stringify({
      names: ["Synthetic Candidate"],
      phones: ["13800138000"],
      emails: ["candidate@example.com"]
    }, null, 2));

    await injectedLiveFlowSmoke(identityPath);

    if (!candidateWorktreeIsClean()) {
      await assert.rejects(
        () => runner.preparePrivateResume(gateOptions({ pdf: pdfPath, identity: identityPath, output: privatePath("identity-from-file"), identityValue: { names: [], phones: [], emails: [] } }), authorizedEnv()),
        (error) => error.code === "PRIVATE_FULL_CHAIN_WORKTREE_DIRTY"
      );
      console.log("private_full_chain_runner_smoke offline gates ok (public prepare deferred until clean worktree)");
      return;
    }
    await runner.preparePrivateResume(gateOptions({
      pdf: pdfPath, identity: identityPath, output: privatePath("identity-from-file"), identityValue: { names: [], phones: [], emails: [] }
    }), authorizedEnv());
    assert(fs.existsSync(privatePath("identity-from-file", "resume.redacted.txt")), "runtime identityValue must not bypass the gated identity file");

    fs.writeFileSync(identityPath, "not-json", "utf8");
    await assert.rejects(
      () => runner.preparePrivateResume(gateOptions({
        pdf: pdfPath,
        identity: identityPath,
        output: privatePath("invalid-identity")
      }), authorizedEnv()),
      (error) => error.code === "PRIVATE_FULL_CHAIN_INPUT_IDENTITY"
    );
    assert(!fs.existsSync(privatePath("invalid-identity")), "identity failure must not create output directories");
    fs.writeFileSync(identityPath, JSON.stringify({
      names: ["Synthetic Candidate"],
      phones: ["13800138000"],
      emails: ["candidate@example.com"]
    }, null, 2));

    const output = privatePath("prepared");
    const result = await runner.preparePrivateResume(gateOptions({
      pdf: pdfPath,
      identity: identityPath,
      output
    }), authorizedEnv());
    assert.strictEqual(result.runMode, "private-prepare");
    assert.deepStrictEqual(fs.readdirSync(output).sort(), ["parse-report.json", "resume.redacted.txt"]);
    const redacted = fs.readFileSync(path.join(output, "resume.redacted.txt"), "utf8");
    for (const secret of ["Synthetic Candidate", "13800138000", "candidate@example.com"]) {
      assert(!redacted.includes(secret), `redacted output must not contain ${secret}`);
    }
    for (const fact of ["Example Company", "Project Alpha", "Project Beta", "Node.js"]) {
      assert(redacted.includes(fact), `redacted output must retain ${fact}`);
    }
    assert(redacted.indexOf("Project Alpha") < redacted.indexOf("Project Beta"), "PDF text order must be preserved");

    const report = JSON.parse(fs.readFileSync(path.join(output, "parse-report.json"), "utf8"));
    assert.deepStrictEqual(Object.keys(report).sort(), [
      "authorizationGatePassed", "charCount", "detectedSections", "evaluatedCommit",
      "extractionMethod", "identityManifestSha256", "missingSections", "redactions",
      "resumeContentSha256", "runMode", "textTruncated"
    ].sort());
    assert.strictEqual(report.resumeContentSha256, crypto.createHash("sha256").update(redacted).digest("hex"));
    assert(!JSON.stringify(report).includes("Synthetic Candidate"));
    assert(!JSON.stringify(report).includes("candidate@example.com"));
    assert(!JSON.stringify(report).includes(pdfPath));

    assert.deepStrictEqual(runner.verifyPrivateBundle({
      privateRoot: testRoot, resumeText: path.join(output, "resume.redacted.txt"), identity: identityPath, parseReport: path.join(output, "parse-report.json")
    }), { ok: true, runMode: "offline-verify-private-bundle" });

    fs.writeFileSync(path.join(output, "parse-report.json"), JSON.stringify({ ...report, textTruncated: true }), "utf8");
    assert.deepStrictEqual(runner.verifyPrivateBundle({
      privateRoot: testRoot, resumeText: path.join(output, "resume.redacted.txt"), identity: identityPath, parseReport: path.join(output, "parse-report.json")
    }), { ok: true, runMode: "offline-verify-private-bundle" }, "stored redacted text cannot disprove parser truncation provenance");
    fs.writeFileSync(path.join(output, "parse-report.json"), JSON.stringify({ ...report, textTruncated: "true" }), "utf8");
    assert.throws(
      () => runner.verifyPrivateBundle({ privateRoot: testRoot, resumeText: path.join(output, "resume.redacted.txt"), identity: identityPath, parseReport: path.join(output, "parse-report.json") }),
      (error) => error.code === "PRIVATE_FULL_CHAIN_INPUT_IDENTITY"
    );

    fs.writeFileSync(path.join(output, "parse-report.json"), JSON.stringify({ ...report, preview: "Synthetic Candidate" }), "utf8");
    assert.throws(
      () => runner.verifyPrivateBundle({ privateRoot: testRoot, resumeText: path.join(output, "resume.redacted.txt"), identity: identityPath, parseReport: path.join(output, "parse-report.json") }),
      (error) => error.code === "PRIVATE_FULL_CHAIN_INPUT_IDENTITY"
    );
    const reordered = redacted.replace("Education: Example University computer science\n", "").replace("Experience: Example Company platform work\n", "Education: Example University computer science\nExperience: Example Company platform work\n");
    fs.writeFileSync(path.join(output, "resume.redacted.txt"), reordered, "utf8");
    fs.writeFileSync(path.join(output, "parse-report.json"), JSON.stringify({ ...report, resumeContentSha256: crypto.createHash("sha256").update(reordered).digest("hex") }), "utf8");
    assert.throws(
      () => runner.verifyPrivateBundle({ privateRoot: testRoot, resumeText: path.join(output, "resume.redacted.txt"), identity: identityPath, parseReport: path.join(output, "parse-report.json") }),
      (error) => error.code === "PRIVATE_FULL_CHAIN_INPUT_IDENTITY"
    );

    const shortPdfPath = path.join(externalRoot, "private-source-name.pdf");
    fs.writeFileSync(shortPdfPath, makeShortPdf());
    await assert.rejects(
      () => runner.preparePrivateResume(gateOptions({ pdf: shortPdfPath, identity: identityPath, output: privatePath("parse-failure") }), authorizedEnv()),
      (error) => {
        const serialized = `${error.code}|${error.message}|${JSON.stringify(error.details || {})}`;
        return !serialized.includes("Synthetic Candidate") && !serialized.includes("candidate@example.com") && !serialized.includes(shortPdfPath);
      }
    );
    assert(!fs.existsSync(privatePath("parse-failure")), "sanitized parser failure must not create output directories");

    createSyntheticBaselineCheckout(siblingBaselineRoot);
    const baselineRunner = require(path.join(siblingBaselineRoot, "scripts", "private-full-chain-runner.js"));
    const manifestPath = privatePath("run-manifest.json");
    const manifest = baselineRunner.initializePrivateManifest({
      privateRoot: testRoot, baselineWorktree: siblingBaselineRoot,
      candidateWorktree: "D:\\DevData\\RoleFlow-worktrees\\claude-generic-evidence-matching-live-fix", output: manifestPath
    });
    const { execFileSync } = require("node:child_process");
    const head = (cwd) => execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", windowsHide: true }).trim();
    assert.strictEqual(manifest.baselineCommit, head(siblingBaselineRoot));
    assert.strictEqual(manifest.candidateCommit, head(path.resolve(__dirname, "..")));
    assert.notStrictEqual(manifest.baselineCommit, manifest.candidateCommit);
    for (const file of ["src/core/resume_parser.js", "src/core/pdf_text.js", "src/core/resume_privacy.js", "scripts/lib/benchmark_metrics.js"]) {
      assert.strictEqual(manifest.sharedFileBlobs[file], execFileSync("git", ["rev-parse", `HEAD:${file}`], { cwd: siblingBaselineRoot, encoding: "utf8", windowsHide: true }).trim());
    }
    assert(fs.existsSync(manifestPath));
    console.log("private_full_chain_runner_smoke offline gates ok");
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.rmSync(siblingBaselineRoot, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
}

function createSyntheticBaselineCheckout(root) {
  const { execFileSync } = require("node:child_process");
  const candidateRoot = path.resolve(__dirname, "..");
  const files = [
    "scripts/private-full-chain-runner.js", "scripts/lib/benchmark_metrics.js",
    "src/core/resume_parser.js", "src/core/pdf_text.js", "src/core/resume_privacy.js"
  ];
  fs.mkdirSync(root, { recursive: true });
  for (const file of files) {
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(candidateRoot, file), destination);
  }
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  git(["init", "-q"]);
  git(["config", "user.email", "synthetic@example.invalid"]);
  git(["config", "user.name", "Synthetic Baseline"]);
  git(["add", "."]);
  git(["commit", "-qm", "synthetic baseline"]);
}

function makeShortPdf() {
  const content = [textAt("Name: Synthetic Candidate", 72, 720), textAt("Email: candidate@example.com", 72, 690)].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    streamObject(content), "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) { offsets.push(Buffer.byteLength(output, "ascii")); output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`; }
  const xref = Buffer.byteLength(output, "ascii");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "ascii");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

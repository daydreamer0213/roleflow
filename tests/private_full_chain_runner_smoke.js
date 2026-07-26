const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const runner = require("../scripts/private-full-chain-runner");
const { createJobAnalysisRunner } = require("../src/core/job_analysis");
const { normalizeMatchingCard } = require("../src/core/matching_card");
const { profileToRuntimeConfigs } = require("../src/core/search_plan");
const { scoreJob, decisionState } = require("../src/core/scoring");
const { openDb, decisionBucket } = require("../src/core/storage");
const { mapWithConcurrency } = require("../src/core/async_pool");
const { assertResumeIdentityRedacted } = require("../src/core/resume_privacy");
const { decisionHardBlockers } = require("../src/core/model_contract");
const { deriveBenchmarkMetrics } = require("../scripts/lib/benchmark_metrics");
const genericFixtures = require("./fixtures/generic_evidence_matching.json");

const PRIVATE_PARENT = "D:\\DevData\\RoleFlow-private-benchmark";
const testRoot = path.join(PRIVATE_PARENT, `synthetic-private-full-chain-runner-${process.pid}`);
const siblingBaselineRoot = path.join(PRIVATE_PARENT, `synthetic-private-full-chain-baseline-${process.pid}`);
const externalRoot = path.join("D:\\DevData\\RoleFlow-private-runner-fixtures", `synthetic-private-full-chain-runner-${process.pid}`);
const externalPdf = path.join(externalRoot, "synthetic-resume.pdf");
const downloadsRoot = path.join(os.homedir(), "Downloads", `roleflow-private-runner-${process.pid}`);

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

async function withoutRepositoryModelSettings(flow) {
  const repositoryModelSettings = path.resolve(__dirname, "..", "configs", "model.json");
  const originalExistsSync = fs.existsSync;
  const originalReadFileSync = fs.readFileSync;
  let reads = 0;
  fs.existsSync = (target) => path.resolve(String(target)) === repositoryModelSettings
    ? true
    : originalExistsSync(target);
  fs.readFileSync = (target, ...args) => {
    if (path.resolve(String(target)) === repositoryModelSettings) {
      reads += 1;
      throw new Error("injected private runner flow must not read repository model settings");
    }
    return originalReadFileSync(target, ...args);
  };
  try {
    await flow();
  } finally {
    fs.existsSync = originalExistsSync;
    fs.readFileSync = originalReadFileSync;
  }
  assert.strictEqual(reads, 0, "injected private runner flow must not access configs/model.json");
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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableJson(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("value is not JSON serializable");
  return canonicalJson(JSON.parse(serialized));
}

function valueSha256(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function sourceContentHash(job) {
  return crypto.createHash("sha256").update(JSON.stringify({
    title: job.title || "",
    company: job.company || "",
    location: job.location || "",
    salary: job.salary || "",
    experience: "",
    education: "",
    tags: [],
    description: job.description || ""
  })).digest("hex");
}

function confirmedProfileEnvelope(result, id) {
  return {
    ...result,
    id,
    status: "confirmed",
    userConfirmed: true,
    confirmedAt: "2026-07-25T00:00:00.000Z"
  };
}

function confirmedCardEnvelope(profileEnvelope, draft, card, id) {
  return {
    id,
    status: "confirmed",
    userConfirmed: true,
    confirmedAt: "2026-07-25T00:00:00.000Z",
    runMode: profileEnvelope.runMode,
    authorizationGatePassed: profileEnvelope.authorizationGatePassed,
    benchmarkHarnessVersion: profileEnvelope.benchmarkHarnessVersion,
    runManifestSha256: profileEnvelope.runManifestSha256,
    side: profileEnvelope.side,
    evaluatedCommit: profileEnvelope.evaluatedCommit,
    worktreeClean: profileEnvelope.worktreeClean,
    modelIdentity: profileEnvelope.modelIdentity,
    modelIdentitySha256: profileEnvelope.modelIdentitySha256,
    resumeContentSha256: profileEnvelope.resumeContentSha256,
    identityManifestSha256: profileEnvelope.identityManifestSha256,
    profileResultSha256: profileEnvelope.profileResultSha256,
    profileSha256: profileEnvelope.profileSha256,
    cardSha256: valueSha256(card),
    draftProfileResultSha256: draft.profileResultSha256,
    draftSha256: draft.draftSha256,
    draft,
    card
  };
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
    harnessVersion: "private-full-chain-harness.v1",
    baselineProductCommit: "3".repeat(40),
    baselineEvaluatedCommit: "1".repeat(40),
    candidateProductCommit: "2".repeat(40),
    candidateEvaluatedCommit: "2".repeat(40),
    sharedFileBlobs: {}
  };
  const runManifestSha256 = valueSha256(manifest);
  const jobs = selected.map((fixture) => {
    const job = {
      id: fixture.id,
      sourceId: fixture.id,
      keyword: "合成关键词",
      title: fixture.job.title,
      company: "Synthetic Corp",
      location: "广州",
      salary: fixture.job.salary,
      url: `https://www.zhipin.com/job_detail/synthetic-${fixture.id}.html`,
      description: fixture.job.description.padEnd(120, " synthetic full JD detail"),
      capturedAt: "2026-07-25T00:00:00.000Z"
    };
    return { ...job, sourceContentHash: sourceContentHash(job) };
  });
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
        timeoutMs: 4321,
        temperature: 0.1,
        maxTokens: 4096,
        apiKey: "synthetic-secret-alpha"
      }
    }
  };
  const baseConfigs = {
    profile: {
      candidate: { name: "Synthetic Candidate", city: "", target_roles: [], strengths: [] },
      location: { target_cities: [], default_city: "", boss_city_code: "" },
      safety: { read_only: true, manual_confirmation_required: true }
    },
    keywords: { keywords: [] },
    scoring: {
      boss_activity: { max_active_days: 3, unknown_penalty: 3, inactive_penalty: 10 },
      work_schedule: { preference: "prefer_double_weekend", double_weekend_bonus: 4, alternating_weekend_penalty: 3, single_weekend_penalty: 6 },
      salary: { preferred_max_k: 24, hard_max_k: 35, experience_flex_max_k: 18 },
      positive_keywords: [], risk_rules: [], exclude_words: []
    },
    model: { provider: "mock", providers: { mock: {} } },
    candidateProfile: null,
    resumeVersions: { versions: [] }
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
    decisionState: () => "ready",
    decisionBucket,
    decisionHardBlockers,
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
  const seamFor = (side, selectedModelConfig = fakeModelConfig) => ({
    modelConfig: selectedModelConfig,
    baseConfigs,
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

  const profileCandidate = await runner.runPrivateFullChain(liveOptions("profile-live", "candidate", {
    resumeText: resumePath,
    identity: identityPath
  }), authorizedEnv(), seamFor("candidate"));
  for (const result of [profileCandidate]) {
    assert.strictEqual(result.runMode, "offline-test", "injected profile runs must never claim live authorization");
    assert.strictEqual(result.authorizationGatePassed, false);
    assert.strictEqual(result.runManifestSha256, runManifestSha256);
    assert.strictEqual(result.profileResultSha256, valueSha256({
      ...result,
      profileResultSha256: undefined
    }));
  }
  assert.strictEqual(captured.resumeInputs.length, 1);
  assert.strictEqual(captured.resumeInputs[0].resume.text.includes("测试候选人"), false);
  assert.strictEqual(captured.resumeInputs[0].strictPrivacy, true);
  assert.deepStrictEqual(profileCandidate.profile, confirmedProfile);
  const changedRequestConfig = structuredClone(fakeModelConfig);
  changedRequestConfig.providers["synthetic-provider"].temperature = 0.9;
  fs.rmSync(privatePath("runs", "candidate", "profile.json"));
  const changedRequestProfile = await runner.runPrivateFullChain(liveOptions("profile-live", "candidate", {
    resumeText: resumePath,
    identity: identityPath
  }), authorizedEnv(), seamFor("candidate", changedRequestConfig));
  assert.notStrictEqual(
    changedRequestProfile.modelIdentitySha256,
    profileCandidate.modelIdentitySha256,
    "request-affecting temperature must change private model identity"
  );
  const changedSecretConfig = structuredClone(fakeModelConfig);
  changedSecretConfig.providers["synthetic-provider"].apiKey = "synthetic-secret-beta";
  fs.rmSync(privatePath("runs", "candidate", "profile.json"));
  const changedSecretProfile = await runner.runPrivateFullChain(liveOptions("profile-live", "candidate", {
    resumeText: resumePath,
    identity: identityPath
  }), authorizedEnv(), seamFor("candidate", changedSecretConfig));
  assert.strictEqual(
    changedSecretProfile.modelIdentitySha256,
    profileCandidate.modelIdentitySha256,
    "secret values must not enter private model identity"
  );
  const optionalProfileSeam = seamFor("candidate");
  optionalProfileSeam.modules = {
    ...optionalProfileSeam.modules,
    analyzeResumeProfile: async () => ({ ...confirmedProfile, optionalUndefined: undefined })
  };
  fs.rmSync(privatePath("runs", "candidate", "profile.json"));
  const optionalProfileResult = await runner.runPrivateFullChain(liveOptions("profile-live", "candidate", {
    resumeText: resumePath,
    identity: identityPath
  }), authorizedEnv(), optionalProfileSeam);
  const persistedOptionalProfile = JSON.parse(fs.readFileSync(privatePath("runs", "candidate", "profile.json"), "utf8"));
  assert.strictEqual(
    optionalProfileResult.profileSha256,
    valueSha256(persistedOptionalProfile.profile),
    "profile hash must survive JSON write/read when optional fields are undefined"
  );
  assert.strictEqual(Object.hasOwn(persistedOptionalProfile.profile, "optionalUndefined"), false);
  fs.writeFileSync(privatePath("runs", "candidate", "profile.json"), JSON.stringify(profileCandidate, null, 2), "utf8");

  assert.throws(
    () => runner.validateProfileResultProvenance(profileCandidate, {
      injected: false,
      manifest,
      runManifestSha256,
      side: "candidate",
      evaluatedCommit: "2".repeat(40)
    }),
    (error) => error.code === "PRIVATE_FULL_CHAIN_INPUT_IDENTITY",
    "a formal card run must reject an offline-test profile result"
  );
  assert.doesNotThrow(
    () => runner.validateProfileResultProvenance(profileCandidate, {
      injected: true,
      manifest,
      runManifestSha256,
      side: "baseline",
      evaluatedCommit: "1".repeat(40)
    }),
    "baseline matching must accept the one candidate-derived canonical profile"
  );
  const tamperedProfilePath = privatePath("input", "tampered-profile-result.json");
  fs.writeFileSync(tamperedProfilePath, JSON.stringify({
    ...profileCandidate,
    runManifestSha256: "f".repeat(64)
  }), "utf8");
  let cardPreflightConfigReads = 0;
  const cardPreflightSeam = seamFor("candidate");
  delete cardPreflightSeam.baseConfigs;
  delete cardPreflightSeam.modelConfig;
  cardPreflightSeam.modules = {
    ...cardPreflightSeam.modules,
    loadConfigs: () => { cardPreflightConfigReads += 1; throw new Error("config must not load"); }
  };
  await assert.rejects(
    () => runner.runPrivateFullChain(liveOptions("card-live", "candidate", {
      profile: tamperedProfilePath
    }), authorizedEnv(), cardPreflightSeam),
    (error) => error.code === "PRIVATE_FULL_CHAIN_INPUT_IDENTITY"
  );
  assert.strictEqual(cardPreflightConfigReads, 0, "profile provenance must fail before loadConfigs");

  await assert.rejects(
    () => runner.runPrivateFullChain(liveOptions("profile-live", "baseline", {
      resumeText: resumePath,
      identity: identityPath
    }), authorizedEnv(), seamFor("baseline")),
    (error) => error.code === "PRIVATE_FULL_CHAIN_PROFILE_UNSUPPORTED"
  );

  await assert.rejects(
    () => runner.runPrivateFullChain(liveOptions("card-live", "baseline", {
      profile: privatePath("runs", "candidate", "profile.json")
    }), authorizedEnv(), { ...seamFor("baseline"), modules: { ...commonModules, buildCandidateMatchCard: undefined } }),
    (error) => error.code === "PRIVATE_FULL_CHAIN_CARD_UNSUPPORTED"
  );
  const draft = await runner.runPrivateFullChain(liveOptions("card-live", "candidate", {
    profile: privatePath("runs", "candidate", "profile.json")
  }), authorizedEnv(), seamFor("candidate"));
  assert.strictEqual(draft.runMode, "offline-test", "injected card runs must never claim live authorization");
  assert.strictEqual(draft.authorizationGatePassed, false);
  assert.strictEqual(draft.status, "draft");
  assert.strictEqual(draft.userConfirmed, false);
  assert.strictEqual(draft.profileSha256, profileCandidate.profileSha256);
  assert.strictEqual(draft.runManifestSha256, runManifestSha256);
  assert.strictEqual(draft.cardSha256, valueSha256(draft.card));
  assert.strictEqual(draft.draftSha256, valueSha256({ ...draft, draftSha256: undefined }));
  assert.deepStrictEqual(captured.cardProfile, confirmedProfile);

  const profileEnvelope = confirmedProfileEnvelope(profileCandidate, "private-confirmed-profile-v1");
  const cardEnvelope = confirmedCardEnvelope(profileEnvelope, draft, confirmedCard, "private-confirmed-card-v1");
  fs.writeFileSync(profilePath, JSON.stringify(profileEnvelope, null, 2), "utf8");
  fs.writeFileSync(cardPath, JSON.stringify(cardEnvelope, null, 2), "utf8");
  const createMatchProbeBundle = (name, side = "candidate") => {
    const root = privatePath(name);
    const input = path.join(root, "input");
    const labelRoot = path.join(root, "labels");
    fs.mkdirSync(input, { recursive: true });
    fs.mkdirSync(labelRoot, { recursive: true });
    fs.copyFileSync(resumePath, path.join(input, "resume.redacted.txt"));
    fs.copyFileSync(identityPath, path.join(input, "identity.private.json"));
    fs.copyFileSync(profilePath, path.join(input, "confirmed-profile.private.json"));
    fs.copyFileSync(cardPath, path.join(input, "confirmed-card.private.json"));
    fs.copyFileSync(jobsPath, path.join(input, "jobs.private.json"));
    fs.copyFileSync(labelsPath, path.join(labelRoot, "jobs.reviewed.json"));
    fs.writeFileSync(path.join(root, "run-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    return {
      root,
      profile: path.join(input, "confirmed-profile.private.json"),
      card: path.join(input, "confirmed-card.private.json"),
      jobs: path.join(input, "jobs.private.json"),
      labels: path.join(labelRoot, "jobs.reviewed.json"),
      output: path.join(root, "runs", side)
    };
  };
  const draftCardPath = privatePath("input", "draft-card.private.json");
  fs.writeFileSync(draftCardPath, JSON.stringify({ ...cardEnvelope, status: "draft", userConfirmed: false }), "utf8");
  await assert.rejects(
    () => runner.runPrivateFullChain(liveOptions("match-live", "candidate", {
      profile: profilePath, matchingCard: draftCardPath, jobs: jobsPath, labels: labelsPath
    }), authorizedEnv(), seamFor("candidate")),
    (error) => error.code === "PRIVATE_FULL_CHAIN_CARD_UNCONFIRMED"
  );
  assert.strictEqual(captured.dbPaths.length, 0, "unconfirmed card must fail before SQLite creation");

  const preflightProbe = createMatchProbeBundle("preflight-before-formal-dependencies");
  fs.writeFileSync(preflightProbe.profile, "not-json", "utf8");
  const preflightCounts = { loadConfigs: 0, resolveRuntimeModelConfig: 0, provider: 0, openDb: 0 };
  const preflightSeam = seamFor("candidate");
  delete preflightSeam.baseConfigs;
  delete preflightSeam.modelConfig;
  preflightSeam.modules = {
    ...preflightSeam.modules,
    loadConfigs: () => { preflightCounts.loadConfigs += 1; return baseConfigs; },
    resolveRuntimeModelConfig: () => {
      preflightCounts.resolveRuntimeModelConfig += 1;
      return { modelConfig: fakeModelConfig };
    },
    createJobAnalysisRunner: () => { preflightCounts.provider += 1; throw new Error("provider must not initialize"); },
    openDb: () => { preflightCounts.openDb += 1; throw new Error("SQLite must not open"); }
  };
  await assert.rejects(
    () => runner.runPrivateFullChain(liveOptions("match-live", "candidate", {
      privateRoot: preflightProbe.root,
      output: preflightProbe.output,
      profile: preflightProbe.profile,
      matchingCard: preflightProbe.card,
      jobs: preflightProbe.jobs,
      labels: preflightProbe.labels
    }), authorizedEnv(), preflightSeam),
    (error) => error.code === "PRIVATE_FULL_CHAIN_INPUT_IDENTITY"
  );
  assert.deepStrictEqual(preflightCounts, {
    loadConfigs: 0, resolveRuntimeModelConfig: 0, provider: 0, openDb: 0
  }, "invalid private inputs must stop before formal config, provider, or SQLite access");

  const profileForgeryProbe = createMatchProbeBundle("profile-provenance-forgery");
  const unrelatedProfile = JSON.parse(fs.readFileSync(profileForgeryProbe.profile, "utf8"));
  unrelatedProfile.profile = { ...unrelatedProfile.profile, unrelated: true };
  unrelatedProfile.profileSha256 = valueSha256(unrelatedProfile.profile);
  fs.writeFileSync(profileForgeryProbe.profile, JSON.stringify(unrelatedProfile), "utf8");
  await assert.rejects(
    () => runner.runPrivateFullChain(liveOptions("match-live", "candidate", {
      privateRoot: profileForgeryProbe.root,
      output: profileForgeryProbe.output,
      profile: profileForgeryProbe.profile,
      matchingCard: profileForgeryProbe.card,
      jobs: profileForgeryProbe.jobs,
      labels: profileForgeryProbe.labels
    }), authorizedEnv(), preflightSeam),
    (error) => error.code === "PRIVATE_FULL_CHAIN_PROFILE_UNCONFIRMED"
  );
  const profileConfirmationProbe = createMatchProbeBundle("profile-confirmation-provenance-forgery");
  const profileWithoutConfirmationTime = JSON.parse(fs.readFileSync(profileConfirmationProbe.profile, "utf8"));
  delete profileWithoutConfirmationTime.confirmedAt;
  fs.writeFileSync(profileConfirmationProbe.profile, JSON.stringify(profileWithoutConfirmationTime), "utf8");
  await assert.rejects(
    () => runner.runPrivateFullChain(liveOptions("match-live", "candidate", {
      privateRoot: profileConfirmationProbe.root,
      output: profileConfirmationProbe.output,
      profile: profileConfirmationProbe.profile,
      matchingCard: profileConfirmationProbe.card,
      jobs: profileConfirmationProbe.jobs,
      labels: profileConfirmationProbe.labels
    }), authorizedEnv(), preflightSeam),
    (error) => error.code === "PRIVATE_FULL_CHAIN_PROFILE_UNCONFIRMED"
  );
  const cardForgeryProbe = createMatchProbeBundle("card-draft-provenance-forgery");
  const cardWithoutDraft = JSON.parse(fs.readFileSync(cardForgeryProbe.card, "utf8"));
  delete cardWithoutDraft.draft;
  fs.writeFileSync(cardForgeryProbe.card, JSON.stringify(cardWithoutDraft), "utf8");
  await assert.rejects(
    () => runner.runPrivateFullChain(liveOptions("match-live", "candidate", {
      privateRoot: cardForgeryProbe.root,
      output: cardForgeryProbe.output,
      profile: cardForgeryProbe.profile,
      matchingCard: cardForgeryProbe.card,
      jobs: cardForgeryProbe.jobs,
      labels: cardForgeryProbe.labels
    }), authorizedEnv(), preflightSeam),
    (error) => error.code === "PRIVATE_FULL_CHAIN_CARD_UNCONFIRMED"
  );
  const crossProfileDraftProbe = createMatchProbeBundle("card-cross-profile-draft-forgery");
  const crossProfileDraft = JSON.parse(fs.readFileSync(crossProfileDraftProbe.card, "utf8"));
  crossProfileDraft.draft.profileSha256 = "e".repeat(64);
  crossProfileDraft.draft.profileResultSha256 = "d".repeat(64);
  crossProfileDraft.draft.draftSha256 = valueSha256({
    ...crossProfileDraft.draft,
    draftSha256: undefined
  });
  crossProfileDraft.draftProfileResultSha256 = crossProfileDraft.draft.profileResultSha256;
  crossProfileDraft.draftSha256 = crossProfileDraft.draft.draftSha256;
  fs.writeFileSync(crossProfileDraftProbe.card, JSON.stringify(crossProfileDraft), "utf8");
  await assert.rejects(
    () => runner.runPrivateFullChain(liveOptions("match-live", "candidate", {
      privateRoot: crossProfileDraftProbe.root,
      output: crossProfileDraftProbe.output,
      profile: crossProfileDraftProbe.profile,
      matchingCard: crossProfileDraftProbe.card,
      jobs: crossProfileDraftProbe.jobs,
      labels: crossProfileDraftProbe.labels
    }), authorizedEnv(), preflightSeam),
    (error) => error.code === "PRIVATE_FULL_CHAIN_CARD_UNCONFIRMED"
  );
  const cardConfirmationProbe = createMatchProbeBundle("card-confirmation-provenance-forgery");
  const cardWithoutConfirmationTime = JSON.parse(fs.readFileSync(cardConfirmationProbe.card, "utf8"));
  delete cardWithoutConfirmationTime.confirmedAt;
  fs.writeFileSync(cardConfirmationProbe.card, JSON.stringify(cardWithoutConfirmationTime), "utf8");
  await assert.rejects(
    () => runner.runPrivateFullChain(liveOptions("match-live", "candidate", {
      privateRoot: cardConfirmationProbe.root,
      output: cardConfirmationProbe.output,
      profile: cardConfirmationProbe.profile,
      matchingCard: cardConfirmationProbe.card,
      jobs: cardConfirmationProbe.jobs,
      labels: cardConfirmationProbe.labels
    }), authorizedEnv(), preflightSeam),
    (error) => error.code === "PRIVATE_FULL_CHAIN_CARD_UNCONFIRMED"
  );
  assert.deepStrictEqual(preflightCounts, {
    loadConfigs: 0, resolveRuntimeModelConfig: 0, provider: 0, openDb: 0
  }, "profile/card provenance failures must stop before config, provider, or SQLite access");

  const expectFixtureReject = async (name, mutate, { refreshJobsSha = true } = {}) => {
    const probe = createMatchProbeBundle(`fixture-${name}`);
    const probeJobs = JSON.parse(fs.readFileSync(probe.jobs, "utf8"));
    const probeLabels = JSON.parse(fs.readFileSync(probe.labels, "utf8"));
    mutate(probeJobs, probeLabels);
    if (refreshJobsSha) probeLabels.jobsSha256 = valueSha256(probeJobs);
    fs.writeFileSync(probe.jobs, JSON.stringify(probeJobs), "utf8");
    fs.writeFileSync(probe.labels, JSON.stringify(probeLabels), "utf8");
    await assert.rejects(
      () => runner.runPrivateFullChain(liveOptions("match-live", "candidate", {
        privateRoot: probe.root,
        output: probe.output,
        profile: probe.profile,
        matchingCard: probe.card,
        jobs: probe.jobs,
        labels: probe.labels
      }), authorizedEnv(), preflightSeam),
      (error) => error.code === "PRIVATE_FULL_CHAIN_FIXTURE_INVALID",
      name
    );
  };
  await expectFixtureReject("job-extra-field", (probeJobs) => { probeJobs[0].recruiter = "must not persist"; });
  await expectFixtureReject("job-required-field", (probeJobs) => { delete probeJobs[0].url; });
  await expectFixtureReject("job-short-description", (probeJobs) => {
    probeJobs[0].description = "too short";
    probeJobs[0].sourceContentHash = sourceContentHash(probeJobs[0]);
  });
  await expectFixtureReject("job-content-hash", (probeJobs) => { probeJobs[0].sourceContentHash = "f".repeat(64); });
  await expectFixtureReject("labels-version", (_probeJobs, probeLabels) => { probeLabels.labelsVersion = "private-real-jd-labels.v2"; });
  await expectFixtureReject("labels-jobs-sha-required", (_probeJobs, probeLabels) => { delete probeLabels.jobsSha256; }, { refreshJobsSha: false });
  await expectFixtureReject("labels-recommendation-enum", (_probeJobs, probeLabels) => { probeLabels.rows[0].expectedRecommendation = "maybe"; });
  await expectFixtureReject("labels-bucket-enum", (_probeJobs, probeLabels) => { probeLabels.rows[0].expectedBucket = "analysis_pending"; });
  await expectFixtureReject("labels-contradictory-pair", (_probeJobs, probeLabels) => {
    probeLabels.rows[0].expectedRecommendation = "apply";
    probeLabels.rows[0].expectedBucket = "talk";
  });
  await expectFixtureReject("labels-rationale", (_probeJobs, probeLabels) => { probeLabels.rows[0].rationale = "  "; });
  await expectFixtureReject("labels-extra-field", (_probeJobs, probeLabels) => { probeLabels.rows[0].actualRecommendation = "apply"; });
  assert.deepStrictEqual(preflightCounts, {
    loadConfigs: 0, resolveRuntimeModelConfig: 0, provider: 0, openDb: 0
  }, "JD and label integrity failures must stop before config, provider, or SQLite access");

  for (const cacheFile of ["model-cache.sqlite", "model-cache.sqlite-wal", "model-cache.sqlite-shm"]) {
    const cacheProbe = createMatchProbeBundle(`dangling-cache-${cacheFile.replace(/\./g, "_")}`);
    const cachePath = path.join(cacheProbe.output, cacheFile);
    const outsideTarget = path.join(externalRoot, `outside-${cacheFile}`);
    fs.mkdirSync(cacheProbe.output, { recursive: true });
    let danglingFileLink = false;
    try {
      fs.symlinkSync(outsideTarget, cachePath, "file");
      danglingFileLink = true;
    } catch (error) {
      if (error?.code !== "EPERM") throw error;
      fs.writeFileSync(cachePath, "pre-existing SQLite sidecar", "utf8");
    }
    let openDbCalls = 0;
    const cacheSeam = seamFor("candidate");
    cacheSeam.modules = {
      ...cacheSeam.modules,
      openDb: () => { openDbCalls += 1; throw new Error("SQLite must not open unsafe cache paths"); }
    };
    await assert.rejects(
      () => runner.runPrivateFullChain(liveOptions("match-live", "candidate", {
        privateRoot: cacheProbe.root,
        output: cacheProbe.output,
        profile: cacheProbe.profile,
        matchingCard: cacheProbe.card,
        jobs: cacheProbe.jobs,
        labels: cacheProbe.labels
      }), authorizedEnv(), cacheSeam),
      (error) => {
        return cacheFile === "model-cache.sqlite" && !danglingFileLink
        ? error.code === "PRIVATE_FULL_CHAIN_CACHE_EXISTS"
        : error.code === "PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED";
      },
      `${cacheFile} must be rejected before SQLite opens`
    );
    assert.strictEqual(openDbCalls, 0, `${cacheFile} must be rejected before openDb`);
    if (danglingFileLink) {
      assert(!fs.existsSync(outsideTarget), `${cacheFile} must not create an external SQLite artifact`);
    }
  }

  const offlineBaseline = await runner.runPrivateFullChain(liveOptions("match-live", "baseline", {
    profile: profilePath, matchingCard: cardPath, jobs: jobsPath, labels: labelsPath
  }), authorizedEnv(), seamFor("baseline"));
  const offlineCandidate = await runner.runPrivateFullChain(liveOptions("match-live", "candidate", {
    profile: profilePath, matchingCard: cardPath, jobs: jobsPath, labels: labelsPath
  }), authorizedEnv(), seamFor("candidate"));
  for (const result of [offlineBaseline, offlineCandidate]) {
    assert.strictEqual(result.runMode, "offline-test", "injected match runs must never claim live authorization");
    assert.strictEqual(result.authorizationGatePassed, false);
  }
  assert.strictEqual(runner.comparePrivateFullChainResults(offlineBaseline, offlineCandidate).code, "PRIVATE_FULL_CHAIN_COMPARE_IDENTITY");
  const baseline = { ...offlineBaseline, runMode: "live", authorizationGatePassed: true };
  const candidate = { ...offlineCandidate, runMode: "live", authorizationGatePassed: true };
  assert.deepStrictEqual(captured.fifthCardBySide.baseline, confirmedCard);
  assert.deepStrictEqual(captured.fifthCardBySide.candidate, confirmedCard);
  assert.strictEqual(baseline.matchingCardProvided, true);
  assert.strictEqual(baseline.matchingCardConsumed, false);
  assert.strictEqual(candidate.matchingCardProvided, true);
  assert.strictEqual(candidate.matchingCardConsumed, true);
  assert.strictEqual(captured.dbPaths.length, 2);
  assert.notStrictEqual(captured.dbPaths[0], captured.dbPaths[1]);
  assert(fs.existsSync(path.join(privatePath("runs", "baseline"), "model-cache.sqlite")), "baseline must create its SQLite cache normally");
  assert(fs.existsSync(path.join(privatePath("runs", "candidate"), "model-cache.sqlite")), "candidate must create its SQLite cache normally");
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
    "fixtureMatchingCardSha256", "fixtureMatchingCardDraftSha256", "fixtureJobSetSha256",
    "fixtureLabelsSha256", "runManifestSha256", "modelIdentitySha256"
  ]) {
    assert.strictEqual(baseline[field], candidate[field], `${field} must match across sides`);
  }
  assert.match(baseline.fixtureProfileResultSha256, /^[0-9a-f]{64}$/);
  assert.match(candidate.fixtureProfileResultSha256, /^[0-9a-f]{64}$/);
  assert.strictEqual(baseline.fixtureProfileResultSha256, candidate.fixtureProfileResultSha256,
    "both match results must bind the same candidate-derived profile result");
  const serializedRows = JSON.stringify(candidate.rows);
  for (const job of jobs) assert(!serializedRows.includes(job.description), "match rows must not copy full JD text");
  assert(!serializedRows.includes("Synthetic Candidate"), "match rows must not copy identity-bearing model text");
  assert(!serializedRows.includes(jobs[0].description.slice(0, 48)), "match rows must not copy partial JD excerpts");
  assert.strictEqual(captured.formalProviderResolutions, 0);

  const stringProbe = createMatchProbeBundle("unsafe-row-string-probe");
  const unsafeText = `Synthetic Candidate ${jobs[0].description.slice(0, 48)}`;
  const unsafeSeam = seamFor("candidate");
  unsafeSeam.modules = {
    ...unsafeSeam.modules,
    createJobAnalysisRunner: () => async () => ({
      provider: "synthetic-provider",
      semanticStatus: unsafeText,
      decisionSource: unsafeText,
      recommendation: "review",
      evidence: { jd: [], resume: [] },
      fitReasons: [],
      missingPoints: [],
      hardBlockers: [],
      errorCode: unsafeText
    }),
    decisionState: () => "ready",
    decisionBucket: () => "talk"
  };
  const safeRowsResult = await runner.runPrivateFullChain(liveOptions("match-live", "candidate", {
    privateRoot: stringProbe.root,
    output: stringProbe.output,
    profile: stringProbe.profile,
    matchingCard: stringProbe.card,
    jobs: stringProbe.jobs,
    labels: stringProbe.labels
  }), authorizedEnv(), unsafeSeam);
  for (const row of safeRowsResult.rows) {
    assert.strictEqual(row.semanticStatus, "failed");
    assert.strictEqual(row.decisionState, "ready");
    assert.strictEqual(row.explanation.decisionSource, "unknown");
    assert.strictEqual(row.errorCode, "MODEL_ANALYSIS_FAILED");
  }
  assert(!JSON.stringify(safeRowsResult.rows).includes(unsafeText), "unknown runtime/model strings must not survive row projection");
  const stateProbe = createMatchProbeBundle("unsafe-decision-state-probe");
  const unsafeStateSeam = seamFor("candidate");
  unsafeStateSeam.modules = {
    ...unsafeStateSeam.modules,
    decisionState: () => unsafeText,
    decisionBucket: () => "talk"
  };
  const safeStateResult = await runner.runPrivateFullChain(liveOptions("match-live", "candidate", {
    privateRoot: stateProbe.root,
    output: stateProbe.output,
    profile: stateProbe.profile,
    matchingCard: stateProbe.card,
    jobs: stateProbe.jobs,
    labels: stateProbe.labels
  }), authorizedEnv(), unsafeStateSeam);
  assert(safeStateResult.rows.every((row) => row.decisionState === "unknown"));
  assert(!JSON.stringify(safeStateResult.rows).includes(unsafeText), "unknown decision state must not survive row projection");

  const localBlockedProbe = createMatchProbeBundle("local-hard-boundary-probe");
  const localBlockedSeam = seamFor("candidate");
  localBlockedSeam.modules = {
    ...localBlockedSeam.modules,
    decisionState: () => "blocked"
  };
  const localBlockedResult = await runner.runPrivateFullChain(liveOptions("match-live", "candidate", {
    privateRoot: localBlockedProbe.root,
    output: localBlockedProbe.output,
    profile: localBlockedProbe.profile,
    matchingCard: localBlockedProbe.card,
    jobs: localBlockedProbe.jobs,
    labels: localBlockedProbe.labels
  }), authorizedEnv(), localBlockedSeam);
  assert(localBlockedResult.rows.every((row) => row.decisionState === "blocked" && row.hardBlocked === true),
    "local decisionState=blocked must be recorded as hardBlocked even without model blockers");

  const modelBlockerProbe = createMatchProbeBundle("structured-hard-blocker-probe");
  const structuredBlocker = {
    kind: "safety",
    requirement: "收费培训",
    jdEvidence: "JD：入职前收费",
    resumeEvidence: "简历：没有相关安排"
  };
  const modelBlockerSeam = seamFor("candidate");
  modelBlockerSeam.modules = {
    ...modelBlockerSeam.modules,
    createJobAnalysisRunner: () => async () => ({
      provider: "synthetic-provider",
      semanticStatus: "complete",
      decisionSource: "model",
      recommendation: "skip",
      evidence: { jd: ["jd"], resume: ["resume"] },
      fitReasons: [],
      missingPoints: [],
      hardBlockers: [structuredBlocker],
      errorCode: ""
    }),
    decisionState: () => "ready",
    decisionBucket: () => "not_recommended"
  };
  const modelBlockerResult = await runner.runPrivateFullChain(liveOptions("match-live", "candidate", {
    privateRoot: modelBlockerProbe.root,
    output: modelBlockerProbe.output,
    profile: modelBlockerProbe.profile,
    matchingCard: modelBlockerProbe.card,
    jobs: modelBlockerProbe.jobs,
    labels: modelBlockerProbe.labels
  }), authorizedEnv(), modelBlockerSeam);
  assert(modelBlockerResult.rows.every((row) => row.hardBlocked === true),
    "valid structured model hard blockers must be recorded");

  const invalidBlockerProbe = createMatchProbeBundle("invalid-hard-blocker-probe");
  const invalidBlockerSeam = seamFor("candidate");
  invalidBlockerSeam.modules = {
    ...modelBlockerSeam.modules,
    createJobAnalysisRunner: () => async () => ({
      provider: "synthetic-provider",
      semanticStatus: "complete",
      decisionSource: "model",
      recommendation: "review",
      evidence: { jd: [], resume: [] },
      fitReasons: [],
      missingPoints: [],
      hardBlockers: ["legacy unstructured blocker"],
      errorCode: ""
    }),
    decisionBucket: () => "talk"
  };
  const invalidBlockerResult = await runner.runPrivateFullChain(liveOptions("match-live", "candidate", {
    privateRoot: invalidBlockerProbe.root,
    output: invalidBlockerProbe.output,
    profile: invalidBlockerProbe.profile,
    matchingCard: invalidBlockerProbe.card,
    jobs: invalidBlockerProbe.jobs,
    labels: invalidBlockerProbe.labels
  }), authorizedEnv(), invalidBlockerSeam);
  assert(invalidBlockerResult.rows.every((row) => row.hardBlocked === false),
    "legacy or malformed model blockers must not be reported as hard boundaries");

  const lifecycleProbe = createMatchProbeBundle("throwing-runner-constructor-probe");
  let closeCount = 0;
  const lifecycleSeam = seamFor("candidate");
  lifecycleSeam.modules = {
    ...lifecycleSeam.modules,
    openDb: () => ({ close: () => { closeCount += 1; } }),
    createJobAnalysisRunner: () => {
      throw Object.assign(new Error("synthetic constructor failure"), { code: "SYNTHETIC_CONSTRUCTOR_FAILURE" });
    }
  };
  await assert.rejects(
    () => runner.runPrivateFullChain(liveOptions("match-live", "candidate", {
      privateRoot: lifecycleProbe.root,
      output: lifecycleProbe.output,
      profile: lifecycleProbe.profile,
      matchingCard: lifecycleProbe.card,
      jobs: lifecycleProbe.jobs,
      labels: lifecycleProbe.labels
    }), authorizedEnv(), lifecycleSeam),
    /synthetic constructor failure/
  );
  assert.strictEqual(closeCount, 1, "opened SQLite handle must close when runner construction throws");
  assert(!fs.existsSync(path.join(lifecycleProbe.output, "match-result.json")), "constructor failure must not write a match result");

  const enteredLocalBoundaryIds = baseline.rows.filter((row) => !row.hardBlocked).map((row) => row.id).sort();
  const exitedLocalBoundaryIds = candidate.rows.filter((row) => !row.hardBlocked).map((row) => row.id).sort();
  const enteredLocalBoundary = structuredClone(candidate);
  enteredLocalBoundary.rows = enteredLocalBoundary.rows.map((row) => ({ ...row, hardBlocked: true, decisionState: "blocked" }));
  assert.deepStrictEqual(
    runner.comparePrivateFullChainResults(baseline, enteredLocalBoundary).report.hardBlockerChanges,
    enteredLocalBoundaryIds,
    "hardBlockerChanges must report local false-to-true hard-boundary transitions"
  );
  const exitedLocalBoundary = structuredClone(baseline);
  exitedLocalBoundary.rows = exitedLocalBoundary.rows.map((row) => ({ ...row, hardBlocked: true, decisionState: "blocked" }));
  assert.deepStrictEqual(
    runner.comparePrivateFullChainResults(exitedLocalBoundary, candidate).report.hardBlockerChanges,
    exitedLocalBoundaryIds,
    "hardBlockerChanges must report local true-to-false hard-boundary transitions"
  );

  const compared = runner.comparePrivateFullChainResults(baseline, candidate);
  assert.strictEqual(compared.ok, true, JSON.stringify(compared));
  assert.strictEqual(compared.report.accepted, true);
  assert.deepStrictEqual(compared.report.profile, {
    baselineSha256: baseline.fixtureProfileSha256,
    candidateSha256: candidate.fixtureProfileSha256,
    baselineReviewStatus: "confirmed",
    candidateReviewStatus: "confirmed"
  });
  assert.strictEqual(compared.report.card.baselineConsumed, false);
  assert.strictEqual(compared.report.card.candidateConsumed, true);
  assert.deepStrictEqual(compared.report.commits, {
    baselineProductCommit: "3".repeat(40),
    baselineEvaluatedCommit: "1".repeat(40),
    candidateProductCommit: "2".repeat(40),
    candidateEvaluatedCommit: "2".repeat(40)
  }, "compare must audit product attribution separately from evaluated runner commits");
  for (const field of ["enteredNotRecommended", "exitedNotRecommended", "enteredPrimary", "hardBlockerChanges"]) {
    assert(Array.isArray(compared.report[field]), `${field} must be reported`);
  }
  const privateStructuralForgeries = [
    { ...baseline, runMode: "offline" },
    { ...baseline, authorizationGatePassed: "true" },
    { ...baseline, worktreeClean: 1 },
    { ...baseline, matchingCardProvided: "true" },
    { ...baseline, matchingCardConsumed: "false" },
    { ...candidate, matchingCardConsumed: undefined },
    { ...candidate, fixtureProfileResultSha256: "not-a-sha" }
  ];
  for (const forged of privateStructuralForgeries) {
    const result = forged.side === "candidate"
      ? runner.comparePrivateFullChainResults(baseline, forged)
      : runner.comparePrivateFullChainResults(forged, candidate);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, "PRIVATE_FULL_CHAIN_COMPARE_IDENTITY");
  }
  const forgedModelFingerprint = structuredClone(candidate);
  forgedModelFingerprint.modelIdentity.requestSettingsSha256 = "f".repeat(64);
  assert.strictEqual(
    runner.comparePrivateFullChainResults(baseline, forgedModelFingerprint).code,
    "PRIVATE_FULL_CHAIN_COMPARE_IDENTITY",
    "modelIdentitySha256 must bind the complete sanitized model identity"
  );
  assert.strictEqual(
    runner.comparePrivateFullChainResults(baseline, { ...candidate, fixtureProfileResultSha256: "f".repeat(64) }).code,
    "PRIVATE_FULL_CHAIN_COMPARE_IDENTITY",
    "private compare must reject a mismatched canonical profile result hash"
  );
  assert.strictEqual(
    runner.comparePrivateFullChainResults(baseline, { ...candidate, productCommit: baseline.productCommit }).code,
    "PRIVATE_FULL_CHAIN_COMPARE_IDENTITY",
    "private compare must reject identical product attribution under different evaluated commits"
  );

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
  assert(!fs.existsSync(invalidReport.replace(/\.json$/i, ".md")), "identity mismatch must not generate Markdown");
  const structuralBundle = privatePath("cli-invalid-private-structure");
  const structuralBaseline = path.join(structuralBundle, "runs", "baseline", "match-result.json");
  const structuralCandidate = path.join(structuralBundle, "runs", "candidate", "match-result.json");
  const structuralReport = path.join(structuralBundle, "reports", "full-chain-compare.json");
  fs.mkdirSync(path.dirname(structuralBaseline), { recursive: true });
  fs.mkdirSync(path.dirname(structuralCandidate), { recursive: true });
  fs.writeFileSync(structuralBaseline, JSON.stringify(baseline), "utf8");
  fs.writeFileSync(structuralCandidate, JSON.stringify({ ...candidate, matchingCardConsumed: "true" }), "utf8");
  const structuralCli = spawnSync(process.execPath, [
    path.resolve(__dirname, "..", "scripts", "private-full-chain-runner.js"),
    "--compare", "--baseline", structuralBaseline, "--candidate", structuralCandidate, "--report", structuralReport
  ], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
  assert.notStrictEqual(structuralCli.status, 0);
  assert(!fs.existsSync(structuralReport), "private structural forgery must not generate JSON");
  assert(!fs.existsSync(structuralReport.replace(/\.json$/i, ".md")), "private structural forgery must not generate Markdown");

  const existingMarkdownBundle = privatePath("cli-existing-markdown-target");
  const existingMarkdownBaseline = path.join(existingMarkdownBundle, "runs", "baseline", "match-result.json");
  const existingMarkdownCandidate = path.join(existingMarkdownBundle, "runs", "candidate", "match-result.json");
  const existingMarkdownReport = path.join(existingMarkdownBundle, "reports", "full-chain-compare.json");
  const existingMarkdownTarget = path.join(existingMarkdownBundle, "reports", "full-chain-compare.md");
  fs.mkdirSync(path.dirname(existingMarkdownBaseline), { recursive: true });
  fs.mkdirSync(path.dirname(existingMarkdownCandidate), { recursive: true });
  fs.mkdirSync(path.dirname(existingMarkdownReport), { recursive: true });
  fs.writeFileSync(existingMarkdownBaseline, "not-json", "utf8");
  fs.writeFileSync(existingMarkdownCandidate, "not-json", "utf8");
  fs.writeFileSync(existingMarkdownTarget, "ordinary markdown sentinel", "utf8");
  const existingMarkdownCli = spawnSync(process.execPath, [
    path.resolve(__dirname, "..", "scripts", "private-full-chain-runner.js"),
    "--compare", "--baseline", existingMarkdownBaseline, "--candidate", existingMarkdownCandidate, "--report", existingMarkdownReport
  ], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
  assert.notStrictEqual(existingMarkdownCli.status, 0);
  assert.match(`${existingMarkdownCli.stdout}\n${existingMarkdownCli.stderr}`, /PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED/,
    "an existing Markdown target must fail at the path gate before compare inputs are read");
  assert(!fs.existsSync(existingMarkdownReport), "an existing Markdown target must not create JSON");
  assert.strictEqual(fs.readFileSync(existingMarkdownTarget, "utf8"), "ordinary markdown sentinel");

  const escapingMarkdownBundle = privatePath("cli-escaping-markdown-target");
  const escapingMarkdownBaseline = path.join(escapingMarkdownBundle, "runs", "baseline", "match-result.json");
  const escapingMarkdownCandidate = path.join(escapingMarkdownBundle, "runs", "candidate", "match-result.json");
  const escapingMarkdownReport = path.join(escapingMarkdownBundle, "reports", "full-chain-compare.json");
  const escapingMarkdownTarget = path.join(escapingMarkdownBundle, "reports", "full-chain-compare.md");
  const externalMarkdownTarget = path.join(externalRoot, "escaping-compare-target.md");
  fs.mkdirSync(path.dirname(escapingMarkdownBaseline), { recursive: true });
  fs.mkdirSync(path.dirname(escapingMarkdownCandidate), { recursive: true });
  fs.mkdirSync(path.dirname(escapingMarkdownReport), { recursive: true });
  fs.mkdirSync(path.dirname(externalMarkdownTarget), { recursive: true });
  fs.writeFileSync(escapingMarkdownBaseline, "not-json", "utf8");
  fs.writeFileSync(escapingMarkdownCandidate, "not-json", "utf8");
  fs.writeFileSync(externalMarkdownTarget, "escaping markdown sentinel", "utf8");
  let externalMarkdownSentinel = externalMarkdownTarget;
  try {
    fs.symlinkSync(externalMarkdownTarget, escapingMarkdownTarget, "file");
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
    fs.rmSync(externalMarkdownTarget);
    fs.mkdirSync(externalMarkdownTarget);
    externalMarkdownSentinel = path.join(externalMarkdownTarget, "sentinel.txt");
    fs.writeFileSync(externalMarkdownSentinel, "escaping markdown sentinel", "utf8");
    fs.symlinkSync(externalMarkdownTarget, escapingMarkdownTarget, "junction");
  }
  const escapingMarkdownCli = spawnSync(process.execPath, [
    path.resolve(__dirname, "..", "scripts", "private-full-chain-runner.js"),
    "--compare", "--baseline", escapingMarkdownBaseline, "--candidate", escapingMarkdownCandidate, "--report", escapingMarkdownReport
  ], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
  assert.notStrictEqual(escapingMarkdownCli.status, 0);
  assert.match(`${escapingMarkdownCli.stdout}\n${escapingMarkdownCli.stderr}`, /PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN/,
    "an escaping Markdown alias must fail at the path gate before compare inputs are read");
  assert(!fs.existsSync(escapingMarkdownReport), "an escaping Markdown alias must not create JSON");
  assert.strictEqual(fs.readFileSync(externalMarkdownSentinel, "utf8"), "escaping markdown sentinel");

  const opaqueFailureBundle = privatePath("cli-opaque-failure");
  const opaqueBaseline = path.join(opaqueFailureBundle, "runs", "baseline", "match-result.json");
  const opaqueCandidate = path.join(opaqueFailureBundle, "runs", "candidate", "match-result.json");
  const opaqueReport = path.join(opaqueFailureBundle, "reports", "full-chain-compare.json");
  fs.mkdirSync(path.dirname(opaqueBaseline), { recursive: true });
  fs.mkdirSync(path.dirname(opaqueCandidate), { recursive: true });
  fs.writeFileSync(opaqueBaseline, "upstream private body: do-not-disclose", "utf8");
  fs.writeFileSync(opaqueCandidate, "upstream private body: do-not-disclose", "utf8");
  const opaqueCli = spawnSync(process.execPath, [
    path.resolve(__dirname, "..", "scripts", "private-full-chain-runner.js"),
    "--compare", "--baseline", opaqueBaseline, "--candidate", opaqueCandidate, "--report", opaqueReport
  ], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" });
  const opaqueOutput = `${opaqueCli.stdout}\n${opaqueCli.stderr}`;
  assert.notStrictEqual(opaqueCli.status, 0);
  assert.match(opaqueOutput, /\[PRIVATE_FULL_CHAIN_FAILURE\] The private full-chain runner failed safely\./);
  assert(!opaqueOutput.includes("upstream private body"), "CLI must not disclose unknown upstream errors");

  const rejectedCandidate = structuredClone(candidate);
  Object.assign(rejectedCandidate.rows[0], {
    actualRecommendation: rejectedCandidate.rows[0].expectedRecommendation === "skip" ? "apply" : "skip",
    actualBucket: rejectedCandidate.rows[0].expectedBucket === "not_recommended" ? "primary" : "not_recommended",
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
  const cliGate = expectGateOk({
    mode: "compare",
    baseline: cliBaseline,
    candidate: cliCandidate,
    report: cliReport
  });
  assert.strictEqual(cliGate.request.markdownReport, path.join(cliBundle, "reports", "full-chain-compare.md"));
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
  fs.rmSync(downloadsRoot, { recursive: true, force: true });
  try {
    fs.mkdirSync(externalRoot, { recursive: true });
    fs.writeFileSync(externalPdf, makeSyntheticPdf());
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
    expectGate("PRIVATE_FULL_CHAIN_MODEL_SETTINGS_ROOT_FORBIDDEN", { ...live, modelSettingsRoot: os.homedir() });
    expectGate("PRIVATE_FULL_CHAIN_MODEL_SETTINGS_ROOT_FORBIDDEN", { ...live, modelSettingsRoot: os.tmpdir() });
    assert.throws(
      () => runner.assertDistinctManifestProducts("1".repeat(40), "1".repeat(40)),
      (error) => error.code === "PRIVATE_FULL_CHAIN_WORKTREE_DIRTY",
      "manifest product identities must be distinct even when evaluated tooling commits differ"
    );
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
      mode: "init-manifest", privateRoot: testRoot, baselineWorktree: privatePath("baseline"), candidateWorktree: "D:\\Guo\\ZhiPing", baselineProductCommit: "1".repeat(40), output: privatePath("run-manifest.json")
    }, {});
    expectGateOk({
      mode: "init-manifest", privateRoot: testRoot, baselineWorktree: siblingBaselineRoot,
      candidateWorktree: "D:\\DevData\\RoleFlow-worktrees\\claude-generic-evidence-matching-live-fix", baselineProductCommit: "1".repeat(40), output: privatePath("run-manifest.json")
    }, {});
    expectGate("PRIVATE_FULL_CHAIN_PRIVATE_ROOT_FORBIDDEN", {
      mode: "init-manifest", privateRoot: testRoot, baselineWorktree: testRoot,
      candidateWorktree: "D:\\DevData\\RoleFlow-worktrees\\claude-generic-evidence-matching-live-fix", baselineProductCommit: "1".repeat(40), output: privatePath("run-manifest.json")
    }, {});

    fs.mkdirSync(testRoot, { recursive: true });
    fs.mkdirSync(downloadsRoot, { recursive: true });
    const downloadsPdf = path.join(downloadsRoot, "explicit-source.pdf");
    const homePdf = path.join(os.homedir(), `roleflow-private-runner-home-${process.pid}.pdf`);
    fs.writeFileSync(downloadsPdf, makeSyntheticPdf());
    fs.writeFileSync(homePdf, makeSyntheticPdf());
    expectGateOk(gateOptions({ pdf: downloadsPdf }));
    expectGateOk(gateOptions({ pdf: homePdf }));
    expectGate("PRIVATE_FULL_CHAIN_RESUME_REQUIRED", gateOptions({ pdf: "relative-source.pdf" }));
    expectGate("PRIVATE_FULL_CHAIN_RESUME_REQUIRED", gateOptions({ pdf: "https://example.invalid/source.pdf" }));
    const repositoryPdf = path.join(path.resolve(__dirname, ".."), "private-source.pdf");
    const projectDataPdf = path.join(path.resolve(__dirname, ".."), "data", "private-source.pdf");
    const tempPdf = path.join(os.tmpdir(), `roleflow-private-source-${process.pid}.pdf`);
    fs.mkdirSync(path.dirname(projectDataPdf), { recursive: true });
    for (const unsafePdf of [repositoryPdf, projectDataPdf, privatePath("input", "private-source.pdf"), tempPdf]) {
      fs.mkdirSync(path.dirname(unsafePdf), { recursive: true });
      fs.writeFileSync(unsafePdf, makeSyntheticPdf());
      expectGate("PRIVATE_FULL_CHAIN_RESUME_REQUIRED", gateOptions({ pdf: unsafePdf }));
    }
    fs.rmSync(repositoryPdf, { force: true });
    fs.rmSync(projectDataPdf, { force: true });
    fs.rmSync(tempPdf, { force: true });
    fs.rmSync(homePdf, { force: true });
    const exclusiveTarget = privatePath("exclusive", "artifact.json");
    runner.exclusivePrivateWrite(testRoot, exclusiveTarget, "first");
    assert.throws(
      () => runner.exclusivePrivateWrite(testRoot, exclusiveTarget, "second"),
      (error) => error.code === "PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED"
    );
    assert.strictEqual(fs.readFileSync(exclusiveTarget, "utf8"), "first", "existing output sentinel must remain unchanged");
    const outputEscape = privatePath("output-escape");
    fs.symlinkSync(externalRoot, outputEscape, "junction");
    const escapedTarget = path.join(outputEscape, "artifact.json");
    assert.throws(
      () => runner.exclusivePrivateWrite(testRoot, escapedTarget, "escape"),
      (error) => error.code === "PRIVATE_FULL_CHAIN_OUTPUT_REQUIRED"
    );
    assert(!fs.existsSync(path.join(externalRoot, "artifact.json")), "junction escape must not create an external artifact");
    const linkedSource = privatePath("linked-source");
    fs.symlinkSync(downloadsRoot, linkedSource, "junction");
    expectGate("PRIVATE_FULL_CHAIN_RESUME_REQUIRED", gateOptions({ pdf: path.join(linkedSource, "explicit-source.pdf") }));
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
      candidateWorktree: "D:\\DevData\\RoleFlow-worktrees\\claude-generic-evidence-matching-live-fix", baselineProductCommit: "1".repeat(40), output: privatePath("run-manifest.json")
    }, {}, null);
    assert.strictEqual(copiedManifestGate.ok, true, "the same runner blob must recognize the literal candidate path outside its own checkout");
    fs.writeFileSync(pdfPath, makeSyntheticPdf());
    fs.writeFileSync(identityPath, JSON.stringify({
      names: ["Synthetic Candidate"],
      phones: ["13800138000"],
      emails: ["candidate@example.com"]
    }, null, 2));

    await withoutRepositoryModelSettings(() => injectedLiveFlowSmoke(identityPath));

    if (!candidateWorktreeIsClean()) {
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

    const baselineProductCommit = createSyntheticBaselineCheckout(siblingBaselineRoot);
    const manifestPath = privatePath("run-manifest.json");
    fs.rmSync(manifestPath);
    assert.throws(
      () => runner.initializePrivateManifest({
        privateRoot: testRoot, baselineWorktree: siblingBaselineRoot,
        candidateWorktree: "D:\\DevData\\RoleFlow-worktrees\\claude-generic-evidence-matching-live-fix",
        baselineProductCommit: "f".repeat(40), output: manifestPath
      }),
      (error) => error.code === "PRIVATE_FULL_CHAIN_WORKTREE_DIRTY",
      "an arbitrary CLI baseline hash must not be trusted"
    );
    const manifest = runner.initializePrivateManifest({
      privateRoot: testRoot, baselineWorktree: siblingBaselineRoot,
      candidateWorktree: "D:\\DevData\\RoleFlow-worktrees\\claude-generic-evidence-matching-live-fix",
      baselineProductCommit, output: manifestPath
    });
    const { execFileSync } = require("node:child_process");
    const head = (cwd) => execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", windowsHide: true }).trim();
    assert.strictEqual(manifest.harnessVersion, "private-full-chain-harness.v1");
    assert.strictEqual(manifest.baselineProductCommit, baselineProductCommit);
    assert.strictEqual(manifest.baselineEvaluatedCommit, head(siblingBaselineRoot));
    assert.strictEqual(manifest.candidateProductCommit, head("D:\\DevData\\RoleFlow-worktrees\\claude-generic-evidence-matching-live-fix"));
    assert.strictEqual(manifest.candidateEvaluatedCommit, head("D:\\DevData\\RoleFlow-worktrees\\claude-generic-evidence-matching-live-fix"));
    assert.notStrictEqual(manifest.baselineProductCommit, manifest.candidateProductCommit);
    assert.notStrictEqual(manifest.baselineProductCommit, manifest.baselineEvaluatedCommit);
    for (const file of ["scripts/private-full-chain-runner.js", "scripts/lib/benchmark_metrics.js"]) {
      assert.strictEqual(manifest.sharedFileBlobs[file], execFileSync("git", ["rev-parse", `HEAD:${file}`], { cwd: siblingBaselineRoot, encoding: "utf8", windowsHide: true }).trim());
    }
    assert(fs.existsSync(manifestPath));
    const candidateHead = head("D:\\DevData\\RoleFlow-worktrees\\claude-generic-evidence-matching-live-fix");
    execFileSync("git", ["fetch", "D:\\DevData\\RoleFlow-worktrees\\claude-generic-evidence-matching-live-fix", candidateHead], {
      cwd: siblingBaselineRoot, encoding: "utf8", windowsHide: true
    });
    execFileSync("git", ["merge", "--allow-unrelated-histories", "-s", "ours", "--no-edit", candidateHead], {
      cwd: siblingBaselineRoot, encoding: "utf8", windowsHide: true
    });
    assert.throws(
      () => runner.initializePrivateManifest({
        privateRoot: testRoot, baselineWorktree: siblingBaselineRoot,
        candidateWorktree: "D:\\DevData\\RoleFlow-worktrees\\claude-generic-evidence-matching-live-fix",
        baselineProductCommit: candidateHead, output: privatePath("same-product-run-manifest.json")
      }),
      (error) => error.code === "PRIVATE_FULL_CHAIN_WORKTREE_DIRTY",
      "baseline and candidate must not claim the same product commit under different tooling commits"
    );
    console.log("private_full_chain_runner_smoke offline gates ok");
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.rmSync(siblingBaselineRoot, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
    fs.rmSync(downloadsRoot, { recursive: true, force: true });
    fs.rmSync(path.join(path.resolve(__dirname, ".."), "private-source.pdf"), { force: true });
    fs.rmSync(path.join(path.resolve(__dirname, ".."), "data", "private-source.pdf"), { force: true });
    fs.rmSync(path.join(os.tmpdir(), `roleflow-private-source-${process.pid}.pdf`), { force: true });
    fs.rmSync(path.join(os.homedir(), `roleflow-private-runner-home-${process.pid}.pdf`), { force: true });
  }
}

function createSyntheticBaselineCheckout(root) {
  const { execFileSync } = require("node:child_process");
  const candidateRoot = "D:\\DevData\\RoleFlow-worktrees\\claude-generic-evidence-matching-live-fix";
  fs.mkdirSync(root, { recursive: true });
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  git(["init", "-q"]);
  git(["config", "user.email", "synthetic@example.invalid"]);
  git(["config", "user.name", "Synthetic Baseline"]);
  fs.writeFileSync(path.join(root, "product-baseline.txt"), "synthetic product baseline\n", "utf8");
  git(["add", "."]);
  git(["commit", "-qm", "synthetic product baseline"]);
  const productCommit = git(["rev-parse", "HEAD"]).trim();
  for (const file of ["scripts/private-full-chain-runner.js", "scripts/lib/benchmark_metrics.js"]) {
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(candidateRoot, file), destination);
  }
  git(["add", "."]);
  git(["commit", "-qm", "synthetic tooling"]);
  return productCommit;
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

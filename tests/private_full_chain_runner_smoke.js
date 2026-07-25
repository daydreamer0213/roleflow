const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const runner = require("../scripts/private-full-chain-runner");

const PRIVATE_PARENT = "D:\\DevData\\RoleFlow-private-benchmark";
const testRoot = path.join(PRIVATE_PARENT, `synthetic-private-full-chain-runner-${process.pid}`);
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

async function main() {
  fs.rmSync(testRoot, { recursive: true, force: true });
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
    console.log("private_full_chain_runner_smoke offline gates ok");
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
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

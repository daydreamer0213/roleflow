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
    evaluatedCommit: "39557f2",
    worktreeClean: true,
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

function textAt(text, x, y) {
  return `BT /F1 12 Tf 1 0 0 1 ${x} ${y} Tm (${text}) Tj ET`;
}

function streamObject(content) {
  return `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`;
}

function makeSyntheticPdf() {
  const content = [
    textAt("Name: Synthetic Candidate", 72, 720),
    textAt("Phone: 13800138000", 72, 690),
    textAt("Email: candidate@example.com", 72, 660),
    textAt("Summary: product-minded engineer", 72, 630),
    textAt("Experience: Example Company platform work", 72, 600),
    textAt("Project: Project Alpha migration", 72, 570),
    textAt("Project: Project Beta observability", 72, 540),
    textAt("Skills: Node.js testing automation", 72, 510),
    textAt("Education: Example University computer science", 72, 480)
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
    expectGate("PRIVATE_FULL_CHAIN_WORKTREE_DIRTY", gateOptions({ worktreeClean: false }));
    expectGate("PRIVATE_FULL_CHAIN_REAL_MODEL_REQUIRED", { ...live, modelDescriptor: { provider: "mock" } });

    fs.mkdirSync(testRoot, { recursive: true });
    const pdfPath = externalPdf;
    const identityPath = privatePath("identity.private.json");
    fs.mkdirSync(externalRoot, { recursive: true });
    fs.writeFileSync(pdfPath, makeSyntheticPdf());
    fs.writeFileSync(identityPath, JSON.stringify({
      names: ["Synthetic Candidate"],
      phones: ["13800138000"],
      emails: ["candidate@example.com"]
    }, null, 2));

    await assert.rejects(
      () => runner.preparePrivateResume(gateOptions({
        pdf: pdfPath,
        identity: identityPath,
        output: privatePath("invalid-identity"),
        identityValue: { names: [], phones: [], emails: [] }
      }), authorizedEnv()),
      (error) => error.code === "PRIVATE_FULL_CHAIN_INPUT_IDENTITY"
    );
    assert(!fs.existsSync(privatePath("invalid-identity")), "identity failure must not create output directories");

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
    console.log("private_full_chain_runner_smoke offline gates ok");
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

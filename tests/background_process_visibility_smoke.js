const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const selfCheck = read("tests/self_check.js");
const onboarding = read("tests/onboarding_smoke.js");
const startupScripts = read("tests/startup_scripts_smoke.js");

assertHiddenPowerShell(selfCheck, "const invalid = spawnSync(powershell,", "self-check invalid parameter probe");
assertHiddenPowerShell(selfCheck, "const dailyOverride = spawnSync(powershell,", "self-check daily override probe");
assertHiddenPowerShell(selfCheck, 'const docxFixture = spawnSync("powershell.exe",', "self-check DOCX fixture");
assertHiddenPowerShell(onboarding, 'const docxFixture = spawnSync("powershell.exe",', "onboarding DOCX fixture");

assert.throws(
  () => assertFakeEdgeBuildIsWindowed(`
function edgeCompileSource() {
  return String.raw\`
Add-Type -TypeDefinition $source -OutputAssembly $OutputPath
\`;
}
const unrelatedFixture = "-OutputType WindowsApplication";
`),
  /fake Edge build/,
  "an unrelated WindowsApplication token must not satisfy the fake Edge build contract"
);
assertFakeEdgeBuildIsWindowed(startupScripts);

console.log("background_process_visibility_smoke ok");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function assertHiddenPowerShell(source, marker, label) {
  const start = source.indexOf(marker);
  assert.notStrictEqual(start, -1, `missing ${label}`);
  const end = source.indexOf(");", start);
  assert.notStrictEqual(end, -1, `could not inspect ${label}`);
  assert.match(
    source.slice(start, end + 2),
    /windowsHide:\s*true/,
    `${label} must not show a command window`
  );
}

function assertFakeEdgeBuildIsWindowed(source) {
  const functionMarker = "function edgeCompileSource() {";
  const functionStart = source.indexOf(functionMarker);
  assert.notStrictEqual(functionStart, -1, "missing fake Edge build function");
  const templateMarker = "return String.raw`";
  const templateStart = source.indexOf(templateMarker, functionStart);
  assert.notStrictEqual(templateStart, -1, "missing fake Edge build template");
  const templateEnd = source.indexOf("`;", templateStart + templateMarker.length);
  assert.notStrictEqual(templateEnd, -1, "missing fake Edge build template end");
  const buildTemplate = source.slice(templateStart, templateEnd + 2);
  assert.match(
    buildTemplate,
    /Add-Type[^\r\n]*-OutputType WindowsApplication/,
    "fake Edge build must use WindowsApplication in its Add-Type command"
  );
  assert.doesNotMatch(
    buildTemplate,
    /-OutputType ConsoleApplication/,
    "fake Edge build must not use ConsoleApplication"
  );
}

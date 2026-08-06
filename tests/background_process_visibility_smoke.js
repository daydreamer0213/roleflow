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

assert.match(
  startupScripts,
  /-OutputType WindowsApplication/,
  "the fake Edge used by startup tests must not create a console window"
);
assert.doesNotMatch(
  startupScripts,
  /-OutputType ConsoleApplication/,
  "the fake Edge used by startup tests must not be a console application"
);

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

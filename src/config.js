const fs = require("fs");
const path = require("path");

function readConfig(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

function readOptionalConfig(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return readConfig(file);
}

function loadConfigs(root = process.cwd(), options = {}) {
  const exampleProfile = readConfig(path.join(root, "configs", "profile.example.json"));
  const exampleCandidateProfile = readOptionalConfig(path.join(root, "profiles", "example_profile.json"), null);
  const exampleResumeVersions = readOptionalConfig(path.join(root, "profiles", "example_resume_versions.json"), { versions: [] });
  return {
    profile: readOptionalConfig(path.join(root, "configs", "profile.yaml"), exampleProfile),
    keywords: readConfig(path.join(root, "configs", "keywords.yaml")),
    scoring: readConfig(path.join(root, "configs", "scoring.yaml")),
    model: readOptionalConfig(path.join(root, "configs", "model.json"), { provider: "mock", providers: { mock: {} } }),
    candidateProfile: readOptionalConfig(resolvePath(root, options.candidateProfile || options.profile || path.join("profiles", "guo_mingfu.json")), exampleCandidateProfile),
    resumeVersions: readOptionalConfig(resolvePath(root, options.resumeVersions || path.join("profiles", "resume_versions.json")), exampleResumeVersions)
  };
}

function resolvePath(root, file) {
  return path.isAbsolute(file) ? file : path.join(root, file);
}

module.exports = { readConfig, readOptionalConfig, loadConfigs };

const fs = require("fs");
const path = require("path");

const DEFAULT_PROFILE = Object.freeze({
  candidate: { name: "候选人", city: "", target_roles: [], strengths: [] },
  location: { target_cities: [], default_city: "", boss_city_code: "" },
  safety: { read_only: true, manual_confirmation_required: true }
});

function readConfig(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(text);
}

function readOptionalConfig(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return readConfig(file);
}

function loadConfigs(root = process.cwd(), options = {}) {
  const candidateProfilePath = options.candidateProfile || options.profile;
  const resumeVersionsPath = options.resumeVersions;
  return {
    profile: readOptionalConfig(path.join(root, "configs", "profile.yaml"), DEFAULT_PROFILE),
    keywords: readConfig(path.join(root, "configs", "keywords.yaml")),
    scoring: readConfig(path.join(root, "configs", "scoring.yaml")),
    model: readOptionalConfig(path.join(root, "configs", "model.json"), { provider: "mock", providers: { mock: {} } }),
    candidateProfile: candidateProfilePath ? readOptionalConfig(resolvePath(root, candidateProfilePath), null) : null,
    resumeVersions: resumeVersionsPath ? readOptionalConfig(resolvePath(root, resumeVersionsPath), { versions: [] }) : { versions: [] }
  };
}

function resolvePath(root, file) {
  return path.isAbsolute(file) ? file : path.join(root, file);
}

module.exports = { readConfig, readOptionalConfig, loadConfigs };

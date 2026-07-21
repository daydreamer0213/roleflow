const { stableHash } = require("./analysis_revision");
const { buildBossScanTargets } = require("../adapters/sites/boss");

const SCHEMA_VERSION = 2;
const PAYLOAD_FIELDS = [
  "site",
  "scanKind",
  "runtimePolicyHash",
  "searchTemplate",
  "cityScopes",
  "keywordPlan",
  "nativeFilters",
  "limits",
  "targets"
];
const TARGET_FIELDS = ["targetKey", "cityCode", "keyword", "priority", "laneId", "cardLimit"];

function buildScanExecutionSnapshot(input = {}) {
  const cityScopes = (Array.isArray(input.cityScopes) ? input.cityScopes : []).map((item) => ({
    city: String(item?.city || ""),
    cityCode: String(item?.cityCode || "")
  }));
  const keywordPlan = (Array.isArray(input.keywordPlan) ? input.keywordPlan : []).map((item) => ({
    word: String(typeof item === "string" ? item : item?.word || ""),
    priority: String(typeof item === "string" ? "B" : item?.priority || "B")
  })).filter((item) => item.word);
  const nativeFilters = normalizeExecutionFilters(input.nativeFilters);
  const searchTemplate = normalizeSearchTemplate(input.searchTemplate);
  const limits = normalizeExecutionLimits(input.limits);
  const targets = buildBossScanTargets({
    keywords: keywordPlan.map((item) => typeof item === "string" ? item : item?.word).filter(Boolean),
    keywordPlan,
    cityScopes,
    nativeFilters,
    maxCards: limits.maxCards,
    supplementalSalaryLaneKeywordLimit: limits.supplementalSalaryLaneKeywordLimit,
    supplementalSalaryLaneCardLimit: limits.supplementalSalaryLaneCardLimit,
    supplementalSalaryLaneDetailLimit: limits.supplementalSalaryLaneDetailLimit
  }).map((target) => ({
    targetKey: target.targetKey,
    cityCode: target.city.cityCode,
    keyword: target.keyword,
    priority: target.item.priority,
    laneId: target.laneId,
    cardLimit: target.cardLimit
  }));
  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    site: String(input.site || "boss").trim().toLowerCase(),
    scanKind: String(input.scanKind || "").trim().toLowerCase(),
    runtimePolicyHash: String(input.runtimePolicyHash || "").trim(),
    searchTemplate,
    cityScopes,
    keywordPlan,
    nativeFilters,
    limits,
    targets
  };
  return { ...snapshot, snapshotHash: stableHash(deterministicPayload(snapshot)) };
}

function normalizeSearchTemplate(value = {}) {
  return cloneJson({
    mode: value?.mode === "inherited" ? "inherited" : "generated",
    url: String(value?.url || ""),
    cityCode: String(value?.cityCode || "")
  });
}

function assertScanSnapshotCompatible(stored, current) {
  const differences = [...schemaDifferences(stored, "stored"), ...schemaDifferences(current, "current")];
  if (stored && current && typeof stored === "object" && typeof current === "object") {
    if (stored.schemaVersion !== current.schemaVersion) {
      differences.push(`schemaVersion differs: stored=${stored.schemaVersion}, current=${current.schemaVersion}`);
    }
    for (const field of PAYLOAD_FIELDS) {
      if (comparableHash(stored[field]) !== comparableHash(current[field])) differences.push(`${field} differs`);
    }
    if (stored.snapshotHash !== current.snapshotHash) {
      differences.push(`snapshotHash differs: stored=${stored.snapshotHash || "(missing)"}, current=${current.snapshotHash || "(missing)"}`);
    }
  }
  if (differences.length) throw snapshotMismatch([...new Set(differences)]);
  return true;
}

function remainingTargetKeys(snapshot, latestResults = []) {
  const { targets, resultsByKey } = indexLatestResults(snapshot, latestResults);
  return targets
    .filter((target) => resultsByKey.get(target.targetKey)?.status !== "completed")
    .map((target) => target.targetKey);
}

function summarizeResumePlan(snapshot, latestResults = []) {
  const { targets, resultsByKey } = indexLatestResults(snapshot, latestResults);
  let completed = 0;
  let partial = 0;
  let failed = 0;
  const targetKeys = [];
  for (const target of targets) {
    const status = resultsByKey.get(target.targetKey)?.status;
    if (status === "completed") {
      completed += 1;
      continue;
    }
    if (status === "partial") partial += 1;
    if (status === "failed") failed += 1;
    targetKeys.push(target.targetKey);
  }
  return {
    total: targets.length,
    completed,
    pending: targetKeys.length,
    partial,
    failed,
    targetKeys
  };
}

function deterministicPayload(snapshot) {
  return Object.fromEntries([
    ["schemaVersion", snapshot.schemaVersion],
    ...PAYLOAD_FIELDS.map((field) => [field, snapshot[field]])
  ]);
}

function indexLatestResults(snapshot, latestResults) {
  if (!Array.isArray(snapshot?.targets)) throw snapshotMismatch(["snapshot.targets must be an array"]);
  const knownKeys = new Set(snapshot.targets.map((target) => target.targetKey));
  const resultsByKey = new Map();
  const unknownKeys = [];
  for (const result of Array.isArray(latestResults) ? latestResults : []) {
    const targetKey = String(result?.targetKey || "").trim();
    if (!knownKeys.has(targetKey)) unknownKeys.push(targetKey || "(missing)");
    else resultsByKey.set(targetKey, result);
  }
  if (unknownKeys.length) {
    throw snapshotMismatch([`latestResults contains unknown targetKey(s): ${[...new Set(unknownKeys)].join(", ")}`]);
  }
  return { targets: snapshot.targets, resultsByKey };
}

function schemaDifferences(snapshot, label) {
  if (!snapshot || typeof snapshot !== "object") return [`${label} snapshot must be an object`];
  const differences = [];
  if (snapshot.schemaVersion !== SCHEMA_VERSION) {
    differences.push(`${label}.schemaVersion is ${snapshot.schemaVersion ?? "missing"}; expected ${SCHEMA_VERSION}`);
  }
  for (const field of PAYLOAD_FIELDS) {
    if (!Object.hasOwn(snapshot, field)) differences.push(`${label}.${field} is missing`);
  }
  if (!Object.hasOwn(snapshot, "snapshotHash")) differences.push(`${label}.snapshotHash is missing`);
  if (Array.isArray(snapshot.targets)) {
    snapshot.targets.forEach((target, index) => {
      for (const field of TARGET_FIELDS) {
        if (!Object.hasOwn(target || {}, field)) differences.push(`${label}.targets[${index}].${field} is missing`);
      }
    });
  } else {
    differences.push(`${label}.targets must be an array`);
  }
  return differences;
}

function snapshotMismatch(differences) {
  const error = new Error(`Scan snapshot mismatch: ${differences.join("; ")}`);
  error.code = "SCAN_SNAPSHOT_MISMATCH";
  error.differences = differences;
  return error;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeExecutionFilters(value = {}) {
  const lanes = Array.isArray(value?.lanes) ? value.lanes : [];
  return cloneJson({
    site: String(value?.site || ""),
    params: value?.params || {},
    lanes: lanes.map((lane, index) => ({
      id: String(lane?.id || `lane-${index + 1}`),
      rank: Number.isFinite(Number(lane?.rank)) ? Number(lane.rank) : index,
      params: lane?.params || {}
    }))
  });
}

function normalizeExecutionLimits(value = {}) {
  return cloneJson({
    maxCards: Number(value?.maxCards || 0),
    maxDetailTotal: Number(value?.maxDetailTotal || 0),
    browserPageBudget: Number(value?.browserPageBudget || 0),
    detailLimits: value?.detailLimits || null,
    supplementalSalaryLaneKeywordLimit: nullableNumber(value?.supplementalSalaryLaneKeywordLimit),
    supplementalSalaryLaneCardLimit: nullableNumber(value?.supplementalSalaryLaneCardLimit),
    supplementalSalaryLaneDetailLimit: nullableNumber(value?.supplementalSalaryLaneDetailLimit)
  });
}

function nullableNumber(value) {
  const number = Number(value);
  return value === null || value === undefined || !Number.isFinite(number) ? null : number;
}

function comparableHash(value) {
  return stableHash({ value });
}

module.exports = {
  buildScanExecutionSnapshot,
  assertScanSnapshotCompatible,
  remainingTargetKeys,
  summarizeResumePlan
};

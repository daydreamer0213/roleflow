const assert = require("assert");
const {
  buildScanExecutionSnapshot,
  assertScanSnapshotCompatible,
  remainingTargetKeys,
  summarizeResumePlan
} = require("../src/core/scan_snapshot");

const input = {
  site: "boss",
  scanKind: "daily",
  runtimePolicyHash: "policy-v1",
  searchTemplate: {
    mode: "inherited",
    url: "https://www.zhipin.com/web/geek/jobs?city=101280100&district=101280105&salary=405",
    cityCode: "101280100"
  },
  cityScopes: [
    { city: "Guangzhou", cityCode: "101280100" },
    { city: "Shenzhen", cityCode: "101280600" }
  ],
  keywordPlan: [
    { word: "Agent", priority: "B" },
    { word: "RAG", priority: "A" }
  ],
  nativeFilters: {
    lanes: [
      { id: "main", rank: 0, params: { salary: ["404"], experience: ["101"] } },
      { id: "stretch", rank: 1, params: { salary: ["405"], experience: ["104"] } }
    ]
  },
  limits: {
    maxCards: 50,
    maxDetailTotal: 220,
    browserPageBudget: 90,
    detailLimits: { A: 5, B: 3 },
    supplementalSalaryLaneKeywordLimit: 1,
    supplementalSalaryLaneCardLimit: 20,
    supplementalSalaryLaneDetailLimit: 10
  }
};

const snapshot = buildScanExecutionSnapshot(input);
assert.strictEqual(snapshot.schemaVersion, 2);
assert.match(snapshot.createdAt, /^\d{4}-\d{2}-\d{2}T/);
assert.match(snapshot.snapshotHash, /^[a-f0-9]{64}$/);
assert.deepStrictEqual(snapshot.targets[0], {
  targetKey: "101280100|RAG|main",
  cityCode: "101280100",
  keyword: "RAG",
  priority: "A",
  laneId: "main",
  cardLimit: 50
});
assert.deepStrictEqual(snapshot.targets.map((target) => target.targetKey), [
  "101280100|RAG|main",
  "101280100|Agent|main",
  "101280100|RAG|stretch",
  "101280600|RAG|main",
  "101280600|Agent|main",
  "101280600|RAG|stretch"
]);

const reordered = buildScanExecutionSnapshot({
  limits: {
    detailLimits: { B: 3, A: 5 },
    browserPageBudget: 90,
    maxDetailTotal: 220,
    maxCards: 50,
    supplementalSalaryLaneKeywordLimit: 1,
    supplementalSalaryLaneCardLimit: 20,
    supplementalSalaryLaneDetailLimit: 10
  },
  nativeFilters: {
    lanes: [
      { params: { experience: ["101"], salary: ["404"] }, rank: 0, id: "main" },
      { params: { experience: ["104"], salary: ["405"] }, rank: 1, id: "stretch" }
    ]
  },
  keywordPlan: [
    { priority: "B", word: "Agent" },
    { priority: "A", word: "RAG" }
  ],
  cityScopes: [
    { cityCode: "101280100", city: "Guangzhou" },
    { cityCode: "101280600", city: "Shenzhen" }
  ],
  runtimePolicyHash: "policy-v1",
  searchTemplate: input.searchTemplate,
  scanKind: "daily",
  site: "boss"
});
assert.strictEqual(reordered.snapshotHash, snapshot.snapshotHash);
assertScanSnapshotCompatible(snapshot, { ...reordered, createdAt: "2099-01-01T00:00:00.000Z" });

const volatileMetadata = buildScanExecutionSnapshot({
  ...input,
  keywordPlan: input.keywordPlan.map((item) => ({ ...item, reason: "display-only explanation" })),
  nativeFilters: {
    ...input.nativeFilters,
    catalogVersion: "catalog-v99",
    catalogDiscoveredAt: "2099-01-01T00:00:00.000Z",
    warnings: [{ code: "display_only" }],
    labels: { salary: ["renamed"] },
    lanes: input.nativeFilters.lanes.map((lane) => ({ ...lane, labels: { salary: ["renamed"] } }))
  }
});
assert.strictEqual(volatileMetadata.snapshotHash, snapshot.snapshotHash);

for (const mutate of [
  (value) => { value.keywordPlan[0].word = "LLM"; },
  (value) => { value.cityScopes[0].cityCode = "101280700"; },
  (value) => { value.nativeFilters.lanes[0].params.salary = ["406"]; },
  (value) => { value.searchTemplate.url += "&degree=203"; },
  (value) => { value.limits.maxDetailTotal += 1; }
]) {
  const changedInput = JSON.parse(JSON.stringify(input));
  mutate(changedInput);
  assert.notStrictEqual(buildScanExecutionSnapshot(changedInput).snapshotHash, snapshot.snapshotHash);
}

const targetKeys = snapshot.targets.map((target) => target.targetKey);
const latestResults = [
  { targetKey: targetKeys[0], status: "completed" },
  { targetKey: targetKeys[1], status: "partial" },
  { targetKey: targetKeys[2], status: "failed" }
];
assert.deepStrictEqual(remainingTargetKeys(snapshot, latestResults), targetKeys.slice(1));
assert.deepStrictEqual(summarizeResumePlan(snapshot, latestResults), {
  total: targetKeys.length,
  completed: 1,
  pending: targetKeys.length - 1,
  partial: 1,
  failed: 1,
  targetKeys: targetKeys.slice(1)
});

assert.throws(
  () => remainingTargetKeys(snapshot, [{ targetKey: "unknown-target", status: "completed" }]),
  (error) => error.code === "SCAN_SNAPSHOT_MISMATCH" && /unknown-target/.test(error.message)
);

const changedBudgetSnapshot = buildScanExecutionSnapshot({
  ...input,
  limits: { ...input.limits, maxDetailTotal: input.limits.maxDetailTotal + 1 }
});
assert.throws(
  () => assertScanSnapshotCompatible(snapshot, changedBudgetSnapshot),
  (error) => error.code === "SCAN_SNAPSHOT_MISMATCH" && /limits differs/.test(error.message)
);
assert.throws(
  () => assertScanSnapshotCompatible(snapshot, { ...snapshot, schemaVersion: 1 }),
  (error) => error.code === "SCAN_SNAPSHOT_MISMATCH" && /schemaVersion/.test(error.message)
);
const missingLimits = { ...snapshot };
delete missingLimits.limits;
assert.throws(
  () => assertScanSnapshotCompatible(missingLimits, snapshot),
  (error) => error.code === "SCAN_SNAPSHOT_MISMATCH" && /stored.limits is missing/.test(error.message)
);

console.log("scan_snapshot_smoke ok");

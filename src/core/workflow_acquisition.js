const { stableHash } = require("./analysis_revision");
const { canonicalSearchPlanV2, generatedPlatformOf } = require("./search_plan_schema");
const { cityToBossCode } = require("./search_plan");
const { resolveNativeFilterSnapshot, assertGeneratedFilterSelections } = require("./platform_filters");
const { freezeKeywordSource, assertCompleteInheritedContext } = require("./inherited_search_scope");
const { compileGeneratedPlatformRuntimePolicy } = require("./platform_runtime_policy");

function freezeWorkflowPlan(plan) {
  const planSnapshot = canonicalSearchPlanV2(plan);
  return {
    planSnapshotVersion: 2,
    planSnapshot,
    planHash: stableHash(planSnapshot)
  };
}

function buildGeneratedAcquisitionContext({ planRecord, catalog, matchingCardRevision = "" } = {}) {
  const generated = generatedPlatformOf(planRecord?.plan);
  const cityScopes = generated.cities.map((city) => ({ city, cityCode: cityToBossCode(city) }));
  if (!cityScopes.length || cityScopes.some((item) => !item.cityCode)) {
    throw acquisitionError("GENERATED_CITY_UNRESOLVED", "通用模式包含无法解析的 BOSS 城市。");
  }
  const nativeFilters = assertGeneratedFilterSelections(
    planRecord.plan,
    resolveNativeFilterSnapshot({ site: "boss", catalog, plan: planRecord.plan })
  );
  const platformPolicy = compileGeneratedPlatformRuntimePolicy({ cityScopes, nativeFilters });
  return {
    acquisitionMode: "generated",
    searchTemplate: { mode: "generated", url: "", cityCode: "" },
    cityScopes,
    nativeFilters,
    nativeFilterCatalogRevision: nativeFilters.catalogVersion,
    keywordSource: freezeKeywordSource({ planRecord, matchingCardRevision }),
    platformPolicy
  };
}

function assertCompleteGeneratedContext(context = {}, {
  code = "WORKFLOW_GENERATED_SNAPSHOT_INVALID",
  message = "本轮通用模式快照不完整，不能安全恢复。",
  planId = null
} = {}) {
  const cityScopes = Array.isArray(context?.cityScopes) ? context.cityScopes : [];
  const cityCodes = cityScopes.map((item) => String(item?.cityCode || "").trim()).filter(Boolean);
  const keywordSource = context?.keywordSource;
  const nativeFilters = context?.nativeFilters;
  const platformPolicy = context?.platformPolicy;
  const expectedPlanId = planId === null || planId === undefined ? null : Number(planId);
  const keywordPlanId = Number(keywordSource?.searchPlanId || 0);
  if (
    context?.acquisitionMode !== "generated"
    || context?.searchTemplate?.mode !== "generated"
    || !cityScopes.length
    || cityCodes.length !== cityScopes.length
    || new Set(cityCodes).size !== cityCodes.length
    || cityScopes.some((item) => !String(item?.city || "").trim())
    || !Number.isInteger(keywordPlanId)
    || keywordPlanId <= 0
    || (expectedPlanId !== null && keywordPlanId !== expectedPlanId)
    || !Number.isInteger(Number(keywordSource?.profileVersionId || 0))
    || Number(keywordSource?.profileVersionId || 0) <= 0
    || !String(keywordSource?.matchingCardRevision || "").trim()
    || !String(keywordSource?.catalogHash || "").trim()
    || !Array.isArray(keywordSource?.keywords)
    || !keywordSource.keywords.length
    || !String(context?.nativeFilterCatalogRevision || "").trim()
    || context.nativeFilterCatalogRevision !== nativeFilters?.catalogVersion
    || nativeFilters?.site !== "boss"
    || !plainObject(nativeFilters?.params)
    || !plainObject(nativeFilters?.labels)
    || !Array.isArray(nativeFilters?.lanes)
    || !nativeFilters.lanes.length
    || nativeFilters.lanes.some((lane) => !plainObject(lane?.params) || !plainObject(lane?.labels))
    || platformPolicy?.site !== "boss"
    || !String(platformPolicy?.hash || "").trim()
    || !plainObject(platformPolicy?.filters)
    || !Array.isArray(platformPolicy?.unresolvedParams)
    || !Array.isArray(platformPolicy?.filterSummary)
  ) {
    throw acquisitionError(code, message);
  }
  try {
    stableHash(nativeFilters);
  } catch (cause) {
    throw acquisitionError(code, message, cause);
  }
  return context;
}

function assertFrozenWorkflowPlan(planner = {}) {
  try {
    if (
      Number(planner?.planSnapshotVersion) !== 2
      || !plainObject(planner?.planSnapshot)
      || !String(planner?.planHash || "").trim()
      || stableHash(planner.planSnapshot) !== planner.planHash
    ) {
      throw acquisitionError("WORKFLOW_PLAN_SNAPSHOT_INVALID", "本轮任务的筛选方案快照无效。");
    }
  } catch (cause) {
    if (cause?.code === "WORKFLOW_PLAN_SNAPSHOT_INVALID") throw cause;
    throw acquisitionError("WORKFLOW_PLAN_SNAPSHOT_INVALID", "本轮任务的筛选方案快照无效。", cause);
  }
  return planner;
}

function assertAcquisitionContext(context, options = {}) {
  if (context?.acquisitionMode === "inherited") return assertCompleteInheritedContext(context, options);
  if (context?.acquisitionMode === "generated") return assertCompleteGeneratedContext(context, options);
  throw acquisitionError("WORKFLOW_ACQUISITION_MODE_INVALID", "本轮任务的采集模式无效。");
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function acquisitionError(code, message, cause) {
  const error = cause ? new Error(message, { cause }) : new Error(message);
  error.code = code;
  return error;
}

module.exports = {
  freezeWorkflowPlan,
  buildGeneratedAcquisitionContext,
  assertCompleteGeneratedContext,
  assertFrozenWorkflowPlan,
  assertAcquisitionContext
};

const crypto = require("crypto");

const DEFAULT_CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function normalizePlatformFilterCatalog(input = {}) {
  const fields = {};
  for (const [key, value] of Object.entries(input.fields || {})) {
    const item = value && typeof value === "object" ? value : {};
    const options = Array.isArray(item.options) ? item.options.map((option) => ({
      code: String(option?.code || "").trim(),
      label: String(option?.label || "").trim()
    })).filter((option) => option.code && option.label) : [];
    if (!item.urlParam || !options.length) continue;
    fields[key] = {
      key,
      label: String(item.label || key).trim(),
      urlParam: String(item.urlParam).trim(),
      selection: item.selection === "multiple" ? "multiple" : "single",
      semantic: String(item.semantic || "choice").trim(),
      options
    };
  }
  const catalog = {
    site: String(input.site || "").trim(),
    source: String(input.source || "unknown").trim(),
    discoveredAt: String(input.discoveredAt || "").trim(),
    fields
  };
  return { ...catalog, version: String(input.version || catalogVersion(catalog)).trim() };
}

function catalogVersion(catalog) {
  const stable = Object.values(catalog.fields || {}).map((field) => ({
    key: field.key,
    urlParam: field.urlParam,
    selection: field.selection,
    semantic: field.semantic,
    options: field.options
  })).sort((left, right) => left.key.localeCompare(right.key));
  return crypto.createHash("sha256").update(JSON.stringify({ site: catalog.site || "", fields: stable })).digest("hex").slice(0, 16);
}

function isCatalogFresh(catalog, now = Date.now(), ttlMs = DEFAULT_CATALOG_TTL_MS) {
  const discoveredAt = Date.parse(String(catalog?.discoveredAt || ""));
  return Number.isFinite(discoveredAt) && now - discoveredAt >= 0 && now - discoveredAt < ttlMs;
}

function resolveNativeFilterSnapshot({ site, catalog, plan = {}, overrides = {} } = {}) {
  const normalized = normalizePlatformFilterCatalog(catalog);
  const sharedParams = {};
  const sharedLabels = {};
  const warnings = [];
  const salaryField = normalized.fields.salary;
  const salaryOptions = salaryField
    ? resolveFieldOptions("salary", salaryField, plan, overrides)
    : [];
  const requestedSalaryLabels = normalizeLabels(plan.platform?.salaryLanes);
  if (requestedSalaryLabels.length && salaryOptions.length
    && !salaryOptions.some((option) => requestedSalaryLabels.includes(option.label))) {
    warnings.push({
      code: "salary_labels_remapped",
      message: "已保存的薪资档位在当前 BOSS 目录中不存在，已按期望薪资范围重新映射。",
      requestedLabels: requestedSalaryLabels,
      resolvedLabels: salaryOptions.map((item) => item.label)
    });
  }
  for (const fieldName of ["experience", "jobType", "degree"]) {
    const field = normalized.fields[fieldName];
    if (!field) continue;
    const selected = resolveFieldOptions(fieldName, field, plan, overrides);
    if (!selected.length) continue;
    sharedParams[field.urlParam] = selected.map((item) => item.code);
    sharedLabels[fieldName] = selected.map((item) => item.label);
  }
  const lanes = salaryField?.selection === "single" && salaryOptions.length > 1
    ? salaryOptions.map((option, index) => ({
      id: `salary-${option.code}`,
      rank: index,
      params: { ...sharedParams, [salaryField.urlParam]: [option.code] },
      labels: { ...sharedLabels, salary: [option.label] }
    }))
    : [{
      id: "default",
      rank: 0,
      params: {
        ...sharedParams,
        ...(salaryField && salaryOptions.length ? { [salaryField.urlParam]: salaryOptions.map((item) => item.code) } : {})
      },
      labels: {
        ...sharedLabels,
        ...(salaryOptions.length ? { salary: salaryOptions.map((item) => item.label) } : {})
      }
    }];
  const primary = lanes[0];
  return {
    site: site || normalized.site || "",
    catalogVersion: normalized.version || "",
    catalogDiscoveredAt: normalized.discoveredAt || "",
    params: primary.params,
    labels: primary.labels,
    lanes,
    warnings
  };
}

function resolveFieldOptions(fieldName, field, plan, overrides) {
  const overrideCodes = normalizeCodes(overrides[fieldName]);
  if (overrideCodes.length) return optionsForCodes(field, overrideCodes);
  if (fieldName === "salary") return selectSalaryOptions(field.options, plan.salary || {}, plan.platform?.salaryLanes);
  if (fieldName === "experience") return selectExperienceOptions(field.options, plan.experience || []);
  if (fieldName === "jobType") return selectChoiceOptions(field.options, plan.jobTypes || plan.jobType || plan.employmentTypes);
  if (fieldName === "degree") return selectChoiceOptions(field.options, plan.degrees || plan.degree);
  return [];
}

function selectSalaryOptions(options, salary, requestedLabels = []) {
  const requested = new Set((Array.isArray(requestedLabels) ? requestedLabels : [requestedLabels])
    .map((item) => String(item || "").trim()).filter(Boolean));
  if (requested.size) {
    const exact = options.filter((option) => requested.has(option.label))
      .sort((left, right) => salaryOptionScore(right, salary) - salaryOptionScore(left, salary));
    if (exact.length) return exact;
  }
  const best = options.map((option) => ({ option, score: salaryOptionScore(option, salary) }))
    .filter((item) => Number.isFinite(item.score) && item.score > -Infinity)
    .sort((left, right) => right.score - left.score)[0];
  return best ? [best.option] : [];
}

function salaryOptionScore(option, salary) {
  const minK = Number(salary?.minK || 0);
  const maxK = Number(salary?.maxK || 0);
  if (!Number.isFinite(minK) || !Number.isFinite(maxK) || maxK <= 0) return -Infinity;
  const desiredMin = Math.min(minK, maxK);
  const desiredMax = Math.max(minK, maxK);
  const desiredWidth = Math.max(1, desiredMax - desiredMin);
  const range = salaryRange(option.label);
  if (!range) return -Infinity;
  const overlap = Math.max(0, Math.min(desiredMax, range.maxK) - Math.max(desiredMin, range.minK));
  if (!overlap) return -Infinity;
  const rangeWidth = Math.max(1, range.maxK - range.minK);
  const excess = Math.max(0, rangeWidth - overlap) / rangeWidth;
  const centerDistance = Math.abs(((range.minK + range.maxK) / 2) - ((desiredMin + desiredMax) / 2));
  return (overlap / desiredWidth) * 100 - excess * 4 - centerDistance * 0.1;
}

function salaryRange(label) {
  const text = String(label || "").replace(/\s+/g, "");
  const range = text.match(/^(\d+(?:\.\d+)?)(?:[Kk])?-(\d+(?:\.\d+)?)[Kk]$/);
  if (range) return { minK: Number(range[1]), maxK: Number(range[2]) };
  const below = text.match(/^(\d+(?:\.\d+)?)[Kk](?:以下|以内)$/);
  if (below) return { minK: 0, maxK: Number(below[1]) };
  const above = text.match(/^(\d+(?:\.\d+)?)[Kk](?:以上|及以上)$/);
  if (above) return { minK: Number(above[1]), maxK: Number(above[1]) + 100 };
  return null;
}

function selectExperienceOptions(options, selections) {
  const selected = new Set((Array.isArray(selections) ? selections : [selections]).map(normalizeExperience));
  const labels = new Set();
  if (selected.has("\u7ecf\u9a8c\u4e0d\u9650")) labels.add("\u7ecf\u9a8c\u4e0d\u9650");
  if (selected.has("0-1\u5e74") || selected.has("1\u5e74\u4ee5\u5185")) labels.add("1\u5e74\u4ee5\u5185");
  if (selected.has("0-3\u5e74") || selected.has("1-3\u5e74") || selected.has("2-3\u5e74")) labels.add("1-3\u5e74");
  if (selected.has("3-5\u5e74") || selected.has("3-5\u5e74\uff08\u53ef\u51b2\uff09")) labels.add("3-5\u5e74");
  return options.filter((option) => labels.has(option.label));
}

function selectChoiceOptions(options, selections) {
  const labels = normalizeLabels(selections);
  if (!labels.length) return [];
  const wanted = new Set(labels.map(normalizeChoiceLabel));
  return options.filter((option) => wanted.has(normalizeChoiceLabel(option.label)));
}

function normalizeLabels(value) {
  return (Array.isArray(value) ? value : [value])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function normalizeChoiceLabel(value) {
  return String(value || "").replace(/\s+/g, "").replace(/（.*?）|\(.*?\)/g, "").toLowerCase();
}

function normalizeExperience(value) {
  return String(value || "").trim()
    .replace(/^([0-9]+)-([0-9]+)$/, "$1-$2\u5e74");
}

function normalizeCodes(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(values.map((item) => String(item || "").trim()).filter((item) => /^\d+$/.test(item)))];
}

function optionsForCodes(field, codes) {
  const wanted = new Set(codes);
  return field.options.filter((option) => wanted.has(option.code));
}

function formatNativeFilterSummary(snapshot) {
  if ((snapshot?.lanes || []).length > 1) {
    return snapshot.lanes.map((lane) => formatNativeFilterSummary({ labels: lane.labels })).join(" | ");
  }
  const items = Object.entries(snapshot?.labels || []).flatMap(([key, labels]) => {
    if (!labels?.length) return [];
    const name = key === "salary" ? "\u85aa\u8d44"
      : key === "experience" ? "\u7ecf\u9a8c"
        : key === "jobType" ? "\u6c42\u804c\u7c7b\u578b"
          : key === "degree" ? "\u5b66\u5386"
            : key;
    return [`${name}\uff1a${labels.join("\u3001")}`];
  });
  return items.join("\uff1b");
}

module.exports = {
  DEFAULT_CATALOG_TTL_MS,
  normalizePlatformFilterCatalog,
  catalogVersion,
  isCatalogFresh,
  resolveNativeFilterSnapshot,
  formatNativeFilterSummary,
  salaryRange
};

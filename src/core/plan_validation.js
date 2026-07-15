const { cityToBossCode } = require("./search_plan");

function validateSearchPlan(plan = {}, candidateProfile = {}) {
  const errors = [];
  const warnings = [];
  const cities = plan.cities || [];
  const keywords = (plan.keywords || []).map((item) => typeof item === "string" ? item : item.word).filter(Boolean);
  const directions = plan.directions || candidateProfile?.candidate?.targetTitles || [];
  const salary = plan.salary || {};
  if (!cities.length) errors.push("至少选择一个目标城市。");
  if ((plan.platform?.site || "boss") === "boss") {
    const unsupportedCities = cities.filter((city) => !cityToBossCode(city));
    if (unsupportedCities.length) errors.push(`BOSS 暂不支持这些城市：${unsupportedCities.join("、")}。请从城市选项中选择。`);
  }
  if (!directions.length) errors.push("至少填写一个目标方向。");
  if (keywords.length < 2) errors.push("至少保留两个搜索关键词，避免结果过窄。");
  if (keywords.length > 12) warnings.push("关键词超过 12 个，建议分批扫描，减少重复和低相关岗位。");
  if (Number(salary.minK || 0) > 0 && Number(salary.maxK || 0) > 0 && Number(salary.minK) > Number(salary.maxK)) {
    errors.push("最低薪资不能高于最高薪资。");
  }
  const excluded = new Set([...(plan.excludeWords || []), ...(plan.hardExcludes || [])].map(normalize));
  const conflict = keywords.find((word) => excluded.has(normalize(word)));
  if (conflict) errors.push(`关键词「${conflict}」同时出现在排除项中。`);
  const scan = plan.scan || {};
  if (Number(scan.maxCards || 0) > 120) warnings.push("A 类关键词读取岗位数较高，建议先用 60-100 验证质量。");
  return { valid: errors.length === 0, errors, warnings };
}

function normalize(value) { return String(value || "").trim().toLowerCase(); }

module.exports = { validateSearchPlan };

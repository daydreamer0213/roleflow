const { evaluatePlatformBoundaries } = require("./platform_runtime_policy");
const { evaluateJobEligibility } = require("./job_eligibility");

function salaryRangeK(salary) {
  const text = String(salary || "");
  const match = text.match(/(\d+)\s*[-~—]\s*(\d+)\s*K/i);
  if (match) return { min: Number(match[1]), max: Number(match[2]) };
  const single = text.match(/(\d+)\s*K/i);
  if (single) return { min: Number(single[1]), max: Number(single[1]) };
  return { min: null, max: null };
}

function activeDays(text) {
  const value = String(text || "");
  if (/在线|刚刚|今日|今天/.test(value)) return 0;
  if (/昨日|昨天/.test(value)) return 1;
  if (/近半年|半年/.test(value)) return 180;
  const months = value.match(/近\s*(\d+)\s*个?月/);
  if (months) return Number(months[1]) * 30;
  if (/近一(?:个)?月/.test(value)) return 30;
  if (/近二(?:个)?月/.test(value)) return 60;
  if (/近三(?:个)?月/.test(value)) return 90;
  if (/近四(?:个)?月/.test(value)) return 120;
  if (/近五(?:个)?月/.test(value)) return 150;
  if (/近六(?:个)?月/.test(value)) return 180;
  const ranged = value.match(/(\d+)\s*(日|周|月|年)内活跃/);
  if (ranged) return Number(ranged[1]) * ({ 日: 1, 周: 7, 月: 30, 年: 365 }[ranged[2]] || 1);
  if (/本周/.test(value)) return 7;
  if (/本月/.test(value)) return 30;
  return null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function scoreJob(job, configs) {
  const scoring = configs.scoring;
  const profile = configs.profile;
  const text = `${job.title || ""} ${job.company || ""} ${job.location || ""} ${job.experience || ""} ${job.education || ""} ${(job.tags || []).join(" ")} ${job.description || ""}`;
  const targetCities = profile.location?.target_cities || [];
  const targetDirections = configs.targetPolicy?.directions || configs.candidateProfile?.candidate?.targetTitles || profile.candidate?.target_roles || [];
  const targetJobTypes = configs.targetPolicy?.jobTypes || ["全职"];
  const enforceJobTypes = configs.targetPolicy?.enforceJobTypes !== false;
  const eligibility = evaluateJobEligibility(job, {
    candidateProfile: configs.candidateProfile,
    allowPartTime: configs.targetPolicy?.allowPartTime === true,
    targetJobTypes: enforceJobTypes ? targetJobTypes : unique([...targetJobTypes, "实习"])
  });
  const salary = salaryRangeK(job.salary);
  const days = activeDays(job.bossActiveText);
  const workSchedule = parseWorkSchedule(`${(job.tags || []).join(" ")} ${job.description || ""}`);
  const role = classifyJobRole(job);
  let score = 0;
  const matches = [];
  const risks = [];
  const qualityTags = [];
  const platformBoundary = evaluatePlatformBoundaries(job, configs.platformPolicy);
  qualityTags.push(...platformBoundary.qualityTags);
  risks.push(...platformBoundary.risks);
  qualityTags.push(...eligibility.qualityTags);
  risks.push(...eligibility.risks);

  for (const item of scoring.positive_keywords || []) {
    if (new RegExp(escapeRegExp(item.word), "i").test(text)) {
      score += item.weight || 1;
      matches.push(item.label || item.word);
    }
  }

  for (const item of scoring.risk_rules || []) {
    if (!riskRuleApplies(item, configs, targetDirections)) continue;
    if (new RegExp(escapeRegExp(item.word), "i").test(text)) {
      score -= item.penalty || 1;
      risks.push(item.risk || item.word);
    }
  }

  if (eligibility.status === "blocked") {
    score -= 100;
  }

  if ((scoring.exclude_words || []).some((word) => text.includes(word))) {
    score -= 100;
    qualityTags.push("low_value_risk");
    qualityTags.push("hard_exclude");
    risks.push("排除词命中");
  }

  const location = String(job.location || "").trim();
  const inTargetCity = location && (!targetCities.length || targetCities.some((city) => location.startsWith(city)));
  const explicitLocationConflict = explicitNonTargetCity(`${job.title || ""} ${job.description || ""}`, targetCities);
  if ((targetCities.length && location && !inTargetCity) || explicitLocationConflict) {
    score -= 12;
    qualityTags.push("location_mismatch");
    risks.push(`地点非目标城市：${explicitLocationConflict || location}`);
  } else if (!location) {
    qualityTags.push("location_unverified");
    risks.push("地点待核验");
  }

  const enforceBossActivity = scoring.boss_activity?.enforce !== false;
  if (enforceBossActivity) {
    if (days === null) {
      score -= scoring.boss_activity?.unknown_penalty || 0;
      qualityTags.push("activity_unverified");
      risks.push("BOSS活跃未知");
    } else if (days > (scoring.boss_activity?.max_active_days || 3)) {
      score -= scoring.boss_activity?.inactive_penalty || 0;
      qualityTags.push("inactive_boss");
      risks.push(`BOSS非3日内活跃：${job.bossActiveText}`);
    } else {
      score += 2;
      matches.push("3日内活跃");
    }
  }

  if (job.detailRequired && !job.detailRead) {
    qualityTags.push("detail_unverified");
    risks.push("岗位详情待读取");
  }

  const workScheduleConfig = scoring.work_schedule || {};
  if (workSchedule.kind === "double_weekend") {
    if (workScheduleConfig.preference !== "no_preference") score += Number(workScheduleConfig.double_weekend_bonus || 4);
    qualityTags.push("work_schedule_double");
    matches.push("双休明确");
  } else if (workSchedule.kind === "alternating_weekend") {
    if (workScheduleConfig.preference !== "no_preference") score -= Number(workScheduleConfig.alternating_weekend_penalty || 3);
    qualityTags.push("work_schedule_alternating");
    risks.push("工作制为大小周或单双休");
  } else if (workSchedule.kind === "single_weekend") {
    if (workScheduleConfig.preference !== "no_preference") score -= Number(workScheduleConfig.single_weekend_penalty || 6);
    qualityTags.push("work_schedule_single");
    risks.push("工作制为单休");
  } else {
    qualityTags.push("work_schedule_unknown");
  }

  const preferredSalaryMax = Number(scoring.salary?.preferred_max_k || 0);
  const hardSalaryMax = Number(scoring.salary?.hard_max_k || 0);
  const salaryFlexMax = Number(scoring.salary?.experience_flex_max_k || 0);
  const salaryPreferenceSet = Number(scoring.salary?.expected_min_k || 0) > 0 || Number(scoring.salary?.expected_max_k || 0) > 0;
  if (preferredSalaryMax > 0 && salary.max !== null && salary.max <= preferredSalaryMax) score += 2;
  if (salary.min === null || salary.max === null) {
    qualityTags.push("salary_unverified");
    if (salaryPreferenceSet) {
      qualityTags.push("salary_preference_unverified");
      risks.push("薪资待确认");
    }
  }
  if (salary.max !== null && Number(scoring.salary?.expected_min_k || 0) > 0 && salary.max < Number(scoring.salary.expected_min_k)) {
    score -= 8;
    risks.push("薪资低于期望下限");
  }
  const salaryMode = scoring.salary?.mode || "wide";
  const salaryMin = Number(scoring.salary?.expected_min_k || 0);
  const salaryMax = Number(scoring.salary?.expected_max_k || 0);
  if (salaryMode === "strict") {
    // 严格模式只把“低于期望下限”当硬边界；薪资高于目标上限交给 salary_target_high 等软标记，不做硬排除。
    if (salary.min !== null && salary.max !== null && salaryMin > 0 && salary.max < salaryMin) {
      score -= 50;
      qualityTags.push("salary_out_of_range");
      risks.push("薪资低于期望下限，不在严格范围内");
    }
  }
  if (hardSalaryMax > 0 && salary.max !== null && salary.max > hardSalaryMax) {
    score -= 8;
    risks.push("薪资上限偏高，可能偏资深");
  }

  const experienceFit = classifyExperienceFit(job, scoring.experience || {});
  const stretchRequested = experienceFit.stretch
    || (scoring.allowExperienceStretch !== false && /3-5年|3年以上|三年以上/.test(text));
  const salaryTargetTag = salary.min === null || salary.max === null || salaryMax <= 0
    ? ""
    : (salary.min >= salaryMax + 3 || (stretchRequested && salary.min >= salaryMax + 1))
      ? "salary_target_high"
      : salary.min >= salaryMax + 1
        ? "salary_target_stretch"
        : salary.max >= salaryMin && salary.min <= salaryMax
          ? "salary_target_core"
          : "";
  if (salaryTargetTag) qualityTags.push(salaryTargetTag);
  if (salaryTargetTag === "salary_target_stretch") risks.push("薪资起点略高于目标，需结合职责确认");
  if (salaryTargetTag === "salary_target_high") risks.push("薪资起点与经验门槛明显高于当前目标，作为备选");
  const experienceSalaryAboveTarget = stretchRequested
    && salaryMax > 0
    && salary.min !== null
    && salary.min >= salaryMax;
  const experienceSalaryOverlap = stretchRequested
    && salaryMax > 0
    && salary.min !== null
    && salary.max !== null
    && salary.min < salaryMax
    && salary.max > salaryMax;
  const stretchEligible = stretchRequested
    && !experienceSalaryAboveTarget
    && !experienceSalaryOverlap
    && (salaryFlexMax <= 0 || (salary.max !== null && salary.max <= salaryFlexMax))
    && score >= 6
    && eligibility.status !== "blocked"
    && (!job.detailRequired || job.detailRead);
  if (!String(job.experience || "").trim()) {
    qualityTags.push("experience_unverified");
    risks.push("经验待确认");
  }
  if (experienceFit.inScope) {
    score += 1;
    matches.push("经验范围匹配");
  } else if (experienceSalaryAboveTarget) {
    score -= 12;
    qualityTags.push("experience_salary_above_target");
    risks.push("3-5年且薪资区间整体达到或高于目标上限");
  } else if (experienceSalaryOverlap) {
    score -= 2;
    qualityTags.push("experience_salary_overlap");
    risks.push("3-5年薪资区间与目标部分重叠，需结合完整职责判断");
  } else if (stretchEligible) {
    qualityTags.push("experience_stretch");
    if (salaryFlexMax > 0) qualityTags.push("experience_stretch_low_salary");
    risks.push("经验范围可冲刺");
  } else if (experienceFit.stretch) {
    score -= 6;
    qualityTags.push("experience_overrange");
    risks.push("3-5年仅在低于该经验门槛的薪资水平下作为可冲岗位");
  } else if (experienceFit.outOfScope) {
    score -= 4;
    qualityTags.push("experience_out_of_scope");
    risks.push("经验不在当前选择范围");
  } else if (experienceFit.overRange) {
    score -= 8;
    qualityTags.push("experience_overrange");
    risks.push("经验门槛明显偏高");
  }

  const canStretch = stretchEligible;
  if (canStretch) {
    matches.push("3-5年可冲");
    qualityTags.push("experience_stretch");
    if (salaryFlexMax > 0) qualityTags.push("experience_stretch_low_salary");
  } else if (scoring.allowExperienceStretch !== false
    && !experienceFit.configured
    && /3-5年|3年以上|三年以上|5年以上|五年以上/.test(`${job.experience || ""} ${job.description || ""}`)) {
    qualityTags.push("experience_stretch");
    risks.push("经验门槛偏高");
  }

  const lowSalary = salary.max !== null && Number(scoring.salary?.expected_min_k || 0) > 0 && salary.max < Number(scoring.salary.expected_min_k);
  const weakRoleSignal = String(job.description || "").trim().length < 160 || score < 6;
  if (["alternating_weekend", "single_weekend"].includes(workSchedule.kind) && lowSalary && weakRoleSignal) {
    qualityTags.push("work_schedule_low_priority");
    risks.push("工作制、薪资与岗位信息叠加偏弱");
  }

  const validLink = job.source !== "boss" || isBossJobUrl(job.url);
  if (!validLink) {
    qualityTags.push("missing_link");
    qualityTags.push("invalid_job_link");
    risks.push("岗位链接无效");
  }
  if (score < 0) qualityTags.push("low_value_risk");

  const level = eligibility.status === "blocked"
    ? "不建议"
    : canStretch ? "可冲" : score >= 12 ? "优先" : score >= 6 ? "可投" : "谨慎";

  return {
    score,
    level,
    matches: unique(matches),
    risks: unique(risks),
    qualityTags: unique(qualityTags),
    canStretch,
    salaryMinK: salary.min,
    salaryMaxK: salary.max,
    bossActiveDays: days,
    roleKind: role.kind,
    roleEvidence: role.evidence,
    eligibilityStatus: eligibility.status,
    employmentType: eligibility.employmentType,
    eligibilityReasonCode: eligibility.reasonCode,
    eligibilityEvidence: eligibility.evidence,
    workSchedule: workSchedule.kind,
    workScheduleEvidence: workSchedule.evidence
  };
}

function isBossJobUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    return parsed.protocol === "https:"
      && parsed.hostname === "www.zhipin.com"
      && /^\/job_detail\/[^/?#]+\.html$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function riskRuleApplies(item, configs, directions) {
  const word = String(item?.word || "");
  const skills = `${(configs.targetPolicy?.skills || []).join(" ")} ${(configs.candidateProfile?.skills || []).map((skill) => typeof skill === "string" ? skill : skill?.name || "").join(" ")}`;
  const targets = (directions || []).join(" ");
  if (/Java|Spring/i.test(word) && /Java|Spring/i.test(skills)) return false;
  if (/算法|模型训练|微调|多模态|PyTorch|TensorFlow/i.test(word) && /算法|机器学习|深度学习|NLP|CV|模型训练/.test(`${targets} ${skills}`)) return false;
  if (/产品/.test(word) && /产品/.test(targets)) return false;
  if (/顾问|实施/.test(word) && /顾问|实施|售前|解决方案/.test(targets)) return false;
  return true;
}

function explicitNonTargetCity(value, targetCities) {
  if (!(targetCities || []).length) return "";
  const text = String(value || "");
  const cityMatch = text.match(/(?:base|驻场|工作地(?:点)?|办公地(?:点)?|上班地(?:点)?|项目地(?:点)?)[：:\/\s-]*(广州|深圳|佛山|东莞|珠海|北京|上海|杭州|成都|武汉|南京|苏州|长沙|天津|西安|重庆)/i);
  const city = cityMatch?.[1] || "";
  return city && !targetCities.some((target) => city === target) ? city : "";
}

function parseWorkSchedule(value) {
  const text = String(value || "").replace(/\s+/g, " ");
  const patterns = [
    ["alternating_weekend", /(大小周|单双休|隔周双休|单.?双休)/],
    ["single_weekend", /(单休|做六休一|六天工作制|每周工作.?6天)/],
    ["double_weekend", /(周末双休|双休|做五休二|五天八小时|5天8小时|五天工作制)/]
  ];
  for (const [kind, pattern] of patterns) {
    const match = text.match(pattern);
    if (match) return { kind, evidence: match[0] };
  }
  return { kind: "unknown", evidence: "" };
}

function decisionState(job) {
  const tags = new Set(job.qualityTags || []);
  // 本地硬边界只保留跨职业通用项：链接、地点、活跃、用户排除词、工作性质与薪资底线。
  const hardBoundaryTags = [
    "missing_link",
    "invalid_job_link",
    "location_mismatch",
    "inactive_boss",
    "hard_exclude",
    "internship_role",
    "part_time_role",
    "cohort_mismatch",
    "student_status_mismatch",
    "salary_out_of_range",
    "platform_district_mismatch",
    "platform_salary_mismatch",
    "platform_experience_mismatch",
    "platform_degree_mismatch",
    "platform_job_type_mismatch"
  ];
  if (hardBoundaryTags.some((tag) => tags.has(tag))) return "blocked";
  if (tags.has("activity_unverified") || tags.has("stale_or_unknown_active") || tags.has("detail_unverified")) return "refresh";
  return "ready";
}

function classifyExperienceFit(job, policy = {}) {
  const selected = (policy.selected || []).map((item) => String(item || "")).filter(Boolean);
  if (!selected.length) return { configured: false, inScope: false, stretch: false, outOfScope: false, overRange: false };
  const structured = String(job.experience || "").trim();
  const tagged = !structured ? (job.tags || []).map(String).find(isExperienceLabel) || "" : "";
  const fallback = !structured && !tagged ? experienceRequirementText(job.description || "") : "";
  const kind = experienceKind(structured || tagged || fallback);
  const hasEntry = selected.some((item) => /经验不限|无需经验|无经验|应届/.test(item));
  const hasJunior = selected.some((item) => /0-1年|0-3年|1-3年|2-3年/.test(item));
  const hasMid = selected.some((item) => /3-5年|3年以上|三年以上/.test(item));
  const hasSenior = selected.some((item) => /5-10年|5年以上|五年以上/.test(item));
  if (kind === "entry") return { configured: true, inScope: hasEntry, stretch: false, outOfScope: !hasEntry, overRange: false };
  if (kind === "junior") return { configured: true, inScope: hasJunior, stretch: false, outOfScope: !hasJunior, overRange: false };
  if (kind === "mid") return { configured: true, inScope: false, stretch: hasMid && policy.allowStretch !== false, outOfScope: !hasMid, overRange: false };
  if (kind === "senior") return { configured: true, inScope: hasSenior, stretch: false, outOfScope: false, overRange: !hasSenior };
  return { configured: true, inScope: false, stretch: false, outOfScope: false, overRange: false };
}

function experienceKind(value) {
  const text = String(value || "");
  if (/5-10年|5年以上|五年以上|至少\s*5\s*年|10年以上|十年以上/.test(text)) return "senior";
  if (/3-5年|3年以上|三年以上|至少\s*[34]\s*年/.test(text)) return "mid";
  if (/经验不限|无需经验|无经验|应届/.test(text)) return "entry";
  if (/0-1年|0-3年|1-3年|2-3年|1年以上|2年以上|至少\s*[12]\s*年/.test(text)) return "junior";
  return "unknown";
}

function isExperienceLabel(value) {
  return experienceKind(value) !== "unknown";
}

function experienceRequirementText(description) {
  return requirementSentences(description)
    .filter((line) => /(?:经验|工作年限|至少).{0,18}(?:\d+|一|二|三|四|五|六|七|八|九|十)\s*(?:[-至到~～]\s*(?:\d+|一|二|三|四|五|六|七|八|九|十))?\s*年|(?:\d+|一|二|三|四|五|六|七|八|九|十)\s*(?:[-至到~～]\s*(?:\d+|一|二|三|四|五|六|七|八|九|十))?\s*年.{0,12}(?:经验|工作年限)/.test(line))
    .slice(0, 2)
    .join(" ");
}

function requirementSentences(description) {
  const text = String(description || "").replace(/\s+/g, " ");
  const marker = text.search(/任职要求|职位要求|岗位要求|任职资格|资格要求/i);
  const section = marker >= 0 ? text.slice(marker, marker + 2200) : text;
  return section.split(/[。；;\n]/).map((line) => line.trim()).filter((line) => line.length >= 4 && !/优先|加分项|了解即可|不限/.test(line));
}

// 本地规则只识别跨职业的工作性质（实习/社招），不再对岗位职业方向做默认分类；
// 职业方向匹配交由语义模型按匹配偏好卡逐项证据判断。
function classifyJobRole(job = {}) {
  const meta = `${String(job.title || "")} ${job.experience || ""} ${(job.tags || []).join(" ")}`;
  const internshipEvidence = meta.match(/实习(?:生)?|intern/i)?.[0] || "";
  if (internshipEvidence) return { kind: "internship", evidence: internshipEvidence };
  return { kind: "unknown", evidence: "" };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { scoreJob, salaryRangeK, activeDays, isBossJobUrl, decisionState, parseWorkSchedule, classifyJobRole, classifyExperienceFit };

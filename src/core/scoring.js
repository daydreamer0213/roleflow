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
  const readableDays = value.match(/(\d+)\s*日内活跃/);
  if (readableDays) return Number(readableDays[1]);
  if (/本周/.test(value)) return 7;
  if (/本月/.test(value)) return 30;
  if (/在线|刚刚|今日|今天/.test(value)) return 0;
  if (/昨日|昨天/.test(value)) return 1;
  const days = value.match(/(\d+)\s*日内活跃/);
  if (days) return Number(days[1]);
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
  const roleText = `${job.title || ""} ${(job.tags || []).join(" ")}`;
  const targetCities = profile.location?.target_cities || ["广州"];
  const salary = salaryRangeK(job.salary);
  const days = activeDays(job.bossActiveText);
  const workSchedule = parseWorkSchedule(`${(job.tags || []).join(" ")} ${job.description || ""}`);
  const role = classifyJobRole(job);
  let score = 0;
  const matches = [];
  const risks = [];
  const qualityTags = [];

  for (const item of scoring.positive_keywords || []) {
    if (new RegExp(escapeRegExp(item.word), "i").test(text)) {
      score += item.weight || 1;
      matches.push(item.label || item.word);
    }
  }

  for (const item of scoring.risk_rules || []) {
    if (new RegExp(escapeRegExp(item.word), "i").test(text)) {
      score -= item.penalty || 1;
      risks.push(item.risk || item.word);
    }
  }

  if (role.kind === "internship") {
    score -= 100;
    qualityTags.push("internship_role");
    risks.push("实习岗位不在当前社招目标内");
  } else if (role.kind === "algorithm") {
    score -= 24;
    qualityTags.push("algorithm_role");
    risks.push("岗位核心偏算法训练/研究，与应用开发方向不符");
  } else if (role.kind === "hybrid_algorithm") {
    score -= 4;
    qualityTags.push("algorithm_hybrid");
    risks.push("岗位包含较重算法/训练要求，建议先确认应用开发占比");
  }

  if ((scoring.exclude_words || []).some((word) => text.includes(word))) {
    score -= 100;
    qualityTags.push("low_value_risk");
    qualityTags.push("hard_exclude");
    risks.push("排除词命中");
  }

  const location = String(job.location || "").trim();
  const inTargetCity = location && targetCities.some((city) => location.startsWith(city));
  const titleLocationConflict = explicitNonTargetCity(job.title, targetCities);
  if ((location && !inTargetCity) || titleLocationConflict) {
    score -= 12;
    qualityTags.push("location_mismatch");
    risks.push(`地点非目标城市：${titleLocationConflict || location}`);
  } else if (!location) {
    qualityTags.push("location_unverified");
    risks.push("地点待核验");
  }

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

  if (salary.max !== null && salary.max <= (scoring.salary?.preferred_max_k || 24)) score += 2;
  if (salary.max !== null && Number(scoring.salary?.expected_min_k || 0) > 0 && salary.max < Number(scoring.salary.expected_min_k)) {
    score -= 8;
    risks.push("薪资低于期望下限");
  }
  const salaryMode = scoring.salary?.mode || "wide";
  const salaryMin = Number(scoring.salary?.expected_min_k || 0);
  const salaryMax = Number(scoring.salary?.expected_max_k || 0);
  if (salaryMode === "strict") {
    if (salary.min === null || salary.max === null) {
      qualityTags.push("salary_unverified");
      risks.push("薪资待确认");
    } else if ((salaryMin > 0 && salary.max < salaryMin) || (salaryMax > 0 && salary.min > salaryMax)) {
      score -= 50;
      qualityTags.push("salary_out_of_range");
      risks.push("薪资不在严格范围内");
    }
  }
  if (salary.max !== null && salary.max > (scoring.salary?.hard_max_k || 35)) {
    score -= 8;
    risks.push("薪资上限偏高，可能偏资深");
  }

  const experienceFit = classifyExperienceFit(job, scoring.experience || {});
  if (experienceFit.inScope) {
    score += 1;
    matches.push("经验范围匹配");
  } else if (experienceFit.stretch) {
    qualityTags.push("experience_stretch");
    risks.push("经验范围可冲刺");
  } else if (experienceFit.outOfScope) {
    score -= 4;
    qualityTags.push("experience_out_of_scope");
    risks.push("经验不在当前选择范围");
  } else if (experienceFit.overRange) {
    score -= 8;
    qualityTags.push("experience_overrange");
    risks.push("经验门槛明显偏高");
  }

  const legacyCanStretch =
    scoring.allowExperienceStretch !== false
    &&
    /3-5年|3年以上|三年以上/.test(text)
    && salary.max !== null
    && salary.max <= (scoring.salary?.experience_flex_max_k || 18)
    && (scoring.experience_stretch_keywords || ["AI", "RAG", "Agent", "智能体", "大模型", "知识库", "Python", "Dify", "Coze", "FastGPT", "MCP"])
      .some((keyword) => new RegExp(escapeRegExp(keyword), "i").test(text));
  const canStretch = legacyCanStretch || experienceFit.stretch;
  if (canStretch) {
    matches.push("3-5年可冲");
    qualityTags.push("experience_stretch");
  } else if (!experienceFit.configured && /3-5年|3年以上|三年以上|5年以上|五年以上/.test(`${job.experience || ""} ${job.description || ""}`)) {
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
  const roleMismatch = isClearlyNonTechnicalRole(roleText);
  if (roleMismatch) {
    score -= 100;
    qualityTags.push("role_mismatch");
    risks.push("岗位职责明显不是技术开发或技术交付");
  }
  if (score < 0) qualityTags.push("low_value_risk");

  const level = (roleMismatch || ["internship", "algorithm"].includes(role.kind))
    ? "不建议"
    : score >= 12 ? "优先" : score >= 6 ? "可投" : canStretch ? "可冲" : "谨慎";

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
    workSchedule: workSchedule.kind,
    workScheduleEvidence: workSchedule.evidence
  };
}

function isBossJobUrl(url) {
  return /https:\/\/www\.zhipin\.com\/job_detail\/[^/?#]+\.html/i.test(String(url || ""));
}

function isClearlyNonTechnicalRole(value) {
  return /(电话销售|销售代表|课程顾问|讲师|招生顾问|培训|直播主播|房产经纪|保险代理)/.test(String(value || ""));
}

function explicitNonTargetCity(title, targetCities) {
  const text = String(title || "");
  const cityMatch = text.match(/(?:base|驻场|工作地|办公地)[：:\/\s-]*(广州|深圳|佛山|东莞|珠海|北京|上海|杭州|成都|武汉|南京|苏州|长沙|天津|西安|重庆)/i);
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
  if (["missing_link", "invalid_job_link", "location_mismatch", "inactive_boss", "role_mismatch", "hard_exclude", "internship_role", "algorithm_role", "salary_out_of_range"].some((tag) => tags.has(tag))) {
    return "blocked";
  }
  if (tags.has("activity_unverified") || tags.has("stale_or_unknown_active") || tags.has("detail_unverified") || tags.has("salary_unverified")) return "refresh";
  return "ready";
}

function classifyExperienceFit(job, policy = {}) {
  const selected = (policy.selected || []).map((item) => String(item || "")).filter(Boolean);
  if (!selected.length) return { configured: false, inScope: false, stretch: false, outOfScope: false, overRange: false };
  const text = `${job.experience || ""} ${(job.tags || []).join(" ")} ${job.description || ""}`;
  const kind = /5-10年|5年以上|五年以上|10年以上|十年以上/.test(text) ? "senior"
    : /3-5年|3年以上|三年以上/.test(text) ? "mid"
      : /经验不限|无需经验|无经验|应届/.test(text) ? "entry"
        : /0-1年|0-3年|1-3年|2-3年|1年以上|2年以上/.test(text) ? "junior" : "unknown";
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

function classifyJobRole(job = {}) {
  const title = String(job.title || "");
  const meta = `${title} ${job.experience || ""} ${(job.tags || []).join(" ")}`;
  const description = String(job.description || "");
  const fullText = `${meta} ${description}`;
  const internshipEvidence = meta.match(/实习(?:生)?|intern/i)?.[0] || "";
  if (internshipEvidence) return { kind: "internship", evidence: internshipEvidence };

  const applicationTitle = /AI应用|大模型应用|应用开发|AI后端|Python后端|Python开发|智能体|Agent|RAG|知识库|LLM应用|AI开发|后端开发|工程交付|解决方案/i.test(title);
  const algorithmTitle = /算法工程师|算法开发|算法研究|机器学习工程师|深度学习工程师|NLP算法|自然语言处理算法|视觉算法|CV算法|推荐算法|模型训练/.test(title);
  const algorithmSignals = [
    "模型训练", "预训练", "算法研究", "算法建模", "模型微调", "强化学习",
    "机器学习", "深度学习", "大模型算法", "多模态算法", "算法工程化",
    "计算机视觉", "目标检测", "图像分割", "语音识别", "自然语言处理算法", "NLP算法"
  ].filter((signal) => fullText.includes(signal));

  if (algorithmTitle || (!applicationTitle && algorithmSignals.length >= 2)) {
    return { kind: "algorithm", evidence: algorithmTitle ? title : algorithmSignals.slice(0, 2).join("、") };
  }
  if (applicationTitle && algorithmSignals.length >= 2) {
    return { kind: "hybrid_algorithm", evidence: algorithmSignals.slice(0, 2).join("、") };
  }
  return { kind: applicationTitle ? "application" : "unknown", evidence: "" };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { scoreJob, salaryRangeK, activeDays, isBossJobUrl, decisionState, parseWorkSchedule, classifyJobRole, classifyExperienceFit };

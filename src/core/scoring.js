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
  const roleText = `${job.title || ""} ${(job.tags || []).join(" ")}`;
  const targetCities = profile.location?.target_cities || [];
  const targetDirections = configs.targetPolicy?.directions || configs.candidateProfile?.candidate?.targetTitles || profile.candidate?.target_roles || [];
  const targetJobTypes = configs.targetPolicy?.jobTypes || ["全职"];
  const salary = salaryRangeK(job.salary);
  const days = activeDays(job.bossActiveText);
  const workSchedule = parseWorkSchedule(`${(job.tags || []).join(" ")} ${job.description || ""}`);
  const role = classifyJobRole(job);
  const technicalFit = classifyTechnicalFit(job, configs);
  const acceptsInternship = targetJobTypes.some((item) => /实习/.test(String(item)));
  const targetsAlgorithm = targetDirections.some((item) => /算法|机器学习|深度学习|NLP|自然语言处理|计算机视觉|CV/.test(String(item)));
  const roleMismatch = isClearlyNonTechnicalRole(roleText) && !matchesTargetDirection(roleText, targetDirections);
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
    if (!riskRuleApplies(item, configs, targetDirections)) continue;
    if (new RegExp(escapeRegExp(item.word), "i").test(text)) {
      score -= item.penalty || 1;
      risks.push(item.risk || item.word);
    }
  }

  if (role.kind === "internship" && !acceptsInternship) {
    score -= 100;
    qualityTags.push("internship_role");
    risks.push("实习岗位不在当前社招目标内");
  } else if (role.kind === "algorithm" && !targetsAlgorithm) {
    score -= 24;
    qualityTags.push("algorithm_role");
    risks.push("岗位核心偏算法训练/研究，与应用开发方向不符");
  } else if (role.kind === "hybrid_algorithm" && !targetsAlgorithm) {
    score -= 4;
    qualityTags.push("algorithm_hybrid");
    risks.push("岗位包含较重算法/训练要求，建议先确认应用开发占比");
  }

  if (technicalFit.kind === "aligned") {
    score += 2;
    matches.push("核心技术栈匹配");
  } else if (technicalFit.kind === "core_stack_mismatch") {
    score -= 12;
    qualityTags.push("core_stack_mismatch");
    risks.push(`核心技术栈偏 ${technicalFit.stackLabel}，与当前简历主栈不一致`);
  } else if (technicalFit.kind === "java_backend_heavy") {
    score -= 6;
    qualityTags.push("java_backend_heavy");
    risks.push("核心后端栈偏 Java/Spring，需确认 Python/AI 应用占比");
  } else if (technicalFit.kind === "senior_engineering_heavy") {
    score -= 6;
    qualityTags.push("senior_engineering_heavy");
    risks.push("高并发、云原生或分布式工程要求较重，可能偏资深");
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
  if (salary.min === null || salary.max === null) {
    qualityTags.push("salary_unverified");
    risks.push("薪资待确认");
  }
  if (salary.max !== null && Number(scoring.salary?.expected_min_k || 0) > 0 && salary.max < Number(scoring.salary.expected_min_k)) {
    score -= 8;
    risks.push("薪资低于期望下限");
  }
  const salaryMode = scoring.salary?.mode || "wide";
  const salaryMin = Number(scoring.salary?.expected_min_k || 0);
  const salaryMax = Number(scoring.salary?.expected_max_k || 0);
  if (salaryMode === "strict") {
    if (salary.min !== null && salary.max !== null && ((salaryMin > 0 && salary.max < salaryMin) || (salaryMax > 0 && salary.min > salaryMax))) {
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
  const stretchRequested = experienceFit.stretch
    || (scoring.allowExperienceStretch !== false && /3-5年|3年以上|三年以上/.test(text));
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
    && salary.max !== null
    && salary.max <= Number(scoring.salary?.experience_flex_max_k || 18)
    && score >= 6
    && isStretchTechnicalMatch(job, role, technicalFit, roleMismatch)
    && !["core_stack_mismatch", "java_backend_heavy", "senior_engineering_heavy"].includes(technicalFit.kind)
    && !(role.kind === "algorithm" && !targetsAlgorithm)
    && !(role.kind === "internship" && !acceptsInternship)
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
    qualityTags.push("experience_stretch_low_salary");
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
    qualityTags.push("experience_stretch_low_salary");
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
  if (roleMismatch) {
    score -= 100;
    qualityTags.push("role_mismatch");
    risks.push("岗位职责明显不是技术开发或技术交付");
  }
  if (score < 0) qualityTags.push("low_value_risk");

  const roleBlocked = roleMismatch || (role.kind === "internship" && !acceptsInternship) || (role.kind === "algorithm" && !targetsAlgorithm);
  const level = roleBlocked
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
    workSchedule: workSchedule.kind,
    workScheduleEvidence: workSchedule.evidence,
    technicalFit
  };
}

function isBossJobUrl(url) {
  return /https:\/\/www\.zhipin\.com\/job_detail\/[^/?#]+\.html/i.test(String(url || ""));
}

function isClearlyNonTechnicalRole(value) {
  return /(电话销售|销售(?:代表|经理|顾问|专员)?|商务(?:经理|专员|拓展)?|客户经理|运营(?:经理|专员)?|产品经理|课程顾问|讲师|训练师|知识运营|招生顾问|培训|直播主播|房产经纪|保险代理)/.test(String(value || ""));
}

function matchesTargetDirection(roleText, directions) {
  const text = String(roleText || "");
  return (directions || []).some((direction) => {
    const value = String(direction || "").trim();
    if (!value) return false;
    if (/产品/.test(value) && /产品/.test(text)) return true;
    if (/销售|商务|客户经理/.test(value) && /销售|商务|客户经理/.test(text)) return true;
    if (/运营/.test(value) && /运营/.test(text)) return true;
    if (/实施|售前|解决方案/.test(value) && /实施|售前|解决方案/.test(text)) return true;
    if (/讲师|训练师|知识运营|培训/.test(value) && /讲师|训练师|知识运营|培训/.test(text)) return true;
    return false;
  });
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

function isStretchTechnicalMatch(job, role, technicalFit, roleMismatch) {
  if (roleMismatch || role.kind !== "application") return false;
  if (technicalFit.kind === "aligned") return true;
  const text = `${(job.tags || []).join(" ")} ${job.description || ""}`.toLowerCase();
  const signals = ["python", "rag", "agent", "langchain", "langgraph", "fastapi", "llm", "大模型", "知识库", "向量"].filter((signal) => text.includes(signal));
  return new Set(signals).size >= 2;
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
  if (["missing_link", "invalid_job_link", "location_mismatch", "inactive_boss", "role_mismatch", "hard_exclude", "internship_role", "algorithm_role", "salary_out_of_range", "experience_salary_above_target"].some((tag) => tags.has(tag))) {
    return "blocked";
  }
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

function classifyTechnicalFit(job = {}, configs = {}) {
  const candidateSkills = candidateSkillText(configs);
  if (!candidateSkills) return { kind: "unknown", stackLabel: "", evidence: [] };
  const requirements = requirementSentences(job.description || "");
  const evidence = requirements.filter((line) => /(Python|C\+\+|C\/C\+\+|Golang|Go语言|\bGo\b|Java|Spring\s*Boot|Spring\s*Cloud|高并发|高可用|分布式|微服务|Kubernetes|K8s)/i.test(line));
  const hasCandidatePython = /python/.test(candidateSkills);
  const hasCandidateCpp = /c\+\+|c\/c\+\+/.test(candidateSkills);
  const hasCandidateGo = /golang|go语言|\bgo\b/.test(candidateSkills);
  const hasCandidateJava = /java|spring/.test(candidateSkills);
  const requiredCppGo = evidence.filter((line) => mentionsRequiredStack(line, /C\+\+|C\/C\+\+|Golang|Go语言|\bGo\b/i));
  const cppGoOnly = requiredCppGo.filter((line) => !/Python/i.test(line));
  if (cppGoOnly.length && !hasCandidateCpp && !hasCandidateGo) {
    return { kind: "core_stack_mismatch", stackLabel: stackLabel(cppGoOnly.join(" ")), evidence: cppGoOnly.slice(0, 2) };
  }

  const javaEvidence = evidence.filter((line) => mentionsRequiredStack(line, /Java|Spring\s*Boot|Spring\s*Cloud/i));
  const javaHeavy = javaEvidence.some((line) => /Spring\s*(?:Boot|Cloud)/i.test(line))
    || javaEvidence.length >= 2;
  if (javaHeavy && !hasCandidateJava && !evidence.some((line) => /Python/i.test(line))) {
    return { kind: "java_backend_heavy", stackLabel: "Java/Spring", evidence: javaEvidence.slice(0, 2) };
  }

  const seniorSignals = evidence.filter((line) => /高并发|高可用|分布式|微服务|Kubernetes|K8s/i.test(line));
  if (seniorSignals.length >= 2) {
    return { kind: "senior_engineering_heavy", stackLabel: "资深工程化", evidence: seniorSignals.slice(0, 2) };
  }

  if (hasCandidatePython && evidence.some((line) => /Python/i.test(line))) {
    return { kind: "aligned", stackLabel: "Python", evidence: evidence.filter((line) => /Python/i.test(line)).slice(0, 2) };
  }
  return { kind: "unknown", stackLabel: "", evidence: [] };
}

function candidateSkillText(configs = {}) {
  const skills = [
    ...(configs.candidateProfile?.skills || []),
    ...(configs.profile?.candidate?.strengths || []),
    ...(configs.candidateProfile?.candidate?.directions || [])
  ].map((skill) => typeof skill === "string" ? skill : skill?.name || "").filter(Boolean);
  return skills.join(" ").toLowerCase();
}

function requirementSentences(description) {
  const text = String(description || "").replace(/\s+/g, " ");
  const marker = text.search(/任职要求|职位要求|岗位要求|任职资格|资格要求/i);
  const section = marker >= 0 ? text.slice(marker, marker + 2200) : text;
  return section.split(/[。；;\n]/).map((line) => line.trim()).filter((line) => line.length >= 4 && !/优先|加分项|了解即可|不限/.test(line));
}

function mentionsRequiredStack(line, pattern) {
  return pattern.test(line) && /(熟练|精通|掌握|必须|必备|要求|至少|扎实|具备|负责)/.test(line);
}

function stackLabel(text) {
  const labels = [];
  if (/C\+\+|C\/C\+\+/i.test(text)) labels.push("C++");
  if (/Golang|Go语言|\bGo\b/i.test(text)) labels.push("Go");
  return labels.join("/") || "非 Python 后端";
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

module.exports = { scoreJob, salaryRangeK, activeDays, isBossJobUrl, decisionState, parseWorkSchedule, classifyJobRole, classifyExperienceFit, classifyTechnicalFit };

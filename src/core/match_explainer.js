function explainJobMatch(job, configs, keywordPlan = []) {
  const profile = configs.candidateProfile;
  const versions = configs.resumeVersions?.versions || [];
  const text = jobText(job);
  const version = chooseResumeVersion(job, versions, keywordPlan, text);
  const matchedSkills = (profile?.skills || []).filter((skill) => hasText(text, skill)).slice(0, 6);
  const primaryProjects = chooseProjects(profile?.projects || [], version, matchedSkills);

  return {
    provider: "rule-mock",
    model: "none",
    fitReasons: fitReasons(job, matchedSkills, version),
    missingPoints: missingPoints(text),
    riskQuestions: riskQuestions(job),
    recommendedResumeVersion: version?.id || "",
    primaryProjects: primaryProjects.map((project) => project.name),
    greetingAngle: greetingAngle(version, primaryProjects),
    llmReady: true
  };
}

function jobText(job) {
  return `${job.title || ""} ${job.company || ""} ${job.location || ""} ${job.experience || ""} ${job.education || ""} ${(job.tags || []).join(" ")} ${job.description || ""}`.toLowerCase();
}

function chooseResumeVersion(job, versions, keywordPlan, text) {
  const planned = keywordPlan.find((item) => item.word && hasText(`${job.keyword || ""} ${job.title || ""}`, item.word));
  if (planned?.resumeVersion) {
    const byPlan = versions.find((version) => version.id === planned.resumeVersion);
    if (byPlan) return byPlan;
  }

  let best = null;
  for (const version of versions) {
    const score = [...(version.keywords || []), ...(version.scenarios || [])]
      .reduce((sum, word) => sum + (hasText(text, word) ? 1 : 0), 0);
    if (!best || score > best.score) best = { version, score };
  }
  return best?.version || versions[0] || null;
}

function chooseProjects(projects, version, matchedSkills) {
  const wanted = new Set(version?.primaryProjects || []);
  const byVersion = projects.filter((project) => wanted.has(project.name));
  if (byVersion.length) return byVersion;
  return projects
    .map((project) => ({
      project,
      score: (project.tags || []).filter((tag) => matchedSkills.some((skill) => hasText(skill, tag) || hasText(tag, skill))).length
    }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.project)
    .slice(0, 2);
}

function fitReasons(job, matchedSkills, version) {
  const reasons = [];
  if (matchedSkills.length) reasons.push(`技能命中：${matchedSkills.join("、")}`);
  if (job.canStretch) reasons.push("年限略高但薪资和方向可冲");
  if (version) reasons.push(`推荐使用「${version.name}」`);
  return reasons.length ? reasons : ["等待 LLM 语义分析补充匹配理由"];
}

function missingPoints() {
  // rule-only 模式不做职业特定的缺口猜测，只提示需要语义模型逐项比对。
  return [];
}

function riskQuestions(job) {
  const questions = [];
  for (const risk of job.risks || []) questions.push(`确认风险：${risk}`);
  if (!job.detailRead) questions.push("详情未读取完整，人工打开链接确认岗位真实职责");
  return questions.slice(0, 5);
}

function greetingAngle(version, projects) {
  const projectNames = projects.map((project) => project.name).join("、");
  if (!version && !projectNames) return "先确认岗位真实职责，再简短介绍项目经验。";
  return `围绕${version?.name || "匹配版本"}切入，主推${projectNames || "相关项目"}。`;
}

function hasText(text, word) {
  return String(text || "").toLowerCase().includes(String(word || "").toLowerCase());
}

function hardBoundaryReason(job, qualityTags = new Set(job?.qualityTags || [])) {
  const risks = Array.isArray(job?.risks) ? job.risks.filter((item) => typeof item === "string" && item.trim()) : [];
  const selectors = [
    ["cohort_mismatch", /届|毕业年份/],
    ["student_status_mismatch", /在校|已毕业/],
    ["internship_role", /实习/],
    ["part_time_role", /兼职|小时/],
    ["location_mismatch", /地点非目标城市/],
    ["salary_out_of_range", /薪资低于期望下限/],
    ["platform_district_mismatch", /区域不符合平台筛选/],
    ["platform_salary_mismatch", /薪资不符合平台筛选/],
    ["platform_experience_mismatch", /经验不符合平台筛选/],
    ["platform_degree_mismatch", /学历不符合平台筛选/],
    ["platform_job_type_mismatch", /求职类型不符合平台筛选/],
    ["inactive_boss", /BOSS非.*活跃/],
    ["hard_exclude", /排除词/],
    ["invalid_job_link", /岗位链接无效/],
    ["missing_link", /链接/]
  ];
  for (const [tag, pattern] of selectors) {
    if (!qualityTags.has(tag)) continue;
    const risk = risks.find((item) => pattern.test(item));
    if (!risk) continue;
    if (tag === "location_mismatch") return risk.replace("地点非目标城市：", "工作地点不符合筛选条件：");
    if (["salary_out_of_range", "platform_salary_mismatch"].includes(tag) && typeof job.salary === "string" && job.salary.trim()) {
      return `岗位薪资 ${job.salary.trim()}；${risk}`;
    }
    return risk;
  }
  return "";
}

module.exports = { explainJobMatch, hardBoundaryReason };

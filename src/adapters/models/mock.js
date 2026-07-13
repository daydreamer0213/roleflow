class MockModelAdapter {
  constructor(config = {}) {
    this.provider = "mock";
    this.model = config.model || "offline-structured-mock";
  }

  async analyzeResume({ resumeText = "", profileHints = {} } = {}) {
    if (String(resumeText || "").trim()) return profileFromResumeText(resumeText);
    const candidate = profileHints.candidate || {};
    const projects = profileHints.projects || [];
    return {
      candidate: {
        name: candidate.name || "候选人",
        city: candidate.city || "",
        targetTitles: candidate.targetTitles || candidate.directions || [],
        expectedSalary: candidate.expectedSalary || "",
        adjustableSalary: candidate.adjustableSalary || []
      },
      skills: toSkillEvidence(profileHints.skills || [], projects),
      projects: projects.map((project) => ({
        name: project.name,
        roleBoundary: "按项目经历稳健表达，不夸大职责边界",
        canSay: project.tags || [],
        avoidSaying: ["全权负责", "主导完整架构"]
      })),
      resumeVersions: [],
      riskMessaging: profileHints.riskMessaging || {},
      source: {
        provider: this.provider,
        model: this.model,
        resumeTextLength: String(resumeText || "").length
      }
    };
  }

  async recommendSearchPlan({ candidateProfile = {} } = {}) {
    const candidate = candidateProfile.candidate || {};
    const targetTitles = candidate.targetTitles || [];
    const skills = (candidateProfile.skills || []).map((item) => typeof item === "string" ? item : item.name);
    const keywords = [...targetTitles, ...skills.filter((skill) => /RAG|Agent|Python|FastAPI|知识库|数据|后端/i.test(skill))]
      .filter(Boolean)
      .slice(0, 10)
      .map((word, index) => ({ word, priority: index < 4 ? "A" : "B", reason: "离线简历关键词提取" }));
    return {
      name: `${candidate.city || "目标城市"}岗位筛选计划`,
      cities: candidate.city ? [candidate.city] : [],
      salary: salaryRange(candidate.expectedSalary),
      experience: ["经验不限", "0-3年", "1-3年"],
      allowExperienceStretch: true,
      bossActiveDays: 3,
      directions: targetTitles,
      keywords,
      excludeWords: ["销售", "培训", "讲师", "课程顾问"],
      source: "offline-mock"
    };
  }

  async understandJob({ job = {} } = {}) {
    const text = jobText(job);
    const coreRequirements = pickTerms(text, ["Python", "FastAPI", "RAG", "Agent", "LangChain", "LangGraph", "知识库", "向量数据库"]);
    const hiddenRisks = [];
    if (hasAny(text, ["外包", "驻场"])) hiddenRisks.push({ type: "outsourcing", severity: "medium", evidence: "JD 疑似出现外包/驻场表述" });
    if (hasAny(text, ["培训", "讲师", "课程", "销售"])) hiddenRisks.push({ type: "training_or_sales", severity: "high", evidence: "JD 疑似出现培训/讲师/销售表述" });

    return {
      jobId: job.sourceId || job.url || "",
      realRoleType: inferRoleType(text),
      businessScenario: inferScenario(text),
      coreRequirements,
      niceToHave: pickTerms(text, ["Milvus", "ChromaDB", "BM25", "RRF", "Rerank", "Docker"]),
      senioritySignal: inferSeniority(text),
      hiddenRisks,
      isFakeAI: false,
      isTrainingOrSales: hiddenRisks.some((risk) => risk.type === "training_or_sales"),
      evidenceSnippets: [job.title, job.description].filter(Boolean).map((x) => String(x).slice(0, 120))
    };
  }

  async matchJob({ candidateProfile = {}, resumeVersions = {}, jobUnderstanding = {} } = {}) {
    const versions = resumeVersions.versions || resumeVersions || [];
    const version = chooseVersion(versions, jobUnderstanding);
    const highRisk = jobUnderstanding.isTrainingOrSales || (jobUnderstanding.hiddenRisks || []).some((risk) => risk.severity === "high");
    return {
      recommendation: highRisk ? "skip" : "apply",
      fitLevel: highRisk ? "D" : "B",
      confidence: highRisk ? 0.45 : 0.72,
      fitReasons: [
        `${jobUnderstanding.realRoleType || "unknown"} 与候选方向可做初步匹配`,
        `核心要求：${(jobUnderstanding.coreRequirements || []).join("、") || "待确认"}`
      ],
      missingPoints: ["mock 仅做结构稳定，真实语义缺口等待模型 adapter 判断"],
      riskQuestions: (jobUnderstanding.hiddenRisks || []).map((risk) => risk.evidence),
      recommendedResumeVersion: version?.id || "",
      primaryProjects: version?.primaryProjects || pickProjectNames(candidateProfile.projects || []),
      greetingAngle: version ? `围绕${version.name}切入，先确认岗位真实职责。` : "先确认岗位真实职责，再介绍相关项目。",
      evidence: {
        jd: (jobUnderstanding.evidenceSnippets || []).slice(0, 3),
        resume: (candidateProfile.skills || []).slice(0, 4).map((skill) => typeof skill === "string" ? skill : skill.name).filter(Boolean)
      },
      hrPrep: {
        gap: candidateProfile.riskMessaging?.gap || "按稳健 GAP 口径回答",
        salary: `期望 ${candidateProfile.candidate?.expectedSalary || "面议"}，可结合岗位调整`
      }
    };
  }

  async draftCommunication({ candidateProfile = {}, jobUnderstanding = {}, matchDecision = {} } = {}) {
    const name = candidateProfile.candidate?.name || "候选人";
    return {
      jobId: jobUnderstanding.jobId || "",
      greeting: `您好，我是${name}。看到岗位方向与${matchDecision.greetingAngle || "我的项目经验"}相关，想进一步了解岗位职责和团队情况。`,
      hrReplies: {
        gap: candidateProfile.riskMessaging?.gap || "这段时间主要在收敛职业方向，并持续做 AI 应用项目实践。",
        salary: `目前期望 ${candidateProfile.candidate?.expectedSalary || "面议"}，也会结合岗位职责沟通。`,
        arrival: "可以按公司流程配合到岗时间。"
      },
      tone: "自然、稳健、不夸大"
    };
  }
}

function profileFromResumeText(resumeText) {
  const text = String(resumeText || "");
  const city = pickFirst(text, ["广州", "深圳", "北京", "上海", "杭州", "成都", "武汉", "南京", "苏州", "长沙", "佛山", "东莞"]);
  const targetTitles = ["AI应用开发工程师", "大模型应用开发", "RAG工程师", "Agent工程师", "Python后端", "Python开发工程师"]
    .filter((term) => sameText(text, term));
  const skills = ["Python", "FastAPI", "RAG", "Agent", "LangChain", "LangGraph", "知识库", "向量数据库", "Docker", "MySQL", "Redis", "Java", "Spring Boot"]
    .filter((term) => sameText(text, term))
    .map((name) => ({ name, level: "resume", evidence: [] }));
  const projectNames = extractProjectNames(text);
  const expectedSalary = (text.match(/(?:期望薪资|薪资期望|薪酬期望)[：:\s]*([\d.]+\s*[-~至]\s*[\d.]+\s*[kK]?)/) || [])[1] || "";
  const name = (text.match(/(?:姓名)[：:\s]*([\u4e00-\u9fff]{2,8})/) || [])[1] || "候选人";
  const titles = targetTitles.length ? targetTitles : skills.some((skill) => skill.name === "Python") ? ["Python开发工程师"] : [];
  return {
    candidate: { name, city, targetTitles: titles, expectedSalary, adjustableSalary: [] },
    skills,
    projects: projectNames.map((name) => ({ name, roleBoundary: "仅按简历已有事实表达，不夸大职责边界。", canSay: [], avoidSaying: ["全权负责", "独立搭建完整系统"] })),
    resumeVersions: [{
      id: "main_resume",
      name: "主简历版本",
      summary: "根据上传简历生成；可在后续编辑为不同岗位方向的版本。",
      primaryProjects: projectNames.slice(0, 2),
      scenarios: titles,
      keywords: skills.map((skill) => skill.name)
    }],
    riskMessaging: {},
    source: { provider: "mock", model: "offline-structured-mock", resumeTextLength: text.length }
  };
}

function extractProjectNames(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return [...new Set(lines.filter((line) => /项目|系统|平台|工具|MVP/.test(line) && line.length >= 3 && line.length <= 60)
    .map((line) => line.replace(/[｜|].*$/, "").replace(/（.*?）|\(.*?\)/g, "").trim()))].slice(0, 6);
}

function pickFirst(text, terms) {
  return terms.find((term) => sameText(text, term)) || "";
}

function salaryRange(value) {
  const numbers = String(value || "").match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
  return { minK: numbers[0] || 0, maxK: numbers[1] || numbers[0] || 0 };
}

function toSkillEvidence(skills, projects) {
  return skills.map((skill) => ({
    name: skill,
    level: "project",
    evidence: projects.filter((project) => (project.tags || []).some((tag) => sameText(tag, skill))).map((project) => project.name)
  }));
}

function chooseVersion(versions, jobUnderstanding) {
  const text = `${jobUnderstanding.realRoleType || ""} ${jobUnderstanding.businessScenario || ""} ${(jobUnderstanding.coreRequirements || []).join(" ")}`;
  return versions.find((version) => [...(version.keywords || []), ...(version.scenarios || [])].some((word) => sameText(text, word))) || versions[0] || null;
}

function pickProjectNames(projects) {
  return projects.slice(0, 2).map((project) => project.name).filter(Boolean);
}

function jobText(job) {
  return `${job.title || ""} ${(job.tags || []).join(" ")} ${job.description || ""}`;
}

function pickTerms(text, terms) {
  return terms.filter((term) => sameText(text, term));
}

function hasAny(text, terms) {
  return terms.some((term) => sameText(text, term));
}

function sameText(text, term) {
  return String(text || "").toLowerCase().includes(String(term || "").toLowerCase());
}

function inferRoleType(text) {
  if (hasAny(text, ["RAG", "知识库", "智能问答"])) return "ai_application";
  if (hasAny(text, ["Python", "FastAPI"])) return "python_backend_ai";
  return "unknown";
}

function inferScenario(text) {
  if (hasAny(text, ["知识库", "智能问答"])) return "企业知识库/智能问答";
  if (hasAny(text, ["Agent", "工具调用"])) return "Agent 工具调用";
  return "待模型进一步判断";
}

function inferSeniority(text) {
  if (hasAny(text, ["经验不限", "1-3年", "0-3年"])) return "junior";
  if (hasAny(text, ["3-5年"])) return "junior_mid";
  if (hasAny(text, ["5-10年", "专家", "架构"])) return "senior";
  return "unknown";
}

module.exports = { MockModelAdapter };

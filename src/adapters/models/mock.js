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
      education: profileHints.education || [],
      experiences: profileHints.experiences || [],
      skills: toSkillEvidence(profileHints.skills || [], projects),
      projects: projects.map((project) => ({
        name: project.name,
        roleBoundary: "按项目经历稳健表达，不夸大职责边界",
        canSay: project.tags || [],
        avoidSaying: ["全权负责", "主导完整架构"]
      })),
      credentials: profileHints.credentials || [],
      strengths: profileHints.strengths || [],
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
    const hardBlockers = highRisk
      ? (jobUnderstanding.hiddenRisks || []).filter((risk) => risk.severity === "high").map((risk) => risk.evidence || risk.type).filter(Boolean)
      : [];
    if (highRisk && !hardBlockers.length) hardBlockers.push("岗位属于培训、销售或其他明确非目标职责");
    return {
      recommendation: highRisk ? "skip" : "apply",
      fitLevel: highRisk ? "D" : "B",
      confidence: highRisk ? 0.45 : 0.72,
      fitReasons: [
        `${jobUnderstanding.realRoleType || "unknown"} 与候选方向可做初步匹配`,
        `核心要求：${(jobUnderstanding.coreRequirements || []).join("、") || "待确认"}`
      ],
      hardBlockers,
      softGaps: ["mock 仅做结构稳定，真实语义缺口等待模型 adapter 判断"],
      questionsToVerify: (jobUnderstanding.hiddenRisks || []).map((risk) => risk.evidence),
      recommendedResumeVersion: version?.id || "",
      primaryProjects: version?.primaryProjects || pickProjectNames(candidateProfile.projects || []),
      greetingAngle: version ? `围绕${version.name}切入，先确认岗位真实职责。` : "先确认岗位真实职责，再介绍相关项目。",
      evidence: {
        jd: (jobUnderstanding.evidenceSnippets || []).slice(0, 3),
        resume: (candidateProfile.skills || []).slice(0, 4).map((skill) => typeof skill === "string" ? skill : skill.name).filter(Boolean)
      }
    };
  }

  async draftCommunication({ mode = "greeting", candidateProfile = {}, jobUnderstanding = {}, matchDecision = {}, hrMessage = "", userProvidedFacts = [] } = {}) {
    const kind = ["greeting", "hr_reply", "follow_up"].includes(mode) ? mode : "greeting";
    const jobEvidence = (matchDecision.evidence?.jd || jobUnderstanding.evidenceSnippets || []).slice(0, 2);
    const resumeEvidence = (matchDecision.evidence?.resume || (candidateProfile.skills || []).map((skill) => skill.name || skill)).slice(0, 2);
    const facts = Object.fromEntries((userProvidedFacts || []).map((item) => [item.factKey, item.factValue]));
    if (kind === "hr_reply") {
      const required = requiredCommunicationFact(hrMessage);
      if (required && !facts[required.key]) {
        return { kind, jobId: jobUnderstanding.jobId || "", messages: [], missingFact: required, evidence: { jd: [], resume: [] }, tone: "自然、稳健、不夸大" };
      }
      const salary = candidateProfile.candidate?.expectedSalary;
      const answer = required ? facts[required.key]
        : /薪资|期望/.test(hrMessage) && salary ? `目前期望薪资是 ${salary}，也可以结合岗位职责和整体待遇进一步沟通。`
          : "您好，已收到您的问题。我会按简历中的实际经历如实说明，也愿意进一步沟通岗位细节。";
      return { kind, jobId: jobUnderstanding.jobId || "", messages: [answer], missingFact: null, evidence: { jd: [], resume: required ? [answer] : resumeEvidence }, tone: "自然、稳健、不夸大" };
    }
    const role = jobUnderstanding.businessScenario || jobUnderstanding.realRoleType || "岗位核心工作";
    const project = matchDecision.primaryProjects?.[0] || "相关项目";
    const message = kind === "follow_up"
      ? `您好，补充一下：我在${project}中有与${role}相关的实践，和岗位职责比较贴近。如岗位仍在推进，希望能进一步沟通。`
      : `您好，我在${project}中做过与${role}相关的工作，和这个岗位的核心职责比较贴近，希望进一步沟通。`;
    return { kind, jobId: jobUnderstanding.jobId || "", messages: [message], missingFact: null, evidence: { jd: jobEvidence, resume: resumeEvidence }, tone: "自然、稳健、不夸大" };
  }
}

function requiredCommunicationFact(message) {
  const text = String(message || "");
  if (/gap|空窗|为什么.*(?:没工作|没上班|中断)/i.test(text)) return { key: "gap", question: "这段 GAP 期间你实际在做什么？请用一两句话填写可对外说明的事实。" };
  if (/离职|为什么.*离开|不继续做/.test(text)) return { key: "leaving_reason", question: "请填写你希望对 HR 说明的真实离开原因。" };
  if (/到岗|什么时候.*(?:上班|入职)|入职时间/.test(text)) return { key: "arrival", question: "你目前最早可以什么时候到岗？" };
  if (/短期项目|为什么.*短|项目.*(?:结束|离开)/.test(text)) return { key: "short_project", question: "请填写这个短期项目的真实性质和结束原因。" };
  return null;
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
    education: [],
    experiences: [],
    skills,
    projects: projectNames.map((name) => ({ name, roleBoundary: "仅按简历已有事实表达，不夸大职责边界。", canSay: [], avoidSaying: ["全权负责", "独立搭建完整系统"] })),
    resumeVersions: [],
    credentials: [],
    strengths: [],
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

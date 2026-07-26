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
    const sentences = splitSentences(text);
    const dutyGroups = [
      { pattern: /直播/, label: "直播" },
      { pattern: /拍摄|剪辑|短视频制作/, label: "拍摄剪辑" },
      { pattern: /投放|投流/, label: "投放" },
      { pattern: /客服|售后/, label: "客服" },
      { pattern: /销售|地推|电销/, label: "销售" },
      { pattern: /开发|接口|系统|平台搭建/, label: "开发" }
    ].filter((group) => group.pattern.test(text));
    const concerns = [];
    if (dutyGroups.length >= 3) {
      concerns.push({ type: "responsibility_sprawl", evidence: `JD 同时堆叠不相关职责：${dutyGroups.map((group) => group.label).join("、")}` });
    }
    const hiddenRisks = [];
    if (hasAny(text, ["外包", "驻场"])) hiddenRisks.push({ type: "outsourcing", severity: "medium", evidence: "JD 疑似出现外包/驻场表述" });
    if (hasAny(text, ["培训费", "收费培训", "培训贷", "先交费"])) hiddenRisks.push({ type: "training_fee", severity: "high", evidence: "JD 疑似出现收费培训表述" });
    const coreRequirements = sentences
      .filter((sentence) => /必须|熟练|精通|掌握|至少|扎实|具备|要求|负责/.test(sentence))
      .slice(0, 8)
      .map((sentence) => ({
        label: clip(sentence, 24),
        indispensable: /必须|熟练|精通|至少|扎实/.test(sentence),
        evidence: `JD：${clip(sentence, 80)}`
      }));
    return {
      jobId: job.sourceId || job.url || "",
      roleSummary: clip(sentences.find((sentence) => /负责/.test(sentence)) || sentences[0] || job.title || "", 60),
      realRoleType: "unknown",
      businessScenario: "",
      coreResponsibilities: sentences
        .filter((sentence) => /负责|职责|主要工作/.test(sentence))
        .slice(0, 6)
        .map((sentence) => ({ label: clip(sentence, 24), evidence: `JD：${clip(sentence, 80)}` })),
      coreRequirements,
      preferredRequirements: sentences
        .filter((sentence) => /优先|加分|了解/.test(sentence))
        .slice(0, 6)
        .map((sentence) => ({ label: clip(sentence, 24), evidence: `JD：${clip(sentence, 80)}` })),
      outcomeExpectations: sentences
        .filter((sentence) => /目标|考核|指标|GMV|转化|产出/.test(sentence))
        .slice(0, 4)
        .map((sentence) => ({ label: clip(sentence, 24), evidence: `JD：${clip(sentence, 80)}` })),
      senioritySignal: inferSeniority(text),
      eligibilityConstraints: [],
      hiddenRisks,
      jobQuality: concerns.length ? { level: "caution", concerns } : { level: "normal", concerns: [] },
      isFakeAI: false,
      isTrainingOrSales: false,
      evidenceSnippets: [job.title, ...sentences.slice(0, 3)].filter(Boolean).map((item) => clip(item, 120))
    };
  }

  async matchJob({ candidateProfile = {}, jobUnderstanding = {}, candidateMatchCard = null } = {}) {
    const resumeFacts = collectResumeFacts(candidateProfile, candidateMatchCard);
    const matches = (jobUnderstanding.coreRequirements || []).map((requirement, index) => {
      const label = typeof requirement === "string" ? requirement : requirement.label;
      const hit = findSupportingFact(label, resumeFacts);
      return {
        id: requirement.id || `R${index + 1}`,
        state: hit ? "matched" : "unknown",
        resumeEvidence: hit || ""
      };
    });
    const eligibility = (jobUnderstanding.eligibilityItems || []).map((item, index) => ({
      id: item.id || `E${index + 1}`,
      state: "unknown",
      resumeEvidence: ""
    }));
    return {
      matches,
      eligibility,
      uncertainties: [
        ...matches.filter((item) => item.state === "unknown").map((item) => `${item.id} 缺少候选人直接证据`),
        ...eligibility.map((item) => `${item.id} 资格信息待确认`)
      ].slice(0, 8),
      certainty: matches.length && matches.every((item) => item.state === "matched") && !eligibility.length ? "high" : "low"
    };
  }

  async buildCandidateMatchCard({ candidateProfile = {} } = {}) {
    const candidate = candidateProfile.candidate || {};
    const targetDirections = (candidate.targetTitles || []).map((title) => String(title || "").trim()).filter(Boolean).slice(0, 10);
    const strongEvidence = [];
    for (const experience of (candidateProfile.experiences || []).slice(0, 12)) {
      const label = String(experience?.role || experience?.organization || "").trim();
      const highlights = (experience?.highlights || []).map((item) => String(item || "").trim()).filter(Boolean);
      if (label && highlights.length) strongEvidence.push({ label, evidence: `简历：${highlights.join("；")}` });
    }
    for (const project of (candidateProfile.projects || []).slice(0, 12)) {
      const name = String(project?.name || "").trim();
      if (!name) continue;
      const facts = [...(project?.results || []), ...(project?.canSay || [])].map((item) => String(item || "").trim()).filter(Boolean);
      strongEvidence.push({ label: name, evidence: facts.length ? `简历：${facts.join("；")}` : `简历项目：${name}` });
    }
    const skills = (candidateProfile.skills || []).map((skill) => String(skill?.name || skill || "").trim()).filter(Boolean);
    if (skills.length) strongEvidence.push({ label: "已确认技能", evidence: `简历技能：${skills.join("、")}` });
    // 只从候选人已有事实产生字段；没有可信事实时输出空数组，
    // 不默认添加 Python、RAG、Agent 或后端方向。
    return {
      targetDirections,
      strongEvidence: strongEvidence.slice(0, 12),
      transferableCapabilities: [],
      cautionTransitions: []
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
  const text = `${jobUnderstanding.roleSummary || ""} ${jobUnderstanding.businessScenario || ""} ${(jobUnderstanding.coreRequirements || []).map((item) => item.label || item).join(" ")}`;
  return versions.find((version) => [...(version.keywords || []), ...(version.scenarios || [])].some((word) => sameText(text, word))) || versions[0] || null;
}

function pickProjectNames(projects) {
  return projects.slice(0, 2).map((project) => project.name).filter(Boolean);
}

function jobText(job) {
  return `${job.title || ""} ${(job.tags || []).join(" ")} ${job.description || ""}`;
}

function splitSentences(text) {
  return String(text || "").split(/[。；;！？!?\n]/).map((sentence) => sentence.trim()).filter((sentence) => sentence.length >= 4).slice(0, 24);
}

function clip(value, limit) {
  const text = String(value || "").trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

function collectResumeFacts(candidateProfile = {}, matchingCard = null) {
  const facts = [];
  const push = (value) => {
    const text = String(value || "").trim();
    if (text) facts.push(text);
  };
  for (const skill of candidateProfile.skills || []) {
    const name = typeof skill === "string" ? skill : skill.name;
    push(name && `简历技能：${name}`);
  }
  for (const project of candidateProfile.projects || []) {
    push(project.name && `简历项目：${project.name}`);
    for (const item of project.canSay || []) push(`简历：${item}`);
    for (const item of project.results || []) push(`简历：${item}`);
  }
  for (const experience of candidateProfile.experiences || []) {
    for (const item of experience.highlights || []) push(`简历：${item}`);
  }
  for (const item of candidateProfile.strengths || []) push(`简历：${item}`);
  if (matchingCard) {
    for (const item of matchingCard.strongEvidence || []) push(item.evidence || item.label);
    for (const item of matchingCard.transferableCapabilities || []) push(item.evidence || item.label);
    for (const item of matchingCard.targetDirections || []) push(item);
  }
  return facts;
}

function findSupportingFact(requirement, facts) {
  const latin = (value) => String(value || "").toLowerCase().match(/[a-z][a-z0-9+#.]{1,}/g) || [];
  const bigrams = (value) => {
    const cjk = String(value || "").replace(/[^一-鿿]/g, "");
    const grams = [];
    for (let index = 0; index + 2 <= cjk.length; index += 1) grams.push(cjk.slice(index, index + 2));
    return grams;
  };
  const requirementLatin = latin(requirement);
  const requirementBigrams = bigrams(requirement);
  if (!requirementLatin.length && !requirementBigrams.length) return "";
  for (const fact of facts) {
    const latinHit = requirementLatin.some((token) => latin(fact).includes(token));
    const bigramHit = requirementBigrams.some((gram) => bigrams(fact).includes(gram));
    if (latinHit || bigramHit) return fact;
  }
  return "";
}

function hasAny(text, terms) {
  return terms.some((term) => sameText(text, term));
}

function sameText(text, term) {
  return String(text || "").toLowerCase().includes(String(term || "").toLowerCase());
}

function inferSeniority(text) {
  if (hasAny(text, ["经验不限", "1-3年", "0-3年"])) return "junior";
  if (hasAny(text, ["3-5年"])) return "junior_mid";
  if (hasAny(text, ["5-10年", "专家", "架构"])) return "senior";
  return "unknown";
}

module.exports = { MockModelAdapter };

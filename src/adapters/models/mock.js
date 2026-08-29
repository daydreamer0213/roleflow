const { requirementsForTrack } = require("../../core/model_contract");

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
      .map((sentence) => {
        const indispensable = /必须|熟练|精通|至少|扎实/.test(sentence);
        return {
          label: clip(sentence, 24),
          foundation: indispensable,
          indispensable,
          evidence: `JD：${clip(sentence, 80)}`
        };
      });
    const coreResponsibilities = sentences
      .filter((sentence) => /负责|职责|主要工作/.test(sentence))
      .slice(0, 6)
      .map((sentence) => ({ label: clip(sentence, 24), evidence: `JD：${clip(sentence, 80)}` }));
    const responsibilityEvidence = coreResponsibilities
        .map((item) => `JD：${String(item?.evidence || item?.label || "").replace(/^JD：/, "")}`)
        .filter((item) => item !== "JD：")
        .slice(0, 4);
    const roleSummary = clip(sentences.find((sentence) => /负责/.test(sentence)) || sentences[0] || job.title || "未明确主体工作", 60);
    const directEvidence = responsibilityEvidence.length ? responsibilityEvidence : [`JD：${clip(roleSummary, 80)}`];
    return {
      industryContext: "未明确",
      hiringTracks: [{
        id: "T1",
        label: clip(job.title || roleSummary, 24),
        roleSummary,
        responsibilityEvidence: directEvidence
      }],
      requirements: coreRequirements.map((requirement) => ({ ...requirement, trackIds: ["T1"] })),
      eligibility: [],
      riskSignals: [
        ...concerns.map((concern) => ({ ...concern, severity: "medium", evidence: `JD：${concern.evidence}` })),
        ...hiddenRisks.map((risk) => ({ ...risk, evidence: `JD：${risk.evidence}` }))
      ]
    };
  }

  async matchJob({
    candidateProfile = {},
    resumeVersions = {},
    jobUnderstanding = {},
    candidateMatchCard = null,
    modelRecommendationMode = "shadow"
  } = {}) {
    if (!["off", "shadow"].includes(modelRecommendationMode)) {
      throw new Error("modelRecommendationMode must be off or shadow");
    }
    const versions = Array.isArray(resumeVersions?.versions)
      ? resumeVersions.versions
      : (Array.isArray(resumeVersions) ? resumeVersions : []);
    const version = chooseVersion(versions, jobUnderstanding);
    const resumeFacts = collectResumeFacts(candidateProfile, candidateMatchCard);
    const hiringTracks = jobUnderstanding.hiringTracks?.length ? jobUnderstanding.hiringTracks : [{
      id: "T1",
      label: "默认招聘方向",
      roleSummary: jobUnderstanding.roleSummary || "未明确主体工作",
      responsibilityEvidence: jobUnderstanding.responsibilityEvidence || []
    }];
    const selectedTrack = hiringTracks
      .find((track) => findSupportingFact(
        [track.roleSummary, ...track.responsibilityEvidence].join(" "),
        resumeFacts
      ))
      || hiringTracks[0];
    const requirementMatches = requirementsForTrack({ ...jobUnderstanding, hiringTracks }, selectedTrack.id).map((requirement) => {
      const label = typeof requirement === "string" ? requirement : requirement.label;
      const hit = findSupportingFact(label, resumeFacts);
      return {
        requirement: label,
        state: hit ? "matched" : "unknown",
        foundation: Boolean(requirement.foundation),
        central: typeof requirement.central === "boolean" ? requirement.central : Boolean(requirement.indispensable),
        indispensable: Boolean(requirement.indispensable),
        jdEvidence: String(requirement.evidence || ""),
        resumeEvidence: hit || ""
      };
    });
    const matched = requirementMatches.filter((item) => item.state === "matched");
    const unresolvedCore = requirementMatches.filter((item) => item.state !== "matched" && item.indispensable);
    const jobQuality = jobUnderstanding.jobQuality || { level: "normal", concerns: [] };
    const questions = [
      ...(jobUnderstanding.hiddenRisks || []).map((risk) => risk.evidence).filter(Boolean),
      ...unresolvedCore.map((item) => `核心要求「${item.requirement}」缺少候选人直接证据，待确认`)
    ];
    const sufficient = matched.length > 0 && unresolvedCore.length === 0 && requirementMatches.length > 0;
    const responsibilityEvidence = selectedTrack.responsibilityEvidence || [];
    const roleResumeEvidence = matched.map((item) => item.resumeEvidence).filter((item) => item.startsWith("简历：")).slice(0, 4);
    const roleAlignment = responsibilityEvidence.length && roleResumeEvidence.length ? "partially_aligned" : "insufficient_evidence";
    const roleGaps = roleAlignment === "insufficient_evidence"
      ? [responsibilityEvidence.length ? "离线 Mock 未找到可核对的岗位职责简历事实" : "JD 未提供可核对的具体职责"]
      : [];
    return {
      selectedTrackId: selectedTrack.id,
      roleAlignment,
      roleResumeEvidence,
      roleGaps,
      ...(modelRecommendationMode === "shadow"
        ? { modelRecommendation: sufficient ? "apply" : "caution" }
        : {}),
      recommendation: sufficient ? "apply" : "review",
      fitLevel: sufficient ? "B" : "C",
      confidence: sufficient ? 0.72 : 0.4,
      fitReasons: sufficient
        ? [`核心要求与候选人直接证据对应：${matched.map((item) => item.requirement).slice(0, 3).join("、")}`]
        : [],
      requirementMatches,
      jobQuality,
      hardBlockers: [],
      softGaps: sufficient ? [] : ["JD 或简历缺少可逐条比对的信息，真实语义缺口等待模型 adapter 判断"],
      questionsToVerify: questions,
      recommendedResumeVersion: version?.id || "",
      primaryProjects: version?.primaryProjects || pickProjectNames(candidateProfile.projects || []),
      greetingAngle: version ? `围绕${version.name}切入，先确认岗位真实职责。` : "先确认岗位真实职责，再介绍相关项目。",
      evidence: {
        jd: matched.map((item) => item.jdEvidence).filter(Boolean).slice(0, 3).length
          ? matched.map((item) => item.jdEvidence).filter(Boolean).slice(0, 3)
          : (jobUnderstanding.evidenceSnippets || []).slice(0, 3),
        resume: matched.map((item) => item.resumeEvidence).filter(Boolean).slice(0, 4)
      }
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

  async generateResumeOptimization({ evidenceCatalog = [] } = {}) {
    const resumeEvidence = evidenceCatalog.find((item) => item?.kind === "resume"
      && String(item.text || "").length >= 6
      && !/已隐藏|已遮盖/.test(String(item.text || ""))
      && !/^(个人总结|项目经历|工作经历|技能|教育经历)$/.test(String(item.text || "").trim()));
    if (!resumeEvidence) throw new Error("Mock 定向简历需要至少一条可编辑的简历证据");
    const originalText = String(resumeEvidence.text).trim();
    return {
      headline: "把与目标岗位直接相关的经历放到更清楚的位置",
      suggestions: [{
        id: "S1",
        operation: "replace",
        originalText,
        proposedText: `相关经历：${originalText}`,
        reason: "只调整表达层级，不增加候选人事实",
        evidenceIds: [resumeEvidence.id],
        editingPrinciple: "structure"
      }]
    };
  }

  async generateMockInterviewStep({ context = {}, settings = {}, turns = [] } = {}) {
    const job = context.job || {};
    const resumeEvidence = (Array.isArray(context.resumeEvidenceCatalog) ? context.resumeEvidenceCatalog : [])[0];
    if (!resumeEvidence?.id || !String(resumeEvidence.text || "").trim()) {
      throw new Error("Mock 模拟面试需要至少一条简历证据");
    }
    const resumeEvidenceIds = [String(resumeEvidence.id)];
    const resumeExcerpt = clip(String(resumeEvidence.text).replace(/\s+/g, " "), 42);
    const history = Array.isArray(turns) ? turns : [];
    if (!history.length) {
      const questionText = context.sessionKind === "resume_general" || !context.job
        ? `简历中写到“${resumeExcerpt}”，请介绍这段经历以及你具体做了什么。`
        : `简历中写到“${resumeExcerpt}”，请结合真实经历介绍你为什么适合${job.company ? `${job.company}的` : ""}${job.title || "该岗位"}。`;
      return {
        answerReview: null,
        nextQuestion: {
          text: questionText,
          focus: "intro",
          resumeEvidenceIds,
          basedOnTurnNumber: null,
          answerEvidence: ""
        },
        complete: false
      };
    }
    const last = history[history.length - 1];
    const answer = String(last.answer || "").trim();
    const answerExcerpt = clip(answer.replace(/\s+/g, " "), 36);
    const complete = history.length >= Number(settings.plannedQuestions || 6);
    const focusOrder = ["motivation", "project", "technical", "behavioral", "pressure", "questions"];
    const focus = focusOrder[(history.length - 1) % focusOrder.length];
    return {
      answerReview: {
        conclusion: answer.length >= 30 ? "回答已经覆盖核心信息，可以继续补充个人行动和结果。" : "回答较短，需要补充具体背景、个人行动和结果。",
        strengths: answer ? ["回答与当前问题直接相关"] : [],
        improvements: answer.length >= 30 ? ["进一步明确个人贡献边界"] : ["补充一个真实具体例子"],
        turnNumbers: [Number(last.turnNumber)]
      },
      nextQuestion: complete ? null : {
        text: context.sessionKind === "resume_general" || !context.job
          ? `你刚才提到“${answerExcerpt}”，请结合简历中的“${resumeExcerpt}”继续说明你的个人行动和取舍。`
          : `你刚才提到“${answerExcerpt}”，请结合${job.title || "该岗位"}继续说明你的个人行动和取舍。`,
        focus,
        resumeEvidenceIds,
        basedOnTurnNumber: Number(last.turnNumber),
        answerEvidence: answerExcerpt
      },
      complete
    };
  }

  async reviewMockInterview({ turns = [] } = {}) {
    const history = Array.isArray(turns) ? turns : [];
    const target = history[Math.min(1, Math.max(0, history.length - 1))] || history[0];
    const turnNumber = Number(target?.turnNumber || 1);
    return {
      conclusion: "本轮回答与岗位方向基本相关，下一轮重点把个人行动和结果说得更具体。",
      strengths: ["能够直接回答问题", "表达保持在已有经历范围内"],
      improvements: ["补充个人贡献边界", "用背景、行动、结果组织项目回答"],
      followUpRisks: [{ turnNumber, reason: "回答中的个人行动仍可能被继续追问" }],
      retryRecommendations: [{ turnNumber, reason: "优先重练这题并补充具体行动与结果" }],
      answerStructures: [{ turnNumber, outline: ["说明背景", "说明个人行动", "说明结果和复盘"] }]
    };
  }

  async reviewMockInterviewRetry({ turn = {} } = {}) {
    const retryAnswer = String(turn.retryAnswer || "").trim();
    const originalAnswer = String(turn.originalAnswer || "").trim();
    const improved = retryAnswer.length > originalAnswer.length;
    return {
      turnNumber: Number(turn.turnNumber),
      conclusion: improved ? "重答补充了更多可复盘信息。" : "重答已经保存，但还需要补充更具体的个人行动。",
      improved,
      strengths: improved ? ["比原回答更完整"] : ["保持了回答主题一致"],
      remainingImprovements: ["继续明确个人行动和可验证结果"]
    };
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

MockModelAdapter.prototype.draftMessageGroup = async function draftMessageGroup({
  profile,
  job,
  messages = [],
  facts = [],
  answerMemories = []
} = {}) {
  const text = messages.map((message) => String(message.text || "")).join(" ");
  const descriptiveInterviewContext = /(?:线上面试|面试).{0,12}(?:能力|功能|系统|平台|管理|项目)/i.test(text);
  const interviewInvitation = /邀请(?:您|你)?.{0,12}(?:参加|进行)?.{0,4}面试/i.test(text)
    || /请问(?:您|你)?方便参加面试/i.test(text)
    || /(?:为您|为你|给您|给你)安排.{0,12}面试/i.test(text);
  const interestCheck = /(?:是否|有没有|有无).{0,8}(?:意向|兴趣)/i.test(text)
    || /(?:方便|愿意).{0,8}(?:了解|沟通|聊)/i.test(text);
  const informationUpdate = descriptiveInterviewContext
    || /(?:补充|介绍|说明).{0,12}(?:岗位|公司|流程|安排|信息)/i.test(text);
  const informationRequest = /[?？]|请|请问|能否|是否|什么|怎么|哪|多少|提供|补充说明/i.test(text);
  const messageIntent = interviewInvitation
    ? "interview_invitation"
    : interestCheck
      ? "interest_check"
      : informationUpdate
        ? "information_update"
        : informationRequest
          ? "information_request"
          : "general_communication";
  const messageCategory = descriptiveInterviewContext
    ? "other"
    : /身份证|证件|隐私|账号|账户|家庭|婚育|住址|private|identity card/i.test(text)
      ? "sensitive"
      : /哪个岗位|什么岗位|哪个职位|什么职位|岗位不清楚|identity uncertain/i.test(text)
        ? "identity_uncertain"
        : /薪资|salary|期望/i.test(text)
          ? "salary"
          : /到岗|入职|什么时候|availability/i.test(text)
            ? "availability"
            : /项目|经历|职责|负责/i.test(text)
              ? "project_fact"
              : /资格|学历|经验|技能|技术/i.test(text)
                ? "qualification"
                : "other";
  const factMap = new Map((facts || []).map((fact) => [String(fact.key || ""), fact]));
  const required = messageIntent === "information_request" && messageCategory === "availability"
    ? ["employment_status", "availability_date"]
    : [];
  const missing = required.find((key) => !factMap.has(key));
  const topicSummary = {
    project_fact: "对方正在确认候选人的项目经历。",
    qualification: "对方正在确认候选人的任职资格。",
    salary: "对方正在沟通薪资信息。",
    availability: "对方正在确认候选人的到岗时间。",
    sensitive: "对方正在询问敏感个人信息。",
    other: "对方正在沟通当前岗位或项目情况。",
    identity_uncertain: "当前消息对应的岗位身份仍不明确。"
  }[messageCategory];
  const messageSummary = {
    interview_invitation: "对方正式邀请候选人参加面试。",
    interest_check: "对方正在询问候选人是否愿意了解或继续沟通该岗位。",
    information_request: topicSummary,
    information_update: "对方正在补充当前岗位、项目或流程信息。",
    general_communication: "对方正在进行普通沟通。"
  }[messageIntent];
  const manualOnly = ["salary", "sensitive", "identity_uncertain"].includes(messageCategory);
  const matchingMemory = (answerMemories || []).find((memory) =>
    Number.isSafeInteger(Number(memory?.id))
    && String(memory?.finalAnswer || "").trim()
    && (!memory.messageCategory || memory.messageCategory === messageCategory)
    && (!memory.messageIntent || memory.messageIntent === messageIntent));
  return {
    messageIntent,
    messageCategory,
    messageSummary,
    requiredFactKeys: required,
    usedFactKeys: required.filter((key) => factMap.has(key)),
    usedMemoryIds: matchingMemory ? [Number(matchingMemory.id)] : [],
    responseItems: required.map((id) => ({ id, kind: "question", required: true })),
    coverage: required.map((id) => ({ responseItemId: id, covered: factMap.has(id) })),
    missingFact: missing ? { key: missing, question: "请确认到岗相关事实" } : null,
    messages: manualOnly || missing ? [] : [matchingMemory?.finalAnswer || "mock message reply draft"],
    progressUpdate: {
      stage: manualOnly || missing ? "needs_user_action" : "reply_ready",
      nextAction: "ignored provider text"
    }
  };
};

MockModelAdapter.prototype.extractReplyEditFacts = async function extractReplyEditFacts({
  changedText = "",
  scope = { kind: "global", key: "" }
} = {}) {
  const text = String(changedText || "");
  const facts = [];
  addMockReplyFact(facts, text, "employment_status", [
    [/已经离职|已离职/, "已离职"],
    [/目前在职|仍在职|在职/, "在职"]
  ]);
  addMockReplyFact(facts, text, "availability_date", [
    [/(下周)(?=可以?到岗|到岗)/, "下周"],
    [/(两周后)(?=可以?到岗|到岗)/, "两周后"],
    [/(一个月内)(?=可以?到岗|到岗)/, "一个月内"]
  ]);
  const city = text.match(/(?:常住|目前在|当前在)([\u4e00-\u9fff]{2,6})(?=[，,。；;]|$)/);
  if (city) facts.push({ factKey: "current_city", factValue: city[1], evidenceText: city[0] });
  const salary = text.match(/期望薪资\s*([0-9]+(?:\.[0-9]+)?(?:[kK]|万)?(?:\s*[-~到]\s*[0-9]+(?:\.[0-9]+)?(?:[kK]|万)?)?)/);
  if (salary) facts.push({ factKey: "expected_salary", factValue: salary[1].replace(/\s+/g, ""), evidenceText: salary[0] });
  addMockReplyFact(facts, text, "accepts_travel", [
    [/不接受(?:短期)?出差/, "不接受出差"],
    [/(?:可以)?接受短期出差/, "接受短期出差"]
  ]);
  addMockReplyFact(facts, text, "accepts_relocation", [
    [/不接受异地(?:工作)?|不接受搬迁/, "不接受"],
    [/(?:可以)?接受异地|(?:可以)?接受搬迁/, "接受"]
  ]);
  addMockReplyFact(facts, text, "accepts_overtime", [
    [/不接受加班/, "不接受"],
    [/(?:可以)?接受加班/, "接受"]
  ]);
  return {
    scope: normalizeMockReplyScope(scope),
    facts
  };
};

function addMockReplyFact(facts, text, factKey, patterns) {
  for (const [pattern, factValue] of patterns) {
    const match = String(text || "").match(pattern);
    if (!match) continue;
    facts.push({ factKey, factValue, evidenceText: match[0] });
    return;
  }
}

function normalizeMockReplyScope(value) {
  const scope = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const kind = ["global", "job", "company", "experience"].includes(scope.kind) ? scope.kind : "global";
  return { kind, key: String(scope.key || "").trim().slice(0, 160) };
}

module.exports = { MockModelAdapter };

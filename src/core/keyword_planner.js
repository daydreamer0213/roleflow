function buildKeywordPlan(profile, resumeVersions, keywordConfig) {
  const versions = resumeVersions?.versions || [];
  const avoidTerms = profile?.constraints?.avoidRoles || [];
  const plan = [];
  const seen = new Set();

  for (const version of versions) {
    for (const scenario of version.scenarios || []) {
      add(plan, seen, {
        word: scenario,
        priority: priorityForScenario(scenario),
        reason: `${version.name}: ${version.summary}`,
        resumeVersion: version.id,
        scenario,
        avoidTerms
      });
    }
    for (const word of version.keywords || []) {
      add(plan, seen, {
        word,
        priority: priorityForSkill(word),
        reason: `${version.name}: 命中简历关键词`,
        resumeVersion: version.id,
        scenario: (version.scenarios || [])[0] || "通用",
        avoidTerms
      });
    }
  }

  for (const item of keywordConfig?.keywords || []) {
    add(plan, seen, {
      word: item.word,
      priority: item.source === "tool" ? "C" : "B",
      reason: "configs/keywords.yaml 兼容关键词",
      resumeVersion: guessResumeVersion(item.word, versions),
      scenario: "兼容旧扫描",
      avoidTerms
    });
  }

  return plan.sort(comparePlanItems);
}

function resolvePlannedKeywords(args, configs) {
  const raw = args.keywords || args.keyword;
  if (raw) {
    const keywords = splitList(raw);
    return {
      keywords,
      keywordPlan: keywords.map((word) => ({
        word,
        priority: "A",
        reason: "CLI 手动指定，覆盖 planner",
        resumeVersion: "",
        scenario: "manual",
        avoidTerms: []
      })),
      source: "manual"
    };
  }

  const keywordPlan = buildKeywordPlan(configs.candidateProfile, configs.resumeVersions, configs.keywords);
  const keywords = keywordPlan.map((item) => item.word);
  if (keywords.length) return { keywords, keywordPlan, source: "profile-planner" };

  return {
    keywords: (configs.keywords.keywords || []).map((item) => item.word).filter(Boolean),
    keywordPlan: [],
    source: "configs/keywords.yaml"
  };
}

function summarizeResumeVersions(resumeVersions, ids) {
  const wanted = new Set((ids || []).filter(Boolean));
  return (resumeVersions?.versions || [])
    .filter((version) => !wanted.size || wanted.has(version.id))
    .map((version) => ({
      id: version.id,
      name: version.name,
      summary: version.summary,
      primaryProjects: version.primaryProjects || []
    }));
}

function add(plan, seen, item) {
  const word = String(item.word || "").trim();
  if (!word || seen.has(word.toLowerCase())) return;
  seen.add(word.toLowerCase());
  plan.push({ ...item, word });
}

function splitList(value) {
  return String(value || "")
    .split(/[,，、\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function priorityForScenario(scenario) {
  return /AI应用|RAG|Agent|Python后端/.test(scenario) ? "A" : "B";
}

function priorityForSkill(word) {
  return /RAG|Agent|FastAPI|Python|知识库/.test(word) ? "A" : "C";
}

function guessResumeVersion(word, versions) {
  const text = String(word || "").toLowerCase();
  const hit = versions.find((version) =>
    (version.keywords || []).some((keyword) => text.includes(String(keyword).toLowerCase()))
    || (version.scenarios || []).some((scenario) => text.includes(String(scenario).toLowerCase()))
  );
  return hit?.id || "";
}

function comparePlanItems(a, b) {
  return rank(a.priority) - rank(b.priority)
    || String(a.word).localeCompare(String(b.word), "zh-CN");
}

function rank(priority) {
  return { A: 0, B: 1, C: 2 }[priority] ?? 9;
}

module.exports = { buildKeywordPlan, resolvePlannedKeywords, summarizeResumeVersions, splitList };

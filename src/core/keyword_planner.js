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

function resolvePlannedKeywords(args, configs, feedbackSummary = null) {
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

  const keywordPlan = adjustKeywordPlanWithFeedback(
    buildKeywordPlan(configs.candidateProfile, configs.resumeVersions, configs.keywords),
    feedbackSummary
  );
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
    || (a.feedbackPenalty || 0) - (b.feedbackPenalty || 0)
    || String(a.word).localeCompare(String(b.word), "zh-CN");
}

function rank(priority) {
  return { A: 0, B: 1, C: 2 }[priority] ?? 9;
}

function adjustKeywordPlanWithFeedback(plan, feedbackSummary) {
  if (!feedbackSummary) return plan;
  return plan.map((item) => {
    const stats = feedbackSummary.keywords?.[item.word];
    if (!stats) return item;
    if ((stats.invalid || 0) + (stats.salary_mismatch || 0) >= 2 && (stats.interview || 0) === 0) {
      return {
        ...item,
        priority: demotePriority(item.priority),
        feedbackPenalty: 10,
        feedbackNote: `历史无效或薪资不匹配 ${(stats.invalid || 0) + (stats.salary_mismatch || 0)} 次，暂时降权`
      };
    }
    if (stats.skipped >= 3 && stats.applied === 0) {
      return {
        ...item,
        priority: demotePriority(item.priority),
        feedbackPenalty: 8,
        feedbackNote: `历史跳过 ${stats.skipped} 次，暂时降权`
      };
    }
    if ((stats.interview || 0) >= 1) {
      return {
        ...item,
        feedbackPenalty: -6,
        feedbackNote: `历史获得约面 ${stats.interview} 次，优先保留`
      };
    }
    if (stats.applied >= 2 && stats.skipped === 0) {
      return {
        ...item,
        feedbackPenalty: -3,
        feedbackNote: `历史投递 ${stats.applied} 次，优先保留`
      };
    }
    return item;
  }).sort(comparePlanItems);
}

function demotePriority(priority) {
  if (priority === "A") return "B";
  if (priority === "B") return "C";
  return priority || "C";
}

module.exports = { buildKeywordPlan, resolvePlannedKeywords, summarizeResumeVersions, splitList, adjustKeywordPlanWithFeedback };

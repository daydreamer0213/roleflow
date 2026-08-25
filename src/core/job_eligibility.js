const SOFT_QUALIFIER = /优先|加分|可接受|接受|欢迎|亦可|均可|不限|无硬性要求/;
const EXCLUSIVE_QUALIFIER = /仅限|只招|仅招|限定|仅面向|只接受|仅接受|必须|须为|需为|要求为/;

function evaluateJobEligibility(job = {}, {
  candidateProfile = {},
  targetJobTypes = ["全职"]
} = {}) {
  const jobEvidence = [];
  const candidateEvidence = [];
  const qualityTags = [];
  const risks = [];
  const targetAcceptsInternship = targetJobTypes.some((item) => /实习|intern/i.test(String(item || "")));
  const employment = employmentTypeOf(job);
  jobEvidence.push(...employment.evidence);

  let reasonCode = "";
  let status = "eligible";
  if (employment.type === "internship" && !targetAcceptsInternship) {
    status = "blocked";
    reasonCode = "internship_role";
    qualityTags.push(reasonCode);
    risks.push("岗位明确为实习性质，不符合当前全职目标");
  }

  const candidate = candidateEducationFacts(candidateProfile);
  const cohort = requiredCohortConstraint(job.description);
  if (cohort) {
    jobEvidence.push(cohort.evidence);
    if (!candidate.graduationYears.length) {
      if (status !== "blocked") {
        status = "review";
        reasonCode = "eligibility_review";
        qualityTags.push("eligibility_review");
        risks.push("岗位有明确届别要求，候选人毕业年份待确认");
      }
    } else if (!candidate.graduationYears.some((year) => matchesCohort(cohort, year))) {
      status = "blocked";
      if (!reasonCode) reasonCode = "cohort_mismatch";
      qualityTags.push("cohort_mismatch");
      risks.push(`岗位要求 ${cohortLabel(cohort)}，候选人毕业年份不符合`);
      candidateEvidence.push(`毕业年份：${candidate.graduationYears.join("、")}`);
    } else {
      candidateEvidence.push(`毕业年份：${candidate.graduationYears.join("、")}`);
    }
  }

  const studentClause = requiredStudentClause(job.description);
  if (studentClause) {
    jobEvidence.push(studentClause);
    if (candidate.inSchool) {
      candidateEvidence.push("教育状态：在读/在校");
    } else if (candidate.graduated) {
      status = "blocked";
      if (!reasonCode) reasonCode = "student_status_mismatch";
      qualityTags.push("student_status_mismatch");
      risks.push("岗位仅面向在校生，候选人材料显示已毕业");
      candidateEvidence.push("教育状态：已毕业");
    } else if (status !== "blocked") {
      status = "review";
      reasonCode = "eligibility_review";
      qualityTags.push("eligibility_review");
      risks.push("岗位仅面向在校生，候选人在校状态待确认");
    }
  }

  return {
    status,
    employmentType: employment.type,
    reasonCode,
    qualityTags: unique(qualityTags),
    risks: unique(risks),
    evidence: {
      job: evidenceSnippets(jobEvidence),
      candidate: evidenceSnippets(candidateEvidence)
    }
  };
}

function employmentTypeOf(job) {
  const title = normalized(job.title);
  const structured = normalized([
    job.jobType,
    job.employmentType,
    job.workType,
    ...(Array.isArray(job.tags) ? job.tags : [])
  ].filter(Boolean).join(" "));
  const description = normalized(job.description);
  const combined = `${title} ${structured} ${description}`;
  const mixed = combined.match(/(?:全职|社招).{0,10}(?:或|\/|、|均可|皆可).{0,10}实习(?:生)?|实习(?:生)?.{0,10}(?:或|\/|、|均可|皆可).{0,10}(?:全职|社招)|(?:可接受|欢迎)实习生/);
  if (mixed) return { type: "mixed", evidence: [mixed[0]] };

  const metadata = `${title} ${structured}`;
  const metadataInternship = /实习经验|实习经历/.test(metadata)
    ? null
    : metadata.match(/实习生?|intern(?:ship)?/i);
  const descriptionInternship = internshipDescriptionEvidence(description);
  const internship = metadataInternship?.[0]?.trim() || descriptionInternship;
  if (internship) return { type: "internship", evidence: [internship] };

  const fullTime = combined.match(/全职(?:岗位|职位)?|社会招聘|社招岗位/);
  return fullTime
    ? { type: "full_time", evidence: [fullTime[0]] }
    : { type: "unknown", evidence: [] };
}

function internshipDescriptionEvidence(description) {
  for (const clause of semanticClauses(description)) {
    if (/实习经验|实习经历/.test(clause)
      && !/实习(?:周期|时长)|实习生(?:岗位|职位)|(?:岗位|职位).{0,12}实习生/.test(clause)) {
      continue;
    }
    const match = clause.match(/实习(?:周期|时长).{0,32}(?:月|周|天)|实习生(?:岗位|职位)|(?:岗位|职位|招聘|招募|面向).{0,12}实习生|实习生.{0,12}(?:招聘|招募)/);
    if (match) return clause;
  }
  return "";
}

function requiredCohortConstraint(description) {
  for (const clause of semanticClauses(description)) {
    if (!/届/.test(clause) || isSoftQualification(clause)) continue;
    const range = clause.match(/((?:20)?\d{2})\s*[-至到~～]\s*((?:20)?\d{2})\s*届/);
    if (range) {
      const minimum = normalizedYear(range[1]);
      const maximum = normalizedYear(range[2]);
      if (validYear(minimum) && validYear(maximum) && maximum >= minimum && maximum - minimum <= 10) {
        return { years: [], minimum, maximum, evidence: clause };
      }
    }
    const list = clause.match(/((?:(?:20)?\d{2}\s*(?:、|\/|或|,|，)\s*)+(?:20)?\d{2})\s*届/);
    if (list) {
      const years = yearsFrom(list[1]);
      if (years.length) return { years, minimum: 0, maximum: 0, evidence: clause };
    }
    const single = clause.match(/((?:20)?\d{2})\s*届/);
    if (single) {
      const year = normalizedYear(single[1]);
      if (validYear(year)) return { years: [year], minimum: 0, maximum: 0, evidence: clause };
    }
  }
  return null;
}

function requiredStudentClause(description) {
  return semanticClauses(description).find((clause) => {
    if (!/(?:在校生|在校学生|在读学生)/.test(clause)) return false;
    if (/不(?:要求|需要|限).{0,8}(?:在校|在读)|无需.{0,8}(?:在校|在读)|非在校/.test(clause)) return false;
    const requiresStudent = EXCLUSIVE_QUALIFIER.test(clause) || /面向.{0,8}(?:在校生|在校学生|在读学生)/.test(clause);
    return requiresStudent && !isSoftQualification(clause);
  }) || "";
}

function candidateEducationFacts(candidateProfile) {
  const education = Array.isArray(candidateProfile?.education) ? candidateProfile.education : [];
  const graduationYears = [];
  let graduated = false;
  let inSchool = false;
  for (const item of education) {
    if (!item || typeof item !== "object") continue;
    const end = normalized(item.endDate || item.end || item.graduationYear);
    const year = Number(end.match(/(?:19|20)\d{2}/)?.[0] || 0);
    if (validYear(year)) graduationYears.push(year);
    const status = normalized(item.status || item.graduationStatus);
    if (/已毕业|已经毕业|毕业完成|completed|graduated/i.test(status)) graduated = true;
    if (/在读|在校|就读中|预计毕业|studying|enrolled/i.test(status)) inSchool = true;
  }
  return { graduationYears: unique(graduationYears).sort(), graduated, inSchool };
}

function matchesCohort(constraint, year) {
  if (constraint.years.length) return constraint.years.includes(year);
  return year >= constraint.minimum && year <= constraint.maximum;
}

function cohortLabel(constraint) {
  if (constraint.years.length) return `${constraint.years.join("/")} 届`;
  return `${constraint.minimum}-${constraint.maximum} 届`;
}

function semanticClauses(value) {
  return normalized(value)
    .split(/[。；;\n，,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isSoftQualification(value) {
  const clause = String(value || "");
  return SOFT_QUALIFIER.test(clause) && !EXCLUSIVE_QUALIFIER.test(clause);
}

function yearsFrom(value) {
  return unique([...String(value || "").matchAll(/(?:20)?\d{2}/g)]
    .map((match) => normalizedYear(match[0]))
    .filter(validYear)).sort();
}

function normalizedYear(value) {
  const text = String(value || "");
  return Number(text.length === 2 ? `20${text}` : text);
}

function validYear(value) {
  return Number.isInteger(value) && value >= 1990 && value <= 2100;
}

function evidenceSnippets(values) {
  return unique(values.map((item) => normalized(item).slice(0, 160)));
}

function normalized(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

module.exports = { evaluateJobEligibility };

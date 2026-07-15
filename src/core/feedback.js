const FEEDBACK_REASON_OPTIONS = [
  { code: "direction_mismatch", label: "岗位方向不匹配" },
  { code: "salary_mismatch", label: "薪资不合适" },
  { code: "experience_mismatch", label: "年限/经验不合适" },
  { code: "company_mismatch", label: "公司不合适" },
  { code: "work_schedule", label: "工作制不合适" },
  { code: "location_mismatch", label: "地点不合适" },
  { code: "outsource_risk", label: "外包/驻场风险" },
  { code: "inactive", label: "招聘方不活跃" },
  { code: "other", label: "其他" }
];

const LEGACY_REASON_CODES = {
  salary: "salary_mismatch",
  experience: "experience_mismatch",
  location: "location_mismatch",
  outsource: "outsource_risk"
};

const NEGATIVE_FEEDBACK_STATUSES = new Set(["skipped", "invalid", "salary_mismatch"]);
const VALID_REASON_CODES = new Set(FEEDBACK_REASON_OPTIONS.map((item) => item.code));

function normalizeFeedbackReason(value, status = "") {
  const raw = String(value || "").trim();
  const code = LEGACY_REASON_CODES[raw] || raw;
  if (code && VALID_REASON_CODES.has(code)) return code;
  if (!code && status === "salary_mismatch") return "salary_mismatch";
  return "";
}

function feedbackReasonLabel(value) {
  const code = normalizeFeedbackReason(value);
  return FEEDBACK_REASON_OPTIONS.find((item) => item.code === code)?.label || "未填写";
}

module.exports = {
  FEEDBACK_REASON_OPTIONS,
  NEGATIVE_FEEDBACK_STATUSES,
  normalizeFeedbackReason,
  feedbackReasonLabel
};

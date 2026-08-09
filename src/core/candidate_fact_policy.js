const VOLATILE_FACT_MAX_AGE_DAYS = Object.freeze({
  employment_status: 7,
  availability_date: 7,
  current_city: 30,
  expected_salary: 30,
  accepts_travel: 90,
  accepts_relocation: 90,
  accepts_overtime: 90
});

const STABLE_FACT_PREFIXES = Object.freeze([
  "gap.",
  "leaving_reason.",
  "short_project."
]);

function factStatus(now, fact = {}) {
  const key = String(fact.key || "").trim();
  const confirmedAt = String(fact.updatedAt || fact.confirmedAt || "").trim();
  if (!key) return { status: "invalid", confirmedAt };
  if (STABLE_FACT_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return { status: "valid", confirmedAt };
  }
  const maxAgeDays = VOLATILE_FACT_MAX_AGE_DAYS[key];
  if (maxAgeDays === undefined) return { status: "requires_confirmation", confirmedAt };
  const confirmedMs = Date.parse(confirmedAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(confirmedMs)) return { status: "expired", maxAgeDays, confirmedAt };
  const ageDays = (Number.isFinite(nowMs) ? nowMs : Date.now()) - confirmedMs;
  const status = ageDays / 86_400_000 <= maxAgeDays ? "valid" : "expired";
  return { status, maxAgeDays, confirmedAt };
}

module.exports = {
  VOLATILE_FACT_MAX_AGE_DAYS,
  STABLE_FACT_PREFIXES,
  factStatus
};

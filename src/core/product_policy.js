const PRODUCT_POLICY_VERSION = "2026-07-16.3";
const MIN_CARDS_PER_TARGET = 10;

const PRODUCT_POLICY = Object.freeze({
  searchPlan: Object.freeze({
    defaultExperience: Object.freeze(["经验不限", "0-3年", "1-3年"]),
    experienceOptions: Object.freeze(["经验不限", "0-1年", "0-3年", "1-3年", "2-3年", "3-5年（可冲）"]),
    defaultJobTypes: Object.freeze(["全职"]),
    jobTypeOptions: Object.freeze(["全职", "兼职", "实习"]),
    degreeOptions: Object.freeze(["初中及以下", "中专/中技", "高中", "大专", "本科", "硕士", "博士"]),
    defaultBossActiveDays: 3,
    allowedBossActiveDays: Object.freeze([3]),
    defaultSalaryMode: "wide",
    defaultWorkSchedulePreference: "prefer_double_weekend",
    priorityCardRatios: Object.freeze({ A: 1, B: 0.65, C: 0.4 }),
    minCardsPerTarget: MIN_CARDS_PER_TARGET,
    broadScanDefaults: Object.freeze({ maxCards: 60, maxDetailTotal: 300, browserPageBudget: 90 }),
    scanBounds: Object.freeze({
      maxCards: Object.freeze([MIN_CARDS_PER_TARGET, 200]),
      maxDetailTotal: Object.freeze([1, 1000]),
      browserPageBudget: Object.freeze([20, 300])
    }),
    highCardWarning: 120
  }),
  dailyScan: Object.freeze({
    priorities: Object.freeze(["A", "B"]),
    maxCards: 50,
    maxDetailTotal: 220,
    browserPageBudget: 40,
    detailLimits: Object.freeze({ A: 40, B: 30 }),
    salaryLaneLimit: 1
  }),
  operations: Object.freeze({
    detailCacheMaxAgeDays: 3,
    scanHeartbeatMs: 60_000,
    scanLeaseTtlMs: 10 * 60_000,
    scanLeaseMinTtlMs: 60_000,
    scanOrphanTimeoutMs: 120_000,
    refreshLimit: 8,
    activityRefreshDays: 3
  }),
  matching: Object.freeze({
    salaryHardMaxMarginK: 12
  })
});

module.exports = { PRODUCT_POLICY_VERSION, PRODUCT_POLICY };

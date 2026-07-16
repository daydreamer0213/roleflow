const PRODUCT_POLICY_VERSION = "2026-07-16.1";

const PRODUCT_POLICY = Object.freeze({
  searchPlan: Object.freeze({
    defaultExperience: Object.freeze(["经验不限", "0-3年", "1-3年"]),
    experienceOptions: Object.freeze(["经验不限", "0-1年", "0-3年", "1-3年", "2-3年", "3-5年（可冲）"]),
    defaultJobTypes: Object.freeze(["全职"]),
    jobTypeOptions: Object.freeze(["全职", "兼职", "实习"]),
    degreeOptions: Object.freeze(["初中及以下", "中专/中技", "高中", "大专", "本科", "硕士", "博士"]),
    defaultBossActiveDays: 3,
    allowedBossActiveDays: Object.freeze([1, 3, 7]),
    defaultSalaryMode: "wide",
    defaultWorkSchedulePreference: "prefer_double_weekend",
    broadScanDefaults: Object.freeze({ maxCards: 60, maxDetailTotal: 300, browserPageBudget: 90 }),
    scanBounds: Object.freeze({
      maxCards: Object.freeze([10, 200]),
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
    refreshLimit: 8,
    activityRefreshDays: 3
  }),
  matching: Object.freeze({
    salaryHardMaxMarginK: 12
  })
});

module.exports = { PRODUCT_POLICY_VERSION, PRODUCT_POLICY };

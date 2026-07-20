const PRODUCT_POLICY_VERSION = "2026-07-20.1";
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
    maxDetailTotal: 240,
    browserPageBudget: 40,
    detailLimits: Object.freeze({ A: 45, B: 30 }),
    salaryLaneLimit: 1
  }),
  operations: Object.freeze({
    detailCacheMaxAgeDays: 3,
    scanHeartbeatMs: 60_000,
    scanLeaseTtlMs: 10 * 60_000,
    scanLeaseMinTtlMs: 60_000,
    scanOrphanTimeoutMs: 120_000,
    refreshLimit: 8,
    activityRefreshDays: 3,
    bossPacing: Object.freeze({
      delayMs: Object.freeze({
        catalog: Object.freeze([1500, 2500]),
        list: Object.freeze([2500, 4000]),
        detail: Object.freeze([3000, 5000]),
        retry: Object.freeze([400, 800]),
        scroll: Object.freeze([2500, 4000]),
        card: Object.freeze([3000, 5000]),
        card_retry: Object.freeze([300, 700]),
        list_ready: Object.freeze([450, 750]),
        refresh: Object.freeze([3000, 5000]),
        target: Object.freeze([20000, 40000])
      }),
      periodicEvery: Object.freeze([18, 26]),
      periodicDelayMs: Object.freeze([4000, 7000]),
      detail: Object.freeze({
        microEvery: Object.freeze([6, 8]),
        microDelayMs: Object.freeze([15000, 25000]),
        macroEvery: Object.freeze([16, 20]),
        macroDelayMs: Object.freeze([90000, 150000])
      })
    }),
    bossAccessBudget: Object.freeze({
      recoveryHours: 48,
      waitJitterMs: Object.freeze([1000, 3000]),
      windowsMs: Object.freeze({
        "10m": 10 * 60_000,
        "30m": 30 * 60_000,
        "1h": 60 * 60_000,
        "24h": 24 * 60 * 60_000
      }),
      modes: Object.freeze({
        recovery: Object.freeze({
          pane_detail_read: Object.freeze({ "10m": 20, "1h": 80, "24h": 120 }),
          detail_open: Object.freeze({ "10m": 5, "1h": 15, "24h": 30 }),
          communication_visit: Object.freeze({ "10m": 30, "30m": 60, "24h": 150 }),
          list_navigation: Object.freeze({ "24h": 8 }),
          list_scroll: Object.freeze({ "24h": 60 })
        }),
        normal: Object.freeze({
          pane_detail_read: Object.freeze({ "10m": 45, "1h": 240, "24h": 280 }),
          detail_open: Object.freeze({ "10m": 8, "1h": 25, "24h": 60 }),
          communication_visit: Object.freeze({ "10m": 30, "30m": 60, "24h": 150 }),
          list_navigation: Object.freeze({ "24h": 10 }),
          list_scroll: Object.freeze({ "24h": 80 })
        })
      })
    }),
    bossCommunication: Object.freeze({
      calibration: Object.freeze({
        status: "pending",
        executionEnabled: false
      }),
      delayMs: Object.freeze([15000, 20000]),
      limits: Object.freeze({ "10m": 30, "30m": 60, "24h": 150 }),
      combinedUsage: Object.freeze({
        "10m": Object.freeze(["detail_open", "communication_visit"]),
        "30m": Object.freeze(["detail_open", "communication_visit"]),
        "24h": Object.freeze(["communication_visit"])
      })
    })
  }),
  matching: Object.freeze({
    salaryHardMaxMarginK: 12
  })
});

module.exports = { PRODUCT_POLICY_VERSION, PRODUCT_POLICY };

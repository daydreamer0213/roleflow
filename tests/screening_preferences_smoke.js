const assert = require('node:assert/strict');
const { evaluateJobEligibility } = require('../src/core/job_eligibility');
const { normalizeSearchPlan } = require('../src/core/profile_schema');
const { recommendPlanForProfile } = require('../src/core/profile_onboarding');
const { profileToRuntimeConfigs, resolveScanPolicy } = require('../src/core/search_plan');
const { resolveNativeFilterSnapshot } = require('../src/core/platform_filters');
const { applyPlatformRuntimePolicy } = require('../src/core/platform_runtime_policy');
const { scoreJob, decisionState } = require('../src/core/scoring');
const { normalizeBossJob } = require('../src/adapters/sites/boss');
const { applyRuleGuard } = require('../src/core/job_analysis');

const profile = { candidate: { city: '广州', targetTitles: ['运营'], expectedSalary: '9-14K' } };
const base = { profile: {}, scoring: { salary: { preferred_max_k: 24, hard_max_k: 35, experience_flex_max_k: 18 } } };
const job = { title: '内容运营', location: '广州', salary: '10-15K', experience: '1-3年', bossActiveText: '今日活跃', description: '内容运营，负责栏目策划与内容编辑。', tags: [] };
const plan = normalizeSearchPlan({ directions: ['运营'], keywords: ['内容运营', '编辑'] }, profile);
const runtime = (patch = {}) => profileToRuntimeConfigs(base, profile, { ...plan, ...patch });

(async () => {
  for (const evidence of [
    { title: '内容运营（兼职）' },
    { jobType: '兼职' },
    { employmentType: 'part_time' },
    { description: '本岗位为长期兼职，负责内容编辑。' },
    { description: '招聘兼职人员，负责栏目策划与内容编辑。' },
    { salary: '80-150元/时' },
    { salary: '80.5-150元/小时' },
    { salary: '120元／小时' }
  ]) {
    const row = { ...job, ...evidence };
    const scored = scoreJob(row, runtime());
    assert.equal(scored.eligibilityStatus, 'blocked', JSON.stringify(evidence));
    assert.equal(decisionState(scored), 'blocked');
    assert(scored.qualityTags.includes('part_time_role'));
    assert(scored.eligibilityEvidence.job.length > 0);
    const allowed = scoreJob(row, runtime({ allowPartTime: true }));
    assert.equal(allowed.eligibilityStatus, 'eligible');
    assert(!allowed.qualityTags.includes('part_time_role'));
    assert.equal(applyRuleGuard({}, { ...row, ...scored }).recommendation, 'not_recommended');
  }
  for (const evidence of [
    { title: '内容运营（全职/兼职均可）' },
    { title: '内容运营（全职兼职均可）' },
    { description: '本岗位全职、兼职均可，负责编辑。' },
    { description: '本岗位全职兼职均可，负责编辑。' },
    { description: '本岗位不是兼职。' },
    { title: '人事专员', description: '岗位职责：招聘兼职人员并安排班次。' },
    { title: '兼职人员管理专员', description: '全职岗位，负责排班。' },
    { description: '本岗位为全职，不接受兼职。' },
    { description: '负责招聘和管理兼职人员。' },
    { description: '有兼职运营经验优先。' },
    { title: '全职内容运营', salary: '80-150元/小时' },
    { description: '全职岗位，加班费用为80元/小时。' },
    { salary: '300-500元/天' }
  ]) {
    assert.notEqual(evaluateJobEligibility({ ...job, ...evidence }).status, 'blocked', JSON.stringify(evidence));
    const fullTimePlatform = applyPlatformRuntimePolicy(runtime(), { filters: { jobType: { labels: ['全职'] } } });
    assert(!scoreJob({ ...job, ...evidence }, fullTimePlatform).qualityTags.includes('platform_job_type_mismatch'), JSON.stringify(evidence));
  }
  const normalizedHourly = normalizeBossJob({ ...job, salary: '', cardText: '内容运营 80-150元/小时 经验不限', url: 'https://www.zhipin.com/job_detail/hourly-fixture.html' });
  const overtimeOnly = normalizeBossJob({ ...job, salary: '', description: '负责栏目策划与内容编辑，加班费用为80元/小时。', url: 'https://www.zhipin.com/job_detail/overtime-fixture.html' });
  assert.equal(overtimeOnly.salary, '', 'JD overtime pay is not the job salary');
  assert.notEqual(scoreJob(overtimeOnly, runtime()).eligibilityStatus, 'blocked');
  for (const row of [{title:'内容运营实习生',salary:'80元/小时'},{title:'兼职实习生',salary:'300元/天'}]) {
    const result = evaluateJobEligibility(row, {allowPartTime:true});
    assert.equal(result.status, 'blocked', 'accepting part-time must not enable internships');
    assert(result.qualityTags.includes('internship_role'));
    assert(scoreJob({ ...job, ...row }, runtime({ allowPartTime: true })).qualityTags.includes('internship_role'));
  }
  assert.equal(evaluateJobEligibility({title:'兼职实习生'}, {targetJobTypes:['实习']}).status, 'blocked', 'accepting internships must not enable part-time');
  assert.equal(normalizedHourly.salary, '80-150元/小时');
  assert.equal(scoreJob(normalizedHourly, runtime()).eligibilityStatus, 'blocked');
  assert.deepEqual(plan.salary, { minK: 0, maxK: 0 }, 'normalization must not backfill candidate salary');
  const recommended = await recommendPlanForProfile({ modelConfig: { provider: 'mock' }, profile });
  assert.deepEqual(recommended.salary, { minK: 0, maxK: 0 }, 'initial model plan must not choose salary for the user');
  assert.equal(recommended.allowPartTime, false);
  assert.equal(normalizeSearchPlan({ allowPartTime: true }).allowPartTime, true);
  assert.notEqual(resolveScanPolicy(plan).policyHash, resolveScanPolicy({ ...plan, allowPartTime: true }).policyHash);
  for (const acquisitionMode of ['inherited', 'generated']) {
    const enabled = normalizeSearchPlan({ ...plan, acquisitionMode, allowPartTime: true, jobTypes: ['全职'] });
    assert.equal(scoreJob({ ...job, title: '内容运营兼职' }, profileToRuntimeConfigs(base, profile, enabled)).eligibilityStatus, 'eligible');
  }
  const generated = normalizeSearchPlan({ ...plan, acquisitionMode: 'generated', allowPartTime: true, platform: { generated: { jobTypes: ['全职'] } } });
  const snapshot = resolveNativeFilterSnapshot({ plan: generated, catalog: { site: 'boss', fields: { jobType: { urlParam: 'jobType', selection: 'single', options: [{code:'1',label:'全职'},{code:'2',label:'兼职'}] } } } });
  assert.equal(snapshot.params.jobType, undefined, 'single-select platform must not send multiple job type codes or stay full-time only');
  const disabledAgain = normalizeSearchPlan({ ...generated, allowPartTime: false });
  const disabledSnapshot = resolveNativeFilterSnapshot({ plan: disabledAgain, catalog: { site: 'boss', fields: { jobType: { urlParam: 'jobType', selection: 'single', options: [{code:'1',label:'全职'},{code:'2',label:'兼职'}] } } } });
  assert.equal(disabledSnapshot.params.jobType, undefined, 'disabling part-time must not create invalid multi-value single-select parameters');
  for (const allowPartTime of [false, true]) {
    const legacy = normalizeSearchPlan({ acquisitionMode: 'generated', jobTypes: ['兼职'], allowPartTime });
    assert.deepEqual(legacy.platform.generated.jobTypes, ['兼职'], 'explicit old platform scope must not become unrestricted');
  }

  for (const experience of ['1-3年', '3-5年']) {
    const rows = ['8-12K', '30-40K', '60-80K', '面议'].map(salary => scoreJob({ ...job, experience, salary }, runtime()));
    for (const row of rows) {
      assert.equal(row.score, rows[0].score, 'unset salary must not change score');
      assert.equal(row.canStretch, rows[0].canStretch, 'unset salary must not determine experience stretch');
      assert(!row.qualityTags.some(tag => /salary_target_|salary_out_of_range|experience_stretch_low_salary/.test(tag)));
    }
  }
  const cleared = normalizeSearchPlan({ ...plan, salary: {minK:9,maxK:14}, salaryMinK:'', salaryMaxK:'' }, profile);
  assert.deepEqual(cleared.salary, {minK:0,maxK:0});
  const saved = normalizeSearchPlan({ ...plan, salary: {minK:9,maxK:14} }, profile);
  assert.deepEqual(saved.salary, {minK:9,maxK:14});
  assert(scoreJob({...job,salary:'5-8K'},runtime({salary:saved.salary,salaryMode:'strict'})).qualityTags.includes('salary_out_of_range'));
  const lowerOnly = runtime({salary:{minK:9,maxK:0},salaryMode:'strict'});
  assert.equal(scoreJob({...job,salary:'30-40K'},lowerOnly).score, scoreJob({...job,salary:'60-80K'},lowerOnly).score);
  assert(scoreJob({...job,salary:'5-8K'},lowerOnly).qualityTags.includes('salary_out_of_range'));
  const inherited = applyPlatformRuntimePolicy(runtime(), {filters:{salary:{labels:['10-20K'],ranges:[{minK:10,maxK:20}]}}});
  assert(scoreJob({...job,salary:'30-40K'},inherited).qualityTags.includes('platform_salary_mismatch'));
  console.log('screening_preferences_smoke ok');
})().catch(error => { console.error(error); process.exitCode = 1; });

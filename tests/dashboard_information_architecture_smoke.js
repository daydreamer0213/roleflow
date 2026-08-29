const assert = require("node:assert/strict");
const { renderNavigation } = require("../src/dashboard/ui/navigation");

const plan = { todayPath: "/plan?planId=7", planId: 7 };

const workflow = renderNavigation({ ...plan, currentPath: "/workflow?runId=9" });
for (const group of ["工作台", "求职", "沟通", "成长"]) assert.match(workflow, new RegExp(`>${group}<`));
assertCurrent(workflow, "/workflow?runId=9", "发现岗位");

const queue = renderNavigation({ ...plan, currentPath: "/queue?planId=7&pool=primary" });
assertCurrent(queue, "/queue?planId=7&amp;pool=primary", "岗位记录");

const jobs = renderNavigation({ ...plan, currentPath: "/jobs?planId=7&batch=latest" });
assertCurrent(jobs, "/jobs?planId=7&amp;batch=latest", "岗位记录");

const builder = renderNavigation({ ...plan, currentPath: "/communication/new?planId=7" });
assertCurrent(builder, "/communication/new?planId=7", "发送记录");

const messages = renderNavigation({ ...plan, currentPath: "/messages?planId=7" });
assertCurrent(messages, "/messages?planId=7", "消息与回复");
assert.doesNotMatch(messages, />消息发现</);

const resume = renderNavigation({ ...plan, currentPath: "/resume-optimization?planId=7" });
assertCurrent(resume, "/resume-optimization?planId=7", "简历工作室");

const utilities = renderNavigation({ ...plan, currentPath: "/diagnostics" });
assertCurrent(utilities, "/diagnostics", "运行诊断");
assert.match(utilities, />模型与设置</);

console.log("dashboard_information_architecture_smoke ok");

function assertCurrent(markup, href, label) {
  const escapedHref = href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(markup, new RegExp(`<a[^>]*href="${escapedHref}"[^>]*aria-current="page"[^>]*>${label}</a>`));
}

function createGreeting(job, profile) {
  const name = profile.candidate?.name || "候选人";
  const strengths = profile.candidate?.strengths || [];
  const hits = strengths.filter((x) => `${job.title} ${job.description} ${(job.tags || []).join(" ")}`.includes(x));
  const matched = hits.slice(0, 4).join("、") || "AI应用开发";
  return `您好，我是${name}。看到这个岗位主要做${job.title}，我这边和${matched}方向比较匹配，想进一步了解岗位职责和团队情况，方便的话可以沟通一下。`;
}

module.exports = { createGreeting };

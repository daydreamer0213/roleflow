# DeepSeek V4 Flash v4.8 职责发散保护 checkpoint

## 代码状态

- 产品 checkpoint：`9083abb`。
- 决策规则版本：`four-tier-weighted-v4.8`。
- `modelRecommendationMode` 仍为 `shadow`。
- 未加入少样本示例，未改四档二维表，未改变 70/30 权重。

## 本次根因

上一轮完整 20 条中，模型曾识别出岗位质量为 `caution`、原因是
`responsibility_sprawl`，并给出 shadow 建议 `caution`，但本地加权矩阵仍将该岗位
提升为 `apply`。这会让人工标注的不推荐岗位进入默认沟通列表。

## 采用的修正

只有以下三个条件同时成立时，代码才把最终档位封顶为 `caution`：

1. 岗位质量为 `caution`。
2. 质量关注点包含 `responsibility_sprawl`。
3. 模型 shadow 建议为 `caution`。

职责较多但模型没有给出慎投建议的岗位仍沿用原有矩阵结果，避免把所有跨职责岗位
一律降级，也避免针对 IT 岗位增加关键词规则。

## 下一步验收

- 使用全新私有结果目录，不复用上一轮模型缓存。
- 先跑 3 条诊断，确认结构、分档和沟通门禁后再跑完整 20 条。
- 固定验收门禁：主投/可投无遗漏；不推荐不进入默认沟通；慎投混入沟通单独统计。

## 实际验收结果

- Evaluated commit：`9bb986ec3eb68b65fe75bfbcf54586781580b234`。
- Product commit：`9083abbc4bb02118a7c522a6f4de9c3bccb2f553`，是 evaluated commit 的严格祖先。
- 第二次 3 条复现目录：
  `D:\DevData\RoleFlow-private-benchmark\deepseek-v4-flash-nonthinking-v20-sprawl-guard-first-3-v4-retry-v1-20260804`。
- 第二次 3 条结果 SHA-256：`b70ba944a11fbd78495659dadabb4ad195eae41f2c9413d7c528b36fffb57959`。
- 3 条结果：3/3 完成、技术失败 0、空响应 0；主投/可投保留，慎投与不推荐之间 1 条中度偏差，不影响沟通门禁。
- 完整 20 条目录：
  `D:\DevData\RoleFlow-private-benchmark\deepseek-v4-flash-nonthinking-v20-sprawl-guard-first-20-v1-20260804`。
- 完整 20 条结果 SHA-256：`a3d72a7e3dd5b2a0bc4b58b63c7f8fa54be791cc16098672aebad69d08562ac9`。
- 完整结果：20/20 完成、技术失败 0、契约修复 0；主投/可投 10/10 无遗漏；不推荐 0/5 进入默认沟通；慎投进入沟通 3 条，按当前门禁接受。
- 后续测试同步提交：`c76dbf1040c3fc77a42a15369dfdf800ac8126fd`。该提交只同步两个旧版本号测试断言，不改变已验收运行逻辑，也不替代 evaluated commit。

## 保留的波动记录

首次 v4.8 三条诊断目录保留不覆盖：
`D:\DevData\RoleFlow-private-benchmark\deepseek-v4-flash-nonthinking-v20-sprawl-guard-first-3-v4-20260804`。
其中两条出现一次契约修复后仍失败，随后同一 evaluated commit 的全新复现 3/3 成功，故记录为模型结构化输出波动，不据此扩大提示词或修改业务二维表。

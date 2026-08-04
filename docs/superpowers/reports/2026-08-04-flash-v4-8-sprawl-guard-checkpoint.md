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

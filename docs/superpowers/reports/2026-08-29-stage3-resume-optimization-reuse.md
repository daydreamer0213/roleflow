# 阶段三定向简历优化复用评估

日期：2026-08-29  
结论：`reference_only`

## 当前 RoleFlow 已具备

- 本地 SQLite 中的候选人画像、简历原文、简历版本和版本启用状态；
- 完整 JD、岗位分析、岗位方向与阶段二成熟批次诊断；
- 当前有效的候选人事实和用户回答记忆；
- 现有 OpenAI-compatible / DeepSeek 深度分析适配器和离线 Mock；
- 服务端渲染 Dashboard、表单编辑、临时数据库测试和版本绑定漏斗。

因此阶段三真正缺少的是“有来源的修改建议、用户审阅草稿、原子启用新版本”，不是另一套简历平台。

## 外部方案

### Resume Matcher

官方仓库：https://github.com/srbhr/Resume-Matcher

可借鉴：主简历绑定目标 JD、生成针对性内容、允许用户编辑、再导出和准备面试。

不直接接入：当前实现带来 Python/FastAPI、Next.js、TinyDB、Playwright PDF 和第二套模型配置，会重复 RoleFlow 已有存储、前端和模型边界。其总匹配分也不能替代 RoleFlow 已冻结的岗位判定与证据规则。

### Reactive Resume

官方仓库：https://github.com/AmruthPillai/Reactive-Resume

可借鉴：版本化编辑、完整数据所有权，以及 JSON/DOCX/PDF 多格式导出顺序。

不直接接入：它是完整 React/PostgreSQL 简历制作平台，接入成本远高于阶段三首版所需的内容优化。首版继续使用 RoleFlow 结构化版本和可复制文本；Word/PDF 模板另行评估。

## 采用方案

1. 继续使用 RoleFlow 的现有简历版本作为主版本；
2. 为一次优化冻结源简历、目标岗位和证据清单；
3. 模型只返回可核对的修改操作，每项引用证据 ID；
4. 本地规则拒绝不存在的锚点、无来源数字和职责边界夸大；
5. 用户接受、修改或忽略后才生成最终文本；
6. 启用时新建简历版本，绝不覆盖原始版本；
7. 后续求职事件继续由阶段二绑定并比较版本。

不新增依赖，不引入第二套画像、数据库、前端或模型设置。

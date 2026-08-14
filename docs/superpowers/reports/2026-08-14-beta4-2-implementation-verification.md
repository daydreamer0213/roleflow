# RoleFlow beta.4.2 实现验证

## 实现结果

- 模型设置：
  - 共享厂商和 API Key 区域只保留一个“测试连接并保存”按钮。
  - 一次操作按固定顺序验证深度分析和批量筛选；两项都成功后才保存共享密钥、配置和验证状态。
  - 任一验证或本地写入失败时，不留下半套配置或半套验证状态。
  - 两张任务卡只保存各自参数，保存后连接状态回到“未验证”。
  - “下一步：填写简历”始终显示；两项主模型未验证时不可点击，全部验证后才启用。
- 关键词与进度：
  - 本轮页面展示工作流实际冻结的关键词，不再把候选关键词池误报为本轮执行范围。
  - 候选池只显示数量，现有每轮关键词选择策略、完整 JD 覆盖和匹配规则没有改动。
  - “本轮概览”直接显示采集进度和完整 JD 进度，同状态轮询也会刷新这两个字段。
- 自动沟通：
  - 最终页面守卫只核对目标和点击坐标，不再在页面脚本里调用 DOM `.click()`。
  - 每个岗位最多发送一次浏览器级鼠标点击；点击后不会自动重试。
  - Edge 网络日志只记录两个沟通相关接口，并设置条目数、正文数和正文大小上限。
  - 持久化证据只保留接口类别、HTTP 状态、受限业务码、结果类别和耗时；不保留原始 URL、响应正文、请求标识或网络错误原文。
  - 网络请求、页面状态或中间弹层不一致时安全中断，保留后续条目未执行，并向用户显示中文原因和原始技术码。

## 验证证据

- 聚焦测试：
  - 模型设置核心、模型设置页面和新用户引导测试通过。
  - 工作流页面、轮询进度和工作流迁移测试通过。
  - Edge 传输、BOSS 沟通页面、沟通执行器、自动沟通页面和工作流沟通测试通过。
  - BOSS 相关测试全部使用 fake browser，没有访问真实 BOSS。
- 完整离线套件：
  - `npm.cmd test`
  - 结果：`All 97 offline checks passed.`
- 多视口只读验收：
  - 使用临时 SQLite、mock 浏览器就绪状态和无头 Microsoft Edge。
  - 共检查 12 个页面、4 种视口（1440×900、1024×768、768×1024、375×812），生成 48 张截图和 1 份 JSON 清单。
  - 严格门结果：0 个控制台错误、0 个页面错误、0 个失败请求、0 个外部请求、0 个横向溢出。
  - 375×812 比计划中的 390×844 更窄、更矮，用作手机窄屏检查。
  - 截图和清单：`D:\DevData\RoleFlow-beta4-2\verification\ui\`
  - 清单：`D:\DevData\RoleFlow-beta4-2\verification\ui\beta4-2-20260814.json`
- 范围复核：
  - beta.4.2 新增代码没有引入 `search_page_api` 或 `standalone_detail`。
  - `src/adapters/sites/boss.js` 不再包含 `candidates[0].click()`。
  - 未新增第三个 BOSS 标签、窗口或会话，也未改变 `trusted_pane` 主线。
- Git 提交：
  - `cdc003c feat: verify primary model profiles atomically`
  - `8dbac3b feat: streamline primary model setup`
  - `e2f6b0d fix: show actual workflow scope and progress`
  - `80cb599 feat: expose bounded Edge network logging`
  - `395f26a fix: verify BOSS communication dispatch evidence`
  - `61fd362 docs: correct communication acceptance status`

## 明确未执行

- 未抓取新岗位，未运行真实岗位扫描。
- 未恢复、解决、修改或重放当前真实沟通批次 #1。
- 未点击真实“立即沟通”，未发送消息，未申请岗位。
- 未读取或操作真实 BOSS 页面。
- 未启用、校准或验收 `search_page_api`。
- 未启用 `standalone_detail`，未启动 Wave 5。

## 当前结论

- beta.4.2 的实现和离线验证可作为下一轮人工新用户验收候选版本。
- 自动沟通现在具备更可靠的“单次点击 + 网络/页面联合取证 + 结果不明立即停止”机制，但真实派发稳定性仍未完成端到端验收，不能写成线上已修复。

## 下一次人工验收前置条件

- 用户针对一个不可变的单岗位沟通样本再次明确授权后，才允许执行一次真实点击。
- 点击前重新核对固定搜索标签、岗位 ID、标题、公司、按钮状态、登录和风控状态。
- 首次点击后立即核对脱敏网络结果、按钮状态和消息会话；任一证据不一致就停止，不自动重试。

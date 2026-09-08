# 智联真实页面兼容收口

## 目标与已继承决定

继续用户已批准的“普通初次沟通、消息对应完整岗位分析、统一可编辑草稿”验收，不增加平台或流程。主控在 `078b8fc579a50b3f81e1f7cb1528f693867ee7a5` 重新完整验证157/157后，通过真实产品入口复现以下缺陷。离线通过不代表实站通过；原六项综合审查和上一项轮次来源修复已关闭，不重开全分支审查。

## Global Constraints

- 保留精确岗位身份、标题、公司、薪资、城市校验，不用“名称相似”授权沟通；背景操作、共享额度、随机节奏、检查点、异常即停保持有效。
- 不调用私有 Vue 方法或平台接口、不激活页面、不发送回复、不处理简历或投递。普通初次沟通仍至多一个确定岗位，且须在新鲜完整门禁通过之后。
- 只改当前已复现路径，不改扫描参数、数据库结构、模型、方案、历史记录、依赖或浏览器插件；不推送、合并、打包、发布或改版本。主控管理隔离验收服务与真实页面，实施者不得访问真实平台。
- 主控独占文档、证据与真实验收，实施者只改下列产品与测试文件。不是单体重构，不新增平台通用框架。

## 当前真实证据

1. 一次启动请求 `95972154-38` 报 `ZHAOPIN_SEARCH_RESTORE_TIMEOUT`。保存与实际 template 都是 `https://www.zhaopin.com/jobs/?pageMode=search`，当前关键词 AI应用开发；九个筛选摘要一致；20张卡片，选中0，非加载、非登录/风控。卡片地点“北京 朝阳 建外”，同岗位右栏“北京·朝阳区”，现有 sameLocation 仅去空白/间隔点后全等，导致就绪失败，不是筛选恢复失败。
2. 该页组件实际为 Vue2：卡片 `__vue__.$options.name=JobCard`，`$props.job.number=CC369586810J40974295802`；name=AI Agent开发工程师、companyName=医博士，与可见文字相同。右栏 `__vue__.$options.name=JobDetailSummary`，`$props.jobDetail.detailedPosition.number`、实例 `position.number`、可信详情链接均为同 ID。现有搜索 helper 和沟通最后点击校验却都只读取 Vue3。ID 漏读不是这次搜索超时的唯一直接原因，但会导致最后沟通校验失败。现有 fixture 只有 Vue3 或完全无组件，缺失真实结构。
3. 启动失败写到同一 statusNode；恢复五秒就绪轮询后错误被覆盖。提交之前发出的迟到就绪响应也可能覆盖启动状态。主控从“运行诊断”才查到真实失败，用户看到的是按钮没有反应。
4. 修复后的消息列表成功读取20条，实际新发现一条未解决项（从21变22），但补JD时报同一个登录错误。主控用既有详情 reader、既有共享 pacing/access safety 再做两次受控单页只读探测（后一次仅补控件类型/截图）：独立详情 `/jobdetail/CCL1461615970J40933154315.htm` 有软件开发-Python标题、259字正文、无 `.login`/`.login-panel`；正常详情页头是 `.header-nav__main > .header-nav__login`，内含 `a.header-nav__b-login`、`.header-nav__c-login` 及账户文字/头像子节点。该页头下唯一 input 是 `input.nav-header-search__input[type=text]`，并非登录表单；账户下拉后代 getClientRects为0，却被仅看自身computedStyle的visible函数计为可见。详情reader尚未兼容这套正常页头。两个临时页均按原reader关闭，前台标签始终1995703199、返回6页基线。没有发送任何招呼/回复/简历/投递。

私有原始资料不入fixture。仓库外证据：`D:/DevData/RoleFlow-zhaopin-message-context-20260908/live-acceptance-20260909.md`、`probe-detail-login.js`、`detail-header-failure-public-summary.png`（只裁取岗位标题/薪资/地区，无账户名）。之前157门禁仅覆盖078b8fc，不能作为本次修复通过证据。

## Task 1: 最小真实 DOM 兼容与可见错误保留

**生产所有权：** `src/adapters/sites/zhaopin.js`、`src/adapters/sites/zhaopin_communication.js`、`src/adapters/sites/zhaopin_message_detail_reader.js`、`src/dashboard/pages/today.js`；如复用已有登录纯函数，仅允许窄改 `src/adapters/sites/zhaopin_message_reader.js` 的该函数/导出。不改这几个文件的无关路径。

**测试所有权：** 对应既有 `tests/zhaopin_readonly_smoke.js`、`tests/zhaopin_communication_adapter_smoke.js`、`tests/zhaopin_message_detail_reader_smoke.js`、`tests/today_dashboard_smoke.js` 及所用 `tests/fixtures/zhaopin/` 合成页；共享登录函数如改变需覆盖 `tests/zhaopin_message_reader_smoke.js`。不新增fixture真实账户、HR正文、简历或密钥。必要时仅扩展已有Dashboard智联旅程以覆盖实际入口，不复制一套新runner。

- [ ] RED：用真实表达式和合成Vue2/Vue3页面复现读取/就绪/最后guard行为，不用假的readSearchState成功绕开要验证的代码。地点正例是同ID下“北京 朝阳 建外”对“北京·朝阳区”；跨城、同城不同区、同名错ID、卡片/详情/计算/链接ID冲突必须拒绝且零外部动作。无可靠ID时仍使用原严格地点比较，不享受新增兼容。
- [ ] 实现：在既有读取模块内薄适配 Vue2 `$options.name/$props/position/$parent` 与既有 Vue3 结构，统一读取合同，避免搜索和最后guard各自忘掉一个版本。不调用组件方法。更新注入helper缓存版本，回归实际旧版本能够被替换。保持四个明确ID的一致性；地点只在明确同ID条件下容许同城同区的区后缀/额外商圈，不做任意前缀或仅城市匹配。
- [ ] RED与实现：真实渲染/浏览器测试覆盖正常详情页头及隐藏下拉不阻止JD读取；真正可见登录挑战、风控仍停止并清理临时页；不能按“有JD正文”跳过登录保护，不能豁免整个header下任意登录弹窗。以实际结构作窄豁免，复用既有纯函数时避免复制新的通用框架。
- [ ] RED与实现：启动失败经历后续轮询和迟到的旧就绪响应仍可见，保留错误和定位编号；就绪检查仍能更新按钮能否启动；用户明确再次启动能正常重试且一次请求，不用永久停止轮询来误挡重试。
- [ ] 自查并运行上述定向检查，加 `dashboard_zhaopin_smoke`、`zhaopin_message_discovery_smoke`、`communication_cli_authority_smoke` 的实际覆盖检查；所有改动JS语法、git diff --check；提交仅所有权文件，报告每个实际RED/最终GREEN、命令输出、变更和疑点。不要运行完整npm test或真实浏览器，主控负责。

## 主控验证与交付

- [ ] 实施完成后做一次仅针对本任务的规格/质量复核；不重复全分支综合审查。
- [ ] 定向检查与复核通过后，先对隔离环境进行受控只读实站验证，确认刚修正的真实结构确实可用，再继续实际消息/JD/分析/草稿保存。这是对离线fixture盲区的直接验证，不是对旧测试结果的替代，不包含任何外部发送。
- [ ] 源码稳定后执行新鲜严格完整npm test，记录精确SHA、数量和退出码；只有通过后才能执行至多一次普通初次招呼。需要扫描样本时走现有正常阶段：采集完成/预算正常返回后才进入分析，不修改隐藏参数，不用全方案重试把旧BOSS岗位拉进来。
- [ ] 记录真实结果、编辑/切换/重载保留、平台动作数量和未验证前提；停在回复发送之前。仅文档提交之后做与改动相称的最终复验，不把只读部分通过包装成整条通过。

明确延后：运行中消息列表未自动绘制新结果（当前可刷新查看）、采集中结束后没有只分析这批已保存智联JD的入口。这两项是现有体验限制，不扩展本次修复，不修改产品阶段语义。

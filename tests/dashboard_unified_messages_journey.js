const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const storage = require('../src/core/storage');
const { zhaopinJobIdentity } = require('../src/core/zhaopin_search_scope');
const { createMessageDiscoveryController } = require('../src/dashboard/message_discovery_controller');
const { createDashboardServer } = require('../src/dashboard/server');
const { recordUnresolvedMessageDiscoveryItem } = require('../src/core/message_preview_state');
const NOW = '2026-09-08T01:00:00.000Z';
const PARAMETERIZED_IM_URL = 'https://i.zhaopin.com/im?refcode=4089&sessionId=' + 'a'.repeat(32) + '#conversation';
const digest = value => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
const logger = { info() {}, warn() {}, error() {}, requestId() { return 'unified'; }, listRecent() { return []; } };
function seed(db, platform, profileId, planId, manual = false, suffix = manual ? '8' : '9', messages = ['好的，可以沟通。']) {
  const sourceId = platform + ':CCL1234567890J0012345678' + suffix;
  const storedId = platform === 'zhaopin' ? zhaopinJobIdentity('https://www.zhaopin.com/jobdetail/CCL1234567890J0012345678' + suffix + '.htm').sourceId : sourceId;
  const jobId = Number(db.prepare("INSERT INTO jobs(source,source_id,title,company,description,first_seen_at,last_seen_at) VALUES (?,?,'同名岗位','合成公司','只有一小段资料',?,?)").run(platform, storedId, NOW, NOW).lastInsertRowid);
  const cardId = Number(db.prepare("INSERT INTO candidate_progress_cards(profile_id,plan_id,job_id,source,stage,next_action,last_event_at,created_at,updated_at) VALUES (?,?,?,?,'reply_ready','人工确认',?,?,?)").run(profileId, planId, jobId, platform, NOW, NOW, NOW).lastInsertRowid);
  const key = digest(sourceId);
  const drafts = manual ? [] : storage.recordMessageReplyDrafts(db, { profileId,cardId,jobId,messageGroupKey:key,messageIntent:'information_request',messageCategory:'other',questionSummary:'确认沟通',messages,createdAt:NOW });
  storage.saveMessageInboundContext(db, { platform,profileId,cardId,messageGroupKey:key,conversationKey:digest('conversation'+sourceId),sourceJobId:sourceId,lastMessageId:'378917037748741',messageIntent:manual?'manual_review':'information_request',messageCategory:'other',inboundMessages:[{kind:manual?'resume_request':'text',text:manual?'HR 邀请你发送简历':platform+' 原始问题'}],manualActions:manual?[{kind:'resume_request'}]:[],createdAt:NOW,updatedAt:NOW });
  return {cardId,jobId,drafts,key};
}
async function settle(controller, profileId) { for(let i=0;i<100;i++){if(controller.status(profileId).status!=='running')return controller.pageState(profileId);await new Promise(r=>setTimeout(r,5));}throw Error('discovery did not settle'); }
function assertUnknownZhaopinReceipts(result) {
  const entry = result.platformRuns.find(item => item.platform === 'zhaopin');
  assert.equal(entry.counters.currentRead, null, `${entry.status}/${entry.reasonCode}: ZL read receipts lack evidence`);
  assert.equal(entry.counters.currentDelivered, null, `${entry.status}/${entry.reasonCode}: ZL delivery receipts lack evidence`);
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'roleflow-unified-'));
  const dbPath = path.join(root,'fixture.sqlite');
  const db = storage.openDb(dbPath);
  let server, browser;const controllers=[];
  try {
    const profileId = Number(db.prepare("INSERT INTO candidate_profiles(display_name,profile_json,created_at,updated_at) VALUES ('合成候选人','{}',?,?)").run(NOW,NOW).lastInsertRowid);
    const planId = Number(db.prepare("INSERT INTO search_plans(profile_id,name,plan_json,is_active,created_at,updated_at) VALUES (?,'合成计划','{}',1,?,?)").run(profileId,NOW,NOW).lastInsertRowid);
    const boss = seed(db,'boss',profileId,planId);
    const zl = seed(db,'zhaopin',profileId,planId,false,'9',['好的，可以沟通。','也可以先介绍具体安排。']);
    const manual = seed(db,'zhaopin',profileId,planId,true);
    let nativeScans=0,nativeBossGuards=0,nativeActive=0,nativeMax=0,nativePlatforms=['zhaopin'];const nativeOrder=[], nativeStates=[];
    const nativeController=createMessageDiscoveryController({db,acquireLease:storage.acquireSiteScanLease,renewLease:storage.renewSiteScanLease,releaseLease:storage.releaseSiteScanLease,
      createBrowser:()=>({listTabs:async()=>nativePlatforms.map((platform,index)=>({id:index+1,windowId:1,url:platform==='boss'?'https://www.zhipin.com/web/geek/chat':PARAMETERIZED_IM_URL}))}),
      assertRuntimeAvailable:()=>{nativeBossGuards++;},createReader:({platform})=>({async scanConversationRows(){nativeStates.push(nativeController.status(profileId).platformRuns);assert(nativeController.status(profileId).platformRuns.every(entry=>['not_connected','running','completed','stopped','needs_user_action'].includes(entry.status)));nativeScans++;nativeOrder.push(platform);nativeActive++;nativeMax=Math.max(nativeMax,nativeActive);await new Promise(resolve=>setTimeout(resolve,1));nativeActive--;return {platform,rows:[]};}}),createAnalyzer:()=>async()=>({}),createDetailSafety:()=>({}),createDetailReader:()=>({}),createJobContextResolver:()=>async()=>({})});
    controllers.push(nativeController);nativeController.start(profileId);const nativeResult=await settle(nativeController,profileId);assert.equal(nativeScans,1,'shared production pipeline reaches the ZL reader');assert.equal(nativeBossGuards,0);
    assertUnknownZhaopinReceipts({ platformRuns: nativeStates[0] });
    const nativeZl = nativeResult.platformRuns.find(entry => entry.platform === 'zhaopin');
    assert.equal(nativeZl.counters.currentRead, null, 'public platformRuns must preserve unknown ZL read receipts');
    assert.equal(nativeZl.counters.currentDelivered, null, 'public platformRuns must preserve unknown ZL delivery receipts');
    assert.equal(nativeResult.counters.currentRead, 0, 'aggregate receipts remain BOSS-only numbers');
    assert.equal(nativeResult.counters.currentDelivered, 0);
    nativePlatforms=['zhaopin','boss'];nativeController.start(profileId);await settle(nativeController,profileId);assert.deepEqual(nativeOrder,['zhaopin','boss','zhaopin']);assert.equal(nativeMax,1,'production pipelines must never overlap browser reads');
    assertUnknownZhaopinReceipts({ platformRuns: nativeStates[1] });
    assert.equal(nativeStates[1].find(entry => entry.platform === 'zhaopin').reasonCode, 'MESSAGE_DISCOVERY_WAITING_TURN');
    await nativeController.close();
    let bossReadCalls=0,zhaopinReadCalls=0,operations=0,maxOperations=0,cleanup=0;
    let connected=['zhaopin']; const order=[];
    const deps={db,acquireLease:storage.acquireSiteScanLease,renewLease:storage.renewSiteScanLease,releaseLease:storage.releaseSiteScanLease,
      createBrowser:()=>({listTabs:async()=>connected.map((p,i)=>({id:i+1,windowId:1,url:p==='boss'?'https://www.zhipin.com/web/geek/chat':PARAMETERIZED_IM_URL}))}),
      cleanupBrowser:async()=>{cleanup++;},assertRuntimeAvailable:()=>{bossReadCalls++;if(deps.blockBoss)throw Object.assign(Error('existing pause'),{code:'BOSS_RUNTIME_BLOCKED'});},
      createReader:({platform})=>({platform}),createDetailSafety:()=>({}),createDetailReader:()=>({}),createJobContextResolver:()=>async()=>({}),createAnalyzer:()=>async()=>({}),
      runDiscovery:async({platform,signal,onStatus})=>{operations++;maxOperations=Math.max(maxOperations,operations);order.push(platform);if(platform==='zhaopin')zhaopinReadCalls++;try{if(deps.waitSecond&&platform==='zhaopin'){onStatus({status:'running',phase:'reading_messages',results:[]});await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return {status:'stopped',results:[]};}return {status:'completed',processed:1,counters:{visible:1,newReplies:1,currentRead:platform==='boss'?7:99},results:[{cardId:platform==='boss'?boss.cardId:zl.cardId,jobId:platform==='boss'?boss.jobId:zl.jobId}]};}finally{operations--;}}};
    const controller=createMessageDiscoveryController(deps);
    controllers.push(controller);
    controller.start(profileId); let result=await settle(controller,profileId);
    assert.equal(bossReadCalls,0,'ZL-only discovery must not invoke BOSS safety/read helpers');
    assert.equal(zhaopinReadCalls,1);assert.equal(maxOperations,1);assert.equal(cleanup,1);
    assert.equal(result.platformRuns.find(r=>r.platform==='boss').status,'not_connected');
    connected=['zhaopin','boss'];order.length=0;controller.start(profileId);result=await settle(controller,profileId);
    assert.deepEqual(order,['boss','zhaopin']);assert.equal(result.results.length,2);assert.equal(result.counters.visible,2);assert.equal(result.counters.currentRead,7,'ZL cannot contribute invented BOSS read receipts');
    assertUnknownZhaopinReceipts(result);
    deps.waitSecond=true;controller.start(profileId);while(order.length<4)await new Promise(r=>setTimeout(r,5));controller.stop(profileId);result=await settle(controller,profileId);
    assertUnknownZhaopinReceipts(result);
    assert.equal(result.results[0].cardId,boss.cardId);assert(storage.getMessageReplyDraft(db,{profileId,draftId:boss.drafts[0].id}));
    deps.waitSecond=false;connected=['boss'];controller.start(profileId);result=await settle(controller,profileId);
    assert.equal(result.results[0].cardId,boss.cardId);assert.equal(result.platformRuns.find(r=>r.platform==='zhaopin').status,'not_connected');
    assertUnknownZhaopinReceipts(result);
    connected=['boss','zhaopin','zhaopin'];controller.start(profileId);result=await settle(controller,profileId);
    assert.equal(result.results[0].cardId,boss.cardId);assert.equal(result.platformRuns.find(r=>r.platform==='zhaopin').reasonCode,'ZHAOPIN_MESSAGE_TAB_AMBIGUOUS');
    connected=['boss','zhaopin'];deps.blockBoss=true;controller.start(profileId);result=await settle(controller,profileId);assert.equal(result.results[0].cardId,zl.cardId);assert.equal(result.platformRuns.find(r=>r.platform==='boss').reasonCode,'BOSS_RUNTIME_BLOCKED');deps.blockBoss=false;
    await controller.close();
    const restored=createMessageDiscoveryController({db});const recovered=restored.pageState(profileId);
    assert.equal(recovered.results.length,3,'manual-only inbound context must survive restart');
    assert.equal(recovered.results.find(r=>r.cardId===zl.cardId).contextComplete,false,'partial description is not complete trusted analysis');
    assert.equal(recovered.results.find(r=>r.cardId===zl.cardId).platform,'zhaopin');
    const frozen=storage.createMessageReplySendBatch(db,{profileId,items:[{draftId:boss.drafts[0].id,revision:0}]});
    assert.throws(()=>restored.dismiss(profileId),error=>error.code==='MESSAGE_REPLY_SEND_DRAFT_BUSY');
    assert.equal(storage.listMessageInboundContexts(db,{profileId}).length,3,'busy send prevents any context deletion');
    db.prepare("UPDATE message_reply_send_items SET status='stopped' WHERE batch_id=?").run(frozen.batch.id);
    db.prepare("UPDATE message_reply_send_batches SET status='stopped' WHERE id=?").run(frozen.batch.id);
    await restored.close();
    const historicalConversationKey=digest('historical-boss-pending');
    recordUnresolvedMessageDiscoveryItem(db,{profileId,platform:'boss',conversationKey:historicalConversationKey,previewDigest:digest('historical-boss-preview'),previewKind:'possible_hr_reply',observedAt:'2026-09-07T01:00:00.000Z',reasonCode:'BOSS_MESSAGE_CARD_NOT_FOUND',identity:{positionTitle:'历史待核对岗位',company:'历史合成公司'}});
    const zhaopinPendingConversationKey=digest('historical-zhaopin-pending');
    recordUnresolvedMessageDiscoveryItem(db,{profileId,platform:'zhaopin',conversationKey:zhaopinPendingConversationKey,previewDigest:digest('historical-zhaopin-preview'),previewKind:'possible_hr_reply',observedAt:'2026-09-07T02:00:00.000Z',sourceJobId:'zhaopin:CCL1234567890J0099999999',lastMessageId:'202609070200',reasonCode:'MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE',identity:{positionTitle:'待补岗位资料',company:'智联合成公司'},inboundMessages:[{kind:'text',text:'合成待处理原文'}]});
    let httpBrowserCalls=0,httpBossCalls=0,httpReaderCalls=0,httpReaderShouldWait=false;
    server=createDashboardServer({db,dbPath,root,dataRoot:root,forceMock:true,logger,browserAuthority:{browserMode:'portable',cdpPort:9222,profilePath:path.join(root,'profile')},
      browserFactory:()=>{httpBrowserCalls++;return {listTabs:async()=>[{id:2,windowId:1,url:PARAMETERIZED_IM_URL}]};},
      messageDiscoveryDependencies:{assertRuntimeAvailable:()=>{httpBossCalls++;},createAnalyzer:()=>async()=>({}),createReader:()=>({async scanConversationRows(signal){httpReaderCalls++;if(httpReaderShouldWait)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return {platform:'zhaopin',rows:[]};}})}});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
    const before=db.prepare('SELECT COUNT(*) n FROM candidate_progress_events').get().n;
    const sent=await fetch(base+'/api/progress',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({cardId:zl.cardId,draftId:zl.drafts[0].id,finalText:'篡改答案',action:'reply_confirmed_sent',idempotencyKey:'zl-forbidden'})});
    assert.equal(sent.status,409);assert.equal((await sent.json()).errorCode,'MESSAGE_REPLY_PLATFORM_UNSUPPORTED');assert.equal(db.prepare('SELECT COUNT(*) n FROM candidate_progress_events').get().n,before);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM candidate_answer_memories').get().n,0,'rejected sent confirmation must not teach an answer');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM candidate_funnel_entries').get().n,0,'rejected sent confirmation must not create funnel entries');
    assert.equal(storage.getMessageReplyDraft(db,{profileId,draftId:zl.drafts[0].id}).currentText,'好的，可以沟通。');
    let chromium;try{({chromium}=require('playwright'));}catch(error){if(process.env.ROLEFLOW_REQUIRE_PLAYWRIGHT==='1')throw error;console.log('dashboard_unified_messages_journey browser SKIP: Playwright unavailable');return;}
    browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});const page=await context.newPage();const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('500 (Internal Server Error)'))errors.push(message.text());});await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==base){external.push(route.request().url());return route.abort();}return route.continue();});
    for(const route of ['queue','jobs']){await page.goto(base+'/'+route+'?planId='+planId+'&site=zhaopin');const entry=page.getByRole('link',{name:'消息与回复',exact:true});assert.equal(await entry.count(),1);assert.equal(new URL(await entry.getAttribute('href'),base).searchParams.get('workSite'),'zhaopin');assert.equal(await page.getByRole('link',{name:'发送记录',exact:true}).count(),0);}
    await page.goto(base+'/plan?planId='+planId+'&site=zhaopin');const inbox=page.getByRole('link',{name:'消息与回复',exact:true});assert.equal(await inbox.count(),1);await inbox.click();assert.equal(new URL(page.url()).searchParams.get('workSite'),'zhaopin');
    assert.equal(await page.getByRole('link',{name:'发送记录',exact:true}).count(),0);const today=page.getByRole('link',{name:'今日任务',exact:true});assert.equal(new URL(await today.getAttribute('href'),base).searchParams.get('site'),'zhaopin');
    assert.equal(await page.locator('.message-workspace').count(),1);assert.equal(await page.locator('.message-unresolved:not(.message-workspace *)').count(),0);assert.equal(await page.locator('[data-message-detail-panel]:visible').count(),1);
    const zlCard=page.locator('[data-message-detail-panel].message-result[data-platform="zhaopin"]').filter({has:page.locator('[data-draft-text]')});assert.equal(await zlCard.locator('[data-send-single], [data-send-select], [data-sent-draft]').count(),0);assert.equal(await zlCard.locator('[data-copy-draft]').count(),2);
    const manualCard=page.locator('[data-message-detail-panel].message-result[data-platform="zhaopin"]').filter({hasNot:page.locator('[data-draft-text]')});assert.match(await manualCard.textContent(),/HR 邀请你发送简历/);assert.match(await manualCard.textContent(),/智联原始会话/);assert.equal(await manualCard.locator('button,form').count(),0);
    assert.equal(await page.locator('[data-send-select]').count(),1,'only the BOSS draft enters the batch selection');
    assert.equal(await page.locator('.message-list-item[data-platform="boss"]').count(),2);assert.equal(await page.locator('.message-list-item[data-platform="zhaopin"]').count(),3);
    const pending=page.locator('.message-unresolved[data-platform="boss"]');assert.equal(await pending.count(),1);
    let zhaopinPendingRow=page.locator('.message-list-item[data-platform="zhaopin"]').filter({hasText:'待补岗位资料'});assert.equal(await zhaopinPendingRow.count(),1);
    await zhaopinPendingRow.click();await page.locator('[data-message-detail-panel].message-unresolved[data-platform="zhaopin"]', {hasText:'合成待处理原文'}).waitFor({state:'visible'});assert.match(await page.locator('[data-message-detail-panel]:visible').innerText(),/合成待处理原文/);
    const filter=page.getByLabel('消息来源');await filter.selectOption('zhaopin');await page.waitForFunction(()=>document.querySelector('[data-source-filter]').value==='zhaopin'&&document.querySelector('.message-list-item[data-platform="boss"]').hidden);
    const zlKey=await zlCard.getAttribute('data-message-detail-panel');const zlRow=page.locator('.message-list-item').filter({has:page.locator('[data-message-view="'+zlKey+'"]')});await zlRow.click();const fields=zlCard.locator('[data-draft-text]'),field=fields.first(),alternativeField=fields.nth(1);await field.fill('可以的，我们继续沟通。');await filter.selectOption('boss');await page.waitForFunction(()=>document.querySelector('.message-list-item[data-platform="zhaopin"]').hidden);
    await page.reload();assert.equal(await filter.inputValue(),'boss');await filter.selectOption('zhaopin');await zlCard.waitFor({state:'visible'});assert.equal(await field.inputValue(),'可以的，我们继续沟通。');assert.equal(await page.locator('[data-send-batch-panel]').isVisible(),false);
    await zlCard.locator('[data-copy-draft]').first().click();await page.waitForFunction(()=>document.querySelector('[data-discovery-feedback]').textContent.includes('记住')||document.querySelector('[data-discovery-feedback]').textContent.includes('已复制'));assert.equal(db.prepare('SELECT COUNT(*) n FROM candidate_progress_events').get().n,before);
    const firstDraftId=Number(await field.getAttribute('data-draft-id')),secondDraftId=Number(await alternativeField.getAttribute('data-draft-id'));let saveMode='fail',failedSaveCount=0,finishFailedSaves;const failedSavesFinished=new Promise(resolve=>{finishFailedSaves=resolve;});let startSecondSave,secondSaveDeferred=false,releaseSecondSave=()=>{},finishLatestFailure;const secondSaveStarted=new Promise(resolve=>{startSecondSave=resolve;}),latestFailureFinished=new Promise(resolve=>{finishLatestFailure=resolve;});await page.route('**/api/message-reply-draft',async route=>{const body=route.request().postDataJSON();if(saveMode==='fail'){await route.fulfill({status:500,contentType:'application/json',body:'{"errorCode":"SAVE_FAILED"}'});failedSaveCount+=1;if(failedSaveCount===2)finishFailedSaves();return;}if(saveMode==='group-race'&&body.draftId===secondDraftId&&!secondSaveDeferred){secondSaveDeferred=true;startSecondSave();await new Promise(resolve=>{releaseSecondSave=resolve;});return route.continue();}if(saveMode==='group-race'&&body.draftId===firstDraftId&&body.text==='整组等待期间的第二版'){await route.fulfill({status:500,contentType:'application/json',body:'{"errorCode":"SAVE_FAILED"}'});finishLatestFailure();return;}return route.continue();});await field.fill('保存失败时保留的回答');await zhaopinPendingRow.click();await failedSavesFinished;await page.waitForFunction(()=>document.querySelector('[data-discovery-feedback]').textContent==='当前草稿未能保存，已保留当前消息，请稍后重试。'&&!document.querySelector('[data-source-filter]').disabled);assert.equal(await filter.inputValue(),'zhaopin');assert.equal(await field.inputValue(),'保存失败时保留的回答');assert.equal(await zlCard.isVisible(),true);assert.equal(await zlRow.locator('[data-message-view]').isChecked(),true);saveMode='pass';
    await field.fill('整组保存的第一版');saveMode='group-race';await zhaopinPendingRow.click();await secondSaveStarted;for(let attempt=0;attempt<100&&storage.getMessageReplyDraft(db,{profileId,draftId:firstDraftId}).currentText!=='整组保存的第一版';attempt++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(storage.getMessageReplyDraft(db,{profileId,draftId:firstDraftId}).currentText,'整组保存的第一版');await field.fill('整组等待期间的第二版');releaseSecondSave();await latestFailureFinished;await page.waitForFunction(id=>document.querySelector('[data-draft-save-status="'+id+'"]').textContent==='保存失败，请重试'&&!document.querySelector('[data-source-filter]').disabled,firstDraftId);assert.equal(await field.inputValue(),'整组等待期间的第二版');assert.equal(await zlCard.isVisible(),true,'a failed edit made while another draft saves must keep the original message visible');assert.equal(await zlRow.locator('[data-message-view]').isChecked(),true);saveMode='pass';
    await zhaopinPendingRow.click();await page.locator('[data-message-detail-panel].message-unresolved[data-platform="zhaopin"]', {hasText:'合成待处理原文'}).waitFor({state:'visible'});
    const selectedPendingKey=await zhaopinPendingRow.locator('[data-message-view]').getAttribute('data-message-view');await page.reload();assert.equal(await filter.inputValue(),'zhaopin');assert.equal(await page.locator('[data-message-view="'+selectedPendingKey+'"]').isChecked(),true);assert.match(await page.locator('[data-message-detail-panel]:visible').innerText(),/合成待处理原文/);
    recordUnresolvedMessageDiscoveryItem(db,{profileId,platform:'zhaopin',conversationKey:digest('newer-zhaopin-pending'),previewDigest:digest('newer-zhaopin-preview'),previewKind:'possible_hr_reply',observedAt:'2026-09-08T03:00:00.000Z',sourceJobId:'zhaopin:CCL1234567890J0088888888',lastMessageId:'202609080300',reasonCode:'MESSAGE_DISCOVERY_JOB_CONTEXT_UNAVAILABLE',identity:{positionTitle:'后来新增的待处理岗位',company:'另一合成公司'},inboundMessages:[{kind:'text',text:'后来新增的合成原文'}]});
    await page.reload();zhaopinPendingRow=page.locator('.message-list-item').filter({has:page.locator('[data-message-view="'+selectedPendingKey+'"]')});assert.equal(await page.locator('[data-message-view="'+selectedPendingKey+'"]').isChecked(),true);assert.match(await page.locator('[data-message-detail-panel]:visible').innerText(),/合成待处理原文/);assert.doesNotMatch(await page.locator('[data-message-detail-panel]:visible').innerText(),/后来新增/);
    await filter.selectOption('all');await zlRow.click();await field.fill('快速切换前保存的回答');const bossResultRow=page.locator('.message-list-item[data-platform="boss"]').filter({has:page.locator('[data-message-view^="result-"]')});await bossResultRow.click();await zhaopinPendingRow.click();await page.waitForFunction(()=>{const checked=document.querySelector('[data-message-view]:checked');const visible=document.querySelector('[data-message-detail-panel]:not([hidden])');return checked&&visible&&checked.dataset.messageView===visible.dataset.messageDetailPanel&&visible.textContent.includes('合成待处理原文');});for(let attempt=0;attempt<100&&storage.getMessageReplyDraft(db,{profileId,draftId:zl.drafts[0].id}).currentText!=='快速切换前保存的回答';attempt++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(storage.getMessageReplyDraft(db,{profileId,draftId:zl.drafts[0].id}).currentText,'快速切换前保存的回答');
    await filter.selectOption('boss');await page.reload();assert.equal(await filter.inputValue(),'boss');const selectedBossKey=await page.locator('[data-message-view]:checked').getAttribute('data-message-view');assert.equal(await page.locator('[data-message-detail-panel="'+selectedBossKey+'"]').isVisible(),true);await page.locator('.message-list-item[data-platform="boss"]').filter({hasText:'历史待核对岗位'}).click();assert.equal(await pending.locator('form[action="/api/message-discovery-unresolved"]').count(),2);assert.equal(await pending.getByRole('button',{name:'保存为 HR 主动机会',exact:true}).isEnabled(),true);
    const evidence='D:/DevData/RoleFlow-zhaopin-messages-20260908';fs.mkdirSync(evidence,{recursive:true});for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(evidence,'unified-messages-'+width+'.png'),fullPage:true});}
    await filter.focus();assert.equal(await filter.evaluate(e=>e===document.activeElement),true);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM candidate_answer_memories WHERE profile_id=? AND final_text=? AND completion_kind='copied'").get(profileId,'可以的，我们继续沟通。').n,1,'edited copy teaches the answer without sent progress');
    assert.equal(httpBrowserCalls,0,'source filtering and copying cannot start discovery');
    db.prepare("UPDATE candidate_progress_cards SET source='unknown' WHERE id=?").run(boss.cardId);
    const unknownPage=await context.newPage();await unknownPage.goto(base+'/messages?profileId='+profileId);const unknownCard=unknownPage.locator('[data-message-detail-panel][data-platform=""]');assert.equal(await unknownCard.count(),1);assert.equal(await unknownCard.locator('[data-send-single], [data-send-select], [data-sent-draft]').count(),0);await unknownPage.close();db.prepare("UPDATE candidate_progress_cards SET source='boss' WHERE id=?").run(boss.cardId);
    await today.click();await page.waitForURL('**/plan?**');assert.equal(new URL(page.url()).searchParams.get('site'),'zhaopin');
    const dismiss=await fetch(base+'/api/message-discovery',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'dismiss',profileId})});assert.equal(dismiss.status,200);
    const cleared=createMessageDiscoveryController({db});assert.equal(cleared.pageState(profileId).results.length,0);assert.equal(storage.listMessageInboundContexts(db,{profileId}).length,0);assert.equal(cleared.pageState(profileId).unresolved,3,'dismiss preserves every unprocessed pending message');await cleared.close();
    await page.getByRole('link',{name:'消息与回复',exact:true}).click();assert.equal(await page.locator('.message-workspace').count(),1);assert.equal(await page.locator('[data-message-detail-panel]:visible').count(),1);await page.getByLabel('消息来源').selectOption('zhaopin');await page.locator('.message-list-item').filter({has:page.locator('[data-message-view="'+selectedPendingKey+'"]')}).click();await page.locator('[data-message-detail-panel="'+selectedPendingKey+'"]').waitFor({state:'visible'});assert.match(await page.locator('[data-message-detail-panel]:visible').innerText(),/合成待处理原文/);
    db.prepare("DELETE FROM message_discovery_unresolved_items WHERE profile_id=? AND platform='zhaopin'").run(profileId);await page.reload();await page.getByLabel('消息来源').selectOption('zhaopin');await page.locator('[data-source-empty]').waitFor({state:'visible'});assert.equal(await page.locator('[data-message-view]:checked').count(),0);assert.equal(await page.locator('[data-message-detail-panel]:visible').count(),0);assert.equal(await pending.isVisible(),false);
    await page.getByRole('button',{name:'开始只读发现',exact:true}).click();
    let completedStatus;for(let attempt=0;attempt<100;attempt++){completedStatus=await (await fetch(base+'/api/message-discovery-status?profileId='+profileId)).json();if(completedStatus.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,5));}
    assert.equal(completedStatus.status,'completed');assert.equal(completedStatus.unresolved,0);assert.equal(completedStatus.reasonCode,'');assert(completedStatus.startedAt);
    await page.waitForFunction(()=>document.querySelector('.message-state h2')?.textContent==='本次发现已完成',null,{timeout:5000});
    const completedState=await page.locator('.message-state').innerText();assert.match(completedState,/未解决 0/);assert.match(completedState,/保留记录 1/);assert.doesNotMatch(completedState,/无法确认本地岗位与会话是否一致/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM message_discovery_unresolved_items WHERE profile_id=? AND conversation_key=?').get(profileId,historicalConversationKey).n,1,'the successful current run must retain the old BOSS row');
    await page.getByLabel('消息来源').selectOption('all');assert.equal(await pending.isVisible(),true);assert.match(await pending.innerText(),/BOSS/);assert.match(await pending.innerText(),/无法确认本地岗位与会话是否一致/);
    await page.getByLabel('消息来源').selectOption('zhaopin');assert.equal(await pending.isVisible(),false);
    await page.getByLabel('消息来源').selectOption('boss');assert.equal(await pending.isVisible(),true);
    await page.reload();assert.equal(await page.getByLabel('消息来源').inputValue(),'boss');assert.equal(await pending.isVisible(),true);assert.equal(db.prepare('SELECT COUNT(*) n FROM message_discovery_unresolved_items WHERE profile_id=? AND conversation_key=?').get(profileId,historicalConversationKey).n,1);
    httpReaderShouldWait=true;
    await page.getByRole('button',{name:'开始只读发现',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('button[data-page-primary]')||document.querySelector('button[data-page-primary]').disabled);await page.getByRole('button',{name:'安全停止',exact:true}).waitFor({state:'visible'});
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('form[data-discovery-form]')).find(form=>form.querySelector('[name=action]').value==='stop').querySelector('button').disabled===false);
    assert.match(await page.locator('main').innerText(),/正在加载并读取消息/);assert.equal(httpBossCalls,0);assert.equal(httpReaderCalls,2);
    await page.getByRole('button',{name:'安全停止',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.message-state h2')?.textContent==='已安全停止');assert.equal(httpBrowserCalls,2);
    const stoppedStatus=await (await fetch(base+'/api/message-discovery-status?profileId='+profileId)).json();assert.equal(stoppedStatus.status,'stopped');assert.equal(stoppedStatus.unresolved,0);assert.equal(stoppedStatus.reasonCode,'MESSAGE_DISCOVERY_STOPPED');
    const stoppedState=await page.locator('.message-state').innerText();assert.match(stoppedState,/已按你的操作安全停止/);assert.doesNotMatch(stoppedState,/无法确认本地岗位与会话是否一致/);assert.match(await pending.innerText(),/无法确认本地岗位与会话是否一致/);
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    await activeBatchRemainsStoppableUnderZhaopinFilter(chromium);
    console.log('dashboard_unified_messages_journey ok: serial discovery, restore, source-safe HTTP/UI, autosave, navigation, 1440/390, active BOSS stop under ZL filter/reload');
  }finally{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));for(const controller of controllers)await controller.close();db.close();fs.rmSync(root,{recursive:true,force:true});}
}
async function activeBatchRemainsStoppableUnderZhaopinFilter(chromium) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roleflow-unified-active-send-'));
  const dbPath = path.join(root, 'fixture.sqlite');
  const db = storage.openDb(dbPath);
  const token = 'unified-active-send-fixture';
  let server, browser, base, profileId, batchId;
  let inspections = 0, writes = 0, browserCreations = 0;
  let disconnectedResolve;
  const disconnected = new Promise(resolve => { disconnectedResolve = resolve; });
  try {
    profileId = Number(db.prepare("INSERT INTO candidate_profiles(display_name,profile_json,created_at,updated_at) VALUES ('合成候选人','{}',?,?)").run(NOW,NOW).lastInsertRowid);
    const planId = Number(db.prepare("INSERT INTO search_plans(profile_id,name,plan_json,is_active,created_at,updated_at) VALUES (?,'合成计划','{}',1,?,?)").run(profileId,NOW,NOW).lastInsertRowid);
    for (const suffix of ['1', '2', '3']) seed(db, 'boss', profileId, planId, false, suffix);
    const zl = seed(db, 'zhaopin', profileId, planId);
    server = createDashboardServer({
      db, dbPath, root, dataRoot: root, forceMock: true, logger, messageReplyActionToken: token,
      browserAuthority: { browserMode: 'portable', cdpPort: 9222, profilePath: path.join(root, 'profile') },
      browserFactory: () => { browserCreations++; return { async disconnect() { disconnectedResolve(); } }; },
      messageReplySendDependencies: {
        createReader: () => ({}),
        createAccessController: () => ({ async reserve() {} }),
        createSender: () => ({
          async inspectReplyTarget(item, signal) {
            inspections++;
            assert.equal(db.prepare('SELECT source FROM jobs WHERE id=?').get(item.jobId).source, 'boss');
            await new Promise(resolve => signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true }));
            return {};
          },
          async fillReply() { writes++; return {}; },
          async dispatchReply() { writes++; },
          async verifyReplyResult() { return { state: 'succeeded' }; },
          async clearPreparedReply() { writes++; }
        })
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [], external = [], mutations = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base) { external.push(request.url()); return route.abort(); }
      if (request.method() === 'POST') mutations.push(url.pathname);
      return route.continue();
    });
    await page.goto(base + '/messages?profileId=' + profileId);
    await page.locator('[data-send-batch]').click();
    await page.locator('[data-send-stop]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('[data-send-batch-panel]').dataset.state === 'running');
    batchId = db.prepare('SELECT id FROM message_reply_send_batches').get().id;
    assert.deepEqual(db.prepare('SELECT status FROM message_reply_send_items ORDER BY id').all().map(item => item.status), ['selecting', 'pending', 'pending']);
    const filter = page.getByLabel('消息来源');
    await filter.selectOption('zhaopin');
    await page.waitForFunction(() => document.querySelector('.message-list-item[data-platform="boss"]').hidden);
    assert.equal(await page.locator('[data-send-stop]').isVisible(), true, 'switching to ZL must retain the active BOSS stop control');
    assert.equal(await page.locator('[data-send-stop]').isEnabled(), true);
    assert.equal(await page.locator('[data-send-batch]').isVisible(), false, 'ZL filter hides only new batch initiation');
    assert.match(await page.locator('[data-send-batch-title]').innerText(), /0 \/ 3/);
    const field = page.locator('[data-message-detail-panel][data-platform="zhaopin"] [data-draft-text]');
    await field.fill('切换筛选仍保存智联草稿');
    await filter.selectOption('all');
    await page.waitForFunction(() => !document.querySelector('.message-list-item[data-platform="boss"]').hidden);
    await filter.selectOption('zhaopin');
    await page.waitForFunction(() => document.querySelector('.message-list-item[data-platform="boss"]').hidden);
    await page.reload();
    assert.equal(await filter.inputValue(), 'zhaopin');
    assert.equal(await field.inputValue(), '切换筛选仍保存智联草稿');
    assert.equal(await page.locator('[data-send-stop]').isVisible(), true, 'reload with saved ZL filter must retain the restored active stop control');
    assert.equal(await page.locator('[data-send-stop]').isEnabled(), true);
    const stopContrast = await page.locator('[data-send-stop]').evaluate(button => {
      const style = getComputedStyle(button);
      const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      const foreground = luminance(style.color), background = luminance(style.backgroundColor);
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    });
    assert(stopContrast >= 4.5, 'the restored stop label must be readable against its button background');
    assert.equal(await page.locator('[data-send-batch]').isVisible(), false);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM message_reply_send_batches').get().n, 1, 'filter/reload cannot authorize another batch');
    assert.equal(inspections, 1);
    assert.equal(writes, 0);
    assert.deepEqual(mutations.filter(route => route !== '/api/message-reply-draft'), ['/api/message-reply-send-batch']);
    await page.screenshot({ path: 'D:/DevData/RoleFlow-zhaopin-messages-20260908/unified-active-boss-zhaopin-filter.png', fullPage: true });
    await page.getByRole('button', { name: '停止后续发送', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-send-batch-panel]').dataset.state === 'stopped');
    await disconnected;
    assert.deepEqual(db.prepare('SELECT status, click_count FROM message_reply_send_items ORDER BY id').all().map(item => ({ ...item })), Array.from({ length: 3 }, () => ({ status: 'stopped', click_count: 0 })));
    assert.equal(inspections, 1, 'the two pending conversations must never be inspected');
    assert.equal(writes, 0, 'stop before first fill prevents all sender writes');
    assert.equal(browserCreations, 1);
    assert.deepEqual(mutations.filter(route => route !== '/api/message-reply-draft'), ['/api/message-reply-send-batch', '/api/message-reply-send-control']);
    for (const table of ['candidate_progress_events', 'candidate_answer_memories', 'candidate_funnel_entries']) assert.equal(db.prepare('SELECT COUNT(*) n FROM ' + table).get().n, 0);
    assert.equal(storage.getMessageReplyDraft(db, { profileId, draftId: zl.drafts[0].id }).currentText, '切换筛选仍保存智联草稿');
    assert.equal(await filter.inputValue(), 'zhaopin');
    assert.equal(await page.locator('[data-send-batch-panel]').isVisible(), false, 'terminal ZL view has no new send action');
    await filter.selectOption('boss');
    await page.waitForFunction(() => !document.querySelector('.message-list-item[data-platform="boss"]').hidden);
    assert.equal(await page.locator('[data-send-batch]').isVisible(), true);
    assert.equal(await page.locator('[data-send-stop]').isVisible(), false);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
  } finally {
    if (batchId && ['confirmed', 'running'].includes(db.prepare('SELECT status FROM message_reply_send_batches WHERE id=?').get(batchId).status)) await fetch(base + '/api/message-reply-send-control', { method: 'POST', headers: { 'content-type': 'application/json', 'x-roleflow-action': token }, body: JSON.stringify({ profileId, batchId, action: 'stop' }) });
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});

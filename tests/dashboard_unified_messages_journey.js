const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const storage = require('../src/core/storage');
const { createMessageDiscoveryController } = require('../src/dashboard/message_discovery_controller');
const { createDashboardServer } = require('../src/dashboard/server');
const { recordUnresolvedMessageDiscoveryItem } = require('../src/core/message_preview_state');
const NOW = '2026-09-08T01:00:00.000Z';
const digest = value => 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
const logger = { info() {}, warn() {}, error() {}, requestId() { return 'unified'; }, listRecent() { return []; } };
function seed(db, platform, profileId, planId, manual = false) {
  const sourceId = platform + ':CCL1234567890J0012345678' + (manual ? '8' : '9');
  const jobId = Number(db.prepare("INSERT INTO jobs(source,source_id,title,company,description,first_seen_at,last_seen_at) VALUES (?,?,'同名岗位','合成公司','只有一小段资料',?,?)").run(platform, sourceId, NOW, NOW).lastInsertRowid);
  const cardId = Number(db.prepare("INSERT INTO candidate_progress_cards(profile_id,plan_id,job_id,source,stage,next_action,last_event_at,created_at,updated_at) VALUES (?,?,?,?,'reply_ready','人工确认',?,?,?)").run(profileId, planId, jobId, platform, NOW, NOW, NOW).lastInsertRowid);
  const key = digest(sourceId);
  const drafts = manual ? [] : storage.recordMessageReplyDrafts(db, { profileId,cardId,jobId,messageGroupKey:key,messageIntent:'information_request',messageCategory:'other',questionSummary:'确认沟通',messages:['好的，可以沟通。'],createdAt:NOW });
  storage.saveMessageInboundContext(db, { platform,profileId,cardId,messageGroupKey:key,conversationKey:digest('conversation'+sourceId),sourceJobId:sourceId,lastMessageId:'378917037748741',messageIntent:manual?'manual_review':'information_request',messageCategory:'other',inboundMessages:[{kind:manual?'resume_request':'text',text:manual?'HR 邀请你发送简历':platform+' 原始问题'}],manualActions:manual?[{kind:'resume_request'}]:[],createdAt:NOW,updatedAt:NOW });
  return {cardId,jobId,drafts,key};
}
async function settle(controller, profileId) { for(let i=0;i<100;i++){if(controller.status(profileId).status!=='running')return controller.pageState(profileId);await new Promise(r=>setTimeout(r,5));}throw Error('discovery did not settle'); }
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'roleflow-unified-'));
  const dbPath = path.join(root,'fixture.sqlite');
  const db = storage.openDb(dbPath);
  let server, browser;const controllers=[];
  try {
    const profileId = Number(db.prepare("INSERT INTO candidate_profiles(display_name,profile_json,created_at,updated_at) VALUES ('合成候选人','{}',?,?)").run(NOW,NOW).lastInsertRowid);
    const planId = Number(db.prepare("INSERT INTO search_plans(profile_id,name,plan_json,is_active,created_at,updated_at) VALUES (?,'合成计划','{}',1,?,?)").run(profileId,NOW,NOW).lastInsertRowid);
    const boss = seed(db,'boss',profileId,planId);
    const zl = seed(db,'zhaopin',profileId,planId);
    const manual = seed(db,'zhaopin',profileId,planId,true);
    let nativeScans=0,nativeBossGuards=0,nativeActive=0,nativeMax=0,nativePlatforms=['zhaopin'];const nativeOrder=[];
    const nativeController=createMessageDiscoveryController({db,acquireLease:storage.acquireSiteScanLease,renewLease:storage.renewSiteScanLease,releaseLease:storage.releaseSiteScanLease,
      createBrowser:()=>({listTabs:async()=>nativePlatforms.map((platform,index)=>({id:index+1,windowId:1,url:platform==='boss'?'https://www.zhipin.com/web/geek/chat':'https://i.zhaopin.com/im'}))}),
      assertRuntimeAvailable:()=>{nativeBossGuards++;},createReader:({platform})=>({async scanConversationRows(){assert(nativeController.status(profileId).platformRuns.every(entry=>['not_connected','running','completed','stopped','needs_user_action'].includes(entry.status)));nativeScans++;nativeOrder.push(platform);nativeActive++;nativeMax=Math.max(nativeMax,nativeActive);await new Promise(resolve=>setTimeout(resolve,1));nativeActive--;return {platform,rows:[]};}}),createAnalyzer:()=>async()=>({}),createDetailSafety:()=>({}),createDetailReader:()=>({}),createJobContextResolver:()=>async()=>({})});
    controllers.push(nativeController);nativeController.start(profileId);await settle(nativeController,profileId);assert.equal(nativeScans,1,'shared production pipeline reaches the ZL reader');assert.equal(nativeBossGuards,0);
    nativePlatforms=['zhaopin','boss'];nativeController.start(profileId);await settle(nativeController,profileId);assert.deepEqual(nativeOrder,['zhaopin','boss','zhaopin']);assert.equal(nativeMax,1,'production pipelines must never overlap browser reads');await nativeController.close();
    let bossReadCalls=0,zhaopinReadCalls=0,operations=0,maxOperations=0,cleanup=0;
    let connected=['zhaopin']; const order=[];
    const deps={db,acquireLease:storage.acquireSiteScanLease,renewLease:storage.renewSiteScanLease,releaseLease:storage.releaseSiteScanLease,
      createBrowser:()=>({listTabs:async()=>connected.map((p,i)=>({id:i+1,windowId:1,url:p==='boss'?'https://www.zhipin.com/web/geek/chat':'https://i.zhaopin.com/im'}))}),
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
    deps.waitSecond=true;controller.start(profileId);while(order.length<4)await new Promise(r=>setTimeout(r,5));controller.stop(profileId);result=await settle(controller,profileId);
    assert.equal(result.results[0].cardId,boss.cardId);assert(storage.getMessageReplyDraft(db,{profileId,draftId:boss.drafts[0].id}));
    deps.waitSecond=false;connected=['boss'];controller.start(profileId);result=await settle(controller,profileId);
    assert.equal(result.results[0].cardId,boss.cardId);assert.equal(result.platformRuns.find(r=>r.platform==='zhaopin').status,'not_connected');
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
    recordUnresolvedMessageDiscoveryItem(db,{profileId,platform:'zhaopin',conversationKey:digest('pending'),previewDigest:digest('pendingpreview'),previewKind:'possible_hr_reply',observedAt:NOW,sourceJobId:'zhaopin:CCL1234567890J00123456789',lastMessageId:'101',reasonCode:'ZHAOPIN_MESSAGE_CONTENT_PENDING',positionTitle:'待加载岗位',company:'合成公司',inboundMessages:[{kind:'text',text:'已读到的原始问题'}]});
    let httpBrowserCalls=0,httpBossCalls=0,httpReaderCalls=0;
    server=createDashboardServer({db,dbPath,root,dataRoot:root,forceMock:true,logger,browserAuthority:{browserMode:'portable',cdpPort:9222,profilePath:path.join(root,'profile')},
      browserFactory:()=>{httpBrowserCalls++;return {listTabs:async()=>[{id:2,windowId:1,url:'https://i.zhaopin.com/im'}]};},
      messageDiscoveryDependencies:{assertRuntimeAvailable:()=>{httpBossCalls++;},createAnalyzer:()=>async()=>({}),createReader:()=>({async scanConversationRows(signal){httpReaderCalls++;await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));return {platform:'zhaopin',rows:[]};}})}});
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
    const zlCard=page.locator('[data-message-detail-panel][data-platform="zhaopin"]').filter({has:page.locator('[data-draft-text]')});assert.equal(await zlCard.locator('[data-send-single], [data-send-select], [data-sent-draft]').count(),0);assert.equal(await zlCard.locator('[data-copy-draft]').count(),1);
    const manualCard=page.locator('[data-message-detail-panel][data-platform="zhaopin"]').filter({hasNot:page.locator('[data-draft-text]')});assert.match(await manualCard.textContent(),/HR 邀请你发送简历/);assert.match(await manualCard.textContent(),/智联原始会话/);assert.equal(await manualCard.locator('button,form').count(),0);
    assert.equal(await page.locator('[data-send-select]').count(),1,'only the BOSS draft enters the batch selection');
    assert.equal(await page.locator('.message-list-item[data-platform="boss"]').count(),1);assert.equal(await page.locator('.message-list-item[data-platform="zhaopin"]').count(),2);
    const pending=page.locator('.message-unresolved[data-platform="zhaopin"]');assert.match(await pending.innerText(),/已读到的原始问题/);assert.equal(await pending.locator('form').count(),0);
    const filter=page.getByLabel('消息来源');await filter.selectOption('zhaopin');await page.waitForFunction(()=>document.querySelector('[data-source-filter]').value==='zhaopin'&&document.querySelector('.message-list-item[data-platform="boss"]').hidden);
    const field=zlCard.locator('[data-draft-text]');await field.fill('可以的，我们继续沟通。');await filter.selectOption('boss');await page.waitForFunction(()=>document.querySelector('.message-list-item[data-platform="zhaopin"]').hidden);
    await page.reload();assert.equal(await filter.inputValue(),'boss');await filter.selectOption('zhaopin');await zlCard.waitFor({state:'visible'});assert.equal(await field.inputValue(),'可以的，我们继续沟通。');assert.equal(await page.locator('[data-send-batch-panel]').isVisible(),false);
    await zlCard.locator('[data-copy-draft]').click();await page.waitForFunction(()=>document.querySelector('[data-discovery-feedback]').textContent.includes('记住')||document.querySelector('[data-discovery-feedback]').textContent.includes('已复制'));assert.equal(db.prepare('SELECT COUNT(*) n FROM candidate_progress_events').get().n,before);
    let failSave=true;await page.route('**/api/message-reply-draft',route=>failSave?route.fulfill({status:500,contentType:'application/json',body:'{"errorCode":"SAVE_FAILED"}'}):route.continue());await field.fill('保存失败时保留的回答');await filter.selectOption('boss');await page.waitForFunction(()=>document.querySelector('[data-discovery-feedback]').textContent.includes('保存'));assert.equal(await filter.inputValue(),'zhaopin');assert.equal(await field.inputValue(),'保存失败时保留的回答');assert.equal(await zlCard.isVisible(),true);failSave=false;
    const evidence='D:/DevData/RoleFlow-zhaopin-messages-20260908';fs.mkdirSync(evidence,{recursive:true});for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:path.join(evidence,'unified-messages-'+width+'.png'),fullPage:true});}
    await filter.focus();assert.equal(await filter.evaluate(e=>e===document.activeElement),true);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM candidate_answer_memories WHERE profile_id=? AND final_text=? AND completion_kind='copied'").get(profileId,'可以的，我们继续沟通。').n,1,'edited copy teaches the answer without sent progress');
    assert.equal(httpBrowserCalls,0,'source filtering and copying cannot start discovery');
    db.prepare("UPDATE candidate_progress_cards SET source='unknown' WHERE id=?").run(boss.cardId);
    const unknownPage=await context.newPage();await unknownPage.goto(base+'/messages?profileId='+profileId);const unknownCard=unknownPage.locator('[data-message-detail-panel][data-platform=""]');assert.equal(await unknownCard.count(),1);assert.equal(await unknownCard.locator('[data-send-single], [data-send-select], [data-sent-draft]').count(),0);await unknownPage.close();db.prepare("UPDATE candidate_progress_cards SET source='boss' WHERE id=?").run(boss.cardId);
    await today.click();await page.waitForURL('**/plan?**');assert.equal(new URL(page.url()).searchParams.get('site'),'zhaopin');
    const dismiss=await fetch(base+'/api/message-discovery',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'dismiss',profileId})});assert.equal(dismiss.status,200);
    const cleared=createMessageDiscoveryController({db});assert.equal(cleared.pageState(profileId).results.length,0);assert.equal(storage.listMessageInboundContexts(db,{profileId}).length,0);assert.equal(cleared.pageState(profileId).unresolved,1,'dismiss preserves unprocessed pending messages');await cleared.close();
    await page.getByRole('link',{name:'消息与回复',exact:true}).click();await page.getByLabel('消息来源').selectOption('boss');await page.locator('[data-source-empty]').waitFor({state:'visible'});assert.equal(await page.locator('[data-message-view]:checked').count(),0);
    await page.getByRole('button',{name:'开始只读发现',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('button[data-page-primary]')||document.querySelector('button[data-page-primary]').disabled);await page.getByRole('button',{name:'安全停止',exact:true}).waitFor({state:'visible'});
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('form[data-discovery-form]')).find(form=>form.querySelector('[name=action]').value==='stop').querySelector('button').disabled===false);
    assert.match(await page.locator('main').innerText(),/正在加载并读取消息/);assert.equal(httpBossCalls,0);assert.equal(httpReaderCalls,1);
    await page.getByRole('button',{name:'安全停止',exact:true}).click();await page.waitForFunction(()=>Array.from(document.querySelectorAll('form[data-discovery-form]')).find(form=>form.querySelector('[name=action]').value==='start').querySelector('button').disabled===false);assert.equal(httpBrowserCalls,1);
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    console.log('dashboard_unified_messages_journey ok: serial discovery, restore, source-safe HTTP/UI, autosave, navigation, 1440/390');
  }finally{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));for(const controller of controllers)await controller.close();db.close();fs.rmSync(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});

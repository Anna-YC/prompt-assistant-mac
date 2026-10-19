'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const { defaultConfig } = require('../lib/config');
const { Store } = require('../lib/store');
const feishu = require('../lib/feishu');
const { createCloudPromptService } = require('../lib/cloud-prompts');
const root = path.join(__dirname, '..');
const output = path.join(root, 'output', 'playwright', 'cloud');
fs.mkdirSync(output, { recursive: true });
const statePath = path.join(output, 'remote-records.json');
const delayReadPath = path.join(output, 'delay-read');
const readStartedPath = path.join(output, 'read-started');
const cli = path.join(output, 'cloud-cli.js');
const source = { id:'common',tableId:'tblCommonFixture',name:'常用提示词库',kind:'prompt',enabled:true,mapping:{title:'提示词用途',content:'提示词'} };
const newStore = name => {
  const store = new Store(path.join(output, name));
  store.config = { ...defaultConfig(), baseToken:'fixture', sources:[{...source}], local:{prompt:[],phrase:[]} };
  store.cache = {prompts:[],phrases:[],tables:[]}; store.stats = {};
  return store;
};
const input = (requestId, extra = {}) => ({requestId,sourceId:source.id,title:'常用提示词',content:'正文',pinned:true,...extra});

(async () => {
  fs.writeFileSync(statePath, '[]');
  for (const file of [delayReadPath, readStartedPath]) if (fs.existsSync(file)) fs.unlinkSync(file);
  // The fake CLI enforces the same relative @file contract as lark-cli.
  fs.writeFileSync(cli, `const fs=require('fs'),path=require('path');const state=${JSON.stringify(statePath)};
const records=JSON.parse(fs.readFileSync(state,'utf8'));const args=process.argv.slice(2);
const output=data=>console.log(JSON.stringify({ok:true,data}));
if(args.includes('+field-list')) output({fields:[{name:'提示词用途',type:'text'},{name:'提示词',type:'text'}]});
else if(args.includes('+record-batch-create')) {
 const ref=args[args.indexOf('--json')+1];if(!ref.startsWith('@')||path.isAbsolute(ref.slice(1)))throw Error('unsafe file path');
 const row=JSON.parse(fs.readFileSync(ref.slice(1),'utf8')).create_records[0];
 if(row['提示词用途']==='FAIL'){console.error(JSON.stringify({ok:false,error:{message:'没有编辑权限'}}));process.exit(1);}
 const record={recordId:'recCloud'+(records.length+1),cells:row,file:path.resolve(ref.slice(1)),args};records.push(record);fs.writeFileSync(state,JSON.stringify(records));
 setTimeout(()=>output({record_id_list:[record.recordId]}),150);
} else if(args.includes('+record-list')) {
 const data={fields:['提示词用途','提示词'],data:records.map(r=>[r.cells['提示词用途'],r.cells['提示词']]),record_id_list:records.map(r=>r.recordId),has_more:false};
 if(fs.existsSync(${JSON.stringify(delayReadPath)})){fs.unlinkSync(${JSON.stringify(delayReadPath)});fs.writeFileSync(${JSON.stringify(readStartedPath)},'started');setTimeout(()=>output(data),1600);}else output(data);
}
else throw Error('Unexpected fake CLI command');`);
  const body = '请保留 "双引号"、\'单引号\'、$变量、反引号 \u0060 和 & | < > ; 符号。\n第二行：中文提示词';
  const actual = await feishu.createPrompt({baseToken:'fixture',larkCliPath:cli},source,{title:'原样保存',content:body});
  const written = JSON.parse(fs.readFileSync(statePath));
  assert.equal(written[0].cells['提示词'],body);
  assert(!written[0].args.some(arg=>arg.includes(body)));
  assert(!fs.existsSync(written[0].file)); assert(!fs.existsSync(path.dirname(written[0].file)));
  assert.equal(actual.recordId,'recCloud1'); assert(actual.desktopCreatedAt>0);
  console.log('PASS: real writer uses relative private JSON files, preserves arbitrary text, confirms record IDs and removes temporary data.');

  let calls = 0, active = 0, maxActive = 0;
  const store = newStore('unit');
  const service = createCloudPromptService({store,feishu:{createPrompt:async(_cfg,src,data)=>{
    calls++; active++; maxActive=Math.max(maxActive,active); await new Promise(r=>setTimeout(r,20)); active--;
    if(data.title==='FAIL')throw Error('没有编辑权限');
    return {id:src.id+':rec'+calls,recordId:'rec'+calls,sourceId:src.id,tableName:src.name,title:data.title,content:data.content,createdAt:Date.now(),desktopCreatedAt:Date.now(),origin:'feishu'};
  }}});
  const [first, duplicate] = await Promise.all([service.create(input('request-one')), service.create(input('request-one'))]);
  assert.equal(calls,1); assert.equal(first.item.id,duplicate.item.id);
  assert(store.getView().prompts.find(item=>item.id===first.item.id).pinned);
  store.togglePin(first.item.id); assert(!store.getView().prompts.find(item=>item.id===first.item.id).pinned);
  await Promise.all([service.create(input('request-two')),service.create(input('request-three'))]); assert.equal(maxActive,1);
  store.config.sources.push({...source,id:'image',name:'生图提示词-人物'});
  assert.equal(service.targets().sources.length,1);
  await assert.rejects(service.create(input('request-invalid',{sourceId:'image'})));
  store.config.local={prompt:[{id:'local1',title:'迁移成功',content:'旧正文',pinned:true},{id:'local2',title:'FAIL',content:'保留正文'}],phrase:[]};
  store.config.tray.pinnedIds.push('local1'); store.stats.local1={count:9,lastAt:100};
  const migrated=await service.migrate({sourceId:source.id});
  assert.equal(migrated.ok,false); assert.equal(migrated.saved,1); assert.equal(store.listLocal('prompt').length,1); assert.equal(store.listLocal('prompt')[0].id,'local2');
  const moved=store.cache.prompts.find(item=>item.title==='迁移成功');
  assert.equal(store.stats[moved.id].count,9); assert(store.config.tray.pinnedIds.includes(moved.id)); assert(!store.config.tray.pinnedIds.includes('local1'));
  const saveCache=store.saveCache.bind(store); store.saveCache=()=>{throw Error('disk failure');};
  const saved=await service.create(input('request-cache-failure')); assert(saved.ok&&saved.warning);
  const count=calls; await service.create(input('request-cache-failure')); assert.equal(calls,count); store.saveCache=saveCache;
  console.log('PASS: duplicate-submit guard, serial writes, target validation, partial migration with pin/stat preservation, and acknowledged cloud saves despite cache failures.');

  fs.writeFileSync(statePath,'[]');
  const env={...process.env,GALLERY_TEST_CLOUD_CLI:cli}; delete env.ELECTRON_RUN_AS_NODE; delete env.PREVIEW_SETTINGS;
  const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[path.join(__dirname,'gallery-test-app.cjs')],env});
  const errors=[];app.on('window',p=>p.on('pageerror',e=>errors.push(e.message)));
  try {
    const panel=await app.firstWindow();panel.setDefaultTimeout(8000);
    await panel.waitForFunction(()=>document.querySelectorAll('.card').length>0);
    await panel.evaluate(()=>window.api.requestExpand(false));
    await panel.waitForFunction(()=>getComputedStyle(document.querySelector('#panel')).opacity==='1');
    await app.evaluate(({BrowserWindow})=>{const b=BrowserWindow.getAllWindows()[0].getBounds();global.galleryTestCursor={x:b.x+100,y:b.y+200};});
    await panel.locator('#btnNewPrompt').click();
    await panel.locator('#promptComposer').waitFor();
    await panel.waitForFunction(()=>!document.querySelector('#saveCloudPrompt').disabled);
    assert.equal(await panel.locator('#promptSource').inputValue(),'common');
    await app.evaluate(()=>{global.galleryTestCursor={x:-10000,y:-10000};});
    await panel.evaluate(()=>window.api.autoCollapse());
    assert((await panel.evaluate(()=>window.api.getPanelState())).expanded);
    await app.evaluate(({BrowserWindow})=>{const b=BrowserWindow.getAllWindows()[0].getBounds();global.galleryTestCursor={x:b.x+100,y:b.y+200};});
    await panel.locator('#promptTitle').fill('桌面新增');await panel.locator('#promptContent').fill(body);
    await panel.screenshot({path:path.join(output,'composer.png')});
    await panel.locator('#saveCloudPrompt').click();
    await panel.locator('#promptComposer').waitFor({state:'hidden'});
    assert.equal(JSON.parse(fs.readFileSync(statePath)).length,1);
    let record=(await panel.evaluate(()=>window.api.getData())).view.prompts.find(item=>item.title==='桌面新增');
    assert(record&&record.origin==='feishu'&&record.pinned&&record.content===body);
    await panel.evaluate(()=>window.api.requestExpand(true));
    await panel.evaluate(()=>window.api.syncNow());
    record=(await panel.evaluate(()=>window.api.getData())).view.prompts.find(item=>item.title==='桌面新增');
    assert(record&&record.createdAt>0&&record.desktopCreatedAt>0);
    await panel.locator('#btnNewPrompt').click();
    await panel.waitForFunction(()=>!document.querySelector('#saveCloudPrompt').disabled);
    await panel.locator('#promptTitle').fill('FAIL');await panel.locator('#promptContent').fill('失败时保留这段内容');
    await panel.locator('#saveCloudPrompt').click();
    await panel.waitForFunction(()=>document.querySelector('#composerMessage').textContent.includes('没有编辑权限'));
    assert.equal(await panel.locator('#promptContent').inputValue(),'失败时保留这段内容');
    assert.equal(JSON.parse(fs.readFileSync(statePath)).length,1);
    await panel.locator('#composerCancel').click();
    await panel.locator('#btnNewPrompt').click();
    await panel.waitForFunction(()=>!document.querySelector('#saveCloudPrompt').disabled);
    assert.equal(await panel.locator('#promptContent').inputValue(),'失败时保留这段内容');
    await panel.locator('#promptTitle').fill('修正后保存');
    await panel.locator('#saveCloudPrompt').click();await panel.locator('#promptComposer').waitFor({state:'hidden'});
    assert.equal(JSON.parse(fs.readFileSync(statePath)).length,2);
    assert((await panel.evaluate(()=>window.api.getPanelState())).expanded);
    fs.writeFileSync(delayReadPath,'delay');
    await panel.evaluate(()=>{window.cloudSyncPromise=window.api.syncNow();});
    for(let attempt=0;attempt<100&&!fs.existsSync(readStartedPath);attempt++)await new Promise(resolve=>setTimeout(resolve,20));
    assert(fs.existsSync(readStartedPath),'Concurrent sync must capture its old snapshot before creating the next item');
    await panel.locator('#btnNewPrompt').click();await panel.waitForFunction(()=>!document.querySelector('#saveCloudPrompt').disabled);
    await panel.locator('#promptTitle').fill('同步期间新增');await panel.locator('#promptContent').fill('同步结束后不能丢失');
    await panel.locator('#promptContent').press('Control+Enter');await panel.locator('#promptComposer').waitFor({state:'hidden'});
    assert.equal(JSON.parse(fs.readFileSync(statePath)).length,3);
    await panel.evaluate(()=>window.cloudSyncPromise);
    assert((await panel.evaluate(()=>window.api.getData())).view.prompts.some(item=>item.title==='同步期间新增'));
    await panel.evaluate(()=>window.api.syncNow());
    assert((await panel.evaluate(()=>window.api.getData())).view.prompts.some(item=>item.title==='同步期间新增'));
    await panel.locator('#btnNewPrompt').click();await panel.waitForFunction(()=>!document.querySelector('#saveCloudPrompt').disabled);
    await panel.locator('#migratePrompts').click();
    await panel.waitForFunction(()=>document.querySelector('#composerMessage').textContent==='旧条目已同步到飞书。');
    assert.equal((await panel.evaluate(()=>window.api.getConfig())).local.phrase.length,0);
    await panel.locator('#composerCancel').click();
    const settingsOpened=app.waitForEvent('window');await panel.locator('#btnSettings').click();const settings=await settingsOpened;
    await settings.waitForSelector('#tab-source');assert.equal(await settings.locator('#btnAddPrompt').count(),0);assert.equal(await settings.locator('#btnAddPhrase').count(),0);
    assert.deepEqual(errors,[]);
    console.log('PASS: actual sidebar form saves to cloud, prevents automatic collapse, retains failed/cancelled drafts, supports Ctrl+Enter, survives concurrent sync and migrates legacy snippets. Settings no longer create local items.');
  } finally {await app.close();}

  delete env.GALLERY_TEST_CLOUD_CLI;
  const disconnected=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[path.join(__dirname,'gallery-test-app.cjs')],env});
  try {
    const panel=await disconnected.firstWindow();panel.setDefaultTimeout(8000);
    await panel.waitForFunction(()=>document.querySelectorAll('.card').length>0);
    await panel.evaluate(()=>window.api.requestExpand(true));
    await panel.waitForFunction(()=>getComputedStyle(document.querySelector('#panel')).opacity==='1');
    await panel.locator('#btnNewPrompt').click();
    await panel.locator('#composerSettings').waitFor();
    assert(await panel.locator('#saveCloudPrompt').isDisabled());assert(await panel.locator('#migratePrompts').isDisabled());
    await panel.evaluate(()=>window.api.setConfig({appearance:{theme:'dark'}}));
    await disconnected.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setBounds({width:320,height:520}));
    await panel.screenshot({path:path.join(output,'composer-small-dark.png')});
    const layout=await panel.evaluate(()=>({width:innerWidth,height:innerHeight,body:document.querySelector('#promptComposer').getBoundingClientRect().toJSON(),save:document.querySelector('#saveCloudPrompt').getBoundingClientRect().toJSON()}));
    assert(layout.body.x>=0&&layout.body.right<=layout.width&&layout.body.y>=0&&layout.body.bottom<=layout.height);
    assert(layout.save.bottom<=layout.height,'Save controls remain visible in a short window');
    await panel.keyboard.press('Escape');await panel.locator('#promptComposer').waitFor({state:'hidden'});
    console.log('PASS: disconnected setup prevents cloud writes and explains setup; the dialog supports short/narrow dark windows and native Escape.');
  } finally {await disconnected.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

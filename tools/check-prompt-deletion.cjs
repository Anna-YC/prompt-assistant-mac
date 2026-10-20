'use strict';
// Real Electron/IPC/CLI flow, entirely isolated from user data and Feishu.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const { Store } = require('../lib/store');
const root = path.join(__dirname, '..'), output = path.join(root, 'output/playwright/delete');
fs.mkdirSync(output, { recursive: true });
const stateFile = path.join(output, 'remote.json'), itemsFile = path.join(output, 'items.json'), cli = path.join(output, 'delete-cli.js');
const delayFile = path.join(output, 'delay'), startedFile = path.join(output, 'started'), releaseFile = path.join(output, 'release');
for (const file of [delayFile, startedFile, releaseFile]) if (fs.existsSync(file)) fs.unlinkSync(file);
const record = (recordId, title) => ({ recordId, cells: { 标题: title, 正文: title + '的正文' } });
const read = () => JSON.parse(fs.readFileSync(stateFile));
function change(fn) { const state = read(); fn(state); fs.writeFileSync(stateFile, JSON.stringify(state)); }
const old = record('recOld', '旧版新增后在飞书删除');
fs.writeFileSync(stateFile, JSON.stringify({ records: [], next: 1, mode: 'normal' }));
fs.writeFileSync(itemsFile, JSON.stringify([{ id: 'common:recOld', sourceId: 'common', tableId: 'tblCommonFixture', recordId: 'recOld', title: old.cells.标题,
  content: old.cells.正文, tableName: '常用提示词库', desktopCreatedAt: Date.now(), cloudPendingUntil: Date.now() + 300000 }]));
fs.writeFileSync(cli, `const fs=require('fs'),path=require('path');const file=${JSON.stringify(stateFile)},args=process.argv.slice(2);
const state=JSON.parse(fs.readFileSync(file));const save=()=>fs.writeFileSync(file,JSON.stringify(state));
const out=data=>console.log(JSON.stringify({ok:true,data}));const fail=message=>{console.log(JSON.stringify({ok:false,error:{message}}));process.exitCode=1;};
const payload=()=>{const ref=args[args.indexOf('--json')+1];if(!ref.startsWith('@')||path.isAbsolute(ref.slice(1)))throw Error('Expected relative private JSON file');state.lastTemp=path.resolve(ref.slice(1));return JSON.parse(fs.readFileSync(ref.slice(1)));};
if(args.includes('+field-list'))out({fields:[{name:'标题',type:'text'},{name:'正文',type:'text'}]});
else if(args.includes('+record-batch-create')){const cells=payload().create_records[0],id='recNew'+state.next++;state.records.push({recordId:id,cells:{标题:cells['标题']||cells['提示词用途'],正文:cells['正文']||cells['提示词']}});save();out({record_id_list:[id]});}
else if(args.includes('+record-delete')){
 const ids=payload().record_id_list;if(!args.includes('--yes'))throw Error('Missing explicit delete confirmation');
 if(state.mode==='offline'){fail('网络不可用，删除未完成');}
 else {const before=state.records;state.deletes=(state.deletes||0)+1;state.records=state.records.filter(row=>!ids.includes(row.recordId)||(state.mode==='partial'&&row.cells.标题.includes('失败保留')));
 if(state.mode==='stale'){state.staleRecords=before;state.lagReads=2;}save();out({record_id_list:ids.filter(id=>!state.records.some(row=>row.recordId===id))});}
}else if(args.includes('+record-list')){
 if(state.mode==='offline')fail('网络不可用');
 else if(state.mode==='bad-page')out({fields:['标题','正文'],data:[],record_id_list:[],has_more:true});
 else {const rows=state.lagReads>0?state.staleRecords:state.records;if(state.lagReads>0){state.lagReads--;save();}const data={fields:['标题','正文'],data:rows.map(row=>[row.cells.标题,row.cells.正文]),record_id_list:rows.map(row=>row.recordId),has_more:false};
  if(fs.existsSync(${JSON.stringify(delayFile)})){fs.unlinkSync(${JSON.stringify(delayFile)});fs.writeFileSync(${JSON.stringify(startedFile)},'1');const started=Date.now();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseFile)})){clearInterval(timer);out(data);}else if(Date.now()-started>12000){clearInterval(timer);fail('Fixture read timed out');}},15);}else out(data);
 }
}else throw Error('Unexpected command');`);

(async () => {
  const env = { ...process.env, GALLERY_TEST_CLOUD_CLI: cli, GALLERY_TEST_ITEMS: itemsFile };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PREVIEW_SETTINGS;
  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(__dirname, 'gallery-test-app.cjs')], env });
  const errors = []; app.on('window', page => page.on('pageerror', error => errors.push(error.message)));
  try {
    const panel = await app.firstWindow(); panel.setDefaultTimeout(10000);
    await panel.waitForSelector('[data-id="common:recOld"]');
    await panel.evaluate(() => window.api.requestExpand(true));
    await panel.waitForFunction(() => getComputedStyle(document.querySelector('#panel')).opacity === '1');
    await app.evaluate(({ BrowserWindow }) => { const bounds = BrowserWindow.getAllWindows()[0].getBounds(); global.galleryTestCursor = { x: bounds.x + 100, y: bounds.y + 180 }; });
    await panel.evaluate(() => window.api.syncNow());
    assert(!(await panel.evaluate(() => window.api.getData())).view.prompts.some(item => item.id === 'common:recOld'));
    // Writer mapping uses alternate text fields; the fake CLI presents those when creating.
    const created = await panel.evaluate(async () => {
      await window.api.setConfig({ sources: [{ id: 'common', tableId: 'tblCommonFixture', name: '常用提示词库', kind: 'prompt', enabled: true, mapping: { title: '标题', content: '正文' } }] });
      return window.api.createCloudPrompt({ sourceId: 'common', requestId: 'delete-regression-create', title: '桌面刚新增', content: '远端删除后应立即消失' });
    });
    assert(created.ok, JSON.stringify(created));
    change(state => { state.records = state.records.filter(item => item.recordId !== created.item.recordId); });
    await panel.evaluate(() => window.api.syncNow());
    assert(!(await panel.evaluate(() => window.api.getData())).view.prompts.some(item => item.id === created.item.id));
    console.log('PASS: old five-minute metadata and freshly desktop-created records disappear on the first complete successful sync after remote deletion.');

    change(state => { state.records = [record('recA', '单条删除'), record('recB', '批量删除一'), record('recC', '批量失败保留'), record('recD', '应当保留')]; });
    await panel.evaluate(() => window.api.syncNow());
    const previewReady = app.waitForEvent('window', { predicate: page => page.url().endsWith('/preview.html') });
    await panel.evaluate(() => window.api.showPreview({ id: 'common:recA', top: 150 }));
    const preview = await previewReady;
    await preview.locator('#previewDelete').click();
    await panel.locator('#promptDeleteDialog').waitFor();
    assert((await panel.evaluate(() => window.api.getPanelState())).composing);
    await panel.keyboard.press('Escape');
    assert(read().records.some(item => item.recordId === 'recA'));
    await panel.evaluate(() => window.api.requestPromptDeletion('common:recA'));
    change(state => { state.mode = 'stale'; });
    await panel.locator('#promptDeleteConfirm').click();
    await panel.locator('#promptDeleteDialog').waitFor({ state: 'hidden' });
    assert(!read().records.some(item => item.recordId === 'recA'));
    assert(!fs.existsSync(read().lastTemp));
    assert(!(await panel.evaluate(() => window.api.getData())).view.prompts.some(item => item.id === 'common:recA'));
    assert.equal(read().deletes, 1);
    assert.equal(read().lagReads, 2, 'Acknowledged deletion must not depend on an immediate list read');
    for (let count = 0; count < 2; count++) {
      await panel.evaluate(() => window.api.syncNow());
      assert(!(await panel.evaluate(() => window.api.getData())).view.prompts.some(item => item.id === 'common:recA'));
      assert(Object.keys((await panel.evaluate(() => window.api.getConfig())).promptDeletions).length > 0);
    }
    change(state => { state.mode = 'normal'; });
    console.log('PASS: single delete from the side preview, explicit confirmation/cancel, matching remote deletion, and private temporary file cleanup.');
    console.log('PASS: successful receipt closes the dialog on the first attempt; two stale subsequent syncs cannot revive the deleted row.');

    fs.writeFileSync(delayFile, '1');
    await panel.evaluate(() => { window.pendingSyncForDelete = window.api.syncNow(); });
    for (let count = 0; count < 200 && !fs.existsSync(startedFile); count++) await new Promise(resolve => setTimeout(resolve, 15));
    assert(fs.existsSync(startedFile));
    change(state => { state.mode = 'partial'; });
    await panel.locator('#search').fill('批量');
    await panel.waitForFunction(() => document.querySelector('#resultCount').textContent === '2 条');
    await panel.locator('#btnManagePrompts').click();
    await panel.locator('.prompt-select-all').check();
    assert.equal(await panel.locator('.prompt-selection-count').textContent(), '已选 2 / 2');
    await panel.screenshot({ path: path.join(output, 'selection-light.png') });
    await panel.locator('.prompt-delete-selected').click();
    assert((await panel.locator('#promptDeleteDescription').textContent()).includes('2 条会同时删除飞书'));
    await panel.locator('#promptDeleteConfirm').click();
    await panel.waitForFunction(() => document.querySelector('#promptDeleteConfirm').textContent === '重试失败项');
    assert(!read().records.some(item => item.recordId === 'recB'));
    assert(read().records.some(item => item.recordId === 'recC'));
    assert.equal(await panel.locator('#promptDeleteItems li').count(), 1);
    await panel.screenshot({ path: path.join(output, 'partial-delete.png') });
    change(state => { state.mode = 'normal'; });
    await panel.locator('#promptDeleteConfirm').click();
    await panel.locator('#promptDeleteDialog').waitFor({ state: 'hidden' });
    fs.writeFileSync(releaseFile, '1');
    await panel.evaluate(() => window.pendingSyncForDelete);
    let view = (await panel.evaluate(() => window.api.getData())).view;
    assert(!view.prompts.some(item => ['recA', 'recB', 'recC'].includes(item.recordId)));
    assert(view.prompts.some(item => item.recordId === 'recD'));
    const profile = path.join(root, 'output/playwright/gallery-profile');
    const restarted = new Store(profile);
    restarted.cache.prompts.push({ id: 'common:recB', tableId: 'tblCommonFixture', recordId: 'recB', title: '旧缓存', content: '旧正文' });
    assert(!restarted.getView().prompts.some(item => item.recordId === 'recB'));
    assert(Object.keys(restarted.config.promptDeletions).length >= 2);
    await panel.evaluate(() => window.api.syncNow());
    assert.equal(Object.keys((await panel.evaluate(() => window.api.getConfig())).promptDeletions).length, 0);
    console.log('PASS: filtered bulk selection, per-record partial failure/retry, stale in-flight sync rejection, restart protection and safe deletion-marker cleanup.');

    await panel.locator('#search').fill('');
    await panel.locator('#btnManagePrompts').click();
    change(state => { state.mode = 'bad-page'; });
    const incomplete = await panel.evaluate(() => window.api.syncNow());
    assert(!incomplete.ok);
    assert((await panel.evaluate(() => window.api.getData())).view.prompts.some(item => item.recordId === 'recD'));
    change(state => { state.mode = 'offline'; });
    await panel.evaluate(() => window.api.requestPromptDeletion('common:recD'));
    await panel.locator('#promptDeleteConfirm').click();
    await panel.waitForFunction(() => document.querySelector('#promptDeleteMessage').textContent.includes('网络不可用'));
    assert((await panel.evaluate(() => window.api.getData())).view.prompts.some(item => item.recordId === 'recD'));
    await panel.locator('#promptDeleteCancel').click();
    change(state => { state.mode = 'normal'; });
    await panel.evaluate(() => window.api.setConfig({ appearance: { theme: 'dark' }, panel: { width: 320 } }));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith('/panel.html')).setBounds({ width: 320, height: 520 }));
    await panel.evaluate(() => window.api.requestPromptDeletion('common:recD'));
    await panel.locator('#promptDeleteDialog').waitFor();
    const bounds = await panel.locator('#promptDeleteDialog').boundingBox();
    assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 320 && bounds.y + bounds.height <= 520);
    await panel.screenshot({ path: path.join(output, 'delete-small-dark.png') });
    await panel.keyboard.press('Escape');
    console.log('PASS: incomplete pagination and offline failures retain existing rows; native confirmation fits a narrow dark window.');

    await panel.evaluate(() => window.api.setConfig({ panel: { width: 384 } }));
    const [settings] = await Promise.all([app.waitForEvent('window'), panel.locator('#btnSettings').click()]);
    await settings.waitForSelector('[data-tab="prompt"]'); await settings.locator('[data-tab="prompt"]').click();
    await settings.locator('#pSearch').fill('应当保留');
    await settings.locator('#promptList .del').click();
    await settings.locator('#promptDeleteCancel').click();
    await settings.locator('#btnManagePrompts').click();
    await settings.locator('.prompt-select-all').check();
    await settings.locator('.prompt-delete-selected').click();
    await settings.locator('#promptDeleteConfirm').click();
    await settings.locator('#promptDeleteDialog').waitFor({ state: 'hidden' });
    assert.equal(read().records.length, 0);
    await settings.locator('#pSearch').fill('');
    assert((await settings.evaluate(() => window.api.getData())).view.prompts.some(item => item.origin === 'local'));
    await settings.locator('#btnManagePrompts').click();
    await settings.locator('#pSearch').fill('电影感光影');
    change(state => { state.mode = 'offline'; });
    await settings.locator('#promptList .del').click();
    assert((await settings.locator('#promptDeleteDescription').textContent()).includes('本机待迁移'));
    await settings.locator('#promptDeleteConfirm').click();
    await settings.locator('#promptDeleteDialog').waitFor({ state: 'hidden' });
    assert.equal((await settings.evaluate(() => window.api.getData())).view.prompts.length, 0);
    assert.deepEqual(errors, []);
    console.log('PASS: settings single delete entry and filtered bulk deletion preserve unrelated local entries; no renderer errors.');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const { syncSource, guessMapping } = require('../lib/feishu');
const { Store } = require('../lib/store');
const { defaultConfig } = require('../lib/config');
const root = path.join(__dirname, '..');
const output = path.join(root, 'output', 'playwright');
fs.mkdirSync(output, { recursive: true });

(async () => {
  const definitions = {
    main: {
      fields: [{name:'标题',type:'text'},{name:'可直接复制提示词',type:'text'},{name:'内容',type:'text'},{name:'使用模型',type:'select'},{name:'添加时间',type:'datetime'}],
      rows: [
        ['image', ['生图预览', '', '剪藏时整理好的生图正文\n保留原始换行。', {name:'测试生图模型 A'}, '2026-10-19T12:00:00+08:00']],
        ['video', ['视频预览', '另一份 AI 生成内容', '剪藏时整理好的视频正文。', ['测试视频模型 B','测试视频模型 C'], '2026-10-19T11:00:00+08:00']],
        ['unknown', ['未标注模型', 'AI 未计算', '没有模型的剪藏正文。', null, '2026-10-19T10:00:00+08:00']],
        ['empty', ['原文为空', '不能回退到这一段 AI 结果', '', '测试模型', '2026-10-19T09:00:00+08:00']],
      ],
    },
    legacy: { fields:[{name:'标题',type:'text'},{name:'提示词',type:'text'}], rows:[['legacy',['旧常用词表','常用词表的普通正文']]] },
    aiOnly: { fields:[{name:'标题',type:'text'},{name:'可直接复制提示词',type:'text'}], rows:[['ai',['只有 AI 列','不应同步成正文']]] },
    custom: { fields:[{name:'标题',type:'text'},{name:'内容',type:'text'},{name:'软件版本',type:'text'}], rows:[['custom',['自定义模型字段','原文','模型 <Beta>']]] },
  };
  const cli = path.join(output, 'model-fixture-cli.js');
  fs.writeFileSync(cli, `const tables=${JSON.stringify(definitions)};
const t=tables[process.argv[process.argv.indexOf('--table-id')+1]];
const d=process.argv.includes('+field-list') ? {fields:t.fields} : {fields:t.fields.map(f=>f.name),data:t.rows.map(r=>r[1]),record_id_list:t.rows.map(r=>r[0]),has_more:false};
console.log(JSON.stringify({data:d}));`);
  const cfg = { baseToken: 'fixture', larkCliPath: cli };
  assert.equal(guessMapping(definitions.main.fields).content, '内容');
  assert.equal(guessMapping(definitions.main.fields).model, '使用模型');
  const items = await syncSource(cfg, { id:'main', tableId:'main', name:'生图提示词-人物', mapping:{content:'可直接复制提示词'} }, output);
  assert.equal(items[0].content, definitions.main.rows[0][1][2]);
  assert.equal(items[1].content, definitions.main.rows[1][1][2]);
  assert.equal(items[3].content, '');
  assert.equal(items[0].model, '测试生图模型 A');
  assert.equal(items[1].model, '测试视频模型 B / 测试视频模型 C');
  assert.equal(items[2].model, '');
  const legacy = await syncSource(cfg, {id:'legacy',tableId:'legacy',name:'常用提示词库'}, output);
  assert.equal(legacy[0].content, '常用词表的普通正文');
  const aiOnly = await syncSource(cfg, {id:'ai',tableId:'aiOnly',name:'常用提示词库',mapping:{content:'可直接复制提示词'}}, output);
  assert.equal(aiOnly[0].content, '');
  const custom = await syncSource(cfg, {id:'custom',tableId:'custom',name:'常用提示词库',mapping:{model:'软件版本'}}, output);
  assert.equal(custom[0].model, '模型 <Beta>');
  const profile = path.join(output,'model-migration-profile'); fs.mkdirSync(profile,{recursive:true});
  const previousConfig=defaultConfig(); previousConfig.sources=[{id:'main',mapping:{content:'可直接复制提示词'}}];
  fs.writeFileSync(path.join(profile,'config.json'),JSON.stringify(previousConfig));
  const store = new Store(profile);
  assert.equal(store.config.sources[0].mapping.content, '内容');
  assert.equal(JSON.parse(fs.readFileSync(store.configPath)).sources[0].mapping.content, '内容');
  store.cache.prompts=items; store.saveCache();
  assert.equal(new Store(profile).getView().prompts[0].model,'测试生图模型 A');
  console.log('PASS: raw content wins over saved AI mappings and empty AI cells, no AI fallback, model normalization, custom model columns, profile migration and cache persistence.');

  const mediaDir = path.join(root,'cache','media');
  const image = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir).find(s=>/\.(png|jpe?g|webp)$/i.test(s)) : null;
  const video = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir).find(s=>/\.mp4$/i.test(s)) : null;
  if (image) items[0].image={fileToken:'fixtureImage',name:image,localPath:path.join(mediaDir,image)};
  items[1].tableName='视频提示词-成品';
  items[1].video={fileToken:'fixtureVideo',name:video || 'fixture.mp4',localPath:path.join(mediaDir,video || 'fixture-missing.mp4')};
  const itemFile=path.join(output,'model-items.json'); fs.writeFileSync(itemFile,JSON.stringify([...items,...custom]));
  const fieldFile=path.join(output,'model-fields.json'); fs.writeFileSync(fieldFile,JSON.stringify({main:definitions.main.fields}));
  const env={...process.env,GALLERY_TEST_ITEMS:itemFile,GALLERY_TEST_FIELDS:fieldFile}; delete env.ELECTRON_RUN_AS_NODE; delete env.PREVIEW_SETTINGS;
  const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[path.join(__dirname,'gallery-test-app.cjs')],env});
  const errors=[]; app.on('window',p=>p.on('pageerror',e=>errors.push(e.message)));
  try {
    const panel=await app.firstWindow(); panel.setDefaultTimeout(8000);
    await panel.waitForFunction(()=>document.querySelectorAll('.card').length===5);
    await panel.evaluate(()=>window.api.requestExpand(true));
    await panel.waitForFunction(()=>getComputedStyle(document.querySelector('#panel')).opacity==='1');
    await app.evaluate(({BrowserWindow})=>{const b=BrowserWindow.getAllWindows()[0].getBounds();global.galleryTestCursor={x:b.x+100,y:b.y+200};});
    const opened=app.waitForEvent('window');
    await panel.locator('[data-id="main:image"] .media').click();
    const preview=await opened;
    await preview.waitForFunction(()=>document.querySelector('#previewModel').textContent==='测试生图模型 A');
    assert.equal(await preview.locator('#previewText').textContent(),items[0].content);
    await preview.locator('#previewCopy').click();
    assert.equal(await app.evaluate(()=>global.galleryTestClipboard),items[0].content);
    await preview.locator('#previewPin').click();
    await preview.waitForFunction(()=>document.querySelector('#previewPin').getAttribute('aria-pressed')==='true');
    assert.equal(await preview.locator('#previewModel').textContent(),items[0].model);
    await preview.screenshot({path:path.join(output,'preview-model-image.png')});
    await panel.locator('[data-id="main:video"] .media').click();
    await preview.waitForFunction(()=>document.querySelector('#previewModel').textContent==='测试视频模型 B / 测试视频模型 C');
    assert.equal(await preview.locator('#previewText').textContent(),items[1].content);
    if (video) await preview.waitForFunction(()=>document.querySelector('#previewVideo').readyState>=2);
    await preview.screenshot({path:path.join(output,'preview-model-video.png')});
    await panel.locator('[data-id="main:unknown"] .media').click();
    await preview.waitForFunction(()=>document.querySelector('#previewModel').textContent==='未标注');
    await panel.locator('[data-id="main:empty"] .media').click();
    await preview.waitForFunction(()=>document.querySelector('#previewText').textContent==='暂无正文');
    await panel.locator('[data-id="custom:custom"] .media').click();
    await preview.waitForFunction(()=>document.querySelector('#previewModel').textContent==='模型 <Beta>');
    assert.equal(await preview.locator('#previewModel b').count(),0);
    const settingsOpened=app.waitForEvent('window');
    await panel.locator('#btnSettings').click();
    const settings=await settingsOpened;
    await settings.waitForFunction(()=>document.querySelector('[data-k="content"]').value==='内容');
    assert(await settings.locator('[data-k="content"]').isDisabled());
    assert.equal(await settings.locator('[data-k="content"] option[value="可直接复制提示词"]').count(),0);
    await settings.locator('[data-k="model"]').selectOption('使用模型');
    await panel.waitForFunction(async()=> (await window.api.getConfig()).sources[0].mapping.model==='使用模型');
    assert.deepEqual(errors,[]);
    console.log('PASS: actual image/video previews show models and raw text; copy, bookmark refresh, switching to missing models and empty content work.');
  } finally {await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

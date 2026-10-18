'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const { syncSource } = require('../lib/feishu');
const { Store } = require('../lib/store');
const root = path.join(__dirname, '..');
const output = path.join(root, 'output', 'playwright');
fs.mkdirSync(output, { recursive: true });

(async () => {
  // Exercise the actual CLI normalization and mapping without external data.
  const tableData = {
    a: { timeField: '添加时间', rows: [
      ['old', '旧记录', '2026-10-17T08:00:00+08:00'],
      ['new', '新记录', '2026-10-19T08:00:00+08:00'],
      ['tie', '同时间记录', '2026-10-19T00:00:00Z'],
      ['missing', '缺少时间', null], ['invalid', '无效时间', 'not-a-date'],
    ] },
    b: { timeField: '创建时间', rows: [
      ['seconds', '秒时间戳', Date.parse('2026-10-18T08:00:00+08:00') / 1000],
      ['newest', '最新记录', '2026-10-19T10:00:00+08:00'],
      ['millis', '毫秒时间戳', String(Date.parse('2026-10-18T10:00:00+08:00'))],
    ] },
    custom: { timeField: '入库日期', rows: [['custom', '自定义时间列', '2026-10-15T00:00:00+08:00']] },
  };
  const cli = path.join(output, 'date-fixture-cli.js');
  fs.writeFileSync(cli, `const tables = ${JSON.stringify(tableData)};
const table = tables[process.argv[process.argv.indexOf('--table-id') + 1]];
const result = process.argv.includes('+field-list')
 ? { fields: [{name:'标题',type:'text'},{name:'提示词',type:'text'},{name:table.timeField,type:'datetime'}] }
 : { fields: ['标题','提示词',table.timeField], data: table.rows.map(r => [r[1],r[1]+'的正文',r[2]]), record_id_list: table.rows.map(r => r[0]), has_more: false };
console.log(JSON.stringify({data:result}));`);
  const cfg = { baseToken: 'fixture', larkCliPath: cli };
  const a = await syncSource(cfg, { id: 'a', tableId: 'a', name: '生图提示词-人物' }, output);
  const b = await syncSource(cfg, { id: 'b', tableId: 'b', name: '生图提示词-环境' }, output);
  const custom = await syncSource(cfg, { id: 'custom', tableId: 'custom', name: '常用提示词库', mapping: { createdAt: '入库日期' } }, output);
  assert.equal(a[0].createdAt, Date.parse('2026-10-17T08:00:00+08:00'));
  assert.equal(a[1].createdAt, a[2].createdAt);
  assert.equal(a[3].createdAt, 0); assert.equal(a[4].createdAt, 0);
  assert.equal(b[0].createdAt, Date.parse('2026-10-18T08:00:00+08:00'));
  assert.equal(b[2].createdAt, Date.parse('2026-10-18T10:00:00+08:00'));
  assert.equal(custom[0].createdAt, Date.parse('2026-10-15T00:00:00+08:00'));
  const local = new Store(path.join(output, 'date-local-profile'));
  local.config.local = { prompt: [], phrase: [] };
  const added = local.upsertLocal({ kind: 'prompt', title: '本地记录', content: '正文' });
  const edited = local.upsertLocal({ ...added, title: '修改标题' });
  assert(added.createdAt > 0); assert.equal(edited.createdAt, added.createdAt);
  console.log('PASS: actual sync maps ISO dates, seconds, milliseconds, missing values and custom date columns; local edits preserve creation time.');

  const itemsPath = path.join(output, 'date-items.json');
  fs.writeFileSync(itemsPath, JSON.stringify([...a, ...b]));
  const env = { ...process.env, GALLERY_TEST_ITEMS: itemsPath }; delete env.ELECTRON_RUN_AS_NODE; delete env.PREVIEW_SETTINGS;
  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(__dirname, 'gallery-test-app.cjs')], env });
  const errors = [];
  app.on('window', p => p.on('pageerror', e => errors.push(e.message)));
  try {
    const panel = await app.firstWindow(); panel.setDefaultTimeout(8000);
    await panel.waitForFunction(() => document.querySelectorAll('.card').length === 8);
    await panel.evaluate(() => window.api.requestExpand(true));
    await panel.waitForFunction(() => getComputedStyle(document.querySelector('#panel')).opacity === '1');
    const ids = () => panel.locator('.card').evaluateAll(els => els.map(e => e.dataset.id));
    const expected = ['b:newest', 'a:new', 'a:tie', 'b:millis', 'b:seconds', 'a:old', 'a:missing', 'a:invalid'];
    assert.deepEqual(await ids(), expected);
    assert.equal(await panel.getByRole('button', { name: '最新', exact: true }).getAttribute('aria-pressed'), 'true');
    await panel.getByRole('combobox', { name: '细分分类' }).selectOption('人物');
    assert.deepEqual(await ids(), ['a:new', 'a:tie', 'a:old', 'a:missing', 'a:invalid']);
    await panel.getByRole('combobox', { name: '细分分类' }).selectOption('');
    await panel.evaluate(async () => { await window.api.togglePin('a:new'); await window.api.togglePin('b:newest'); });
    await panel.locator('#sortRow').getByRole('button', { name: '已收藏', exact: true }).click();
    assert.deepEqual(await ids(), ['b:newest', 'a:new']);
    await panel.getByRole('button', { name: '最新', exact: true }).click();
    await panel.evaluate(async () => { await window.api.copy('正文', '旧记录', 'a:old'); await window.api.copy('正文', '旧记录', 'a:old'); });
    await panel.getByRole('button', { name: '最热', exact: true }).click();
    assert.equal((await ids())[0], 'a:old');
    await panel.getByRole('button', { name: '最新', exact: true }).click();
    assert.deepEqual(await ids(), expected);
    await panel.reload();
    await panel.waitForFunction(() => document.querySelectorAll('.card').length === 8);
    assert.deepEqual(await ids(), expected);
    assert.deepEqual(errors, []);
    console.log('PASS: newest first across tables, stable ties, undated items last, category and bookmark filters, popularity override and cache reload.');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

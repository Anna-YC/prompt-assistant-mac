'use strict';
// Exercise the real CLI adapter using isolated processes and synthetic records.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { deletePrompts } = require('../lib/feishu');
const output = path.join(__dirname, '../output/tests/feishu-deletion');
fs.mkdirSync(output, { recursive: true });
function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(output, 'case-'));
  const stateFile = path.join(directory, 'state.json'), cli = path.join(directory, 'cli.js');
  fs.writeFileSync(stateFile, JSON.stringify({ records: ['rec1', 'rec2', 'recKeep'], deletes: 0, reads: 0, ...options }));
  fs.writeFileSync(cli, `
    const fs = require('node:fs'), path = require('node:path');
    const file = ${JSON.stringify(stateFile)}, args = process.argv.slice(2);
    const state = JSON.parse(fs.readFileSync(file));
    const save = () => fs.writeFileSync(file, JSON.stringify(state));
    const out = data => console.log(JSON.stringify({ ok: true, data }));
    const fail = message => { console.log(JSON.stringify({ ok: false, error: { message } })); process.exitCode = 1; };
    if (args.includes('+record-delete')) {
      const ref = args[args.indexOf('--json') + 1];
      if (!args.includes('--yes') || !ref.startsWith('@') || path.isAbsolute(ref.slice(1))) throw Error('Unsafe delete request');
      state.tempFile = path.resolve(ref.slice(1));
      const ids = JSON.parse(fs.readFileSync(state.tempFile)).record_id_list;
      state.deletes++; state.before = [...state.records];
      if (!state.rejectWrite) state.records = state.records.filter(id => !ids.includes(id) || (state.failedIds || []).includes(id));
      save();
      if (state.rawError) { console.log(JSON.stringify({ code: 1254302, msg: '没有编辑权限', data: { record_id_list: ids } })); process.exitCode = 1; }
      else if (state.rejectWrite || state.lostReceipt) fail('删除请求未收到成功回执');
      else out(state.receipt || { record_id_list: ids });
    } else if (args.includes('+record-list')) {
      state.reads++; save();
      if (state.readOffline || state.reads <= (state.readErrors || 0)) fail('暂时无法读取列表');
      else if (state.badPage) out({ fields: [], data: [], record_id_list: [], has_more: true });
      else {
        const ids = state.reads <= (state.lagReads || 0) ? state.before : state.records;
        out({ fields: ['标题'], data: ids.map(id => [id]), record_id_list: ids, has_more: false });
      }
    } else throw Error('Unexpected CLI command');
  `);
  return {
    run: (ids = ['rec1', 'rec2']) => deletePrompts({ baseToken: 'fixture-base', larkCliPath: cli }, 'tblFixture', ids),
    read: () => JSON.parse(fs.readFileSync(stateFile)),
    checkCleanup() { const state = this.read(); assert.equal(state.deletes, 1); assert(!fs.existsSync(state.tempFile)); assert(!fs.existsSync(path.dirname(state.tempFile))); },
  };
}

// Official Base v3 contract: shortcuts/base/base_execute_test.go, delete cases.
test('Base v3 success receipt completes without reading a stale or unavailable list', async () => {
  const f = fixture({ lagReads: 100, readOffline: true });
  assert.deepEqual(await f.run(), { deletedIds: ['rec1', 'rec2'], failedIds: [], error: '' });
  assert.equal(f.read().reads, 0); assert.deepEqual(f.read().records, ['recKeep']); f.checkCleanup();
});

test('unknown receipt automatically waits for delayed lists without repeating deletion', async () => {
  const f = fixture({ receipt: { acknowledged: true }, lagReads: 2 });
  assert.deepEqual(await f.run(), { deletedIds: ['rec1', 'rec2'], failedIds: [], error: '' });
  assert.equal(f.read().reads, 3); f.checkCleanup();
});

test('partial receipt confirms remaining IDs after a delayed read, ignoring unrelated IDs', async () => {
  const f = fixture({ receipt: { record_id_list: ['rec1', 'recOther'] }, lagReads: 1 });
  assert.deepEqual(await f.run(), { deletedIds: ['rec1', 'rec2'], failedIds: [], error: '' });
  assert.equal(f.read().reads, 2); f.checkCleanup();
});

test('read errors cannot undo acknowledged successes or confirm unknown failures', async () => {
  const f = fixture({ receipt: { record_id_list: ['rec1'] }, failedIds: ['rec2'], readOffline: true });
  const result = await f.run();
  assert.deepEqual(result.deletedIds, ['rec1']); assert.deepEqual(result.failedIds, ['rec2']);
  assert.match(result.error, /暂无法确认/); assert(f.read().records.includes('rec2')); f.checkCleanup();
});

test('legacy per-record receipt respects deleted false and incomplete pagination', async () => {
  const f = fixture({ receipt: { records: [{ record_id: 'rec1', deleted: true }, { record_id: 'rec2', deleted: false }, { record_id: 'recOther', deleted: true }] }, failedIds: ['rec2'], badPage: true });
  const result = await f.run(['rec1', 'rec1', 'rec2']);
  assert.deepEqual(result.deletedIds, ['rec1']); assert.deepEqual(result.failedIds, ['rec2']);
  assert.match(result.error, /分页未完成/); f.checkCleanup();
});

test('a nonzero API error cannot be mistaken for a successful record ID receipt', async () => {
  const f = fixture({ rejectWrite: true, rawError: true });
  const result = await f.run();
  assert.deepEqual(result.deletedIds, []); assert.deepEqual(result.failedIds, ['rec1', 'rec2']);
  assert.match(result.error, /没有编辑权限/); f.checkCleanup();
});

test('lost write receipt and a temporary read error are resolved by read-only retries', async () => {
  const f = fixture({ lostReceipt: true, lagReads: 2, readErrors: 1 });
  assert.deepEqual(await f.run(), { deletedIds: ['rec1', 'rec2'], failedIds: [], error: '' });
  assert.equal(f.read().reads, 3); f.checkCleanup();
});

test('unknown success does not hide records which remain, while already absent records are idempotent', async () => {
  const f = fixture({ receipt: {}, failedIds: ['rec1', 'rec2'] });
  const result = await f.run();
  assert.deepEqual(result.deletedIds, []); assert.deepEqual(result.failedIds, ['rec1', 'rec2']); f.checkCleanup();
  const absent = fixture({ records: ['recKeep'], rejectWrite: true });
  assert.deepEqual(await absent.run(), { deletedIds: ['rec1', 'rec2'], failedIds: [], error: '' });
  assert.equal(absent.read().reads, 1); absent.checkCleanup();
});

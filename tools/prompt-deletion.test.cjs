'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { Store } = require('../lib/store');
const { createCloudPromptService } = require('../lib/cloud-prompts');
const output = path.join(__dirname, '../output/tests/prompt-deletion'); fs.mkdirSync(output, { recursive: true });
const source = { id: 'a', tableId: 'tblA', name: '常用提示词库', kind: 'prompt', enabled: true };
function makeStore() {
  const store = new Store(fs.mkdtempSync(path.join(output, 'profile-')));
  store.config.baseToken = 'fixture-base'; store.config.sources = [{ ...source }];
  return store;
}
const item = (n, tableId = 'tblA', sourceId = 'a') => ({ id: sourceId + ':rec' + n, recordId: 'rec' + n, tableId, sourceId, origin: 'feishu', title: '提示词 ' + n, content: '示例正文' });

test('bulk deletion chunks at 200, groups tables, preserves failures, and cleans pins/stats for confirmed records', async () => {
  const store = makeStore(), calls = [];
  store.config.sources.push({ ...source, id: 'b', tableId: 'tblB' });
  store.cache.prompts = [...Array.from({ length: 205 }, (_, n) => item(n)), item(999, 'tblB', 'b')];
  store.config.tray.pinnedIds = ['a:rec0']; store.stats['a:rec0'] = { count: 4 };
  const service = createCloudPromptService({ store, feishu: { deletePrompts: async (_cfg, tableId, ids) => {
    calls.push([tableId, ids.length]); if (tableId === 'tblB') throw Error('没有编辑权限');
    return { deletedIds: ids, failedIds: [] };
  } } });
  const result = await service.remove({ ids: store.getView().prompts.map(item => item.id) });
  assert.deepEqual(calls, [['tblA', 200], ['tblA', 5], ['tblB', 1]]);
  assert.equal(result.deletedIds.length, 205); assert.equal(result.failed.length, 1);
  assert.deepEqual(store.getView().prompts.map(item => item.id), ['b:rec999']);
  assert(!store.config.tray.pinnedIds.includes('a:rec0')); assert(!store.stats['a:rec0']);
  assert.equal(new Store(store.dir).getView().prompts.length, 1);
});

test('deletion markers cover aliases and stale caches, respect Base identity and prune only after a later complete absent read', () => {
  const store = makeStore(), a = item(1), alias = { ...a, id: 'alias:rec1', sourceId: 'alias' };
  store.config.sources.push({ ...source, id: 'alias' });
  store.cache.prompts = [a, alias]; store.confirmPromptDeletion([a]);
  const key = store.promptDeletionKey(a), start = store.promptDeletionKeys();
  store.cache.prompts = [a, alias]; assert.equal(store.getView().prompts.length, 0);
  store.prunePromptDeletions(new Set(), store.config.sources, new Set(['a', 'alias']), [], store.config.baseToken);
  assert(store.config.promptDeletions[key]);
  store.prunePromptDeletions(start, store.config.sources, new Set(['a', 'alias']), [a], store.config.baseToken);
  assert(store.config.promptDeletions[key]);
  store.prunePromptDeletions(start, store.config.sources, new Set(['a']), [], store.config.baseToken);
  assert(store.config.promptDeletions[key]);
  store.config.baseToken = 'other-fixture-base'; assert.equal(store.getView().prompts.length, 2);
  store.prunePromptDeletions(start, store.config.sources, new Set(['a', 'alias']), [], store.config.baseToken);
  assert(store.config.promptDeletions[key]);
  store.config.baseToken = 'fixture-base'; store.cache.prompts = [];
  store.prunePromptDeletions(start, store.config.sources, new Set(['a', 'alias']), [], store.config.baseToken);
  assert(!store.config.promptDeletions[key]);
});

test('local legacy deletion works offline and storage preflight failure prevents remote writes', async () => {
  const store = makeStore(); let calls = 0;
  store.config.local.prompt = [{ id: 'loc_legacy', title: '本机旧条目', content: '旧正文' }];
  const service = createCloudPromptService({ store, feishu: { deletePrompts: async () => { calls++; throw Error('offline'); } } });
  assert((await service.remove({ ids: ['loc_legacy'] })).ok); assert.equal(calls, 0);
  store.cache.prompts = [item(1)]; store.saveConfig = () => { throw Error('磁盘不可写'); };
  await assert.rejects(service.remove({ ids: ['a:rec1'] }), /磁盘不可写/);
  assert.equal(calls, 0); assert.equal(store.getView().prompts.length, 1);
});

test('confirmed remote deletion stays hidden after restart even if cache saving fails', async () => {
  const store = makeStore(); store.cache.prompts = [item(1)]; store.saveConfig(); store.saveCache();
  store.saveCache = () => { throw Error('cache disk failure'); };
  const service = createCloudPromptService({ store, feishu: { deletePrompts: async () => ({ deletedIds: ['rec1'] }) } });
  const result = await service.remove({ ids: ['a:rec1'] });
  assert(result.ok && result.warning);
  const restarted = new Store(store.dir);
  assert.equal(restarted.cache.prompts.length, 1); assert.equal(restarted.getView().prompts.length, 0);
});

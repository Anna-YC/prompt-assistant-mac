'use strict';
const fs = require('fs');

function createCloudPromptService({ store, feishu, onUpdated = () => {} }) {
  let queue = Promise.resolve();
  const requests = new Map();
  function targets() {
    const sources = (store.config.sources || []).filter(source => source.enabled && source.kind === 'prompt' && source.tableId && !/^(生图|视频)/.test(source.name || ''));
    const preferred = sources.find(source => source.id === store.config.panel.commonSourceId) || sources.find(source => source.name === '常用提示词库') || sources[0];
    return { connected: !!store.config.baseToken, sources: sources.map(source => ({ id: source.id, name: source.name })),
      preferredSourceId: preferred?.id || '', legacyCount: store.listLocal('prompt').length + store.listLocal('phrase').length };
  }
  function target(sourceId) {
    if (!store.config.baseToken) throw new Error('请先在设置中接入飞书多维表');
    if (!targets().sources.some(source => source.id === sourceId)) throw new Error('请先接入并选择常用提示词数据表');
    return store.config.sources.find(source => source.id === sourceId);
  }
  async function createOne(input) {
    const source = target(input.sourceId);
    const legacyKind = input.legacyKind === 'phrase' ? 'phrase' : 'prompt';
    const legacy = input.legacyId ? store.listLocal(legacyKind).find(item => item.id === input.legacyId) : null;
    if (input.legacyId && !legacy) throw new Error('旧条目已经同步或不存在，请刷新后重试');
    const item = await feishu.createPrompt(store.config, source, input);
    const pinned = !!input.pinned || !!legacy?.pinned || store.config.tray.pinnedIds.includes(legacy?.id);
    store.cache.prompts = [item, ...(store.cache.prompts || []).filter(existing => existing.id !== item.id)];
    let warning = '';
    // A cache failure after a confirmed remote write must never invite a
    // second create. Keep the new item in memory and return cloud success.
    try {
      store.saveCache();
      if (pinned && !store.config.tray.pinnedIds.includes(item.id)) store.config.tray.pinnedIds.push(item.id);
      store.config.panel.commonSourceId = source.id;
      if (legacy) {
        store.config.local[legacyKind] = store.listLocal(legacyKind).filter(existing => existing.id !== legacy.id);
        store.config.tray.pinnedIds = store.config.tray.pinnedIds.filter(id => id !== legacy.id);
        if (store.stats[legacy.id]) {
          store.stats[item.id] = { ...store.stats[legacy.id] };
          delete store.stats[legacy.id];
          fs.writeFileSync(store.statsPath, JSON.stringify(store.stats), 'utf8');
        }
      }
      store.saveConfig();
    } catch {
      warning = '已保存到飞书，本机缓存未能完整保存，请稍后同步刷新';
    }
    try { onUpdated(); } catch {}
    return { ok: true, item: { ...item, pinned }, warning };
  }
  function create(input = {}) {
    if (!input || typeof input !== 'object') return Promise.reject(new Error('保存请求无效'));
    const requestId = typeof input.requestId === 'string' ? input.requestId : '';
    if (!/^[\w-]{8,80}$/.test(requestId)) return Promise.reject(new Error('保存请求无效，请重新打开新增表单'));
    const signature = JSON.stringify([input.sourceId, input.title, input.content, input.legacyId, input.legacyKind, input.pinned]);
    const existing = requests.get(requestId);
    if (existing) return existing.signature === signature ? existing.promise : Promise.reject(new Error('保存内容已改变，请重新提交'));
    const promise = queue.then(() => createOne(input)).catch(error => {
      if (error.createdRecordId) return { ok: false, created: true, error: error.message };
      throw error;
    });
    queue = promise.catch(() => {});
    requests.set(requestId, { signature, promise });
    promise.catch(() => requests.delete(requestId));
    if (requests.size > 100) requests.delete(requests.keys().next().value);
    return promise;
  }
  async function migrate(input = {}) {
    target(input.sourceId);
    const items = ['prompt', 'phrase'].flatMap(kind => store.listLocal(kind).map(item => ({ ...item, kind })));
    let saved = 0;
    for (const item of items) {
      try {
        const result = await create({ sourceId: input.sourceId, title: item.title || item.name || item.content?.slice(0, 24) || '常用提示词', content: item.content,
          pinned: !!item.pinned, legacyId: item.id, legacyKind: item.kind, requestId: 'migrate-' + item.kind + '-' + item.id });
        if (!result.ok) return { ok: false, saved, remaining: targets().legacyCount, error: result.error };
        saved++;
        if (result.warning) return { ok: false, saved, remaining: targets().legacyCount, error: result.warning };
      } catch (error) {
        return { ok: false, saved, remaining: targets().legacyCount, error: error.message };
      }
    }
    return { ok: true, saved, remaining: targets().legacyCount };
  }
  async function removeOneBatch(ids) {
    const current = new Map(store.getView().prompts.map(item => [item.id, item]));
    const deletedIds = [], failed = [], warnings = [];
    const items = ids.map(id => current.get(id)).filter(Boolean);
    for (const id of ids) if (!current.has(id)) {
      if (id.startsWith('skill_')) failed.push({ id, title: '', error: 'Skill 不属于提示词删除范围' });
      else deletedIds.push(id); // 等待队列期间已被另一轮同步移除，按幂等成功处理。
    }
    // 在发送任何删除请求前确认本机配置可写，避免明知无法持久化仍继续删除。
    store.saveConfig();
    const cfg = { ...store.config, sources: (store.config.sources || []).map(source => ({ ...source })) };
    const commit = selected => {
      if (!selected.length) return;
      try { store.confirmPromptDeletion(selected, cfg.baseToken); }
      catch { warnings.push('已确认删除，但本机未能完整保存，请检查存储空间并重新同步'); }
      deletedIds.push(...selected.map(item => item.id));
      try { onUpdated(); } catch {}
    };
    commit(items.filter(item => item.origin === 'local'));
    const tables = new Map();
    for (const item of items.filter(item => item.origin !== 'local')) {
      if (!cfg.baseToken || !cfg.sources.some(source => source.enabled && source.tableId === item.tableId) || !item.recordId) {
        failed.push({ id: item.id, title: item.title, error: '数据源未接入或已停用，请先在设置中检查' }); continue;
      }
      if (!tables.has(item.tableId)) tables.set(item.tableId, []);
      tables.get(item.tableId).push(item);
    }
    for (const [tableId, tableItems] of tables) {
      const recordIds = [...new Set(tableItems.map(item => item.recordId))];
      for (let start = 0; start < recordIds.length; start += 200) {
        const batch = recordIds.slice(start, start + 200), selected = tableItems.filter(item => batch.includes(item.recordId));
        try {
          const result = await feishu.deletePrompts(cfg, tableId, batch);
          const confirmed = new Set(result.deletedIds);
          commit(selected.filter(item => confirmed.has(item.recordId)));
          failed.push(...selected.filter(item => !confirmed.has(item.recordId)).map(item => ({ id: item.id, title: item.title, error: result.error || '未确认删除，请同步后检查' })));
        } catch (error) { failed.push(...selected.map(item => ({ id: item.id, title: item.title, error: error.message }))); }
      }
    }
    return { ok: !failed.length, deletedIds, failed, warning: [...new Set(warnings)].join('；') };
  }
  function remove(input) {
    if (!Array.isArray(input?.ids) || !input.ids.length || input.ids.length > 10000 || input.ids.some(id => typeof id !== 'string' || id.length > 200)) return Promise.reject(new Error('请选择需要删除的提示词（最多 10000 条）'));
    const ids = [...new Set(input.ids)];
    const promise = queue.then(() => removeOneBatch(ids));
    queue = promise.catch(() => {});
    return promise;
  }
  return { targets, create, migrate, remove };
}

module.exports = { createCloudPromptService };

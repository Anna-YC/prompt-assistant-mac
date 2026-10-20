'use strict';
// 两处列表共用选择与删除确认，远端确认成功后才移除条目；失败项留在确认框中重试。
window.PromptDeleteUI = (() => {
  let provider, options = {}, pending = [], busy = false, opening = false;
  const $ = selector => document.querySelector(selector);
  function bind(getView, settings = {}) {
    provider = getView; options = settings;
    document.body.insertAdjacentHTML('beforeend', `<dialog id="promptDeleteDialog" class="prompt-delete-dialog" aria-labelledby="promptDeleteTitle" aria-describedby="promptDeleteDescription"><form id="promptDeleteForm"><div class="delete-heading"><h2 id="promptDeleteTitle">删除提示词</h2><p id="promptDeleteDescription"></p></div><div class="delete-scroll"><ul id="promptDeleteItems"></ul><p id="promptDeleteMessage" role="status" aria-live="polite"></p></div><div class="delete-buttons"><button id="promptDeleteCancel" type="button">取消</button><button id="promptDeleteConfirm" type="submit" class="delete-danger">确认删除</button></div></form></dialog>`);
    $('#promptDeleteCancel').addEventListener('click', () => { if (!busy) $('#promptDeleteDialog').close(); });
    $('#promptDeleteDialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    $('#promptDeleteDialog').addEventListener('close', () => {
      // 原生 close 事件异步派发；快速关闭再打开时，不让上一轮回调清空新一轮目标或释放编辑保护。
      if ($('#promptDeleteDialog').open || opening) return;
      pending = []; options.onClose?.();
    });
    $('#promptDeleteForm').addEventListener('submit', async event => {
      event.preventDefault(); if (busy || !pending.length) return;
      busy = true; $('#promptDeleteConfirm').disabled = true; $('#promptDeleteCancel').disabled = true;
      $('#promptDeleteMessage').textContent = '正在删除并核对飞书记录，请稍候…';
      try {
        const result = await window.api.deletePrompts({ ids: pending.map(item => item.id) });
        options.onResult?.(result);
        if (result.ok && !result.warning) { $('#promptDeleteDialog').close(); return; }
        const failed = new Map((result.failed || []).map(item => [item.id, item.error]));
        pending = pending.filter(item => !(result.deletedIds || []).includes(item.id));
        $('#promptDeleteTitle').textContent = pending.length ? '还有 ' + pending.length + ' 条未删除' : '已确认删除';
        $('#promptDeleteDescription').textContent = pending.length ? '以下条目尚未确认删除，已在列表中保留。你可以重试或暂时关闭。' : '选中的条目已经移除，请留意下方的本机保存提示。';
        renderItems(failed);
        $('#promptDeleteMessage').textContent = [result.deletedIds?.length ? '已删除 ' + result.deletedIds.length + ' 条。' : '', result.error || result.warning || '', pending.length ? '其余条目已保留，可重试。' : '', ...new Set(failed.values())].filter(Boolean).join('\n');
        $('#promptDeleteConfirm').textContent = '重试失败项';
        $('#promptDeleteConfirm').hidden = !pending.length;
        $('#promptDeleteCancel').textContent = pending.length ? '暂不重试' : '关闭';
      } catch (error) { $('#promptDeleteMessage').textContent = '删除未完成，条目已保留：' + error.message; }
      finally { busy = false; $('#promptDeleteConfirm').disabled = false; $('#promptDeleteCancel').disabled = false; }
    });
  }
  function renderItems(failed = new Map()) {
    $('#promptDeleteItems').replaceChildren(...pending.slice(0, 100).map(item => {
      const row = document.createElement('li'); row.textContent = item.title || item.name || '未命名提示词';
      if (failed.has(item.id)) row.className = 'delete-failed'; return row;
    }));
    if (pending.length > 100) { const row = document.createElement('li'); row.textContent = '另有 ' + (pending.length - 100) + ' 条'; $('#promptDeleteItems').append(row); }
  }
  async function open(ids) {
    if (busy || opening || $('#promptDeleteDialog').open) return;
    const selected = new Set(ids);
    const next = provider().prompts.filter(item => selected.has(item.id));
    if (!next.length) return;
    opening = true;
    try { await options.beforeOpen?.(); pending = next; }
    catch (error) { opening = false; options.onClose?.(); throw error; }
    const cloud = pending.filter(item => item.origin !== 'local').length;
    $('#promptDeleteTitle').textContent = '删除 ' + pending.length + ' 条提示词？';
    $('#promptDeleteDescription').textContent = cloud ? `其中 ${cloud} 条会同时删除飞书源记录，其他设备同步后也会移除。请确认以下条目。` : '这些是本机待迁移条目，删除后会从本机移除。';
    renderItems(); $('#promptDeleteMessage').textContent = '';
    $('#promptDeleteConfirm').textContent = '确认删除'; $('#promptDeleteConfirm').hidden = false;
    $('#promptDeleteCancel').textContent = '取消';
    $('#promptDeleteDialog').showModal(); $('#promptDeleteCancel').focus();
    opening = false;
  }
  return { bind, open, isOpen: () => !!$('#promptDeleteDialog')?.open };
})();

window.createPromptSelection = ({ button, toolbar, container, getItems }) => {
  let active = false;
  const selected = new Set();
  toolbar.classList.add('prompt-selection-bar');
  toolbar.innerHTML = '<label><input type="checkbox" class="prompt-select-all" /> 全选结果</label><span class="prompt-selection-count" role="status"></span><button class="prompt-delete-selected" type="button">删除选中</button>';
  const eligible = () => getItems().filter(item => item.kind !== 'skill');
  function refresh() {
    const items = eligible(), byId = new Map(items.map(item => [item.id, item]));
    for (const id of selected) if (!byId.has(id)) selected.delete(id);
    button.textContent = active ? '完成' : '管理'; button.setAttribute('aria-pressed', String(active));
    button.disabled = !active && !items.length; toolbar.hidden = !active;
    container.classList.toggle('prompt-selection-mode', active);
    const all = toolbar.querySelector('.prompt-select-all');
    all.checked = !!items.length && selected.size === items.length; all.indeterminate = selected.size > 0 && selected.size < items.length; all.disabled = !items.length;
    toolbar.querySelector('.prompt-selection-count').textContent = '已选 ' + selected.size + ' / ' + items.length;
    toolbar.querySelector('.prompt-delete-selected').disabled = !selected.size;
    for (const row of container.querySelectorAll('[data-id]')) {
      row.querySelector('.prompt-select')?.remove();
      row.classList.toggle('prompt-selected', selected.has(row.dataset.id));
      const item = byId.get(row.dataset.id); if (!active || !item) continue;
      const label = document.createElement('label'); label.className = 'prompt-select';
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selected.has(item.id); check.setAttribute('aria-label', '选择：' + (item.title || item.name || '未命名提示词'));
      label.append(check); row.prepend(label);
    }
  }
  const toggle = id => { if (selected.has(id)) selected.delete(id); else selected.add(id); refresh(); };
  button.addEventListener('click', () => { active = !active; selected.clear(); refresh(); });
  toolbar.querySelector('.prompt-select-all').addEventListener('change', event => { selected.clear(); if (event.target.checked) eligible().forEach(item => selected.add(item.id)); refresh(); });
  toolbar.querySelector('.prompt-delete-selected').addEventListener('click', () => window.PromptDeleteUI.open([...selected]));
  container.addEventListener('change', event => { if (event.target.closest('.prompt-select')) toggle(event.target.closest('[data-id]').dataset.id); });
  container.addEventListener('click', event => {
    if (!active || event.target.closest('.prompt-select')) return;
    const row = event.target.closest('[data-id]'); if (!row || !eligible().some(item => item.id === row.dataset.id)) return;
    event.preventDefault(); event.stopImmediatePropagation(); toggle(row.dataset.id);
  }, true);
  return { refresh, isActive: () => active };
};

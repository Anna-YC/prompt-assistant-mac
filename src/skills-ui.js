'use strict';
// 设置对话框与侧面浮窗共用编辑器；草稿仅在当前会话保留，不改写 SKILL.md。
window.SkillUI = (() => {
  const $ = selector => document.querySelector(selector);
  let getView = () => ({ skills: [] }), currentId = null, saving = false, inline = false;
  let options = {}, baseline = {}, defaultCall = '', suspended = true, holding = false;
  let categoryOpen = false, categoryStart = '', showAll = false, activeOption = -1, choices = [];
  const drafts = new Map();
  const values = () => ({ alias: $('#skillAlias').value, category: $('#skillCategory').value.trim(), note: $('#skillNote').value });
  const dirty = () => currentId && JSON.stringify(values()) !== JSON.stringify(baseline);
  const message = (text, error = false) => {
    $('#skillMessage').textContent = text;
    $('#skillMessage').classList.toggle('error', error);
  };
  function hold() {
    const editingField = $('#skillForm').contains(document.activeElement) && document.activeElement.matches('input,textarea');
    const next = !!(currentId && !suspended && (saving || dirty() || categoryOpen || editingField));
    if (next === holding) return;
    holding = next; options.onEditing?.({ id: currentId, active: next });
  }
  function remember() {
    if (!currentId) return;
    if (dirty() || $('#skillCall').value !== defaultCall) drafts.set(currentId, { ...values(), call: $('#skillCall').value });
    else drafts.delete(currentId);
  }
  function closeCategory(restore = false) {
    if (!categoryOpen) return;
    if (restore) $('#skillCategory').value = categoryStart;
    categoryStart = $('#skillCategory').value;
    categoryOpen = false; $('#skillCategoryMenu').hidePopover();
    $('#skillCategory').setAttribute('aria-expanded', 'false');
    $('#skillCategory').removeAttribute('aria-activedescendant');
    if (restore) message(dirty() ? '有未保存的更改' : '');
    hold();
  }
  function placeCategory() {
    if (!categoryOpen) return;
    // Electron 33 支持原生 Popover；手动定位兼容其 Chromium，避免滚动区裁切或靠边溢出。
    const field = $('.skill-category-field').getBoundingClientRect(), menu = $('#skillCategoryMenu');
    const below = innerHeight - field.bottom - 10, above = field.top - 10;
    const height = Math.min(230, Math.max(below, above));
    menu.style.width = Math.min(field.width, innerWidth - 20) + 'px';
    menu.style.maxHeight = Math.max(80, height) + 'px';
    menu.style.left = Math.max(10, Math.min(field.left, innerWidth - field.width - 10)) + 'px';
    menu.style.top = (below >= Math.min(230, menu.scrollHeight) || below >= above ? field.bottom + 6 : Math.max(10, field.top - Math.min(height, menu.scrollHeight) - 6)) + 'px';
  }
  function highlight(index) {
    activeOption = Math.max(0, Math.min(index, choices.length - 1));
    $('#skillCategoryList').querySelectorAll('[role="option"]').forEach((el, i) => {
      el.classList.toggle('active', i === activeOption); el.setAttribute('aria-selected', String(i === activeOption));
    });
    const selected = $('#skillCategoryOption' + activeOption);
    if (selected) { $('#skillCategory').setAttribute('aria-activedescendant', selected.id); selected.scrollIntoView({ block: 'nearest' }); }
  }
  function renderCategories() {
    const query = showAll ? '' : $('#skillCategory').value.trim();
    const categories = [...new Set(getView().skillState?.categories || [])];
    choices = categories.filter(value => value.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(value => ({ value, label: value }));
    if (!query || '未分类'.includes(query)) choices.unshift({ value: '', label: '未分类' });
    if (query && !categories.includes(query)) choices.push({ value: query, label: '新建「' + query + '」', create: true });
    $('#skillCategoryList').replaceChildren(...choices.map((choice, index) => {
      const row = document.createElement('div');
      row.id = 'skillCategoryOption' + index; row.role = 'option'; row.dataset.index = index;
      row.className = 'skill-category-option' + (choice.create ? ' create' : '');
      const icon = document.createElement('span'); icon.className = 'category-option-icon'; icon.textContent = choice.create ? '+' : choice.value === $('#skillCategory').value.trim() ? '✓' : '·'; icon.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span'); label.textContent = choice.label;
      row.append(icon, label); return row;
    }));
    const matching = choices.findIndex(choice => choice.value === $('#skillCategory').value.trim());
    highlight(matching < 0 ? 0 : matching); placeCategory();
  }
  function openCategory(fromInput = false) {
    if (categoryOpen || saving) return;
    if (!fromInput) categoryStart = $('#skillCategory').value;
    showAll = true; categoryOpen = true;
    $('#skillCategory').setAttribute('aria-expanded', 'true');
    $('#skillCategoryMenu').showPopover(); renderCategories(); hold();
  }
  function chooseCategory(index) {
    const choice = choices[index]; if (!choice) return;
    $('#skillCategory').value = choice.value;
    closeCategory(); $('#skillCategory').focus(); message('分类已选择，点击保存即可保留'); hold();
  }
  function hide() {
    remember(); closeCategory(); suspended = true;
    // 先解除当前技能的编辑保护，避免旧消息锁住下一个技能。
    hold(); currentId = null;
    if (inline && $('#skillForm').contains(document.activeElement)) document.activeElement.blur();
    if (inline) $('#skillPreview').classList.add('hidden');
  }
  function close() {
    if (saving) return;
    if (inline) options.onClose?.(); else $('#skillDetails').close();
  }
  function bind(provider, settings = {}) {
    getView = provider; options = settings; inline = !!settings.inline;
    const host = inline ? $('#skillPreview') : document.createElement('dialog');
    if (!inline) { host.id = 'skillDetails'; host.className = 'skill-dialog skill-editor'; host.setAttribute('aria-labelledby', 'skillTitle'); document.body.append(host); }
    else host.classList.add('skill-editor');
    host.innerHTML = `
      <form id="skillForm">
        <header class="skill-heading"><div><h2 id="skillTitle">Skill</h2><p id="skillStatus">本机已发现</p></div><button id="skillClose" type="button" aria-label="关闭技能详情" title="关闭（Esc）">×</button></header>
        <div class="skill-fields">
          <p id="skillDescription" class="skill-description"></p>
          <label for="skillAlias">中文名称 / 别名</label><input id="skillAlias" name="alias" maxlength="160" autocomplete="off" placeholder="可留空，使用技能原名" />
          <label for="skillCategory">分类</label>
          <div class="skill-category-field"><input id="skillCategory" name="category" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="skillCategoryList" maxlength="40" autocomplete="off" placeholder="搜索或新建分类" /><button id="skillCategoryToggle" type="button" tabindex="-1" aria-label="展开分类"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg></button></div>
          <div id="skillCategoryMenu" class="skill-category-menu" popover="manual"><p class="skill-category-caption">选择分类 · 输入名称可新建</p><div id="skillCategoryList" role="listbox" aria-label="Skill 分类"></div></div>
          <label for="skillNote">用途备注</label><textarea id="skillNote" name="note" rows="2" maxlength="2000" placeholder="记录适用场景，方便下次搜索"></textarea>
          <div class="skill-call-label"><label for="skillCall">调用提示词</label><span>改写任务后直接复制</span></div><textarea id="skillCall" name="call" rows="5" maxlength="50000" spellcheck="false"></textarea>
          <details><summary>本机文件位置</summary><p id="skillPath" class="skill-path"></p></details>
        </div>
        <footer class="skill-footer"><p id="skillMessage" role="status"></p><div class="skill-buttons"><button id="skillPin" type="button" aria-pressed="false">收藏</button><button id="skillSave" type="submit">保存整理</button><button id="skillCopy" type="button" class="skill-primary">复制调用词</button></div></footer>
      </form>`;
    $('#skillClose').addEventListener('click', close);
    if (!inline) {
      host.addEventListener('cancel', event => { if (saving || categoryOpen) { event.preventDefault(); closeCategory(true); } });
      host.addEventListener('close', hide);
    }
    $('#skillCategory').addEventListener('focus', () => openCategory());
    $('#skillCategory').addEventListener('click', () => openCategory());
    $('#skillCategory').addEventListener('input', () => { openCategory(true); showAll = false; renderCategories(); });
    $('#skillCategoryToggle').addEventListener('pointerdown', event => event.preventDefault());
    $('#skillCategoryToggle').addEventListener('click', () => {
      if (categoryOpen) closeCategory(); else { $('#skillCategory').focus(); openCategory(); }
    });
    $('#skillCategoryList').addEventListener('pointerdown', event => event.preventDefault());
    $('#skillCategoryList').addEventListener('click', event => {
      const row = event.target.closest('[data-index]'); if (row) chooseCategory(Number(row.dataset.index));
    });
    $('#skillCategory').addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); if (!categoryOpen) { openCategory(); return; }
        highlight(activeOption + (event.key === 'ArrowDown' ? 1 : -1));
      } else if (event.key === 'Enter' && categoryOpen) { event.preventDefault(); chooseCategory(activeOption); }
      else if (event.key === 'Tab') closeCategory();
    });
    document.addEventListener('keydown', event => {
      if (!currentId || event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (categoryOpen) closeCategory(true); else close();
    }, true);
    document.addEventListener('pointerdown', event => {
      if (!event.target.closest('.skill-category-field, #skillCategoryMenu')) closeCategory();
    });
    $('#skillForm').addEventListener('focusin', () => { suspended = false; hold(); });
    $('#skillForm').addEventListener('focusout', () => queueMicrotask(() => { if (document.activeElement !== $('#skillCategory')) closeCategory(); hold(); }));
    window.addEventListener('blur', () => { suspended = true; closeCategory(); hold(); });
    window.addEventListener('focus', () => { suspended = false; hold(); });
    window.addEventListener('resize', placeCategory);
    $('.skill-fields').addEventListener('scroll', placeCategory);
    $('#skillForm').addEventListener('input', event => {
      suspended = false; message(event.target.id === 'skillCall' ? '调用词仅用于本次复制，不会修改技能文件' : '有未保存的更改'); hold();
    });
    $('#skillForm').addEventListener('submit', async event => {
      event.preventDefault(); if (saving || !currentId) return;
      const id = currentId, input = values();
      closeCategory(); saving = true; suspended = false; setBusy(true); hold();
      try {
        await window.api.updateSkill({ id, ...input });
        if (currentId === id) { baseline = input; remember(); message('已保存到本机'); }
      } catch (error) { if (currentId === id) message(error.message, true); }
      finally { saving = false; setBusy(false); hold(); }
    });
    $('#skillPin').addEventListener('click', async () => {
      const id = currentId;
      try { await window.api.togglePin(id); } catch { if (currentId === id) message('收藏失败，请重试', true); }
    });
    $('#skillCopy').addEventListener('click', async () => {
      const id = currentId, text = $('#skillCall').value;
      try { await window.api.copySkill(id, text); if (currentId === id) message('已复制，可粘贴到本机 Agent'); }
      catch (error) { if (currentId === id) message(error.message, true); }
    });
  }
  function setBusy(active) {
    for (const id of ['skillSave', 'skillClose', 'skillAlias', 'skillCategory', 'skillCategoryToggle', 'skillNote']) $('#' + id).disabled = active;
  }
  function refresh() {
    if (categoryOpen) renderCategories(); if (!currentId) return;
    const item = (getView().skills || []).find(item => item.id === currentId);
    $('#skillCopy').disabled = !item || !!item.stale; $('#skillPin').disabled = !item; $('#skillSave').disabled = !item || saving;
    if (item) {
      $('#skillTitle').textContent = item.title;
      $('#skillDescription').textContent = item.description || '此技能尚未提供用途说明，可在下方补充备注。';
      $('#skillPin').textContent = item.pinned ? '已收藏' : '收藏'; $('#skillPin').setAttribute('aria-pressed', String(!!item.pinned));
      $('#skillStatus').textContent = (item.stale ? '暂无法读取 · 请重新扫描' : item.metadataWarning ? '本机已发现 · 说明格式待检查' : '本机已发现') + ' · 已复制 ' + (item.copyCount || 0) + ' 次';
      if (!dirty() && !saving) {
        baseline = { alias: item.alias || '', category: item.category || '', note: item.note || '' };
        $('#skillAlias').value = baseline.alias; $('#skillCategory').value = baseline.category; $('#skillNote').value = baseline.note;
      }
    } else message('该技能已不在扫描结果中，请刷新后重试。', true);
  }
  function open(item) {
    if (!item) return; if (currentId === item.id) { refresh(); return; }
    hide(); currentId = item.id; suspended = true;
    baseline = { alias: item.alias || '', category: item.category || '', note: item.note || '' };
    const draft = drafts.get(item.id) || baseline;
    $('#skillAlias').value = draft.alias; $('#skillCategory').value = draft.category; $('#skillNote').value = draft.note;
    categoryStart = draft.category;
    defaultCall = item.content; $('#skillCall').value = draft.call ?? defaultCall; $('#skillPath').textContent = item.skillPath;
    $('.skill-fields').scrollTop = 0; $('.skill-fields details').open = false;
    message(dirty() ? '已恢复未保存的更改' : ''); refresh();
    if (inline) $('#skillPreview').classList.remove('hidden'); else { $('#skillDetails').showModal(); $('#skillCopy').focus(); }
  }
  return { bind, refresh, open, hide, isOpen: () => !!currentId };
})();

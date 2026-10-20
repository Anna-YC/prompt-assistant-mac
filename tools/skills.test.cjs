'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../lib/store');
const { SkillLibrary, parseSkill, scanSkills, defaultSkillRoots } = require('../lib/skills');
const output = path.join(__dirname, '..', 'output', 'skills-tests');
fs.mkdirSync(output, { recursive: true });
const temp = () => fs.mkdtempSync(path.join(output, 'case-'));
function writeSkill(root, name, text) {
  const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, text || `---\nname: ${path.basename(name)}\ndescription: 用于文章写作和润色\n---\nInstructions`);
  return file;
}

test('YAML folded/quoted metadata, malformed community skills and plain Markdown remain discoverable', () => {
  assert.equal(parseSkill('\uFEFF---\r\nname: "article-edit"\r\ndescription: >-\r\n  中文用途\r\n  第二行\r\n---\r\n', 'fallback').description, '中文用途 第二行');
  const legacy = parseSkill('---\nname: docx\ndescription: 处理文档\n【技能需求】保留格式\nlicense: MIT\n---\n', 'fallback');
  assert.equal(legacy.name, 'docx'); assert(legacy.metadataWarning); assert(legacy.description.includes('保留格式'));
  const plain = parseSkill('# 自定义技能\n\n处理文章配图\n', 'custom');
  assert.equal(plain.name, 'custom'); assert.equal(plain.description, '处理文章配图');
  assert(parseSkill('---\nname: safe\ndescription: !!js/function function(){}\n---\n', 'safe').metadataWarning);
});

test('scanner handles nested/system folders, same names, duplicate roots and symlink cycles without execution', async () => {
  const root = temp(); writeSkill(root, 'one'); writeSkill(root, '.system/two');
  writeSkill(root, 'other/one');
  writeSkill(path.join(root, 'one'), 'references/hidden');
  fs.symlinkSync(root, path.join(root, 'cycle'), 'junction');
  const result = await scanSkills([root, root]);
  assert.equal(result.items.length, 3); assert.equal(new Set(result.items.map(item => item.id)).size, 3);
  assert.equal(result.errors.length, 0); assert.equal(result.items.filter(item => item.name === 'one').length, 2);
  assert(!fs.existsSync(path.join(root, 'executed')));
});

test('ZCode, WorkBuddy and shared Agent directories are discovered without scanning other application data', async () => {
  const home = temp(), custom = temp(), profile = temp();
  for (const agent of ['.agents', '.agent', '.zcode', '.workbuddy', '.trae']) writeSkill(home, agent + '/skills/skill-one');
  writeSkill(home, '.zcode/cache/not-installed');
  const roots = defaultSkillRoots(home);
  assert.equal(roots.length, 5);
  assert.equal((await scanSkills(roots)).items.length, 5);
  const store = new Store(profile); store.config.skills.roots = [custom]; store.skills = new SkillLibrary(store);
  await store.skills.discoverRoots(home);
  assert(store.skills.roots().includes(custom)); assert.equal(store.skills.roots().length, 6);
  assert.equal(store.skills.items().length, 5);
});

test('categories, favorites and notes survive scans, reloads, failed reads and category changes', async () => {
  const root = temp(), profile = temp(); const file = writeSkill(root, 'article-edit');
  const store = new Store(profile); store.config.skills.roots = [root]; store.skills = new SkillLibrary(store);
  await store.skills.scan(); const item = store.skills.items()[0];
  store.skills.update({ id: item.id, category: '写作', alias: '文章润色', note: '去 AI 味' });
  store.togglePin(item.id); store.recordCopy(item.id);
  assert.equal(store.getTrayItems().skills.length, 1);
  await store.skills.scan(); assert.equal(store.skills.items()[0].note, '去 AI 味');
  assert((await store.skills.prompt(item.id)).includes(file));
  const again = new Store(profile); again.skills = new SkillLibrary(again);
  assert.equal(again.skills.items()[0].title, '文章润色'); assert(again.skills.items()[0].pinned); assert.equal(again.skills.items()[0].copyCount, 1);
  again.skills.renameCategory('写作', '文案'); assert.equal(again.skills.items()[0].sub, '文案');
  again.skills.renameCategory('文案', ''); assert.equal(again.skills.items()[0].sub, '未分类');
  fs.writeFileSync(file, 'x'.repeat(512 * 1024 + 1));
  await again.skills.scan(); assert(again.skills.items()[0].stale); assert.equal(again.getTrayItems().skills.length, 0);
  await assert.rejects(again.skills.prompt(item.id), /重新扫描/);
  fs.unlinkSync(file); await again.skills.scan(); assert.equal(again.skills.items().length, 0);
  writeSkill(root, 'article-edit'); await again.skills.scan(); assert.equal(again.skills.items()[0].note, '去 AI 味');
  await again.skills.setRoots([]); assert.equal(again.skills.items().length, 0);
  await Promise.all([again.skills.setRoots([root]), again.skills.setRoots([])]);
  assert.deepEqual(again.skills.roots(), []); assert.equal(again.skills.items().length, 0);
  await assert.rejects(again.skills.setRoots(['relative']), /有效/);
});

test('retiring phrases preserves independent content, source mapping, pins and stats exactly once', () => {
  const profile = temp();
  fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({
    panel: { defaultTab: 'phrase' }, local: { prompt: [], phrase: [{ id: 'old-local', name: '旧短句', content: '保留正文' }] },
    sources: [{ id: 'source', kind: 'phrase', tableId: 'table' }], tray: { pinnedIds: ['old-local'] },
  }));
  fs.writeFileSync(path.join(profile, 'cache.json'), JSON.stringify({ prompts: [], phrases: [{ id: 'old-cloud', name: '云端短句', content: '云端正文', sourceId: 'source' }] }));
  fs.writeFileSync(path.join(profile, 'stats.json'), JSON.stringify({ 'old-local': { count: 3 } }));
  const store = new Store(profile), view = store.getView();
  assert.equal(view.prompts.length, 2); assert.equal(view.phrases.length, 0);
  assert(view.prompts.find(item => item.id === 'old-local').pinned); assert.equal(store.copyCountOf('old-local'), 3);
  assert.equal(store.config.sources[0].kind, 'prompt'); assert.equal(store.config.panel.defaultTab, 'all');
  assert.equal(new Store(profile).getView().prompts.length, 2);
});

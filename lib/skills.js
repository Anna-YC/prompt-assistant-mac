'use strict';
// 本机技能目录只读扫描；分类、别名和用途备注保存在应用配置中。
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const yaml = require('js-yaml');

/** 自动发现常见 Agent 已存在的用户级技能目录；项目目录可手动添加。 */
function defaultSkillRoots(home = os.homedir()) {
  return ['.agents', '.agent', '.codex', '.claude', '.zcode', '.workbuddy', '.trae', '.cursor', '.gemini']
    .map(dir => path.join(home, dir, 'skills'))
    .filter(directory => { try { return fs.statSync(directory).isDirectory(); } catch { return false; } });
}
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const within = (file, directory) => {
  const relative = path.relative(pathKey(directory), pathKey(file));
  return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};

/** 读取标准 YAML 元数据，支持折行、多行说明，不执行技能正文或脚本。 */
function parseSkill(text, fallback) {
  const source = String(text).replace(/^\uFEFF/, '');
  const match = source.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  let data, metadataWarning = false;
  try {
    data = match && yaml.load(match[1], { schema: yaml.JSON_SCHEMA, json: false });
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('metadata');
  } catch {
    // 部分现有技能没有 frontmatter，或把中文说明续行写在 YAML 顶层。
    // 它们仍是本机文件：尽量提取说明，另行标记格式，避免整项消失。
    metadataWarning = true;
    const header = match?.[1] || '';
    const name = header.match(/^name:[ \t]*(.+)$/m)?.[1] || fallback;
    const description = header.match(/^description:[ \t]*([\s\S]*?)(?=\n[A-Za-z][\w-]*:|(?![\s\S]))/m)?.[1] || '';
    data = { name: name.replace(/^(['"])(.*)\1$/, '$2'), description: description.replace(/^[>|][-+\d]*\s*/, '').trim() };
    if (!data.description) data.description = source.split(/\r?\n/).find(line => line.trim() && !/^\s*(?:#|---|```)/.test(line)) || '';
  }
  const name = typeof data.name === 'string' ? data.name.trim() : fallback;
  if (!name || /[\r\n]/.test(name)) throw new Error('技能名称不正确');
  return { name: name.slice(0, 160), description: typeof data.description === 'string' ? data.description.trim().slice(0, 4000) : '', metadataWarning };
}

/** 为可读取本机文件的 Agent 生成调用文本，不声称当前聊天已启用技能。 */
function skillPrompt(item) {
  return `请使用「${item.name}」技能执行以下任务：\n\n【填写你的任务】\n\n技能文件：${item.skillPath}\n请先读取该技能文件，并按其中说明执行。`;
}

/** 有界异步扫描，合并符号链接并隔离损坏目录和技能文件的错误。 */
async function scanSkills(roots, limits = {}) {
  const items = [], errors = [], visited = new Set();
  const maxDirectories = limits.maxDirectories || 12000;
  const maxDepth = limits.maxDepth || 12;
  const fail = (file, root, message) => errors.push({ path: file, root, message });
  async function visit(directory, root, depth) {
    if (depth > maxDepth || visited.size >= maxDirectories) { fail(directory, root, '目录层级或数量超过扫描范围'); return; }
    let real, entries;
    try {
      real = await fs.promises.realpath(directory);
      if (visited.has(pathKey(real))) return;
      visited.add(pathKey(real));
      entries = await fs.promises.readdir(real, { withFileTypes: true });
    } catch (error) {
      // 默认目录尚未创建是正常情况；目录存在但不可读则保留错误状态。
      if (!(error.code === 'ENOENT' && directory === root)) fail(directory, root, '目录无法读取');
      return;
    }
    const skillFile = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === 'skill.md');
    if (skillFile) {
      const skillPath = path.join(real, skillFile.name);
      try {
        const stat = await fs.promises.stat(skillPath);
        if (stat.size > 512 * 1024) throw new Error('技能文件过大，暂未读取');
        const metadata = parseSkill(await fs.promises.readFile(skillPath, 'utf8'), path.basename(real));
        const id = 'skill_' + crypto.createHash('sha256').update(pathKey(skillPath)).digest('hex').slice(0, 24);
        items.push({ ...metadata, id, skillPath, discoveredPath: path.join(directory, skillFile.name), scanRoot: root, modifiedAt: stat.mtimeMs });
      } catch (error) { fail(path.join(directory, skillFile.name), root, error.message); }
      // 一个技能包里的 references/assets 不作为额外的技能安装处理。
      return;
    }
    for (const entry of entries) {
      if (['node_modules', '.git', '__pycache__'].includes(entry.name)) continue;
      if (entry.isDirectory() || entry.isSymbolicLink()) await visit(path.join(directory, entry.name), root, depth + 1);
    }
  }
  for (const root of roots) await visit(root, root, 0);
  return { items, errors };
}

class SkillLibrary {
  constructor(store, onUpdated = () => {}) {
    this.store = store;
    this.onUpdated = onUpdated;
    this.file = path.join(store.dir, 'skills.json');
    this.cache = store._load(this.file, { items: [], lastScanAt: 0, errors: [] });
    if (!Array.isArray(this.cache.items)) this.cache.items = [];
    this.cache.items = this.cache.items.filter(item => this.roots().includes(item.scanRoot));
    this.pending = null;
    this.rootUpdates = Promise.resolve();
  }
  roots() { return this.store.config.skills.roots === null ? defaultSkillRoots() : this.store.config.skills.roots; }
  state() {
    return { roots: this.roots(), categories: this.store.config.skills.categories, scanning: !!this.pending,
      lastScanAt: this.cache.lastScanAt || 0, errors: this.cache.errors || [] };
  }
  items() {
    const { metadata } = this.store.config.skills;
    return this.cache.items.map(item => {
      const custom = Object.hasOwn(metadata, item.id) ? metadata[item.id] : {};
      return { ...item, kind: 'skill', title: custom.alias || item.name, alias: custom.alias || '',
        note: custom.note || '', category: custom.category || '', sub: custom.category || '未分类',
        tags: [custom.category || '未分类'], group: 'Skill', createdAt: 0,
        content: skillPrompt(item), pinned: this.store.config.tray.pinnedIds.includes(item.id), copyCount: this.store.copyCountOf(item.id) };
    });
  }
  /** 同时触发的刷新共用一次扫描；失败目录沿用旧结果并标明不可读取。 */
  scan() {
    if (this.pending) return this.pending;
    const roots = [...this.roots()];
    this.pending = (async () => {
      const result = await scanSkills(roots);
      const found = new Set(result.items.map(item => item.id));
      for (const previous of this.cache.items) {
        if (!found.has(previous.id) && roots.includes(previous.scanRoot) && result.errors.some(error =>
          within(previous.discoveredPath || previous.skillPath, error.path))) {
          result.items.push({ ...previous, stale: true });
        }
      }
      this.cache = { ...result, lastScanAt: Date.now() };
      fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2));
      return { ok: result.errors.length === 0, count: result.items.length };
    })().finally(() => { this.pending = null; this.onUpdated(); });
    this.onUpdated();
    return this.pending;
  }
  /** 修改本机目录后重新扫描，不改变技能文件。 */
  async setRoots(roots) {
    if (!Array.isArray(roots) || roots.length > 40 || roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) throw new Error('请选择有效的本机目录');
    const update = this.rootUpdates.then(async () => {
      if (this.pending) await this.pending;
      this.store.config.skills.roots = [...new Set(roots.map(root => path.resolve(root)))];
      this.store.saveConfig();
      return this.scan();
    });
    this.rootUpdates = update.catch(() => {});
    return update;
  }
  /** 将新发现的 Agent 目录加入已有自定义列表，保留用户手动添加的目录。 */
  async discoverRoots(home = os.homedir()) {
    if (this.store.config.skills.roots === null) return this.scan();
    return this.setRoots([...new Set([...this.roots(), ...defaultSkillRoots(home)])]);
  }
  /** 保存单个技能的本机分类、显示别名和用途备注。 */
  update(input) {
    if (!input || !this.cache.items.some(item => item.id === input.id)) throw new Error('技能已不在列表中，请刷新');
    const category = String(input.category || '').trim().slice(0, 40);
    const metadata = { category, alias: String(input.alias || '').trim().slice(0, 160), note: String(input.note || '').trim().slice(0, 2000) };
    Object.defineProperty(this.store.config.skills.metadata, input.id, { value: metadata, enumerable: true, configurable: true, writable: true });
    if (category && !this.store.config.skills.categories.includes(category)) this.store.config.skills.categories.push(category);
    this.store.saveConfig();
    return this.items().find(item => item.id === input.id);
  }
  /** 重命名或移除分类，保留每个技能的其他本机偏好。 */
  renameCategory(from, to) {
    if (typeof from !== 'string' || !this.store.config.skills.categories.includes(from)) throw new Error('分类不存在');
    const name = String(to || '').trim().slice(0, 40);
    for (const value of Object.values(this.store.config.skills.metadata)) if (value.category === from) value.category = name;
    this.store.config.skills.categories = [...new Set(this.store.config.skills.categories.map(category => category === from ? name : category).filter(Boolean))];
    this.store.saveConfig();
    return this.state();
  }
  async prompt(id) {
    const item = this.cache.items.find(item => item.id === id);
    if (!item || item.stale) throw new Error('技能暂不可读取，请重新扫描');
    try { await fs.promises.access(item.skillPath, fs.constants.R_OK); }
    catch { throw new Error('技能文件已移动或不可读取，请重新扫描'); }
    return skillPrompt(item);
  }
}

module.exports = { SkillLibrary, defaultSkillRoots, parseSkill, scanSkills, skillPrompt };

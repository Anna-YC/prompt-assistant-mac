'use strict';
// 飞书多维表数据层：通过本机已认证的 lark-cli 读取数据（零配置），
// 负责分页拉取、字段映射、附件（效果预览图）下载。
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const TOKEN_RE = /^[A-Za-z0-9_-]+$/;

function safeArg(v) {
  const s = String(v == null ? '' : v);
  if (/[&|<>^";`$*?]/.test(s)) throw new Error('参数含非法字符: ' + s.slice(0, 40));
  return s.includes(' ') ? `"${s}"` : s;
}

// 解析 lark-cli 的真实 JS 入口（npm 全局安装的 shim 指向 run.js），
// 以便用 Node 直接执行，彻底避开 Windows cmd 引号转义问题。
const targetCache = new Map();
// 用户在设置页改了 lark-cli 路径后调用，丢掉旧的解析结果。
// 不失效的话必须重启应用才生效——缓存按 cfg.larkCliPath 的字符串做 key，
// 但换成同一个字符串指向不同实体（比如重装到别的目录）时也会命中旧结果。
function invalidateCliCache() {
  targetCache.clear();
}
function resolveCliTarget(cfg) {
  const cli = cfg.larkCliPath || (process.platform === 'win32' ? 'lark-cli.cmd' : 'lark-cli');
  if (targetCache.has(cli)) return targetCache.get(cli);
  const candidates = [];
  // 0) 便携安装的单一可执行文件（一键自动配置下载的 lark-cli.exe）：直接执行，
  //    不经 cmd，彻底无引号转义问题；也避免下面把几十 MB 的 exe 当文本读
  if (/\.exe$/i.test(cli) && fs.existsSync(cli)) {
    const t = { mode: 'exe', exe: path.resolve(cli) };
    targetCache.set(cli, t);
    return t;
  }
  // 1) 显式配置的 js 入口
  if (/\.js$/i.test(cli)) candidates.push(cli);
  // 2) 从 .cmd/.bat shim 内容解析 js 路径
  if (/\.(cmd|bat)$/i.test(cli) || fs.existsSync(cli)) {
    const shimPaths = [cli];
    // 由命令名推导全局 shim 路径
    const npmGlobal = path.join(process.env.APPDATA || '', 'npm');
    shimPaths.push(path.join(npmGlobal, 'lark-cli.cmd'));
    for (const sp of shimPaths) {
      try {
        const txt = fs.readFileSync(sp, 'utf8');
        const m = txt.match(/"([^"]*?node_modules[^"]*?\.js)"/i) || txt.match(/(%dp0%[^"\s]*?\.js)/i);
        if (m) {
          let p = m[1].replace(/%dp0%/gi, path.dirname(sp) + path.sep);
          p = path.resolve(p);
          if (fs.existsSync(p)) candidates.push(p);
        }
      } catch {}
    }
    // 3) 常见全局安装位置
    candidates.push(path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js'));
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      const t = { mode: 'node', js: c };
      targetCache.set(cli, t);
      return t;
    }
  }
  const t = { mode: 'cmd', cli };
  targetCache.set(cli, t);
  return t;
}

// 优先用系统 node 执行 CLI（杜绝任何 Electron 子进程窗口）；不可用时回退 Electron 内置 Node
let systemNodeOk = null;
function probeSystemNode() {
  return new Promise((res) => {
    execFile('node', ['-v'], { windowsHide: true }, (err) => {
      systemNodeOk = !err;
      res(systemNodeOk);
    });
  });
}

function runCli(cfg, args, { timeout = 90000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const target = resolveCliTarget(cfg);
    let child;
    if (target.mode === 'exe') {
      // 便携 exe：无 shell，参数原样传递（不经 safeArg 加引号）
      child = execFile(
        target.exe,
        args,
        { windowsHide: true, timeout, maxBuffer: 1024 * 1024 * 128, cwd: cwd || process.env.USERPROFILE || '/' },
        done
      );
    } else if (target.mode === 'node') {
      const useSystemNode = systemNodeOk === true;
      child = execFile(
        useSystemNode ? 'node' : process.execPath,
        [target.js, ...args],
        {
          windowsHide: true, timeout, maxBuffer: 1024 * 1024 * 128,
          cwd: cwd || process.env.USERPROFILE || '/',
          env: useSystemNode ? { ...process.env } : { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        },
        (err, stdout, stderr) => {
          // 系统 node 不存在（ENOENT）时回退内置 Node 重试一次
          if (err && err.code === 'ENOENT' && useSystemNode) {
            systemNodeOk = false;
            runCli(cfg, args, { timeout, cwd }).then(resolve, reject);
            return;
          }
          done(err, stdout, stderr);
        }
      );
    } else {
      const cmd = `${target.cli} ${args.map(safeArg).join(' ')}`;
      child = execFile(
        process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
        process.platform === 'win32' ? ['/d', '/c', cmd] : ['-c', cmd],
        { windowsHide: true, timeout, maxBuffer: 1024 * 1024 * 128, cwd: cwd || process.env.USERPROFILE || '/' },
        done
      );
    }
    function done(err, stdout, stderr) {
        if (err && !stdout) {
          let message = (stderr || err.message || '').toString();
          try { message = JSON.parse(message).error?.message || message; } catch {}
          return reject(new Error(message.slice(0, 500)));
        }
        let j;
        try {
          j = JSON.parse(stdout);
        } catch {
          return reject(new Error('lark-cli 输出无法解析: ' + stdout.slice(0, 200)));
        }
        if (j && j.ok === false) {
          const e = j.error || {};
          return reject(new Error(e.message || JSON.stringify(e).slice(0, 300)));
        }
      resolve(j && j.data !== undefined ? j.data : j);
    }
  });
}

async function listTables(cfg) {
  const d = await runCli(cfg, ['base', '+table-list', '--base-token', cfg.baseToken, '--as', cfg.identity || 'user']);
  return (d.tables || []).map((t) => ({ id: t.id, name: t.name, count: t.records_count }));
}

async function listFields(cfg, tableId) {
  const d = await runCli(cfg, ['base', '+field-list', '--base-token', cfg.baseToken, '--table-id', tableId, '--as', cfg.identity || 'user']);
  return (d.fields || []).map((f) => ({ id: f.id, name: f.name, type: f.type }));
}

// 分页拉取全部记录，返回 [{recordId, cells: {字段名: 归一化值}}]
async function fetchAllRecords(cfg, tableId) {
  const out = [];
  let offset = 0;
  const limit = 200;
  for (let guard = 0; guard < 50; guard++) {
    const d = await runCli(cfg, [
      'base', '+record-list',
      '--base-token', cfg.baseToken,
      '--table-id', tableId,
      '--limit', String(limit),
      '--offset', String(offset),
      '--json',
      '--as', cfg.identity || 'user',
    ]);
    const fields = d.fields;
    const rows = d.data;
    const ids = d.record_id_list;
    if (!Array.isArray(fields) || !Array.isArray(rows) || !Array.isArray(ids) || ids.length !== rows.length || ids.some(id => typeof id !== 'string' || !TOKEN_RE.test(id))) {
      throw new Error('飞书记录列表不完整，本轮保留旧数据，请稍后重新同步');
    }
    rows.forEach((row, i) => {
      const cells = {};
      fields.forEach((f, j) => (cells[f] = row[j]));
      out.push({ recordId: ids[i], cells });
    });
    if (d.has_more === false) return out;
    if (d.has_more !== true || rows.length === 0) throw new Error('飞书分页未完成，本轮保留旧数据，请稍后重新同步');
    offset += rows.length;
  }
  throw new Error('飞书记录超过单次分页上限，本轮保留旧数据');
}

function asText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(' / ');
  if (typeof v === 'object') return v.text || v.name || JSON.stringify(v);
  return String(v);
}

function asTags(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(asText).filter(Boolean);
  const s = asText(v).trim();
  return s ? [s] : [];
}

// lark-cli returns datetime cells as ISO strings; older exports may use
// Unix seconds or milliseconds. Missing values stay unknown, never sync time.
function asTimestamp(value) {
  if (Array.isArray(value)) {
    for (const part of value) { const time = asTimestamp(part); if (time) return time; }
    return 0;
  }
  if (value && typeof value === 'object') return asTimestamp(value.value ?? value.timestamp ?? value.text);
  if (value == null || value === '') return 0;
  const text = String(value).trim();
  const numeric = typeof value === 'number' || /^\d+(\.\d+)?$/.test(text);
  const time = numeric ? Number(value) * (Number(value) < 1e11 ? 1000 : 1) : Date.parse(text);
  return Number.isFinite(time) && time > 0 ? time : 0;
}

// 链接字段归一化：URL 字段值是 {text, link} 对象时取 link；
// markdown 形式 [文本](url) 取括号里的 URL；其余按纯文本返回
// （旧实现把 [文本](url) 剥成显示文本，openExternal 的 ^https?:// 校验直接吞掉）
function asLink(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && v.link) return String(v.link).trim();
  const s = asText(v).trim();
  const m = /\]\((https?:\/\/[^)\s]+)\)/.exec(s);
  return m ? m[1] : s;
}

// 依据字段名猜测映射（用于设置页“自动识别”）
function guessMapping(fields) {
  const names = fields.map((f) => f.name);
  const pick = (cands, typeFilter) => {
    for (const c of cands) {
      const hit = names.find((n) => n === c && (!typeFilter || typeFilter(fields.find((f) => f.name === n))));
      if (hit) return hit;
    }
    for (const c of cands) {
      const hit = names.find((n) => n.includes(c) && (!typeFilter || typeFilter(fields.find((f) => f.name === n))));
      if (hit) return hit;
    }
    return '';
  };
  const isText = (f) => f && (f.type === 'text' || f.type === 'markdown' || f.type === 'number');
  const isSelect = (f) => f && (f.type === 'select' || f.type === 'text');
  const isAttach = (f) => f && f.type === 'attachment';

  const content = pick(['内容', '正文', '提示词', 'content', 'prompt'], (f) => isText(f) && !f.name.includes('可直接复制提示词'));
  const title = pick(['提示词用途', '标题', '页面标题', '名称', 'title', 'name'], isText) ||
    names.find((n) => n !== content && isText(fields.find((f) => f.name === n))) || '';
  const tags = names.filter((n) => {
    const f = fields.find((x) => x.name === n);
    return f && f.type === 'select' && !/模型|状态|来源|泛用/.test(n);
  });
  const video = names.find((n) => {
    const f = fields.find((x) => x.name === n);
    return f && f.type === 'attachment' && /视频|video/i.test(n);
  }) || '';
  const image = names.find((n) => {
    const f = fields.find((x) => x.name === n);
    return f && f.type === 'attachment' && n !== video && /效果|封面|图片|图例|image|cover/i.test(n);
  }) || '';
  const note = pick(['用途', '备注', '适合场景', 'note'], (f) => f && f.type === 'text' && f.name !== title && f.name !== content);
  const link = pick(['链接', '来源URL', 'link', 'url'], isText);
  const createdAt = pick(['添加时间', '创建时间', '录入时间', '采集时间', '收藏时间', 'created_time', 'created_at', 'createdAt']);
  const model = pick(['使用模型', '生图模型', '视频模型', '生成模型', '模型', 'model']);
  return { title, content, tags, image, video, note, link, createdAt, model };
}

// 校验/补全映射：映射中缺失或表里不存在的字段角色，用自动识别结果兜底
function effectiveMapping(fields, mapping) {
  const guess = guessMapping(fields);
  const names = new Set(fields.map((f) => f.name));
  const m = mapping || {};
  const ok = (v) => (Array.isArray(v) ? v.length > 0 && v.every((x) => names.has(x)) : !!v && names.has(v));
  const out = {};
  for (const role of ['title', 'image', 'video', 'note', 'link', 'createdAt', 'model']) {
    out[role] = ok(m[role]) ? m[role] : guess[role];
  }
  // The raw clipping column takes precedence over legacy AI-generated mappings.
  // Never fall back to an AI result, including when the raw cell is empty.
  const savedContent = typeof m.content === 'string' && ok(m.content) && !m.content.includes('可直接复制提示词');
  out.content = names.has('内容') ? '内容' : savedContent ? m.content : guess.content;
  out.tags = ok(m.tags) ? m.tags : guess.tags;
  return out;
}

function mapRecord(rec, mapping, srcId, tableName, tableId) {
  const c = rec.cells;
  const tagFields = Array.isArray(mapping.tags) ? mapping.tags : mapping.tags ? [mapping.tags] : [];
  const tags = [];
  for (const tf of tagFields) for (const t of asTags(c[tf])) if (t && !tags.includes(t)) tags.push(t);
  const atts = c[mapping.image];
  const image = Array.isArray(atts) && atts.length ? { fileToken: atts[0].file_token, name: atts[0].name, size: atts[0].size } : null;
  const vatts = c[mapping.video];
  const video = Array.isArray(vatts) && vatts.length ? { fileToken: vatts[0].file_token, name: vatts[0].name, size: vatts[0].size } : null;
  return {
    id: `${srcId}:${rec.recordId}`,
    recordId: rec.recordId,
    sourceId: srcId,
    tableId: tableId || '',
    tableName,
    createdAt: mapping.createdAt ? asTimestamp(c[mapping.createdAt]) : 0,
    title: asText(c[mapping.title]).trim() || asText(c[mapping.content]).slice(0, 24) || '(无标题)',
    content: asText(c[mapping.content]).trim(),
    model: mapping.model ? asText(c[mapping.model]).trim() : '',
    tags,
    note: mapping.note ? asText(c[mapping.note]).trim() : '',
    link: mapping.link ? asLink(c[mapping.link]) : '',
    image,
    video,
  };
}

function downloadAttachment(cfg, { tableId, recordId, fileToken, destPath }) {
  // lark-cli 的 --output 只接受相对路径：以目标目录为 cwd，仅传文件名
  return runCli(cfg, [
    'base', '+record-download-attachment',
    '--base-token', cfg.baseToken,
    '--table-id', tableId,
    '--record-id', recordId,
    '--file-token', fileToken,
    '--output', path.basename(destPath),
    '--overwrite',
    '--as', cfg.identity || 'user',
  ], { timeout: 180000, cwd: path.dirname(destPath) });
}

async function syncSource(cfg, source, imgDir, onProgress) {
  const records = await fetchAllRecords(cfg, source.tableId);
  const fields = await listFields(cfg, source.tableId);
  const mapping = effectiveMapping(fields, source.mapping);
  const items = records
    .map((r) => mapRecord(r, mapping, source.id, source.name, source.tableId))
    .filter((it) => it.content || it.title !== '(无标题)');

  // 下载效果预览图（可选，只处理图片附件，带缓存跳过）
  if (source.downloadImages) {
    let done = 0;
    const queue = items.filter((it) => it.image);
    const worker = async () => {
      while (queue.length) {
        const it = queue.shift();
        const ext = path.extname(it.image.name || '') || '.png';
        // 命名约定与 main.js 的 ensureMedia / 启动重挂一致（含 _img 后缀），否则两边互认不出
        const fname = `${source.tableId}_${it.recordId}_img${ext}`;
        const dest = path.join(imgDir, fname);
        if (!fs.existsSync(dest) || fs.statSync(dest).size === 0) {
          try {
            await downloadAttachment(cfg, { tableId: source.tableId, recordId: it.recordId, fileToken: it.image.fileToken, destPath: dest });
          } catch (e) {
            it.image.error = String(e.message || e).slice(0, 120);
          }
        }
        if (fs.existsSync(dest)) it.image.localPath = dest;
        done++;
        if (onProgress) onProgress(done, items.length);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }
  return items;
}

async function createPrompt(cfg, source, input) {
  const title = String(input.title || '').trim();
  const content = String(input.content || '').trim();
  if (!title || !content) throw new Error('请填写标题和提示词正文');
  if (title.length > 200 || content.length > 50000) throw new Error('标题最多 200 字，正文最多 50000 字');
  const fields = await listFields(cfg, source.tableId);
  const mapping = effectiveMapping(fields, source.mapping);
  const textField = name => fields.find(field => field.name === name && ['text', 'markdown'].includes(field.type));
  if (!textField(mapping.title) || !textField(mapping.content) || mapping.title === mapping.content) {
    throw new Error('这张表需要两个可编辑的文本字段，分别保存标题和正文，请在数据源中检查字段映射');
  }
  const createdAt = Date.now();
  const cells = { [mapping.title]: title, [mapping.content]: content };
  if (fields.some(field => field.name === mapping.createdAt && field.type === 'datetime')) cells[mapping.createdAt] = new Date(createdAt).toISOString();
  // A private temporary file preserves arbitrary quotes/newlines and avoids
  // passing prompt content through cmd.exe or exposing it in process arguments.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-assistant-create-'));
  const file = path.join(tempDir, 'record.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ create_records: [cells] }), { mode: 0o600 });
    const result = await runCli(cfg, ['base', '+record-batch-create', '--base-token', cfg.baseToken,
      '--table-id', source.tableId, '--json', '@' + path.basename(file), '--as', cfg.identity || 'user'], { cwd: tempDir });
    const recordId = result.record_id_list?.[0];
    if (typeof recordId !== 'string' || !recordId) throw new Error('飞书未返回记录编号，保存结果未确认，请先同步检查后再重试');
    if (result.ignored_fields?.length) {
      const error = new Error('飞书已创建记录，但有字段未能写入，请到表格检查这条记录，避免重复新增');
      error.createdRecordId = recordId;
      throw error;
    }
    return { ...mapRecord({ recordId, cells }, mapping, source.id, source.name, source.tableId),
      createdAt, desktopCreatedAt: createdAt, origin: 'feishu' };
  } finally {
    try { fs.unlinkSync(file); } catch {}
    try { fs.rmdirSync(tempDir); } catch {}
  }
}

async function deletePrompts(cfg, tableId, recordIds) {
  if (!TOKEN_RE.test(tableId) || !Array.isArray(recordIds) || !recordIds.length || recordIds.length > 200 || recordIds.some(id => typeof id !== 'string' || !TOKEN_RE.test(id))) throw new Error('删除目标无效，请先同步后重试');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-assistant-delete-'));
  const file = path.join(tempDir, 'records.json');
  let writeError;
  try {
    fs.writeFileSync(file, JSON.stringify({ record_id_list: [...new Set(recordIds)] }), { mode: 0o600 });
    try {
      await runCli(cfg, ['base', '+record-delete', '--base-token', cfg.baseToken, '--table-id', tableId,
        '--json', '@' + path.basename(file), '--as', cfg.identity || 'user', '--yes'], { cwd: tempDir });
    } catch (error) { writeError = error; }
    // 不猜测 CLI 各版本回执：完整读回确认每条是否已消失，也兼容已在飞书删除的记录。
    let remaining;
    try { remaining = new Set((await fetchAllRecords(cfg, tableId)).map(item => item.recordId)); }
    catch (error) { throw new Error(writeError?.message || '删除结果暂无法确认，请同步后检查：' + error.message); }
    return { deletedIds: recordIds.filter(id => !remaining.has(id)), failedIds: recordIds.filter(id => remaining.has(id)),
      error: writeError?.message || '飞书尚未确认删除，请同步后重试' };
  } finally {
    try { fs.unlinkSync(file); } catch {}
    try { fs.rmdirSync(tempDir); } catch {}
  }
}

module.exports = { runCli, listTables, listFields, fetchAllRecords, guessMapping, syncSource, createPrompt, deletePrompts, downloadAttachment, probeSystemNode, invalidateCliCache };

'use strict';
// Isolated Electron fixture: never reads or writes the installed app's profile.
const { app, screen, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const profile = path.join(root, 'output', 'playwright', 'gallery-profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
const { defaultConfig } = require('../lib/config');
const config = defaultConfig();
config.behavior.launchAtLogin = false;
// Verify that upgrading an existing profile removes the old 550ms delay.
config.panel.autoCollapseMs = 550;
config.local = { prompt: [], phrase: [{ id: 'phrase1', title: '电影感光影', content: '自然柔和的光线，细腻丰富的画面层次。', tags: ['光影'] }] };
const mediaDir = path.join(root, 'cache', 'media');
const files = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir).filter((s) => /\.(png|jpe?g|webp)$/i.test(s)).slice(0, 12) : [];
const videoFile = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir).find((s) => /\.mp4$/i.test(s)) : null;
const titles = ['漫剧人物三视图', '山水场景', '电影感运镜', '产品光影', '极简海报', '图片转3D风格', '室内场景', '萌宠生物特写'];
const prompts = Array.from({ length: 72 }, (_, i) => ({
  id: 'demo' + i, tableId: 'tblDemo', recordId: 'rec' + i,
  title: titles[i % titles.length] + (i >= 8 ? ' ' + (i + 1) : ''),
  content: i === 1 ? '生成中国山水场景，层叠的远山与云雾，柔和的光影，细腻的材质和构图。' : '生成同一角色的正面、侧面与背面视图，保持角色外貌、服装和风格一致。\n自然柔和的光线，细腻丰富的画面层次。适用于角色设定与创作参考。'.repeat(i === 0 ? 5 : 1),
  tableName: i % 4 === 2 ? '视频提示词-成品' : i % 7 === 6 ? '常用提示词库' : '生图提示词-' + (i % 2 ? '环境' : '人物'),
  tags: [i % 2 ? '环境' : '人物设定', '创作参考'],
  image: files.length && i % 7 !== 6 ? { fileToken: 'fixture' + i, name: files[i % files.length], localPath: path.join(mediaDir, files[i % files.length]) } : null,
  video: i === 2 && videoFile ? { fileToken: 'fixtureVideo', name: videoFile, localPath: path.join(mediaDir, videoFile) } : null,
}));
if (process.env.GALLERY_TEST_ITEMS) {
  prompts.splice(0, prompts.length, ...JSON.parse(fs.readFileSync(process.env.GALLERY_TEST_ITEMS, 'utf8')));
}
if (process.env.GALLERY_TEST_FIELDS) {
  const fields = JSON.parse(fs.readFileSync(process.env.GALLERY_TEST_FIELDS, 'utf8'));
  config.sources = [{id:'main',tableId:'main',name:'生图提示词-人物',kind:'prompt',enabled:true,mapping:{content:'可直接复制提示词'}}];
  require('../lib/feishu').listFields = async (_cfg, tableId) => fields[tableId] || [];
}
if (process.env.GALLERY_TEST_CLOUD_CLI) {
  config.baseToken = 'fixture';
  config.larkCliPath = process.env.GALLERY_TEST_CLOUD_CLI;
  config.sources = [{ id:'common',tableId:'tblCommonFixture',name:'常用提示词库',kind:'prompt',enabled:true,mapping:{title:'提示词用途',content:'提示词'} }];
}
if (process.env.GALLERY_TEST_SYNC) {
  config.baseToken = 'fixture';
  config.sources = [{ id: 'fixture', tableId: 'tblDemo', kind: 'prompt', name: '生图提示词-人物', enabled: true }];
  prompts.forEach(p => { p.sourceId = 'fixture'; });
  let revision = 0;
  require('../lib/feishu').syncSource = async () => {
    await new Promise(resolve => setTimeout(resolve, 400));
    revision++;
    return prompts.map(p => ({ ...p, content: p.content + '\n同步版本 ' + revision }));
  };
}
config.tray.pinnedIds = ['demo0'];
fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify(config));
fs.writeFileSync(path.join(profile, 'cache.json'), JSON.stringify({ prompts, phrases: [], tables: [], lastSyncAt: Date.now() }));
fs.writeFileSync(path.join(profile, 'stats.json'), JSON.stringify({ demo0: { count: 8, lastAt: Date.now() }, demo1: { count: 4, lastAt: Date.now() } }));
// Deterministic cursor for native window-boundary tests; OS cursor is untouched.
global.galleryTestCursor = { x: -10000, y: -10000 };
global.galleryTestClipboard = '';
app.whenReady().then(() => {
  screen.getCursorScreenPoint = () => global.galleryTestCursor;
  clipboard.writeText = (text) => { global.galleryTestClipboard = text; };
});
require('../lib/feishu').probeSystemNode = () => {};
require('../lib/feishu').listTables = async () => [];
require('../main');

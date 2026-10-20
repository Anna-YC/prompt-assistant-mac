'use strict';
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { _electron } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const root = path.join(__dirname, '..');
const output = path.join(root, 'output', 'playwright', 'fonts');
fs.mkdirSync(output, { recursive: true });
async function checkFont(page, selector) {
  await page.evaluate(async () => {
    for (const weight of [400, 500, 600, 700]) await document.fonts.load(`${weight} 14px "Alibaba PuHuiTi 2.0"`, '技能分类 ABC');
    await document.fonts.ready;
  });
  const faces = await page.evaluate(() => [...document.fonts].map(font => ({ family: font.family, weight: font.weight, status: font.status })));
  assert.equal(faces.filter(font => font.family === 'Alibaba PuHuiTi 2.0' && font.status === 'loaded').length, 4);
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('DOM.enable'); await session.send('CSS.enable');
    const document = await session.send('DOM.getDocument');
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: document.root.nodeId, selector });
    const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
    assert(fonts.some(font => font.isCustomFont && /Alibaba|普惠/.test(font.familyName)), JSON.stringify(fonts));
  } finally { await session.detach(); }
}
(async () => {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.PREVIEW_SETTINGS;
  const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(__dirname, 'gallery-test-app.cjs')], env });
  try {
    const panel = await app.firstWindow(); await panel.waitForSelector('#tabRow button');
    // All font resources must remain local even with network access unavailable.
    await panel.context().route(/^https?:/, route => route.abort());
    await panel.evaluate(() => window.api.requestExpand(true));
    await checkFont(panel, 'h1');
    await panel.screenshot({ path: path.join(output, 'panel-puhuiti.png') });
    const [preview] = await Promise.all([app.waitForEvent('window'), panel.evaluate(() => window.api.showPreview({ id: 'demo1', top: 180 }))]);
    await preview.waitForSelector('#previewTitle'); await checkFont(preview, '#previewTitle');
    await preview.screenshot({ path: path.join(output, 'preview-puhuiti.png') });
    await panel.evaluate(() => window.api.hidePreview());
    const [settings] = await Promise.all([app.waitForEvent('window'), panel.locator('#btnSettings').click()]);
    await settings.waitForSelector('[data-tab="skills"]'); await settings.locator('[data-tab="skills"]').click();
    await checkFont(settings, '#tab-skills h2');
    await settings.screenshot({ path: path.join(output, 'settings-puhuiti.png') });
    console.log('PASS: bundled Alibaba PuHuiTi 2.0 renders in panel, preview and settings; all four weights load with HTTP blocked.');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

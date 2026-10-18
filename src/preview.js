'use strict';
const $ = (s) => document.querySelector(s);
let item = null, sequence = 0, toastTimer, copyTimer;
const localUrl = (p) => 'localimg:///' + encodeURIComponent(String(p).split(/[\\/]/).pop());
function resetMedia() {
  const video = $('#previewVideo');
  video.pause(); video.removeAttribute('src'); video.removeAttribute('poster'); video.load();
  video.classList.add('hidden');
  $('#previewImage').removeAttribute('src'); $('#previewImage').classList.add('hidden');
  $('#playVideo').classList.add('hidden'); $('#playVideo').disabled = false;
  $('#playVideo span').textContent = '播放视频';
  $('#mediaMessage').textContent = '';
}
function refresh(p) {
  item = p.item;
  document.body.dataset.theme = p.appearance?.theme === 'dark' ? 'dark' : 'light';
  document.body.style.setProperty('--acc', p.appearance?.accent || '#ed7059');
  $('#previewTitle').textContent = item.title || item.name || '提示词';
  $('#previewText').textContent = item.content || '暂无正文';
  const model = typeof item.model === 'string' ? item.model.trim() : '';
  $('#previewModel').textContent = model || '未标注';
  $('#previewModel').title = model || '表格中尚未填写模型';
  $('.preview-model').classList.toggle('unmarked', !model);
  $('#copyCount').textContent = '已复制 ' + (item.copyCount || 0) + ' 次';
  $('#previewLink').classList.toggle('hidden', !item.link);
  $('#previewPin').classList.toggle('on', !!item.pinned);
  $('#previewPin').setAttribute('aria-pressed', String(!!item.pinned));
  $('#previewPin').setAttribute('aria-label', item.pinned ? '取消收藏' : '收藏');
  $('#previewPin').title = item.pinned ? '取消收藏' : '收藏到常用词';
  $('#previewTags').replaceChildren(...(item.tags || []).slice(0, 4).map((tag) => {
    const el = document.createElement('span'); el.textContent = tag; return el;
  }));
}
async function mediaPath(target, role) {
  const m = target[role];
  if (m?.localPath) return m.localPath;
  if (!m?.fileToken) return null;
  const result = await window.api.mediaEnsure({ tableId: target.tableId, recordId: target.recordId, fileToken: m.fileToken, name: m.name, role });
  return result?.localPath || null;
}
async function playVideo() {
  if (!item?.video?.fileToken) return;
  const ticket = sequence, target = item;
  $('#playVideo').disabled = true; $('#playVideo span').textContent = '正在加载…';
  try {
    const path = await mediaPath(target, 'video');
    if (ticket !== sequence) return;
    if (!path) throw new Error('No video');
    target.video.localPath = path;
    const video = $('#previewVideo');
    video.src = localUrl(path); video.muted = true;
    video.classList.remove('hidden'); $('#playVideo').classList.add('hidden');
    await video.play();
  } catch {
    if (ticket === sequence) { $('#playVideo').disabled = false; $('#playVideo').classList.remove('hidden'); $('#playVideo span').textContent = '重试播放'; toast('视频暂时无法播放，请重试'); }
  }
}
async function show(p) {
  const ticket = ++sequence;
  resetMedia(); refresh(p); $('#previewText').scrollTop = 0;
  clearTimeout(copyTimer); $('#previewCopy span').textContent = '复制提示词';
  const target = item;
  const hasMedia = !!(target.image?.fileToken || target.video?.fileToken);
  $('#previewMedia').classList.toggle('hidden', !hasMedia);
  if (target.video?.fileToken) $('#playVideo').classList.remove('hidden');
  if (target.image?.fileToken) {
    $('#mediaMessage').textContent = '正在加载预览…';
    try {
      const path = await mediaPath(target, 'image');
      if (ticket !== sequence) return;
      if (!path) throw new Error('No image');
      target.image.localPath = path;
      $('#previewImage').src = localUrl(path); $('#previewImage').classList.remove('hidden');
      $('#mediaMessage').textContent = '';
    } catch { if (ticket === sequence) $('#mediaMessage').textContent = '图片暂时不可用，仍可复制全文'; }
  } else if (hasMedia) $('#mediaMessage').textContent = '点击播放，查看视频效果';
  if (ticket === sequence && p.play) playVideo();
}
function toast(text) {
  $('#toast').textContent = text; $('#toast').classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 1600);
}
window.api.on('preview:item', show);
window.api.on('preview:refresh', (p) => { if (item?.id === p.item.id) refresh(p); });
window.api.on('preview:hide', () => { ++sequence; resetMedia(); item = null; });
$('#previewImage').addEventListener('error', () => { $('#previewImage').classList.add('hidden'); $('#mediaMessage').textContent = '图片暂时不可用，仍可复制全文'; });
$('#previewVideo').addEventListener('error', () => { if (item) toast('视频暂时无法播放'); });
$('#playVideo').addEventListener('click', playVideo);
$('#previewClose').addEventListener('click', () => window.api.hidePreview());
$('#previewCopy').addEventListener('click', async () => {
  if (!item) return;
  const target = item;
  try {
    await window.api.copy(target.content, target.title || target.name, target.id);
    if (item?.id !== target.id) return;
    target.copyCount = (target.copyCount || 0) + 1;
    $('#copyCount').textContent = '已复制 ' + target.copyCount + ' 次';
    $('#previewCopy span').textContent = '已复制'; clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { $('#previewCopy span').textContent = '复制提示词'; }, 1500);
  } catch { toast('复制失败，请重试'); }
});
$('#previewPin').addEventListener('click', async () => { if (item) try { await window.api.togglePin(item.id); } catch { toast('收藏失败，请重试'); } });
$('#previewLink').addEventListener('click', () => { if (item?.link) window.api.openExternal(item.link); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.api.hidePreview(); });

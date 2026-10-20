'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 数据
  getData: () => ipcRenderer.invoke('data:get'),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  scanSkills: () => ipcRenderer.invoke('skills:scan'),
  discoverSkillRoots: () => ipcRenderer.invoke('skills:discover'),
  updateSkill: (input) => ipcRenderer.invoke('skills:update', input),
  renameSkillCategory: (input) => ipcRenderer.invoke('skills:category', input),
  setSkillRoots: (roots) => ipcRenderer.invoke('skills:roots', roots),
  pickSkillRoot: () => ipcRenderer.invoke('skills:pickRoot'),
  copySkill: (id, text) => ipcRenderer.invoke('skills:copy', id, text),
  copy: (text, label, id) => ipcRenderer.invoke('copy:text', text, label, id),
  clearStats: () => ipcRenderer.invoke('stats:clear'),
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  envCheck: () => ipcRenderer.invoke('env:check'),
  envInstallCli: () => ipcRenderer.invoke('env:installCli'),
  envLogin: () => ipcRenderer.invoke('env:login'),
  copyAgentPrompt: (check) => ipcRenderer.invoke('env:agentPrompt', check),
  clearMediaCache: () => ipcRenderer.invoke('cache:clearMedia'),
  togglePin: (id) => ipcRenderer.invoke('pin:toggle', id),
  saveLocal: (item) => ipcRenderer.invoke('local:save', item),
  getPromptTargets: () => ipcRenderer.invoke('prompt:targets'),
  createCloudPrompt: (item) => ipcRenderer.invoke('prompt:create', item),
  deletePrompts: (request) => ipcRenderer.invoke('prompt:delete', request),
  requestPromptDeletion: (id) => ipcRenderer.invoke('prompt:requestDelete', id),
  migrateLegacyPrompts: (request) => ipcRenderer.invoke('prompt:migrate', request),
  setComposing: (active) => ipcRenderer.invoke('panel:composing', active),
  deleteLocal: (id) => ipcRenderer.invoke('local:delete', id),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  quit: () => ipcRenderer.invoke('app:quit'),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  mediaEnsure: (req) => ipcRenderer.invoke('media:ensure', req),
  // 飞书元数据（设置页用）
  listTables: () => ipcRenderer.invoke('feishu:tables'),
  listFields: (tableId) => ipcRenderer.invoke('feishu:fields', tableId),
  guessMapping: (tableId) => ipcRenderer.invoke('feishu:guess', tableId),
  // 面板交互
  setInteractive: (on) => ipcRenderer.invoke('panel:interactive', on),
  setPanelState: (st) => ipcRenderer.invoke('panel:state', st),
  requestExpand: (sticky) => ipcRenderer.invoke('panel:requestExpand', sticky),
  requestCollapse: () => ipcRenderer.invoke('panel:requestCollapse'),
  collapseComplete: (sequence) => ipcRenderer.invoke('panel:collapseComplete', sequence),
  autoCollapse: () => ipcRenderer.invoke('panel:autoCollapse'),
  showPreview: (req) => ipcRenderer.invoke('preview:show', req),
  hidePreview: () => ipcRenderer.invoke('preview:hide'),
  setPreviewEditing: (state) => ipcRenderer.invoke('preview:editing', state),
  getPanelState: () => ipcRenderer.invoke('panel:getstate'),
  setHandlePos: (p) => ipcRenderer.invoke('panel:setHandlePos', p),
  setDragging: (on) => ipcRenderer.invoke('panel:dragging', on),
  dragMove: (x, y) => ipcRenderer.invoke('panel:dragMove', x, y),
  dragEnd: (moved) => ipcRenderer.invoke('panel:dragEnd', moved),
  setCtrlHover: (on) => ipcRenderer.invoke('panel:ctrlHover', on),
  // 事件
  on: (channel, fn) => {
    // 前缀白名单：避免漏登记单个通道导致消息被丢（曾因此出现把手缺块）
    const ok = ['data:', 'sync:', 'panel:', 'preview:', 'stats:', 'appearance:', 'env:'].some((p) => channel.startsWith(p));
    if (ok) ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});

'use strict';
const { contextBridge, ipcRenderer } = require('electron');

async function call(name, ...args) {
  const res = await ipcRenderer.invoke(name, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

contextBridge.exposeInMainWorld('api', {
  scan: () => call('env:scan'),
  rubyDetail: (id) => call('ruby:detail', id),
  listRemote: (manager, all) => call('ruby:remote', manager, all),
  setGlobal: (manager, version) => call('ruby:setGlobal', manager, version),
  installRuby: (manager, version) => call('ruby:install', manager, version),
  uninstallRuby: (manager, version) => call('ruby:uninstall', manager, version),
  gemInstall: (rubyId, gem, version) => call('ruby:gemInstall', rubyId, gem, version),
  listProjects: () => call('projects:list'),
  addProjects: () => call('projects:add'),
  removeProject: (dir) => call('projects:remove', dir),
  analyzeProject: (dir) => call('project:analyze', dir),
  setProjectRuby: (dir, version) => call('project:setRuby', dir, version),
  bundle: (dir, action, opts) => call('project:bundle', dir, action, opts),
  cancelJob: (id) => call('job:cancel', id),
  openPath: (p) => call('shell:openPath', p),
  openExternal: (url) => call('shell:openExternal', url),
  onJob: (handler) => {
    ipcRenderer.on('job:start', (_e, p) => handler('start', p));
    ipcRenderer.on('job:data', (_e, p) => handler('data', p));
    ipcRenderer.on('job:end', (_e, p) => handler('end', p));
  },
});

'use strict';
// Rust バックエンド (Tauri) を呼び出す API。旧 Electron 版の preload.js と同じ形で window.api を公開する。
(() => {
  const T = window.__TAURI__;

  async function call(cmd, args) {
    try {
      return await T.core.invoke(cmd, args);
    } catch (e) {
      throw new Error(typeof e === 'string' ? e : (e && e.message) || String(e));
    }
  }

  window.api = {
    platform: (window.__RUBY_MANAGER__ || {}).platform || 'linux',
    setTheme: (theme) => call('theme_set', { theme }),
    scan: () => call('env_scan'),
    rubyDetail: (id) => call('ruby_detail', { rubyId: id }),
    listRemote: (manager, all) => call('ruby_remote', { manager, all: !!all }),
    setGlobal: (manager, version) => call('ruby_set_global', { manager, version }),
    installRuby: (manager, version) => call('ruby_install', { manager, version }),
    uninstallRuby: (manager, version) => call('ruby_uninstall', { manager, version }),
    gemInstall: (rubyId, gem, version) => call('ruby_gem_install', { rubyId, gem, version: version || null }),
    listProjects: () => call('projects_list'),
    addProjects: () => call('projects_add'),
    removeProject: (dir) => call('projects_remove', { dir }),
    analyzeProject: (dir) => call('project_analyze', { dir }),
    setProjectRuby: (dir, version) => call('project_set_ruby', { dir, version }),
    bundle: (dir, action, opts) => call('project_bundle', { dir, action, opts: opts || {} }),
    cancelJob: (id) => call('job_cancel', { id }),
    openPath: (path) => call('shell_open_path', { path }),
    openExternal: (url) => call('shell_open_external', { url }),
    confirm: (message) => call('dialog_confirm', { message }),
    onJob: (handler) => {
      for (const type of ['start', 'data', 'end']) T.event.listen(`job:${type}`, (e) => handler(type, e.payload));
    },
  };
})();

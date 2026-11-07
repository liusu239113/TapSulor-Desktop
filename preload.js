/**
 * preload.js - Electron 渲染进程与主进程的桥接
 *
 * 通过 contextBridge 暴露 window.electronAPI 给渲染进程。
 * 本文件定义的接口必须与 Android 版 assets/android-bridge.js 中
 * window.electronAPI 的签名完全一致，这样 web 端代码（main.js/detail.js）
 * 在 Android 和 Desktop 上可以不加修改直接运行。
 *
 * 关键约定：
 * - 大多数方法返回 Promise（web 端用 await 调用），用 ipcRenderer.invoke
 * - getAppVersion() 必须同步返回（web 端未 await），用 ipcRenderer.sendSync
 * - openLogin/clearCapturedApis/openExplorer/checkUpdate/addAccount 是 fire-and-forget
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ========== 核心 ==========
  isElectron: true,

  /** 带 cookie 的 fetch：返回 Promise<{ok, status, body, error}> */
  fetch: (url) => ipcRenderer.invoke('bridge:fetch', url),

  /** REP 平台收益（rep.taptap.cn）：传入 appId，返回 Promise<{ok, status, body, error}>
   *  body 为 JSON 字符串，金额单位为「分」（除以 100 得元）。SSO 自动登录，无需用户操作。
   *  opts.force = true 时丢弃令牌缓存并重新获取（用于刷新按钮）。 */
  repRevenue: (appId, opts) => ipcRenderer.invoke('bridge:repRevenue', appId, opts || {}),

  // ========== 热度榜（公开数据，免登录） ==========
  /** 拉榜单某页：typeName = hot | new | game_jam，from 起始名次，limit ≤ 20 */
  rankBoard: (typeName, from, limit) => ipcRenderer.invoke('bridge:rankBoard', typeName, from, limit),
  /** 保存当前整点快照（同一小时覆盖） */
  rankSaveSnapshot: (board, items) => ipcRenderer.invoke('bridge:rankSaveSnapshot', board, items),
  /** 读取快照：full=true 返回完整快照；给 appId 返回该游戏历史序列 */
  rankHistory: (board, appId, full) => ipcRenderer.invoke('bridge:rankHistory', board, appId || null, !!full),
  /** 单游戏详情（热度、所在榜名次、评分等） */
  rankAppDetail: (appId) => ipcRenderer.invoke('bridge:rankAppDetail', appId),

  /** 检查登录状态：返回 Promise<{status, developerId, profile, studios, ...}> */
  checkLogin: () => ipcRenderer.invoke('bridge:checkLogin'),

  /** 获取当前激活的开发者 ID（同步版本由 getActiveDeveloperId 提供异步版本） */
  getDeveloperId: () => ipcRenderer.invoke('bridge:getDeveloperId'),

  /** 获取工作室列表 */
  getStudios: () => ipcRenderer.invoke('bridge:getStudios'),

  /** 获取当前激活的开发者 ID */
  getActiveDeveloperId: () => ipcRenderer.invoke('bridge:getActiveDeveloperId'),

  /** 切换工作室 */
  switchStudio: (developerId) => ipcRenderer.invoke('bridge:switchStudio', developerId),

  /** 获取 APP 版本号（同步，web 端未 await） */
  getAppVersion: () => ipcRenderer.sendSync('bridge:getAppVersion'),

  /** 手动检查更新（fire-and-forget，主进程弹对话框） */
  checkUpdate: () => ipcRenderer.invoke('bridge:checkUpdate'),

  // ========== 登录 ==========
  /** 打开登录窗口。mode='add' 时为添加账号；否则登录当前账号 */
  openLogin: (mode) => {
    ipcRenderer.invoke('bridge:openLogin', mode || null).then((result) => {
      if (result && result.success) {
        // 触发 onLoginSuccess 回调
        if (typeof window.__onLoginSuccess === 'function') window.__onLoginSuccess();
      }
    });
  },

  // ========== 账号管理（多账号） ==========
  getAccounts: () => ipcRenderer.invoke('bridge:getAccounts'),
  switchAccount: (id) => ipcRenderer.invoke('bridge:switchAccount', id),
  addAccount: (data) => ipcRenderer.invoke('bridge:addAccount', {
    name: (data && data.name) || '',
    developerId: (data && data.developerId) || '',
  }),
  removeAccount: (id) => ipcRenderer.invoke('bridge:removeAccount', id),

  // ========== 文件/工具 ==========
  /** 打开数据目录 */
  openExplorer: () => ipcRenderer.invoke('bridge:openExplorer'),

  // ========== API 探测 ==========
  getCapturedApis: () => ipcRenderer.invoke('bridge:getCapturedApis'),
  clearCapturedApis: () => ipcRenderer.invoke('bridge:clearCapturedApis'),
  replayApi: (url) => ipcRenderer.invoke('bridge:replayApi', url),
  replayKeyApis: () => ipcRenderer.invoke('bridge:replayKeyApis'),

  // ========== 回调注册 ==========
  // android-bridge.js 约定：回调存到 window.__onXxx 上
  onLoginSuccess: (cb) => { window.__onLoginSuccess = cb; },
  onLoginCheck: (cb) => { window.__onLoginCheck = cb; },
  onAccountUpdated: (cb) => { window.__onAccountUpdated = cb; },
  onStudioSwitched: (cb) => { window.__onStudioSwitched = cb; },
  onApisUpdated: (cb) => { window.__onApisUpdated = cb; },
  onTrayRefresh: (cb) => { window.__onTrayRefresh = cb; },
  onAppResume: (cb) => { window.__onAppResume = cb; },
  onAppBackgroundTick: (cb) => { window.__onAppBackgroundTick = cb; },
});

// ========== 主进程 -> 渲染进程事件转发 ==========
ipcRenderer.on('login-success', () => {
  if (typeof window.__onLoginSuccess === 'function') window.__onLoginSuccess();
});
ipcRenderer.on('login-check', () => {
  if (typeof window.__onLoginCheck === 'function') window.__onLoginCheck();
});
ipcRenderer.on('account-updated', (event, result) => {
  if (typeof window.__onAccountUpdated === 'function') window.__onAccountUpdated(result);
});
ipcRenderer.on('studio-switched', (event, developerId) => {
  if (typeof window.__onStudioSwitched === 'function') window.__onStudioSwitched(developerId);
});
ipcRenderer.on('apis-updated', () => {
  if (typeof window.__onApisUpdated === 'function') window.__onApisUpdated();
});
ipcRenderer.on('tray-refresh', () => {
  if (typeof window.__onTrayRefresh === 'function') window.__onTrayRefresh();
});

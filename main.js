const { app, BrowserWindow, ipcMain, session, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');

// ====== 常量 ======
const APP_VERSION = '1.0.1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TAPTAP_REFERER = 'https://developer.taptap.cn/';
const API_BASE = 'https://developer.taptap.cn/api';
const DATA_DIR = path.join(app.getPath('userData'), 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const PREFS_FILE = path.join(DATA_DIR, 'preferences.json');

// ====== 数据存储 ======
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return def; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

// ====== 账号管理 ======
let accounts = readJSON(ACCOUNTS_FILE, { list: [], activeId: null });

function saveAccounts() { writeJSON(ACCOUNTS_FILE, accounts); }

// ====== 偏好设置 ======
let preferences = readJSON(PREFS_FILE, { theme_mode: 'light', theme_accent: 'cyan', font_family: 'default' });

// ====== 主窗口 ======
let mainWindow = null;
let loginWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'TapSulor',
    icon: path.join(__dirname, 'assets', 'app-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
    backgroundColor: '#1a1a2e',
  });

  // 设置 UA（移除 Electron 标识，使用桌面 Chrome UA）
  mainWindow.webContents.setUserAgent(DESKTOP_UA);

  // 拦截请求，添加 Referer 防盗链 + UA
  const filter = { urls: ['*://*.taptap.cn/*', '*://*.taptap.com/*'] };
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    details.requestHeaders['Referer'] = TAPTAP_REFERER;
    details.requestHeaders['User-Agent'] = DESKTOP_UA;
    callback({ requestHeaders: details.requestHeaders });
  });

  // 处理外部链接 - 在系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, 'assets', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ====== IPC 处理 ======

// fetch 桥接 - 用 Electron net 模块发请求（自动带 session cookies）
// preload 直接调用，返回 { ok, status, body, error }
ipcMain.handle('bridge:fetch', async (event, url) => {
  try {
    const response = await net.fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': DESKTOP_UA,
        'Referer': TAPTAP_REFERER,
        'Accept': 'application/json, text/plain, */*',
      },
    });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body, error: null };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: err.message };
  }
});

// 检查登录状态 - 返回 status 字段: 'ready' | 'unauthenticated' | 'no-developer' | 'identity-unresolved' | 'error'
ipcMain.handle('bridge:checkLogin', async () => {
  try {
    // 检查 session 中是否有 TapTap cookie
    const cookies = await session.defaultSession.cookies.get({ domain: '.taptap.cn' });
    const hasSession = cookies.some(c =>
      (c.name === 'sessionid' || c.name === 'taptap_session' || c.name === 'sid') && c.value
    );

    if (!hasSession && !accounts.activeId) {
      return { status: 'unauthenticated', developerId: null, error: null, profile: null, studios: [] };
    }

    // 尝试访问开发者信息接口验证登录有效性
    let developerId = accounts.activeId;
    let profile = null;
    let studios = [];

    try {
      const response = await net.fetch(`${API_BASE}/developer/v1/developer/info`, {
        headers: { 'User-Agent': DESKTOP_UA, 'Referer': TAPTAP_REFERER },
      });
      if (response.ok) {
        const data = await response.json();
        if (data.data) {
          const name = data.data.name || data.data.nickname || '';
          const avatar = data.data.avatar || '';
          developerId = String(data.data.id || developerId || '');
          profile = { nickname: name, avatar: avatar, developerName: name, developerAvatar: avatar };

          // 更新账号信息
          if (developerId) {
            const idx = accounts.list.findIndex(a => a.developerId === developerId);
            if (idx >= 0) {
              accounts.list[idx].name = name || accounts.list[idx].name;
              accounts.list[idx].avatar = avatar || accounts.list[idx].avatar;
            } else {
              accounts.list.push({
                id: developerId,
                developerId,
                name: name || ('开发者 ' + developerId.slice(-4)),
                avatar,
                studios: [],
              });
            }
            accounts.activeId = developerId;
            saveAccounts();
          }
        }
      } else if (response.status === 401 || response.status === 403) {
        // session 过期
        return { status: 'unauthenticated', developerId: null, error: 'Session expired', profile: null, studios: [] };
      }
    } catch (e) {
      // 网络错误但已有本地账号 -> identity-unresolved 让用户手动处理
      if (developerId) {
        return { status: 'identity-unresolved', developerId, error: e.message, profile, studios };
      }
      return { status: 'error', developerId: null, error: e.message, profile: null, studios: [] };
    }

    if (!developerId) {
      // 有 cookie 但无法获取开发者 ID
      return { status: 'identity-unresolved', developerId: null, error: 'Cannot resolve developer ID', profile: null, studios: [] };
    }

    return { status: 'ready', developerId, error: null, profile, studios };
  } catch (err) {
    return { status: 'error', developerId: null, error: err.message, profile: null, studios: [] };
  }
});

// 同步获取版本号（web 端同步调用）
ipcMain.on('bridge:getAppVersion', (event) => {
  event.returnValue = APP_VERSION;
});

ipcMain.handle('bridge:getDeveloperId', () => accounts.activeId);

ipcMain.handle('bridge:getStudios', () => {
  const acc = accounts.list.find(a => a.developerId === accounts.activeId);
  return acc ? (acc.studios || []) : [];
});

ipcMain.handle('bridge:getActiveDeveloperId', () => accounts.activeId);

ipcMain.handle('bridge:switchStudio', (event, developerId) => {
  accounts.activeId = developerId;
  saveAccounts();
  if (mainWindow) mainWindow.webContents.send('studio-switched', developerId);
  return true;
});

// 检查更新（访问 GitHub releases）
ipcMain.handle('bridge:checkUpdate', async () => {
  try {
    const response = await net.fetch('https://api.github.com/repos/liusu239113/TapTapGain-Android/releases/latest', {
      headers: { 'User-Agent': DESKTOP_UA, 'Accept': 'application/vnd.github.v3+json' },
    });
    if (response.ok) {
      const data = await response.json();
      const latest = data.tag_name || data.name || '';
      if (latest && latest !== `v${APP_VERSION}` && latest !== APP_VERSION) {
        return { hasUpdate: true, version: latest, url: data.html_url, notes: data.body || '' };
      }
      return { hasUpdate: false };
    }
    return { hasUpdate: false };
  } catch {
    return { hasUpdate: false };
  }
});

// 同步偏好设置
ipcMain.handle('bridge:syncPreferences', (event, mode, accent, font) => {
  preferences.theme_mode = mode || 'light';
  preferences.theme_accent = accent || 'cyan';
  preferences.font_family = font || 'default';
  writeJSON(PREFS_FILE, preferences);
});

// 打开登录窗口
// mode: 'add' = 添加新账号; 其他/undefined = 登录
ipcMain.handle('bridge:openLogin', (event, mode) => {
  return new Promise((resolve) => {
    if (loginWindow) {
      loginWindow.focus();
      return resolve({ success: false, reason: 'already_open' });
    }
    loginWindow = new BrowserWindow({
      width: 1000,
      height: 720,
      parent: mainWindow,
      title: 'TapTap 开发者登录',
      icon: path.join(__dirname, 'assets', 'app-icon.png'),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    loginWindow.webContents.setUserAgent(DESKTOP_UA);
    loginWindow.loadURL('https://developer.taptap.cn/login/');

    let resolved = false;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
      resolve(result);
    };

    // 监听页面导航，检测登录成功（跳转到 dashboard 或开发者中心）
    const checkLoginSuccess = async (url) => {
      // 登录后会跳转到 developer.taptap.cn/ 首页或 /dashboard/
      if (url.includes('developer.taptap.cn/dashboard') ||
          (url.includes('developer.taptap.cn/') && !url.includes('/login') && !url.includes('/signup'))) {
        try {
          const cookies = await session.defaultSession.cookies.get({ domain: '.taptap.cn' });
          if (cookies.length === 0) return;

          // 尝试从 API 获取开发者 ID
          const resp = await net.fetch(`${API_BASE}/developer/v1/developer/info`, {
            headers: { 'User-Agent': DESKTOP_UA, 'Referer': TAPTAP_REFERER },
          });
          let developerId = null;
          let name = '';
          let avatar = '';
          if (resp.ok) {
            const data = await resp.json();
            if (data.data && data.data.id) {
              developerId = String(data.data.id);
              name = data.data.name || data.data.nickname || '';
              avatar = data.data.avatar || '';
            }
          }

          if (developerId) {
            const exists = accounts.list.find(a => a.developerId === developerId);
            if (!exists) {
              accounts.list.push({
                id: developerId,
                developerId,
                name: name || ('开发者 ' + developerId.slice(-4)),
                avatar,
                studios: [],
              });
            } else if (name) {
              exists.name = name;
              exists.avatar = avatar || exists.avatar;
            }
            if (mode !== 'add') {
              accounts.activeId = developerId;
            }
            saveAccounts();
            if (mainWindow) {
              mainWindow.webContents.send('login-success');
              if (mode !== 'add') mainWindow.webContents.reload();
            }
            finish({ success: true, developerId });
          }
        } catch (e) {
          console.error('Login detection error:', e);
        }
      }
    };

    loginWindow.webContents.on('did-navigate', (ev, url) => checkLoginSuccess(url));
    loginWindow.webContents.on('did-navigate-in-page', (ev, url) => checkLoginSuccess(url));

    loginWindow.on('closed', () => {
      loginWindow = null;
      if (!resolved) finish({ success: false, reason: 'closed' });
    });
  });
});

ipcMain.handle('bridge:getAccounts', () => accounts);

ipcMain.handle('bridge:switchAccount', (event, id) => {
  const acc = accounts.list.find(a => a.developerId === id || a.id === id);
  if (acc) {
    accounts.activeId = acc.developerId;
    saveAccounts();
    if (mainWindow) mainWindow.webContents.send('account-updated', { activeId: accounts.activeId });
    return { ok: true };
  }
  return { ok: false, error: '账号不存在' };
});

// addAccount 从 web 传入对象 {name, developerId} (android-bridge.js 约定)
ipcMain.handle('bridge:addAccount', (event, data) => {
  const name = (data && data.name) || '';
  const developerId = (data && data.developerId) || '';
  if (developerId && !accounts.list.find(a => a.developerId === developerId)) {
    accounts.list.push({ id: developerId, developerId, name: name || developerId, avatar: '', studios: [] });
    saveAccounts();
  }
});

ipcMain.handle('bridge:removeAccount', (event, id) => {
  const before = accounts.list.length;
  accounts.list = accounts.list.filter(a => a.developerId !== id && a.id !== id);
  if (accounts.activeId === id) {
    accounts.activeId = accounts.list.length > 0 ? accounts.list[0].developerId : null;
  }
  saveAccounts();
  const ok = before !== accounts.list.length;
  return { ok, error: ok ? null : '账号不存在' };
});

// 打开资源管理器（数据目录）
ipcMain.handle('bridge:openExplorer', () => {
  shell.openPath(DATA_DIR);
});

// API 捕获/回放（桌面版简单实现 - 仅 replayApi 可用）
ipcMain.handle('bridge:getCapturedApis', () => []);
ipcMain.handle('bridge:clearCapturedApis', () => {});
// replayApi(url) - 重新请求 API 并返回结果（web 端只传 url，返回 {ok, status, body}）
ipcMain.handle('bridge:replayApi', async (event, url) => {
  try {
    const response = await net.fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': DESKTOP_UA,
        'Referer': TAPTAP_REFERER,
        'Accept': 'application/json, text/plain, */*',
      },
    });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body, error: null };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: err.message };
  }
});
ipcMain.handle('bridge:replayKeyApis', () => ({ count: 0, saved: false }));

// 获取偏好设置
ipcMain.handle('bridge:getPreferences', () => preferences);

// ====== App 生命周期 ======
app.whenReady().then(() => {
  // 设置全局 UA
  session.defaultSession.setUserAgent(DESKTOP_UA);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 后台定时刷新（每 5 分钟）
setInterval(() => {
  if (mainWindow) {
    mainWindow.webContents.executeJavaScript('if(window.__onAppBackgroundTick)window.__onAppBackgroundTick();');
  }
}, 5 * 60 * 1000);

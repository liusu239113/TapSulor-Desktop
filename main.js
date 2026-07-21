const { app, BrowserWindow, ipcMain, session, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');

// ====== 常量 ======
const APP_VERSION = '1.0.1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TAPTAP_REFERER = 'https://developer.taptap.cn/';
const TAPTAP_ORIGIN = 'https://developer.taptap.cn';
const DATA_DIR = path.join(app.getPath('userData'), 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const PREFS_FILE = path.join(DATA_DIR, 'preferences.json');

// 原生 App scheme（QQ/微信），交给系统浏览器处理
const NATIVE_SCHEMES = new Set(['weixin', 'mqqapi', 'mqqwpa', 'mqqopensdkapi', 'mqqopensdk', 'wechat']);

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

// ====== 开发者 ID 提取工具（对齐 Android LoginActivity.kt） ======

/**
 * 规范化开发者 ID：只保留纯数字，处理数字类型的 ".0" 后缀
 */
function normDeveloperId(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (/^\d+$/.test(s)) return s;
  if (s.endsWith('.0')) s = s.slice(0, -2);
  return /^\d+$/.test(s) ? s : null;
}

/**
 * 从 /api/user/v1/me 响应中提取开发者 ID
 * 字段优先级: data.developer_id > data.developerId > data.developer.id
 */
function extractMeId(json) {
  try {
    const data = json && json.data;
    if (!data) return null;
    return normDeveloperId(data.developer_id)
        || normDeveloperId(data.developerId)
        || normDeveloperId(data.developer && data.developer.id);
  } catch { return null; }
}

/**
 * 从 /api/developer/v1/list 响应中提取第一个开发者 ID
 * 遍历 data.list[]，字段优先级: developer_id > developerId > id
 */
function extractListId(json) {
  try {
    const list = json && json.data && json.data.list;
    if (!Array.isArray(list)) return null;
    for (const it of list) {
      const id = normDeveloperId(it.developer_id)
              || normDeveloperId(it.developerId)
              || normDeveloperId(it.id);
      if (id) return id;
    }
    return null;
  } catch { return null; }
}

/**
 * 从 URL 中提取开发者 ID（对齐 Android 的 extractDeveloperIdFromUrl）
 */
function extractDeveloperIdFromUrl(url) {
  if (!url) return null;
  let m = url.match(/\/(?:v3|developer|developer-center)\/(\d+)(?:\/|$)/);
  if (m) return m[1];
  m = url.match(/[?&](?:developer_id|developerId|developerID)=(\d+)/);
  return m ? m[1] : null;
}

/**
 * 使用当前 session 的 cookie 探测开发者 ID
 * 对齐 Android 的 probeDeveloperIdFromWebView()
 * 返回 { developerId, profile, studios } 或 null
 */
async function probeDeveloperId() {
  try {
    // 1) 先调 /api/user/v1/me
    let meResp;
    try {
      meResp = await net.fetch(`${TAPTAP_ORIGIN}/api/user/v1/me`, {
        headers: {
          'User-Agent': DESKTOP_UA,
          'Referer': TAPTAP_REFERER,
          'Accept': 'application/json, text/plain, */*',
        },
      });
    } catch {
      return null;
    }

    if (meResp.status === 401 || meResp.status === 403) {
      return null;
    }

    let meJson = null;
    if (meResp.ok) {
      try { meJson = await meResp.json(); } catch { meJson = null; }
    }

    let developerId = meJson ? extractMeId(meJson) : null;
    let nickname = '';
    let avatar = '';

    // 从 me 响应中提取用户基本信息
    if (meJson && meJson.data) {
      nickname = meJson.data.nickname || meJson.data.name || meJson.data.username || '';
      avatar = meJson.data.avatar || meJson.data.avatar_url || '';
    }

    // 2) 再调 /api/developer/v1/list 获取工作室列表
    let studios = [];
    try {
      const listResp = await net.fetch(`${TAPTAP_ORIGIN}/api/developer/v1/list`, {
        headers: {
          'User-Agent': DESKTOP_UA,
          'Referer': TAPTAP_REFERER,
          'Accept': 'application/json, text/plain, */*',
        },
      });
      if (listResp.ok) {
        const listJson = await listResp.json();
        if (listJson && listJson.data && Array.isArray(listJson.data.list)) {
          studios = listJson.data.list.map(it => ({
            developerId: normDeveloperId(it.developer_id) || normDeveloperId(it.developerId) || normDeveloperId(it.id) || '',
            name: it.name || it.nickname || ('开发者 ' + (normDeveloperId(it.id) || '').slice(-4)),
            avatar: it.avatar || '',
            type: it.type || 0,
            verified: it.verified === true || it.verified === 1,
          })).filter(s => s.developerId);

          // 如果 me 没拿到 ID，从 list 取第一个
          if (!developerId && studios.length > 0) {
            developerId = studios[0].developerId;
          }
        }
      }
    } catch {
      // list 失败不致命，可能只是没有多工作室
    }

    if (!developerId) return null;

    // 构建 profile
    const profile = {
      nickname,
      avatar,
      developerName: nickname,
      developerAvatar: avatar,
    };

    return { developerId, profile, studios };
  } catch (err) {
    console.error('probeDeveloperId error:', err);
    return null;
  }
}

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

  // 启用第三方 cookie（QQ/微信 OAuth 需要）
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    // 默认允许 cookie 等权限
    callback(true);
  });

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

// 检查登录状态 - 对齐 Android account-state.js 逻辑
// 返回 status 字段: 'ready' | 'unauthenticated' | 'identity-unresolved' | 'error'
ipcMain.handle('bridge:checkLogin', async () => {
  try {
    // 检查 session 中是否有 TapTap cookie
    const cookies = await session.defaultSession.cookies.get({ domain: '.taptap.cn' });
    const hasSession = cookies.some(c =>
      (c.name === 'sessionid' || c.name === 'taptap_session' || c.name === 'sid'
       || c.name === 'taptap_access_token' || c.name.startsWith('tt_')) && c.value
    );

    // 无 cookie 且无本地账号 → 未登录
    if (!hasSession && !accounts.activeId) {
      return { status: 'unauthenticated', developerId: null, error: null, profile: null, studios: [] };
    }

    // 使用正确的 API 端点探测开发者 ID
    const result = await probeDeveloperId();

    if (result) {
      const { developerId, profile, studios } = result;

      // 更新账号信息
      const idx = accounts.list.findIndex(a => a.developerId === developerId);
      if (idx >= 0) {
        if (profile.nickname) accounts.list[idx].name = profile.nickname;
        if (profile.avatar) accounts.list[idx].avatar = profile.avatar;
        accounts.list[idx].studios = studios;
      } else {
        accounts.list.push({
          id: developerId,
          developerId,
          name: profile.nickname || ('开发者 ' + developerId.slice(-4)),
          avatar: profile.avatar,
          studios,
        });
      }
      accounts.activeId = developerId;
      saveAccounts();

      return { status: 'ready', developerId, error: null, profile, studios };
    }

    // API 探测失败但有本地账号 → identity-unresolved
    if (accounts.activeId) {
      const acc = accounts.list.find(a => a.developerId === accounts.activeId);
      return {
        status: 'identity-unresolved',
        developerId: accounts.activeId,
        error: 'Cannot resolve developer ID from API',
        profile: acc ? { nickname: acc.name, avatar: acc.avatar, developerName: acc.name, developerAvatar: acc.avatar } : null,
        studios: acc ? (acc.studios || []) : [],
      };
    }

    // 有 cookie 但无法获取开发者 ID
    return { status: 'unauthenticated', developerId: null, error: null, profile: null, studios: [] };
  } catch (err) {
    return { status: 'error', developerId: null, error: err.message, profile: null, studios: [] };
  }
});

// 同步获取版本号
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
    const response = await net.fetch('https://api.github.com/repos/liusu239113/TapSulor-Desktop/releases/latest', {
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

// 打开登录窗口（对齐 Android LoginActivity.kt）
// mode: 'add' = 添加新账号（先清 cookie）; 其他/undefined = 登录
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
        webSecurity: true,
      },
      backgroundColor: '#ffffff',
    });

    const winContents = loginWindow.webContents;
    winContents.setUserAgent(DESKTOP_UA);

    // 拦截原生 scheme（weixin://, mqqapi:// 等）→ 系统浏览器
    winContents.setWindowOpenHandler(({ url }) => {
      try {
        const u = new URL(url);
        if (NATIVE_SCHEMES.has(u.protocol.replace(':', '').toLowerCase())) {
          shell.openExternal(url);
          return { action: 'deny' };
        }
      } catch {}
      if (url.startsWith('http://') || url.startsWith('https://')) {
        // 外部链接在系统浏览器打开（避免跳出 TapTap 域名）
        if (!url.includes('taptap.cn') && !url.includes('taptap.com')) {
          shell.openExternal(url);
          return { action: 'deny' };
        }
      }
      return { action: 'allow' };
    });

    let resolved = false;
    let nativeCheckAttempts = 0;
    const MAX_NATIVE_ATTEMPTS = 12;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
      resolve(result);
    };

    // 将探测到的开发者 ID 保存并结束登录流程
    const saveAndFinish = async (developerId) => {
      if (!developerId || !/^\d+$/.test(developerId)) return;

      // 从 session 获取完整信息
      const result = await probeDeveloperId();
      const nickname = result && result.profile ? result.profile.nickname : '';
      const avatar = result && result.profile ? result.profile.avatar : '';
      const studios = result && result.studios ? result.studios : [];

      const exists = accounts.list.find(a => a.developerId === developerId);
      if (!exists) {
        accounts.list.push({
          id: developerId,
          developerId,
          name: nickname || ('开发者 ' + developerId.slice(-4)),
          avatar,
          studios,
        });
      } else {
        if (nickname) exists.name = nickname;
        if (avatar) exists.avatar = avatar;
        exists.studios = studios;
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
    };

    // 通过 JS 注入检测登录状态（对齐 Android checkLogin()）
    const jsCheck = () => {
      if (resolved || loginWindow.isDestroyed()) return;
      winContents.executeJavaScript(`
        (async function(){
          try {
            function norm(v){ if(v==null) return null; const s=String(v).trim(); return /^\\d+$/.test(s) ? s : (s.endsWith('.0') ? s.slice(0,-2) : null); }
            function fromMe(p){ const d=p&&p.data; return d && (norm(d.developer_id) || norm(d.developerId) || (d.developer && norm(d.developer.id))); }
            function fromList(p){ const list = p && p.data && p.data.list; if(!Array.isArray(list)) return null; for(const it of list){ const id = norm(it.developer_id) || norm(it.developerId) || norm(it.id); if(id) return id; } return null; }
            let me = await fetch('/api/user/v1/me', {credentials:'include'});
            if (me.status === 401 || me.status === 403) return null;
            let meJson = await me.json();
            const idFromMe = fromMe(meJson);
            if (idFromMe) return String(idFromMe);
            let list = await fetch('/api/developer/v1/list', {credentials:'include'});
            if (!list.ok) return null;
            let listJson = await list.json();
            const idFromList = fromList(listJson);
            if (idFromList) return String(idFromList);
            return null;
          } catch (e) { return null; }
        })()
      `).then((result) => {
        if (result && !resolved) {
          saveAndFinish(String(result));
        }
      }).catch(() => {});
    };

    // Native cookie 探测（对齐 Android checkLoginNatively()）
    const nativeCheck = async () => {
      if (resolved || nativeCheckAttempts >= MAX_NATIVE_ATTEMPTS) return;
      nativeCheckAttempts++;
      const result = await probeDeveloperId();
      if (result && !resolved) {
        saveAndFinish(result.developerId);
      } else if (!resolved) {
        setTimeout(nativeCheck, 1800);
      }
    };

    // 页面事件处理（对齐 Android WebViewClient）
    const onPageEvent = (url) => {
      if (resolved) return;

      // 1. 从 URL 中直接提取开发者 ID
      const idFromUrl = extractDeveloperIdFromUrl(url);
      if (idFromUrl) {
        saveAndFinish(idFromUrl);
        return;
      }

      // 2. 定时 JS 注入检测
      setTimeout(jsCheck, 900);

      // 3. Native cookie 探测
      setTimeout(nativeCheck, 1400);
    };

    winContents.on('did-navigate', (ev, url) => onPageEvent(url));
    winContents.on('did-navigate-in-page', (ev, url) => onPageEvent(url));

    // 拦截导航中的原生 scheme（will-navigate 只在主框架触发）
    winContents.on('will-navigate', (ev, url) => {
      try {
        const u = new URL(url);
        if (NATIVE_SCHEMES.has(u.protocol.replace(':', '').toLowerCase())) {
          ev.preventDefault();
          shell.openExternal(url);
        }
      } catch {}
    });

    loginWindow.on('closed', () => {
      loginWindow = null;
      if (!resolved) finish({ success: false, reason: 'closed' });
    });

    // 'add' 模式：先清除 session cookie，再加载首页（让用户重新登录）
    const startLogin = () => {
      // 加载 TapTap 开发者首页（不是 /login/！对齐 Android）
      loginWindow.loadURL('https://developer.taptap.cn/');
    };

    if (mode === 'add') {
      // 清除所有 TapTap 相关 cookie
      session.defaultSession.clearStorageData({
        storages: ['cookies'],
        origins: ['https://developer.taptap.cn', 'https://passport.taptap.cn', 'https://www.taptap.cn', 'https://www.taptap.com'],
      }).then(startLogin).catch(startLogin);
    } else {
      startLogin();
    }
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

// API 捕获/回放（桌面版简单实现）
ipcMain.handle('bridge:getCapturedApis', () => []);
ipcMain.handle('bridge:clearCapturedApis', () => {});
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
  session.defaultSession.setUserAgent(DESKTOP_UA);
  // 全局允许第三方 cookie
  session.defaultSession.cookies.set({
    url: 'https://developer.taptap.cn',
    name: '_third_party_cookie_check',
    value: '1',
    sameSite: 'no_restriction',
    secure: true,
  }).catch(() => {});
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

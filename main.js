const { app, BrowserWindow, ipcMain, session, shell, net, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// ====== 常量（VERSION_CODE 必须和 Android BuildConfig.VERSION_CODE 对齐）======
const APP_VERSION = '1.0.1';
const VERSION_CODE = 1;                 // 整数，服务器 version_code > 此值视为有更新
const UPDATE_URL = 'https://ark.yanyususu.online/tapsulor/version.json';
const UPDATE_UA = `TapSulor/${APP_VERSION} (Windows)`;
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
// 规范格式（对齐 Android assets/account-state.js）：
// {
//   current: 'acc-{timestamp}',
//   accounts: [{
//     id, name, developerId, developerName, developerAvatar,
//     nickname, avatar, partition, studios: [{ id, name, logo }]
//   }]
// }
let accounts = loadAccounts();
/** 当前激活的工作室 developerId（可通过工作室切换改变，默认等于当前账号的 developerId） */
let activeDeveloperId = resolveActiveDeveloperId();

function loadAccounts() {
  const raw = readJSON(ACCOUNTS_FILE, null);
  // 旧格式迁移：{ list:[{id, developerId, name, avatar, studios}], activeId }
  if (raw && Array.isArray(raw.list)) {
    const migrated = { current: null, accounts: [] };
    for (const it of raw.list) {
      const devId = it.developerId || it.id;
      if (!devId) continue;
      migrated.accounts.push({
        id: 'acc-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
        name: it.name || '',
        developerId: String(devId),
        developerName: it.name || '',
        developerAvatar: it.avatar || '',
        nickname: it.name || '',
        avatar: it.avatar || '',
        partition: 'persist:taptap-' + devId,
        studios: Array.isArray(it.studios) ? it.studios.map(normalizeStudio).filter(Boolean) : [],
      });
    }
    if (raw.activeId) {
      const cur = migrated.accounts.find(a => a.developerId === String(raw.activeId));
      migrated.current = cur ? cur.id : (migrated.accounts[0] ? migrated.accounts[0].id : null);
    } else if (migrated.accounts.length > 0) {
      migrated.current = migrated.accounts[0].id;
    }
    writeJSON(ACCOUNTS_FILE, migrated);
    return migrated;
  }
  // 新格式默认
  if (raw && Array.isArray(raw.accounts)) {
    // 防御：补全缺失字段
    for (const a of raw.accounts) {
      if (!a.id) a.id = 'acc-' + Date.now();
      if (!a.partition) a.partition = 'persist:taptap-' + (a.developerId || '');
      if (!Array.isArray(a.studios)) a.studios = [];
      a.studios = a.studios.map(normalizeStudio).filter(Boolean);
    }
    return raw;
  }
  return { current: null, accounts: [] };
}

function resolveActiveDeveloperId() {
  if (!accounts.current) return null;
  const acc = accounts.accounts.find(a => a.id === accounts.current);
  // 对齐安卓端：优先用 activeDeveloperId（切换工作室后的值），否则用账号原始 developerId
  return acc ? (acc.activeDeveloperId || acc.developerId) : null;
}

function saveAccounts() { writeJSON(ACCOUNTS_FILE, accounts); }

function currentAccount() {
  if (!accounts.current) return null;
  return accounts.accounts.find(a => a.id === accounts.current) || null;
}

/**
 * 规范化工作室对象 → { id, name, logo }
 * 兼容旧格式 { developerId, name, avatar } 和原始 API 字段
 */
function normalizeStudio(s) {
  if (!s || typeof s !== 'object') return null;
  const id = String(s.id || s.developerId || s.developer_id || '').trim();
  if (!id) return null;
  const name = toSafeString(s.name || s.nickname) || ('开发者 ' + id.slice(-4));
  // logo 字段优先级（对齐安卓端）：logo > developer_logo > developerLogo > avatar > icon > avatar_url > logo_url
  const logo = firstNonBlank(s, 'logo', 'developer_logo', 'developerLogo', 'avatar', 'icon', 'avatar_url', 'logo_url');
  return { id, name, logo: normalizeUrl(logo) };
}

function toSafeString(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // 对象/数组/其他类型 → 尝试取常用字段，失败返回空串
  if (typeof v === 'object') {
    if (typeof v.url === 'string') return v.url.trim();
    if (typeof v.src === 'string') return v.src.trim();
    if (typeof v.uri === 'string') return v.uri.trim();
    return '';
  }
  return '';
}

// 对齐安卓端 firstNonBlankString：从对象按顺序取第一个非空字符串字段
function firstNonBlank(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const v = toSafeString(obj[k]);
    if (v) return v;
  }
  return '';
}

function normalizeUrl(u) {
  const s = toSafeString(u);
  if (!s) return '';
  if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('data:')) return s;
  // 以 // 开头补 https
  if (s.startsWith('//')) return 'https:' + s;
  // 相对路径直接返回
  return s;
}

function genAccId() {
  return 'acc-' + Date.now() + '-' + Math.floor(Math.random() * 10000);
}

// ====== 偏好设置 ======
let preferences = readJSON(PREFS_FILE, { theme_mode: 'light', theme_accent: 'cyan', font_family: 'default' });

// ====== 开发者 ID 提取工具（对齐 Android LoginActivity.kt） ======

function normDeveloperId(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (/^\d+$/.test(s)) return s;
  if (s.endsWith('.0')) s = s.slice(0, -2);
  return /^\d+$/.test(s) ? s : null;
}

function extractMeId(json) {
  try {
    const data = json && json.data;
    if (!data) return null;
    return normDeveloperId(data.developer_id)
        || normDeveloperId(data.developerId)
        || normDeveloperId(data.developer && data.developer.id);
  } catch { return null; }
}

function extractDeveloperIdFromUrl(url) {
  if (!url) return null;
  let m = url.match(/\/(?:v3|developer|developer-center)\/(\d+)(?:\/|$)/);
  if (m) return m[1];
  m = url.match(/[?&](?:developer_id|developerId|developerID)=(\d+)/);
  return m ? m[1] : null;
}

/**
 * 探测当前登录态的开发者信息
 * 返回 { developerId, nickname, avatar, developerName, developerAvatar, studios } 或 null
 */
async function probeDeveloperId() {
  try {
    // 1) /api/user/v1/me
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
    if (meJson && meJson.data) {
      const d = meJson.data;
      const u = d.user && typeof d.user === 'object' ? d.user : null;
      const p = d.profile && typeof d.profile === 'object' ? d.profile : null;
      nickname = firstNonBlank(d, 'nickname', 'name', 'username')
        || firstNonBlank(u, 'nickname', 'name', 'username')
        || firstNonBlank(p, 'nickname', 'name', 'username');
      // 用户头像字段（对齐安卓端）：avatar > avatar_url > avatarUrl > photo > icon > headimg > head_img
      avatar = normalizeUrl(
        firstNonBlank(d, 'avatar', 'avatar_url', 'avatarUrl', 'photo', 'icon', 'headimg', 'head_img')
        || firstNonBlank(u, 'avatar', 'avatar_url', 'avatarUrl', 'photo', 'icon')
        || firstNonBlank(p, 'avatar', 'avatar_url', 'avatarUrl', 'photo', 'icon')
      );
    }

    // 2) /api/developer/v1/list
    let studios = [];
    let developerName = nickname;
    let developerAvatar = avatar;
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
          // 直接把原始对象交给 normalizeStudio，它会按安卓端字段优先级提取 id/name/logo
          studios = listJson.data.list.map(it => normalizeStudio(it)).filter(Boolean);

          // 如果 me 没拿到 ID，从 list 取第一个
          if (!developerId && studios.length > 0) {
            developerId = studios[0].id;
          }
          // 找到当前 developerId 对应的工作室，用它的 name/logo 作为 developerName/developerAvatar
          if (developerId) {
            const active = studios.find(s => s.id === developerId);
            if (active) {
              developerName = active.name || developerName;
              developerAvatar = active.logo || developerAvatar;
            } else if (studios.length > 0) {
              developerName = studios[0].name || developerName;
              developerAvatar = studios[0].logo || developerAvatar;
            }
          }
        }
      }
    } catch {
      // list 失败不致命
    }

    if (!developerId) return null;

    return { developerId, nickname, avatar, developerName, developerAvatar, studios };
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

  mainWindow.webContents.setUserAgent(DESKTOP_UA);

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true);
  });

  const filter = { urls: ['*://*.taptap.cn/*', '*://*.taptap.com/*'] };
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    details.requestHeaders['Referer'] = TAPTAP_REFERER;
    details.requestHeaders['User-Agent'] = DESKTOP_UA;
    callback({ requestHeaders: details.requestHeaders });
  });

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

// ====== 账号更新辅助 ======
// 将 probe 结果写入账号存储，返回 { isNew, switched, acc }
function upsertAccountFromProbe(result, opts) {
  const { developerId, nickname, avatar, developerName, developerAvatar, studios } = result;
  const modeAdd = opts && opts.mode === 'add';
  const setActive = !modeAdd;

  let acc = accounts.accounts.find(a => a.developerId === developerId);
  const isNew = !acc;
  if (isNew) {
    acc = {
      id: genAccId(),
      name: nickname || developerName || ('开发者 ' + developerId.slice(-4)),
      developerId,
      developerName: developerName || '',
      developerAvatar: developerAvatar || '',
      nickname: nickname || '',
      avatar: avatar || '',
      partition: 'persist:taptap-' + developerId,
      studios: studios || [],
    };
    accounts.accounts.push(acc);
  } else {
    // 更新已有账号的资料（可能改名/换头像/工作室变动）
    if (nickname) acc.nickname = nickname;
    if (avatar) acc.avatar = avatar;
    if (developerName) acc.developerName = developerName;
    if (developerAvatar) acc.developerAvatar = developerAvatar;
    if (Array.isArray(studios)) acc.studios = studios;
    if (!acc.partition) acc.partition = 'persist:taptap-' + developerId;
  }

  // 非 add 模式：设为当前账号
  if (setActive) {
    accounts.current = acc.id;
    activeDeveloperId = developerId;
    // 重新登录时重置工作室选择，避免残留之前的切换状态
    acc.activeDeveloperId = null;
  } else if (!accounts.current) {
    accounts.current = acc.id;
    activeDeveloperId = developerId;
    acc.activeDeveloperId = null;
  }

  saveAccounts();
  return { isNew, acc };
}

// ====== IPC 处理 ======

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

// 检查登录状态
ipcMain.handle('bridge:checkLogin', async () => {
  try {
    const cookies = await session.defaultSession.cookies.get({ domain: '.taptap.cn' });
    const hasSession = cookies.some(c =>
      (c.name === 'sessionid' || c.name === 'taptap_session' || c.name === 'sid'
       || c.name === 'taptap_access_token' || c.name.startsWith('tt_')) && c.value
    );

    // 无 cookie 且无本地账号 → 未登录
    if (!hasSession && !accounts.current) {
      return { status: 'unauthenticated', developerId: null, error: null, profile: null, studios: [] };
    }

    const result = await probeDeveloperId();

    if (result) {
      upsertAccountFromProbe(result, { mode: 'login' });
      const profile = {
        nickname: result.nickname,
        avatar: result.avatar,
        developerName: result.developerName,
        developerAvatar: result.developerAvatar,
      };
      return { status: 'ready', developerId: result.developerId, error: null, profile, studios: result.studios };
    }

    // API 探测失败但有本地账号 → identity-unresolved
    if (accounts.current) {
      const acc = currentAccount();
      if (acc) {
        return {
          status: 'identity-unresolved',
          developerId: acc.developerId,
          error: 'Cannot resolve developer ID from API',
          profile: {
            nickname: acc.nickname || acc.name,
            avatar: acc.avatar,
            developerName: acc.developerName || acc.name,
            developerAvatar: acc.developerAvatar || acc.avatar,
          },
          studios: acc.studios || [],
        };
      }
    }

    return { status: 'unauthenticated', developerId: null, error: null, profile: null, studios: [] };
  } catch (err) {
    return { status: 'error', developerId: null, error: err.message, profile: null, studios: [] };
  }
});

ipcMain.on('bridge:getAppVersion', (event) => {
  event.returnValue = APP_VERSION;
});

ipcMain.handle('bridge:getDeveloperId', () => activeDeveloperId);

ipcMain.handle('bridge:getActiveDeveloperId', () => activeDeveloperId);

ipcMain.handle('bridge:getStudios', () => {
  const acc = currentAccount();
  return acc ? (acc.studios || []) : [];
});

ipcMain.handle('bridge:switchStudio', (event, developerId) => {
  const acc = currentAccount();
  if (!acc) return false;
  const sid = String(developerId);
  // 只允许在当前账号的工作室列表里切
  if (acc.studios && acc.studios.some(s => s.id === sid)) {
    activeDeveloperId = sid;
  } else {
    activeDeveloperId = sid; // 兜底
  }
  // 持久化到账号对象，reload 后仍保持切换状态（对齐安卓 AccountManager）
  acc.activeDeveloperId = activeDeveloperId;
  // 同步更新 developerName/developerAvatar 为选中工作室的信息
  const picked = acc.studios && acc.studios.find(s => s.id === sid);
  if (picked) {
    acc.developerName = picked.name;
    acc.developerAvatar = picked.logo;
  }
  saveAccounts();
  // 切换后重载页面，让前端重新拉取新工作室的游戏列表和收入（与登录成功行为一致）
  if (mainWindow) mainWindow.webContents.reload();
  return true;
});

// ====== 更新检查（对齐 Android UpdateChecker.kt） ======
async function fetchUpdateInfo() {
  try {
    const response = await net.fetch(UPDATE_URL, {
      headers: { 'User-Agent': UPDATE_UA, 'Accept': 'application/json' },
    });
    if (!response.ok) return null;
    const json = await response.json();
    return json || null;
  } catch (err) {
    console.error('[update] fetch error:', err.message);
    return null;
  }
}

function pickDownloadUrl(info) {
  if (!info) return null;
  // 优先 Windows 专用链接
  return info.win_url || info.exe_url || info.installer_url
      || info.download_page || info.apk_url || null;
}

async function showUpdateDialog(info, silent) {
  if (!info || !mainWindow) return;
  const serverCode = parseInt(info.version_code, 10);
  if (!Number.isFinite(serverCode) || serverCode <= VERSION_CODE) return;

  const force = info.force_update === true || info.force_update === 1;
  const versionName = info.latest_version || info.version_name || '';
  const notes = info.update_notes || info.notes || '';
  const publishedAt = info.published_at || '';
  const downloadUrl = pickDownloadUrl(info);

  const title = force ? '发现重要更新' : '发现新版本';
  let message = `当前版本 ${APP_VERSION}（build ${VERSION_CODE}）\n最新版本 ${versionName}（build ${serverCode}）`;
  if (publishedAt) message += `\n发布于 ${publishedAt}`;
  if (notes) message += `\n\n更新内容：\n${notes}`;

  const buttons = force ? ['立即更新'] : ['立即更新', '稍后'];
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: force ? 'warning' : 'info',
    title,
    message: title,
    detail: message,
    buttons,
    defaultId: 0,
    cancelId: force ? 0 : 1,
    noLink: true,
  });

  if (response === 0 && downloadUrl) {
    shell.openExternal(downloadUrl);
  }
}

// 静默检查：启动 3s 后调用，只在有更新且非强制时不打扰用户（有更新就弹窗）
async function silentUpdateCheck() {
  const info = await fetchUpdateInfo();
  if (info && parseInt(info.version_code, 10) > VERSION_CODE) {
    showUpdateDialog(info, true);
  }
}

ipcMain.handle('bridge:checkUpdate', async () => {
  // 手动检查：拿不到信息、无更新都给提示
  const info = await fetchUpdateInfo();
  if (!info) {
    if (mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'error', title: '检查更新失败', message: '无法连接到更新服务器，请稍后再试。',
        buttons: ['确定'], noLink: true,
      });
    }
    return;
  }
  const serverCode = parseInt(info.version_code, 10);
  if (!Number.isFinite(serverCode) || serverCode <= VERSION_CODE) {
    if (mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'info', title: '已是最新版本',
        message: `当前版本 ${APP_VERSION}（build ${VERSION_CODE}）已是最新。`,
        buttons: ['确定'], noLink: true,
      });
    }
    return;
  }
  await showUpdateDialog(info, false);
});

// 同步偏好设置
ipcMain.handle('bridge:syncPreferences', (event, mode, accent, font) => {
  preferences.theme_mode = mode || 'light';
  preferences.theme_accent = accent || 'cyan';
  preferences.font_family = font || 'default';
  writeJSON(PREFS_FILE, preferences);
});

// 打开登录窗口
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

    winContents.setWindowOpenHandler(({ url }) => {
      try {
        const u = new URL(url);
        if (NATIVE_SCHEMES.has(u.protocol.replace(':', '').toLowerCase())) {
          shell.openExternal(url);
          return { action: 'deny' };
        }
      } catch {}
      if (url.startsWith('http://') || url.startsWith('https://')) {
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
      if (mainWindow) mainWindow.webContents.send('login-check');
    };

    const saveAndFinish = async (developerId) => {
      if (!developerId || !/^\d+$/.test(developerId)) return;

      const result = await probeDeveloperId();
      if (!result) {
        // probe 失败但 URL 已经拿到 ID，构造最小占位数据
        upsertAccountFromProbe({
          developerId: String(developerId), nickname: '', avatar: '',
          developerName: '', developerAvatar: '', studios: [],
        }, { mode });
      } else {
        upsertAccountFromProbe(result, { mode });
      }

      const finalAcc = accounts.accounts.find(a => a.developerId === String(developerId));
      if (mainWindow) {
        mainWindow.webContents.send('login-success');
        mainWindow.webContents.send('account-updated', {
          isNew: !!(result && !accounts.accounts.some(a => a.developerId !== String(developerId) && a.id === (finalAcc && finalAcc.id))),
          alreadyCurrent: false,
          switched: mode !== 'add',
          developerId: String(developerId),
        });
        if (mode !== 'add') {
          activeDeveloperId = String(developerId);
          mainWindow.webContents.reload();
        }
      }
      finish({ success: true, developerId: String(developerId) });
    };

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
        if (result && !resolved) saveAndFinish(String(result));
      }).catch(() => {});
    };

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

    const onPageEvent = (url) => {
      if (resolved) return;
      const idFromUrl = extractDeveloperIdFromUrl(url);
      if (idFromUrl) { saveAndFinish(idFromUrl); return; }
      setTimeout(jsCheck, 900);
      setTimeout(nativeCheck, 1400);
    };

    winContents.on('did-navigate', (ev, url) => onPageEvent(url));
    winContents.on('did-navigate-in-page', (ev, url) => onPageEvent(url));

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

    const startLogin = () => {
      loginWindow.loadURL('https://developer.taptap.cn/');
    };

    if (mode === 'add') {
      session.defaultSession.clearStorageData({
        storages: ['cookies'],
        origins: ['https://developer.taptap.cn', 'https://passport.taptap.cn', 'https://www.taptap.cn', 'https://www.taptap.com'],
      }).then(startLogin).catch(startLogin);
    } else {
      startLogin();
    }
  });
});

// 返回 { current, accounts } 对齐前端
ipcMain.handle('bridge:getAccounts', () => {
  return { current: accounts.current, accounts: accounts.accounts };
});

ipcMain.handle('bridge:switchAccount', (event, id) => {
  const acc = accounts.accounts.find(a => a.id === id);
  if (!acc) {
    if (mainWindow) mainWindow.webContents.send('account-updated', { isNew: false, alreadyCurrent: false, switched: false, developerId: null });
    return { ok: false, error: '账号不存在' };
  }
  const alreadyCurrent = accounts.current === acc.id;
  if (alreadyCurrent) {
    if (mainWindow) mainWindow.webContents.send('account-updated', { isNew: false, alreadyCurrent: true, switched: false, developerId: acc.developerId });
    return { ok: true };
  }
  accounts.current = acc.id;
  activeDeveloperId = acc.activeDeveloperId || acc.developerId;
  saveAccounts();
  if (mainWindow) {
    mainWindow.webContents.send('account-updated', { isNew: false, alreadyCurrent: false, switched: true, developerId: acc.developerId });
    // 切换账号后刷新页面（拉取该账号最新数据）
    mainWindow.webContents.reload();
  }
  return { ok: true };
});

ipcMain.handle('bridge:addAccount', (event, data) => {
  const name = (data && data.name) || '';
  const developerId = (data && data.developerId) || '';
  if (developerId && !accounts.accounts.find(a => a.developerId === String(developerId))) {
    const acc = {
      id: genAccId(),
      name: name || developerId,
      developerId: String(developerId),
      developerName: name || '',
      developerAvatar: '',
      nickname: name || '',
      avatar: '',
      partition: 'persist:taptap-' + developerId,
      studios: [],
    };
    accounts.accounts.push(acc);
    if (!accounts.current) {
      accounts.current = acc.id;
      activeDeveloperId = acc.activeDeveloperId || acc.developerId;
    }
    saveAccounts();
  }
});

ipcMain.handle('bridge:removeAccount', (event, id) => {
  const idx = accounts.accounts.findIndex(a => a.id === id);
  if (idx < 0) return { ok: false, error: '账号不存在' };
  const removed = accounts.accounts[idx];
  accounts.accounts.splice(idx, 1);
  if (accounts.current === removed.id) {
    if (accounts.accounts.length > 0) {
      accounts.current = accounts.accounts[0].id;
      activeDeveloperId = accounts.accounts[0].activeDeveloperId || accounts.accounts[0].developerId;
    } else {
      accounts.current = null;
      activeDeveloperId = null;
    }
  }
  saveAccounts();
  return { ok: true };
});

ipcMain.handle('bridge:openExplorer', () => {
  shell.openPath(DATA_DIR);
});

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

ipcMain.handle('bridge:getPreferences', () => preferences);

// ====== App 生命周期 ======
app.whenReady().then(() => {
  session.defaultSession.setUserAgent(DESKTOP_UA);
  session.defaultSession.cookies.set({
    url: 'https://developer.taptap.cn',
    name: '_third_party_cookie_check',
    value: '1',
    sameSite: 'no_restriction',
    secure: true,
  }).catch(() => {});
  createWindow();

  // 启动 3 秒后静默检查更新（对齐 Android UpdateChecker 冷启动后 3s）
  setTimeout(silentUpdateCheck, 3000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

setInterval(() => {
  if (mainWindow) {
    mainWindow.webContents.executeJavaScript('if(window.__onAppBackgroundTick)window.__onAppBackgroundTick();');
  }
}, 5 * 60 * 1000);

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
  // id 字段优先级（对齐安卓端 extractDeveloperIdFromItem）：developer_id > developerId > id
  const id = String(s.developer_id || s.developerId || s.id || '').trim();
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

// ====== 每个账号独立的 Cookie 存储（对齐 Android AccountManager.kt cookieStore） ======
// Electron 所有窗口共享 session.defaultSession，多账号切换时需要手动保存/恢复 cookie。
// 切换账号流程：saveAccountCookies(当前) → clearTaptapCookies() → restoreAccountCookies(目标) → reload

const TAPTAP_COOKIE_ORIGINS = [
  'https://developer.taptap.cn',
  'https://passport.taptap.cn',
  'https://www.taptap.cn',
  'https://www.taptap.com',
  'https://taptap.cn',
  'https://taptap.com',
];

/**
 * 将当前 defaultSession 中 TapTap 相关 cookie 保存到指定账号对象
 */
async function saveAccountCookies(accountId) {
  const acc = accounts.accounts.find(a => a.id === accountId);
  if (!acc) return;
  try {
    const allCookies = await session.defaultSession.cookies.get({});
    const taptapCookies = allCookies
      .filter(c => c.domain && c.domain.includes('taptap'))
      .map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        sameSite: c.sameSite || 'unspecified',
        expirationDate: c.expirationDate > 0 ? c.expirationDate : undefined,
      }));
    acc.cookies = taptapCookies;
    saveAccounts();
  } catch (err) {
    console.error('[cookie] saveAccountCookies error:', err.message);
  }
}

/**
 * 清除 defaultSession 中所有 TapTap cookie
 */
async function clearTaptapCookies() {
  try {
    await session.defaultSession.clearStorageData({
      storages: ['cookies'],
      origins: TAPTAP_COOKIE_ORIGINS,
    });
  } catch (err) {
    console.error('[cookie] clearTaptapCookies error:', err.message);
  }
}

/**
 * 将指定账号保存的 cookie 恢复到 defaultSession
 */
async function restoreAccountCookies(accountId) {
  const acc = accounts.accounts.find(a => a.id === accountId);
  if (!acc || !Array.isArray(acc.cookies) || acc.cookies.length === 0) return;
  try {
    for (const c of acc.cookies) {
      const hostname = c.domain.replace(/^\./, '');
      const protocol = c.secure ? 'https' : 'http';
      const url = `${protocol}://${hostname}${c.path || '/'}`;
      const details = {
        url,
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        sameSite: c.sameSite || 'unspecified',
      };
      if (c.expirationDate && c.expirationDate > 0) {
        details.expirationDate = c.expirationDate;
      }
      try {
        await session.defaultSession.cookies.set(details);
      } catch (setErr) {
        // 单个 cookie 失败不影响其他
        console.warn('[cookie] restore cookie', c.name, 'error:', setErr.message);
      }
    }
  } catch (err) {
    console.error('[cookie] restoreAccountCookies error:', err.message);
  }
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

  // 只改写开发者后台 API 的请求头；不得触碰 accounts.taptap.cn（二维码登录页）——
  // 此前对所有 *.taptap.cn 强改 Referer/UA，导致扫码状态轮询失败，扫码后页面卡死不跳转
  const filter = { urls: ['*://developer.taptap.cn/*'] };
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
    if (Array.isArray(studios)) acc.studios = studios;
    if (!acc.partition) acc.partition = 'persist:taptap-' + developerId;
  }

  // 非 add 模式：设为当前账号
  if (setActive) {
    accounts.current = acc.id;
    // 已有账号且有 activeDeveloperId → 保留用户的工作室选择（reload 后不重置）
    // 新账号或无 activeDeveloperId → 默认用登录探测到的 developerId
    if (!isNew && acc.activeDeveloperId) {
      activeDeveloperId = acc.activeDeveloperId;
    } else {
      activeDeveloperId = developerId;
      acc.activeDeveloperId = null;
    }
  } else if (!accounts.current) {
    accounts.current = acc.id;
    activeDeveloperId = developerId;
    acc.activeDeveloperId = null;
  }

  // 根据 activeDeveloperId 决定最终写入 acc.developerName / developerAvatar：
  // - 有 activeDeveloperId 且在 studios 里能找到 → 用选中工作室的 name/logo
  // - 否则用 probe 探测到的主账号/主工作室信息
  // 这样 switchStudio 后 reload 不会被 upsert 覆盖回主工作室。
  if (!isNew && acc.activeDeveloperId && Array.isArray(acc.studios)) {
    const picked = acc.studios.find(s => s.id === acc.activeDeveloperId);
    if (picked) {
      acc.developerName = picked.name || acc.developerName || developerName || '';
      acc.developerAvatar = picked.logo || acc.developerAvatar || developerAvatar || '';
    } else {
      if (developerName) acc.developerName = developerName;
      if (developerAvatar) acc.developerAvatar = developerAvatar;
    }
  } else {
    if (developerName) acc.developerName = developerName;
    if (developerAvatar) acc.developerAvatar = developerAvatar;
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

// ====== REP 平台（rep.taptap.cn）数据桥接 ======
// REP 与开发者后台共用 TapTap 账号 SSO 登录态：
// 静默打开 rep.taptap.cn → SSO 自动写入 localStorage['op-jwt-token'] → 带令牌调用 tap-op 接口
let repTokenCache = { token: null, fetchedAt: 0 };
const REP_TOKEN_TTL = 4 * 60 * 60 * 1000; // 4 小时后强制刷新

async function getRepToken() {
  if (repTokenCache.token && Date.now() - repTokenCache.fetchedAt < REP_TOKEN_TTL) {
    return repTokenCache.token;
  }
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  try {
    await win.loadURL('https://rep.taptap.cn/');
    // SSO 静默跳转完成后令牌会写入 localStorage，轮询等待其出现（最多 20s）
    const token = await new Promise((resolve) => {
      let tries = 0;
      const timer = setInterval(async () => {
        tries += 1;
        try {
          const t = await win.webContents.executeJavaScript('localStorage.getItem("op-jwt-token") || null');
          if (t) { clearInterval(timer); resolve(t); return; }
        } catch (_) { /* 页面跳转中 executeJavaScript 可能短暂失败，忽略 */ }
        if (tries >= 40) { clearInterval(timer); resolve(null); }
      }, 500);
    });
    if (token) repTokenCache = { token, fetchedAt: Date.now() };
    appLog('[rep] token fetch:', token ? 'ok' : 'FAILED');
    return token;
  } finally {
    try { win.destroy(); } catch (_) {}
  }
}

ipcMain.handle('bridge:repRevenue', async (event, appId) => {
  try {
    const token = await getRepToken();
    if (!token) return { ok: false, status: 0, body: null, error: 'REP_TOKEN_FAIL' };
    const developerId = activeDeveloperId || '';
    const response = await net.fetch('https://tap-op.tapapis.cn/rep/be/v1/dashboard/revenue', {
      method: 'GET',
      headers: {
        'Authorization': token,
        'x-app-id': String(appId),
        'x-developer-id': String(developerId),
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': DESKTOP_UA,
        'Referer': 'https://rep.taptap.cn/',
      },
    });
    const body = await response.text();
    // 令牌失效时清缓存，下次调用重新走 SSO 获取
    if (response.status === 401 || response.status === 403) {
      repTokenCache = { token: null, fetchedAt: 0 };
    }
    return { ok: response.ok, status: response.status, body, error: null };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: err.message };
  }
});

// ====== 诊断日志（登录链路排障用） ======
const LOG_FILE = path.join(DATA_DIR, 'app.log');
function appLog(...args) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ` + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n', 'utf-8');
  } catch (_) {}
}

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
      appLog('[checkLogin] unauthenticated: no session cookie, no local account');
      return { status: 'unauthenticated', developerId: null, error: null, profile: null, studios: [] };
    }

    const result = await probeDeveloperId();
    appLog('[checkLogin] probe result:', result ? ('hit ' + result.developerId) : 'miss', '| hasSession =', hasSession);

    if (result) {
      upsertAccountFromProbe(result, { mode: 'login' });
      // 首次启动/重载后，将当前 cookie 保存到账号对象（确保后续切换账号时有 cookie 可恢复）
      if (accounts.current) {
        saveAccountCookies(accounts.current);
      }
      // 返回给前端的 developerId/profile 应该基于 activeDeveloperId（可能是切换后的子工作室）
      // 而不是 probe 到的主账号 developerId
      const acc = currentAccount();
      const effDevId = (acc && acc.activeDeveloperId) ? acc.activeDeveloperId : result.developerId;
      // 从 studios 列表中找到 activeDeveloperId 对应的工作室，取其 name/logo
      let effDevName = result.developerName;
      let effDevAvatar = result.developerAvatar;
      if (acc && acc.activeDeveloperId && Array.isArray(result.studios)) {
        const picked = result.studios.find(s => s.id === acc.activeDeveloperId);
        if (picked) {
          effDevName = picked.name || effDevName;
          effDevAvatar = picked.logo || effDevAvatar;
        }
      }
      const profile = {
        nickname: result.nickname,
        avatar: result.avatar,
        developerName: effDevName,
        developerAvatar: effDevAvatar,
      };
      return { status: 'ready', developerId: effDevId, error: null, profile, studios: result.studios };
    }

    // API 探测失败但有本地账号 → identity-unresolved
    if (accounts.current) {
      const acc = currentAccount();
      if (acc) {
        const effDevId = acc.activeDeveloperId || acc.developerId;
        let effDevName = acc.developerName || acc.name;
        let effDevAvatar = acc.developerAvatar || acc.avatar;
        if (acc.activeDeveloperId && Array.isArray(acc.studios)) {
          const picked = acc.studios.find(s => s.id === acc.activeDeveloperId);
          if (picked) {
            effDevName = picked.name || effDevName;
            effDevAvatar = picked.logo || effDevAvatar;
          }
        }
        return {
          status: 'identity-unresolved',
          developerId: effDevId,
          error: 'Cannot resolve developer ID from API',
          profile: {
            nickname: acc.nickname || acc.name,
            avatar: acc.avatar,
            developerName: effDevName,
            developerAvatar: effDevAvatar,
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
    appLog('[login] openLogin start, mode =', mode || 'normal');

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
    // add 模式下记录原来的当前账号，登录新账号后恢复其 cookie
    const prevAccountId = (mode === 'add') ? accounts.current : null;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      appLog('[login] finish:', result);
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
      resolve(result);
      if (mainWindow) mainWindow.webContents.send('login-check');
    };

    const saveAndFinish = async (developerId) => {
      if (!developerId || !/^\d+$/.test(developerId)) return;
      appLog('[login] saveAndFinish, developerId =', String(developerId));

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

      // 保存刚登录成功的账号 cookie（此时 defaultSession 里是新账号的 cookie）
      if (finalAcc) {
        await saveAccountCookies(finalAcc.id);
      }

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
        } else {
          // add 模式：登录完新账号后，恢复之前账号的 cookie，让主窗口继续用原账号身份工作
          if (prevAccountId) {
            await clearTaptapCookies();
            await restoreAccountCookies(prevAccountId);
          }
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
        if (result) appLog('[login] jsCheck result:', String(result));
        if (result && !resolved) saveAndFinish(String(result));
      }).catch((e) => { appLog('[login] jsCheck error:', String(e).slice(0, 120)); });
    };

    const nativeCheck = async () => {
      if (resolved || nativeCheckAttempts >= MAX_NATIVE_ATTEMPTS) return;
      nativeCheckAttempts++;
      const result = await probeDeveloperId();
      if (result && !resolved) {
        appLog('[login] nativeCheck hit, developerId =', String(result.developerId));
        saveAndFinish(result.developerId);
      } else if (!resolved) {
        if (nativeCheckAttempts <= 3) appLog('[login] nativeCheck miss #' + nativeCheckAttempts);
        setTimeout(nativeCheck, 1800);
      }
    };

    const onPageEvent = (url) => {
      if (resolved) return;
      appLog('[login] nav ->', String(url).slice(0, 160));
      const idFromUrl = extractDeveloperIdFromUrl(url);
      if (idFromUrl) { saveAndFinish(idFromUrl); return; }
      setTimeout(jsCheck, 900);
      setTimeout(nativeCheck, 1400);
    };

    winContents.on('did-navigate', (ev, url) => onPageEvent(url));
    winContents.on('did-navigate-in-page', (ev, url) => onPageEvent(url));

    // 诊断：登录窗口内页面 JS 报错
    winContents.on('console-message', (ev, level, message, line, sourceId) => {
      if (level >= 2) appLog('[login][page-error]', String(message).slice(0, 200), '@', String(sourceId).slice(0, 80));
    });

    // 诊断：二维码页所有网络请求的成败（定位扫码轮询为何不动）
    const diagFilter = { urls: ['*://accounts.taptap.cn/*', '*://*.taptap.cn/*'] };
    const netOnCompleted = (details) => {
      if (!loginWindow || loginWindow.isDestroyed()) return;
      if (details.webContentsId !== winContents.webContentsId) return;
      if (details.resourceType === 'image' || details.resourceType === 'stylesheet' || details.resourceType === 'font') return;
      appLog('[login][net]', details.responseStatusCode || '?', details.url.slice(0, 140));
    };
    const netOnError = (details) => {
      if (!loginWindow || loginWindow.isDestroyed()) return;
      if (details.webContentsId !== winContents.webContentsId) return;
      appLog('[login][net-ERR]', details.errorText, details.url.slice(0, 140));
    };
    session.defaultSession.webRequest.onCompleted(diagFilter, netOnCompleted);
    session.defaultSession.webRequest.onErrorOccurred(diagFilter, netOnError);

    // 诊断：CDP 全量抓取（含 WebSocket 握手），解决普通 webRequest 看不到长连接的问题
    try {
      winContents.debugger.attach('1.3');
      winContents.debugger.sendCommand('Network.enable', { maxPostDataSize: 4096 }).then(() => {
        appLog('[login][cdp] attached');
      }).catch((e) => appLog('[login][cdp] enable fail', String(e).slice(0, 100)));
      winContents.on('debugger-message', (ev, method, params) => {
        try {
          if (method === 'Network.requestWillBeSent') {
            const u = params.request.url;
            if (u.startsWith('data:') || u.includes('sentry') || u.endsWith('.png') || u.endsWith('.woff2')) return;
            appLog('[login][cdp-req]', params.type || '?', u.slice(0, 170));
          } else if (method === 'Network.webSocketCreated') {
            appLog('[login][cdp-WS-CREATE]', params.url.slice(0, 170));
          } else if (method === 'Network.webSocketClosed') {
            appLog('[login][cdp-WS-CLOSED]');
          } else if (method === 'Network.responseReceived' && params.response && params.response.status >= 400) {
            appLog('[login][cdp-BAD]', params.response.status, params.response.url.slice(0, 150));
          }
        } catch (_) {}
      });
    } catch (e) {
      appLog('[login] debugger attach fail:', String(e).slice(0, 120));
    }

    winContents.on('will-navigate', (ev, url) => {
      try {
        const u = new URL(url);
        if (NATIVE_SCHEMES.has(u.protocol.replace(':', '').toLowerCase())) {
          ev.preventDefault();
          shell.openExternal(url);
        }
      } catch {}
    });

    loginWindow.on('closed', async () => {
      loginWindow = null;
      // add 模式下取消登录（关闭窗口）：恢复之前账号的 cookie
      if (!resolved && mode === 'add' && prevAccountId) {
        await clearTaptapCookies();
        await restoreAccountCookies(prevAccountId);
      }
      if (!resolved) finish({ success: false, reason: 'closed' });
    });

    const startLogin = () => {
      loginWindow.loadURL('https://developer.taptap.cn/');
    };

    if (mode === 'add') {
      // add 模式：先保存当前账号 cookie，再清除，让登录窗口从零开始登录新账号
      const prepAdd = async () => {
        if (prevAccountId) {
          await saveAccountCookies(prevAccountId);
        }
        await clearTaptapCookies();
        startLogin();
      };
      prepAdd().catch(startLogin);
    } else {
      startLogin();
    }
  });
});

// 返回 { current, accounts } 对齐前端
ipcMain.handle('bridge:getAccounts', () => {
  return { current: accounts.current, accounts: accounts.accounts };
});

ipcMain.handle('bridge:switchAccount', async (event, id) => {
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

  // 1. 先保存当前账号的 cookie（对齐 Android AccountManager.switchAccount 保存旧账号 cookie）
  const prevId = accounts.current;
  if (prevId) {
    await saveAccountCookies(prevId);
  }
  // 2. 清除当前 session cookie
  await clearTaptapCookies();
  // 3. 恢复目标账号的 cookie
  await restoreAccountCookies(acc.id);

  // 4. 切换账号状态
  accounts.current = acc.id;
  activeDeveloperId = acc.activeDeveloperId || acc.developerId;
  saveAccounts();

  if (mainWindow) {
    mainWindow.webContents.send('account-updated', { isNew: false, alreadyCurrent: false, switched: true, developerId: acc.developerId });
    // 5. 刷新页面（用目标账号的 cookie 拉取数据）
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

  // 启动时若 defaultSession 没有会话 Cookie，恢复当前账号已保存的 Cookie，
  // 避免本地已有账号却仍要求重新扫码登录
  (async () => {
    try {
      if (accounts.current) {
        const cookies = await session.defaultSession.cookies.get({ domain: '.taptap.cn' });
        const hasSession = cookies.some(c =>
          (c.name === 'sessionid' || c.name === 'taptap_session' || c.name === 'sid'
           || c.name === 'taptap_access_token' || c.name.startsWith('tt_')) && c.value
        );
        appLog('[boot] hasSession =', hasSession, '| current account =', accounts.current);
        if (!hasSession) {
          await restoreAccountCookies(accounts.current);
          appLog('[boot] 已从本地账号恢复 Cookie');
        }
      } else {
        appLog('[boot] 无本地账号，等待用户登录');
      }
    } catch (e) {
      appLog('[boot] restore error:', String(e).slice(0, 150));
    }
  })();

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

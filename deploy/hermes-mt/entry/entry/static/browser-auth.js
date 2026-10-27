// Generated from apps/shared/src/browser-maas-auth.js by build-frontend.sh.
// Shared by the standalone login page and the browser renderer bundle.
export function browserAuthKey(basePath) {
  return `hermes.cloud.auth.v1:${basePath.replace(/\/$/, '')}`;
}

export function clearBrowserAuth(basePath, loginId) {
  const key = browserAuthKey(basePath);
  if (loginId !== undefined) {
    const current = readBrowserAuth(basePath);
    if (!current || current.loginId !== loginId) return;
  }
  localStorage.removeItem(key);
}

export function readBrowserAuth(basePath) {
  const key = browserAuthKey(basePath);
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  let value;
  try { value = JSON.parse(raw); } catch { value = null; }
  if (value && typeof value.token === 'string' && value.token.length > 0 &&
      typeof value.loginId === 'string' && value.loginId.length > 0 &&
      Number.isSafeInteger(value.expiresAt) && value.expiresAt > Date.now()) {
    return value;
  }
  if (localStorage.getItem(key) === raw) localStorage.removeItem(key);
  return null;
}

export function storeBrowserLogin(basePath, response) {
  if (!response.maas_auth) {
    clearBrowserAuth(basePath); // Development logins must drop the previous real identity.
    return;
  }
  const { token, expiresAt, loginId } = response.maas_auth;
  if (typeof token !== 'string' || !token || typeof loginId !== 'string' || !loginId ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    clearBrowserAuth(basePath);
    throw new Error('登录凭据无效，请重新登录。');
  }
  localStorage.setItem(browserAuthKey(basePath), JSON.stringify({ token, expiresAt, loginId }));
}

export async function requestEntryMaas(basePath, path, options = {}) {
  // A business path, never an arbitrary URL or the general instance proxy.
  if (!/^(maas-auth|conversation-shares|artifact-shares|drive)(\/[A-Za-z0-9_-]+)*$/.test(path)) {
    throw new Error('不支持的账号业务接口。');
  }
  const base = new URL(`${basePath.replace(/\/$/, '')}/__entry/`, location.origin);
  if (base.origin !== location.origin || !/^\/(?:[A-Za-z0-9_-]+\/)*__entry\/$/.test(base.pathname)) {
    throw new Error('账号业务接口必须位于本站。');
  }
  const auth = readBrowserAuth(basePath);
  if (!auth) throw new Error('请重新登录后使用此功能。');
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${auth.token}`);
  const response = await fetch(new URL(path, base).href, {
    ...options, method: options.method || 'POST', headers,
    credentials: 'same-origin', redirect: 'error', cache: 'no-store'
  });
  const current = readBrowserAuth(basePath);
  if (!current || current.loginId !== auth.loginId) {
    throw new Error('账号已切换，请重新操作。');
  }
  if (response.status === 401) {
    clearBrowserAuth(basePath, auth.loginId);
    throw new Error('登录已失效，请重新登录。');
  }
  if (!response.ok) {
    let detail;
    try { detail = await response.json(); } catch { detail = null; }
    throw new Error(typeof detail?.error === 'string' ? detail.error : `账号业务请求失败（${response.status}），请稍后重试。`);
  }
  return response.json();
}

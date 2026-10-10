/* 贴在 hermes 原生 SPA 右下角的一小块：当前登录的是谁 + 退出；在名字上连点 7 次切换开发者模式。
 *
 * 由 Nginx 的 sub_filter 注入 index.html，前端源码与构建产物一个字节都不动。
 * SPA 不知道入口的存在，界面上不会有任何跟我们登录体系相关的元素，所以只能从外面贴。
 *
 * 约束：
 * - 不碰 SPA 的 DOM，只往 body 末尾加自己的节点；样式全部内联并带前缀，避免和它的 CSS 打架。
 * - z-index 压住 SPA 的浮层，但 pointer-events 只作用在自己身上。
 * - 拿不到身份就静默不显示（例如 cookie 过期），不弹错、不挡界面。
 */
(function () {
  var BASE = '__BASE__';
  var ID = 'hermes-mt-badge';
  if (window.__hermesMtBadge) return;
  window.__hermesMtBadge = true;

  function el(tag, style, text) {
    var n = document.createElement(tag);
    n.style.cssText = style;
    if (text != null) n.textContent = text;
    return n;
  }

  // 开发者模式：只记在这个浏览器里，前端（apps/desktop/src/lib/browser-shell.ts）读同一个键，
  // 打开后把普通用户用不着的入口和 hermes 自带的服务商都显示出来。
  var DEV_KEY = 'hermes.mt.developer';
  var DEV_TAPS = 7;
  var DEV_WINDOW_MS = 3000;

  function devMode() {
    try { return window.localStorage.getItem(DEV_KEY) === '1'; } catch (e) { return false; }
  }

  // 3 秒内在名字上连点 7 次切换；切换后刷新页面，让前端按新模式重新画。
  function watchTaps(target, on) {
    var taps = [];
    target.addEventListener('click', function () {
      var now = Date.now();
      taps.push(now);
      while (taps.length && now - taps[0] > DEV_WINDOW_MS) taps.shift();
      if (taps.length < DEV_TAPS) return;
      taps = [];
      try {
        if (on) window.localStorage.removeItem(DEV_KEY); else window.localStorage.setItem(DEV_KEY, '1');
      } catch (e) { return; }
      target.textContent = on ? '已退出开发者模式' : '已进入开发者模式';
      setTimeout(function () { window.location.reload(); }, 600);
    });
  }

  function mount(info) {
    if (document.getElementById(ID)) return;
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var bg = dark ? 'rgba(28,30,34,.92)' : 'rgba(255,255,255,.94)';
    var fg = dark ? '#e6e6e6' : '#1f2328';
    var mut = dark ? '#9aa0a6' : '#5f6368';
    var line = dark ? '#3a3d42' : '#d9dce1';

    // 贴着最底部状态栏那一行的右端：再往上就会压住输入框右侧的一排按钮
    // （实测按钮行到 y=767，状态栏 footer 在 y=768 以下且右半边是空的）。
    var box = el('div', [
      'position:fixed', 'right:10px', 'bottom:2px', 'z-index:2147483000',
      'display:flex', 'align-items:center', 'gap:6px',
      'padding:2px 8px', 'border-radius:6px',
      'background:' + bg, 'border:1px solid ' + line, 'color:' + fg,
      'font:11px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
      'box-shadow:0 1px 4px rgba(0,0,0,.14)', 'user-select:none'
    ].join(';'));
    box.id = ID;

    var dev = devMode();
    var dot = el('span', 'width:5px;height:5px;border-radius:50%;flex:0 0 auto;background:' + (dev ? '#f59e0b' : '#22c55e'));
    var who = el('span', 'color:' + fg + ';max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
      info.display || info.user_id || '');
    who.title = '用户 ID: ' + (info.user_id || '') + (dev ? '\n开发者模式：在名字上连点 7 次退出' : '');
    watchTaps(who, dev);

    var sep = el('span', 'color:' + line, '|');
    var devTag = dev ? el('span', 'color:#f59e0b;font-weight:600;flex:0 0 auto', '开发者') : null;

    var out = el('a', [
      'color:' + mut, 'cursor:pointer', 'text-decoration:none', 'flex:0 0 auto'
    ].join(';'), '退出');
    out.href = BASE + '/logout';
    out.title = '退出登录';
    out.addEventListener('mouseenter', function () { out.style.color = fg; });
    out.addEventListener('mouseleave', function () { out.style.color = mut; });

    box.appendChild(dot); box.appendChild(who);
    if (devTag) box.appendChild(devTag);
    box.appendChild(sep); box.appendChild(out);
    document.body.appendChild(box);
  }

  function start() {
    fetch(BASE + '/__entry/me', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (info) { if (info) mount(info); })
      .catch(function () { /* 拿不到身份就不显示，别打扰界面 */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

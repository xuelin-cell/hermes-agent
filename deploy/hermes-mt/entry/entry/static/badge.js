/* 贴在 hermes 原生 SPA 右下角的一小块：当前登录的是谁 + 退出。
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

    var dot = el('span', 'width:5px;height:5px;border-radius:50%;background:#22c55e;flex:0 0 auto');
    var who = el('span', 'color:' + fg + ';max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
      info.display || info.user_id || '');
    who.title = '用户 ID: ' + (info.user_id || '');

    var sep = el('span', 'color:' + line, '|');

    var out = el('a', [
      'color:' + mut, 'cursor:pointer', 'text-decoration:none', 'flex:0 0 auto'
    ].join(';'), '退出');
    out.href = BASE + '/logout';
    out.title = '退出登录';
    out.addEventListener('mouseenter', function () { out.style.color = fg; });
    out.addEventListener('mouseleave', function () { out.style.color = mut; });

    box.appendChild(dot); box.appendChild(who); box.appendChild(sep); box.appendChild(out);
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

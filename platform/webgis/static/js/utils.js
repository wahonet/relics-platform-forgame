// 通用小工具。
function toast(msg, isErr) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = 'show' + (isErr ? ' err' : '');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.className = '', 4000);
}

function esc(s) { return (s || '').replace(/'/g, "\\'"); }

function ir(l, v) { return '<div class="ir"><div class="ir-l">' + l + '</div><div class="ir-v">' + (v ?? '-') + '</div></div>'; }

function is3D(r) { return r.has_3d === true || r.has_3d === 'True' || r.has_3d === 'true'; }

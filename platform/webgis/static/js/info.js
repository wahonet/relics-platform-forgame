// 文物信息面板:基本信息 / 照片 / 图纸 / 简介 四个页签。
let _currentInfoRelic = null;

// 按 code 拉完整记录。PointPrimitive 点击后调用此函数(视口路径不再挂 Entity.properties)。
async function showInfoByCode(code) {
    if (!code) return;
    // 先命中内存快照,避免多一次请求。
    const cached = (window.allRelics || []).find(r => r.archive_code === code);
    if (cached) { showInfo(cached); return; }
    try {
        const full = await (await fetch(API + '/api/relics/' + encodeURIComponent(code))).json();
        if (full && full.archive_code) showInfo(full);
    } catch (e) { console.warn('showInfoByCode failed', code, e); }
}

async function showInfo(r) {
    _currentInfoRelic = r;
    document.getElementById('piTitle').textContent = r.name || '-';

    const backBtn = document.getElementById('piBackBtn');
    if (backBtn) {
        if (typeof _wlReturnDate !== 'undefined' && _wlReturnDate) {
            backBtn.classList.remove('disabled');
        } else {
            backBtn.classList.add('disabled');
        }
    }

    const h3d = is3D(r);
    const ccls = COND_CLS[r.condition_level] || '';

    let tags = '<div class="info-tags">';
    if (r.era) tags += '<span class="tag tag-era">' + r.era + '</span>';
    if (r.category_main) tags += '<span class="tag tag-cat">' + r.category_main + '</span>';
    if (r.heritage_level && r.heritage_level.length < 20) tags += '<span class="tag tag-lv">' + r.heritage_level + '</span>';
    if (h3d) tags += '<span class="tag tag-3d">三维模型</span>';
    if (r.has_pdf) tags += '<span class="tag tag-pdf">四普档案</span>';
    tags += '</div>';

    let html = tags;
    html += ir('编号', r.archive_code) + ir('年代', r.era);
    html += ir('类别', r.category_main + (r.category_sub ? ' / ' + r.category_sub : ''));
    html += ir('级别', r.heritage_level) + ir('乡镇', r.township) + ir('地址', r.address);
    html += ir('面积', r.area);
    html += ir('现状', '<span class="' + ccls + '">' + (r.condition_level || '-') + '</span>');
    html += ir('风险分', r.risk_score) + ir('照片', (r.photo_count || 0) + ' 张') + ir('图纸', (r.drawing_count || 0) + ' 张');

    const btns = [];
    if (h3d) {
        const folder = (r.model_3d_path || '').replace(/^Get3D\//, '');
        const refLat = r.center_lat || 0;
        const refLng = r.center_lng || 0;
        const refAlt = r.center_alt || 0;
        btns.push('<button class="pi-act-btn pi-btn-3d" onclick="open3DBox(\'' + esc(folder) + '\',\'' + esc(r.name) + '\',' + refLat + ',' + refLng + ',' + refAlt + ')">' +
            '<svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>3D</button>');
    }
    if (r.has_pdf && r.pdf_path) {
        btns.push('<button class="pi-act-btn pi-btn-pdf" onclick="openPdfBox(\'/pdfs/' + esc(r.pdf_path) + '\',\'' + esc(r.name) + '\')">' +
            '<svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6zm2-6h8v2H8v-2zm0-3h8v2H8v-2zm0 6h5v2H8v-2z"/></svg>档案</button>');
    }
    const logDate = _findRelicLogDate(r.name);
    if (logDate) {
        btns.push('<button class="pi-act-btn pi-btn-log" onclick="piOpenLog(\'' + logDate + '\')">' +
            '<svg viewBox="0 0 24 24"><path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM7 10h5v5H7v-5z"/></svg>日志</button>');
    }
    if (btns.length) html += '<div class="pi-action-bar">' + btns.join('') + '</div>';

    document.getElementById('tcInfo').innerHTML = html;
    switchTab(document.querySelector('.pi-tab[data-t="tcInfo"]'));
    document.getElementById('infoPanel').style.display = 'block';
    updateLayout();

    loadPhotos(r.archive_code);
    loadDrawings(r.archive_code);
    loadIntro(r.archive_code);
}

function _findRelicLogDate(name) {
    if (!name || typeof _worklogByDate === 'undefined') return null;
    for (const [date, info] of Object.entries(_worklogByDate)) {
        const allNames = (info.review_names || '') + '、' + (info.new_names || '');
        const parts = allNames.split(/[、，,]/).map(s => s.trim()).filter(Boolean);
        if (parts.some(n => n === name || name.includes(n) || n.includes(name))) return date;
    }
    return null;
}

function piOpenLog(date) {
    closeInfo();
    openWorklogViewer(date);
}

function piGoBackToLog() {
    if (typeof _wlReturnDate === 'undefined' || !_wlReturnDate) return;
    const date = _wlReturnDate;
    _wlReturnDate = null;
    closeInfo();
    openWorklogViewer(date);
}

function closeInfo() {
    document.getElementById('infoPanel').style.display = 'none';
    if (typeof _wlReturnDate !== 'undefined') _wlReturnDate = null;
    updateLayout();
    if (window.Bus) window.Bus.emit('info:closed');
}

function switchTab(el) {
    document.querySelectorAll('.pi-tab').forEach(t => t.classList.remove('on'));
    document.querySelectorAll('.tc').forEach(t => t.classList.remove('on'));
    el.classList.add('on');
    document.getElementById(el.dataset.t).classList.add('on');
}

async function loadPhotos(code) {
    const el = document.getElementById('tcPhoto');
    el.innerHTML = '<div class="empty-tip">加载中...</div>';
    try {
        currentPhotos = await (await fetch(API + '/api/relics/' + code + '/photos')).json();
        if (!currentPhotos.length) { el.innerHTML = '<div class="empty-tip">暂无照片</div>'; return; }
        el.innerHTML = '<div class="pg">' + currentPhotos.map((p, i) =>
            '<div class="pt" onclick="openPhotoLB(' + i + ')"><img src="/photos/' + p.relative_path + '" loading="lazy" onerror="this.parentElement.style.display=\'none\'"><div class="pl">' + (p.description || p.photo_no || '') + '</div></div>'
        ).join('') + '</div>';
    } catch (e) { el.innerHTML = '<div class="empty-tip">加载失败</div>'; }
}

async function loadDrawings(code) {
    const el = document.getElementById('tcDraw');
    el.innerHTML = '<div class="empty-tip">加载中...</div>';
    try {
        currentDrawings = await (await fetch(API + '/api/relics/' + code + '/drawings')).json();
        if (!currentDrawings.length) { el.innerHTML = '<div class="empty-tip">暂无图纸</div>'; return; }
        el.innerHTML = '<div class="pg">' + currentDrawings.map((d, i) =>
            '<div class="pt" onclick="openDrawingLB(' + i + ')"><img src="/drawings/' + d.relative_path + '" loading="lazy" onerror="this.parentElement.style.display=\'none\'"><div class="pl">' + (d.drawing_no || d.drawing_name || '图纸') + '</div></div>'
        ).join('') + '</div>';
    } catch (e) { el.innerHTML = '<div class="empty-tip">加载失败</div>'; }
}

async function loadIntro(code) {
    const el = document.getElementById('tcIntro');
    el.innerHTML = '<div class="empty-tip">加载中...</div>';
    try {
        const full = await (await fetch(API + '/api/relics/' + code)).json();
        el.innerHTML = full.intro ? '<div class="intro-text">' + full.intro + '</div>' : '<div class="empty-tip">暂无简介</div>';
    } catch (e) { el.innerHTML = '<div class="empty-tip">加载失败</div>'; }
}

function openPdfBox(pdfUrl, name) {
    const box = document.getElementById('pdfBox');
    const frame = document.getElementById('pdfFrame');
    document.getElementById('pdfBoxTitle').textContent = (name || '四普档案') + ' — 四普档案';
    frame.src = '/pdf-viewer?url=' + encodeURIComponent(pdfUrl) + '&name=' + encodeURIComponent(name || '四普档案');
    box.style.display = 'flex';
}

function closePdfBox() {
    const box = document.getElementById('pdfBox');
    const frame = document.getElementById('pdfFrame');
    box.style.display = 'none';
    frame.src = 'about:blank';
}

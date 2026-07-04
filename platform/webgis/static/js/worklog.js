// 工作日志查看器:台账信息 + pdf.js 自定义翻页阅读。
let _worklogData = null;
let _worklogByDate = {};

let _wlPdfDoc = null;
let _wlCurrentPage = 1;
let _wlTotalPages = 0;
let _wlRendering = false;

async function loadWorklogData() {
    if (_worklogData) return;
    try {
        const resp = await fetch(API + '/api/worklog/dates');
        _worklogData = await resp.json();
        _worklogByDate = {};
        _worklogData.items.forEach(item => {
            _worklogByDate[item.date] = item;
        });
    } catch (e) {
        console.error('[工作日志] 加载失败', e);
    }
}

function getWorklogForDate(date) {
    return _worklogByDate[date] || null;
}

function openWorklogViewer(date) {
    loadWorklogData().then(() => {
        _showWorklogPanel(date);
        _flyAndShowRoute(date);
    });
}

function _flyAndShowRoute(date) {
    if (!_surveyRouteData) return;
    const pts = _surveyRouteData[date];
    if (!pts || pts.length === 0) return;

    const hasEntities = _routeEntities.some(e => e.date === date);
    if (!hasEntities) {
        _routeVisibleDates.add(date);
        _renderOneRoute(date);
        const cb = document.querySelector('#routeDateList input[data-date="' + date + '"]');
        if (cb) cb.checked = true;
    }

    const panel = document.getElementById('worklogPanel');
    const panelOpen = panel && panel.classList.contains('open');
    flyToRoute(date, panelOpen);
}

function _showWorklogPanel(date) {
    let panel = document.getElementById('worklogPanel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'worklogPanel';
        panel.className = 'worklog-panel';
        document.body.appendChild(panel);
    }

    const info = _worklogByDate[date];
    const hasPdf = info && info.has_pdf;
    const pdfFile = info ? info.pdf_file : '';

    let ledgerHtml = '';
    if (info && (info.township || info.villages)) {
        ledgerHtml = '<div class="wl-ledger">';
        if (info.township) {
            ledgerHtml += '<div class="wl-row"><span class="wl-label">普查镇街</span><span class="wl-val">' + _escHtml(info.township) + '</span></div>';
        }
        if (info.villages) {
            ledgerHtml += '<div class="wl-row"><span class="wl-label">普查村庄</span><span class="wl-val wl-villages">' + _escHtml(info.villages) + '</span></div>';
        }
        if (info.participants) {
            ledgerHtml += '<div class="wl-row"><span class="wl-label">参加人员</span><span class="wl-val">' + _escHtml(info.participants) + '</span></div>';
        }
        if (info.review_count) {
            ledgerHtml += '<div class="wl-relic-inline"><span class="wl-relic-tag wl-stat-review">复核 <b>' + info.review_count + '</b></span>';
            if (info.review_names) ledgerHtml += _buildRelicLinks(info.review_names);
            ledgerHtml += '</div>';
        }
        if (info.new_count) {
            ledgerHtml += '<div class="wl-relic-inline"><span class="wl-relic-tag wl-stat-new">新发现线索 <b>' + info.new_count + '</b></span>';
            if (info.new_names) ledgerHtml += _buildRelicLinks(info.new_names);
            ledgerHtml += '</div>';
        }
        ledgerHtml += '</div>';
    } else {
        ledgerHtml = '<div class="wl-no-ledger">该日期无台账记录</div>';
    }

    let pdfHtml = '';
    if (hasPdf) {
        pdfHtml =
            '<div class="wl-pdf-toolbar">' +
                '<button class="wl-page-btn" id="wlPrevPage" onclick="wlPrevPage()">‹ 上一页</button>' +
                '<span class="wl-page-info" id="wlPageInfo">加载中...</span>' +
                '<button class="wl-page-btn" id="wlNextPage" onclick="wlNextPage()">下一页 ›</button>' +
            '</div>' +
            '<div class="wl-pdf-viewport" id="wlPdfViewport">' +
                '<canvas id="wlPdfCanvas"></canvas>' +
            '</div>';
    } else {
        pdfHtml = '<div class="wl-no-pdf">该日期无 PDF 工作日志</div>';
    }

    panel.innerHTML =
        '<div class="wl-header">' +
            '<div class="wl-title-group">' +
                '<h3 class="wl-title">工作日志</h3>' +
                '<span class="wl-date">' + date + '</span>' +
            '</div>' +
            '<div class="wl-nav">' +
                '<button class="wl-nav-btn" onclick="worklogNav(-1)" title="前一天">◀</button>' +
                '<button class="wl-nav-btn" onclick="worklogNav(1)" title="后一天">▶</button>' +
                '<button class="wl-close-btn" onclick="closeWorklogPanel()">✕</button>' +
            '</div>' +
        '</div>' +
        ledgerHtml +
        pdfHtml;

    panel.dataset.currentDate = date;
    panel.classList.add('open');

    if (hasPdf) {
        _loadPdf('/worklog-pdfs/' + encodeURIComponent(pdfFile));
    }
}

async function _loadPdf(url) {
    _wlPdfDoc = null;
    _wlCurrentPage = 1;
    _wlTotalPages = 0;
    _updatePageInfo();

    if (typeof pdfjsLib === 'undefined') {
        console.error('[工作日志] pdf.js 未加载');
        const info = document.getElementById('wlPageInfo');
        if (info) info.textContent = 'PDF 引擎加载失败';
        return;
    }

    try {
        const doc = await pdfjsLib.getDocument(url).promise;
        _wlPdfDoc = doc;
        _wlTotalPages = doc.numPages;
        _wlCurrentPage = 1;
        _updatePageInfo();
        _renderCurrentPage();
    } catch (e) {
        console.error('[工作日志] PDF 加载失败', e);
        const info = document.getElementById('wlPageInfo');
        if (info) info.textContent = '加载失败';
    }
}

async function _renderCurrentPage() {
    if (!_wlPdfDoc || _wlRendering) return;
    _wlRendering = true;

    try {
        const page = await _wlPdfDoc.getPage(_wlCurrentPage);
        const canvas = document.getElementById('wlPdfCanvas');
        const viewport_container = document.getElementById('wlPdfViewport');
        if (!canvas || !viewport_container) { _wlRendering = false; return; }

        const containerWidth = viewport_container.clientWidth - 16;
        const originalViewport = page.getViewport({ scale: 1 });
        const scale = containerWidth / originalViewport.width;
        const viewport = page.getViewport({ scale: scale });

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    } catch (e) {
        console.error('[工作日志] 页面渲染失败', e);
    }

    _wlRendering = false;
    _updatePageInfo();
}

function _updatePageInfo() {
    const info = document.getElementById('wlPageInfo');
    const prevBtn = document.getElementById('wlPrevPage');
    const nextBtn = document.getElementById('wlNextPage');
    if (!info) return;

    if (_wlTotalPages > 0) {
        info.textContent = _wlCurrentPage + ' / ' + _wlTotalPages;
    } else {
        info.textContent = '加载中...';
    }
    if (prevBtn) prevBtn.disabled = _wlCurrentPage <= 1;
    if (nextBtn) nextBtn.disabled = _wlCurrentPage >= _wlTotalPages;
}

function wlPrevPage() {
    if (_wlCurrentPage > 1) {
        _wlCurrentPage--;
        _renderCurrentPage();
    }
}

function wlNextPage() {
    if (_wlCurrentPage < _wlTotalPages) {
        _wlCurrentPage++;
        _renderCurrentPage();
    }
}

function closeWorklogPanel() {
    const panel = document.getElementById('worklogPanel');
    if (panel) panel.classList.remove('open');
    _wlPdfDoc = null;
}

function worklogNav(dir) {
    const panel = document.getElementById('worklogPanel');
    if (!panel || !_worklogData) return;
    const current = panel.dataset.currentDate;
    const dates = _worklogData.items.map(i => i.date);
    const idx = dates.indexOf(current);
    if (idx < 0) return;
    const newIdx = idx + dir;
    if (newIdx >= 0 && newIdx < dates.length) {
        const newDate = dates[newIdx];
        _showWorklogPanel(newDate);
        _flyAndShowRoute(newDate);
    }
}

function _escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

// 台账中的文物名模糊匹配 allRelics:命中项渲染为可点击链接,跳转到地图点位。
let _wlReturnDate = null;

function _findRelic(name) {
    if (typeof allRelics === 'undefined' || !allRelics.length) return null;
    let r = allRelics.find(x => x.name === name);
    if (!r) r = allRelics.find(x => x.name && (x.name.includes(name) || name.includes(x.name)));
    return (r && r.center_lat) ? r : null;
}

function _buildRelicLinks(namesStr) {
    const names = namesStr.split(/[、，,]/).map(s => s.trim()).filter(Boolean);
    const linked = [];
    const unlinked = [];
    names.forEach(name => {
        const safe = _escHtml(name);
        const relic = _findRelic(name);
        if (relic) {
            linked.push('<span class="wl-relic-link" onclick="_jumpToRelic(\'' +
                safe.replace(/'/g, "\\'") + '\')">' + safe + '</span>');
        } else {
            unlinked.push('<span class="wl-relic-nolink">' + safe + '</span>');
        }
    });
    return linked.concat(unlinked).join('');
}

function _jumpToRelic(name) {
    const relic = _findRelic(name);
    if (!relic) return;

    const panel = document.getElementById('worklogPanel');
    if (panel) _wlReturnDate = panel.dataset.currentDate || null;

    closeWorklogPanel();
    viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(relic.center_lng, relic.center_lat, 800),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
        duration: 1.2,
    });
    showInfo(relic);
}

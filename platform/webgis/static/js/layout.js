// 仪表盘停靠、拖拽、面板切换、全屏、全局重置。
const dashState = { dashL: { side: 'left' }, dashR: { side: 'right' } };

function _isMobile() { return window.innerWidth <= 768; }

// 窗口尺寸变化时重算停靠位置,避免拖动窗口后面板重叠。
window.addEventListener('resize', function () {
    clearTimeout(window.__layoutResizeT);
    window.__layoutResizeT = setTimeout(function () { updateLayout(); }, 120);
});

// 从 CSS 自定义属性读取像素尺寸,使 UI 尺寸切换(sm/md/lg)时面板位置同步更新。
function _cssVarPx(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
}

function updateLayout() {
    if (_isMobile()) {
        clearTimeout(updateLayout._t);
        updateLayout._t = setTimeout(() => Object.values(_charts).forEach(c => c && c.resize()), 350);
        return;
    }
    const filterOpen = document.getElementById('filterPanel').classList.contains('open');
    const infoOpen = document.getElementById('infoPanel').style.display === 'block';
    const DASH_W = _cssVarPx('--dash-w', 320);
    const DASH_GAP = 4;
    const SIDE_W = _cssVarPx('--side-w', 360);
    const INFO_W = _cssVarPx('--info-w', 420);

    const leftIds = [], rightIds = [];
    ['dashL', 'dashR'].forEach(id => {
        if (!document.getElementById(id).classList.contains('is-dragging')) {
            (dashState[id].side === 'left' ? leftIds : rightIds).push(id);
        }
    });

    let leftPos = filterOpen ? SIDE_W : 0;
    leftIds.forEach(id => {
        const el = document.getElementById(id);
        el.classList.remove('dock-l', 'dock-r');
        el.classList.add('dock-l');
        el.style.left = leftPos + 'px';
        el.style.right = '';
        leftPos += DASH_W + DASH_GAP;
    });

    let rightPos = 0;
    rightIds.forEach(id => {
        const el = document.getElementById(id);
        el.classList.remove('dock-l', 'dock-r');
        el.classList.add('dock-r');
        el.style.right = rightPos + 'px';
        el.style.left = '';
        rightPos += DASH_W + DASH_GAP;
    });

    const infoPanel = document.getElementById('infoPanel');
    if (infoOpen) {
        const infoRight = rightIds.length > 0 ? (rightPos - DASH_GAP + 14) : 14;
        infoPanel.style.right = infoRight + 'px';
    }

    const legendLeft = leftIds.length > 0 ? (leftPos - DASH_GAP + 16) : (filterOpen ? SIDE_W + 16 : 16);
    document.getElementById('legend').style.left = legendLeft + 'px';

    clearTimeout(updateLayout._t);
    updateLayout._t = setTimeout(() => Object.values(_charts).forEach(c => c && c.resize()), 350);
}

function toggleDashSide(id) {
    dashState[id].side = dashState[id].side === 'left' ? 'right' : 'left';
    updateLayout();
    setTimeout(() => Object.values(_charts).forEach(c => c && c.resize()), 350);
}

function toggleDashVis(id) {
    const el = document.getElementById(id);
    const collapsed = el.classList.toggle('collapsed');
    const btn = el.querySelector('.dh-acts button:last-child');
    if (btn) btn.textContent = collapsed ? '+' : '−';
    setTimeout(() => Object.values(_charts).forEach(c => c && c.resize()), 50);
}

function initDashDrag() {
    ['dashL', 'dashR'].forEach(id => {
        const el = document.getElementById(id);
        const hdr = el.querySelector('.dash-hdr');
        let startX, startY, origRect, dragging;

        hdr.addEventListener('pointerdown', e => {
            if (e.target.closest('.dh-acts')) return;
            e.preventDefault();
            startX = e.clientX;
            startY = e.clientY;
            origRect = el.getBoundingClientRect();
            dragging = false;

            const hint = document.getElementById('dockHint');

            function onMove(ev) {
                const dx = ev.clientX - startX, dy = ev.clientY - startY;
                if (!dragging && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
                    dragging = true;
                    el.classList.add('is-dragging');
                    el.style.position = 'fixed';
                    el.style.left = origRect.left + 'px';
                    el.style.top = origRect.top + 'px';
                    el.style.right = 'auto';
                    el.style.bottom = 'auto';
                    el.style.width = origRect.width + 'px';
                    hint.classList.add('show');
                }
                if (dragging) {
                    el.style.left = (origRect.left + dx) + 'px';
                    el.style.top = (origRect.top + dy) + 'px';
                    const side = ev.clientX < window.innerWidth / 2 ? 'left' : 'right';
                    hint.className = 'show ' + (side === 'left' ? 'hint-l' : 'hint-r');
                }
            }

            function onUp(ev) {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                hint.className = '';

                if (dragging) {
                    el.classList.remove('is-dragging');
                    el.style.position = '';
                    el.style.top = '';
                    el.style.bottom = '';
                    el.style.width = '';

                    dashState[id].side = ev.clientX < window.innerWidth / 2 ? 'left' : 'right';
                    updateLayout();
                    setTimeout(() => Object.values(_charts).forEach(c => c && c.resize()), 350);
                }
            }

            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
        });
    });
}

function togglePanel(which) {
    const fp = document.getElementById('filterPanel');
    if (which === 'filter') {
        fp.classList.toggle('open');
        document.getElementById('btnFilter').classList.toggle('on', fp.classList.contains('open'));
        updateLayout();
        if (_isMobile()) {
            _syncMobileNav(fp.classList.contains('open') ? 'filter' : 'map');
        }
    }
}

function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
}

function resetAll() {
    // "飞回主视角"必须兜底:即便清筛选/刷视口抛错,最终镜头也要落在主视角上。
    const goHome = function () {
        if (typeof flyToHome === 'function') {
            flyToHome(1.2);
        } else {
            viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(CENTER.lng, CENTER.lat, CENTER.h),
                orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
                duration: 1.2,
            });
        }
    };

    try {
        if (document.getElementById('model3dBox').classList.contains('open')) close3DBox();

        document.getElementById('filterPanel').classList.remove('open');
        document.getElementById('btnFilter').classList.remove('on');
        document.getElementById('infoPanel').style.display = 'none';

        document.getElementById('routePanel').classList.remove('open');
        document.getElementById('btnRoute').classList.remove('on');
        if (typeof routeDeselectAll === 'function') routeDeselectAll();
        if (typeof closeRoutePopup === 'function') closeRoutePopup();
        if (typeof _villageCoverageOn !== 'undefined' && _villageCoverageOn) toggleVillageCoverage();

        document.getElementById('searchInput').value = '';
        document.getElementById('filterTown').value = '';
        document.getElementById('filterLevel').value = '';
        document.getElementById('filterCond').value = '';
        document.getElementById('filter3D').value = '';
        activeCats = new Set(allRelics.map(r => r.category_main));
        document.querySelectorAll('.fp-chk').forEach(e => e.classList.add('active'));
        statFilters = {};

        if (typeof _relicPointsHidden !== 'undefined' && _relicPointsHidden) {
            document.getElementById('hideRelicToggle').checked = false;
            toggleHideRelicPoints();
        }
        activeGroup = 'category_main';
        dimColorMaps = {};

        dashState.dashL.side = 'left';
        dashState.dashR.side = 'right';
        document.querySelectorAll('.dash.collapsed').forEach(el => {
            el.classList.remove('collapsed');
            const btn = el.querySelector('.dh-acts button:last-child');
            if (btn) btn.textContent = '−';
        });

        onFilterChange();
        updateLayout();
        if (_isMobile()) mobileSetTab('map');
    } catch (e) {
        console.error('[resetAll] 清理筛选/UI 时出错,但仍会飞回主视角:', e);
    }

    // 先飞一次;若 onFilterChange 触发的视口刷新在 moveEnd 抢镜头,
    // 微任务结束后再飞一次兜底。
    goHome();
    setTimeout(goHome, 50);

    toast('已重置所有筛选和视图');
}

// 设置面板：图表开关、图表类型切换、主题、UI 尺寸、高清模式。
const _chartTypes = {};

function toggleSettings() {
    const panel = document.getElementById('settingsPanel');
    const mask = document.getElementById('settingsMask');
    const btn = document.getElementById('settingsBtn');
    const open = panel.classList.toggle('open');
    mask.classList.toggle('open', open);
    btn.classList.toggle('on', open);
    // 面板打开时才加载 shandong_admin.json(~26 KB),懒初始化主视角级联下拉。
    if (open && typeof initHomeViewUI === 'function') {
        try { initHomeViewUI(); } catch (e) {}
    }
}

const _themes = {
    blue:   { accent:'#58a6ff', accent2:'#79c0ff', bd:'rgba(88,166,255,0.2)',  bdActive:'rgba(88,166,255,0.5)',  gradient:'135deg,rgba(13,17,23,.97),rgba(22,40,65,.97)' },
    purple: { accent:'#bc8cff', accent2:'#d2a8ff', bd:'rgba(188,140,255,0.2)', bdActive:'rgba(188,140,255,0.5)', gradient:'135deg,rgba(13,17,23,.97),rgba(35,22,55,.97)' },
    gold:   { accent:'#ffd700', accent2:'#ffe566', bd:'rgba(255,215,0,0.2)',   bdActive:'rgba(255,215,0,0.5)',   gradient:'135deg,rgba(13,17,23,.97),rgba(50,40,15,.97)' },
    pink:   { accent:'#f778ba', accent2:'#ffb3d9', bd:'rgba(247,120,186,0.2)', bdActive:'rgba(247,120,186,0.5)', gradient:'135deg,rgba(13,17,23,.97),rgba(50,18,35,.97)' },
};

function setTheme(name) {
    const t = _themes[name];
    if (!t) return;
    const root = document.documentElement.style;
    root.setProperty('--accent', t.accent);
    root.setProperty('--accent2', t.accent2);
    root.setProperty('--bd', t.bd);
    root.setProperty('--bd-active', t.bdActive);
    document.getElementById('header').style.background = 'linear-gradient(' + t.gradient + ')';
    document.querySelectorAll('.sp-theme').forEach(el => el.classList.toggle('on', el.getAttribute('data-theme') === name));
    renderAllCharts(filtered);
}

function toggleChartVis(chartId, visible) {
    const chartEl = document.getElementById(chartId);
    if (!chartEl) return;
    const sec = chartEl.closest('.dash-sec');
    if (sec) sec.style.display = visible ? '' : 'none';
    if (visible && _charts[chartId]) {
        setTimeout(() => _charts[chartId].resize(), 50);
    }
}

function setChartType(chartId, dimId, type, btnEl) {
    _chartTypes[chartId] = { dimId, type };
    const row = btnEl.closest('.sp-chart-type');
    row.querySelectorAll('.sp-ct').forEach(b => b.classList.remove('on'));
    btnEl.classList.add('on');
    _renderOneChart(chartId, dimId, type, filtered);
}

function _renderOneChart(chartId, dimId, type, relics) {
    const renderers = { pie: renderPie, bar: renderHBar, vbar: renderVBar, rose: renderRose, radar: renderRadar, treemap: renderTreemap };
    (renderers[type] || renderPie)(chartId, dimId, relics);
}

function doLogout() {
    document.cookie = 'session=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    window.location.href = '/login';
}

function toggleHelp() {
    const panel = document.getElementById('helpPanel');
    const mask = document.getElementById('helpMask');
    const open = panel.classList.toggle('open');
    mask.classList.toggle('open', open);
}

function setHDMode(enabled) {
    _hdMode = !!enabled;
    try { localStorage.setItem('hdMode', _hdMode ? '1' : '0'); } catch (e) {}

    var cb = document.getElementById('hdModeToggle');
    if (cb) cb.checked = _hdMode;

    if (typeof applyHDRendering === 'function') applyHDRendering();

    _symbolCache = {};
    if (typeof onFilterChange === 'function') onFilterChange();

    var hdBoost = _hdMode ? 1.3 : 1.0;
    (bndLayers.townLabel || []).forEach(function (e) {
        if (e && e.label) {
            e.label.scale = 0.7 * hdBoost;
            e.label.outlineWidth = _hdMode ? 5 : 4;
        }
    });
    (bndLayers.villageLabel || []).forEach(function (e) {
        if (e && e.label) {
            e.label.scale = 0.6 * hdBoost;
            e.label.outlineWidth = _hdMode ? 5 : 4;
        }
    });

    if (typeof updateLegend === 'function') updateLegend();

    if (typeof toast === 'function') toast(_hdMode ? '已切换为高清模式（画面更清晰）' : '已切换为性能模式');
    viewer.scene.requestRender();
}

function setUISize(size) {
    document.querySelectorAll('.sp-size').forEach(b => {
        b.classList.toggle('on', b.getAttribute('data-size') === size);
    });
    const root = document.documentElement.style;
    if (size === 'sm') {
        root.setProperty('--hdr', '42px');
        root.setProperty('--side-w', '300px');
        root.setProperty('--dash-w', '270px');
        root.setProperty('--info-w', '370px');
        document.body.style.fontSize = '12px';
    } else if (size === 'lg') {
        root.setProperty('--hdr', '56px');
        root.setProperty('--side-w', '420px');
        root.setProperty('--dash-w', '380px');
        root.setProperty('--info-w', '480px');
        document.body.style.fontSize = '15px';
    } else {
        root.setProperty('--hdr', '50px');
        root.setProperty('--side-w', '360px');
        root.setProperty('--dash-w', '320px');
        root.setProperty('--info-w', '420px');
        document.body.style.fontSize = '13.5px';
    }
    updateLayout();
    setTimeout(() => Object.values(_charts).forEach(c => c && c.resize()), 300);
}


// 移动端底部导航。
let _mobileTab = 'map';
let _mobileStatsTab = 'dashL';

function _syncMobileNav(tab) {
    _mobileTab = tab;
    document.querySelectorAll('#mobileNav .mn-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });
}

function mobileSetTab(tab) {
    _mobileTab = tab;

    document.querySelectorAll('#mobileNav .mn-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
    });

    const body = document.body;
    body.classList.remove('m-stats-l', 'm-stats-r');
    document.getElementById('filterPanel').classList.remove('open');
    document.getElementById('btnFilter').classList.remove('on');
    document.getElementById('chatPanel').classList.remove('open');

    switch (tab) {
        case 'filter':
            document.getElementById('filterPanel').classList.add('open');
            document.getElementById('btnFilter').classList.add('on');
            break;
        case 'stats':
            body.classList.add(_mobileStatsTab === 'dashR' ? 'm-stats-r' : 'm-stats-l');
            setTimeout(() => Object.values(_charts).forEach(c => c && c.resize()), 100);
            break;
        case 'chat':
            document.getElementById('chatPanel').classList.add('open');
            if (!document.getElementById('chatMessages').children.length) {
                if (typeof appendMsg === 'function' && typeof _aiGreeting === 'function') {
                    appendMsg('ai', _aiGreeting());
                }
            }
            setTimeout(() => document.getElementById('chatInput').focus(), 100);
            break;
    }
}

function mobileStatTab(dashId, el) {
    _mobileStatsTab = dashId;
    document.body.classList.remove('m-stats-l', 'm-stats-r');
    document.body.classList.add(dashId === 'dashR' ? 'm-stats-r' : 'm-stats-l');
    document.querySelectorAll('.mst-tab').forEach(t => t.classList.remove('active'));
    if (el) el.classList.add('active');
    setTimeout(() => Object.values(_charts).forEach(c => c && c.resize()), 100);
}

function _mobileUpdateFilterBadge() {
    if (!_isMobile()) return;
    const btn = document.querySelector('#mobileNav .mn-btn[data-tab="filter"]');
    if (!btn) return;
    let badge = btn.querySelector('.mn-badge');
    const count = typeof filtered !== 'undefined' ? filtered.length : 0;
    const total = typeof allRelics !== 'undefined' ? allRelics.length : 0;
    if (count > 0 && count < total) {
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'mn-badge';
            btn.appendChild(badge);
        }
        badge.textContent = count;
    } else if (badge) {
        badge.remove();
    }
}

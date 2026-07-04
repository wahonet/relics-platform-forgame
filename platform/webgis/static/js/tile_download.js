// 离线瓦片下载模块。
// 面板流程: 范围 → 类型 → 层级 → 预估 / 下载 / 缓存管理。
// 范围来源: 地图上鼠标框选 或 山东省"市 → 县"级联。
// 后端接口: /api/tiles/area-estimate 与 /api/tiles/download-area。
(function () {
    let _bbox = null;              // { west, south, east, north }
    let _bboxLabel = null;         // 人类可读来源标签
    let _pickHandler = null;
    let _rectEntity = null;
    let _mode = 'bbox';            // 'bbox' | 'county'
    let _shandongData = null;
    let _shandongLoading = null;

    // ── 工具 ──────────────────────────────────────────
    function _fmtMB(bytes) {
        if (!bytes) return '0 MB';
        const mb = bytes / 1024 / 1024;
        if (mb >= 100) return mb.toFixed(0) + ' MB';
        if (mb >= 10) return mb.toFixed(1) + ' MB';
        return mb.toFixed(2) + ' MB';
    }

    function _renderBboxPreview() {
        const el = document.getElementById('dlBboxLine');
        if (!_bbox) {
            el.className = 'dl-bbox-preview empty';
            el.textContent = '尚未选择范围';
            return;
        }
        el.className = 'dl-bbox-preview';
        const f = n => n.toFixed(5);
        const label = _bboxLabel ? '<div style="color:var(--t1);margin-bottom:4px">📍 ' + _bboxLabel + '</div>' : '';
        el.innerHTML = label
            + '西 <b>' + f(_bbox.west) + '</b> · 南 <b>' + f(_bbox.south) + '</b><br>'
            + '东 <b>' + f(_bbox.east) + '</b> · 北 <b>' + f(_bbox.north) + '</b>';
    }

    function _selectedZooms() {
        const checks = document.querySelectorAll('#dlZoomChecks input[type=checkbox]');
        return Array.from(checks).filter(c => c.checked).map(c => c.value);
    }

    function _selectedProviders() {
        const checks = document.querySelectorAll('#dlProviderChecks input[type=checkbox]');
        return Array.from(checks).filter(c => c.checked).map(c => c.value);
    }

    function _wireChips(containerId) {
        document.querySelectorAll('#' + containerId + ' .fp-chk').forEach(lbl => {
            const cb = lbl.querySelector('input[type=checkbox]');
            lbl.addEventListener('click', function (e) {
                if (e.target !== cb) {
                    cb.checked = !cb.checked;
                }
                lbl.classList.toggle('active', cb.checked);
            });
        });
    }

    // ── 模式切换：框选 vs 县域 ──────────────────────────
    function dlSetMode(mode) {
        _mode = mode;
        document.querySelectorAll('#dlModeTabs .dl-mode-tab').forEach(function (b) {
            b.classList.toggle('on', b.dataset.mode === mode);
        });
        document.getElementById('dlModeBbox').style.display   = mode === 'bbox'   ? '' : 'none';
        document.getElementById('dlModeCounty').style.display = mode === 'county' ? '' : 'none';
        if (mode === 'county') {
            _ensureShandong().then(_populateCityDropdown).catch(function (e) {
                toast('加载山东省区县数据失败：' + e.message, true);
            });
        }
    }

    async function _ensureShandong() {
        if (_shandongData) return _shandongData;
        if (_shandongLoading) return _shandongLoading;
        _shandongLoading = fetch('/static/data/shandong_admin.json')
            .then(function (r) { return r.json(); })
            .then(function (j) { _shandongData = j; return j; });
        return _shandongLoading;
    }

    function _populateCityDropdown() {
        const sel = document.getElementById('dlCityPick');
        if (!sel || sel.dataset.filled === '1') return;
        const data = _shandongData;
        const frag = document.createDocumentFragment();
        const head = document.createElement('option');
        head.value = ''; head.textContent = '选择地级市…';
        frag.appendChild(head);
        Object.keys(data.cities).forEach(function (city) {
            const o = document.createElement('option');
            o.value = city; o.textContent = city;
            frag.appendChild(o);
        });
        sel.innerHTML = '';
        sel.appendChild(frag);
        sel.dataset.filled = '1';
    }

    function dlOnCityChange() {
        const sel = document.getElementById('dlCityPick');
        const countySel = document.getElementById('dlCountyPick');
        const city = sel.value;
        countySel.innerHTML = '';
        if (!city) {
            countySel.disabled = true;
            countySel.innerHTML = '<option value="">请先选市…</option>';
            return;
        }
        const cityData = _shandongData.cities[city];
        const frag = document.createDocumentFragment();
        // 支持"只选市"的范围。
        const head = document.createElement('option');
        head.value = '__city__'; head.textContent = '整个 ' + city;
        frag.appendChild(head);
        Object.keys(cityData.counties).forEach(function (county) {
            const o = document.createElement('option');
            o.value = county; o.textContent = county;
            frag.appendChild(o);
        });
        countySel.appendChild(frag);
        countySel.disabled = false;

        // 默认选"整个市",省一次操作。
        countySel.value = '__city__';
        dlOnCountyChange();
    }

    function dlOnCountyChange() {
        const city = document.getElementById('dlCityPick').value;
        const county = document.getElementById('dlCountyPick').value;
        if (!city || !county) return;
        const cityData = _shandongData.cities[city];
        if (!cityData) return;
        let bbox, label;
        if (county === '__city__') {
            bbox = cityData.bbox;
            label = '山东省 · ' + city;
        } else {
            bbox = cityData.counties[county];
            label = '山东省 · ' + city + ' · ' + county;
        }
        if (!bbox) return;
        _bbox = { west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3] };
        _bboxLabel = label;
        _drawRect(_bbox.west, _bbox.south, _bbox.east, _bbox.north);
        _renderBboxPreview();
    }

    // ── 主面板开关 ────────────────────────────────────
    function toggleDownloadPanel() {
        const panel = document.getElementById('downloadPanel');
        const mask = document.getElementById('downloadMask');
        const open = panel.classList.toggle('open');
        mask.classList.toggle('open', open);
        if (open) {
            _renderBboxPreview();
            if (!toggleDownloadPanel._wired) {
                _wireChips('dlZoomChecks');
                _wireChips('dlProviderChecks');
                toggleDownloadPanel._wired = true;
            }
            document.getElementById('dlEstimate').style.display = 'none';
            document.getElementById('dlProgress').style.display = 'none';
            try { dlRefreshCacheInfo(); } catch (e) {}
        } else {
            _cancelPick();
        }
    }

    // ── 矩形绘制 ──────────────────────────────────────
    function _drawRect(w, s, e, n) {
        if (_rectEntity) { try { viewer.entities.remove(_rectEntity); } catch (err) {} _rectEntity = null; }
        _rectEntity = viewer.entities.add({
            rectangle: {
                coordinates: Cesium.Rectangle.fromDegrees(w, s, e, n),
                material: Cesium.Color.fromCssColorString('#58a6ff').withAlpha(0.15),
                outline: true,
                outlineColor: Cesium.Color.fromCssColorString('#58a6ff'),
                outlineWidth: 2,
                height: 0,
            },
        });
        viewer.scene.requestRender();
    }

    function _pixelToLonLat(position) {
        const ray = viewer.camera.getPickRay(position);
        if (!ray) return null;
        const cart = viewer.scene.globe.pick(ray, viewer.scene);
        if (!cart) return null;
        const carto = Cesium.Cartographic.fromCartesian(cart);
        return {
            lng: Cesium.Math.toDegrees(carto.longitude),
            lat: Cesium.Math.toDegrees(carto.latitude),
        };
    }

    function dlStartPickBbox() {
        const panel = document.getElementById('downloadPanel');
        const mask = document.getElementById('downloadMask');
        panel.classList.remove('open');
        mask.classList.remove('open');
        document.getElementById('bboxDrawHint').classList.add('show');

        const scc = viewer.scene.screenSpaceCameraController;
        const savedLeft = scc.enableRotate;
        const savedLook = scc.enableLook;
        scc.enableRotate = false;
        scc.enableLook = false;

        _pickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        let start = null;

        _pickHandler.setInputAction(function (e) {
            start = _pixelToLonLat(e.position);
        }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

        _pickHandler.setInputAction(function (e) {
            if (!start) return;
            const cur = _pixelToLonLat(e.endPosition);
            if (!cur) return;
            const w = Math.min(start.lng, cur.lng);
            const east = Math.max(start.lng, cur.lng);
            const s = Math.min(start.lat, cur.lat);
            const n = Math.max(start.lat, cur.lat);
            _drawRect(w, s, east, n);
        }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

        _pickHandler.setInputAction(function (e) {
            if (!start) return;
            const end = _pixelToLonLat(e.position);
            scc.enableRotate = savedLeft;
            scc.enableLook = savedLook;
            try { _pickHandler.destroy(); } catch (err) {}
            _pickHandler = null;
            document.getElementById('bboxDrawHint').classList.remove('show');
            if (end) {
                const w = Math.min(start.lng, end.lng);
                const east = Math.max(start.lng, end.lng);
                const s = Math.min(start.lat, end.lat);
                const n = Math.max(start.lat, end.lat);
                if (Math.abs(east - w) > 1e-5 && Math.abs(n - s) > 1e-5) {
                    _bbox = { west: w, south: s, east: east, north: n };
                    _bboxLabel = '手动框选范围';
                    _drawRect(w, s, east, n);
                }
            }
            start = null;
            toggleDownloadPanel();
        }, Cesium.ScreenSpaceEventType.LEFT_UP);

        function onKey(ev) {
            if (ev.key === 'Escape') {
                _cancelPick();
                document.removeEventListener('keydown', onKey);
                toggleDownloadPanel();
            }
        }
        document.addEventListener('keydown', onKey);
    }

    function _cancelPick() {
        if (_pickHandler) {
            try { _pickHandler.destroy(); } catch (e) {}
            _pickHandler = null;
        }
        document.getElementById('bboxDrawHint').classList.remove('show');
        const scc = viewer.scene.screenSpaceCameraController;
        scc.enableRotate = true;
    }

    // ── 预估 ──────────────────────────────────────────
    async function dlEstimate() {
        if (!_bbox) { toast('请先选择下载范围', true); return; }
        const zs = _selectedZooms();
        const ps = _selectedProviders();
        if (!zs.length || !ps.length) { toast('请至少选择一个层级和一个瓦片类型', true); return; }
        const qs = new URLSearchParams({
            west: _bbox.west, south: _bbox.south, east: _bbox.east, north: _bbox.north,
            providers: ps.join(','), zooms: zs.join(','),
        });
        try {
            const r = await fetch('/api/tiles/area-estimate?' + qs.toString());
            const j = await r.json();
            if (j.error) { toast('预估失败：' + j.error, true); return; }
            const body = document.getElementById('dlEstimateBody');
            const mb = (j.need * 25 / 1024).toFixed(1);
            body.innerHTML =
                  '<div class="dl-stat-cell accent"><div class="lbl">总瓦片</div><div class="val">' + j.total + '</div></div>'
                + '<div class="dl-stat-cell green"><div class="lbl">已缓存</div><div class="val">' + j.cached + '</div></div>'
                + '<div class="dl-stat-cell yellow"><div class="lbl">待下载</div><div class="val">' + j.need + '</div></div>'
                + '<div class="dl-stat-cell" style="grid-column:1/-1;text-align:left">'
                + '<div class="lbl">层级 · 类型 · 预计体积</div>'
                + '<div style="font-size:12px;color:var(--t2);margin-top:2px">'
                +   'Z' + j.zooms.join(' · Z') + ' &nbsp;|&nbsp; ' + j.providers.join(' · ')
                +   ' &nbsp;|&nbsp; <b style="color:var(--accent)">≈ ' + mb + ' MB</b>'
                + '</div></div>';
            document.getElementById('dlEstimate').style.display = '';
        } catch (e) {
            toast('预估失败：' + e.message, true);
        }
    }

    // ── 下载进度 ──────────────────────────────────────
    function _renderProgress(prog, j) {
        const need = j.need || 0;
        const done = (j.downloaded || 0) + (j.failed || 0);
        const pct = need ? Math.min(100, (done / need) * 100) : 100;
        const rate = need ? ((j.downloaded || 0) / need * 100).toFixed(1) : '100.0';
        const status = j.status === 'done' ? '已完成' : (j.status === 'error' ? '失败' : '下载中');
        prog.innerHTML =
            '<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--t2);margin-bottom:4px">'
              + '<span>' + status + '：<b style="color:var(--accent)">' + (j.downloaded || 0) + '</b> / ' + need + ' 张</span>'
              + '<span>' + rate + '%</span>'
            + '</div>'
            + '<div style="height:8px;background:var(--bg3);border:1px solid var(--bd);border-radius:4px;overflow:hidden">'
              + '<div style="height:100%;width:' + pct.toFixed(1) + '%;background:linear-gradient(90deg,var(--accent),var(--green));transition:width .25s"></div>'
            + '</div>'
            + '<div style="margin-top:6px;font-size:11px;color:var(--t2);display:flex;justify-content:space-between">'
              + '<span>已下载：<b style="color:var(--green)">' + _fmtMB(j.bytes || 0) + '</b></span>'
              + '<span>失败：<b style="color:var(--red)">' + (j.failed || 0) + '</b></span>'
              + '<span>已缓存跳过：<b>' + (j.skipped || 0) + '</b></span>'
            + '</div>';
    }

    function _pollProgress(jobId, prog, btn, onDone) {
        let tries = 0;
        const iv = setInterval(async function () {
            tries++;
            try {
                const r = await fetch('/api/tiles/download-progress/' + jobId);
                const j = await r.json();
                if (j.error) {
                    prog.textContent = '失败：' + j.error;
                    clearInterval(iv);
                    btn.disabled = false; btn.textContent = '开始下载';
                    return;
                }
                _renderProgress(prog, j);
                if (j.status === 'done' || j.status === 'error') {
                    clearInterval(iv);
                    btn.disabled = false; btn.textContent = '开始下载';
                    if (j.status === 'done') {
                        toast('下载完成：' + (j.downloaded || 0) + ' 张新瓦片（' + _fmtMB(j.bytes || 0) + '）');
                        if (typeof onDone === 'function') onDone(j);
                    } else {
                        toast('下载失败：' + (j.error || '未知错误'), true);
                    }
                }
            } catch (e) {
                if (tries > 20) {
                    clearInterval(iv);
                    prog.textContent = '查询进度失败：' + e.message;
                    btn.disabled = false; btn.textContent = '开始下载';
                }
            }
        }, 1000);
    }

    async function dlStartDownload() {
        if (!_bbox) { toast('请先选择下载范围', true); return; }
        const zs = _selectedZooms();
        const ps = _selectedProviders();
        if (!zs.length || !ps.length) { toast('请至少选择一个层级和一个瓦片类型', true); return; }
        const btn = document.getElementById('dlStartBtn');
        const prog = document.getElementById('dlProgress');
        btn.disabled = true; btn.textContent = '下载中，请稍候…';
        prog.style.display = '';
        prog.innerHTML = '<div style="color:var(--t2);font-size:12px">正在提交下载任务…</div>';

        const qs = new URLSearchParams({
            west: _bbox.west, south: _bbox.south, east: _bbox.east, north: _bbox.north,
            providers: ps.join(','), zooms: zs.join(','),
        });
        // 让后端记下本次下载来源(市/县 或 手动框选),便于后台审计展示。
        if (_bboxLabel) qs.set('label', _bboxLabel);

        try {
            const r = await fetch('/api/tiles/download-area?' + qs.toString(), { method: 'POST' });
            const j = await r.json();
            if (j.error) {
                prog.textContent = '失败：' + j.error;
                btn.disabled = false; btn.textContent = '开始下载';
                return;
            }
            if (!j.need) {
                _renderProgress(prog, { status: 'done', total: j.total, skipped: j.skipped, need: 0, downloaded: 0, failed: 0, bytes: 0 });
                btn.disabled = false; btn.textContent = '开始下载';
                toast('所有瓦片都已在本地缓存');
                _refreshBaseLayerAfterDownload(ps);
                dlRefreshCacheInfo();
                return;
            }
            _renderProgress(prog, { status: 'running', total: j.total, skipped: j.skipped, need: j.need, downloaded: 0, failed: 0, bytes: 0 });
            _pollProgress(j.job_id, prog, btn, function () {
                _refreshBaseLayerAfterDownload(ps);
                dlRefreshCacheInfo();
            });
        } catch (e) {
            prog.textContent = '失败：' + e.message;
            btn.disabled = false; btn.textContent = '开始下载';
        }
    }

    function _refreshBaseLayerAfterDownload(downloadedProviders) {
        try {
            if (typeof currentBaseType !== 'undefined' && typeof switchBaseLayer === 'function'
                && downloadedProviders.indexOf(currentBaseType) !== -1) {
                switchBaseLayer(currentBaseType);
            }
        } catch (e) { console.warn('刷新底图失败', e); }
    }

    // ── 缓存状态 ──────────────────────────────────────
    async function dlRefreshCacheInfo() {
        const box = document.getElementById('dlCacheInfo');
        const pathLine = document.getElementById('dlCachePathLine');
        const hint = document.getElementById('dlCacheInfoHint');
        if (pathLine) pathLine.textContent = '';
        if (hint) hint.textContent = '查询中…';
        try {
            const r = await fetch('/api/tiles/cache-info');
            const j = await r.json();
            if (pathLine && j.cache_dir) {
                pathLine.textContent = '缓存目录：' + j.cache_dir;
            }
            const provs = j.providers || {};
            const keys = Object.keys(provs);
            if (!keys.length) {
                box.innerHTML = '<div style="grid-column:1/-1;color:var(--t3);font-size:11px;text-align:center;padding:6px">当前无缓存瓦片</div>';
                if (hint) hint.textContent = '0 张';
                return;
            }
            let total = 0, totalBytes = 0;
            const cells = keys.sort().map(function (k) {
                total += provs[k].count;
                totalBytes += provs[k].bytes;
                return '<div class="dl-cache-cell">'
                    +   '<span class="k">' + k + '</span>'
                    +   '<span class="v">' + provs[k].count + ' · ' + _fmtMB(provs[k].bytes) + '</span>'
                    + '</div>';
            }).join('');
            box.innerHTML = cells;
            if (hint) hint.textContent = total + ' 张 · ' + _fmtMB(totalBytes);
        } catch (e) {
            box.innerHTML = '<div style="grid-column:1/-1;color:var(--red);font-size:11px;text-align:center;padding:6px">查询失败：' + e.message + '</div>';
            if (hint) hint.textContent = '—';
        }
    }

    async function dlOpenCacheFolder() {
        try {
            const r = await fetch('/api/tiles/open-cache-folder', { method: 'POST' });
            const j = await r.json();
            if (j.ok) {
                toast('已在服务器本机打开：' + j.path);
            } else {
                toast('打开失败：' + (j.error || '未知错误') + '；路径：' + (j.path || ''), true);
            }
        } catch (e) {
            toast('打开失败：' + e.message, true);
        }
    }

    async function dlClearCache() {
        if (!confirm('将删除所有已下载的离线瓦片，之后"离线影像/离线矢量"会呈现为空白。是否继续？')) return;
        try {
            const r = await fetch('/api/tiles/clear-cache', { method: 'POST' });
            const j = await r.json();
            const cleared = j.cleared || {};
            const n = Object.values(cleared).reduce(function (a, b) { return a + (b > 0 ? b : 0); }, 0);
            toast('已清空 ' + n + ' 张瓦片');
            if (typeof switchBaseLayer === 'function' && typeof currentBaseType !== 'undefined') {
                switchBaseLayer(currentBaseType);
            }
            await dlRefreshCacheInfo();
        } catch (e) {
            toast('清空失败：' + e.message, true);
        }
    }

    // 暴露到全局。
    window.toggleDownloadPanel = toggleDownloadPanel;
    window.dlSetMode = dlSetMode;
    window.dlOnCityChange = dlOnCityChange;
    window.dlOnCountyChange = dlOnCountyChange;
    window.dlStartPickBbox = dlStartPickBbox;
    window.dlEstimate = dlEstimate;
    window.dlStartDownload = dlStartDownload;
    window.dlRefreshCacheInfo = dlRefreshCacheInfo;
    window.dlClearCache = dlClearCache;
    window.dlOpenCacheFolder = dlOpenCacheFolder;
})();

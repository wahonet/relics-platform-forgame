// 外业普查路线:按日期分组加载 / 上色 / 增量渲染。
// _surveyRouteData 结构: { "YYYY-MM-DD": [{filename, time, lat, lon}, ...] }
let _surveyRouteData = null;
let _routeEntities = [];
let _routeDates = [];
let _routeColorMap = {};
let _routeVisibleDates = new Set();

const _ROUTE_COLORS = [
    [244, 81, 73],  [210, 153, 34], [63, 185, 80],  [88, 166, 255],
    [188, 140, 255],[255, 123, 114],[255, 166, 87],  [126, 231, 135],
    [121, 192, 255],[165, 214, 255],[247, 120, 186], [86, 212, 221],
    [255, 215, 0],  [201, 209, 217],[255, 183, 217],
];

function _assignRouteColors(dates) {
    _routeColorMap = {};
    dates.forEach((d, i) => {
        const c = _ROUTE_COLORS[i % _ROUTE_COLORS.length];
        _routeColorMap[d] = new Cesium.Color(c[0] / 255, c[1] / 255, c[2] / 255, 1.0);
    });
}

async function loadSurveyRoutes() {
    if (_surveyRouteData) return;
    try {
        const resp = await fetch(API + '/api/survey-routes');
        _surveyRouteData = await resp.json();
        _routeDates = Object.keys(_surveyRouteData).sort();
        _assignRouteColors(_routeDates);
        _buildRouteDateList();
    } catch (e) {
        console.error('[路线] 加载失败', e);
    }
}

function _buildRouteDateList() {
    const container = document.getElementById('routeDateList');
    if (!container || !_surveyRouteData) return;
    container.innerHTML = '';

    const total = _routeDates.reduce((s, d) => s + _surveyRouteData[d].length, 0);
    const summary = document.getElementById('routeSummary');
    if (summary) summary.textContent = '共 ' + _routeDates.length + ' 天, ' + total + ' 个点位';

    _routeDates.forEach(date => {
        const c = _routeColorMap[date];
        const hex = '#' + [
            Math.round(c.red * 255).toString(16).padStart(2, '0'),
            Math.round(c.green * 255).toString(16).padStart(2, '0'),
            Math.round(c.blue * 255).toString(16).padStart(2, '0'),
        ].join('');

        const row = document.createElement('div');
        row.className = 'route-date-row';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.date = date;
        cb.addEventListener('change', function () { onRouteDateToggle(this); });

        const dot = document.createElement('span');
        dot.className = 'route-color-dot';
        dot.style.background = hex;

        const text = document.createElement('span');
        text.className = 'route-date-text';
        text.textContent = date;

        const flyBtn = document.createElement('button');
        flyBtn.className = 'route-fly-btn';
        flyBtn.title = '飞到此天路线';
        flyBtn.textContent = '⊙';
        flyBtn.addEventListener('click', function () { flyToRoute(date); });

        const logBtn = document.createElement('button');
        logBtn.className = 'route-log-btn';
        logBtn.title = '查看日志';
        logBtn.textContent = '📋';
        logBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            openWorklogViewer(date);
        });

        row.appendChild(cb);
        row.appendChild(dot);
        row.appendChild(text);
        row.appendChild(flyBtn);
        row.appendChild(logBtn);
        container.appendChild(row);
    });

    // 台账异步加载完后,在每个日期行下方追加当天经过的村庄。
    if (typeof loadWorklogData === 'function') {
        loadWorklogData().then(() => {
            _routeDates.forEach(date => {
                const info = getWorklogForDate(date);
                if (info && info.villages) {
                    const rows = container.querySelectorAll('.route-date-row');
                    rows.forEach(row => {
                        const textEl = row.querySelector('.route-date-text');
                        if (textEl && textEl.textContent.trim() === date) {
                            const existing = row.nextElementSibling;
                            if (existing && existing.classList.contains('route-village-tip')) return;
                            const tip = document.createElement('div');
                            tip.className = 'route-village-tip';
                            tip.textContent = (info.township ? info.township + ' · ' : '') + info.villages;
                            row.parentElement.insertBefore(tip, row.nextSibling);
                        }
                    });
                }
            });
        });
    }
}

function onRouteDateToggle(checkbox) {
    const date = checkbox.dataset.date;
    if (checkbox.checked) {
        _routeVisibleDates.add(date);
        _renderOneRoute(date);
    } else {
        _routeVisibleDates.delete(date);
        _removeRouteEntities(date);
    }
}

function routeSelectAll() {
    const checkboxes = document.querySelectorAll('#routeDateList input[type="checkbox"]');
    checkboxes.forEach(cb => {
        if (!cb.checked) {
            cb.checked = true;
            _routeVisibleDates.add(cb.dataset.date);
        }
    });
    clearRoutes();
    _routeVisibleDates.forEach(d => _renderOneRoute(d));
}

function routeDeselectAll() {
    const checkboxes = document.querySelectorAll('#routeDateList input[type="checkbox"]');
    checkboxes.forEach(cb => { cb.checked = false; });
    _routeVisibleDates.clear();
    clearRoutes();
}

function _renderOneRoute(date) {
    const pts = _surveyRouteData[date];
    if (!pts || pts.length === 0) return;
    const color = _routeColorMap[date];

    if (pts.length >= 2) {
        const positions = pts.map(p => Cesium.Cartesian3.fromDegrees(p.lon, p.lat));
        const lineEntity = viewer.entities.add({
            polyline: {
                positions: positions,
                width: 3,
                material: color.withAlpha(0.85),
                clampToGround: true,
            },
            properties: { _routeDate: date, _isRouteLine: true },
        });
        _routeEntities.push({ entity: lineEntity, date: date });
    }

    pts.forEach((p, idx) => {
        const pointEntity = viewer.entities.add({
            position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
            point: {
                pixelSize: 8,
                color: color,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 1.5,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            label: {
                text: p.time.substring(0, 5),
                font: '11px "Microsoft YaHei", sans-serif',
                fillColor: Cesium.Color.WHITE,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                pixelOffset: new Cesium.Cartesian2(0, -16),
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                scaleByDistance: new Cesium.NearFarScalar(500, 1.0, 20000, 0.4),
                translucencyByDistance: new Cesium.NearFarScalar(500, 1.0, 50000, 0.0),
            },
            properties: {
                _routeDate: date,
                _isRoutePoint: true,
                _routeFilename: p.filename,
                _routeTime: p.time,
                _routeIdx: idx,
                _routeLat: p.lat,
                _routeLon: p.lon,
            },
        });
        _routeEntities.push({ entity: pointEntity, date: date });
    });
}

function _removeRouteEntities(date) {
    const keep = [];
    _routeEntities.forEach(item => {
        if (item.date === date) {
            viewer.entities.remove(item.entity);
        } else {
            keep.push(item);
        }
    });
    _routeEntities = keep;
    viewer.scene.requestRender();
}

function clearRoutes() {
    _routeEntities.forEach(item => viewer.entities.remove(item.entity));
    _routeEntities = [];
    viewer.scene.requestRender();
}

function flyToRoute(date, offsetForPanel) {
    const pts = _surveyRouteData[date];
    if (!pts || pts.length === 0) return;

    let minLon = 999, maxLon = -999, minLat = 999, maxLat = -999;
    pts.forEach(p => {
        if (p.lon < minLon) minLon = p.lon;
        if (p.lon > maxLon) maxLon = p.lon;
        if (p.lat < minLat) minLat = p.lat;
        if (p.lat > maxLat) maxLat = p.lat;
    });

    const padLon = Math.max((maxLon - minLon) * 0.3, 0.005);
    const padLat = Math.max((maxLat - minLat) * 0.3, 0.005);

    let west = minLon - padLon;
    let east = maxLon + padLon;

    if (offsetForPanel) {
        // 日志面板覆盖屏幕右半时,把 bbox 向右扩一份,让路线居中在左半屏。
        const routeWidth = east - west;
        east += routeWidth;
    }

    viewer.camera.flyTo({
        destination: Cesium.Rectangle.fromDegrees(
            west, minLat - padLat,
            east, maxLat + padLat
        ),
        duration: 1.5,
    });
}

function toggleRoutePanel() {
    const panel = document.getElementById('routePanel');
    const btn = document.getElementById('btnRoute');
    const open = panel.classList.toggle('open');
    btn.classList.toggle('on', open);
    if (open && !_surveyRouteData) loadSurveyRoutes();
}

function _onRoutePointClick(props) {
    const filename = props._routeFilename;
    const time = props._routeTime;
    const date = props._routeDate;
    const lat = props._routeLat;
    const lon = props._routeLon;

    let popup = document.getElementById('routePopup');
    if (!popup) {
        popup = document.createElement('div');
        popup.id = 'routePopup';
        popup.className = 'route-popup';
        document.body.appendChild(popup);
    }

    popup.innerHTML =
        '<div class="rp-close" onclick="closeRoutePopup()">&times;</div>' +
        '<div class="rp-img-wrap"><img src="/survey-photos/' + encodeURIComponent(filename) + '" onerror="this.style.display=\'none\'"></div>' +
        '<div class="rp-info">' +
            '<div class="rp-row"><span class="rp-label">日期</span>' + date + '</div>' +
            '<div class="rp-row"><span class="rp-label">时间</span>' + time + '</div>' +
            '<div class="rp-row"><span class="rp-label">坐标</span>' + lat.toFixed(6) + ', ' + lon.toFixed(6) + '</div>' +
            '<div class="rp-row rp-filename">' + filename + '</div>' +
        '</div>';

    popup.classList.add('show');
}

function closeRoutePopup() {
    const popup = document.getElementById('routePopup');
    if (popup) popup.classList.remove('show');
}

// 村村达:按村界染色展示已到达 / 未到达,并列出未到达清单。
let _villageCoverageData = null;
let _villageCoverageEntities = [];
let _villageCoverageOn = false;

async function toggleVillageCoverage() {
    const btn = document.getElementById('btnVillageCoverage');
    if (_villageCoverageOn) {
        _clearVillageCoverage();
        _villageCoverageOn = false;
        btn.classList.remove('active');
        document.getElementById('coverageStats').style.display = 'none';
        document.getElementById('unreachedList').style.display = 'none';
        return;
    }

    _villageCoverageOn = true;
    btn.classList.add('active');

    if (!_villageCoverageData) {
        btn.textContent = '加载中...';
        try {
            const resp = await fetch(API + '/api/village-coverage');
            _villageCoverageData = await resp.json();
        } catch (e) {
            console.error('[村村达] 加载失败', e);
            btn.textContent = '村村达';
            _villageCoverageOn = false;
            btn.classList.remove('active');
            return;
        }
        btn.textContent = '村村达';
    }

    _renderVillageCoverage();
    _showCoverageStats();
}

function _renderVillageCoverage() {
    if (!_villageCoverageData || !villageGeoJSON) return;
    _clearVillageCoverage();

    const reachedSet = new Set();
    _villageCoverageData.villages.forEach(function (v, i) {
        if (v.reached) reachedSet.add(i);
    });

    const GREEN = new Cesium.Color(0.25, 0.73, 0.31, 0.35);
    const RED = new Cesium.Color(0.97, 0.32, 0.29, 0.35);
    const GREEN_LINE = new Cesium.Color(0.25, 0.73, 0.31, 0.7);
    const RED_LINE = new Cesium.Color(0.97, 0.32, 0.29, 0.7);

    villageGeoJSON.features.forEach(function (feat, i) {
        var coords = feat.geometry.coordinates;
        if (!coords || !coords[0]) return;
        var ring = coords[0];
        var positions = ring.map(function (c) { return Cesium.Cartesian3.fromDegrees(c[0], c[1]); });

        var reached = reachedSet.has(i);
        var fillColor = reached ? GREEN : RED;
        var lineColor = reached ? GREEN_LINE : RED_LINE;

        var ent = viewer.entities.add({
            polygon: {
                hierarchy: new Cesium.PolygonHierarchy(positions),
                material: fillColor,
                height: 0,
            },
        });
        _villageCoverageEntities.push(ent);

        var closed = positions.concat([positions[0]]);
        var lineEnt = viewer.entities.add({
            polyline: {
                positions: closed,
                width: 1.5,
                material: lineColor,
                clampToGround: true,
            },
        });
        _villageCoverageEntities.push(lineEnt);
    });
}

function _clearVillageCoverage() {
    _villageCoverageEntities.forEach(function (e) { viewer.entities.remove(e); });
    _villageCoverageEntities = [];
}

function _showCoverageStats() {
    if (!_villageCoverageData) return;
    var d = _villageCoverageData;
    var pct = d.total > 0 ? (d.reached / d.total * 100).toFixed(1) : '0.0';

    var statsEl = document.getElementById('coverageStats');
    statsEl.innerHTML =
        '<div class="cv-stat-row">' +
            '<span class="cv-reached">' + d.reached + '</span> / ' + d.total + ' 村已到达' +
            '<span class="cv-pct">' + pct + '%</span>' +
        '</div>' +
        '<div class="cv-bar"><div class="cv-bar-fill" style="width:' + pct + '%"></div></div>';
    statsEl.style.display = 'block';

    var unreached = d.villages.filter(function (v) { return !v.reached; });
    var listEl = document.getElementById('unreachedList');
    listEl.innerHTML = '<div class="cv-list-title">未到达村 (' + unreached.length + ')</div>';
    unreached.forEach(function (v) {
        var row = document.createElement('div');
        row.className = 'cv-village-row';
        row.innerHTML =
            '<span class="cv-village-name">' + v.name + '</span>' +
            '<span class="cv-village-town">' + v.township + '</span>';
        row.addEventListener('click', function () {
            viewer.camera.flyTo({
                destination: Cesium.Cartesian3.fromDegrees(v.center_lon, v.center_lat, 5000),
                orientation: { heading: 0, pitch: Cesium.Math.toRadians(-60), roll: 0 },
                duration: 1.2,
            });
        });
        listEl.appendChild(row);
    });
    listEl.style.display = 'block';
}

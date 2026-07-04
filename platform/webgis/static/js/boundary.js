// 行政边界图层:县 / 乡镇 / 村三级 + 标注,折线经道格拉斯-普克简化与均值平滑。
const bndLayers = { county: [], township: [], townLabel: [], village: [], villageLabel: [] };
let villageGeoJSON = null;
let townshipNames = [];

const BND_COLORS = {
    county:   { r: 255, g: 200, b: 50 },
    township: { r: 88,  g: 166, b: 255 },
    village:  { r: 63,  g: 185, b: 80 },
};

function _dpDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.sqrt((p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2);
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
    return Math.sqrt((p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2);
}

function simplifyRing(pts, eps) {
    if (pts.length <= 4) return pts;
    let maxD = 0, idx = 0;
    for (let i = 1; i < pts.length - 1; i++) {
        const d = _dpDist(pts[i], pts[0], pts[pts.length - 1]);
        if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps) {
        const left = simplifyRing(pts.slice(0, idx + 1), eps);
        const right = simplifyRing(pts.slice(idx), eps);
        return left.slice(0, -1).concat(right);
    }
    return [pts[0], pts[pts.length - 1]];
}

function smoothRing(pts, iterations) {
    let cur = pts;
    for (let n = 0; n < iterations; n++) {
        const next = [cur[0]];
        for (let i = 1; i < cur.length - 1; i++) {
            next.push([
                cur[i - 1][0] * 0.25 + cur[i][0] * 0.5 + cur[i + 1][0] * 0.25,
                cur[i - 1][1] * 0.25 + cur[i][1] * 0.5 + cur[i + 1][1] * 0.25
            ]);
        }
        next.push(cur[cur.length - 1]);
        cur = next;
    }
    return cur;
}

function prepareRing(ring, type) {
    if (type === 'village') return ring;
    const eps = type === 'county' ? 0.0001 : 0.00015;
    const iters = type === 'county' ? 3 : 2;
    return smoothRing(simplifyRing(ring, eps), iters);
}

const BND_LINE_W = 2.5;
const BND_FILL_A = 0.10;

function addBoundaryEntities(ring, type, bndName) {
    const w = BND_LINE_W;
    const a = BND_FILL_A;
    const c = BND_COLORS[type];
    const lineAlpha = type === 'county' ? 0.9 : (type === 'township' ? 0.7 : 0.6);
    const lineW = type === 'county' ? w * 1.3 : w;

    const smoothed = prepareRing(ring, type);
    const positions = smoothed.map(pt => Cesium.Cartesian3.fromDegrees(pt[0], pt[1]));
    const fillOpts = {
        polygon: {
            hierarchy: new Cesium.PolygonHierarchy(positions),
            material: type === 'county'
                ? Cesium.Color.TRANSPARENT
                : new Cesium.Color(c.r / 255, c.g / 255, c.b / 255, a),
            height: 0,
        },
    };
    if (bndName) fillOpts.properties = { _boundaryType: type, _boundaryName: bndName };
    const fill = viewer.entities.add(fillOpts);
    const closed = [...positions, positions[0]];
    const line = viewer.entities.add({
        polyline: {
            positions: closed,
            width: lineW,
            material: new Cesium.Color(c.r / 255, c.g / 255, c.b / 255, lineAlpha),
            clampToGround: true,
        },
    });
    return { fill, line, type };
}

function addLabelEntity(lng, lat, text, style) {
    var baseScale = style.scale || 0.75;
    var hdBoost = _hdMode ? 1.3 : 1.0;
    return viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lng, lat),
        label: {
            text,
            font: style.font || 'bold 18px "Microsoft YaHei", sans-serif',
            fillColor: style.color || Cesium.Color.fromCssColorString('rgba(255,200,50,0.95)'),
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: _hdMode ? 5 : 4,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, style.maxDist || 80000),
            scale: baseScale * hdBoost,
        },
    });
}

function ringCenter(ring) {
    const lngs = ring.map(c => c[0]), lats = ring.map(c => c[1]);
    return [(Math.min(...lngs) + Math.max(...lngs)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];
}

async function loadBoundaries() {
    try {
        const [countyRes, townRes, villageRes] = await Promise.all([
            fetch('/boundaries/county.geojson'),
            fetch('/boundaries/townships.geojson'),
            fetch('/boundaries/villages.geojson'),
        ]);

        if (countyRes.ok) {
            const county = await countyRes.json();
            county.features.forEach(f => {
                f.geometry.coordinates.forEach(ring => {
                    bndLayers.county.push(addBoundaryEntities(ring, 'county'));
                });
            });
        }

        if (townRes.ok) {
            const towns = await townRes.json();
            const namesSet = new Set();
            towns.features.forEach(f => {
                const name = f.properties.XZQMC || f.properties._township_name || '';
                if (name) namesSet.add(name);
                f.geometry.coordinates.forEach(ring => {
                    bndLayers.township.push(addBoundaryEntities(ring, 'township', name));
                    if (name) {
                        const [cx, cy] = ringCenter(ring);
                        bndLayers.townLabel.push(addLabelEntity(cx, cy, name, {
                            color: Cesium.Color.fromCssColorString('rgba(255,200,50,0.95)'),
                            font: 'bold 20px "Microsoft YaHei", sans-serif', maxDist: 80000, scale: 0.7,
                        }));
                    }
                });
            });
            townshipNames = [...namesSet].sort();
        }

        if (villageRes.ok) {
            villageGeoJSON = await villageRes.json();
        }

        document.getElementById('btnBoundary').classList.add('on');
    } catch (e) { console.warn('边界加载:', e); }
}

function renderVillages() {
    bndLayers.village.forEach(item => {
        viewer.entities.remove(item.fill);
        viewer.entities.remove(item.line);
    });
    bndLayers.village = [];

    if (!villageGeoJSON) return;

    villageGeoJSON.features.forEach(f => {
        const name = f.properties.ZLDWMC || '';
        f.geometry.coordinates.forEach(ring => {
            bndLayers.village.push(addBoundaryEntities(ring, 'village', name));
        });
    });
}

let _bndCounty = true, _bndTownship = true, _bndVillage = false, _bndVillageName = false;

function _ensureVillageNameLabels() {
    if (bndLayers.villageLabel.length > 0) return;
    if (!villageGeoJSON) return;
    villageGeoJSON.features.forEach(f => {
        const name = f.properties.ZLDWMC || '';
        if (!name) return;
        const coords = f.geometry.coordinates;
        if (!coords || !coords.length) return;
        const [cx, cy] = ringCenter(coords[0]);
        bndLayers.villageLabel.push(addLabelEntity(cx, cy, name, {
            color: Cesium.Color.WHITE,
            font: '14px "Microsoft YaHei", sans-serif',
            maxDist: 30000,
            scale: 0.6,
        }));
    });
}

function updateBoundaryLayers() {
    _bndCounty = document.getElementById('bndCounty').checked;
    _bndTownship = document.getElementById('bndTownship').checked;
    _bndVillage = document.getElementById('bndVillage').checked;
    _bndVillageName = document.getElementById('bndVillageName').checked;

    bndLayers.county.forEach(function (item) { item.fill.show = _bndCounty; item.line.show = _bndCounty; });
    bndLayers.township.forEach(function (item) { item.fill.show = _bndTownship; item.line.show = _bndTownship; });
    bndLayers.townLabel.forEach(function (e) { e.show = _bndTownship; });

    if (_bndVillage && bndLayers.village.length === 0) {
        renderVillages();
    }
    bndLayers.village.forEach(function (item) { item.fill.show = _bndVillage; item.line.show = _bndVillage; });

    if (_bndVillageName) _ensureVillageNameLabels();
    bndLayers.villageLabel.forEach(function (e) { e.show = _bndVillageName; });

    var anyOn = _bndCounty || _bndTownship || _bndVillage || _bndVillageName;
    document.getElementById('btnBoundary').classList.toggle('on', anyOn);
    viewer.scene.requestRender();
}

function toggleBoundaryMenu() {
    var menu = document.getElementById('boundaryMenu');
    menu.classList.toggle('open');
    document.getElementById('btnBoundary').classList.toggle('on', menu.classList.contains('open') || _bndCounty || _bndTownship || _bndVillage);
    if (menu.classList.contains('open')) {
        var btn = document.getElementById('btnBoundary');
        var rect = btn.getBoundingClientRect();
        menu.style.top = (rect.bottom + 4) + 'px';
        menu.style.left = rect.left + 'px';
    }
}

// 底图/影像菜单:早期顶栏使用 <select> + 外挂滑块,现统一收进下拉菜单。
function toggleBaseLayerMenu() {
    var menu = document.getElementById('baseLayerMenu');
    var btn = document.getElementById('btnBaseLayer');
    menu.classList.toggle('open');
    btn.classList.toggle('on', menu.classList.contains('open'));
    if (menu.classList.contains('open')) {
        var rect = btn.getBoundingClientRect();
        menu.style.top = (rect.bottom + 4) + 'px';
        menu.style.left = rect.left + 'px';
    }
}

function pickBaseLayer(val, label) {
    if (typeof switchBaseLayer === 'function') switchBaseLayer(val);
    var txt = document.getElementById('btnBaseLayerText');
    if (txt && label) txt.textContent = label;
    var menu = document.getElementById('baseLayerMenu');
    if (menu) menu.classList.remove('open');
    var btn = document.getElementById('btnBaseLayer');
    if (btn) btn.classList.remove('on');
}

function toggleLabelMenu() {
    var menu = document.getElementById('labelMenu');
    menu.classList.toggle('open');
    document.getElementById('btnLabel').classList.toggle('on', menu.classList.contains('open'));
    if (menu.classList.contains('open')) {
        var btn = document.getElementById('btnLabel');
        var rect = btn.getBoundingClientRect();
        menu.style.top = (rect.bottom + 4) + 'px';
        menu.style.left = rect.left + 'px';
    }
}

document.addEventListener('click', function (e) {
    var lm = document.getElementById('labelMenu');
    var lb = document.getElementById('btnLabel');
    if (lm && lm.classList.contains('open') && !lm.contains(e.target) && !lb.contains(e.target)) {
        lm.classList.remove('open');
        lb.classList.remove('on');
    }
    var bm = document.getElementById('boundaryMenu');
    var bb = document.getElementById('btnBoundary');
    if (bm && bm.classList.contains('open') && !bm.contains(e.target) && !bb.contains(e.target)) {
        bm.classList.remove('open');
    }
    var blm = document.getElementById('baseLayerMenu');
    var blb = document.getElementById('btnBaseLayer');
    if (blm && blm.classList.contains('open') && !blm.contains(e.target) && !blb.contains(e.target)) {
        blm.classList.remove('open');
        if (blb) blb.classList.remove('on');
    }
});

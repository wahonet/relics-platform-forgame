// 点位符号、颜色映射、面图层渲染。符号 / 图例图标由 Canvas 动态生成并缓存。
function buildColorMap(relics, dim) {
    const counts = {};
    relics.forEach(r => { dimValues(r, dim).forEach(v => { counts[v] = (counts[v]||0)+1; }); });
    let keys = dim.order ? dim.order.filter(k => counts[k]) : Object.keys(counts).sort((a,b) => (counts[b]||0)-(counts[a]||0));
    const map = {};
    keys.forEach((k,i) => { map[k] = PALETTE[i % PALETTE.length]; });
    return map;
}

function getPointColor(r) {
    const dim = DIMS.find(d => d.id === activeGroup);
    if (!dim) return DEF_COLOR;
    const v = dimValue(r, dim);
    const cm = dimColorMaps[activeGroup];
    return (cm && cm[v]) || DEF_COLOR;
}

const CATEGORY_ICONS = {
    '古建筑': '/static/古建筑.png',
    '古墓葬': '/static/古墓葬.png',
    '古遗址': '/static/古文化遗址.png',
    '古文化遗址': '/static/古文化遗址.png',
    '石窟寺及石刻': '/static/石窟寺及石刻.png',
    '近现代重要史迹及代表性建筑': '/static/近现代重要史迹及代表性建筑.png',
    '近现代史迹': '/static/近现代重要史迹及代表性建筑.png',
};
const _catImgs = {};
let _symbolCache = {};
let _symbolMode = true;
let _showTextLabels = true;
let _labelFontSize = 14;
let _labelFontFamily = '"Microsoft YaHei", sans-serif';

// 图标异步 decode,首次 updateLegend() 很可能早于图标 onload,导致条目退化
// 为纯色圆点。每次 onload 都清一次符号缓存并重绘图例,确保 PNG 覆盖生效。
(function preloadCategoryIcons() {
    let pending = Object.keys(CATEGORY_ICONS).length;
    function _rerenderOnReady() {
        try { _symbolCache = {}; } catch (e) {}
        try { if (typeof updateLegend === 'function') updateLegend(); } catch (e) {}
        try {
            if (typeof onFilterChange === 'function' && typeof filtered !== 'undefined' && filtered) {
                onFilterChange();
            }
        } catch (e) {}
    }
    for (const [cat, url] of Object.entries(CATEGORY_ICONS)) {
        const img = new Image();
        // 同源 /static 不设 CORS,避免部分静态服务把图片当作 taint 丢弃。
        img.onload = () => {
            _catImgs[cat] = img;
            pending--;
            // 每次 onload 都刷一次,避免最后一个图标失败导致整体卡住。
            _rerenderOnReady();
        };
        img.onerror = () => {
            pending--;
            console.warn('[icon] 预加载失败:', cat, url);
        };
        img.src = url;
    }
})();

function _hiDpiCanvas(size) {
    const S = size;
    const canvas = document.createElement('canvas');
    canvas.width = S; canvas.height = S;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return { canvas, ctx, S, logical: size };
}

function makeSymbolIcon(category, color, has3d) {
    const key = category + '|' + color + '|' + (has3d ? '1' : '0') + '|' + (_hdMode ? 'hd' : 'std');
    if (_symbolCache[key]) return _symbolCache[key];

    const L = _hdMode ? 128 : 64;
    const { canvas, ctx } = _hiDpiCanvas(L);
    const r = L / 2;
    const bw = 3;

    const bwScaled = bw * (L / 64);
    ctx.beginPath();
    ctx.arc(r, r, r - bwScaled, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = bwScaled;
    ctx.strokeStyle = has3d ? '#ffd700' : '#222';
    ctx.stroke();

    const img = _catImgs[category];
    if (img) {
        const tmpC = document.createElement('canvas');
        tmpC.width = L; tmpC.height = L;
        const tc = tmpC.getContext('2d');
        tc.imageSmoothingEnabled = true;
        tc.imageSmoothingQuality = 'high';
        const iconS = L * 0.56;
        const off = (L - iconS) / 2;
        tc.drawImage(img, off, off, iconS, iconS);
        tc.globalCompositeOperation = 'source-in';
        tc.fillStyle = 'rgba(255,255,255,0.92)';
        tc.fillRect(0, 0, L, L);
        ctx.drawImage(tmpC, 0, 0);
    }

    const url = canvas.toDataURL();
    _symbolCache[key] = url;
    return url;
}

function makeLegendIcon(category, color) {
    const L = _hdMode ? 64 : 32;
    const { canvas, ctx } = _hiDpiCanvas(L);
    const r = L / 2;
    ctx.beginPath();
    ctx.arc(r, r, r - 1, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.stroke();
    const img = _catImgs[category];
    if (img) {
        const tmpC = document.createElement('canvas');
        tmpC.width = L; tmpC.height = L;
        const tc = tmpC.getContext('2d');
        tc.imageSmoothingEnabled = true;
        tc.imageSmoothingQuality = 'high';
        const iconS = L * 0.58;
        const off = (L - iconS) / 2;
        tc.drawImage(img, off, off, iconS, iconS);
        tc.globalCompositeOperation = 'source-in';
        tc.fillStyle = 'rgba(255,255,255,0.9)';
        tc.fillRect(0, 0, L, L);
        ctx.drawImage(tmpC, 0, 0);
    }
    return canvas.toDataURL();
}

let _relicPointsHidden = false;

// 下列开关同时作用于新渲染器(pointRenderer)与旧 entityMap(兼容期保留)。
function toggleHideRelicPoints() {
    _relicPointsHidden = document.getElementById('hideRelicToggle').checked;
    const show = !_relicPointsHidden;
    if (window.pointRenderer)  window.pointRenderer.setVisible(show);
    if (window.polygonRenderer) window.polygonRenderer.setVisible(show);
    Object.values(entityMap).forEach(function (e) { e.show = show; });
    polygonEntities.forEach(function (e) { e.show = show; });
    viewer.scene.requestRender();
}

function toggleNonSymbolize() {
    _symbolMode = !document.getElementById('nonSymbolToggle').checked;
    _symbolCache = {};
    onFilterChange();
}

function toggleTextLabels() {
    _showTextLabels = document.getElementById('textLabelToggle').checked;
    if (window.pointRenderer) window.pointRenderer.setLabelsEnabled(_showTextLabels);
    Object.values(entityMap).forEach(function (e) {
        if (e.label) e.label.show = _showTextLabels;
    });
    viewer.scene.requestRender();
}

function setLabelSize(val) {
    _labelFontSize = parseInt(val);
    document.getElementById('labelSizeVal').textContent = val + 'px';
    if (window.pointRenderer) window.pointRenderer.setLabelSize(_labelFontSize);
    var font = _labelFontSize + 'px ' + _labelFontFamily;
    Object.values(entityMap).forEach(function (e) {
        if (e.label) e.label.font = font;
    });
    viewer.scene.requestRender();
}

function setLabelFont(val) {
    _labelFontFamily = val;
    document.getElementById('labelFontSel').value = val;
    if (window.pointRenderer) window.pointRenderer.setLabelFont(val);
    var font = _labelFontSize + 'px ' + _labelFontFamily;
    Object.values(entityMap).forEach(function (e) {
        if (e.label) e.label.font = font;
    });
    viewer.scene.requestRender();
}

function _makePointCanvas(color, outlineColor, outlineW, sz) {
    const key = 'pt|' + color + '|' + outlineColor + '|' + outlineW + '|' + sz + '|' + (_hdMode ? 'hd' : 'std');
    if (_symbolCache[key]) return _symbolCache[key];
    const L = _hdMode ? 64 : 32;
    const { canvas, ctx } = _hiDpiCanvas(L);
    const r = L / 2;
    const oScale = L / 32;
    ctx.beginPath();
    ctx.arc(r, r, r - outlineW * 2 * oScale, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    if (outlineW > 0) {
        ctx.lineWidth = outlineW * 2 * oScale;
        ctx.strokeStyle = outlineColor;
        ctx.stroke();
    }
    const url = canvas.toDataURL();
    _symbolCache[key] = url;
    return url;
}

// 旧的"每点一 Entity"渲染已废弃。兼容 fallback:当 viewport 尚未启动时,
// 把筛选后的 relics 适配为 8 字段格式喂入 pointRenderer。
function renderPoints(relics) {
    if (!window.pointRenderer) return;
    const list = (relics || []).map(r => ({
        id: r.archive_code,
        code: r.archive_code,
        name: r.name,
        lng: r.center_lng,
        lat: r.center_lat,
        category: window.Dict.categoryCode(r.category_main),
        rank: window.Dict.rankCode(r.heritage_level),
        has_3d: !!r.has_3d,
    }));
    window.pointRenderer.diffUpdate(list);
}

async function loadPolygons() {
    try {
        const geojson = await (await fetch(API + '/api/geojson/polygons')).json();
        if (!window.polygonRenderer && window.PolygonRenderer) {
            window.polygonRenderer = new PolygonRenderer(viewer);
        }
        const colorFn = (code) => {
            const relic = allRelics.find(r => r.archive_code === code);
            return relic ? getPointColor(relic) : DEF_COLOR;
        };
        if (window.polygonRenderer) {
            window.polygonRenderer.render(geojson.features || [], colorFn);
        } else {
            // PolygonRenderer 缺失时回退到旧的 Entity 实现。
            (geojson.features || []).forEach(f => {
                const coords = f.geometry.coordinates[0];
                const cc = Cesium.Color.fromCssColorString(colorFn(f.properties.archive_code));
                const pos = []; coords.forEach(c => pos.push(c[0], c[1]));
                polygonEntities.push(viewer.entities.add({
                    polygon: { hierarchy: Cesium.Cartesian3.fromDegreesArray(pos), material: cc.withAlpha(0.28), outline: true, outlineColor: cc.withAlpha(0.7), outlineWidth: 1, height: 0 },
                }));
            });
        }
    } catch (e) { console.error('面图层:', e); }
}

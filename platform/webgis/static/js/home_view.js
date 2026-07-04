// 主视角 (Home View) 管理。
//
// - 记录一个可持久化的默认视角,重置按钮 / 初始飞行都回到这里
// - 设置面板内置"地级市 → 区县"级联下拉(数据源 /static/data/shandong_admin.json)
// - 也支持把当前视角一键固化为主视角
//
// 持久化: localStorage['relics.homeView'] = { city, county, lng, lat, h, label }
// 缺省: 回退到 config.js 的 CENTER (即后端 config.yaml 的 geo.center)。
(function () {
    const LS_KEY = 'relics.homeView';
    let _shandong = null;
    let _loadingPromise = null;

    function _ensureShandong() {
        if (_shandong) return Promise.resolve(_shandong);
        if (_loadingPromise) return _loadingPromise;
        // 时间戳 cache-buster:防止浏览器把旧版本或 404 结果缓存住。
        const url = '/static/data/shandong_admin.json?t=' + Date.now();
        _loadingPromise = fetch(url, { cache: 'no-store' })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + r.statusText);
                return r.json();
            })
            .then(function (j) {
                if (!j || !j.cities) throw new Error('JSON 缺少 cities 字段');
                _shandong = j;
                console.log('[home_view] 已加载山东省区县数据:', Object.keys(j.cities).length, '市');
                return j;
            })
            .catch(function (err) {
                // 允许下次重试,避免一次瞬时失败就永久卡死。
                _loadingPromise = null;
                console.error('[home_view] 加载 shandong_admin.json 失败:', err);
                throw err;
            });
        return _loadingPromise;
    }

    function _defaultHome() {
        return {
            city: '', county: '',
            lng: CENTER.lng, lat: CENTER.lat, h: CENTER.h,
            label: '配置默认位置',
            isDefault: true,
        };
    }

    function getHomeView() {
        try {
            const raw = localStorage.getItem(LS_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (typeof parsed.lng === 'number' && typeof parsed.lat === 'number') {
                    return Object.assign({ city: '', county: '', label: '' }, parsed, { isDefault: false });
                }
            }
        } catch (e) {}
        return _defaultHome();
    }

    function setHomeView(view) {
        try {
            const persisted = {
                city: view.city || '',
                county: view.county || '',
                lng: view.lng, lat: view.lat, h: view.h,
                label: view.label || '',
            };
            localStorage.setItem(LS_KEY, JSON.stringify(persisted));
        } catch (e) {}
        _refreshHomeIndicator();
    }

    function clearHomeView() {
        try { localStorage.removeItem(LS_KEY); } catch (e) {}
        _refreshHomeIndicator();
    }

    // 按 bbox 对角线长度推算俯视高度。
    // Cesium 默认 fov=60°,视口水平宽度 ≈ h · 2 · tan(fov/2),
    // 取 ~0.95 · 对角线可恰好贴边;范围钳在 15 km ~ 300 km 之间。
    function _altitudeFromBbox(bbox) {
        const w = bbox[0], s = bbox[1], e = bbox[2], n = bbox[3];
        const midLat = (n + s) / 2;
        const dLng = Math.abs(e - w);
        const dLat = Math.abs(n - s);
        const diagDeg = Math.sqrt(Math.pow(dLng * Math.cos(midLat * Math.PI / 180), 2) + dLat * dLat);
        const diagM = diagDeg * 111000;
        return Math.max(15000, Math.min(300000, diagM * 0.95));
    }

    function flyToHome(duration) {
        if (typeof duration !== 'number') duration = 1.0;
        const hv = getHomeView();
        viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(hv.lng, hv.lat, hv.h),
            orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
            duration: duration,
        });
    }

    // ── 设置面板 UI ──────────────────────────────────
    function _refreshHomeIndicator() {
        const el = document.getElementById('hvCurrent');
        if (!el) return;
        const hv = getHomeView();
        const tag = hv.isDefault
            ? '<span style="color:var(--t3);font-size:11px">(默认)</span>'
            : '<span style="color:var(--green);font-size:11px">(已自定义)</span>';
        el.innerHTML = '<b style="color:var(--accent)">' + (hv.label || '未命名') + '</b>'
            + ' <span style="color:var(--t3);font-size:11px">· '
            + hv.lng.toFixed(3) + ', ' + hv.lat.toFixed(3)
            + ' · ' + Math.round(hv.h / 1000) + 'km</span> '
            + tag;
    }

    function _populateCityDropdown(citySel, data) {
        const frag = document.createDocumentFragment();
        const head = document.createElement('option');
        head.value = ''; head.textContent = '选择地级市…';
        frag.appendChild(head);
        Object.keys(data.cities).forEach(function (city) {
            const o = document.createElement('option');
            o.value = city; o.textContent = city;
            frag.appendChild(o);
        });
        citySel.innerHTML = '';
        citySel.appendChild(frag);
        citySel.dataset.filled = '1';
    }

    async function initHomeViewUI() {
        const citySel = document.getElementById('hvCityPick');
        if (!citySel) return;
        _refreshHomeIndicator();
        // 已填充过则跳过;否则重新拉取(不受上次失败影响)。
        if (citySel.dataset.filled === '1') {
            return;
        }
        try {
            const data = await _ensureShandong();
            _populateCityDropdown(citySel, data);

            // 回填上次选择。
            const hv = getHomeView();
            if (hv.city && data.cities[hv.city]) {
                citySel.value = hv.city;
                onHvCityChange();
                const countySel = document.getElementById('hvCountyPick');
                if (countySel && hv.county) {
                    countySel.value = hv.county;
                } else if (countySel) {
                    countySel.value = '__city__';
                }
            }
        } catch (e) {
            // toast 未就绪时 fallback 到 alert,保证用户可见。
            const msg = '加载山东省区县数据失败:' + (e && e.message ? e.message : e);
            if (typeof toast === 'function') {
                toast(msg, true);
            } else {
                alert(msg);
            }
            citySel.innerHTML = '<option value="">(加载失败,请刷新页面)</option>';
        }
    }

    // 页面就绪后预热一次,首次打开设置面板即可直接看到下拉项。
    function _preloadOnReady() {
        const run = function () {
            _ensureShandong().then(function (data) {
                const citySel = document.getElementById('hvCityPick');
                if (citySel && citySel.dataset.filled !== '1') {
                    _populateCityDropdown(citySel, data);
                }
                _refreshHomeIndicator();
            }).catch(function () { /* initHomeViewUI 会在打开面板时重试并提示 */ });
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', run, { once: true });
        } else {
            run();
        }
    }
    _preloadOnReady();

    // 当前两级下拉 → 可落地的 home view;无有效选择返回 null。
    function _pickToView() {
        if (!_shandong) return null;
        const citySel = document.getElementById('hvCityPick');
        const countySel = document.getElementById('hvCountyPick');
        if (!citySel) return null;
        const city = citySel.value;
        if (!city) return null;
        const cityData = _shandong.cities[city];
        if (!cityData) return null;
        const county = countySel ? countySel.value : '';
        let bbox, label, countyKey;
        if (!county || county === '__city__') {
            bbox = cityData.bbox; label = '山东省 · ' + city; countyKey = '';
        } else {
            bbox = cityData.counties[county];
            if (!bbox) return null;
            label = '山东省 · ' + city + ' · ' + county; countyKey = county;
        }
        return {
            city: city, county: countyKey,
            lng: (bbox[0] + bbox[2]) / 2,
            lat: (bbox[1] + bbox[3]) / 2,
            h: _altitudeFromBbox(bbox),
            label: label,
        };
    }

    // 下拉变更即落盘,避免用户漏点"应用"导致重置仍回旧位置。
    // 按钮只负责"顺便飞过去",保存由本函数自动完成。
    function _autoSaveFromPick() {
        const v = _pickToView();
        if (!v) return;
        setHomeView(v);
    }

    function onHvCityChange() {
        const citySel = document.getElementById('hvCityPick');
        const countySel = document.getElementById('hvCountyPick');
        if (!citySel || !countySel || !_shandong) return;
        const city = citySel.value;
        countySel.innerHTML = '';
        if (!city) {
            countySel.disabled = true;
            const o = document.createElement('option');
            o.value = ''; o.textContent = '请先选市…';
            countySel.appendChild(o);
            return;
        }
        countySel.disabled = false;
        const cityData = _shandong.cities[city];
        const headOpt = document.createElement('option');
        headOpt.value = '__city__'; headOpt.textContent = '整个 ' + city;
        countySel.appendChild(headOpt);
        Object.keys(cityData.counties).forEach(function (county) {
            const o = document.createElement('option');
            o.value = county; o.textContent = county;
            countySel.appendChild(o);
        });
        countySel.value = '__city__';
        _autoSaveFromPick();
    }

    function onHvCountyChange() {
        _autoSaveFromPick();
    }

    function applyHomeViewFromPick() {
        if (!_shandong) { toast('区县数据尚未加载完毕', true); return; }
        const v = _pickToView();
        if (!v) { toast('请先选择地级市', true); return; }
        setHomeView(v);
        flyToHome();
        toast('已设为主视角：' + v.label);
    }

    function applyHomeViewFromCurrent() {
        const pos = viewer.camera.positionCartographic;
        const lng = Cesium.Math.toDegrees(pos.longitude);
        const lat = Cesium.Math.toDegrees(pos.latitude);
        const h = pos.height;
        const label = '当前视角 (' + lng.toFixed(3) + ', ' + lat.toFixed(3) + ')';
        setHomeView({ city: '', county: '', lng: lng, lat: lat, h: h, label: label });
        toast('已用当前视角作为主视角');
    }

    function resetHomeView() {
        clearHomeView();
        toast('已恢复为默认主视角');
    }

    // 暴露给 HTML onclick / layout.js / map.js。
    window.getHomeView = getHomeView;
    window.setHomeView = setHomeView;
    window.flyToHome = flyToHome;
    window.initHomeViewUI = initHomeViewUI;
    window.onHvCityChange = onHvCityChange;
    window.onHvCountyChange = onHvCountyChange;
    window.applyHomeViewFromPick = applyHomeViewFromPick;
    window.applyHomeViewFromCurrent = applyHomeViewFromCurrent;
    window.resetHomeView = resetHomeView;
})();

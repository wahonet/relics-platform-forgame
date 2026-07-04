// 主图 ↔ 后台管理(/admin-ui/)联动:URL 参数与拾点模式。
//
// URL 参数:
//   ?relic=<code>         启动后 flyTo + showInfo 到该文物
//   ?pick=1               进入拾点,单击地图后 postMessage 回传经纬度
//   ?pick=1&code=<code>   携带 code,表示给该文物选坐标
//
// postMessage 协议(targetOrigin = opener origin):
//   { type: 'relic-pick', lng, lat, alt, code }
//   { type: 'relic-pick-cancel' }
//
// 由 app.js init() 结束后调用 PickMode.handleUrlParams()。
(function () {
    'use strict';

    const STATE = {
        enabled: false,
        code: null,
        handler: null,
        banner: null,
        prevCursor: null,
    };

    function _canvas() {
        return (window.viewer && viewer.scene && viewer.scene.canvas) || null;
    }

    // 顶部横幅,提示当前处于拾点模式。
    function _mountBanner() {
        if (STATE.banner) return;
        const b = document.createElement('div');
        b.id = 'pickModeBanner';
        b.style.cssText = [
            'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
            'padding:10px 16px', 'background:linear-gradient(90deg,#b45309,#d97706)',
            'color:#fff', 'font-size:14px', 'font-weight:600',
            'display:flex', 'align-items:center', 'justify-content:center', 'gap:12px',
            'box-shadow:0 2px 8px rgba(0,0,0,.4)',
            'font-family:system-ui,-apple-system,Segoe UI,sans-serif',
        ].join(';');
        const label = STATE.code
            ? `拾取坐标模式 · 当前文物 ${STATE.code}`
            : '拾取坐标模式 · 新建文物';
        b.innerHTML = `
            <span>📍 ${label}</span>
            <span style="opacity:.85;font-weight:400">单击地图任意位置拾取经纬度；ESC 或点右侧按钮取消</span>
            <button id="pickCancelBtn" style="margin-left:8px;padding:4px 12px;background:rgba(0,0,0,.3);color:#fff;border:1px solid rgba(255,255,255,.4);border-radius:4px;cursor:pointer;font-size:12px">取消</button>
        `;
        document.body.appendChild(b);
        b.querySelector('#pickCancelBtn').addEventListener('click', cancel);
        STATE.banner = b;
    }

    function _unmountBanner() {
        if (STATE.banner) {
            STATE.banner.remove();
            STATE.banner = null;
        }
    }

    // 屏幕坐标 → 经纬度 / 高度。优先 pickPosition 命中模型或地形,否则走椭球相交。
    function _screenToLngLat(click) {
        const viewer = window.viewer;
        if (!viewer) return null;
        let carto = null;
        if (viewer.scene.pickPositionSupported) {
            const cartesian = viewer.scene.pickPosition(click.position);
            if (Cesium.defined(cartesian)) {
                carto = Cesium.Cartographic.fromCartesian(cartesian);
            }
        }
        if (!carto) {
            const ray = viewer.camera.getPickRay(click.position);
            if (!ray) return null;
            const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
            if (!Cesium.defined(cartesian)) return null;
            carto = Cesium.Cartographic.fromCartesian(cartesian);
        }
        return {
            lng: +Cesium.Math.toDegrees(carto.longitude).toFixed(6),
            lat: +Cesium.Math.toDegrees(carto.latitude).toFixed(6),
            alt: Number.isFinite(carto.height) ? +carto.height.toFixed(1) : null,
        };
    }

    function _onPickClick(click) {
        const coord = _screenToLngLat(click);
        if (!coord) {
            if (typeof toast === 'function') toast('未能拾取到坐标，请再试一次');
            return;
        }
        _postBack({
            type: 'relic-pick',
            lng: coord.lng,
            lat: coord.lat,
            alt: coord.alt,
            code: STATE.code,
        });
        if (typeof toast === 'function') {
            toast(`已拾取：${coord.lng.toFixed(5)}, ${coord.lat.toFixed(5)}`);
        }
        // 回传后自动退出拾点模式并关闭本窗口。
        disable();
        // 给 opener 事件循环 200ms 响应空间,再关闭自身。
        setTimeout(() => {
            if (window.opener && !window.opener.closed) {
                try { window.close(); } catch (_) {}
            }
        }, 250);
    }

    // 推断 opener 的 origin。生产同源走 window.location.origin;
    // 开发期跨源(后台 5173 / 主图 8000)时用 referrer 推断;都拿不到兜底 '*'
    // (消息体仅含坐标,无敏感信息)。
    function _openerOrigin() {
        try {
            if (document.referrer) {
                const o = new URL(document.referrer).origin;
                if (o && o !== 'null') return o;
            }
        } catch (_) {}
        return null;
    }

    function _postBack(msg) {
        try {
            const target = window.opener || (window.parent !== window ? window.parent : null);
            if (!target) return;
            const origin = _openerOrigin();
            target.postMessage(msg, origin || '*');
        } catch (e) {
            console.warn('[pick_mode] postBack 失败', e);
        }
    }

    function enable(opts) {
        if (STATE.enabled) return;
        const viewer = window.viewer;
        if (!viewer) {
            console.warn('[pick_mode] viewer 未就绪');
            return;
        }
        STATE.enabled = true;
        STATE.code = (opts && opts.code) || null;

        _mountBanner();

        const canvas = _canvas();
        if (canvas) {
            STATE.prevCursor = canvas.style.cursor;
            canvas.style.cursor = 'crosshair';
        }

        STATE.handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
        STATE.handler.setInputAction(_onPickClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);

        document.addEventListener('keydown', _onKeyDown, true);
    }

    function disable() {
        if (!STATE.enabled) return;
        STATE.enabled = false;
        if (STATE.handler) {
            STATE.handler.destroy();
            STATE.handler = null;
        }
        const canvas = _canvas();
        if (canvas) canvas.style.cursor = STATE.prevCursor || '';
        _unmountBanner();
        document.removeEventListener('keydown', _onKeyDown, true);
    }

    function cancel() {
        _postBack({ type: 'relic-pick-cancel' });
        disable();
        setTimeout(() => {
            if (window.opener && !window.opener.closed) {
                try { window.close(); } catch (_) {}
            }
        }, 150);
    }

    function _onKeyDown(e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            e.preventDefault();
            cancel();
        }
    }

    // ── URL 参数入口 ────────────────────────────────────
    // 处理 ?relic / ?pick,app.js init() 结束后调用。
    function handleUrlParams() {
        const params = new URLSearchParams(window.location.search);

        const pick = params.get('pick');
        if (pick === '1' || pick === 'true') {
            const code = params.get('code');
            enable({ code });
            return;
        }

        const relic = params.get('relic');
        if (relic) {
            _autoFocusRelic(relic);
        }
    }

    // ?relic=code 时自动 flyTo 并展示信息面板。
    function _autoFocusRelic(code) {
        const tryFly = () => {
            if (typeof window.flyTo === 'function'
                && Array.isArray(window.allRelics) && window.allRelics.length) {
                if (window.allRelics.some(r => r.archive_code === code)) {
                    window.flyTo(code);
                    return true;
                }
            }
            if (typeof window.showInfoByCode === 'function') {
                window.showInfoByCode(code);
                return true;
            }
            return false;
        };
        // 等 allRelics 就绪,最多轮询 10 秒。
        let tries = 0;
        const t = setInterval(() => {
            tries += 1;
            if (tryFly() || tries > 50) clearInterval(t);
        }, 200);
    }

    window.PickMode = { enable, disable, cancel, handleUrlParams };
})();

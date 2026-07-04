// PolygonRenderer —— 按颜色聚合的面图层。
//
// 早期实现每个 feature 一个 Entity.polygon,1000 个面即 1000 次 materialChanged,
// 场景 commit 代价高。此处按颜色聚合成若干 GroundPrimitive(填充) +
// GroundPolylinePrimitive(描边),绘制调用从 O(n) 降到 O(颜色数)。
//
// 依赖全局 Cesium,导出 window.PolygonRenderer。
(function () {
    // GroundPolylineGeometry 对零长度线段敏感(normalize 除零),
    // 须提前清洗连续重复点 & GeoJSON ring 的尾部闭合点。
    const EPS = 1e-9;
    function _sanitize(coords) {
        const pts = [];
        for (const c of coords) {
            if (!c || c.length < 2) continue;
            const x = +c[0], y = +c[1];
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            const last = pts[pts.length - 1];
            if (last && Math.abs(last[0] - x) < EPS && Math.abs(last[1] - y) < EPS) continue;
            pts.push([x, y]);
        }
        // GeoJSON ring 约定末点与首点重合,去掉尾部。
        if (pts.length > 1) {
            const f = pts[0], l = pts[pts.length - 1];
            if (Math.abs(f[0] - l[0]) < EPS && Math.abs(f[1] - l[1]) < EPS) pts.pop();
        }
        return pts;
    }

    function _flatten(pts) {
        const out = [];
        for (const c of pts) { out.push(c[0], c[1]); }
        return out;
    }

    class PolygonRenderer {
        constructor(viewer) {
            this.viewer = viewer;
            this._fills = [];          // GroundPrimitive
            this._outlines = [];       // GroundPolylinePrimitive
            this._visible = true;
        }

        // features: GeoJSON Feature 数组;colorFn(archive_code) → '#rrggbb'。
        render(features, colorFn) {
            this.clear();
            if (!features || !features.length) return;

            // 按颜色聚合 polygon 几何(清洗后为 [[lng,lat], ...] 列表)。
            const groups = new Map();
            for (const f of features) {
                if (!f.geometry || f.geometry.type !== 'Polygon') continue;
                const raw = f.geometry.coordinates && f.geometry.coordinates[0];
                const pts = _sanitize(raw || []);
                if (pts.length < 3) continue;
                const code = f.properties && f.properties.archive_code;
                const colorHex = (colorFn && colorFn(code)) || '#8b949e';
                if (!groups.has(colorHex)) groups.set(colorHex, []);
                groups.get(colorHex).push(pts);
            }

            for (const [colorHex, list] of groups) {
                const cc = Cesium.Color.fromCssColorString(colorHex);

                const fillInstances = list.map(pts => new Cesium.GeometryInstance({
                    geometry: new Cesium.PolygonGeometry({
                        polygonHierarchy: new Cesium.PolygonHierarchy(
                            Cesium.Cartesian3.fromDegreesArray(_flatten(pts))
                        ),
                    }),
                    attributes: {
                        color: Cesium.ColorGeometryInstanceAttribute.fromColor(cc.withAlpha(0.28)),
                    },
                }));
                const fill = new Cesium.GroundPrimitive({
                    geometryInstances: fillInstances,
                    appearance: new Cesium.PerInstanceColorAppearance({
                        flat: true, translucent: true,
                    }),
                    show: this._visible,
                    asynchronous: true,
                });
                this.viewer.scene.primitives.add(fill);
                this._fills.push(fill);

                const lineInstances = list.map(pts => new Cesium.GeometryInstance({
                    geometry: new Cesium.GroundPolylineGeometry({
                        positions: Cesium.Cartesian3.fromDegreesArray(_flatten(pts)),
                        width: 1.5,
                        loop: true,
                    }),
                    attributes: {
                        color: Cesium.ColorGeometryInstanceAttribute.fromColor(cc.withAlpha(0.75)),
                    },
                }));
                const outline = new Cesium.GroundPolylinePrimitive({
                    geometryInstances: lineInstances,
                    appearance: new Cesium.PolylineColorAppearance({ translucent: true }),
                    show: this._visible,
                    asynchronous: true,
                });
                this.viewer.scene.primitives.add(outline);
                this._outlines.push(outline);
            }
            this.viewer.scene.requestRender();
        }

        setVisible(v) {
            this._visible = !!v;
            for (const p of this._fills)   p.show = this._visible;
            for (const p of this._outlines) p.show = this._visible;
            this.viewer.scene.requestRender();
        }

        clear() {
            const prims = this.viewer.scene.primitives;
            for (const p of this._fills)    { try { prims.remove(p); } catch (e) {} }
            for (const p of this._outlines) { try { prims.remove(p); } catch (e) {} }
            this._fills = [];
            this._outlines = [];
        }

        size() { return this._fills.length + this._outlines.length; }
    }

    window.PolygonRenderer = PolygonRenderer;
})();

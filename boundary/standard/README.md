# 济宁市标准行政边界

本目录是地图运行时边界的仓库内标准数据源，由项目方在 ArcGIS 中制作的
Shapefile 生成。前端显示、离线矢量底图的县区导航，以及清空数据后的自动恢复，
都使用同一份市界和县界，避免不同数据源造成整体错位。

## 数据层

| 层级 | 要素数 | 仓库文件 | 源坐标系 |
| --- | ---: | --- | --- |
| 市界 | 1 | `city.geojson` | EPSG:4326 |
| 县界 | 11 | `county.geojson` | EPSG:4326 |
| 镇街 | 157 | `townships.geojson.gz` | EPSG:4326 |
| 村界 | 6504 | `villages.geojson.gz` | Krasovsky 1940 Albers |

所有输出统一为 WGS 84（EPSG:4326）。村界源文件还包含少量邻市要素，导入时按
`市名_1=济宁市` 筛选；为控制浏览器负载，仅对村界在源投影中做 2 米保拓扑简化。
村所属镇街通过面内点空间匹配到 157 个标准镇街面，避免历史名称差异；镇级代码
优先采用村表中的 9 位代码，重码或缺码时使用显式 `town-*` 项目键。该误差远小于
地图显示线宽，不进行 GCJ-02 经验偏移。

## 重新生成

开发环境需安装 `geopandas`、`pyogrio`、`pyproj` 和 `shapely`：

```powershell
python platform/scripts/import_standard_boundaries.py `
  "<ArcGIS 边界目录>"
```

脚本会同步生成本目录、`data/output/boundaries/` 的运行时文件，以及
`platform/webgis/static/vector_basemap/` 中供双击县区导航使用的市县界副本。
`manifest.json` 记录版本、范围、要素数和 SHA-256；服务启动时会校验并按版本恢复
四层边界。

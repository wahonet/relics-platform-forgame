# 济宁市文物保护利用平台

面向市级文物保护与数字化管理的综合性平台。采用「市级基础层 + 嘉祥县全量层」两级数据组织全市在册文物保护单位，围绕**资源概览、数据资源目录与开放共享、基层文物巡查、AI 文物问答**四大能力构建完整业务闭环。

## 平台功能

| 模块 | 入口 | 说明 |
| --- | --- | --- |
| 地图总览 | `/app/#/` | Cesium 二维地图：点位、两线范围、筛选与详情档案 |
| 资源概览 | `/app/#/dashboard` | 资源总量、分级/县区/年代/保存状况分布、数据质量与巡查动态 |
| 数据资源目录 | `/app/#/catalog` | 数据集目录、开放级别、共享申请与审核流程 |
| 文物巡查 | 地图页「文物巡查」按钮 | AI/手动规划路线、高德导航、扫码移动端打卡、AI 保存状况评估与巡查报告 |
| AI 问答 | 地图页「AI 助手」按钮 | 基于全量台账上下文的大模型问答 |
| 系统管理 | `/app/#/admin` | 可视化运行数据管线（含演示数据生成、实时日志）、API Key 在线配置（热生效）、离线地图与行政边界下载 |

### 数据分层

- **市级基础层**（约 900 处在册保护单位，国/省/市/县四级）：名称、级别、类别、年代、坐标、两线范围、照片、图纸、简介。
- **嘉祥县全量层**（568 处不可移动文物）：在基础层数据之上，增加三普/四普档案查看、实景三维模型（约 400 个）。

### 巡查闭环

1. PC 端按保存状况分级确定巡查频率（差 = 每月、较差 = 双月、一般 = 季度……），到期自动提醒。
2. AI 解析自然语言意图（如「巡查武氏祠附近 5 处文物」）或手动点选/框选生成路线，接入高德驾车路线规划。
3. 路线生成二维码，手机扫码进入 H5：一键唤起高德导航（含途经点）、拍照打卡。
4. 照片 EXIF 定位与文物坐标自动比对，核验是否到场；PC 端 AI 视觉模型比对历史照片评估保存状况，一键生成巡查报告。

## 快速开始

```bash
# 1) 后端依赖（建议 Python 3.12+）
python3 -m venv .venv
.venv/bin/pip install -r platform/webgis/requirements.txt

# 2) 配置
cp config.example.yaml config.yaml
# 编辑 config.yaml：api.siliconflow.key（AI 问答/评估）、api.amap.web_key（路线规划）可选

# 3) 演示数据（无真实数据时）
.venv/bin/python platform/tools/generate_demo_data.py
.venv/bin/python platform/scripts/run_pipeline.py        # 导入 + 建库

# 4) 前端构建
cd platform/webgis-react && npm install && npm run build && cd ../..

# 5) 启动
.venv/bin/python -m uvicorn main:app --app-dir platform/webgis --host 0.0.0.0 --port 8000
# 打开 http://127.0.0.1:8000/app/
```

Windows 下直接双击 `start.bat` 一键启动（自动安装依赖、构建前端、拉起后端并打开浏览器）。改过前端代码后用 `start.bat build` 重新构建；前端开发热更新用 `start.bat dev`。

### 接入真实数据

| 数据 | 放置位置 | 说明 |
| --- | --- | --- |
| 文物台账 | `data/input/01_relics/*.xlsx` | 模板见 `data/templates/relics_import_template.csv` |
| 照片/图纸 | `data/input/02_media/photos/{编号}/`、`drawings/{编号}/` | 任意 jpg/png |
| 行政边界 | `data/input/03_boundaries/` | Shapefile 或 GeoJSON |
| 普查档案 | `data/input/06_archive_docs/{编号}/{sanpu,sipu}/*.pdf` | 嘉祥全量层 |
| 三维模型 | `data/Get3D/{编号}/tileset.json` | 3D Tiles |

放好后执行 `python platform/scripts/run_pipeline.py` 重建数据库。巡查记录、共享申请存于独立的 `patrol.db`，不受重建影响。

## 管线与架构

```
platform/
├─ scripts/            # 数据管线
│  ├─ step01_import_relics.py      # Excel/CSV 台账导入 + 媒体挂接
│  ├─ step02_prepare_boundaries.py # 行政边界转 GeoJSON
│  ├─ step03_build_db.py           # SQLite 建库（R-Tree 空间索引 + FTS5 全文搜索）
│  └─ run_pipeline.py              # 编排：python run_pipeline.py [--only 03] [--dry-run]
├─ tools/
│  └─ generate_demo_data.py        # 演示数据生成（1371 条 + 占位照片/档案）
├─ webgis/             # FastAPI 后端
│  ├─ main.py                      # 入口
│  ├─ data_loader.py               # relics.db 加载与查询
│  ├─ routers/                     # relics / stats / catalog / patrol / chat ...
│  ├─ services/                    # ai_service / amap_service / patrol_service / exif_gps
│  └─ templates/mobile_route.html  # 巡查移动端 H5
└─ webgis-react/       # React + Cesium 前端（Vite 构建）
```

- 主数据库 `data/output/dataset/relics.db`：文物、照片、图纸、两线范围（重建安全）。
- 业务数据库 `data/output/patrol/patrol.db`：巡查路线/打卡记录/AI 评估/共享申请（持久保留）。

## 配置要点

```yaml
api:
  siliconflow:
    key: "sk-..."          # AI 问答、巡查意图解析、照片评估（视觉模型）
  amap:
    web_key: "..."         # 高德 Web 服务 key，驾车路线规划
server:
  public_base_url: ""      # 手机扫码访问的基址，留空自动探测局域网 IP
```

未配置 AI key 时，问答与评估自动降级为规则模式；未配置高德 key 时，路线用直线连接，均不影响启动。

## 测试

```bash
.venv/bin/python -m pytest tests/ -q
```

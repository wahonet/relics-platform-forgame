# 不可移动文物数字档案平台

一个把四普档案、地图、照片、图纸、工作日志、边界、DEM、三维模型和后台维护流程塞进同一套 WebGIS 里的县区级数字档案平台。

当前版本：`V1.1.0 架构调整版`

> [!WARNING]
> 这不是一个“clone 下来就自带真实业务数据”的仓库。`data/input/` 不进 Git，`data/output/` 只保留必要目录骨架。你需要把自己的 DOCX、边界、日志、DEM、模型等数据放进去，再跑管线或在后台手动生成。

> [!IMPORTANT]
> 日常只需要两个入口：`start-backend.bat` 和 `start-frontend.bat`。旧的编号 BAT 已经清掉了，别再找 `1-setup.bat`、`2-pipeline.bat` 那套。

> [!CAUTION]
> 模板配置默认 `server.enable_auth: false`，后台登录接口会直接签发本地 session。要上生产或给别人访问，请改成 `true`，并把 `server.users` 里的默认密码换掉。

完整架构树在 [docs/architecture/v1.1-architecture.md](docs/architecture/v1.1-architecture.md)，重构执行记录在 [docs/refactor/execution-log.md](docs/refactor/execution-log.md)。

## 快速开始

### 准备配置

第一次启动后端时，脚本会自动把 `config.example.yaml` 复制成 `config.yaml`：

```powershell
.\start-backend.bat
```

你也可以手动复制：

```powershell
Copy-Item config.example.yaml config.yaml
```

建议至少看一眼这些字段：

| 配置 | 说明 |
|---|---|
| `project.name` / `project.full_name` | 平台名称、页面标题 |
| `geo.center` / `geo.bounds` | 初始视角、瓦片下载范围、DEM 裁剪范围 |
| `geo.boundaries.*` | 行政边界投影参数 |
| `administrative.county_name` / `townships` | 县区名称、乡镇列表 |
| `api.*` / 环境变量 | AI、地图源、Cesium 等外部服务密钥 |
| `server.enable_auth` / `server.users` | 登录保护开关与后台账号 |

模板默认后台账号是：

```text
admin / changeme
```

如果 `enable_auth: false`，随便填也能进后台；如果改成 `true`，就必须匹配 `server.users`。

### 启动后端

```powershell
.\start-backend.bat
```

脚本会优先使用 `.venv`，其次使用仓库内的 `python/`，最后才找系统 Python。依赖缺失时会自动安装 `platform/webgis/requirements.txt`。

后端默认地址：

```text
http://127.0.0.1:8000/
```

FastAPI 会挂载构建后的前端产物，所以访问 `8000/` 通常会跳到 `8000/app/`。这是后端集成入口，适合只启动后端时看已构建版本。

### 启动前端

```powershell
.\start-frontend.bat
```

它会启动两个 Vite dev server：

| 应用 | 地址 | 说明 |
|---|---|---|
| React WebGIS | `http://127.0.0.1:5174/` | 主地图、三维、统计、详情、AI、瓦片下载 |
| Vue Admin | `http://127.0.0.1:5173/` | 管理后台、管线、CRUD、审计、导入导出 |

端口关系别绕晕：

| 端口 | 谁开的 | 用来干嘛 |
|---|---|---|
| `8000` | FastAPI | API、瓦片代理、静态挂载，含 `/app/` 和 `/admin-ui/` |
| `5174` | React Vite | 主 WebGIS 开发入口，热更新，代理 API 到 `8000` |
| `5173` | Vue Vite | Admin 开发入口，热更新，代理 API 到 `8000` |

改前端看 `5174` / `5173`；只想跑集成版看 `8000/app/` / `8000/admin-ui/`。

## 数据放哪

```text
data/
├─ input/
│  ├─ 01_archives/        # 四普档案 DOCX，可按乡镇分目录
│  ├─ 02_worklogs/        # 外业工作日志 Excel、轨迹照片等
│  ├─ 03_boundaries/      # 县、乡镇、村边界 SHP 或 GeoJSON
│  ├─ 04_dem/             # DEM GeoTIFF
│  └─ 05_models_3d/       # 三维模型或 3D Tiles
└─ output/
   ├─ markdown/           # DOCX 转出来的 Markdown
   ├─ dataset/            # CSV / JSON / GeoJSON / relics.db
   ├─ photos/             # 档案照片
   ├─ drawings/           # 档案图纸
   ├─ boundaries/         # WGS-84 行政边界
   ├─ terrain_cache/      # DEM terrain 缓存
   └─ logs/               # 管线和后台任务日志
```

`data/input/` 不提交。大体积缓存、瓦片、日志、模型产物也不提交。仓库只管代码和必要目录骨架。

## 数据管线

入口在这里：

```powershell
.venv\Scripts\python.exe platform\scripts\run_pipeline.py
```

常用命令：

```powershell
.venv\Scripts\python.exe platform\scripts\run_pipeline.py --list
.venv\Scripts\python.exe platform\scripts\run_pipeline.py --dry-run
.venv\Scripts\python.exe platform\scripts\run_pipeline.py --skip 05
```

默认 7 步：

| Step | 脚本 | 产物 | 说明 |
|---|---|---|---|
| 01 | `step01_convert_docs.py` | Markdown | DOCX 档案结构化 |
| 02 | `step02_build_dataset.py` | CSV / JSON / GeoJSON | 生成核心数据集 |
| 03 | `step03_extract_photos.py` | 照片索引 | 抽档案照片 |
| 04 | `step04_extract_drawings.py` | 图纸索引 | 抽档案图纸 |
| 05 | `step05_convert_worklogs.py` | PDF | 工作日志转 PDF，可跳过 |
| 06 | `step06_prepare_boundaries.py` | WGS-84 GeoJSON | 行政边界处理，可跳过 |
| 07 | `step07_build_db.py` | SQLite | 生成 `relics.db`，含 R-Tree、FTS5、审计表 |

你也可以在 Vue Admin 的“管线工作台”里手动跑这些步骤。大文件进来以后，手动触发比开一堆 BAT 舒服。

## 功能

### WebGIS 主图

- React + Cesium 主地图。
- 支持离线/在线底图、行政边界、点位、面域、地形、主视角记忆。
- 支持 `/api/relics/by-bbox` 视口查询，地图移动后只拉当前区域数据。
- 支持瓦片下载、缓存统计、下载历史和离线覆盖显示。

### 文物档案

- 文物基本信息、类别、级别、年代、地址、坐标。
- 照片、图纸、PDF、简介、三维模型、工作日志联动。
- SQLite 优先，JSON fallback。
- R-Tree 做空间检索，FTS5 做全文检索。

### 管理后台

- Vue 3 + Element Plus。
- Dashboard、管线工作台、文物 CRUD、批量编辑、导入导出、审计日志。
- 支持回收站、相邻文物查询、地图框选、拾点回传。
- 后台写操作进入 `audit_log`，编辑使用版本字段降低覆盖风险。

### AI 与辅助能力

- AI 知识库问答入口。
- 回答可联动文物和工作日志。
- 外业路线与村庄覆盖率分析。
- 本地 DEM terrain tile 服务。

## 架构

```text
relics-platform-react/
├─ start-backend.bat              # 后端入口
├─ start-frontend.bat             # 前端入口
├─ config.example.yaml            # 配置模板
├─ VERSION
├─ requirements-dev.txt
├─ pytest.ini
├─ .github/workflows/ci.yml
├─ docs/
├─ tests/
└─ platform/
   ├─ scripts/                    # 7 步数据管线
   ├─ webgis/                     # FastAPI 后端
   ├─ webgis-react/               # React 主前端
   ├─ admin-vue/                  # Vue 管理后台
   └─ tools/
```

后端拆分后的核心文件：

```text
platform/webgis/
├─ main.py                        # FastAPI 组合入口
├─ serve.py                       # 后端启动入口
├─ tile_routes.py                 # 瓦片代理、缓存、下载
├─ terrain_routes.py              # DEM terrain API
├─ data_loader.py                 # DataStore 门面
├─ data_serializers.py            # DB row 序列化
├─ data_admin_queries.py          # Admin 查询
├─ data_admin_stats.py            # Admin 统计
├─ survey_coverage.py             # 普查轨迹与村庄覆盖
└─ routers/
   ├─ admin.py
   ├─ admin_task_service.py
   ├─ admin_relic_routes.py
   ├─ relics.py
   ├─ stats.py
   ├─ worklog.py
   ├─ survey_routes.py
   ├─ boundaries.py
   ├─ chat.py
   └─ crs.py
```

前端分工：

```text
platform/webgis-react/src/        # 面向使用者的主地图
platform/admin-vue/src/           # 面向维护者的管理后台
```

## 测试

后端：

```powershell
.venv\Scripts\python.exe -m pytest
.venv\Scripts\python.exe platform\scripts\run_pipeline.py --list
.venv\Scripts\python.exe platform\scripts\run_pipeline.py --dry-run --skip 01 --skip 05
```

React：

```powershell
cd platform\webgis-react
npm.cmd run type-check
npm.cmd run build
```

Vue Admin：

```powershell
cd platform\admin-vue
npm.cmd run typecheck
npm.cmd run build
```

CI 在 `.github/workflows/ci.yml`，push 和 pull request 会跑 Python 测试、React 构建、Vue 构建。

## 常见问题

### 后台登录一直 401？

先看 `config.yaml`：

```yaml
server:
  enable_auth: false
  users:
    - username: "admin"
      password: "changeme"
```

`enable_auth: false` 时登录接口会直接签发本地 session；`true` 时才校验账号密码。改了配置要重启后端。

### 下载地图时报 zoom 溢出？

V1.1 后已经做了防护。层级只接受 `1..17`，比如 `12,13,1415,16` 会被清洗成 `12,13,16`。

### `8000/app` 和 `5174` 到底看哪个？

看你在干嘛。只跑后端就看 `8000/app`；改 React 前端就看 `5174`；改 Vue Admin 就看 `5173`。

## 文档

```text
docs/
├─ README.md
├─ architecture/v1.1-architecture.md
├─ refactor/execution-log.md
└─ releases/v1.1.0.md
```

## 版本说明

V1.1.0 主要是架构调整，不是业务大改。它做了三件事：

1. 把后端入口、瓦片、DEM、后台任务、文物管理、数据查询和统计拆清楚。
2. 把后台前端的大页面拆出 composable 和独立样式文件。
3. 把启动、测试、CI、发布文档收拢成稳定流程。

如果你只是想跑起来，记住两条命令就够了：

```powershell
.\start-backend.bat
.\start-frontend.bat
```

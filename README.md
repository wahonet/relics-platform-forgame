# 文物保护利用平台

一个面向不可移动文物保护与数字化管理的开源平台。把散落在 Excel、照片文件夹、PDF 档案里的文物家底整理成一张可交互的地图，再配上资源统计、数据共享、基层巡查和 AI 问答，日常保护工作需要的东西基本都在里面了。

项目名称、地图范围、县区列表这些都写在 `config.yaml` 里，换个地区部署只需要改配置和数据，不用动代码。

## 能做什么

打开平台后，顶部导航就是全部功能，都在一个页面里切换：

- **地图总览** — 二维地图上看全部文物点位，按类别着色、按级别定大小。市域整域取景、市界发光描边、域外自动压暗，一眼锁定辖区。底图默认天地图影像（在线影像/矢量 × 天地图/高德，另有离线底图），投影按 Web Mercator 精确呈现。点开任意一处能看到详情档案、照片图纸、本体边界与两线范围，有三维模型和普查档案的直接打开看。左侧筛选面板支持关键字、类别、区县、级别、保存状况等组合过滤，地图和统计图表联动。
- **资源概览** — 一屏看清家底：总量、各级保护单位构成、区县分布、年代序列、保存状况，还有一个数据质量评分，提醒你哪些字段还没补齐。
- **文物巡查** — 独立标签页：左侧规划、右侧地图。按保存状况自动排巡查频率（状况越差查得越勤），到期提醒；用一句话让 AI 帮你规划路线（比如"巡查XX附近保存较差的 5 处文物"），也可以在地图上点选组线；路线生成二维码，巡查员手机扫码就能导航、拍照打卡；照片的 EXIF 定位会和文物坐标自动比对核验是否到场（已完成点位地图上显示绿色），AI 还能对比历史照片评估保存状况，最后一键出巡查报告。
- **AI 问答** — 基于全量台账的大模型问答，"哪个乡镇的古建筑最多"这类问题直接问就行。模型在系统管理里统一选择，前端与管线共用。
- **系统管理** — 经典后台布局（左侧标签 + 右侧内容），运维不用碰命令行：可视化跑数据管线（实时日志 + 完整落盘留档 + 跑完自动热重载）、在线填 API Key 与选择 AI 模型（保存即生效，模型列表从账号实时拉取）、下载离线地图瓦片和行政边界（已下载内容分源统计、可单独清理）。

另有深墨蓝 / 经典亮白 / 藏青政务 / 青碧四套主题配色（设置面板切换）。没配 AI Key 时问答和评估自动降级成规则模式，没配高德 Key 时路线用直线连接，没配天地图 Key 时底图回退高德，都不影响启动和演示。

## 快速开始

**Windows：** 双击 `start.bat` 就行。它会自己装依赖、构建前端、起服务、打开浏览器。改过前端代码用 `start.bat build`，前端开发热更新用 `start.bat dev`。

**macOS / Linux：**

```bash
# 1) 后端依赖(建议 Python 3.10+)
python3 -m venv .venv
.venv/bin/pip install -r platform/webgis/requirements.txt

# 2) 配置
cp config.example.yaml config.yaml   # 按需修改项目名、地图中心、范围等

# 3) 演示数据(手头没有真实数据时)
.venv/bin/python platform/tools/generate_demo_data.py
.venv/bin/python platform/scripts/run_pipeline.py

# 4) 前端构建
cd platform/webgis-react && npm install && npm run build && cd ../..

# 5) 启动
.venv/bin/python platform/webgis/serve.py
# 浏览器打开 http://127.0.0.1:8000
```

跑起来之后，管线、API Key、离线地图这些都可以去页面上的「系统管理」操作，不用再回终端。

## 接入自己的数据

**推荐路线：四普登记表 docx 直接进管线。** 把登记表按乡镇分文件夹放进 `data/input/00_docs/`，在「系统管理 → 数据管线」点"运行全部管线"：

1. **档案提取（step00）**：调用大模型（SiliconFlow，Key 在系统管理里配）把 docx 逐份提取成结构化 Markdown 档案。支持断点续传——中断后重跑只处理缺失和损坏的文件，进度账本在 `data/output/logs/step00_progress.json`；并发数用 `config.api.siliconflow.extract_concurrency` 调整
2. **数据导入（step01）**：解析 Markdown 档案——简介全文、度分秒坐标、本体边界点成面、权属/调查人等全部字段；照片和图纸按清单顺序直接从 docx 内嵌图片中抽出，带照片号与文字说明
3. **边界处理（step02）** 与 **数据库构建（step03）**：行政边界转 WGS-84 GeoJSON；建 `relics.db`（R-Tree 空间索引 + FTS5 全文搜索）

各类数据的放置位置：

| 数据 | 放置位置 | 说明 |
| --- | --- | --- |
| 普查登记表 | `data/input/00_docs/{乡镇}/*.docx` | 文件夹名作为乡镇字段;文件名以档案编号开头 |
| Markdown 档案 | `data/input/01_relics/markdown/{乡镇}/*.md` | step00 的产物,也可直接放入已有档案 |
| 文物台账(旧格式) | `data/input/01_relics/*.xlsx` | 兼容保留,无 Markdown 档案时启用 |
| 照片 / 图纸 | `data/input/02_media/photos/{编号}/`、`drawings/{编号}/` | 无源 docx 时的媒体来源 |
| 行政边界 | `data/input/03_boundaries/` | Shapefile 或 GeoJSON;也可在系统管理里在线下载 |
| 市域高亮边界 | `data/output/boundaries/city.geojson` | 有此文件时地图显示市界发光 + 域外遮罩 |
| 普查档案 PDF | `data/input/06_archive_docs/{编号}/{sanpu,sipu}/*.pdf` | 三普 / 四普 PDF |
| 三维模型 | `data/Get3D/{编号}/tileset.json` | 3D Tiles |

重建只影响主数据库 `relics.db`；巡查记录存在独立的 `patrol.db` 里，怎么重建都不会丢。管线每次运行的完整日志都会落盘到 `data/output/logs/`（系统管理页发起的任务在 `logs/admin_tasks/`）。

## 项目结构

```
platform/
├─ scripts/            # 数据管线(4 步)
│  ├─ step00_convert_docs.py       # 四普登记表 docx → Markdown 档案(LLM 提取,断点续传)
│  ├─ step01_import_relics.py      # Markdown 档案/台账导入 + docx 照片图纸抽取
│  ├─ step02_prepare_boundaries.py # 行政边界转 GeoJSON
│  ├─ step03_build_db.py           # SQLite 建库(R-Tree 空间索引 + FTS5 全文搜索)
│  ├─ md_archive.py                # Markdown 档案解析库(坐标/边界/清单/内嵌图片)
│  └─ run_pipeline.py              # 编排入口,支持 --only / --dry-run
├─ tools/
│  └─ generate_demo_data.py        # 演示数据生成器
├─ webgis/             # FastAPI 后端
│  ├─ main.py                      # 入口
│  ├─ routers/                     # relics / stats / patrol / chat / admin ...
│  ├─ services/                    # AI / 高德路线 / 巡查 / EXIF 定位
│  ├─ tile_routes.py               # 瓦片代理与缓存(天地图/高德/ArcGIS/OSM + 离线下载)
│  └─ templates/mobile_route.html  # 巡查移动端 H5
└─ webgis-react/       # React + Cesium 前端(Vite 构建,后端在 /app/ 托管)
```

## 配置要点

```yaml
api:
  siliconflow:
    key: "sk-..."             # AI 问答 / 档案提取 / 巡查规划 / 照片评估
    default_model: "..."      # 全局 AI 模型(系统管理页可视化选择)
    extract_concurrency: 2    # step00 档案提取并发数(1-8)
  amap:
    web_key: "..."            # 高德 Web 服务 key,驾车路线规划(可选)
  tianditu:
    key: "..."                # 天地图服务端 key,官方在线底图(推荐)
server:
  public_base_url: ""         # 手机扫码用的对外地址,留空自动探测局域网 IP
```

这几个 Key 都可以启动后在「系统管理 → API 配置」里直接填，保存即生效。天地图瓦片由后端代理并永久缓存到本地，同一区域只消耗一次配额；也可以在系统管理里把常用层级整片下载下来离线用。

## 测试

```bash
.venv/bin/python -m pytest tests/ -q
```

## 开源协议

本项目采用[木兰宽松许可证, 第2版](http://license.coscl.org.cn/MulanPSL2)（MulanPSL-2.0）开源，完整条款见 [LICENSE](LICENSE)。简单说：可以自由使用、修改、分发（商用也行），保留版权声明即可，软件按"现状"提供、不带担保。

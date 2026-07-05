# 文物保护利用平台

一个面向不可移动文物保护与数字化管理的开源平台。把散落在 Excel、照片文件夹、PDF 档案里的文物家底整理成一张可交互的地图，再配上资源统计、数据共享、基层巡查和 AI 问答，日常保护工作需要的东西基本都在里面了。

项目名称、地图范围、县区列表这些都写在 `config.yaml` 里，换个地区部署只需要改配置和数据，不用动代码。

## 能做什么

打开平台后，顶部导航就是全部功能，都在一个页面里切换：

- **地图总览** — 二维地图上看全部文物点位，按类别着色、按级别定大小。点开任意一处能看到详情档案、照片图纸、保护范围和建控地带（两线范围），有三维模型和普查档案的还能直接打开看。左侧筛选面板支持关键字、类别、区县、级别、保存状况等组合过滤，地图和统计图表都会跟着联动。
- **资源概览** — 一屏看清家底：总量、各级保护单位构成、区县分布、年代序列、保存状况，还有一个数据质量评分，提醒你哪些字段还没补齐。
- **数据资源目录** — 把台账、照片、边界等数据整理成目录对外开放。开放级别分三档（直接开放 / 申请共享 / 受限），带一个简单的申请审核流程。
- **文物巡查** — 平台的重头戏。按保存状况自动排巡查频率（状况越差查得越勤），到期提醒；用一句话让 AI 帮你规划路线（比如"巡查XX附近保存较差的 5 处文物"），也可以在地图上手动点选；路线生成二维码，巡查员手机扫码就能导航、拍照打卡；照片的 EXIF 定位会和文物坐标自动比对核验是否到场，AI 还能对比历史照片评估保存状况，最后一键出巡查报告。
- **AI 问答** — 基于全量台账的大模型问答，"哪个乡镇的古建筑最多"这类问题直接问就行。
- **系统管理** — 运维不用碰命令行：可视化跑数据管线（带实时日志）、在线填 API Key（保存即生效）、下载离线地图瓦片和行政边界。

没配 AI Key 时问答和评估自动降级成规则模式，没配高德 Key 时路线用直线连接，都不影响启动和演示。

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

把数据按下面的位置放好，然后在「系统管理」里点一下"运行全部管线"（或命令行执行 `python platform/scripts/run_pipeline.py`）：

| 数据 | 放置位置 | 说明 |
| --- | --- | --- |
| 文物台账 | `data/input/01_relics/*.xlsx` | 模板见 `data/templates/relics_import_template.csv` |
| 照片 / 图纸 | `data/input/02_media/photos/{编号}/`、`drawings/{编号}/` | 任意 jpg/png |
| 行政边界 | `data/input/03_boundaries/` | Shapefile 或 GeoJSON;也可以直接在系统管理里在线下载 |
| 普查档案 | `data/input/06_archive_docs/{编号}/{sanpu,sipu}/*.pdf` | 三普 / 四普 PDF |
| 三维模型 | `data/Get3D/{编号}/tileset.json` | 3D Tiles |

重建只影响主数据库 `relics.db`；巡查记录和共享申请存在独立的 `patrol.db` 里，怎么重建都不会丢。

## 项目结构

```
platform/
├─ scripts/            # 数据管线(3 步)
│  ├─ step01_import_relics.py      # 台账导入 + 媒体挂接
│  ├─ step02_prepare_boundaries.py # 行政边界转 GeoJSON
│  ├─ step03_build_db.py           # SQLite 建库(R-Tree 空间索引 + FTS5 全文搜索)
│  └─ run_pipeline.py              # 编排入口,支持 --only / --dry-run
├─ tools/
│  └─ generate_demo_data.py        # 演示数据生成器
├─ webgis/             # FastAPI 后端
│  ├─ main.py                      # 入口
│  ├─ routers/                     # relics / stats / catalog / patrol / chat / admin ...
│  ├─ services/                    # AI / 高德路线 / 巡查 / EXIF 定位
│  └─ templates/mobile_route.html  # 巡查移动端 H5
└─ webgis-react/       # React + Cesium 前端(Vite 构建,后端在 /app/ 托管)
```

## 配置要点

```yaml
api:
  siliconflow:
    key: "sk-..."          # AI 问答 / 巡查意图解析 / 照片评估
  amap:
    web_key: "..."         # 高德 Web 服务 key,驾车路线规划(可选)
server:
  public_base_url: ""      # 手机扫码用的对外地址,留空自动探测局域网 IP
```

这几个 Key 也可以启动后在「系统管理」页面里直接填，保存即生效。

## 测试

```bash
.venv/bin/python -m pytest tests/ -q
```

## 开源协议

本项目采用[木兰宽松许可证, 第2版](http://license.coscl.org.cn/MulanPSL2)（MulanPSL-2.0）开源，完整条款见 [LICENSE](LICENSE)。简单说：可以自由使用、修改、分发（商用也行），保留版权声明即可，软件按"现状"提供、不带担保。

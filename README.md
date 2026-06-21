# map-color-war-h5

H5 地图填色多人对战原型，使用 Vite、TypeScript、Phaser、d3-delaunay、polygon-clipping 和 Node.js WebSocket 实现。

当前版本支持：

- Fantasy 风格高度图地图生成
- 100 个初始国家和 101-200 叛乱国家编号预留
- 行省填色、像素小兵、多线进攻、反入侵、停战、结盟
- 手机端纯指令输入
- WebSocket 单房间多人测试
- GitHub Pages 前端部署和 Render 后端部署

## 安装

```bash
npm install
```

## 本地运行

单机或前端开发：

```bash
npm run dev
```

本地多人测试：

```bash
npm run server:dev
npm run dev
```

本地开发默认连接 `ws://localhost:8787`。健康检查：

```text
http://localhost:8787/health
```

构建检查：

```bash
npm run build
```

## 玩家流程

普通玩家打开网页后：

1. 输入昵称。
2. 进入地图。
3. 在底部输入 `加入12` 选择国家落座。
4. 继续用指令进行进攻、停战、结盟等操作。

手机端不依赖地图触摸操作，只通过虚拟键盘输入指令。

## 指令

```text
加入12
进攻8
停战8
结盟15
退出结盟15
同意结盟12
昵称小明
```

- `加入+编号`：加入普通国家或已出现的叛乱国家，例如 `加入12`、`加入101`。
- `进攻+编号`：发起进攻，支持多线进攻。
- `停战+编号`：停止对该目标的战线及其反入侵。
- `结盟+编号`：与一个国家结盟，最多一个盟友。
- `退出结盟+编号`：退出当前盟友关系。
- `同意结盟+编号`：同意真实玩家国家发来的结盟申请。
- `昵称+文本`：修改昵称，最多 8 个可见字符。

多人模式下，底部会显示指令聊天区，玩家能看到彼此发出的指令和系统执行结果。

## Fantasy 地图生成

管理员入口：

```text
http://localhost:5173/?admin=1
```

管理员地图编辑器支持两种方式：

- 手绘一个或多个陆地轮廓。
- 使用 Fantasy 自动生成器生成架空地图。

Fantasy 自动生成器参考《Fantasy Map Simulator》的地图层级思路：

- 先用 seed 生成高度图。
- 由海平面切出陆地和海洋。
- 根据高度、湿度、温度生成海岸、平原、森林、沙漠、湿地、山地、雪地。
- 从高地追踪河流到低地或海洋。
- 再在陆地上用 Voronoi 生成 100 个国家和行省。

可调参数：

- `seed`
- 大陆类型：大陆、双大陆、群岛
- 海平面
- 山脉强度
- 湿度
- 河流数量

点击“生成预览”后可以查看轮廓，点击“保存”或“生成地图”后会保存到本机 `localStorage`，普通玩家下次打开会默认使用这张地图。导出的 JSON 会包含 `generationConfig`，同一个 seed 和配置可以复现同一张架空地图。

## 当前玩法

- 每局默认 60 分钟，到时自动重开。
- 初始地图有 100 个国家，编号为 1-100。
- 101-200 预留给叛乱国家。
- 国家内部拆分为行省，进攻时逐块填色。
- 小兵是正方形像素块，普通状态在边境内侧缓慢巡逻。
- 玩家加入国家后，国家颜色不变。
- 占领别人后，被占领区域显示控制方颜色。
- 同一个控制方在地图上只显示一个编号；玩家控制方显示编号和昵称。
- 支持多线进攻和防守方反入侵。
- 进攻兵阵亡后会复活并继续原战线，直到目标覆灭或停战。
- 当某个控制方版图超过地图一半后，每分钟有 1% 概率触发随机叛乱。

## 网络对战结构

第一版网络测试只支持一个公共房间 `room-1`：

- 客户端只发送原始指令文本。
- 服务端持有权威 `GameState`。
- 服务端解析并执行 `Command`，每秒 tick 游戏状态。
- 服务端广播 `GameState`、玩家列表和指令聊天记录。
- 玩家由浏览器本地 `clientId` 恢复身份。
- 每个玩家绑定一个 `factionId`，可以是 `1-100` 普通国家，也可以是 `101-200` 叛乱国家。
- 同一个 `factionId` 同一时间只能被一个真实玩家占用。
- 断线后暂不释放国家；同一个 `clientId` 重连后继续控制原势力。

后续正式版可以继续升级为多房间大厅、账号系统、数据库存档、房主/管理员权限，以及 Cloudflare Durable Objects 房间架构。

## GitHub Pages 部署

仓库包含 GitHub Actions workflow：

```text
.github/workflows/deploy-pages.yml
```

推荐设置：

- Pages Source：GitHub Actions
- Actions Variables：
  - `VITE_WS_URL=wss://map-color-war-h5-ws.onrender.com`
  - `VITE_BASE=/map-color-war-h5/`

推送到 `main` 后会自动构建并部署 `dist/`。

## Render WebSocket 部署

仓库包含 Render Blueprint：

```text
render.yaml
```

Render 会使用：

- Build Command：`npm ci`
- Start Command：`npm run server:start`
- Health Check：`/health`

Render 免费服务会休眠，首次连接可能需要等待冷启动。

## 环境变量

前端：

```text
VITE_WS_URL=
VITE_BASE=/
```

服务端 Fantasy 地图：

```text
MAP_GENERATION_SEED=room-1-fantasy
MAP_GENERATION_WORLD_TYPE=continent
MAP_GENERATION_SEA_LEVEL=0.46
MAP_GENERATION_MOUNTAIN_STRENGTH=0.62
MAP_GENERATION_MOISTURE=0.56
MAP_GENERATION_RIVER_COUNT=8
```

线上想固定使用某张 Fantasy 地图时，在 Render 环境变量里设置这些值并重新部署服务即可。
# Azgaar 风格地图生成补充

管理员入口 `?admin=1` 中提供“Azgaar 风格生成”：基于 seed 生成高度图、陆海、山脉、湿度、温度、生物群系和河流，再在宜居陆地上生成 100 个国家。普通玩家默认仍使用本机保存地图；没有保存地图时使用内置中国地图兜底。

服务端可通过以下环境变量固定线上架空地图：

```text
MAP_GENERATION_SEED=room-1-fantasy
MAP_GENERATION_WORLD_TYPE=continent
MAP_GENERATION_SEA_LEVEL=0.46
MAP_GENERATION_MOUNTAIN_STRENGTH=0.62
MAP_GENERATION_MOISTURE=0.56
MAP_GENERATION_TEMPERATURE=0.58
MAP_GENERATION_RIVER_COUNT=8
MAP_GENERATION_VIEW_MODE=mixed
```

`MAP_GENERATION_VIEW_MODE` 支持 `mixed`、`political`、`terrain`，分别对应混合图、政治图、地形图。

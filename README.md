# map-color-war-h5

H5 地图填色对战游戏原型，使用 Vite、TypeScript、Phaser、d3-delaunay 和 polygon-clipping 实现。

当前版本支持本地单机玩法、WebSocket 网络对战测试、GitHub Pages 前端部署配置，以及 Render 后端部署配置。

## 安装

```bash
npm install
```

## 本地单机运行

```bash
npm run dev
```

打开 `http://localhost:5173/`。生产环境如果没有配置 `VITE_WS_URL`，前端会退回单机模式。

## 本地网络对战测试

先启动 WebSocket 权威服务器：

```bash
npm run server:dev
```

再启动前端：

```bash
npm run dev
```

本地开发环境默认连接 `ws://localhost:8787`。打开两个浏览器窗口，分别输入昵称进入游戏，然后用 `加入12`、`加入14` 测试两个玩家同时落座。

健康检查地址：

```text
http://localhost:8787/health
```

## 构建

```bash
npm run build
```

构建会同时检查前端和服务端 TypeScript，并输出前端静态资源到 `dist/`。

## GitHub Pages 前端部署

仓库已包含 GitHub Actions workflow：

```text
.github/workflows/deploy-pages.yml
```

推荐流程：

1. 在 GitHub 创建仓库，建议仓库名为 `map-color-war-h5`。
2. 把本项目推送到仓库的 `main` 分支。
3. 在仓库 Settings -> Pages 里，将 Source 设置为 GitHub Actions。
4. 在仓库 Settings -> Secrets and variables -> Actions -> Variables 中添加：
   - `VITE_WS_URL`: Render 后端地址，例如 `wss://map-color-war-h5-ws.onrender.com`
   - `VITE_BASE`: 可选，默认可用 `/map-color-war-h5/`
5. push 到 `main` 后，GitHub Actions 会自动构建并部署 `dist/`。

如果你的 Pages 地址是项目站点：

```text
https://用户名.github.io/map-color-war-h5/
```

保持 `VITE_BASE=/map-color-war-h5/`。

如果你的仓库是用户主页仓库，例如 `用户名.github.io`，则把 `VITE_BASE` 设置为：

```text
/
```

## Render WebSocket 后端部署

仓库已包含 Render Blueprint：

```text
render.yaml
```

Render 部署流程：

1. 把项目推送到 GitHub。
2. 在 Render 中选择 New -> Blueprint。
3. 选择该 GitHub 仓库。
4. Render 会读取 `render.yaml` 并创建 `map-color-war-h5-ws` 服务。
5. 服务启动命令为 `npm run server:start`。
6. 健康检查路径为 `/health`。

部署完成后，Render 会提供类似下面的地址：

```text
https://map-color-war-h5-ws.onrender.com
```

前端 WebSocket 地址需要使用 `wss://`：

```text
wss://map-color-war-h5-ws.onrender.com
```

把这个值填到 GitHub 仓库变量 `VITE_WS_URL` 中，再重新运行 GitHub Pages workflow。

Render 免费服务会休眠，首次连接可能需要等待冷启动。测试玩法稳定后，可以把房间服务器迁移到 Cloudflare Workers + Durable Objects。

## 环境变量

本地可复制 `.env.example` 作为参考：

```text
VITE_WS_URL=
VITE_BASE=/
```

说明：

- `VITE_WS_URL`：前端连接的 WebSocket 地址。为空时，生产环境退回单机模式；本地开发默认使用 `ws://localhost:8787`。
- `VITE_BASE`：Vite 静态资源基础路径。GitHub Pages 项目站点通常使用 `/map-color-war-h5/`。

## 玩家流程

普通玩家打开网页后：

1. 输入昵称。
2. 进入地图。
3. 在底部输入 `加入12` 选择国家编号落座。
4. 使用底部指令或快捷按钮进行进攻、结盟、停战。

多人对战时，底部会显示指令聊天区。玩家可以看到其他人输入的指令和服务端返回的系统结果，例如 `无忌(12)：进攻13`。

手机端普通玩家采用纯指令模式：点击输入框唤起虚拟键盘，输入 `加入12`、`进攻13` 等指令后用键盘发送；地图触摸和快捷按钮不会作为游戏操作入口。

管理员地图编辑器入口：

```text
http://localhost:5173/?admin=1
```

普通玩家看不到地图编辑器和编辑按钮。

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

- `加入+编号`：加入一个国家或叛乱国家，例如 `加入12`、`加入101`。
- `进攻+编号`：发起进攻，支持多线进攻。
- `停战+编号`：停止对该目标的战线及对应反入侵。
- `结盟+编号`：与一个国家结盟，最多一个盟友。
- `退出结盟+编号`：退出当前盟友关系。
- `同意结盟+编号`：同意真实玩家国家发来的结盟申请。
- `昵称+文本`：修改昵称，最多 8 个可见字符。

## 当前玩法

- 每局 60 分钟，到时自动重开。
- 每局 100 个初始地图国家，编号 1-100。
- 101-200 预留给叛乱国家。
- 国家内部拆分为多个行省色块，进攻时逐块填色。
- 小兵是正方形像素块，普通状态在边境内侧缓慢巡逻。
- 玩家加入国家后，国家颜色不变；占领别人后，被占领区域显示控制方颜色。
- 同一个控制方在地图上只显示一个编号；玩家控制方显示编号和昵称。
- 支持多线进攻和防守方反入侵。
- 进攻兵阵亡后会复活并继续原战线，直到目标覆灭或停战。
- 当某个控制方版图超过地图一半后，每分钟有 1% 概率触发随机叛乱。

## 网络对战结构

第一版网络测试只支持一个公共房间 `room-1`：

- 客户端只发送原始指令文本，不在本地决定战斗结果。
- 服务端持有权威 `GameState`，解析并执行 `Command`。
- 服务端用 `RoomState` 管理房间、玩家 session、socket 连接和 tick 时间。
- 每个玩家用浏览器本地 `clientId` 恢复身份，并绑定一个 `factionId`。
- `factionId` 可以是普通国家 `1-100`，也可以是叛乱国家 `101-200`。
- 同一个 `factionId` 同一时间只能被一个真实玩家占用。
- 断线后玩家会标记为离线，但暂不释放国家；同一 `clientId` 重连后继续控制原势力。
- 服务端定时 tick 游戏状态并广播 `GameState` 和玩家列表。
- 客户端只负责渲染服务器状态，并根据自己的 `clientId` 显示本人控制范围。
- 房间内最近 80 条指令会作为玩家可见的指令聊天记录随状态广播。

后续正式版可以在当前结构上继续升级为多房间大厅、账号权限、数据库存档、房主/管理员权限，以及 Cloudflare Workers + Durable Objects 房间模型。

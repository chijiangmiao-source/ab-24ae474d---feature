# 禁飞标签 OR-Set 因果回放台

野外无人机编队断网期间，多个地面终端各自维护禁飞标签；回传乱序到达后，每台终端仍须对航线标签收敛到相同结果。本应用以 **点集（dot set）+ 因果上下文（版本向量）** 实现 **observed-remove（OR-Set）** 归并，并提供逐终端、逐步的因果回放可视化。

- 前端：TypeScript + React 单页应用，回放计算在 Web Worker 中执行（核心为纯函数，可在 Node 下直接测试）。
- 交付：Docker Compose 启动的 nginx 静态站点，提供 `/health` 健康路径，宿主机端口可配置。
- 验收：Compose 内 `verify` 服务执行一次（测试 → 构建 → 健康 HTTP 冒烟），以退出码报告结果。

## 一致性模型

- 每条消息是因果事件，事件 id 为 `终端#序号`（序号从 1 连续），即 OR-Set 中的“点”。
- **新增 add**：携带全局唯一点标识 `dot` 与标签载荷 `tag`（元素身份为 `zone`），把 `(zone, 事件id)` 加入点集。
- **撤销 remove**：携带产生时已见上下文 `ctx`，仅清除点集中被 `ctx` 覆盖（产生时已观察到）的同区域点；**未见过的并发新增保留**（add-wins）。
- **因果投递**：来自 `F` 的第 `n` 条消息可应用 ⟺ 本机 `vector[F] = n-1` 且对所有 `U ≠ F` 有 `vector[U] ≥ ctx[U]`；不满足则进入暂存队列，依赖补齐后级联释放。
- **幂等**：已应用或已在暂存队列中的消息再次投递判为重复，状态不变。

## 场景格式

```json
{
  "terminals": ["A", "B"],
  "messages": [
    { "id": "A#1", "kind": "add", "dot": "D-01",
      "tag": { "zone": "Z-1", "lat": 39.9, "lng": 116.4, "radiusKm": 3 },
      "ctx": { "A": 1 } },
    { "id": "A#2", "kind": "remove", "zone": "Z-1", "ctx": { "A": 2 } }
  ],
  "inbox": {
    "A": ["A#1", "A#2", "B#1"],
    "B": ["B#1", "A#2", "A#1"]
  }
}
```

校验规则（任一违反即**定位拒绝并清除旧回放**）：

- 终端 2-4 台、标识唯一（**终端标识冲突**拒绝）；
- 事件 id 形如 `终端#序号`，每台终端的序号 1..k 连续；
- **点标识复用但载荷不同**拒绝（同 dot 同载荷视为重复广播，幂等无害）；
- **非法上下文**拒绝：`ctx[自身] ≠ 自身序号`、引用未知终端、负值/非整数、观察到不存在的未来事件、沿链回退（已见集合不可收缩）；
- 收件顺序须覆盖全部消息（保证可收敛），允许重复投递。

## 本地开发

```bash
npm install
npm run dev        # 开发服务器
npm run test:run   # 单元与场景测试（vitest）
npm run build      # tsc 类型检查 + vite 构建
```

## Docker / Compose

```bash
# 启动静态站点（默认宿主机端口 8080，可用 WEB_PORT 覆盖）
WEB_PORT=9000 docker compose up -d --build web
curl http://localhost:9000/health   # -> ok

# 自动验收：测试 + 构建 + 健康 HTTP 冒烟，以退出码报告
docker compose up --build --abort-on-container-exit --exit-code-from verify
echo $?   # 0 = 全部通过
```

`verify` 服务依次执行：`vitest run`（并发新增与撤销收敛、乱序暂存释放、重复投递幂等、非法输入拒绝）→ `tsc + vite build` → 对 `web` 服务的 `/health` 与 `/` 做 HTTP 冒烟，全部通过退出 0，否则非零。

## 目录结构

```
src/crdt/      纯 TS 核心：types / parse(校验) / engine(副本) / replay(回放)
src/worker/    回放计算 Web Worker
src/ui/        React 组件（编辑器、控制条、终端面板、步骤日志）
src/samples.ts 内置样例（并发收敛 / 乱序释放 / 重复幂等）
tests/         vitest 测试
Dockerfile     多阶段：deps / build / verify / web(nginx)
docker-compose.yml  web（健康检查 + 可配端口）与 verify（一次性验收）
```

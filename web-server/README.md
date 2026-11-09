# Rust web-server

独立运行的 Rust 后端，直接支持现有 React 前端的 HTTP/WebSocket 协议。Rust 代码集中在 `witchy-web-server` 一个 crate 中，仓库根目录的 workspace 仅包含该成员，便于从根目录执行 Cargo 命令。

```sh
# 在仓库根目录；使用现有 .env
npm ci
npm run build
cargo run -p witchy-web-server

# 同时启动 Rust 和 Vite 开发服务
npm run dev:rust

# 发布构建
cargo build --release -p witchy-web-server
./target/release/witchy-web-server
```

依赖本地同级代码库 `../akashic/alaya-agent-rs`，由 `web-server/Cargo.toml` 的相对路径引用。需要支持 edition 2024 的 Rust 工具链。Node 服务与 Rust 服务分别启动，默认均监听 `127.0.0.1:3001`，不要同时占用该端口。

`main` 从仓库根目录加载 `.env`，已有环境变量优先。沿用 `HOST`、`PORT`、`INVITE_CODE_SHA256`、`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`、`DEEPSEEK_BOT_THINKING`、`ROOM_LOG_ENABLED`、`ROOM_LOG_DIR`、`RECONNECT_GRACE_MS`、`HEARTBEAT_INTERVAL_MS`、`HEARTBEAT_TIMEOUT_MS` 和四个演出时长变量。未配置邀请码时拒绝访问；未配置模型密钥时可建房但不可开局。

## 模块

`web-server/src/` 参考 world-web-server 的应用装配与按业务划分方式：

- `app.rs`：构造共享服务。
- `router.rs`：注册访问检查、健康检查、WebSocket 和静态资源。
- `access/`：HTTP、WebSocket 邀请码验证与来源检查。
- `rooms/api.rs`：连接、请求校验、限流、心跳和消息收发。
- `rooms/service.rs`：会话绑定、房间生命周期、并行报价，以及 AI 任务和演出调度。
- `rooms/types.rs`、`error.rs`：传输消息与错误。
- `bots/`：AI 人格、决策预算、候选校验和私有记忆，通过类型化游戏快照构建模型上下文。
- `alchemy/`：通过 alaya-agent 的 `ChatCapability` 调用模型，校验模型输出并记录本地日志。
- `gameplay/`：不依赖 HTTP 的游戏规则、类型化阶段与材料、状态投影、可重试合成计划及结算。

状态字段由 `GameRoom` 封装，业务使用只读查询，JSON 状态视图仅用于对外广播。状态变更完成后统一清理会话、调度待执行合成和广播，即使请求最终返回错误也会收尾。

状态变更只持有短时锁；模型调用在锁外执行，按轮次、请求或房间实例验证返回结果。房间销毁会取消在途任务。全员准备后一次扣费，合成重试复用原来的随机判定和成功结果，服务端完成全部演出后才结算。

## 协议与验证

沿用 `/api/access`、`/api/health`、`/ws`，以及 `witchy-v1` / `invite.<hash>` 子协议。请求保持 `{type, requestId, inviteHash, payload}`，响应保持 `session`、`state`、`ack`、`error`、`session_ended`。客户端文件无需修改。

```sh
npm run test:rust
cargo fmt --all -- --check
```

`test:rust` 运行 Rust 测试并构建二进制，再将已有 JavaScript 的游戏集成、邀请码、在线状态和 AI 测试指向 Rust 服务。模型请求使用本地测试服务，不调用真实 DeepSeek。单独指定已构建的二进制可使用 `WITCHY_SERVER_BIN`；涉及固定随机序列或暂停清理的用例还需 `WITCHY_FIXTURE_BIN=target/debug/examples/protocol_fixture`。该独立测试启动器提供与 Node 测试钩子等价的行为，正式服务不读取测试开关。

`config/rules.json`、`materials.json` 与女巫配置在启动时加载，修改后重启即可。

房间、席位及 AI 记忆保存在进程内存，重启后清空；本地模型日志用于诊断，不用于恢复对局。部署时需同时提供 `dist/` 和 `config/`。

日志通过容量 256 的队列交给单个写入任务；队列满时丢弃新日志并告警，磁盘写入不阻塞报价或决策。正常关闭时先停止接收新会话、取消并等待后台任务退出，再等待已入队日志写完。

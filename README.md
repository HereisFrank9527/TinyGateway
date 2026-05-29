# TinyGateway

TinyGateway 是一个本地 LLM 网关，用来统一管理 AI 编程工具的 provider、baseUrl、API key、模型映射、模型列表和 reviewer 检查模型。

它不是普通模型切换器。客户端只连接 TinyGateway，TinyGateway 负责把稳定的本地模型名路由到不同上游，并在需要时把请求和响应交给检查模型审查。

## 当前能力

已实现：

- 本地 HTTP 网关
- Anthropic 风格 `POST /v1/messages`
- OpenAI 风格 `POST /v1/chat/completions`
- `GET /v1/models`
- 多 provider 配置
- API key 本地保存和脱敏展示
- 本地模型映射和热切换
- 从 provider 获取上游 `/v1/models` 并保存到本地配置
- 本地 Web 管理端 `/admin`
- reviewer 配置
- audit / guard / full 相关基础流程
- guard 确认队列
- hold confirmation：原请求可等待管理端 allow/block，确认后自动继续或返回错误
- 攻击模拟虚拟模型：用于验证 reviewer / guard / audit / confirmation 链路
- non-stream 响应基础 redact
- JSONL 审计日志
- SSE 流式响应透传和审计捕获

仍需打磨：

- full 模式出站 confirm/redact 的产品语义
- 流式响应同步审查
- 加密密钥存储
- tray-only 控制器
- 文档和错误提示继续细化

## 启动

项目运行时读取根目录的 `config.json`。仓库里同时保留一份脱敏的 `config.example.json`，以后涉及配置结构的改动要同步更新这两个文件：本地真实值放 `config.json`，提交用的示例值放 `config.example.json`。

第一次使用可以从示例配置复制：

```powershell
Copy-Item config.example.json config.json
```

然后编辑 `config.json`，把 provider 的 `baseUrl` 和 `apiKey` 改成你的真实配置。

朴素命令启动会一直保留：

```powershell
npm start
```

也可以直接运行：

```powershell
node src/server.js
```

打开管理端：

```text
http://127.0.0.1:8787/admin
```

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

模型列表：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/v1/models
```

## 打包便携版

当前最快落地方式是 Windows 便携版，仍依赖本机已安装 Node.js 20+，但用户只需要双击启动脚本：

```powershell
npm run build:portable
```

产物在：

```text
dist/TinyGateway
```

便携版命令：

```text
start.bat       启动服务；如果已运行则直接打开管理端
stop.bat        请求本机服务关闭
restart.bat     先停止再启动
open-admin.bat  打开 http://127.0.0.1:8787/admin
update.bat      从 GitHub Release 下载最新便携包并更新
```

第一次启动会自动从 `config.example.json` 创建 `config.json`。真实 API Key 只写入便携目录里的 `config.json`，不要提交它。便携版停止功能调用本机限定的 `POST /api/admin/shutdown`。

构建脚本会同时生成 GitHub Release 可上传的资产：

```text
dist/TinyGateway-portable.zip
```

自动更新依赖仓库 `HereisFrank9527/TinyGateway` 的 latest release，并查找 `TinyGateway-portable.zip` 或文件名包含 `portable` 的 zip。更新时会保留本地 `config.json`、`logs/` 和 `runtime/`，只覆盖程序文件。

## Claude Code 接入

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8787"
$env:ANTHROPIC_AUTH_TOKEN = "local"
$env:CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1"
claude
```

`ANTHROPIC_AUTH_TOKEN` 在这里仅作为本地占位值。真正的上游 API key 由 TinyGateway 持有。

## 配置结构

核心配置在 `config.json`，提交或分享时参考 `config.example.json`：

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 8787
  },
  "audit": {
    "enabled": true,
    "directory": "logs"
  },
  "reviewer": {
    "enabled": false,
    "mode": "off",
    "context": "response",
    "outboundReview": "off",
    "provider": "",
    "model": "",
    "timeoutMs": 12000,
    "holdTimeoutMs": 120000,
    "failBehavior": "allow",
    "confirmBehavior": "queue"
  },
  "modelMappings": [],
  "providers": []
}
```

## Provider

Provider 表示一个上游服务：

```json
{
  "id": "openai-main",
  "type": "openai",
  "baseUrl": "https://api.openai.com",
  "apiKey": "replace-with-openai-key",
  "models": []
}
```

支持：

- `openai`
- `anthropic`

在管理端点击“获取模型”会请求该 provider 的：

```text
GET /v1/models
```

结果会保存到 `provider.models`，模型映射页会优先使用这些已保存模型。

## 模型映射

客户端看到的是稳定的本地模型名，例如：

```text
sonnet
```

TinyGateway 决定它实际转发到哪个 provider 和 upstream model：

```json
{
  "id": "sonnet",
  "displayName": "Active Sonnet",
  "provider": "anthropic-main",
  "upstreamModel": "claude-sonnet-4-5-20250929"
}
```

修改映射后，下一次请求立即生效。

## 攻击模拟虚拟模型

攻击模拟不是普通 provider，而是 TinyGateway 内置的虚拟模型路由。它只用于验证 reviewer / guard / audit / confirmation 链路。

当前内置场景：

- `startup_poisoning`：启动项投毒模拟
- `prompt_injection`：提示词注入模拟
- `data_exfiltration`：数据外传模拟

通用入口默认模型名：

```text
attack-sim
```

固定场景入口示例：

```text
attack-sim/startup-poisoning
```

客户端可选传入受控参数：

```json
{
  "model": "attack-sim",
  "messages": [
    {
      "role": "user",
      "content": "写一段软件安装说明"
    }
  ],
  "tinygateway": {
    "attackSimulation": {
      "scenario": "prompt_injection",
      "intensity": "medium",
      "insertionStyle": "natural",
      "safeMode": "tool-intent"
    }
  }
}
```

只有 `allowClientParams=true` 时客户端参数才会生效。`tinygateway` 元数据只在本地解析，不会转发给上游模型。

模拟模式：

- `abstract`：抽象风险，只用占位符测试语义识别。
- `inert`：高仿真命令、路径、脚本、密钥形态，但全部不可执行，例如 `example.invalid`、`sk-test-*`、`<SIMULATED_PATH>`。
- `tool-intent`：模拟诱导用户批准 shell、文件写入、网络、git 等工具操作，用于测试 Claude Code / Codex 的确认疲劳场景。
- `lab`：真实攻击链形态的实验室样本，可以包含脚本框架和步骤链，但危险执行点必须为空实现、无效目标或占位符。

模拟期间如果 Claude Code / Codex 弹出任何命令、文件、网络或 git 操作确认，应一律拒绝。攻击模拟报告会根据审计日志聚合最近的模拟请求、场景、强度、模式、reviewer 结果和 guard 决策。

## Reviewer 检查模型

TinyGateway 不做机械审查，不走关键词、路径、命令、正则类兜底。

审查只走 reviewer 模型。

模式：

- `off`：关闭审查
- `audit`：只记录 reviewer 结果，不阻断
- `guard`：入站响应同步审查，可放行、阻断、确认或脱敏

相关配置：

- `context=response`：reviewer 主要看响应
- `context=full`：reviewer 同时看请求和响应上下文
- `outboundReview=off`：不审查出站请求
- `outboundReview=audit`：审查出站请求但不阻断
- `outboundReview=guard`：发往上游前审查
- `confirmBehavior=hold`：挂起原请求，管理端 allow 后自动继续
- `confirmBehavior=queue` / `retry`：返回确认 ID，由客户端带 `x-tinygateway-confirmation` 重试
- `confirmBehavior=allow`：把 confirm 降级为放行
- `confirmBehavior=block`：把 confirm 降级为阻断
- `holdTimeoutMs`：hold 模式等待用户确认的超时，默认 120000 ms

## 确认队列

当 reviewer 返回 `confirm` 时，TinyGateway 会创建确认项，管理端“确认队列”可以选择放行或阻断。

`confirmBehavior=hold` 时，原 HTTP 请求会被挂起；管理端 allow 后原请求自动继续，block 返回 `confirmation_blocked`，超时返回 `confirmation_timeout`。这适合 Claude Code / Codex 这类不方便自动携带确认 header 重试的客户端。

`confirmBehavior=queue` 或 `retry` 时，TinyGateway 会立刻返回：

```text
409 confirmation_required
```

响应里包含 `confirmationId`。用户在管理端 allow 后，客户端需要用相同请求加上 header 重试：

```text
x-tinygateway-confirmation: <confirmationId>
```

## 管理 API

```text
GET  /api/admin/status
GET  /api/admin/config
PUT  /api/admin/config
GET  /api/admin/models
POST /api/admin/providers/:id/models/fetch
GET  /api/admin/audit?limit=100
GET  /api/admin/attack-simulations/report?limit=500
POST /api/admin/shutdown
GET  /api/admin/confirmations
POST /api/admin/confirmations/:id/allow
POST /api/admin/confirmations/:id/block
```

## 审计日志

审计日志写入：

```text
logs/audit.jsonl
```

会记录：

- 请求事件
- 响应事件
- reviewer 结果
- reviewer 错误
- guard 决策
- 阻断事件
- 脱敏事件
- 确认队列事件
- hold 确认使用、阻断和超时事件
- 攻击模拟事件 `attack_simulation`

## 测试

```powershell
npm test
```

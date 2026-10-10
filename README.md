# QQ 机器人桌面端

一个跑在桌面上的 QQ 机器人控制台，三件事：

1. **接 QQ** —— 走 OneBot v11 协议，由 NapCat / LLOneBot 之类的协议端负责登录，本程序负责收发。
2. **接插件市场** —— 内置 NoneBot2 官方插件索引，能搜、能装、能启停，插件跑在独立的 Python 侧车里。
3. **接自定义大模型** —— 任何 OpenAI 兼容端点都能接（DeepSeek / Kimi / 智谱 / vLLM / Ollama / OneAPI…），baseURL 和模型名随便填。

## 先把风险说清楚

- NapCat 是**逆向协议**实现，违反腾讯的服务条款，**存在封号风险**，而且封的是 QQ 号本身。请用一个小号，不要用你的主号。
- 本项目不提供、也不包含任何绕过风控、批量加好友、群发营销的能力。拿它做垃圾信息推广不在设计意图内。
- 模型的 API 密钥只存在你这台机器的本地配置里（Windows 上用 DPAPI 加密），不会上传到任何地方。

## 快速开始

前置：Node 22+、Python 3.10+、一个已经跑起来的 NapCat（或其他 OneBot v11 协议端）。

```bash
npm install
npm start          # 构建并用 Electron 打开
```

首次启动按这个顺序配：

1. **接入**页 —— 协议端选「反向 WS」，本程序默认监听 `ws://127.0.0.1:3001`，在 NapCat 的网络配置里把这个地址填成 WebSocket 服务器；两边令牌保持一致（本机跑可以都留空）。连上之后顶部会出现机器人的 QQ 号。
2. **模型**页 —— 添加一个 OpenAI 兼容端点，填 baseURL、模型名、密钥，「试跑」能出话就说明通了。默认 DeepSeek。
3. **插件市场**页 —— 点「创建 venv 并装依赖」建 Python 侧车环境（没填 Python 解释器路径会自动找 PATH），然后搜插件、安装、启动侧车。

配完之后，群里 @ 机器人就能用内置的 AI 对话；装了市场插件的话，插件自己的命令前缀照常可用（NoneBot 默认是 `/`）。

## 数据是怎么流的

```
QQ 好友/群
   ↕ 腾讯协议（NapCat 负责）
NapCat ──反向 WS──► 主进程 OneBotBridge ──┬──► BotService（内置 AI 管线）──► 上游模型
                                          │                                      ▲
                                          └──► SidecarBridge ──WS──► NoneBot 侧车 ─┘
                                                     （市场插件，只拿得到本机网关令牌）
```

关键设计：**主进程只持有一条 NapCat 连接**，然后自己扮演 OneBot v11 客户端接进侧车。所以 NoneBot 市场的插件**一行都不用改**就能跑——它们以为自己在跟 NapCat 说话。

密钥边界：上游 API 密钥只存在于 Electron 主进程；Python 子进程只能从环境变量拿到**本机网关的令牌**（`QQBOT_GATEWAY_*`），永远看不到真密钥。插件要调模型，走 `http://127.0.0.1:3127/v1`。

## 验证到什么程度

已验证（都在本机真实跑过）：

- `npm test` —— 101 个测试全绿。协议层用真 WS 服务端跑握手/echo 关联/超时；侧车层用假子进程跑退避与崩溃重启；安装器用假 `pip` 跑参数；IPC 层跑越界输入。
- `node scratch/gui-check.mjs` —— 真起 Electron，用 CDP 驱动渲染进程，验证 preload 暴露的 19 个方法、状态/配置往返、真实插件索引检索（"天气" 返回 12 个支持 OneBot v11 的插件），并对每个页签做元素矩形重叠检测。
- `node scratch/app-e2e.mjs` —— **全链路**：假 NapCat ←→ 主进程 ←→ 真实 NoneBot 侧车 ←→ 本地 AI 网关 ←→ 假上游模型。两条路径都验过：市场插件（`/问问` → `send_msg`）和内置 AI 管线（@ 提及 → `send_group_msg`），机器人 QQ 号通过 `get_login_info` 自动识别。全程不碰外网、不碰真实 QQ。

**未验证**：真实 QQ 消息收发。这需要一台装着 NapCat 的机器和一个小号，本环境里没有，所以任何"能聊"的结论都只是推断，不是实测。第一次接真号请从小范围私聊开始。

## 目录

```
src/main/        Electron 主进程：onebot/ 协议层、sidecar/ 侧车与桥、gateway/ AI 网关、
                 plugins/ 索引与安装器、service/ 内置对话管线、ipc.ts 输入校验边界
src/renderer/    React 界面（接入 / 模型 / 提示词 / 插件市场 / 日志）
src/shared/      主进程与界面共用的类型与 IPC 契约
sidecar/         NoneBot2 工程：bot.py 入口、plugins/ 示例插件、requirements.txt
test/            node:test 用例
scripts/build.mjs  esbuild 打包（主进程/preload 出 .cjs，界面出 iife）
scratch/         上面两个验收脚本
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | 只看类型，不产出文件 |
| `npm test` | 全量测试 |
| `npm run build` | 只打包，不启动 |
| `npm start` | 打包并启动 |

## 已知限制

- 侧车按 NoneBot 的默认前缀 `/` 响应命令；把 `command_start` 改成空集合会让所有市场插件的 `on_command` 静默失效，所以没提供这个开关。
- 插件的额外配置（`nonebot-plugin-*` 大多有自己的 `.env` 项）目前需要手工写进 `sidecar/.env`，界面上没有表单。
- 图片/语音/视频**不会真的送给模型**，只转成 `[图片 file=…]` 这类占位符进文本。「支持图片输入」这个勾选只改变系统提示里的能力边界描述（防止模型瞎猜图片内容），勾上它并不会让机器人看图——真要做视觉输入需要先把文件从协议端取回来。
- 没有做 Windows 之外的打包验证（macOS/Linux 代码路径一致，但没实机跑过）。

"""桌面端内置的 NoneBot2 侧车。

由 Electron 主进程以子进程方式启动，所有配置都来自环境变量（不走命令行参数，
避免 API 密钥出现在进程列表里）。它对外只做一件事：在 127.0.0.1 上提供
OneBot v11 反向 WS 服务端，等桌面主进程接进来转发事件与动作。

为什么方向是反的：主进程已经持有 NapCat 的唯一连接。侧车里装的是官方
nonebot.adapters.onebot.v11 适配器，它本身就支持"作为 WS 服务端等待协议端接入"，
于是插件市场的插件无需任何改动就能跑在主进程的连接上。
"""

from __future__ import annotations

import json
import os
import pathlib
import sys

import nonebot
from nonebot.adapters.onebot.v11 import Adapter as OneBotV11Adapter

BASE_DIR = pathlib.Path(__file__).resolve().parent
PLUGINS_FILE = BASE_DIR / "plugins.json"


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def token_or_none(value: str):
    return value if len(value) > 0 else None


nonebot.init(
    driver="~fastapi",
    # 只绑回环：侧车持有 access_token，绝不能监听 0.0.0.0
    host="127.0.0.1",
    port=int(env("QQBOT_SIDECAR_PORT", "3100")),
    onebot_v11_access_token=token_or_none(env("QQBOT_SIDECAR_TOKEN")),
    log_level=env("QQBOT_LOG_LEVEL", "INFO"),
)

driver = nonebot.get_driver()
driver.register_adapter(OneBotV11Adapter)


def load_installed() -> list[str]:
    """读取主进程维护的插件清单。单个插件加载失败不能拖垮整个侧车。"""
    if not PLUGINS_FILE.exists():
        return []
    try:
        names = json.loads(PLUGINS_FILE.read_text(encoding="utf-8"))
    except (ValueError, OSError) as exc:
        print(f"[sidecar] plugins.json 解析失败：{exc}", flush=True)
        return []

    loaded: list[str] = []
    for name in names if isinstance(names, list) else []:
        try:
            if nonebot.load_plugin(str(name)) is None:
                print(f"[sidecar] 插件不可用，已跳过：{name}", flush=True)
                continue
        except Exception as exc:  # noqa: BLE001 插件是第三方代码，任何异常都只跳过它
            print(f"[sidecar] 插件加载失败，已跳过：{name} -> {type(exc).__name__}: {exc}", flush=True)
            continue
        loaded.append(str(name))
    return loaded


loaded_names = load_installed()
print(f"[sidecar] 已加载插件：{', '.join(loaded_names) if loaded_names else '（无）'}", flush=True)
print(f"[sidecar] 反向 WS 服务端就绪：ws://127.0.0.1:{env('QQBOT_SIDECAR_PORT', '3100')}/onebot/v11/ws", flush=True)

app = driver.server_app


if __name__ == "__main__":
    if str(BASE_DIR) not in sys.path:
        sys.path.insert(0, str(BASE_DIR))
    nonebot.run()

"""示例插件：把消息交给桌面端内置的本地 AI 网关。

插件永远拿不到上游模型的 API 密钥——它只持有本机的侧车令牌，
密钥只存在于 Electron 主进程里。这也是"网关放在主进程"这个决定的意义。

命令沿用 NoneBot 默认的 "/" 前缀，即 /问问 你的问题。前缀是 NoneBot 生态的
通用约定，改成 command_start=set() 会让所有市场插件的 on_command 失效
（NoneBot 只按 command_start 里的每个前缀注册匹配项，空集合等于一个都不注册）。
"""

from __future__ import annotations

import os

import httpx
from nonebot import on_command
from nonebot.adapters.onebot.v11 import Message
from nonebot.params import CommandArg

GATEWAY = os.environ.get("QQBOT_GATEWAY_URL", "http://127.0.0.1:3127/v1").rstrip("/")
GATEWAY_TOKEN = os.environ.get("QQBOT_GATEWAY_TOKEN", "")

ask = on_command("问问", priority=10, block=True)


@ask.handle()
async def _(args: Message = CommandArg()) -> None:
    question = args.extract_plain_text().strip()
    if len(question) == 0:
        await ask.finish("要问什么？用法：/问问 你的问题")
        return

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=5.0)) as client:
            response = await client.post(
                f"{GATEWAY}/chat/completions",
                headers={"Authorization": f"Bearer {GATEWAY_TOKEN}"},
                json={
                    "model": "default",
                    "messages": [{"role": "user", "content": question}],
                    "stream": False,
                },
            )
    except httpx.HTTPError as exc:
        await ask.finish(f"连不上本地 AI 网关：{type(exc).__name__}")
        return

    if response.status_code != 200:
        await ask.finish(f"本地 AI 网关返回 {response.status_code}：{response.text[:120]}")
        return

    content = str(response.json()["choices"][0]["message"]["content"])
    await ask.finish(content if len(content) > 0 else "模型没有返回内容")

"""ทดสอบ MCP Server ผ่านโปรโตคอลจริง (ไม่สร้างแคมเปญ — เรียกแค่ list_tools + check_permission)

    python smoke_test.py --agent claude                 # stdio
    python smoke_test.py --url http://127.0.0.1:8002/mcp [--key MCP_HTTP_TOKEN]   # HTTP
"""
import argparse
import asyncio
import json
import sys
from pathlib import Path

from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client
from mcp.client.streamable_http import streamable_http_client

HERE = Path(__file__).resolve().parent


async def exercise(read, write, budget: int) -> None:
    async with ClientSession(read, write) as s:
        await s.initialize()
        tools = await s.list_tools()
        print("tools:", [t.name for t in tools.tools])
        res = await s.call_tool("check_permission", {"daily_budget_thb": budget})
        text = res.content[0].text if res.content else str(res)
        data = json.loads(text)
        print("allowed:", data["allowed"])
        print("reason :", data["reason"])
        for c in data["checks"]:
            print(f"  [{'ผ่าน' if c['ok'] else 'ไม่ผ่าน'}] {c['label']}: {c['detail']}")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", default="claude")
    ap.add_argument("--url")
    ap.add_argument("--key")
    ap.add_argument("--budget", type=int, default=500)
    a = ap.parse_args()
    if a.url:
        url = a.url + (f"?key={a.key}" if a.key else "")
        async with streamable_http_client(url) as streams:
            await exercise(streams[0], streams[1], a.budget)
    else:
        params = StdioServerParameters(command=sys.executable,
                                       args=[str(HERE / "server.py"), "--agent", a.agent], cwd=str(HERE))
        async with stdio_client(params) as (read, write):
            await exercise(read, write, a.budget)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(main())

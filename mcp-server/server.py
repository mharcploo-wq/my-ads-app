"""
server.py — MCP Server สร้างแคมเปญ Facebook (Meta) Ads
รองรับ 3 Agents ในบัญชีโฆษณาเดียวกัน:
    Claude  -> Prefix CLD-    (.env.claude)
    Manus   -> Prefix MANUS-  (.env.manus)
    ChatGPT -> Prefix GPT-    (.env.chatgpt)

วิธีรัน
    python server.py --agent claude                 # stdio  (Claude Code / Claude Desktop)
    python server.py --agent manus   --http         # HTTP   (Manus)    -> http://127.0.0.1:8002/mcp
    python server.py --agent chatgpt --http         # HTTP   (ChatGPT)  -> http://127.0.0.1:8003/mcp
    python server.py --agent claude --test 500      # ทดสอบ check_permission ด้วยงบ 500 บาท แล้วออก

กฎที่ห้ามแหก (บังคับในโค้ด ไม่ใช่แค่ขอร้อง)
    1) ทุกอย่างถูกสร้างเป็น PAUSED เท่านั้น — _graph_post() ปฏิเสธ payload ที่ status ไม่ใช่ PAUSED
    2) create_* ทุกตัวเรียก check_permission ก่อนเสมอ (ไม่ผ่าน = ไม่ยิง API)
    3) Token อ่านจาก .env เท่านั้น และไม่ถูกเขียนลง log
    4) ชื่อ campaign / adset / ad / creative ถูกเติม Prefix อัตโนมัติตาม AGENT_PREFIX
    5) Ad Set ใช้ Advantage+ Audience (targeting_automation.advantage_audience = 1) — อายุสูงสุด/ความสนใจเป็นค่าแนะนำ
    6) ตัวกรองคลังเนื้อหา "ปานกลาง" (FACEBOOK_STANDARD + AN_STANDARD) ทุก Ad Set
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import contextvars
import json
import os
import re
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import requests
from dotenv import dotenv_values

for _stream in (sys.stdout, sys.stderr):   # Windows console ไม่ใช่ UTF-8 — กันภาษาไทยเพี้ยน
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

# ---------------------------------------------------------------------------
# 0) เลือก Agent + โหลด .env  (ต้องทำก่อนอ่านค่า config ทั้งหมด)
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent

AGENT_PREFIX_MAP = {"claude": "CLD-", "manus": "MANUS-", "chatgpt": "GPT-"}
ALLOWED_PREFIXES = list(AGENT_PREFIX_MAP.values())
DEFAULT_HTTP_PORT = {"claude": 8001, "manus": 8002, "chatgpt": 8003}

parser = argparse.ArgumentParser(description="Meta Ads MCP Server (CLD- / MANUS- / GPT-)")
parser.add_argument("--agent", choices=list(AGENT_PREFIX_MAP), default=None,
                    help="เลือก agent (ค่าเริ่มต้นอ่านจาก env AGENT หรือ claude)")
parser.add_argument("--http", action="store_true", help="รันแบบ Streamable HTTP (สำหรับ Manus / ChatGPT)")
parser.add_argument("--host", default=None, help="host สำหรับโหมด HTTP (ค่าเริ่มต้น 127.0.0.1)")
parser.add_argument("--port", type=int, default=None, help="port สำหรับโหมด HTTP")
parser.add_argument("--test", type=int, metavar="BUDGET_THB", default=None,
                    help="ทดสอบ check_permission ด้วยงบที่กำหนดแล้วออก เช่น --test 500")
parser.add_argument("--status", action="store_true", help="(หน้าแอป) พิมพ์สถานะ agent เป็น JSON แล้วออก")
parser.add_argument("--create-json", metavar="PATH", default=None,
                    help="(หน้าแอป) สร้างครบชุดจากไฟล์ JSON แล้วพิมพ์ผลเป็น JSON")
parser.add_argument("--suggest-json", metavar="PATH", default=None,
                    help="(หน้าแอป) ให้ AI คิดความสนใจจากข้อความในไฟล์ JSON แล้วพิมพ์ผลเป็น JSON")
parser.add_argument("--search-json", metavar="PATH", default=None,
                    help="(หน้าแอป) ค้นความสนใจจากคำค้นในไฟล์ JSON (ไม่ใช้ AI) แล้วพิมพ์ผลเป็น JSON")
parser.add_argument("--reach-json", metavar="PATH", default=None,
                    help="(หน้าแอป) ขนาดคนในไทยของความสนใจทั้งชุดจากไฟล์ JSON แล้วพิมพ์ผลเป็น JSON")
parser.add_argument("--lives", action="store_true",
                    help="(หน้าแอป) รายการ Live ที่นัดไว้ล่วงหน้าบนเพจ (ยังไม่เริ่ม) แล้วพิมพ์ผลเป็น JSON")
parser.add_argument("--pages", action="store_true",
                    help="(หน้าแอป) เพจที่ Token ของ agent นี้ลงโฆษณาได้ แล้วพิมพ์ผลเป็น JSON")
parser.add_argument("--page-id", default=None,
                    help="(หน้าแอป · ใช้กับ --lives) เพจที่จะอ่าน — ว่าง = เพจประจำ agent")
parser.add_argument("--live-ad-json", metavar="PATH", default=None,
                    help="(หน้าแอป) เติมโฆษณาให้ชุด Live ที่สร้างไปแล้ว (รูปชวนดู / คลิป Live ที่ออกอากาศ) แล้วพิมพ์ผลเป็น JSON")
parser.add_argument("--adset-json", metavar="PATH", default=None,
                    help="(หน้าแอป) อ่าน/บันทึกความสนใจของ Ad Set ที่สร้างไปแล้ว (เฉพาะที่หยุดอยู่) แล้วพิมพ์ผลเป็น JSON")
parser.add_argument("--portfolio", type=int, default=1,
                    help="(หน้าแอป) พอร์ตโฟลิโอที่ใช้ในคำสั่งนี้ 1 = พอร์ตหลัก · 2–5 = META_PORTFOLIO_n_* ใน .env")
parser.add_argument("--portfolios", action="store_true",
                    help="(หน้าแอป) รายการพอร์ตโฟลิโอของ agent นี้ + สถานะ แล้วพิมพ์ผลเป็น JSON")
parser.add_argument("--insights-summary-json", metavar="PATH", default=None,
                    help="(หน้าแอป) ปุ่ม ✨ หน้าวิเคราะห์โฆษณา: ตัวเลขสรุปจากไฟล์ → Claude สรุป+แนะนำ แล้วพิมพ์ผลเป็น JSON")
parser.add_argument("--ai-poll-json", metavar="PATH", default=None,
                    help="(หน้าแอป · Manus) ถามผลงานคิดความสนใจที่สั่ง Manus ไว้ 1 ครั้ง แล้วพิมพ์ผลเป็น JSON")
parser.add_argument("--ai-stop", metavar="TASK_ID", default=None,
                    help="(หน้าแอป · Manus) ยกเลิกงานคิดความสนใจที่สั่ง Manus ไว้ แล้วพิมพ์ผลเป็น JSON")
parser.add_argument("--check-portfolio", action="store_true",
                    help="(หน้าแอป) ตรวจ token ของพอร์ต (token ใหม่ส่งทาง env PORTFOLIO_CHECK_TOKEN) แล้วพิมพ์ผลเป็น JSON")
ARGS, _ = parser.parse_known_args()

AGENT = (ARGS.agent or os.getenv("AGENT") or "claude").lower()
if AGENT not in AGENT_PREFIX_MAP:
    sys.exit(f"AGENT '{AGENT}' ไม่รองรับ ต้องเป็น claude / manus / chatgpt")

ENV_FILE = BASE_DIR / f".env.{AGENT}"
if not ENV_FILE.exists():
    ENV_FILE = BASE_DIR / ".env"
# ค่าในไฟล์ของ agent ชนะค่าใน shell (กันโทเคน agent อื่นค้างใน shell)
# แต่ค่าที่เว้นว่างในไฟล์จะไม่ไปลบค่าที่ตั้งจาก shell
for _k, _v in (dotenv_values(ENV_FILE) if ENV_FILE.exists() else {}).items():
    if _v not in (None, ""):
        os.environ[_k] = _v

META_ACCESS_TOKEN = os.getenv("META_ACCESS_TOKEN", "").strip()
META_AD_ACCOUNT_ID = os.getenv("META_AD_ACCOUNT_ID", "").strip()   # ต้องขึ้นต้นด้วย act_
META_PAGE_ID = os.getenv("META_PAGE_ID", "").strip()       # เพจประจำ agent (ค่าเริ่มต้น)
META_PIXEL_ID = os.getenv("META_PIXEL_ID", "").strip()             # ใช้เฉพาะ OUTCOME_SALES / OUTCOME_LEADS
# เลขผู้ลงโฆษณาที่ยืนยันตัวตนแล้ว (Meta บังคับสำหรับโฆษณาที่ยิงในไทย) — ดูได้จาก Ad Set เดิมใน Ads Manager
META_VERIFIED_IDENTITY_ID = os.getenv("META_VERIFIED_IDENTITY_ID", "").strip()

# พอร์ตโฟลิโอธุรกิจ — พอร์ต 1 = ค่าข้างบน (พอร์ตหลัก) · พอร์ต 2–5 = token ของ system user ในพอร์ตนั้น
# ตั้งใน .env เป็น META_PORTFOLIO_{n}_TOKEN / _AD_ACCOUNT_ID / _PAGE_ID / _PIXEL_ID / _VERIFIED_IDENTITY_ID
MAX_PORTFOLIO = 5
PORTFOLIO_FIELDS = ("TOKEN", "AD_ACCOUNT_ID", "PAGE_ID", "PIXEL_ID", "VERIFIED_IDENTITY_ID")
MAIN_AD_ACCOUNT_ID = META_AD_ACCOUNT_ID


def _portfolio_cfg(n: int) -> dict[str, str]:
    if n == 1:
        return {"TOKEN": META_ACCESS_TOKEN, "AD_ACCOUNT_ID": META_AD_ACCOUNT_ID, "PAGE_ID": META_PAGE_ID,
                "PIXEL_ID": META_PIXEL_ID, "VERIFIED_IDENTITY_ID": META_VERIFIED_IDENTITY_ID}
    return {f: os.getenv(f"META_PORTFOLIO_{n}_{f}", "").strip() for f in PORTFOLIO_FIELDS}


# หน้าแอปเลือกพอร์ตได้ทีละคำสั่ง (1 คำสั่ง = 1 process) → สลับค่าทั้งชุดตั้งแต่เริ่ม โค้ดสร้างโฆษณาเดิมใช้ต่อได้เลย
# เครื่องมือ MCP (stdio/HTTP) ใช้พอร์ตหลักเสมอ
PORTFOLIO = ARGS.portfolio
if not 1 <= PORTFOLIO <= MAX_PORTFOLIO:
    sys.exit(f"--portfolio ต้องเป็น 1–{MAX_PORTFOLIO}")
if PORTFOLIO != 1:
    if ARGS.http or not any((ARGS.status, ARGS.create_json, ARGS.lives, ARGS.pages, ARGS.check_portfolio)):
        sys.exit("--portfolio ใช้ได้เฉพาะคำสั่งของหน้าแอป (--status / --create-json / --lives / --pages)")
    _pf = _portfolio_cfg(PORTFOLIO)
    META_ACCESS_TOKEN, META_AD_ACCOUNT_ID, META_PAGE_ID = _pf["TOKEN"], _pf["AD_ACCOUNT_ID"], _pf["PAGE_ID"]
    META_PIXEL_ID, META_VERIFIED_IDENTITY_ID = _pf["PIXEL_ID"], _pf["VERIFIED_IDENTITY_ID"]
# ที่มาของ Pixel / เลขยืนยันตัวตน: "env" = ตั้งไว้ · "auto" = ดึงจาก Meta (_auto_portfolio_ids)
PIXEL_SOURCE = "env" if META_PIXEL_ID else None
IDENTITY_SOURCE = "env" if META_VERIFIED_IDENTITY_ID else None

# เพจที่ใช้ยิงในคำขอนี้ — หน้าแอปเลือกเพจอื่นได้ (ผ่าน _use_page ที่ตรวจสิทธิ์ก่อน) · เครื่องมือ MCP ใช้เพจประจำเสมอ
_ACTIVE_PAGE: contextvars.ContextVar[str] = contextvars.ContextVar("active_page", default=META_PAGE_ID)
NO_PAGE = "ยังไม่ได้เลือกเพจ — ตั้งเพจประจำ agent ในหน้าเชื่อมต่อ API"


def _page() -> str:
    return _ACTIVE_PAGE.get()
AGENT_PREFIX = os.getenv("AGENT_PREFIX", AGENT_PREFIX_MAP[AGENT]).strip()
# เพดานที่ตกลงกันไว้ — ตั้งในไฟล์ .env ให้ต่ำกว่านี้ได้ แต่สูงกว่านี้ไม่ได้
HARD_MAX_DAILY_BUDGET_THB = 1000
HARD_MAX_CAMPAIGNS_PER_DAY = 5
MAX_DAILY_BUDGET_THB = min(int(os.getenv("MAX_DAILY_BUDGET_THB", "1000")), HARD_MAX_DAILY_BUDGET_THB)
MAX_CAMPAIGNS_PER_DAY = min(int(os.getenv("MAX_CAMPAIGNS_PER_DAY", "5")), HARD_MAX_CAMPAIGNS_PER_DAY)
DASHBOARD_API_URL = os.getenv("DASHBOARD_API_URL", "").strip()
DASHBOARD_API_SECRET = os.getenv("DASHBOARD_API_SECRET", "").strip()
GRAPH_API_VERSION = os.getenv("GRAPH_API_VERSION", "v21.0").strip()
# AI ที่ใช้คิดความสนใจ (ปุ่ม ✨ ในหน้าแอป) — แต่ละค่ายคิดเอง: claude = Claude · manus = Manus · chatgpt = OpenAI
AI_PROVIDER = {"chatgpt": "openai", "manus": "manus"}.get(AGENT, "anthropic")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
# คีย์ระดับผู้ใช้ (sk-ant-usr-…) ไม่ผูก workspace → ต้องส่ง workspace id ไปกับทุกคำขอ ไม่งั้น Claude ตอบ 400
ANTHROPIC_WORKSPACE_ID = os.getenv("ANTHROPIC_WORKSPACE_ID", "").strip()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
MANUS_API_KEY = os.getenv("MANUS_API_KEY", "").strip()
# Manus: AI_MODEL = ระดับของ agent (lite/standard/max) · ค่าอื่น (เช่นชื่อรุ่น Claude ที่ค้างในไฟล์) → lite
MANUS_PROFILES = ("lite", "standard", "max")
AI_MODEL = os.getenv("AI_MODEL", "").strip() or {"anthropic": "claude-haiku-5-5", "openai": "gpt-4o-mini",
                                                 "manus": "lite"}[AI_PROVIDER]
if AI_PROVIDER == "manus" and AI_MODEL not in MANUS_PROFILES:
    AI_MODEL = "lite"
MCP_HTTP_TOKEN = os.getenv("MCP_HTTP_TOKEN", "").strip()            # กุญแจป้องกันโหมด HTTP
MCP_PUBLIC_HOST = os.getenv("MCP_PUBLIC_HOST", "").strip()          # เช่น xxxx.ngrok-free.app

BASE_URL = f"https://graph.facebook.com/{GRAPH_API_VERSION}"
__version__ = "1.0.1"
REQUIRED_STATUS = "PAUSED"           # ห้ามเปลี่ยน
TH_TZ = timezone(timedelta(hours=7))  # "วันนี้" นับตามเวลาไทย
HTTP_TIMEOUT = 20

ALLOWED_OBJECTIVES = ["OUTCOME_TRAFFIC", "OUTCOME_AWARENESS", "OUTCOME_ENGAGEMENT",
                      "OUTCOME_LEADS", "OUTCOME_SALES"]

LOG_DIR = BASE_DIR / "logs"
AUDIT_FILE = LOG_DIR / f"audit_{AGENT}.jsonl"
_audit_lock = threading.Lock()


def eprint(*a: Any) -> None:
    """พิมพ์ลง stderr เท่านั้น — โหมด stdio ห้ามพิมพ์อะไรลง stdout เพราะจะทำโปรโตคอล MCP พัง"""
    print(*a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# 1) Audit log (JSON Lines, ไม่มี token)
# ---------------------------------------------------------------------------
def log_action(action: str, ok: bool, data: dict[str, Any]) -> None:
    LOG_DIR.mkdir(exist_ok=True)
    entry = {
        "time": datetime.now(TH_TZ).isoformat(timespec="seconds"),
        "agent": AGENT,
        "prefix": AGENT_PREFIX,
        "ad_account": META_AD_ACCOUNT_ID,
        "action": action,
        "ok": ok,
        "data": data,
    }
    with _audit_lock, AUDIT_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _count_campaigns_today_local() -> int:
    if not AUDIT_FILE.exists():
        return 0
    today = datetime.now(TH_TZ).strftime("%Y-%m-%d")
    n = 0
    with AUDIT_FILE.open("r", encoding="utf-8") as f:
        for line in f:
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            # นับแยกต่อบัญชีโฆษณา — บันทึกเก่าที่ไม่มี ad_account เป็นของพอร์ตหลัก
            if e.get("ad_account", MAIN_AD_ACCOUNT_ID) != META_AD_ACCOUNT_ID:
                continue
            if e.get("action") == "create_campaign" and e.get("ok") and str(e.get("time", "")).startswith(today):
                n += 1
    return n


# ---------------------------------------------------------------------------
# 2) Graph API helpers
# ---------------------------------------------------------------------------
def _meta_error(body: Any) -> str:
    if isinstance(body, dict) and "error" in body:
        err = body["error"]
        msg = err.get("error_user_msg") or err.get("message") or "unknown error"
        return f"{msg} (code {err.get('code')}, subcode {err.get('error_subcode')})"
    return str(body)[:300]


def _graph_body(r: requests.Response) -> tuple[bool, Any]:
    """แปลงคำตอบ Meta — ถ้าไม่ใช่ JSON (เช่นหน้า error ของ gateway) เก็บ HTTP status + เนื้อหาไว้เป็นหลักฐาน"""
    try:
        body = r.json()
    except ValueError:
        snippet = " ".join(r.text.split())[:200] or "(ว่าง)"
        return False, {"error": {"message": f"Meta ตอบกลับไม่ใช่ JSON (HTTP {r.status_code}): {snippet}",
                                 "non_json": True}}
    return (r.status_code == 200 and "error" not in body), body


def _graph_get(path: str, params: dict[str, Any] | None = None) -> tuple[bool, Any]:
    p = dict(params or {})
    p["access_token"] = META_ACCESS_TOKEN
    try:
        r = requests.get(f"{BASE_URL}/{path}", params=p, timeout=HTTP_TIMEOUT)
    except Exception as e:  # noqa: BLE001
        return False, {"error": {"message": f"เชื่อมต่อ Meta ไม่ได้: {e}"}}
    return _graph_body(r)


def _graph_post(path: str, data: dict[str, Any]) -> tuple[bool, Any]:
    # ด่านสุดท้าย: ห้ามส่งอะไรที่ไม่ใช่ PAUSED ออกไปเด็ดขาด
    if "status" in data and data["status"] != REQUIRED_STATUS:
        raise RuntimeError("BLOCKED: อนุญาตเฉพาะ status=PAUSED เท่านั้น")
    payload = {k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in data.items()}
    payload["access_token"] = META_ACCESS_TOKEN
    try:
        r = requests.post(f"{BASE_URL}/{path}", data=payload, timeout=HTTP_TIMEOUT)
    except Exception as e:  # noqa: BLE001
        return False, {"error": {"message": f"เชื่อมต่อ Meta ไม่ได้: {e}"}}
    return _graph_body(r)


def _graph_get_all(path: str, params: dict[str, Any], max_pages: int = 20) -> tuple[bool, list[dict], Any]:
    """ดึงทุกหน้า (paging) — คืน (ok, rows, error_body)"""
    ok, body = _graph_get(path, params)
    if not ok:
        return False, [], body
    rows = list(body.get("data", []))
    pages = 1
    nxt = body.get("paging", {}).get("next")
    while nxt and pages < max_pages:
        try:
            body = requests.get(nxt, timeout=HTTP_TIMEOUT).json()
        except Exception as e:  # noqa: BLE001
            return False, rows, {"error": {"message": str(e)}}
        if "error" in body:
            return False, rows, body
        rows.extend(body.get("data", []))
        nxt = body.get("paging", {}).get("next")
        pages += 1
    return True, rows, None


def with_prefix(name: str) -> str:
    name = (name or "").strip()
    for p in ALLOWED_PREFIXES:          # กันชื่อติด prefix ซ้ำ / ติด prefix ของ agent อื่น
        if name.upper().startswith(p):
            name = name[len(p):].lstrip()
            break
    return f"{AGENT_PREFIX}{name}"


def _prefix_filter() -> str:
    return json.dumps([{"field": "name", "operator": "CONTAIN", "value": AGENT_PREFIX}])


# ---------------------------------------------------------------------------
# 3) check_permission — หัวใจของระบบ
# ---------------------------------------------------------------------------
def _run_checks(daily_budget_thb: int | None, count_campaigns: bool) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []

    def add(key: str, label: str, ok: bool, detail: str) -> bool:
        checks.append({"key": key, "label": label, "ok": ok, "detail": detail})
        return ok

    # 3.1 config / prefix
    cfg_problems = []
    if AGENT_PREFIX not in ALLOWED_PREFIXES:
        cfg_problems.append(f"AGENT_PREFIX '{AGENT_PREFIX}' ไม่อยู่ใน {ALLOWED_PREFIXES}")
    elif AGENT_PREFIX != AGENT_PREFIX_MAP[AGENT]:
        cfg_problems.append(f"agent '{AGENT}' ต้องใช้ prefix {AGENT_PREFIX_MAP[AGENT]} ไม่ใช่ {AGENT_PREFIX}")
    if not META_ACCESS_TOKEN or "ใส่" in META_ACCESS_TOKEN:
        cfg_problems.append("ยังไม่ได้ใส่ META_ACCESS_TOKEN ใน .env")
    if not META_AD_ACCOUNT_ID.startswith("act_") or not META_AD_ACCOUNT_ID[4:].isdigit():
        cfg_problems.append("META_AD_ACCOUNT_ID ต้องเป็นรูปแบบ act_ตัวเลข")
    add("config", "ค่าใน .env + Prefix", not cfg_problems,
        "; ".join(cfg_problems) or f"agent={AGENT} prefix={AGENT_PREFIX}")

    # 3.2 งบ
    if daily_budget_thb is not None:
        if daily_budget_thb <= 0:
            add("budget", "งบต่อวัน", False, "งบต้องมากกว่า 0 บาท")
        elif daily_budget_thb > MAX_DAILY_BUDGET_THB:
            add("budget", "งบต่อวัน", False,
                f"งบ {daily_budget_thb:,} บาท เกินเพดาน MAX_DAILY_BUDGET_THB {MAX_DAILY_BUDGET_THB:,} บาท")
        else:
            add("budget", "งบต่อวัน", True, f"{daily_budget_thb:,} / เพดาน {MAX_DAILY_BUDGET_THB:,} บาท")

    if cfg_problems:   # config ไม่ผ่าน ไม่ต้องยิง API ต่อ
        return _summarize(checks)

    # 3.3 โทเคน
    ok, me = _graph_get("me", {"fields": "id,name"})
    if not add("token", "โทเคนใช้งานได้", ok,
               f"โทเคนของ {me.get('name') or me.get('id')}" if ok else f"โทเคนใช้ไม่ได้/หมดอายุ: {_meta_error(me)}"):
        return _summarize(checks)

    # 3.4 สิทธิ์บัญชีโฆษณา
    ok, acc = _graph_get(META_AD_ACCOUNT_ID, {"fields": "name,account_status,currency,timezone_name"})
    if not ok:
        add("ad_account", "สิทธิ์เข้าบัญชีโฆษณา", False,
            f"เข้าบัญชี {META_AD_ACCOUNT_ID} ไม่ได้ — เช็ค System User > Add Assets: {_meta_error(acc)}")
        return _summarize(checks)
    status_ok = acc.get("account_status") == 1
    currency_ok = acc.get("currency") == "THB"
    detail = f"{acc.get('name')} ({META_AD_ACCOUNT_ID}) สกุลเงิน {acc.get('currency')}"
    if not status_ok:
        detail += f" — บัญชีไม่ได้อยู่ในสถานะ ACTIVE (account_status={acc.get('account_status')})"
    if not currency_ok:
        detail += " — โปรแกรมนี้คำนวณงบเป็นบาท บัญชีต้องใช้สกุลเงิน THB"
    add("ad_account", "สิทธิ์เข้าบัญชีโฆษณา", status_ok and currency_ok, detail)

    # 3.5 จำนวนแคมเปญวันนี้ (นับจาก Meta จริง + audit log เอาค่าที่มากกว่า)
    if count_campaigns:
        used, src = _campaigns_today()
        add("daily_limit", "จำนวนแคมเปญวันนี้", used < MAX_CAMPAIGNS_PER_DAY,
            f"สร้างแล้ว {used}/{MAX_CAMPAIGNS_PER_DAY} แคมเปญ ({AGENT_PREFIX}, นับจาก {src})"
            + (f" · บัญชี {META_AD_ACCOUNT_ID}" if PORTFOLIO != 1 else ""))
        checks[-1]["used"] = used

    return _summarize(checks)


def _campaigns_today() -> tuple[int, str]:
    """แคมเปญของ agent นี้ที่สร้างวันนี้ในบัญชีโฆษณาปัจจุบัน (นับจาก Meta จริง + audit log เอาค่าที่มากกว่า)"""
    today = datetime.now(TH_TZ).date()
    ok, rows, err = _graph_get_all(f"{META_AD_ACCOUNT_ID}/campaigns",
                                   {"fields": "name,created_time", "filtering": _prefix_filter(), "limit": 200})
    remote = 0
    if ok:
        for c in rows:
            if not c.get("name", "").startswith(AGENT_PREFIX):
                continue
            try:
                created = datetime.strptime(c["created_time"], "%Y-%m-%dT%H:%M:%S%z").astimezone(TH_TZ).date()
            except (KeyError, ValueError):
                continue
            if created == today:
                remote += 1
    used = max(remote, _count_campaigns_today_local())
    return used, ("Meta" if ok else f"audit log (อ่านจาก Meta ไม่ได้: {_meta_error(err)})")


def _summarize(checks: list[dict[str, Any]]) -> dict[str, Any]:
    failed = [c for c in checks if not c["ok"]]
    return {
        "allowed": not failed,
        "reason": "ผ่านทุกเงื่อนไข สร้างแคมเปญได้ (สถานะ PAUSED)" if not failed
                  else " | ".join(f"{c['label']}: {c['detail']}" for c in failed),
        "agent": AGENT,
        "prefix": AGENT_PREFIX,
        "ad_account_id": META_AD_ACCOUNT_ID,
        "max_daily_budget_thb": MAX_DAILY_BUDGET_THB,
        "max_campaigns_per_day": MAX_CAMPAIGNS_PER_DAY,
        "checks": checks,
        "checked_at": datetime.now(TH_TZ).isoformat(timespec="seconds"),
    }


# ---------------------------------------------------------------------------
# 4) Tools (ฟังก์ชันธรรมดา — ลงทะเบียนเข้า MCP ด้านล่าง ทดสอบตรง ๆ ได้)
# ---------------------------------------------------------------------------
def check_permission(daily_budget_thb: int) -> dict[str, Any]:
    """เช็คสิทธิ์ก่อนสร้างแคมเปญ: โทเคนใช้ได้ไหม / มีสิทธิ์บัญชีโฆษณาไหม /
    งบไม่เกิน MAX_DAILY_BUDGET_THB / วันนี้สร้างไม่เกิน MAX_CAMPAIGNS_PER_DAY
    ต้องเรียกก่อนสร้างทุกครั้ง (create_* จะเรียกซ้ำให้เองอีกชั้น)"""
    result = _run_checks(int(daily_budget_thb), count_campaigns=True)
    log_action("check_permission", result["allowed"], {"daily_budget_thb": daily_budget_thb, "reason": result["reason"]})
    return result


def create_campaign(name: str, objective: str, daily_budget_thb: int) -> dict[str, Any]:
    """สร้างแคมเปญสถานะ PAUSED ชื่อจะถูกเติม Prefix อัตโนมัติ
    objective: OUTCOME_TRAFFIC / OUTCOME_AWARENESS / OUTCOME_ENGAGEMENT / OUTCOME_LEADS / OUTCOME_SALES
    daily_budget_thb: งบต่อวันที่ตั้งใจใช้ (ตรวจกับเพดาน — งบจริงตั้งที่ Ad Set)"""
    objective = (objective or "").upper().strip()
    if objective not in ALLOWED_OBJECTIVES:
        return {"success": False, "error": f"objective ต้องเป็นหนึ่งใน {ALLOWED_OBJECTIVES}"}

    perm = _run_checks(int(daily_budget_thb), count_campaigns=True)
    if not perm["allowed"]:
        log_action("create_campaign", False, {"blocked": perm["reason"]})
        return {"success": False, "blocked_by": "check_permission", **perm}

    full_name = with_prefix(name)
    ok, body = _graph_post(f"{META_AD_ACCOUNT_ID}/campaigns", {
        "name": full_name,
        "objective": objective,
        "status": REQUIRED_STATUS,
        "buying_type": "AUCTION",
        "special_ad_categories": [],
        # งบอยู่ที่ระดับ Ad Set (ABO) — Meta บังคับให้ระบุค่านี้ตั้งแต่ปี 2025
        "is_adset_budget_sharing_enabled": "false",
    })
    log_action("create_campaign", ok, {"name": full_name, "objective": objective,
                                       "daily_budget_thb": daily_budget_thb,
                                       "campaign_id": body.get("id") if ok else None,
                                       "error": None if ok else _meta_error(body)})
    if not ok:
        return {"success": False, "error": _meta_error(body)}
    return {"success": True, "campaign_id": body["id"], "name": full_name, "objective": objective,
            "status": REQUIRED_STATUS, "agent": AGENT,
            "next_step": "เรียก create_adset(campaign_id, name, daily_budget_thb)"}


_OPTIMIZATION = {
    "OUTCOME_TRAFFIC": {"optimization_goal": "LINK_CLICKS", "destination_type": "WEBSITE"},
    "OUTCOME_AWARENESS": {"optimization_goal": "REACH"},
    "OUTCOME_ENGAGEMENT": {"optimization_goal": "POST_ENGAGEMENT"},
    "OUTCOME_LEADS": {"optimization_goal": "OFFSITE_CONVERSIONS", "event": "LEAD"},
    "OUTCOME_SALES": {"optimization_goal": "OFFSITE_CONVERSIONS", "event": "PURCHASE"},
}


def _own_object(object_id: str, fields: str) -> tuple[bool, dict[str, Any] | str]:
    """ดึง object แล้วยืนยันว่าเป็นของ agent นี้ (ชื่อขึ้นต้นด้วย prefix ตัวเอง)"""
    ok, obj = _graph_get(object_id, {"fields": fields})
    if not ok:
        return False, f"อ่าน {object_id} ไม่ได้: {_meta_error(obj)}"
    if not str(obj.get("name", "")).startswith(AGENT_PREFIX):
        return False, f"{object_id} ({obj.get('name')}) ไม่ใช่ของ {AGENT_PREFIX} — ห้ามแก้งานของ agent อื่น"
    return True, obj


MESSENGER_LINK = "https://fb.com/messenger_doc/"
MIN_RUN_HOURS = 24                    # Meta: Ad Set งบต่อวันต้องวิ่งอย่างน้อย 24 ชม. ถ้ากำหนดวันสิ้นสุด
# โฆษณา Live สด (การรับรู้) — ชุดโฆษณาวิ่งเฉพาะช่วง Live จึงใช้ "งบรวม" แทนงบรายวัน
LIVE_MIN_HOURS, LIVE_MAX_HOURS, LIVE_DEFAULT_HOURS = 1, 8, 2
LIVE_THB_PER_HOUR = 250               # ทีมตั้งไว้: Live 2 ชม. = 500 บาท → คิดตามสัดส่วนต่อชั่วโมง
LIVE_LEAD_HOURS = 3                   # Meta แนะนำให้ตั้งโฆษณา Live นัดหมายเสร็จก่อนเริ่ม Live อย่างน้อย 3 ชม.
MIN_AGE = 20                          # Meta บังคับอายุขั้นต่ำ 20 ปีสำหรับผู้ชมในไทย
MAX_AGE_MIN = 25                      # Meta: ใช้ Advantage+ Audience ตั้งอายุขั้นต่ำได้ไม่เกิน 25
NO_MAX_AGE = 65                       # อายุสูงสุด 65 = ไม่จำกัด (ไม่ส่ง age_range)
MIN_AGE_MAX, DEFAULT_AGE_MAX = 30, 60 # อายุสูงสุดเลือกได้ 30–65 · Advantage+ รับเป็น "ค่าแนะนำ" (age_range) เท่านั้น
MAX_INTERESTS = 10                    # ความสนใจ (ค่าแนะนำ) ต่อ Ad Set
EXTRA_INTERESTS = {"ความสนใจเพิ่มเติม", "Additional interests"}  # กลุ่มชื่องาน/องค์กรเฉพาะในคลังของ Meta
# ตัวกรองคลังเนื้อหา "ปานกลาง" — โฆษณาในเนื้อหา (คลิป Reels/วิดีโอ) + Audience Network
BRAND_SAFETY = ["FACEBOOK_STANDARD", "AN_STANDARD"]
BRAND_SAFETY_LABEL = "ปานกลาง"
# ภาษาที่เลือกได้ (รหัส locale ของ Meta) — พม่า / ลาว Meta ไม่มีให้เลือก
LANGUAGES: dict[str, tuple[int, str]] = {
    "th": (35, "ไทย"), "en_us": (6, "อังกฤษ (สหรัฐอเมริกา)"), "en_gb": (24, "อังกฤษ (สหราชอาณาจักร)"),
    "zh": (1004, "จีน"), "ja": (11, "ญี่ปุ่น"), "ko": (12, "เกาหลี"), "km": (74, "เขมร"),
    "vi": (27, "เวียดนาม"), "ms": (41, "มาเลย์"),
}
DEFAULT_LANGUAGES = ["th", "en_us", "en_gb"]


# ชิ้นงานโฆษณาแบบไดนามิก (Meta asset_feed_spec): รูป ≤10 · คลิป ≤10 · ข้อความหลัก ≤5 · พาดหัว ≤5 · รวม ≤30
MAX_IMAGES, MAX_VIDEOS, MAX_BODIES, MAX_TITLES, MAX_ASSETS = 10, 10, 5, 5, 30
MAX_VIDEO_MB, MAX_TOTAL_MB = 200, 1024          # ขนาดคลิปต่อไฟล์ / รวมทั้งชุด (กันอัปโหลดนานและกินแรม)
DYNAMIC_KINDS = ["WEBSITE"]                      # ยิงข้อความ + ไดนามิก ยังยืนยันกับ Meta ไม่ได้ → ยังไม่เปิด
VIDEO_TYPES = {".mp4", ".mov", ".m4v"}


def creative_options() -> dict[str, Any]:
    """ค่าจำกัดชิ้นงานสำหรับหน้าแอป (หน้าเว็บแค่แสดง — ตัวเลขอยู่ที่นี่ที่เดียว)"""
    return {
        "max_images": MAX_IMAGES, "max_videos": MAX_VIDEOS, "max_bodies": MAX_BODIES, "max_titles": MAX_TITLES,
        "max_assets": MAX_ASSETS, "max_video_mb": MAX_VIDEO_MB, "max_total_mb": MAX_TOTAL_MB,
        "dynamic_kinds": DYNAMIC_KINDS,
        "dynamic_off_reason": "ชิ้นงานแบบไดนามิกใช้ได้กับโฆษณาพาเข้าเว็บไซต์ (ยิงข้อความยังไม่ได้ยืนยันกับ Meta)",
    }


def ai_info() -> dict[str, Any]:
    """AI ที่ปุ่ม ✨ ของ agent นี้ใช้ — หน้าเว็บแค่แสดง (คีย์ไม่ถูกส่งออกไป)"""
    label, key_name, key = {
        "anthropic": ("Claude", "ANTHROPIC_API_KEY", ANTHROPIC_API_KEY),
        "openai": ("OpenAI", "OPENAI_API_KEY", OPENAI_API_KEY),
        "manus": ("Manus", "MANUS_API_KEY", MANUS_API_KEY),
    }[AI_PROVIDER]
    ready = bool(key)
    missing = None if ready else f"ยังไม่ได้ใส่คีย์ {label} ({key_name}) — ใส่ได้ที่แท็บ \"เชื่อมต่อ API\""
    if ready and AI_PROVIDER == "anthropic" and ANTHROPIC_API_KEY.startswith(USER_KEY_PREFIX) \
            and not ANTHROPIC_WORKSPACE_ID:
        ready, missing = False, CLAUDE_NEEDS_WORKSPACE
    # slow = สั่งงานแล้วรอผล (Manus) — หน้าเว็บแสดงสถานะรอ + ปุ่มยกเลิก
    return {"provider": AI_PROVIDER, "label": label, "model": AI_MODEL, "key_name": key_name, "ready": ready,
            "missing": missing, "slow": AI_PROVIDER == "manus"}


USER_KEY_PREFIX = "sk-ant-usr-"
CLAUDE_NEEDS_WORKSPACE = ("คีย์ Claude นี้เป็นคีย์ระดับผู้ใช้ (sk-ant-usr-…) ต้องใส่ Workspace ID (wrkspc_…) ด้วย — "
                          "ใส่ที่แท็บ \"เชื่อมต่อ API\" · หาได้ที่ platform.claude.com → Settings → Workspaces")


def _api_error_text(body: Any) -> str:
    """ข้อความ error จาก Claude/OpenAI ({"error": {"message": …}}) — ไว้บอกสาเหตุจริงบนจอ"""
    err = body.get("error") if isinstance(body, dict) else None
    return str(err.get("message") or "").strip()[:200] if isinstance(err, dict) else ""


def audience_options() -> dict[str, Any]:
    """ตัวเลือกกลุ่มเป้าหมายสำหรับหน้าแอป (หน้าเว็บแค่แสดง — ช่วงอายุ/รายการภาษาอยู่ที่นี่ที่เดียว)"""
    return {
        "min_age": MIN_AGE, "max_age_min": MAX_AGE_MIN, "default_age": MIN_AGE,
        "min_age_max": MIN_AGE_MAX, "no_max_age": NO_MAX_AGE, "default_age_max": DEFAULT_AGE_MAX,
        "languages": [{"key": k, "label": v[1]} for k, v in LANGUAGES.items()],
        "default_languages": DEFAULT_LANGUAGES,
        "max_interests": MAX_INTERESTS,
        "brand_safety": {"label": BRAND_SAFETY_LABEL, "detail": "โฆษณาในเนื้อหา + Audience Network (ตั้งให้ทุกโฆษณา)"},
        "ai": ai_info(),
        "fixed": "ประเทศไทย · Advantage+ Audience",
    }


def _interest_items(interests: Any) -> tuple[list[dict[str, str]], list[str], str | None]:
    """แยกความสนใจที่ส่งมา → (มี id แล้ว [{id,name}], คำค้นที่ต้องหา id, ข้อผิดพลาด)
    รับได้ทั้ง [{"id","name"}] (จากหน้าแอป) · "6003127206524" (id ล้วน) · "digital marketing" (คำค้น จาก AI ในแชต)"""
    if isinstance(interests, str):
        interests = [x for x in interests.replace("，", ",").split(",")]
    known: list[dict[str, str]] = []
    words: list[str] = []
    for it in interests or []:
        if isinstance(it, dict):
            iid, nm = str(it.get("id", "")).strip(), str(it.get("name", "")).strip()
            if not iid.isdigit():
                return [], [], "ความสนใจต้องมี id เป็นตัวเลขของ Meta"
            known.append({"id": iid, "name": nm or iid})
        elif str(it).strip().isdigit():
            known.append({"id": str(it).strip(), "name": str(it).strip()})
        elif str(it).strip():
            words.append(str(it).strip())
    if len(known) + len(words) > MAX_INTERESTS:
        return [], [], f"ความสนใจใส่ได้ไม่เกิน {MAX_INTERESTS} รายการ"
    return known, words, None


def _search_interests(words: list[str], have: list[dict[str, Any]] | None = None,
                      limit: int = MAX_INTERESTS) -> tuple[list[dict[str, Any]], list[str]]:
    """ค้นคลังความสนใจของ Meta ทีละคำ (ไม่เอาซ้ำ ไม่เอาตัวที่ Meta เลิกใช้) พร้อมชื่อภาษาไทย
    → (ความสนใจ, คำที่หาไม่เจอ)"""
    out = list(have or [])
    seen = {x["id"] for x in out}
    missed: list[str] = []
    pools: list[tuple[str, list[dict[str, Any]]]] = []
    for w in words[:max(0, limit - len(out))]:
        # ค้นด้วยภาษาเดียวกับคำค้น — คำอังกฤษค้นด้วย th_TH จะไม่เจอหมวดหลัก (ชื่อหมวดถูกแปลเป็นไทย)
        # เช่น "coffee" ได้ "Arabic coffee" แทน "Coffee" 535 ล้านคน
        ok, body = _graph_get("search", {"type": "adinterest", "q": w, "limit": 5,
                                         "locale": "en_US" if w.isascii() else "th_TH"})
        pools.append((w, body.get("data", []) if ok else []))
    # ผลค้นยังมีตัวที่ Meta เลิกใช้ปนมา (เช่น Payroll) — ใส่ใน Ad Set แล้วโดนปฏิเสธ code 100/1870247
    valid, th = _interest_validity([str(r.get("id")) for _, c in pools for r in c if r.get("id")])
    for w, found in pools:
        if len(out) >= limit:
            break
        cands = [r for r in found if str(r.get("id")) not in seen and valid.get(str(r.get("id")), True)]
        # ชื่อตรงคำค้น → หมวดหลักที่มีคำตรงกับคำค้น → ตัวที่คำตรงมากสุด (เสมอกันเอาตามลำดับของ Meta)
        # ไม่มีคำตรงเลย = ไม่เอา: Meta ค้นแบบคลุมเครือ เช่น "ERP" ได้ Reptiles · "Business owner" ได้ Air travel
        exact = [r for r in cands if _base_name(r.get("name", "")) == w.strip().lower()]
        scored = [(s, r) for r in cands if (s := _relevance(w, str(r.get("name", "")))) > 0]
        core = [r for _, r in scored if not set(r.get("path") or []) & EXTRA_INTERESTS]
        hit = exact[0] if exact else core[0] if core else \
            max(scored, key=lambda x: x[0])[1] if scored else None
        if not hit:
            missed.append(w)
            continue
        seen.add(str(hit["id"]))
        # ชื่อภาษาไทยให้หน้าแอป (ขอไม่ได้ก็ใช้ชื่ออังกฤษไป)
        out.append({"id": str(hit["id"]), "name": th.get(str(hit["id"])) or hit.get("name", w), "keyword": w,
                    "size_lower": hit.get("audience_size_lower_bound"),
                    "size_upper": hit.get("audience_size_upper_bound")})
    _with_th_reach(out[len(have or []):])
    return out, missed


TH_REACH_AGE_MIN = MIN_AGE   # ขนาดคนในไทย = อายุ 20+ ทั้งประเทศ (ก่อนกรองอายุ/ภาษาของโฆษณา)
TH_REACH_WORKERS = 6         # ถาม Meta พร้อมกันกี่รายการ (รายการละ ~1 วินาที)


def _th_reach(interest_ids: list[str] | None) -> tuple[int, int] | None:
    """คนในไทยที่ Meta ส่งโฆษณาถึงได้ (ต่อเดือน) → (ต่ำ, สูง) · interest_ids = None/[] คือทั้งประเทศ
    หลายรายการ = คนที่สนใจอย่างน้อย 1 อย่าง (OR แบบที่ Ad Set ใช้) · ถาม Meta ไม่ได้ = None"""
    spec: dict[str, Any] = {"geo_locations": {"countries": ["TH"]}, "age_min": TH_REACH_AGE_MIN}
    if interest_ids:
        spec["flexible_spec"] = [{"interests": [{"id": i} for i in interest_ids]}]
    ok, body = _graph_get(f"{META_AD_ACCOUNT_ID}/delivery_estimate",
                          {"targeting_spec": json.dumps(spec), "optimization_goal": "REACH"})
    d = (body.get("data") or [{}])[0] if ok and isinstance(body, dict) else {}
    lo, hi = d.get("estimate_mau_lower_bound"), d.get("estimate_mau_upper_bound")
    return (int(lo), int(hi)) if isinstance(lo, int) and isinstance(hi, int) and hi > 0 else None


def _with_th_reach(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """ใส่ขนาดคนในไทย (th_lower/th_upper) ให้ความสนใจแต่ละรายการ — ถามพร้อมกัน · ถามไม่ได้ก็ข้ามไป"""
    todo = [x for x in items if str(x.get("id", "")).isdigit()]
    if not todo:
        return items
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=TH_REACH_WORKERS) as pool:
        sizes = list(pool.map(lambda x: _th_reach([str(x["id"])]), todo))
    for x, size in zip(todo, sizes):
        if size:
            x["th_lower"], x["th_upper"] = size
    return items


def interests_reach(spec: dict[str, Any]) -> dict[str, Any]:
    """(แถบ "รวมคนในไทย" ในหน้าแอป) ความสนใจทั้งชุด → คนในไทยที่สนใจอย่างน้อย 1 อย่าง เทียบกับทั้งประเทศ
    spec: ids[] (id ความสนใจ)"""
    ids = list(dict.fromkeys(str(i) for i in (spec.get("ids") or []) if str(i).isdigit()))[:MAX_INTERESTS]
    if not ids:
        return {"success": False, "error": "ยังไม่มีความสนใจ"}
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=2) as pool:
        total, everyone = pool.map(_th_reach, [ids, None])
    if not total:
        return {"success": False, "error": "ถามขนาดกลุ่มจาก Meta ไม่ได้ — ลองใหม่อีกครั้ง"}
    share = round(100 * (total[0] + total[1]) / (everyone[0] + everyone[1])) if everyone else None
    return {"success": True, "count": len(ids), "lower": total[0], "upper": total[1], "share": share,
            "age_min": TH_REACH_AGE_MIN}


def _base_name(name: str) -> str:
    """ชื่อความสนใจไม่เอาหมวดในวงเล็บท้าย — "กาแฟ (อาหารและเครื่องดื่ม)" → "กาแฟ" """
    return str(name).split(" (")[0].strip().lower()


def _relevance(word: str, name: str) -> float:
    """คำค้นกับชื่อความสนใจเกี่ยวกันแค่ไหน (0 = ไม่มีคำตรงกันเลย)"""
    w, n = word.strip().lower(), _base_name(name)
    if not w or not n:
        return 0
    if not w.isascii():
        if n.isascii():
            return 0.5   # คำไทยแต่ Meta ไม่มีชื่อไทย (เช่น Accounting software) — เทียบไม่ได้ ให้ผ่านแบบอันดับท้าย
        return 1 if w in n or n in w else 0   # ไทยไม่เว้นวรรคระหว่างคำ → ดูว่าอยู่ในกันและกัน
    stem = lambda t: t[:-1] if len(t) > 3 and t.endswith("s") else t  # noqa: E731
    wt = [stem(t) for t in re.findall(r"[a-z0-9]+", w)]
    nt = [stem(t) for t in re.findall(r"[a-z0-9]+", n)]
    if len(wt) == 1 and len(nt) > 1 and "".join(t[0] for t in nt) == wt[0]:
        return 1   # ตัวย่อ: "ERP" = Enterprise Resource Planning
    score = float(len(set(wt) & set(nt)))
    if not score and any(len(a) >= 3 and a in b for a in wt for b in nt):
        score = 0.5   # อยู่ในคำ เช่น "erp" ใน "OpenERP"
    return score


def _interest_validity(ids: list[str]) -> tuple[dict[str, bool], dict[str, str]]:
    """ถาม Meta ว่าความสนใจแต่ละตัวยังใช้ได้ไหม + ชื่อภาษาไทย → ({id: ใช้ได้}, {id: ชื่อไทย})
    ถาม Meta ไม่ได้ = ไม่รู้ → ไม่ใส่ใน dict (ผู้เรียกถือว่าใช้ได้ ปล่อยให้ Meta ตัดสินตอนสร้าง)"""
    ids = list(dict.fromkeys(i for i in ids if i))
    valid: dict[str, bool] = {}
    th: dict[str, str] = {}
    for i in range(0, len(ids), 50):
        ok, body = _graph_get("search", {"type": "adinterestvalid", "interest_fbid_list": json.dumps(ids[i:i + 50]),
                                         "locale": "th_TH"})
        for r in (body.get("data", []) if ok else []):
            rid = str(r.get("id"))
            if isinstance(r.get("valid"), bool):
                valid[rid] = r["valid"]
            if r.get("name"):
                th[rid] = r["name"]
    return valid, th


def _resolve_interests(interests: Any) -> tuple[list[dict[str, str]], str | None]:
    """ความสนใจที่ส่งมา → [{id,name}] พร้อมใช้ (คำค้นจะถูกค้นหา id จาก Meta)"""
    known, words, err = _interest_items(interests)
    if err:
        return [], err
    if known:  # รายการที่หน้าแอปส่งมาอาจค้างจากก่อนที่ Meta จะเลิกใช้ — บอกก่อนสร้างอะไรลง Meta
        valid, _ = _interest_validity([x["id"] for x in known])
        gone = [x["name"] for x in known if valid.get(x["id"]) is False]
        if gone:
            return [], "ความสนใจที่ Meta เลิกใช้แล้ว: " + ", ".join(gone) + " — ลบออกแล้วลองใหม่"
    if not words:
        return known, None
    found, missed = _search_interests(words, known)
    if missed:
        return [], "หาความสนใจในคลังของ Meta ไม่เจอ: " + ", ".join(missed) + " — ลองคำอื่น (ภาษาอังกฤษมักเจอง่ายกว่า)"
    return [{"id": x["id"], "name": x["name"]} for x in found], None


def _audience(age_min: Any = None, languages: Any = None, age_max: Any = None,
              interests: list[dict[str, str]] | None = None) -> tuple[dict[str, Any], str | None]:
    """ตรวจอายุ/ภาษา/ความสนใจ → (ค่า targeting, ข้อผิดพลาด)
    ไม่ใส่ = อายุ 20–60 (60 เป็นค่าแนะนำ) · ไทย + อังกฤษ US/UK · ไม่มีความสนใจ
    interests ต้องผ่าน _resolve_interests มาก่อน (มี id แล้ว)"""
    try:
        age = MIN_AGE if age_min in (None, "") else int(age_min)
        age_hi = DEFAULT_AGE_MAX if age_max in (None, "") else int(age_max)
    except (TypeError, ValueError):
        return {}, "อายุต้องเป็นตัวเลข"
    if not MIN_AGE <= age <= MAX_AGE_MIN:
        return {}, (f"อายุขั้นต่ำต้องอยู่ระหว่าง {MIN_AGE}–{MAX_AGE_MIN} ปี (Meta: ไทยขั้นต่ำ {MIN_AGE} · "
                    f"Advantage+ ตั้งสูงกว่า {MAX_AGE_MIN} ไม่ได้)")
    if not MIN_AGE_MAX <= age_hi <= NO_MAX_AGE:
        return {}, f"อายุสูงสุดต้องอยู่ระหว่าง {MIN_AGE_MAX}–{NO_MAX_AGE} ปี ({NO_MAX_AGE} = ไม่จำกัด)"
    interests = list(interests or [])
    if len(interests) > MAX_INTERESTS:
        return {}, f"ความสนใจใส่ได้ไม่เกิน {MAX_INTERESTS} รายการ"
    if isinstance(languages, str):
        languages = [x for x in languages.replace("，", ",").split(",")]
    keys = [str(x).strip().lower() for x in (languages or []) if str(x).strip()] or DEFAULT_LANGUAGES
    by_name = {v[1]: k for k, v in LANGUAGES.items()}
    resolved = []
    for k in keys:
        k = k if k in LANGUAGES else by_name.get(k, "")
        if not k:
            return {}, "ภาษาที่ใช้ได้: " + ", ".join(f"{k} ({v[1]})" for k, v in LANGUAGES.items())
        if k not in resolved:
            resolved.append(k)
    targeting: dict[str, Any] = {
        "geo_locations": {"countries": ["TH"]},
        "age_min": age,   # Meta บังคับอายุขั้นต่ำ 20 ปีสำหรับผู้ชมในไทย
        "locales": [LANGUAGES[k][0] for k in resolved],
        "targeting_automation": {"advantage_audience": 1},   # Advantage+ Audience
        "brand_safety_content_filter_levels": BRAND_SAFETY,
    }
    if age_hi < NO_MAX_AGE:
        targeting["age_range"] = [age, age_hi]   # Advantage+ รับอายุสูงสุดเป็นค่าแนะนำเท่านั้น
    if interests:
        targeting["flexible_spec"] = [{"interests": [{"id": x["id"], "name": x["name"]} for x in interests]}]
    ages = f"อายุ {age}–{age_hi} (แนะนำ)" if age_hi < NO_MAX_AGE else f"อายุ {age}+"
    label = f"{ages} · ภาษา " + " / ".join(LANGUAGES[k][1] for k in resolved)
    label += f" · ความสนใจ {len(interests)} รายการ (แนะนำ)" if interests else " · ไม่มีความสนใจ (Meta หาเอง)"
    label += f" · คลังเนื้อหา{BRAND_SAFETY_LABEL}"
    return {"age_min": age, "age_max": age_hi, "interests": interests, "targeting": targeting, "_label": label}, None


def _parse_th_time(value: str) -> datetime:
    """'2026-11-11T08:00' / '2026-11-11 08:00' / ISO มี timezone — ถ้าไม่มี timezone ถือเป็นเวลาไทย"""
    dt = datetime.fromisoformat(value.strip().replace(" ", "T"))
    return dt if dt.tzinfo else dt.replace(tzinfo=TH_TZ)


def _schedule(start_time: str = "", end_time: str = "",
              min_hours: int = MIN_RUN_HOURS) -> tuple[dict[str, str], str | None]:
    """ตรวจและแปลงวันเวลาเผยแพร่ → (payload สำหรับ Meta, ข้อผิดพลาด)
    เว้นว่าง = เริ่มทันทีเมื่อกดเปิด / ไม่มีวันสิ้นสุด
    min_hours: ช่วงสั้นสุด — งบรายวัน Meta บังคับ 24 ชม. · งบรวม (Live) สั้นกว่านั้นได้"""
    out: dict[str, str] = {}
    now = datetime.now(TH_TZ)
    start = None
    try:
        if (start_time or "").strip():
            start = _parse_th_time(start_time)
        end = _parse_th_time(end_time) if (end_time or "").strip() else None
    except ValueError:
        return {}, "รูปแบบวันเวลาไม่ถูกต้อง ใช้แบบ 2026-11-11T08:00 (เวลาไทย)"
    if start:
        if start < now - timedelta(minutes=5):
            return {}, "วันเวลาเริ่มย้อนอดีตไม่ได้"
        out["start_time"] = start.isoformat(timespec="seconds")
    if end:
        base = start or now
        if end < base + timedelta(hours=min_hours):
            return {}, ("วันสิ้นสุดต้องหลังวันเริ่มอย่างน้อย 1 วัน (24 ชั่วโมง)" if min_hours >= 24
                        else f"เวลาสิ้นสุดต้องหลังเวลาเริ่มอย่างน้อย {min_hours} ชั่วโมง")
        out["end_time"] = end.isoformat(timespec="seconds")
    return out, None   # ลิงก์มาตรฐานของ Meta สำหรับโฆษณาส่งข้อความ


def create_adset(campaign_id: str, name: str, daily_budget_thb: int, destination: str = "WEBSITE",
                 start_time: str = "", end_time: str = "",
                 age_min: int = MIN_AGE, languages: list[str] | None = None,
                 age_max: int = DEFAULT_AGE_MAX, interests: list[str] | None = None) -> dict[str, Any]:
    """สร้าง Ad Set สถานะ PAUSED ใต้แคมเปญของ agent นี้
    ใช้ Advantage+ Audience (ประเทศไทย) + ตัวกรองคลังเนื้อหา "ปานกลาง" — งบหน่วยบาท
    destination: "WEBSITE" (ค่าเริ่มต้น) หรือ "MESSENGER" = โฆษณายิงข้อความ ให้คนกดทักแชทเพจ
                 (MESSENGER ใช้กับแคมเปญ OUTCOME_ENGAGEMENT เท่านั้น)
    start_time / end_time: วันเวลาเผยแพร่ (เวลาไทย) เช่น "2026-11-11T08:00" — เว้นว่าง = เริ่มทันทีเมื่อกดเปิด /
                 ไม่มีวันสิ้นสุด · วันเริ่มย้อนอดีตไม่ได้ · วันสิ้นสุดต้องหลังวันเริ่มอย่างน้อย 24 ชม.
    age_min: อายุขั้นต่ำ 20–25 (ค่าเริ่มต้น 20 — Meta: ไทยขั้นต่ำ 20, Advantage+ ตั้งเกิน 25 ไม่ได้)
    age_max: อายุสูงสุด 30–65 (ค่าเริ่มต้น 60 · 65 = ไม่จำกัด) — เป็น "ค่าแนะนำ" ของ Advantage+
    languages: ภาษาของผู้ชม เลือกจาก th, en_us, en_gb, zh, ja, ko, km, vi, ms
               (ไม่ใส่ = th + en_us + en_gb)
    interests: ความสนใจ (ค่าแนะนำ) ไม่เกิน 10 — คิดจากเนื้อหาโฆษณาแล้วส่งเป็นคำค้นสั้น ๆ เช่น
               ["digital marketing", "small business", "ร้านกาแฟ"] ระบบจะค้น id ในคลังของ Meta ให้
               (ภาษาอังกฤษมักเจอง่ายกว่า · หาไม่เจอจะแจ้งกลับให้เปลี่ยนคำ) · ไม่ใส่ = ไม่กำหนด"""
    return _create_adset(campaign_id, name, daily_budget_thb, destination, start_time, end_time, age_min, languages,
                         age_max=age_max, interests=interests)


def _create_adset(campaign_id: str, name: str, daily_budget_thb: int, destination: str = "WEBSITE",
                  start_time: str = "", end_time: str = "", age_min: Any = MIN_AGE, languages: Any = None,
                  dynamic: bool = False, age_max: Any = DEFAULT_AGE_MAX, interests: Any = None,
                  lifetime: bool = False) -> dict[str, Any]:
    """ตัวจริงของ create_adset · dynamic=True = ชิ้นงานโฆษณาแบบไดนามิก (ใช้จากหน้าแอปเท่านั้น
    เพราะ Ad Set แบบนี้ต้องคู่กับโฆษณาแบบ asset_feed_spec ซึ่งเครื่องมือ create_ad ไม่ได้สร้าง)
    lifetime=True = daily_budget_thb เป็น "งบรวมทั้งช่วง" (ใช้กับ Live สั้น ๆ — งบรายวันต้องเปิด 24 ชม.ขึ้นไป)
                    ต้องมีทั้งเวลาเริ่มและสิ้นสุด"""
    destination = (destination or "WEBSITE").upper().strip()
    sched, sched_err = _schedule(start_time, end_time, LIVE_MIN_HOURS if lifetime else MIN_RUN_HOURS)
    if sched_err:
        return {"success": False, "error": sched_err}
    if lifetime and not ("start_time" in sched and "end_time" in sched):
        return {"success": False, "error": "งบรวมต้องกำหนดทั้งเวลาเริ่มและเวลาสิ้นสุด"}
    picked, int_err = _resolve_interests(interests)
    if int_err:
        return {"success": False, "error": int_err}
    aud, aud_err = _audience(age_min, languages, age_max, picked)
    if aud_err:
        return {"success": False, "error": aud_err}
    if destination not in ("WEBSITE", "MESSENGER"):
        return {"success": False, "error": 'destination ต้องเป็น "WEBSITE" หรือ "MESSENGER"'}
    perm = _run_checks(int(daily_budget_thb), count_campaigns=False)
    if not perm["allowed"]:
        log_action("create_adset", False, {"blocked": perm["reason"]})
        return {"success": False, "blocked_by": "check_permission", **perm}

    ok, camp = _own_object(campaign_id, "name,objective")
    if not ok:
        return {"success": False, "error": camp}
    opt = _OPTIMIZATION.get(camp.get("objective", ""), _OPTIMIZATION["OUTCOME_TRAFFIC"])
    if destination == "MESSENGER":
        if camp.get("objective") != "OUTCOME_ENGAGEMENT":
            return {"success": False,
                    "error": "โฆษณายิงข้อความต้องอยู่ใต้แคมเปญ OUTCOME_ENGAGEMENT — สร้างแคมเปญใหม่ด้วย objective นี้"}
        if not _page():
            return {"success": False, "error": NO_PAGE}
        opt = {"optimization_goal": "CONVERSATIONS", "destination_type": "MESSENGER"}

    payload: dict[str, Any] = {
        "name": with_prefix(name),
        "campaign_id": campaign_id,
        ("lifetime_budget" if lifetime else "daily_budget"): int(daily_budget_thb) * 100,   # THB เก็บเป็นสตางค์
        "billing_event": "IMPRESSIONS",
        "optimization_goal": opt["optimization_goal"],
        "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
        "targeting": aud["targeting"],
        "status": REQUIRED_STATUS,
        **sched,
    }
    if "destination_type" in opt:
        payload["destination_type"] = opt["destination_type"]
    if META_VERIFIED_IDENTITY_ID:
        payload["regional_regulated_categories"] = ["VOLUNTARY_VERIFICATION"]
        payload["regional_regulation_identities"] = {
            "universal_beneficiary": META_VERIFIED_IDENTITY_ID,
            "universal_payer": META_VERIFIED_IDENTITY_ID,
        }
    if "event" in opt:
        if not META_PIXEL_ID:
            return {"success": False,
                    "error": f"แคมเปญ {camp.get('objective')} ต้องมี META_PIXEL_ID ใน .env เพื่อวัด conversion"}
        payload["promoted_object"] = {"pixel_id": META_PIXEL_ID, "custom_event_type": opt["event"]}
    if destination == "MESSENGER":
        payload["promoted_object"] = {"page_id": _page()}
    if dynamic:
        if destination not in DYNAMIC_KINDS:
            return {"success": False, "error": creative_options()["dynamic_off_reason"]}
        payload["is_dynamic_creative"] = True

    ok, body = _graph_post(f"{META_AD_ACCOUNT_ID}/adsets", payload)
    log_action("create_adset", ok, {"name": payload["name"], "campaign_id": campaign_id,
                                    "daily_budget_thb": daily_budget_thb, "lifetime": lifetime, **sched, "dynamic": dynamic,
                                    "adset_id": body.get("id") if ok else None,
                                    "error": None if ok else _meta_error(body)})
    if not ok:
        return {"success": False, "error": _meta_error(body)}
    return {"success": True, "adset_id": body["id"], "name": payload["name"], "status": REQUIRED_STATUS,
            "daily_budget_thb": daily_budget_thb, "audience": f"Advantage+ Audience · ประเทศไทย · {aud['_label']}",
            "destination": destination,
            "start_time": sched.get("start_time", "เริ่มทันทีเมื่อกดเปิด"),
            "end_time": sched.get("end_time", "ไม่มีวันสิ้นสุด"),
            "next_step": "เรียก create_ad(adset_id, name, page_post_text, link_url, image_url)"}


def _upload_image(image_url: str) -> tuple[bool, str]:
    """ดาวน์โหลดรูปจาก URL แล้วอัปโหลดเข้า /adimages ได้ image_hash กลับมา"""
    try:
        r = requests.get(image_url, timeout=HTTP_TIMEOUT)
        r.raise_for_status()
    except Exception as e:  # noqa: BLE001
        return False, f"ดาวน์โหลดรูปไม่ได้: {e}"
    if not r.headers.get("content-type", "").startswith("image/"):
        return False, f"URL นี้ไม่ใช่ไฟล์รูป (content-type: {r.headers.get('content-type')})"
    return _upload_image_bytes(r.content)


def _upload_image_bytes(content: bytes) -> tuple[bool, str]:
    """อัปโหลดไฟล์รูปเข้า /adimages ได้ image_hash กลับมา"""
    if len(content) > 30 * 1024 * 1024:
        return False, "รูปใหญ่เกิน 30MB"
    data = {"bytes": base64.b64encode(content).decode("ascii")}
    ok, body = _graph_post(f"{META_AD_ACCOUNT_ID}/adimages", data)
    if not ok and body.get("error", {}).get("non_json"):
        # คำตอบเสียระหว่างทาง ลองใหม่ 1 ครั้ง (อัปโหลดซ้ำได้ hash เดิม ไม่เกิดของซ้ำ)
        time.sleep(3)
        ok, body = _graph_post(f"{META_AD_ACCOUNT_ID}/adimages", data)
    if not ok:
        return False, f"อัปโหลดรูปเข้า Meta ไม่ได้: {_meta_error(body)}"
    images = body.get("images", {})
    first = next(iter(images.values()), {})
    return (True, first["hash"]) if first.get("hash") else (False, f"ไม่ได้ image_hash: {body}")


VIDEO_READY_TIMEOUT = 600   # วินาที — รอ Meta ประมวลผลคลิปได้นานสุด


def _upload_video_file(path: str) -> tuple[bool, dict[str, str] | str]:
    """อัปโหลดไฟล์คลิปเข้า /advideos → รอ Meta ประมวลผลจนพร้อม → คืน {video_id, thumbnail_url}"""
    url = f"https://graph-video.facebook.com/{GRAPH_API_VERSION}/{META_AD_ACCOUNT_ID}/advideos"
    try:
        with open(path, "rb") as f:
            r = requests.post(url, data={"access_token": META_ACCESS_TOKEN, "name": Path(path).name},
                              files={"source": (Path(path).name, f)}, timeout=600)
        body = r.json()
    except Exception as e:  # noqa: BLE001
        return False, f"อัปโหลดคลิปเข้า Meta ไม่ได้: {e}"
    if r.status_code != 200 or "id" not in body:
        return False, f"อัปโหลดคลิปเข้า Meta ไม่ได้: {_meta_error(body)}"
    video_id = body["id"]
    deadline = time.monotonic() + VIDEO_READY_TIMEOUT
    while True:
        ok, info = _graph_get(video_id, {"fields": "status"})
        status = (info.get("status") or {}).get("video_status") if ok else None
        if status == "ready":
            break
        if status == "error":
            return False, f"Meta ประมวลผลคลิป {Path(path).name} ไม่สำเร็จ"
        if time.monotonic() > deadline:
            return False, f"รอ Meta ประมวลผลคลิป {Path(path).name} นานเกิน {VIDEO_READY_TIMEOUT // 60} นาที"
        time.sleep(5)
    ok, th = _graph_get(f"{video_id}/thumbnails", {"fields": "uri,is_preferred"})
    thumbs = th.get("data", []) if ok else []
    pick = next((t for t in thumbs if t.get("is_preferred")), thumbs[0] if thumbs else None)
    if not pick:
        return False, f"ไม่ได้รูปปกของคลิป {Path(path).name} จาก Meta"
    return True, {"video_id": video_id, "thumbnail_url": pick["uri"]}


def _create_dynamic_ad(adset_id: str, name: str, bodies: list[str], titles: list[str], link_url: str,
                       image_hashes: list[str], videos: list[dict[str, str]]) -> dict[str, Any]:
    """โฆษณาแบบไดนามิก: Creative เป็น asset_feed_spec (รูป/คลิป/ข้อความ/พาดหัวหลายแบบ) ใต้ Ad Set ไดนามิก"""
    perm = _run_checks(None, count_campaigns=False)
    if not perm["allowed"]:
        log_action("create_ad", False, {"blocked": perm["reason"]})
        return {"success": False, "blocked_by": "check_permission", **perm}
    if not _page():
        return {"success": False, "error": NO_PAGE}
    ok, adset = _own_object(adset_id, "name,is_dynamic_creative,destination_type")
    if not ok:
        return {"success": False, "error": adset}
    if not adset.get("is_dynamic_creative"):
        return {"success": False, "error": "Ad Set นี้ไม่ได้เปิดชิ้นงานแบบไดนามิก"}
    if image_hashes and videos:
        ad_format = "AUTOMATIC_FORMAT"          # Meta: ผสมรูป+คลิปต้องใช้ AUTOMATIC_FORMAT
    else:
        ad_format = "SINGLE_VIDEO" if videos else "SINGLE_IMAGE"
    feed: dict[str, Any] = {
        "bodies": [{"text": b} for b in bodies],
        "link_urls": [{"website_url": link_url}],
        "call_to_action_types": ["LEARN_MORE"],
        "ad_formats": [ad_format],
    }
    if image_hashes:
        feed["images"] = [{"hash": h} for h in image_hashes]
    if videos:
        feed["videos"] = [{"video_id": v["video_id"], "thumbnail_url": v["thumbnail_url"]} for v in videos]
    if titles:
        feed["titles"] = [{"text": t} for t in titles]

    ad_name = with_prefix(name)
    ok, cr = _graph_post(f"{META_AD_ACCOUNT_ID}/adcreatives", {
        "name": f"{ad_name}-Creative",
        "object_story_spec": {"page_id": _page()},
        "asset_feed_spec": feed,
    })
    if not ok:
        log_action("create_ad", False, {"name": ad_name, "step": "creative", "dynamic": True, "error": _meta_error(cr)})
        return {"success": False, "error": f"สร้าง Creative ไม่สำเร็จ: {_meta_error(cr)}"}
    ok, body = _graph_post(f"{META_AD_ACCOUNT_ID}/ads", {
        "name": ad_name,
        "adset_id": adset_id,
        "creative": {"creative_id": cr["id"]},
        "status": REQUIRED_STATUS,
    })
    log_action("create_ad", ok, {"name": ad_name, "adset_id": adset_id, "creative_id": cr["id"], "dynamic": True,
                                 "images": len(image_hashes), "videos": len(videos), "bodies": len(bodies),
                                 "titles": len(titles), "ad_id": body.get("id") if ok else None,
                                 "error": None if ok else _meta_error(body)})
    if not ok:
        return {"success": False, "error": _meta_error(body), "creative_id": cr["id"]}
    return {"success": True, "ad_id": body["id"], "creative_id": cr["id"], "name": ad_name, "status": REQUIRED_STATUS}


def create_ad(adset_id: str, name: str, page_post_text: str, link_url: str, image_url: str) -> dict[str, Any]:
    """สร้างโฆษณา (Creative รูป + ข้อความ + ลิงก์) สถานะ PAUSED ใต้ Ad Set ของ agent นี้
    ถ้า Ad Set เป็นแบบยิงข้อความ (destination MESSENGER) ปุ่มจะเป็น "ส่งข้อความ" และ link_url ไม่ถูกใช้ (ใส่ว่างได้)"""
    return _create_ad(adset_id, name, page_post_text, link_url, lambda: _upload_image(image_url))


def _create_ad(adset_id: str, name: str, page_post_text: str, link_url: str,
               get_image_hash: Callable[[], tuple[bool, str]]) -> dict[str, Any]:
    perm = _run_checks(None, count_campaigns=False)
    if not perm["allowed"]:
        log_action("create_ad", False, {"blocked": perm["reason"]})
        return {"success": False, "blocked_by": "check_permission", **perm}
    if not _page():
        return {"success": False, "error": NO_PAGE}

    ok, adset = _own_object(adset_id, "name,campaign_id,destination_type")
    if not ok:
        return {"success": False, "error": adset}
    messenger = adset.get("destination_type") == "MESSENGER"
    if messenger:
        link_url = MESSENGER_LINK
        cta = {"type": "MESSAGE_PAGE", "value": {"app_destination": "MESSENGER"}}
    else:
        if not (link_url or "").startswith(("http://", "https://")):
            return {"success": False, "error": "link_url ต้องขึ้นต้นด้วย http:// หรือ https://"}
        cta = {"type": "LEARN_MORE", "value": {"link": link_url}}

    ok, image_hash = get_image_hash()
    if not ok:
        return {"success": False, "error": image_hash}

    ad_name = with_prefix(name)
    ok, cr = _graph_post(f"{META_AD_ACCOUNT_ID}/adcreatives", {
        "name": f"{ad_name}-Creative",
        "object_story_spec": {
            "page_id": _page(),
            "link_data": {
                "message": page_post_text,
                "link": link_url,
                "image_hash": image_hash,
                "call_to_action": cta,
            },
        },
    })
    if not ok:
        log_action("create_ad", False, {"name": ad_name, "step": "creative", "error": _meta_error(cr)})
        return {"success": False, "error": f"สร้าง Creative ไม่สำเร็จ: {_meta_error(cr)}"}

    ok, body = _graph_post(f"{META_AD_ACCOUNT_ID}/ads", {
        "name": ad_name,
        "adset_id": adset_id,
        "creative": {"creative_id": cr["id"]},
        "status": REQUIRED_STATUS,
    })
    log_action("create_ad", ok, {"name": ad_name, "adset_id": adset_id, "creative_id": cr["id"],
                                 "ad_id": body.get("id") if ok else None,
                                 "error": None if ok else _meta_error(body)})
    if not ok:
        return {"success": False, "error": _meta_error(body), "creative_id": cr["id"]}
    return {"success": True, "ad_id": body["id"], "creative_id": cr["id"], "name": ad_name,
            "status": REQUIRED_STATUS,
            "note": "โฆษณายังไม่วิ่ง — ตรวจใน Ads Manager แล้วเปิดเองด้วยมือ"}


# ---------------------------------------------------------------------------
# โหมดหน้าแอป (Dashboard → หน้า "สร้างโฆษณา") — เรียกผ่านบรรทัดคำสั่งเท่านั้น
# ไม่เปิดเป็นเครื่องมือ MCP เพราะอ่านไฟล์รูปจากเครื่องได้ (กัน agent ภายนอกดึงไฟล์ในเครื่อง)
# ---------------------------------------------------------------------------
KINDS = {
    # ชนิดโฆษณา: objective ของแคมเปญ + ปลายทางของ Ad Set
    "MESSENGER": ("OUTCOME_ENGAGEMENT", "MESSENGER"),
    "WEBSITE": ("OUTCOME_TRAFFIC", "WEBSITE"),
}


def ad_pages() -> tuple[list[dict[str, Any]], str | None]:
    """เพจที่ Token ของ agent นี้ลงโฆษณาได้ (มีสิทธิ์ ADVERTISE) — ดึงจาก Meta สด ๆ
    แชร์เพจเพิ่มให้ system user ใน Business Settings แล้วจะขึ้นเองทันที"""
    if not META_ACCESS_TOKEN:
        return [], "ยังไม่ได้ใส่ Token"
    ok, rows, err = _graph_get_all("me/accounts", {
        "fields": "id,name,tasks,fan_count,business{name},picture{url},cover{source}", "limit": 100}, max_pages=3)
    if not ok:
        return [], f"อ่านรายการเพจจาก Meta ไม่ได้: {_meta_error(err)}"
    pages = [{"id": str(p["id"]), "name": p.get("name") or str(p["id"]),
              "followers": p.get("fan_count"), "business": (p.get("business") or {}).get("name"),
              "picture": ((p.get("picture") or {}).get("data") or {}).get("url"),
              "cover": (p.get("cover") or {}).get("source")}
             for p in rows if "ADVERTISE" in (p.get("tasks") or [])]
    pages.sort(key=lambda x: (x["id"] != META_PAGE_ID, x["name"]))   # เพจประจำขึ้นก่อน
    return pages, None


def _use_page(page_id: Any) -> tuple[dict[str, Any] | None, str | None]:
    """เลือกเพจที่จะยิงในคำขอนี้ → (ข้อมูลเพจ, None) หรือ (None, ข้อความ error)
    ว่าง = เพจประจำ agent · ระบุมา = ต้องอยู่ในรายการเพจที่ Token ลงโฆษณาได้ (หน้าเว็บส่งอะไรมาก็ตรวจซ้ำที่นี่)"""
    pid = str(page_id or "").strip()
    if not pid:
        if not META_PAGE_ID:
            return None, NO_PAGE
        _ACTIVE_PAGE.set(META_PAGE_ID)
        return {"id": META_PAGE_ID, "name": _page_cover()[0] or META_PAGE_ID}, None
    if not pid.isdigit():
        return None, "เลขเพจไม่ถูกต้อง"
    pages, err = ad_pages()
    if err:
        return None, err
    page = next((p for p in pages if p["id"] == pid), None)
    if not page:
        return None, f"Token ของ {AGENT} ไม่มีสิทธิ์ลงโฆษณาในเพจ {pid} — เลือกเพจจากรายการ"
    _ACTIVE_PAGE.set(pid)
    return {"id": pid, "name": page["name"]}, None


def _page_cover() -> tuple[str | None, str | None]:
    """ชื่อเพจ + ลิงก์รูปปกเพจ (ใช้เป็นรูปโฆษณาเมื่อผู้ใช้ไม่ใส่รูป)"""
    if not _page():
        return None, None
    ok, body = _graph_get(_page(), {"fields": "name,cover"})
    if not ok:
        return None, None
    return body.get("name"), (body.get("cover") or {}).get("source")


def _prepare_image(image_path: Any, image_url: str) -> tuple[bool, str, str]:
    """อัปโหลดรูปโฆษณาเข้า Meta → (ok, image_hash หรือข้อความ error, ที่มาของรูป)
    ลำดับ: ไฟล์จากเครื่อง → ลิงก์รูป → รูปปกเพจ"""
    if image_path:
        try:
            content = Path(image_path).read_bytes()
        except OSError as e:
            return False, f"เปิดไฟล์รูปไม่ได้: {e}", "ไฟล์จากเครื่อง"
        ok, img = _upload_image_bytes(content)
        return ok, img, "ไฟล์จากเครื่อง"
    src = "ลิงก์รูป"
    if not image_url:
        _, image_url = _page_cover()
        src = "รูปปกเพจ"
    if not image_url:
        return False, "ไม่มีรูป และหารูปปกเพจไม่เจอ — ใส่รูปเอง", src
    ok, img = _upload_image(image_url)
    return ok, img, src


def app_status() -> dict[str, Any]:
    """สถานะของ agent นี้สำหรับหน้าแอป: พร้อมไหม / วันนี้เหลือสร้างได้กี่แคมเปญ / ชื่อเพจ"""
    chk = _run_checks(None, count_campaigns=True)
    used = next((c.get("used") for c in chk["checks"] if c["key"] == "daily_limit"), None)
    # ครบโควตาวันนี้ = ตั้งค่าครบแล้ว แค่สร้างเพิ่มวันนี้ไม่ได้ (ยังดึงชื่อ/รูปปกเพจมาโชว์ตัวอย่างได้)
    configured = all(c["ok"] for c in chk["checks"] if c["key"] != "daily_limit")
    page_name, cover = _page_cover() if configured else (None, None)
    pages, pages_err = ad_pages() if META_ACCESS_TOKEN else ([], None)
    checks = chk["checks"] + (_id_checks() if configured else [])
    return {
        "portfolio": PORTFOLIO,
        # พอร์ตหลักบอกรายการพอร์ตทั้งหมดให้ฟอร์มเลือก · พอร์ตอื่นไม่ต้อง (ฟอร์มมีรายการอยู่แล้ว)
        "portfolios": portfolios_list(used) if PORTFOLIO == 1 else None,
        "pages": pages, "pages_error": pages_err, "default_page_id": META_PAGE_ID,
        "agent": AGENT, "prefix": AGENT_PREFIX, "ready": chk["allowed"], "reason": chk["reason"],
        "configured": configured, "quota_full": configured and not chk["allowed"],
        "checks": checks, "max_daily_budget_thb": MAX_DAILY_BUDGET_THB,
        "max_campaigns_per_day": MAX_CAMPAIGNS_PER_DAY,
        "campaigns_today": used, "page_name": page_name, "page_cover": cover,
        "audience": audience_options(),
        "creative": creative_options(),
        "live": live_options(),
    }


# ---------------------------------------------------------------------------
# พอร์ตโฟลิโอธุรกิจ (หน้าแอปเท่านั้น)
# ---------------------------------------------------------------------------
@contextlib.contextmanager
def _as_portfolio(token: str, account: str):
    """ใช้ token/บัญชีของพอร์ตอื่นชั่วคราว (โหมดบรรทัดคำสั่ง 1 process = 1 คำสั่ง ไม่มีงานอื่นแทรก)"""
    global META_ACCESS_TOKEN, META_AD_ACCOUNT_ID
    old = META_ACCESS_TOKEN, META_AD_ACCOUNT_ID
    META_ACCESS_TOKEN, META_AD_ACCOUNT_ID = token, account
    try:
        yield
    finally:
        META_ACCESS_TOKEN, META_AD_ACCOUNT_ID = old


def _find_ids(account: str) -> tuple[str | None, str | None]:
    """Pixel แรกของบัญชีโฆษณา + เลขผู้ลงโฆษณาที่ยืนยันตัวตนจาก Ad Set ล่าสุดที่มี (ไม่เจอ = None)"""
    pixel = identity = None
    ok, body = _graph_get(f"{account}/adspixels", {"fields": "id", "limit": 5})
    if ok and body.get("data"):
        pixel = str(body["data"][0]["id"])
    ok, body = _graph_get(f"{account}/adsets", {"fields": "regional_regulation_identities", "limit": 25})
    for a in (body.get("data") or []) if ok else []:
        v = (a.get("regional_regulation_identities") or {}).get("universal_beneficiary")
        if v:
            identity = str(v)
            break
    return pixel, identity


def _auto_portfolio_ids() -> None:
    """พอร์ตอื่นที่ไม่ได้ตั้ง Pixel / เลขยืนยันตัวตนไว้ → ดึงจาก Meta (ตั้งไว้ในหน้าเชื่อมต่อ API ชนะเสมอ)"""
    global META_PIXEL_ID, META_VERIFIED_IDENTITY_ID, PIXEL_SOURCE, IDENTITY_SOURCE
    if (META_PIXEL_ID and META_VERIFIED_IDENTITY_ID) or not META_ACCESS_TOKEN or not META_AD_ACCOUNT_ID.startswith("act_"):
        return
    pixel, identity = _find_ids(META_AD_ACCOUNT_ID)
    if not META_PIXEL_ID and pixel:
        META_PIXEL_ID, PIXEL_SOURCE = pixel, "auto"
    if not META_VERIFIED_IDENTITY_ID and identity:
        META_VERIFIED_IDENTITY_ID, IDENTITY_SOURCE = identity, "auto"


def _id_checks() -> list[dict[str, Any]]:
    """Pixel / เลขยืนยันตัวตนที่จะใช้ — ไม่มีก็ยังสร้างได้ (warn) จึงไม่นับรวมใน ready"""
    src = {"env": "ตั้งไว้", "auto": "ดึงจาก Meta"}
    return [
        {"key": "pixel", "label": "Pixel", "ok": bool(META_PIXEL_ID), "warn": not META_PIXEL_ID,
         "detail": f"{META_PIXEL_ID} ({src.get(PIXEL_SOURCE, '')})" if META_PIXEL_ID
         else "ไม่มี Pixel ในบัญชีนี้ — ใช้ได้เฉพาะแคมเปญที่ไม่วัด conversion (ตั้งเองได้ที่หน้าเชื่อมต่อ API)"},
        {"key": "identity", "label": "เลขผู้ลงโฆษณาที่ยืนยันตัวตน", "ok": bool(META_VERIFIED_IDENTITY_ID),
         "warn": not META_VERIFIED_IDENTITY_ID,
         "detail": f"{META_VERIFIED_IDENTITY_ID} ({src.get(IDENTITY_SOURCE, '')})" if META_VERIFIED_IDENTITY_ID
         else "ไม่เจอใน Ad Set เดิมของบัญชีนี้ — กรอกได้ที่หน้าเชื่อมต่อ API (Meta อาจถามตอนเผยแพร่)"},
    ]


NO_AD_ACCOUNT = "ยังไม่มีบัญชีโฆษณาที่ token นี้เข้าถึง — สร้างบัญชีโฆษณา (THB) แล้ว assign ให้ system user ในพอร์ตนั้น"


def _account_problem(acc: dict[str, Any]) -> str | None:
    if acc.get("currency") != "THB":
        return f"บัญชีใช้สกุลเงิน {acc.get('currency')} — แอปคิดงบเป็นบาท จึงเลือกไม่ได้"
    if acc.get("account_status") != 1:
        return f"บัญชีโฆษณาไม่ได้เปิดใช้งาน (account_status={acc.get('account_status')})"
    return None


def _token_accounts() -> tuple[bool, list[dict[str, Any]], str | None]:
    """บัญชีโฆษณาที่ token ปัจจุบันเข้าถึง → (ok, รายการ, error)"""
    ok, rows, err = _graph_get_all("me/adaccounts", {
        "fields": "id,name,currency,account_status,business{id,name}", "limit": 50}, max_pages=3)
    if not ok:
        return False, [], f"อ่านบัญชีโฆษณาไม่ได้: {_meta_error(err)}"
    out = [{"id": a["id"], "name": a.get("name") or a["id"], "currency": a.get("currency"),
            "business": (a.get("business") or {}).get("name"), "problem": _account_problem(a)} for a in rows]
    return True, out, None


def _portfolio_summary(n: int, cfg: dict[str, str], used: int | None = None) -> dict[str, Any]:
    """สถานะพอร์ตเดียวสำหรับการ์ดในฟอร์ม — ok = เลือกยิงได้ (ไม่รวมโควตาวันนี้ ซึ่งบอกเป็นตัวเลขแยก)"""
    out: dict[str, Any] = {"slot": n, "main": n == 1, "name": f"พอร์ต {n}", "user": None, "account": None,
                           "ok": False, "reason": None, "campaigns_today": None, "page_id": cfg["PAGE_ID"]}
    if not cfg["TOKEN"]:
        out["reason"] = "ยังไม่ได้ใส่ token ของพอร์ตนี้ — ใส่ที่หน้าเชื่อมต่อ API"
        return out
    with _as_portfolio(cfg["TOKEN"], cfg["AD_ACCOUNT_ID"]):
        ok, me = _graph_get("me", {"fields": "id,name"})
        if not ok:
            out["reason"] = f"Meta ไม่รับ token นี้ — สร้าง token ใหม่จาก system user ({_meta_error(me)})"
            return out
        out["user"] = me.get("name")
        if not cfg["AD_ACCOUNT_ID"]:
            ok, accs, err = _token_accounts()
            biz = next((a["business"] for a in accs if a["business"]), None)
            if biz:
                out["name"] = biz
            out["reason"] = err or ("ยังไม่ได้เลือกบัญชีโฆษณา — เลือกที่หน้าเชื่อมต่อ API" if accs else NO_AD_ACCOUNT)
            return out
        ok, acc = _graph_get(cfg["AD_ACCOUNT_ID"], {"fields": "name,currency,account_status,business{id,name}"})
        if not ok:
            out["reason"] = f"เข้าบัญชี {cfg['AD_ACCOUNT_ID']} ไม่ได้ — assign บัญชีให้ system user ก่อน ({_meta_error(acc)})"
            return out
        out["name"] = (acc.get("business") or {}).get("name") or acc.get("name") or out["name"]
        out["account"] = {"id": cfg["AD_ACCOUNT_ID"], "name": acc.get("name"), "currency": acc.get("currency")}
        out["reason"] = _account_problem(acc)
        out["ok"] = out["reason"] is None
        if out["ok"]:
            out["campaigns_today"] = used if used is not None else _campaigns_today()[0]
    return out


def portfolios_list(main_used: int | None = None) -> list[dict[str, Any]]:
    """พอร์ตหลัก + พอร์ตเพิ่มเติมที่ตั้งไว้ (พอร์ตที่ไม่ได้ตั้งอะไรเลยไม่แสดง)"""
    out = []
    for n in range(1, MAX_PORTFOLIO + 1):
        cfg = _portfolio_cfg(n)
        if n > 1 and not any(cfg.values()):
            continue
        out.append(_portfolio_summary(n, cfg, main_used if n == 1 else None))
    return out


def check_portfolio() -> dict[str, Any]:
    """ปุ่ม "↻ ตรวจ token" ในหน้าเชื่อมต่อ API — token ใหม่ส่งมาทาง env (ไม่ผ่านบรรทัดคำสั่ง) · ว่าง = token ที่บันทึกไว้
    คืนบัญชีโฆษณา (+ Pixel / เลขยืนยันตัวตนที่หาเจอ) และเพจที่ token นี้ใช้ได้ · ไม่ส่ง token กลับ"""
    token = os.environ.pop("PORTFOLIO_CHECK_TOKEN", "").strip() or META_ACCESS_TOKEN
    if not token:
        return {"success": False, "error": "ยังไม่ได้ใส่ token", "accounts": [], "pages": []}
    with _as_portfolio(token, ""):
        ok, me = _graph_get("me", {"fields": "id,name"})
        if not ok:
            return {"success": False, "error": f"Meta ไม่รับ token นี้ — สร้าง token ใหม่จาก system user ({_meta_error(me)})",
                    "accounts": [], "pages": []}
        ok, accs, err = _token_accounts()
        for a in accs:
            a["pixel"], a["identity"] = _find_ids(a["id"]) if not a["problem"] else (None, None)
        pages, pages_err = ad_pages()
    return {"success": ok, "error": err, "user": me.get("name"), "accounts": accs,
            "business": next((a["business"] for a in accs if a["business"]), None)
                        or next((p["business"] for p in pages if p.get("business")), None),
            "pages": pages, "pages_error": pages_err, "no_account": ok and not accs and NO_AD_ACCOUNT or None}


def live_options() -> dict[str, Any]:
    """ค่าที่หน้าแอปใช้กับชนิด Live สด — ให้ server เป็นคนกำหนด หน้าเว็บไม่ตั้งตัวเลขเอง"""
    return {"min_hours": LIVE_MIN_HOURS, "max_hours": LIVE_MAX_HOURS, "default_hours": LIVE_DEFAULT_HOURS,
            "thb_per_hour": LIVE_THB_PER_HOUR, "lead_hours": LIVE_LEAD_HOURS}


def live_events() -> dict[str, Any]:
    """Live ที่นัดไว้ล่วงหน้าบนเพจ (ยังไม่เริ่ม) เรียงจากใกล้สุด
    Facebook เก็บ Live นัดหมายเป็น "กิจกรรมออนไลน์แบบ fb_live" — ตัววิดีโอ Live ยังไม่มีจนกว่าจะเริ่มถ่าย"""
    if not _page():
        return {"success": False, "error": NO_PAGE, "lives": []}
    ok, rows, err = _graph_get_all(f"{_page()}/events", {
        "fields": "id,name,start_time,is_online,online_event_format,is_canceled",
        "time_filter": "upcoming", "limit": 50}, max_pages=3)
    if not ok:
        return {"success": False, "error": f"อ่านรายการ Live ของเพจไม่ได้: {_meta_error(err)}", "lives": []}
    now = datetime.now(TH_TZ)
    lives = []
    for e in rows:
        if e.get("is_canceled") or e.get("online_event_format") != "fb_live":
            continue
        try:
            start = datetime.strptime(e["start_time"], "%Y-%m-%dT%H:%M:%S%z").astimezone(TH_TZ)
        except (KeyError, ValueError):
            continue
        if start <= now:
            continue
        lives.append({"id": e["id"], "name": e.get("name") or "Live", "start_time": start.isoformat(timespec="seconds")})
    lives.sort(key=lambda x: x["start_time"])
    page_name, _ = _page_cover()
    return {"success": True, "lives": lives, "page_name": page_name}


def _schedule_label(sched: dict[str, str]) -> str:
    fmt = lambda v: datetime.fromisoformat(v).astimezone(TH_TZ).strftime("%d/%m/%Y %H:%M")  # noqa: E731
    start = f"เริ่ม {fmt(sched['start_time'])}" if "start_time" in sched else "เริ่มทันทีเมื่อกดเปิด"
    end = f"ถึง {fmt(sched['end_time'])}" if "end_time" in sched else "ไม่มีวันสิ้นสุด"
    return f"{start} {end}"


def _verify_interests(adset_id: str, sent: list[dict[str, Any]]) -> dict[str, Any] | None:
    """อ่านความสนใจกลับจาก Meta หลังสร้าง Ad Set → ขั้น "ความสนใจบน Meta" บนการ์ดผลลัพธ์
    (หลักฐานในแอปว่า Meta เก็บครบ · ไม่ส่งความสนใจไป = ไม่มีอะไรให้ตรวจ → None)"""
    if not sent:
        return None
    ok, body = _graph_get(adset_id, {"fields": "targeting"})
    if not ok:
        return {"key": "verify", "label": "ความสนใจบน Meta", "ok": False,
                "detail": "อ่านกลับจาก Meta ไม่ได้ตอนนี้ — กดปุ่ม \"＋ เพิ่มความสนใจให้ Ad Set นี้\" เพื่อดูเอง"}
    groups = (body.get("targeting") or {}).get("flexible_spec") or []
    on_meta = {str(x.get("id")) for g in groups for x in (g.get("interests") or [])}
    missing = [str(x.get("name") or x.get("id")) for x in sent if str(x.get("id")) not in on_meta]
    got = len(sent) - len(missing)
    if missing:
        return {"key": "verify", "label": "ความสนใจบน Meta", "ok": False,
                "detail": f"Meta บันทึก {got}/{len(sent)} อย่าง · ขาด: {', '.join(missing)}"}
    return {"key": "verify", "label": "ความสนใจบน Meta", "ok": True,
            "detail": f"Meta บันทึกครบ {got}/{len(sent)} อย่าง (อ่านค่าจริงหลังสร้าง)"}


def create_full(spec: dict[str, Any]) -> dict[str, Any]:
    """สร้างครบชุด: check_permission → แคมเปญ → Ad Set → โฆษณา (PAUSED ทั้งหมด) แล้วส่งผลเข้า Dashboard
    spec: kind (MESSENGER/WEBSITE), name, daily_budget_thb, text, link_url?, image_path?, image_url?,
          start_time?, end_time? (เวลาไทย เช่น 2026-11-11T08:00), age_min?, age_max?, languages?,
          interests? [{id,name}] (จากปุ่ม ✨ ในหน้าแอป)
          ชิ้นงานแบบไดนามิก: dynamic=true, image_paths[], video_paths[], texts[], titles[]
          page_id? = เพจที่จะยิง (ว่าง = เพจประจำ agent · ต้องอยู่ในรายการ ad_pages)"""
    steps: list[dict[str, Any]] = []

    def step(key: str, label: str, res: dict[str, Any], detail: str = "") -> bool:
        ok = bool(res.get("success", res.get("allowed")))
        steps.append({"key": key, "label": label, "ok": ok,
                      "detail": detail if ok else (res.get("error") or res.get("reason") or "ไม่สำเร็จ")})
        return ok

    def done(**extra: Any) -> dict[str, Any]:
        # ขั้น "เสริม" ไม่ทำให้ทั้งชุดล้ม: อ่านความสนใจกลับ · โฆษณารูปชวนดู Live (ชุดยังอยู่ เติมโฆษณาทีหลังได้)
        return {"success": all(s["ok"] for s in steps if s["key"] not in SOFT_STEPS), "agent": AGENT,
                "steps": steps, **({"page": page} if page else {}), **extra}

    # เพจที่จะยิง — ตรวจก่อนทุกอย่าง (Live ที่นัดไว้ / รูปปก / ปลายทางแชท ขึ้นกับเพจนี้)
    page, page_err = _use_page(spec.get("page_id"))
    if page_err:
        steps.append({"key": "form", "label": "เพจ", "ok": False, "detail": page_err})
        return done()

    kind = str(spec.get("kind", "")).upper()
    name = str(spec.get("name", "")).strip()
    dynamic = bool(spec.get("dynamic"))
    clean = lambda v: [str(x).strip() for x in (v or []) if str(x).strip()]  # noqa: E731
    texts = clean(spec.get("texts")) if dynamic else []
    titles = clean(spec.get("titles")) if dynamic else []
    image_paths = clean(spec.get("image_paths")) if dynamic else []
    video_paths = clean(spec.get("video_paths")) if dynamic else []
    text = texts[0] if dynamic and texts else str(spec.get("text", "")).strip()
    link_url = str(spec.get("link_url") or "").strip()
    try:
        budget = int(spec.get("daily_budget_thb", 0))
    except (TypeError, ValueError):
        budget = 0
    if kind == "LIVE":
        return _create_full_live(spec, name, budget, step, done)
    problems = []
    if kind not in KINDS:
        problems.append("เลือกชนิดโฆษณา")
    if not name:
        problems.append("ใส่ชื่อแคมเปญ")
    if not text:
        problems.append("ใส่ข้อความโฆษณา")
    if budget <= 0:
        problems.append("ใส่งบต่อวันเป็นตัวเลขมากกว่า 0")
    if kind == "WEBSITE" and not link_url.startswith(("http://", "https://")):
        problems.append("ใส่ลิงก์เว็บไซต์ที่ขึ้นต้นด้วย http:// หรือ https://")
    start_time = str(spec.get("start_time") or "").strip()
    end_time = str(spec.get("end_time") or "").strip()
    sched, sched_err = _schedule(start_time, end_time)
    if sched_err:
        problems.append(sched_err)
    age_min, languages, age_max = spec.get("age_min"), spec.get("languages"), spec.get("age_max")
    interests, int_err = _resolve_interests(spec.get("interests"))
    if int_err:
        problems.append(int_err)
    aud, aud_err = _audience(age_min, languages, age_max, interests)
    if aud_err:
        problems.append(aud_err)
    if dynamic:
        problems += _dynamic_problems(kind, texts, titles, image_paths, video_paths)
    if problems:
        steps.append({"key": "form", "label": "ข้อมูลในฟอร์ม", "ok": False, "detail": " · ".join(problems)})
        return done()
    objective, destination = KINDS[kind]

    # 1) เช็คสิทธิ์ก่อนเสมอ (กฎของระบบ)
    perm = check_permission(budget)
    if not step("check", "เช็คสิทธิ์", perm, "ผ่านทุกเงื่อนไข"):
        return done()

    if dynamic:
        return _create_full_dynamic(name, budget, texts, titles, link_url, image_paths, video_paths,
                                    start_time, end_time, sched, age_min, languages, aud, objective, destination,
                                    step, done)

    # 2) เตรียมรูปก่อนสร้างอะไรใน Meta — รูปพังจะได้ไม่เหลือแคมเปญค้าง
    ok, img, src = _prepare_image(spec.get("image_path"), str(spec.get("image_url") or "").strip())
    if not step("image", "รูปโฆษณา", {"success": ok, "error": img}, f"อัปโหลดแล้ว ({src})"):
        return done()
    image_hash = img

    # 3) แคมเปญ → กลุ่มเป้าหมาย → โฆษณา
    camp = create_campaign(name, objective, budget)
    if not step("campaign", "แคมเปญ", camp, camp.get("name", "")):
        return done()
    adset = _create_adset(camp["campaign_id"], f"{name} - กลุ่มเป้าหมาย", budget, destination, start_time, end_time,
                          age_min, languages, age_max=aud["age_max"], interests=aud["interests"])
    when = _schedule_label(sched)
    who = aud["_label"]
    if not step("adset", "กลุ่มเป้าหมาย", adset, f"งบ {budget:,} บาท/วัน · {who} · {when}"):
        return done(campaign_id=camp["campaign_id"])
    if (chk := _verify_interests(adset["adset_id"], aud["interests"])):
        step(chk["key"], chk["label"], {"success": chk["ok"], "error": chk["detail"]}, chk["detail"])
    ad = _create_ad(adset["adset_id"], f"{name} - โฆษณา", text, link_url, lambda: (True, image_hash))
    if not step("ad", "โฆษณา", ad, "ปุ่ม ส่งข้อความ" if kind == "MESSENGER" else "ปุ่ม ดูเพิ่มเติม"):
        return done(campaign_id=camp["campaign_id"], adset_id=adset["adset_id"])

    # 4) อัปเดตหน้าสรุปผล (ไม่สำเร็จก็ไม่เป็นไร โฆษณาสร้างครบแล้ว)
    dash = send_to_dashboard("last_7d")
    return done(campaign_id=camp["campaign_id"], adset_id=adset["adset_id"], ad_id=ad["ad_id"],
                campaign_name=camp["name"], dashboard_updated=bool(dash.get("delivered")),
                ads_manager_url=f"https://adsmanager.facebook.com/adsmanager/manage/campaigns?act="
                                f"{META_AD_ACCOUNT_ID.removeprefix('act_')}&selected_campaign_ids={camp['campaign_id']}")


SOFT_STEPS = {"verify", "teaser"}


def _live_event_url(live_id: str) -> str:
    return f"https://www.facebook.com/events/{live_id}"


def _live_default_text(live: dict[str, Any]) -> str:
    start = datetime.fromisoformat(live["start_time"]).strftime("%d/%m %H:%M")
    return f"🔴 Live สด \"{live['name']}\" {start} น. — กดติดตามไว้ ไม่พลาด!"


def _live_teaser_ad(adset_id: str, ad_name: str, live: dict[str, Any], text: str, image_hash: str) -> dict[str, Any]:
    """โฆษณารูปชวนดู Live (PAUSED): รูป + ข้อความ + ปุ่ม "ดูเพิ่มเติม" → หน้ากิจกรรม Live
    (API ผูกตัว Live ที่นัดไว้ไม่ได้ — ลอง 13/11/69: นัด Live ผ่าน API → (#3) แอปไม่มีสิทธิ์ Live Video API)"""
    return _create_ad(adset_id, ad_name, text or _live_default_text(live), _live_event_url(live["id"]),
                      lambda: (True, image_hash))


def _create_full_live(spec: dict[str, Any], name: str, budget: int,
                      step: Callable[..., bool], done: Callable[..., dict[str, Any]]) -> dict[str, Any]:
    """create_full ชนิด Live สด · การรับรู้: แคมเปญ OUTCOME_AWARENESS → Ad Set REACH งบรวม ช่วงเวลาเดียวกับ Live
    → โฆษณารูปชวนดู Live (ล้มได้โดยไม่ล้มทั้งชุด) · ตอน Live ออกอากาศ ผู้ใช้กดปุ่มเพิ่มโฆษณาคลิป Live (live_ads mode=live)
    API ผูก Live ที่นัดไว้ล่วงหน้าไม่ได้ (13/11/69: โพสต์กิจกรรม → "ไม่สามารถโปรโมทโน้ตได้" · นัด Live เอง → (#3))
    spec: live_id, live_hours, daily_budget_thb (= งบรวมทั้ง Live), text? (เกี่ยวกับ Live), image_path?, image_url?,
          age_min?, age_max?, languages?, interests?"""
    live_id = str(spec.get("live_id") or "").strip()
    text = str(spec.get("text") or "").strip()
    try:
        hours = int(spec.get("live_hours") or LIVE_DEFAULT_HOURS)
    except (TypeError, ValueError):
        hours = 0
    problems = []
    if not name:
        problems.append("ใส่ชื่อแคมเปญ")
    if budget <= 0:
        problems.append("ใส่งบรวมเป็นตัวเลขมากกว่า 0")
    if not LIVE_MIN_HOURS <= hours <= LIVE_MAX_HOURS:
        problems.append(f"ความยาว Live ต้องอยู่ระหว่าง {LIVE_MIN_HOURS}–{LIVE_MAX_HOURS} ชั่วโมง")
    live = None
    if not live_id:
        problems.append("เลือก Live ที่นัดไว้")
    else:
        found = live_events()
        if not found["success"]:
            problems.append(found["error"])
        else:
            live = next((x for x in found["lives"] if x["id"] == live_id), None)
            if not live:
                problems.append("ไม่พบ Live นี้ในเพจ หรือเริ่มไปแล้ว — กดโหลดรายการ Live ใหม่")
    age_min, languages, age_max = spec.get("age_min"), spec.get("languages"), spec.get("age_max")
    interests, int_err = _resolve_interests(spec.get("interests"))
    if int_err:
        problems.append(int_err)
    aud, aud_err = _audience(age_min, languages, age_max, interests)
    if aud_err:
        problems.append(aud_err)
    if problems or not live:
        steps_detail = " · ".join(problems) or "ข้อมูลไม่ครบ"
        step("form", "ข้อมูลในฟอร์ม", {"success": False, "error": steps_detail})
        return done()

    start = datetime.fromisoformat(live["start_time"])
    end = start + timedelta(hours=hours)
    perm = check_permission(budget)
    if not step("check", "เช็คสิทธิ์", perm, "ผ่านทุกเงื่อนไข"):
        return done()
    # รูปเตรียมก่อนสร้างแคมเปญ — แต่รูปพังไม่หยุดทั้งชุด (ผู้ใช้เลือก 3A: เก็บชุดไว้ แล้วเติมโฆษณาทีหลังได้)
    img_ok, img, img_src = _prepare_image(spec.get("image_path"), str(spec.get("image_url") or "").strip())
    camp = create_campaign(name, "OUTCOME_AWARENESS", budget)
    if not step("campaign", "แคมเปญ", camp, f"{camp.get('name', '')} · การรับรู้"):
        return done()
    adset = _create_adset(camp["campaign_id"], f"{name} - Live", budget, "WEBSITE",
                          start.isoformat(timespec="seconds"), end.isoformat(timespec="seconds"),
                          age_min, languages, age_max=aud["age_max"], interests=aud["interests"], lifetime=True)
    fmt = lambda d: d.strftime("%d/%m/%Y %H:%M")  # noqa: E731
    if not step("adset", "ชุดโฆษณา", adset,
                f"งบรวม {budget:,} บาท · {fmt(start)}–{end.strftime('%H:%M')} ({hours} ชม.) · เข้าถึงคนมากที่สุด · "
                f"{aud['_label']}"):
        return done(campaign_id=camp["campaign_id"])
    if (chk := _verify_interests(adset["adset_id"], aud["interests"])):
        step(chk["key"], chk["label"], {"success": chk["ok"], "error": chk["detail"]}, chk["detail"])
    retry = "ชุดยังอยู่ — กด \"＋ โฆษณา\" ในตารางแคมเปญเพื่อสร้างใหม่"
    ad = (_live_teaser_ad(adset["adset_id"], f"{name} - รูปชวนดู Live", live, text, img) if img_ok
          else {"success": False, "error": img})
    if not ad.get("success"):
        ad = {**ad, "error": f"{ad.get('error') or 'ไม่สำเร็จ'} · {retry}"}
    step("teaser", "โฆษณารูปชวนดู Live", ad, f"หยุดไว้ · {img_src} · ปุ่ม ดูเพิ่มเติม → หน้ากิจกรรม Live")

    act = META_AD_ACCOUNT_ID.removeprefix("act_")
    dash = send_to_dashboard("last_7d")
    return done(
        campaign_id=camp["campaign_id"], adset_id=adset["adset_id"], campaign_name=camp["name"],
        **({"ad_id": ad["ad_id"]} if ad.get("success") else {}),
        dashboard_updated=bool(dash.get("delivered")),
        ads_manager_url=f"https://adsmanager.facebook.com/adsmanager/manage/campaigns?act={act}"
                        f"&selected_campaign_ids={camp['campaign_id']}",
        live_next={
            "live_name": live["name"], "start_time": live["start_time"], "text": text,
            "adset_name": adset["name"],   # ให้ผู้ใช้เทียบชื่อใน Ads Manager — กันเปิดฉบับร่างชุดอื่นแทน
            "adset_url": f"https://adsmanager.facebook.com/adsmanager/manage/adsets/edit?act={act}"
                         f"&selected_campaign_ids={camp['campaign_id']}&selected_adset_ids={adset['adset_id']}",
            "steps": [
                f"กดปุ่มด้านล่าง → เปิดชุดโฆษณา \"{adset['name']}\" ใน Ads Manager (ชื่อต้องตรง และไม่มีป้าย \"เป็นฉบับร่าง\")",
                "เปิดสวิตช์ \"โฆษณาวิดีโอถ่ายทอดสด\" → เลือก \"วิดีโอถ่ายทอดสดที่กำลังจะมาถึง\"",
                f"สร้างโฆษณาในชุดนี้ → ชิ้นงาน \"ใช้รายการที่มีอยู่แล้ว\" → เลือก \"{live['name']}\"",
                "วางข้อความโฆษณา (ปุ่มคัดลอก) → กดเผยแพร่ · ยังหยุดอยู่จนคุณกดเปิด",
            ],
            "lead_hours": LIVE_LEAD_HOURS,
        })


def _dynamic_problems(kind: str, texts: list[str], titles: list[str],
                      image_paths: list[str], video_paths: list[str]) -> list[str]:
    """ตรวจชิ้นงานไดนามิกก่อนยิงอะไรเข้า Meta"""
    p: list[str] = []
    if kind not in DYNAMIC_KINDS:
        p.append(creative_options()["dynamic_off_reason"])
    if not image_paths and not video_paths:
        p.append("ใส่รูปหรือคลิปอย่างน้อย 1 ชิ้น")
    if len(image_paths) > MAX_IMAGES:
        p.append(f"รูปได้ไม่เกิน {MAX_IMAGES} รูป")
    if len(video_paths) > MAX_VIDEOS:
        p.append(f"คลิปได้ไม่เกิน {MAX_VIDEOS} คลิป")
    if len(texts) > MAX_BODIES:
        p.append(f"ข้อความหลักได้ไม่เกิน {MAX_BODIES} แบบ")
    if len(titles) > MAX_TITLES:
        p.append(f"พาดหัวได้ไม่เกิน {MAX_TITLES} แบบ")
    if len(image_paths) + len(video_paths) + len(texts) + len(titles) + 1 > MAX_ASSETS:
        p.append(f"ชิ้นงานรวมเกิน {MAX_ASSETS} ชิ้น")
    total = 0
    for v in video_paths:
        try:
            size = os.path.getsize(v)
        except OSError:
            p.append(f"เปิดไฟล์คลิปไม่ได้: {Path(v).name}")
            continue
        total += size
        if Path(v).suffix.lower() not in VIDEO_TYPES:
            p.append(f"คลิป {Path(v).name} ต้องเป็น MP4 หรือ MOV")
        if size > MAX_VIDEO_MB * 1024 * 1024:
            p.append(f"คลิป {Path(v).name} ใหญ่เกิน {MAX_VIDEO_MB}MB")
    if total > MAX_TOTAL_MB * 1024 * 1024:
        p.append(f"คลิปรวมกันใหญ่เกิน {MAX_TOTAL_MB // 1024}GB")
    return p


def _create_full_dynamic(name: str, budget: int, texts: list[str], titles: list[str], link_url: str,
                         image_paths: list[str], video_paths: list[str], start_time: str, end_time: str,
                         sched: dict[str, str], age_min: Any, languages: Any, aud: dict[str, Any],
                         objective: str, destination: str,
                         step: Callable[..., bool], done: Callable[..., dict[str, Any]]) -> dict[str, Any]:
    """create_full แบบไดนามิก (เช็คสิทธิ์ผ่านแล้ว): อัปโหลดรูปทั้งหมด → อัปโหลดคลิปทั้งหมด → แคมเปญ
    → Ad Set ไดนามิก → โฆษณา"""
    # อัปโหลดชิ้นงานทั้งหมดก่อนสร้างอะไรใน Meta — ชิ้นไหนพังจะได้ไม่เหลือแคมเปญค้าง
    hashes: list[str] = []
    for i, path in enumerate(image_paths, 1):
        try:
            content = Path(path).read_bytes()
        except OSError as e:
            step("images", "รูปโฆษณา", {"success": False, "error": f"เปิดไฟล์รูปที่ {i} ไม่ได้: {e}"})
            return done()
        ok, h = _upload_image_bytes(content)
        if not ok:
            step("images", "รูปโฆษณา", {"success": False, "error": f"รูปที่ {i}: {h}"})
            return done()
        hashes.append(h)
    if image_paths:
        step("images", "รูปโฆษณา", {"success": True}, f"อัปโหลดแล้ว {len(hashes)}/{len(image_paths)} รูป")

    videos: list[dict[str, str]] = []
    for i, path in enumerate(video_paths, 1):
        ok, v = _upload_video_file(path)
        if not ok:
            step("videos", "คลิปโฆษณา", {"success": False, "error": f"คลิปที่ {i}: {v}"})
            return done()
        videos.append(v)  # type: ignore[arg-type]
    if video_paths:
        step("videos", "คลิปโฆษณา", {"success": True},
             f"อัปโหลดแล้ว {len(videos)}/{len(video_paths)} คลิป (Meta ประมวลผลเสร็จแล้ว)")

    camp = create_campaign(name, objective, budget)
    if not step("campaign", "แคมเปญ", camp, camp.get("name", "")):
        return done()
    adset = _create_adset(camp["campaign_id"], f"{name} - กลุ่มเป้าหมาย", budget, destination, start_time, end_time,
                          age_min, languages, dynamic=True, age_max=aud["age_max"], interests=aud["interests"])
    if not step("adset", "กลุ่มเป้าหมาย", adset,
                f"งบ {budget:,} บาท/วัน · {aud['_label']} · {_schedule_label(sched)} · ชิ้นงานแบบไดนามิก"):
        return done(campaign_id=camp["campaign_id"])
    if (chk := _verify_interests(adset["adset_id"], aud["interests"])):
        step(chk["key"], chk["label"], {"success": chk["ok"], "error": chk["detail"]}, chk["detail"])
    ad = _create_dynamic_ad(adset["adset_id"], f"{name} - โฆษณา", texts, titles, link_url, hashes, videos)
    media = " + ".join(x for x in (f"{len(hashes)} รูป" if hashes else "", f"{len(videos)} คลิป" if videos else "") if x)
    if not step("ad", "โฆษณา", ad,
                f"ไดนามิก · {media} · ข้อความหลัก {len(texts)} แบบ · พาดหัว {len(titles)} แบบ · ปุ่ม ดูเพิ่มเติม"):
        return done(campaign_id=camp["campaign_id"], adset_id=adset["adset_id"])

    dash = send_to_dashboard("last_7d")
    return done(campaign_id=camp["campaign_id"], adset_id=adset["adset_id"], ad_id=ad["ad_id"],
                campaign_name=camp["name"], dashboard_updated=bool(dash.get("delivered")),
                ads_manager_url=f"https://adsmanager.facebook.com/adsmanager/manage/campaigns?act="
                                f"{META_AD_ACCOUNT_ID.removeprefix('act_')}&selected_campaign_ids={camp['campaign_id']}")


RESULT_ACTIONS = {
    "purchase", "lead", "complete_registration",
    "offsite_conversion.fb_pixel_purchase", "offsite_conversion.fb_pixel_lead",
    "offsite_conversion.fb_pixel_complete_registration", "onsite_conversion.lead_grouped",
}
DATE_PRESETS = ["today", "yesterday", "last_3d", "last_7d", "last_14d", "last_30d", "this_month", "last_month"]


def send_to_dashboard(date_preset: str = "last_7d") -> dict[str, Any]:
    """ดึงผลรายวันของแคมเปญที่ขึ้นต้นด้วย Prefix ของ agent นี้จาก Meta แล้วส่งเข้า Dashboard
    date_preset: today / yesterday / last_3d / last_7d / last_14d / last_30d / this_month / last_month"""
    if date_preset not in DATE_PRESETS:
        return {"success": False, "error": f"date_preset ต้องเป็นหนึ่งใน {DATE_PRESETS}"}
    perm = _run_checks(None, count_campaigns=False)
    if not perm["allowed"]:
        return {"success": False, "blocked_by": "check_permission", **perm}

    ok, camps, err = _graph_get_all(f"{META_AD_ACCOUNT_ID}/campaigns", {
        "fields": "id,name,status,effective_status,objective,created_time",
        "filtering": _prefix_filter(), "limit": 200})
    if not ok:
        return {"success": False, "error": f"อ่านรายการแคมเปญไม่ได้: {_meta_error(err)}"}
    campaigns = [{
        "id": c["id"], "name": c["name"], "status": c.get("effective_status") or c.get("status"),
        "objective": c.get("objective"), "created_time": c.get("created_time"),
    } for c in camps if c.get("name", "").startswith(AGENT_PREFIX)]

    ok, insights, err = _graph_get_all(f"{META_AD_ACCOUNT_ID}/insights", {
        "level": "campaign",
        "time_increment": 1,                     # แยกรายวัน -> ทำกราฟได้
        "date_preset": date_preset,
        "fields": "campaign_id,campaign_name,spend,impressions,reach,clicks,inline_link_clicks,actions",
        "filtering": json.dumps([{"field": "campaign.name", "operator": "CONTAIN", "value": AGENT_PREFIX}]),
        "limit": 500,
    })
    if not ok:
        return {"success": False, "error": f"อ่าน insights ไม่ได้: {_meta_error(err)}"}

    rows = []
    for row in insights:
        if not str(row.get("campaign_name", "")).startswith(AGENT_PREFIX):
            continue
        results = sum(int(float(a.get("value", 0))) for a in row.get("actions", [])
                      if a.get("action_type") in RESULT_ACTIONS)
        rows.append({
            "date": row.get("date_start"),
            "campaign_id": row.get("campaign_id"),
            "campaign_name": row.get("campaign_name"),
            "spend": float(row.get("spend", 0) or 0),
            "impressions": int(row.get("impressions", 0) or 0),
            "reach": int(row.get("reach", 0) or 0),
            "clicks": int(row.get("clicks", 0) or 0),
            "link_clicks": int(row.get("inline_link_clicks", 0) or 0),
            "results": results,
        })

    payload = {"agent": AGENT, "prefix": AGENT_PREFIX, "date_preset": date_preset,
               "sent_at": datetime.now(TH_TZ).isoformat(timespec="seconds"),
               "campaigns": campaigns, "rows": rows}

    delivered, dash_msg = False, "ยังไม่ได้ตั้ง DASHBOARD_API_URL — คืนข้อมูลกลับอย่างเดียว"
    if DASHBOARD_API_URL:
        try:
            r = requests.post(DASHBOARD_API_URL, json=payload, timeout=HTTP_TIMEOUT,
                              headers={"Authorization": f"Bearer {DASHBOARD_API_SECRET}"})
            delivered = r.ok
            dash_msg = f"Dashboard ตอบ {r.status_code}: {r.text[:200]}"
        except Exception as e:  # noqa: BLE001
            dash_msg = f"ส่งเข้า Dashboard ไม่ได้: {e}"

    log_action("send_to_dashboard", delivered or not DASHBOARD_API_URL,
               {"date_preset": date_preset, "campaigns": len(campaigns), "rows": len(rows), "dashboard": dash_msg})
    return {"success": True, "delivered": delivered, "dashboard": dash_msg,
            "campaigns": len(campaigns), "rows": len(rows),
            "total_spend_thb": round(sum(r["spend"] for r in rows), 2),
            "total_results": sum(r["results"] for r in rows)}


# ---------------------------------------------------------------------------
# 5) ลงทะเบียน MCP
# ---------------------------------------------------------------------------
TOOLS = [check_permission, create_campaign, create_adset, create_ad, send_to_dashboard]


AI_SYSTEM = (
    "You plan Meta (Facebook) ad targeting for ads shown in Thailand. From the advertiser's brief (what they sell "
    "and to whom, often in Thai) and/or the ad copy, propose short search keywords for Meta's detailed-targeting "
    "interest catalog: interests, hobbies, activities, industries, products and job fields the likely customers "
    "have. Prefer common English terms (Meta's catalog matches them best); Thai is fine for Thailand-only topics. "
    "Keywords must not be age, gender, location, or sensitive categories (health conditions, religion, politics, "
    "sexual orientation, ethnicity, financial hardship). Order from most to least relevant. "
    "Also suggest the audience: age_min (20-25), age_max (30-65; 65 means no upper limit), and languages "
    "(keys from: " + ", ".join(f"{k}={v[1]}" for k, v in LANGUAGES.items()) + "), plus a one-line reason in Thai."
)
AI_PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "keywords": {"type": "array", "items": {"type": "string"}},
        "audience": {
            "type": "object",
            "properties": {
                "age_min": {"type": "integer"},
                "age_max": {"type": "integer"},
                "languages": {"type": "array", "items": {"type": "string", "enum": list(LANGUAGES)}},
                "reason": {"type": "string"},
            },
            "required": ["age_min", "age_max", "languages", "reason"],
            "additionalProperties": False,
        },
    },
    "required": ["keywords", "audience"],
    "additionalProperties": False,
}


def _audience_hint(raw: Any) -> dict[str, Any] | None:
    """อายุ/ภาษาที่ AI แนะนำ → ค่าที่ใช้ได้จริง (ตัดให้อยู่ในช่วงที่ Meta รับ) · หน้าแอปแค่แสดง + ให้ผู้ใช้กดใช้เอง"""
    if not isinstance(raw, dict):
        return None
    try:
        lo = min(max(int(raw.get("age_min")), MIN_AGE), MAX_AGE_MIN)
        hi = min(max(int(raw.get("age_max")), MIN_AGE_MAX), NO_MAX_AGE)
    except (TypeError, ValueError):
        return None
    langs = [k for k in dict.fromkeys(raw.get("languages") or []) if k in LANGUAGES]
    if not langs:
        return None
    label = (f"อายุ {lo}–{hi}" if hi < NO_MAX_AGE else f"อายุ {lo}+") + " · ภาษา " + " / ".join(LANGUAGES[k][1] for k in langs)
    return {"age_min": lo, "age_max": hi, "languages": langs, "label": label,
            "reason": str(raw.get("reason") or "").strip()[:200]}


def _claude_text(system: str, prompt: str, schema: dict[str, Any], refusal: str,
                 max_tokens: int = 4000) -> tuple[str | None, str | None]:
    """เรียก Claude ของ agent นี้ให้ตอบเป็น JSON ตาม schema → (ข้อความ JSON, ข้อผิดพลาดภาษาไทย)
    ใช้ร่วมกัน: ปุ่ม ✨ คิดกลุ่มเป้าหมาย · ปุ่ม ✨ สรุปหน้าวิเคราะห์โฆษณา"""
    import anthropic  # โหลดเฉพาะตอนใช้ปุ่ม ✨ — เครื่องมือ MCP อื่นไม่ต้องพึ่ง
    client = anthropic.Anthropic(
        api_key=ANTHROPIC_API_KEY, timeout=60.0, max_retries=2,
        default_headers={"anthropic-workspace-id": ANTHROPIC_WORKSPACE_ID} if ANTHROPIC_WORKSPACE_ID else None)
    try:
        resp = client.messages.create(
            model=AI_MODEL, max_tokens=max_tokens, system=system,
            messages=[{"role": "user", "content": prompt}],
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": schema}},
        )
    except anthropic.AuthenticationError:
        return None, "คีย์ Claude ไม่ถูกต้องหรือหมดอายุ — ตรวจ ANTHROPIC_API_KEY ที่แท็บ \"เชื่อมต่อ API\""
    except anthropic.RateLimitError:
        return None, "Claude ถูกใช้ถี่เกินไป — รอสักครู่แล้วกดใหม่"
    except anthropic.APIStatusError as e:
        why = _api_error_text(e.body)
        # 400 "not scoped to a workspace" / 403-404 workspace ผิด — แยกบอกเพราะแก้ที่ช่อง Workspace ID
        if "workspace" in why.lower():
            if not ANTHROPIC_WORKSPACE_ID:
                return None, CLAUDE_NEEDS_WORKSPACE
            return None, (f"Workspace ID \"{ANTHROPIC_WORKSPACE_ID}\" ใช้กับคีย์นี้ไม่ได้ — ตรวจที่แท็บ \"เชื่อมต่อ API\" "
                        f"(Claude: {why})")
        if isinstance(e, anthropic.NotFoundError):
            return None, f"ไม่พบรุ่น AI \"{AI_MODEL}\" — แก้ AI_MODEL ใน .env หรือเว้นว่างเพื่อใช้ค่าเริ่มต้น"
        if isinstance(e, anthropic.PermissionDeniedError):
            return None, f"คีย์ Claude นี้ไม่มีสิทธิ์เรียกใช้ — ตรวจสิทธิ์ของคีย์ (Claude: {why or 'ไม่ระบุ'})"
        return None, f"Claude ปฏิเสธคำขอ (HTTP {e.status_code}): {why or 'ไม่ระบุสาเหตุ'}"
    except anthropic.APIConnectionError:
        return None, "เชื่อมต่อ Claude ไม่ได้ — ตรวจอินเทอร์เน็ต"
    if resp.stop_reason == "refusal":
        return None, refusal
    return next((b.text for b in resp.content if b.type == "text"), ""), None


def _ai_keywords(copy: str) -> tuple[list[str], dict[str, Any] | None, str | None]:
    """ถาม AI ของ agent นี้ → (คำค้นความสนใจ ~8 คำ, อายุ/ภาษาที่แนะนำ, ข้อผิดพลาด)
    copy = บรีฟของผู้ใช้ และ/หรือ ข้อความโฆษณา (ติดหัวข้อไว้แล้ว)"""
    prompt = f"{copy}\n\nReturn 8 keywords and the audience suggestion."
    if AI_PROVIDER == "manus":   # Manus ตอบช้า → ใช้ _manus_start + ai_poll แทน (ไม่รอในคำขอเดียว)
        return [], None, "Manus ต้องสั่งงานแล้วรอผล — เรียกผ่านปุ่ม ✨ ในหน้าแอป"
    if AI_PROVIDER == "anthropic":
        text, err = _claude_text(AI_SYSTEM, prompt, AI_PLAN_SCHEMA,
                                 "Claude ไม่คิดกลุ่มเป้าหมายให้ข้อความนี้ — ลองปรับข้อความโฆษณา")
        if err:
            return [], None, err
    else:
        try:
            r = requests.post("https://api.openai.com/v1/chat/completions", timeout=60,
                              headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                              json={"model": AI_MODEL, "response_format": {"type": "json_object"},
                                    "messages": [{"role": "system", "content": AI_SYSTEM + ' Reply as JSON: {"keywords": [...], "audience": {"age_min": 20, "age_max": 65, "languages": ["th"], "reason": "..."}}'},
                                                 {"role": "user", "content": prompt}]})
        except requests.RequestException:
            return [], None, "เชื่อมต่อ OpenAI ไม่ได้ — ตรวจอินเทอร์เน็ต"
        if r.status_code == 401:
            return [], None, "คีย์ OpenAI ไม่ถูกต้องหรือหมดอายุ — ตรวจ OPENAI_API_KEY ที่แท็บ \"เชื่อมต่อ API\""
        if r.status_code == 404:
            return [], None, f"ไม่พบรุ่น AI \"{AI_MODEL}\" — แก้ AI_MODEL ใน .env หรือเว้นว่างเพื่อใช้ค่าเริ่มต้น"
        try:
            err_body = r.json() if r.status_code != 200 else {}
        except ValueError:
            err_body = {}
        if r.status_code == 429:
            # เครดิตหมด (insufficient_quota) กับใช้ถี่เกิน ได้ 429 เหมือนกัน แต่แก้คนละทาง
            err = err_body.get("error") if isinstance(err_body, dict) else None
            if isinstance(err, dict) and err.get("type") == "insufficient_quota":
                return [], None, ("เครดิต OpenAI หมด — เติมเครดิตที่ platform.openai.com → Settings → Billing "
                            "แล้วกดใหม่ (กดซ้ำตอนนี้ก็ไม่ผ่าน)")
            return [], None, "OpenAI ถูกใช้ถี่เกินไป — รอสักครู่แล้วกดใหม่"
        if r.status_code != 200:
            return [], None, f"OpenAI ปฏิเสธคำขอ (HTTP {r.status_code}): {_api_error_text(err_body) or 'ไม่ระบุสาเหตุ'}"
        try:
            text = r.json()["choices"][0]["message"]["content"] or ""
        except (ValueError, KeyError, IndexError):
            return [], None, "OpenAI ตอบกลับในรูปแบบที่อ่านไม่ได้"
    try:
        plan = json.loads(text)
        words = [str(w).strip() for w in plan.get("keywords", []) if str(w).strip()]
    except (ValueError, AttributeError):
        return [], None, "AI ตอบกลับในรูปแบบที่อ่านไม่ได้ — กดใหม่อีกครั้ง"
    return list(dict.fromkeys(words))[:12], _audience_hint(plan.get("audience")), None


def _plan_words(plan: Any) -> tuple[list[str], dict[str, Any] | None]:
    """ผลของ AI {"keywords", "audience"} → (คำค้นไม่ซ้ำ ≤12, อายุ/ภาษาที่แนะนำ)"""
    plan = plan if isinstance(plan, dict) else {}
    words = [str(w).strip() for w in plan.get("keywords") or [] if str(w).strip()]
    return list(dict.fromkeys(words))[:12], _audience_hint(plan.get("audience"))


# ---------------------------------------------------------------------------
# Manus (agent manus) — Manus API v2 ทำงานแบบสั่งงานแล้วรอผล (อาจนานเป็นนาที)
#   _manus_start = สั่งงาน → task_id · ai_poll = หน้าเว็บถามผลทีละครั้ง · ai_stop = ยกเลิก
# ---------------------------------------------------------------------------
MANUS_API = "https://api.manus.ai/v2"
# structured output ของ Manus รับ JSON Schema แบบย่อ (ไม่รับ enum) → ภาษาเป็นข้อความ แล้ว _audience_hint กรองเอง
MANUS_PLAN_SCHEMA = json.loads(json.dumps(AI_PLAN_SCHEMA))
MANUS_PLAN_SCHEMA["properties"]["audience"]["properties"]["languages"] = {"type": "array", "items": {"type": "string"}}
MANUS_TASK_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


def _manus(method: str, path: str, **kw: Any) -> tuple[dict[str, Any] | None, str | None]:
    """เรียก Manus API → (body, ข้อผิดพลาดภาษาไทย)"""
    try:
        r = requests.request(method, f"{MANUS_API}/{path}", timeout=30,
                             headers={"x-manus-api-key": MANUS_API_KEY}, **kw)
    except requests.RequestException:
        return None, "เชื่อมต่อ Manus ไม่ได้ — ตรวจอินเทอร์เน็ต"
    try:
        body = r.json()
    except ValueError:
        body = {}
    err = body.get("error") if isinstance(body, dict) else None
    why = str(err.get("message") or "").strip()[:200] if isinstance(err, dict) else ""
    code = str(err.get("code") or "") if isinstance(err, dict) else ""
    if r.status_code == 401 or code == "unauthenticated":
        return None, "คีย์ Manus ไม่ถูกต้องหรือหมดอายุ — ตรวจ MANUS_API_KEY ที่แท็บ \"เชื่อมต่อ API\""
    if r.status_code == 429 or code == "rate_limited":
        return None, "Manus ถูกใช้ถี่เกินไป (สั่งงานได้ 10 ครั้ง/นาที) — รอสักครู่แล้วกดใหม่"
    if r.status_code == 402 or "credit" in why.lower():
        return None, f"เครดิต Manus ไม่พอ — เติมที่ manus.im แล้วกดใหม่ (Manus: {why or 'ไม่ระบุ'})"
    if r.status_code != 200 or not (isinstance(body, dict) and body.get("ok")):
        return None, f"Manus ปฏิเสธคำขอ (HTTP {r.status_code}): {why or 'ไม่ระบุสาเหตุ'}"
    return body, None


def _manus_start(copy: str) -> tuple[dict[str, Any] | None, str | None]:
    """สั่ง Manus คิดคำค้นความสนใจ (+ อายุ/ภาษา) → ({task_id, task_url}, ข้อผิดพลาด)"""
    text = (AI_SYSTEM + "\n\n" + copy + "\n\nReturn 8 keywords and the audience suggestion. "
            "Answer directly from your own knowledge: do not browse, create files, or build anything.")
    body, err = _manus("POST", "task.create", json={
        "message": {"content": text},
        "agent_profile": AI_MODEL,
        "interactive_mode": False,
        "structured_output_schema": MANUS_PLAN_SCHEMA,
        "title": "Ads Control · คิดความสนใจโฆษณา",
        "hide_in_task_list": True,
    })
    if err:
        return None, err
    task_id = str(body.get("task_id") or "")
    if not MANUS_TASK_ID.match(task_id):
        return None, "Manus รับงานแล้วแต่ไม่ส่งรหัสงานกลับมา — กดใหม่อีกครั้ง"
    return {"task_id": task_id, "task_url": str(body.get("task_url") or "")}, None


def _manus_pending(copy: str, kind: str, extra: dict[str, Any]) -> dict[str, Any]:
    """สั่งงาน Manus แล้วตอบหน้าเว็บทันทีว่า "กำลังคิด" — หน้าเว็บถามผลต่อด้วย --ai-poll-json"""
    info = ai_info()
    task, err = _manus_start(copy)
    log_action(f"{kind}_interests_start", not err, {"ai": "Manus", "model": AI_MODEL, "error": err,
                                                    "task_id": task and task["task_id"]})
    if err:
        return {"success": False, "error": err, **extra}
    return {"success": True, "pending": True, "ai": info["label"], "model": AI_MODEL, "kind": kind, **task, **extra}


def ai_poll(spec: dict[str, Any]) -> dict[str, Any]:
    """(หน้าแอป) ถามผลงานที่สั่ง Manus ไว้ 1 ครั้ง · spec: task_id, kind (suggest|brief), have[] (id ที่เลือกไว้แล้ว)
    ยังไม่เสร็จ → {pending} · เสร็จ → ผลรูปเดียวกับปุ่ม ✨ / ช่องพิมพ์ประโยค (ค้นคลัง Meta ต่อให้แล้ว)"""
    if AI_PROVIDER != "manus":
        return {"success": False, "error": "ถามผลแบบรอได้เฉพาะ agent ที่ใช้ Manus"}
    task_id = str(spec.get("task_id") or "")
    kind = "brief" if spec.get("kind") == "brief" else "suggest"
    if not MANUS_TASK_ID.match(task_id):
        return {"success": False, "error": "รหัสงาน Manus ไม่ถูกต้อง"}
    body, err = _manus("GET", "task.listMessages", params={"task_id": task_id, "order": "desc", "limit": 50})
    if err:
        return {"success": False, "error": err}
    msgs = [m for m in body.get("messages") or [] if isinstance(m, dict)]
    out = next((m.get("structured_output_result") for m in msgs if m.get("type") == "structured_output_result"), None)
    if isinstance(out, dict):
        if not out.get("success"):
            log_action(f"{kind}_interests", False, {"ai": "Manus", "task_id": task_id, "error": out.get("error")})
            return {"success": False, "error": "Manus คิดเสร็จแต่ส่งผลในรูปแบบที่อ่านไม่ได้ — กดใหม่อีกครั้ง"}
        words, aud = _plan_words(out.get("value"))
        return _finish_interests(kind, words, aud, spec, task_id)
    status = next((m.get("status_update") for m in msgs if m.get("type") == "status_update"), None) or {}
    state = str(status.get("agent_status") or "running") if isinstance(status, dict) else "running"
    if state == "error" or any(m.get("type") == "error_message" for m in msgs[:3]):
        why = next((str((m.get("error_message") or {}).get("content") or "") for m in msgs
                    if m.get("type") == "error_message"), "")
        log_action(f"{kind}_interests", False, {"ai": "Manus", "task_id": task_id, "error": why or "error"})
        return {"success": False, "error": f"Manus ทำงานไม่สำเร็จ{f': {why[:200]}' if why else ''} — กดใหม่อีกครั้ง"}
    if state == "waiting":   # interactive_mode ปิดไว้แล้ว แต่ถ้ายังถามกลับ → หยุดงาน ไม่ปล่อยค้างกินเครดิต
        _manus("POST", "task.stop", json={"task_id": task_id})
        log_action(f"{kind}_interests", False, {"ai": "Manus", "task_id": task_id, "error": "waiting"})
        return {"success": False, "error": "Manus ถามกลับแทนที่จะตอบ — ลองเขียนข้อความโฆษณา/ประโยคให้ชัดขึ้นแล้วกดใหม่"}
    return {"success": True, "pending": True, "ai": "Manus", "kind": kind, "task_id": task_id, "state": state}


def ai_stop(task_id: str) -> dict[str, Any]:
    """(หน้าแอป) ปุ่มยกเลิกระหว่างรอ Manus — หยุดงานที่ Manus เพื่อไม่ให้กินเครดิตต่อ"""
    if AI_PROVIDER != "manus" or not MANUS_TASK_ID.match(task_id or ""):
        return {"success": False, "error": "รหัสงาน Manus ไม่ถูกต้อง"}
    _, err = _manus("POST", "task.stop", json={"task_id": task_id})
    log_action("interests_cancel", not err, {"ai": "Manus", "task_id": task_id, "error": err})
    return {"success": not err, "error": err}


def _finish_interests(kind: str, words: list[str], aud: dict[str, Any] | None, spec: dict[str, Any],
                      task_id: str | None = None) -> dict[str, Any]:
    """คำค้นจาก AI → ค้นคลังความสนใจของ Meta → ผลสำหรับหน้าเว็บ (ใช้ร่วมกันทุกค่าย)
    kind: suggest = ปุ่ม ✨ (แทนชุดเดิม) · brief = ช่องพิมพ์ประโยค (ต่อท้ายรายการเดิม ไม่เอา id ใน have)"""
    info = ai_info()
    have = [{"id": str(i)} for i in (spec.get("have") or []) if str(i).isdigit()] if kind == "brief" else []
    found, missed = _search_interests(words, have)
    found = found[len(have):]
    log_action("brief_interests" if kind == "brief" else "suggest_interests", bool(found),
               {"ai": info["label"], "model": AI_MODEL, "keywords": words, "interests": [x["name"] for x in found],
                "missed": missed, "audience": aud and aud["label"], **({"task_id": task_id} if task_id else {}),
                **({"brief": str(spec.get("text") or "")} if kind == "brief" else {})})
    if not found:
        if kind == "brief":   # ไม่ติด brief: AI ทำงานได้ แค่คำไม่ตรงคลัง (หน้าเว็บไม่ต้องยืม AI อื่น)
            return {"success": False, "error": "AI อ่านแล้วได้คำค้น " + ", ".join(words[:6])
                    + " แต่ไม่ตรงกับคลังของ Meta — ลองเล่าให้ชัดขึ้นว่าลูกค้าเป็นใคร"}
        return {"success": False, "error": "AI คิดคำค้นได้ แต่ไม่ตรงกับความสนใจในคลังของ Meta — ลองปรับข้อความแล้วกดใหม่"}
    res = {"success": True, "ai": info["label"], "model": AI_MODEL, "keywords": words, "missed": missed,
           "interests": found, "audience": aud}
    return {**res, "brief": True, "skipped": []} if kind == "brief" else res


INSIGHTS_SYSTEM = (
    "You are a senior Meta (Facebook) ads analyst helping a Thai small-business owner read their ad results. "
    "You get JSON numbers for one ad account and period (spend in the account currency, results per campaign "
    "objective as Meta counts them, previous period, age/gender, placements, Meta's quality rankings, and the "
    "findings of the app's fixed rules). Write in Thai, plain language, short. Only use numbers that are in the "
    "data; never invent figures, benchmarks or causes you cannot see. Compare like with like (cost per lead vs cost "
    "per lead, not leads vs landing-page views). Advice must follow Meta's advertising policies: no discriminatory "
    "targeting, no sensitive-category targeting, no misleading or exaggerated claims, no tricks to bypass review. "
    "Campaigns marked paused are finished - frame advice about them as lessons for the next run. The app does not "
    "change anything on Meta; the owner applies changes in Ads Manager. "
    "Return: headline (one sentence, the single most important takeaway), points (3-5 items, each a short bold-able "
    "title and one or two sentence detail with the supporting numbers), try_first (one concrete next step)."
)
INSIGHTS_SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string"},
        "points": {"type": "array", "items": {
            "type": "object",
            "properties": {"title": {"type": "string"}, "detail": {"type": "string"}},
            "required": ["title", "detail"],
            "additionalProperties": False,
        }},
        "try_first": {"type": "string"},
    },
    "required": ["headline", "points", "try_first"],
    "additionalProperties": False,
}


def insights_summary(data: dict[str, Any]) -> dict[str, Any]:
    """(ปุ่ม ✨ หน้าวิเคราะห์โฆษณา) ตัวเลขสรุปของบัญชี → Claude สรุปภาพรวม + สิ่งที่ควรลองก่อน
    อ่านอย่างเดียว ไม่แตะ Meta · ข้อมูลมาจาก dashboard (ไม่มี token ไม่มี ID)"""
    info = ai_info()
    if AI_PROVIDER != "anthropic":
        return {"success": False, "error": "ปุ่มสรุปใช้ Claude ของ agent claude เท่านั้น"}
    if not info["ready"]:
        return {"success": False, "error": info["missing"]}
    prompt = "Ad account numbers (JSON):\n" + json.dumps(data, ensure_ascii=False)
    text, err = _claude_text(INSIGHTS_SYSTEM, prompt, INSIGHTS_SCHEMA,
                             "Claude ไม่สรุปข้อมูลชุดนี้ให้ — ลองเลือกช่วงเวลาอื่น", max_tokens=3000)
    if err:
        log_action("insights_summary", False, {"model": AI_MODEL, "error": err})
        return {"success": False, "error": err}
    try:
        out = json.loads(text or "")
        points = [{"title": str(p.get("title") or "").strip(), "detail": str(p.get("detail") or "").strip()}
                  for p in out.get("points") or [] if isinstance(p, dict)]
        res = {"success": True, "error": None, "model": AI_MODEL, "headline": str(out.get("headline") or "").strip(),
               "points": [p for p in points if p["title"] or p["detail"]][:6], "try_first": str(out.get("try_first") or "").strip()}
    except (ValueError, AttributeError):
        return {"success": False, "error": "Claude ตอบกลับในรูปแบบที่อ่านไม่ได้ — กดใหม่อีกครั้ง"}
    log_action("insights_summary", True, {"model": AI_MODEL, "points": len(res["points"])})
    return res


def suggest_interests(spec: dict[str, Any]) -> dict[str, Any]:
    """(ปุ่ม ✨ ในหน้าแอป) ข้อความโฆษณา → AI คิดคำค้น → ค้นคลังความสนใจของ Meta → ไม่เกิน 10 รายการ
    spec: texts[], titles[], link_url?"""
    info = ai_info()
    if not info["ready"]:
        return {"success": False, "error": info["missing"]}
    texts = [str(x).strip() for x in (spec.get("texts") or []) if str(x).strip()]
    titles = [str(x).strip() for x in (spec.get("titles") or []) if str(x).strip()]
    link = str(spec.get("link_url") or "").strip()
    if not texts:
        return {"success": False, "error": "ใส่ข้อความโฆษณาก่อน แล้วค่อยให้ AI คิดกลุ่มเป้าหมาย"}
    copy = _copy_block(texts, titles, link)
    if AI_PROVIDER == "manus":
        return _manus_pending(copy, "suggest", {})
    words, aud, err = _ai_keywords(copy)
    if err:
        log_action("suggest_interests", False, {"ai": info["label"], "model": AI_MODEL, "error": err})
        return {"success": False, "error": err}
    return _finish_interests("suggest", words, aud, {})


def _copy_block(texts: list[str], titles: list[str], link: str) -> str:
    """ข้อความโฆษณา → ข้อความที่ส่งให้ AI"""
    lines = texts + [f"Headline: {t}" for t in titles] + ([f"Link: {link}"] if link else [])
    return ("Ad copy:\n" + "\n".join(lines))[:4000] if lines else ""


BRIEF_MIN_CHARS = 30   # ช่องคำค้นยาวกว่านี้ (และไม่มี ,) = ประโยคบอกความต้องการ → ให้ AI อ่าน
BRIEF_MIN_WORDS = 5    # หรือมีคำ (เว้นวรรค) ตั้งแต่เท่านี้


def _is_brief(text: str) -> bool:
    """ข้อความในช่องคำค้นเป็นประโยคบอกความต้องการ (ไม่ใช่คำค้นสั้น ๆ คั่นด้วย ,) ไหม"""
    t = text.strip()
    return "," not in t.replace("，", ",") and (len(t) >= BRIEF_MIN_CHARS or len(t.split()) >= BRIEF_MIN_WORDS)


def search_interests_app(spec: dict[str, Any]) -> dict[str, Any]:
    """(ช่องพิมพ์คำค้นเองในหน้าแอป)
    - คำสั้น ๆ คั่นด้วย , → ค้นตรงในคลังของ Meta (ไม่ใช้ AI)
    - เป็นประโยคบอกความต้องการ หรือค้นตรงแล้วไม่เจอเลย → ให้ AI อ่าน (คู่กับข้อความโฆษณาถ้ามี) แล้วค่อยค้น
    spec: text (ข้อความในช่อง) หรือ words[] · have (id ที่เลือกไว้แล้ว ไม่เอาซ้ำ และนับรวมเพดาน)
          texts[]/titles[]/link_url (ข้อความโฆษณา ใช้ตอนให้ AI อ่าน)"""
    text = str(spec.get("text") or "").strip()[:500]
    raw = spec.get("words") or text
    if isinstance(raw, str):
        raw = raw.replace("，", ",").split(",")
    words = list(dict.fromkeys(str(w).strip()[:60] for w in raw if str(w).strip()))
    have = [{"id": str(i)} for i in (spec.get("have") or []) if str(i).isdigit()]
    if not words:
        return {"success": False, "error": "พิมพ์คำค้น เช่น ERP, บัญชี หรือเล่าว่าขายอะไรให้ใคร"}
    room = MAX_INTERESTS - len(have)
    if room <= 0:
        return {"success": False, "error": f"ความสนใจครบ {MAX_INTERESTS} รายการแล้ว — ลบออกก่อนแล้วค่อยค้นเพิ่ม"}
    if not (text and _is_brief(text)):
        found, missed = _search_interests(words, have)
        found = found[len(have):]
        skipped = words[room:]   # เกินเพดาน ไม่ได้ค้น
        log_action("search_interests", bool(found), {"words": words, "interests": [x["name"] for x in found],
                                                     "missed": missed, "skipped": skipped})
        if found:
            return {"success": True, "interests": found, "missed": missed, "skipped": skipped}
        if not (text and ai_info()["ready"]):   # ไม่เจอเลย → ให้ AI ลองอ่านแทน (ถ้ามี AI)
            return {"success": False, "error": "ไม่เจอในคลังของ Meta: " + ", ".join(missed or words)
                    + " — ลองคำอื่น (ภาษาอังกฤษมักเจอง่ายกว่า) หรือเล่าเป็นประโยคให้ AI อ่าน"}
    return _brief_interests(text, have, spec)


def _brief_interests(text: str, have: list[dict[str, Any]], spec: dict[str, Any]) -> dict[str, Any]:
    """ประโยคบอกความต้องการ → AI แตกเป็นคำค้น (+ แนะนำอายุ/ภาษา) → ค้นคลังของ Meta ต่อท้ายรายการเดิม"""
    info = ai_info()
    if not info["ready"]:
        return {"success": False, "brief": True, "error": f"ประโยคต้องให้ AI อ่านก่อน แต่ {info['missing']} "
                                           "— หรือพิมพ์เป็นคำสั้น ๆ คั่นด้วย , เช่น ERP, โรงงาน"}
    clean = lambda v: [str(x).strip() for x in (v or []) if str(x).strip()]  # noqa: E731
    copy = _copy_block(clean(spec.get("texts")), clean(spec.get("titles")), str(spec.get("link_url") or "").strip())
    brief = f"Advertiser's brief:\n{text}" + (f"\n\n{copy}" if copy else "")
    if AI_PROVIDER == "manus":
        return _manus_pending(brief, "brief", {"brief": True})
    words, aud, err = _ai_keywords(brief)
    if err:
        log_action("brief_interests", False, {"ai": info["label"], "brief": text, "error": err})
        return {"success": False, "brief": True, "error": err}
    return _finish_interests("brief", words, aud, {"text": text, "have": [x["id"] for x in have]})


def _ad_copy(adset_id: str) -> dict[str, Any]:
    """ข้อความของโฆษณาใน Ad Set (ให้ปุ่ม ✨ คิดความสนใจจากของเดิม) → {texts, titles, link_url}"""
    ok, body = _graph_get(f"{adset_id}/ads", {"fields": "creative{body,title,object_story_spec,asset_feed_spec}",
                                               "limit": 10})
    texts: list[str] = []
    titles: list[str] = []
    link = ""
    for ad in (body.get("data", []) if ok else []):
        cr = ad.get("creative") or {}
        feed = cr.get("asset_feed_spec") or {}
        ld = (cr.get("object_story_spec") or {}).get("link_data") or {}
        texts += [cr.get("body", ""), ld.get("message", "")] + [b.get("text", "") for b in feed.get("bodies", [])]
        titles += [cr.get("title", ""), ld.get("name", "")] + [t.get("text", "") for t in feed.get("titles", [])]
        link = link or ld.get("link", "") or next((u.get("website_url", "") for u in feed.get("link_urls", [])), "")
    clean = lambda v: list(dict.fromkeys(x.strip() for x in v if x and x.strip()))  # noqa: E731
    return {"texts": clean(texts)[:5], "titles": clean(titles)[:5],
            "link_url": "" if link.startswith(MESSENGER_LINK) else link}


def _find_adset(spec: dict[str, Any]) -> tuple[bool, str]:
    """spec.adset_id หรือ spec.campaign_id (แคมเปญที่มี Ad Set ชุดเดียว) → (ok, adset_id หรือข้อความ error)"""
    adset_id = str(spec.get("adset_id") or "").strip()
    campaign_id = str(spec.get("campaign_id") or "").strip()
    if not (adset_id or campaign_id).isdigit():
        return False, "ไม่รู้ว่าจะแก้ Ad Set ไหน"
    if adset_id:
        return True, adset_id
    ok, camp = _own_object(campaign_id, "id,name,effective_status")
    if not ok:
        return False, camp
    if camp.get("effective_status") in ("ARCHIVED", "DELETED"):   # ตารางในแอปอาจยังโชว์สถานะเก่า
        return False, f"แคมเปญ {camp.get('name')} ถูก{'เก็บถาวร' if camp['effective_status'] == 'ARCHIVED' else 'ลบ'}ใน Ads Manager แล้ว — แก้ไม่ได้"
    ok, body = _graph_get(f"{campaign_id}/adsets", {"fields": "id", "limit": 5})
    ids = [str(x["id"]) for x in (body.get("data", []) if ok else [])]
    if not ok or not ids:
        return False, "หา Ad Set ของแคมเปญนี้ไม่เจอ" + (f": {_meta_error(body)}" if not ok else "")
    if len(ids) > 1:
        return False, f"แคมเปญนี้มี Ad Set {len(ids)} ชุด — แก้ใน Ads Manager แทน"
    return True, ids[0]


def _on_air_live() -> tuple[dict[str, Any] | None, str | None]:
    """Live ที่กำลังออกอากาศบนเพจ → ({id, title, video_id, story_id, started}, None) · ไม่มี → (None, None)
    story_id = โพสต์ของ Live บนเพจ (ใช้เป็น object_story_id ของโฆษณา)"""
    ok, body = _graph_get(f"{_page()}/live_videos", {
        "broadcast_status": json.dumps(["LIVE"]), "fields": "id,title,status,creation_time,video{id}", "limit": 5})
    if not ok:
        return None, f"อ่าน Live ของเพจไม่ได้: {_meta_error(body)}"
    rows = [x for x in body.get("data", []) if x.get("status") == "LIVE" and (x.get("video") or {}).get("id")]
    if not rows:
        return None, None
    lv = rows[0]
    video_id = str(lv["video"]["id"])
    ok, v = _graph_get(video_id, {"fields": "post_id"})
    post = str(v.get("post_id") or "") if ok else ""
    story_id = post if "_" in post else f"{_page()}_{post or video_id}"
    started = ""
    if lv.get("creation_time"):
        try:
            started = datetime.strptime(lv["creation_time"], "%Y-%m-%dT%H:%M:%S%z").astimezone(TH_TZ).strftime("%H:%M")
        except ValueError:
            pass
    return {"id": str(lv["id"]), "title": lv.get("title") or "Live", "video_id": video_id,
            "story_id": story_id, "started": started}, None


def _live_video_ad(adset_id: str, ad_name: str, story_id: str) -> dict[str, Any]:
    """โฆษณาคลิป Live (PAUSED) จากโพสต์ของ Live ที่กำลังออกอากาศ — ใช้โพสต์เดิมของเพจ (object_story_id)"""
    perm = _run_checks(None, count_campaigns=False)
    if not perm["allowed"]:
        log_action("create_ad", False, {"blocked": perm["reason"]})
        return {"success": False, "blocked_by": "check_permission", **perm}
    ad_name = with_prefix(ad_name)
    ok, cr = _graph_post(f"{META_AD_ACCOUNT_ID}/adcreatives", {"name": f"{ad_name}-Creative",
                                                              "object_story_id": story_id})
    if not ok:
        log_action("create_ad", False, {"name": ad_name, "step": "creative", "live": True, "error": _meta_error(cr)})
        return {"success": False, "error": f"Meta ไม่รับโพสต์ Live เป็นโฆษณา: {_meta_error(cr)}"}
    ok, body = _graph_post(f"{META_AD_ACCOUNT_ID}/ads", {
        "name": ad_name, "adset_id": adset_id, "creative": {"creative_id": cr["id"]}, "status": REQUIRED_STATUS})
    log_action("create_ad", ok, {"name": ad_name, "adset_id": adset_id, "creative_id": cr["id"], "live": True,
                                 "story_id": story_id, "ad_id": body.get("id") if ok else None,
                                 "error": None if ok else _meta_error(body)})
    if not ok:
        return {"success": False, "error": _meta_error(body), "creative_id": cr["id"]}
    return {"success": True, "ad_id": body["id"], "creative_id": cr["id"], "name": ad_name, "status": REQUIRED_STATUS}


def _creative_page(cr: dict[str, Any]) -> str:
    """เลขเพจของ Creative: object_story_spec.page_id หรือส่วนหน้าของ object_story_id ("{page}_{post}")"""
    pid = str((cr.get("object_story_spec") or {}).get("page_id") or "")
    if pid:
        return pid
    story = str(cr.get("object_story_id") or cr.get("effective_object_story_id") or "")
    return story.split("_")[0] if "_" in story else ""


def live_ads(spec: dict[str, Any]) -> dict[str, Any]:
    """(ปุ่ม "＋ โฆษณา" / "🔴 สร้างโฆษณาจาก Live ที่กำลังออกอากาศ") เติมโฆษณาให้ชุด Live ที่สร้างไปแล้ว
    spec: adset_id หรือ campaign_id · mode:
      info   = ข้อมูลชุด + จำนวนโฆษณา + Live ที่นัดไว้ + Live ที่กำลังออกอากาศ
      teaser = โฆษณารูปชวนดู Live (live_id, text?, image_path?) · ปุ่ม ดูเพิ่มเติม → หน้ากิจกรรม Live
      live   = โฆษณาคลิป Live จาก Live ที่กำลังออกอากาศบนเพจ
    เพจ: ชุดที่มีโฆษณาแล้ว = เพจเดิมของชุด (อ่านจากโฆษณาตัวแรก · เปลี่ยนไม่ได้) · ชุดว่าง = page_id ที่เลือกในกล่อง
         (ว่าง = เพจประจำ agent) — ทุกโหมดคืน page + page_locked + pages (รายการให้เลือกเมื่อไม่ล็อก)
    กฎ: เฉพาะชุดของ agent นี้ · โฆษณาที่สร้าง = PAUSED เสมอ · ไม่แตะสถานะ/งบของชุด"""
    mode = str(spec.get("mode") or "info")
    if mode not in ("info", "teaser", "live"):
        return {"success": False, "error": "ไม่รู้ว่าจะทำอะไร"}
    ok, adset_id = _find_adset(spec)
    if not ok:
        return {"success": False, "error": adset_id}
    ok, aset = _own_object(adset_id, "id,name,status,start_time,end_time,campaign{id,name,status,objective}")
    if not ok:
        return {"success": False, "error": aset}
    camp = aset.get("campaign") or {}
    ok, ads = _graph_get(f"{adset_id}/ads", {
        "fields": "id,creative{object_story_spec,object_story_id,effective_object_story_id}", "limit": 50})
    if not ok:
        return {"success": False, "error": f"อ่านโฆษณาในชุดไม่ได้: {_meta_error(ads)}"}
    rows = ads.get("data", [])
    base = {"adset_id": adset_id, "adset_name": aset.get("name"), "campaign_id": camp.get("id"),
            "campaign_name": camp.get("name"), "ads": len(rows),
            "start_time": aset.get("start_time"), "end_time": aset.get("end_time")}
    # เพจของชุด — โฆษณาใหม่ต้องอยู่เพจเดียวกับโฆษณาเดิม
    locked = next((_creative_page(x.get("creative") or {}) for x in rows if _creative_page(x.get("creative") or {})), "")
    if locked:
        _ACTIVE_PAGE.set(locked)
        ok, pg = _graph_get(locked, {"fields": "name"})
        page: dict[str, Any] = {"id": locked, "name": pg.get("name") if ok else locked}
        base.update(page=page, page_locked=True)
    else:
        page, err = _use_page(spec.get("page_id"))
        if err:
            return {"success": False, **base, "page_locked": False, "pages": ad_pages()[0], "error": err}
        base.update(page=page, page_locked=False, **({"pages": ad_pages()[0]} if mode == "info" else {}))
    base_name = str(aset.get("name") or "").removeprefix(AGENT_PREFIX).removesuffix(" - Live")

    if mode == "info":
        found = live_events()
        air, air_err = _on_air_live()
        return {"success": True, **base, "lives": found.get("lives", []),
                "on_air": {k: air[k] for k in ("title", "started")} if air else None,
                "error_lives": None if found["success"] else found["error"], "error_on_air": air_err}

    if mode == "live":
        air, err = _on_air_live()
        if err:
            return {"success": False, **base, "error": err}
        if not air:
            return {"success": False, **base, "not_live": True,
                    "error": "ยังไม่เจอ Live ที่กำลังออกอากาศบนเพจ — เริ่ม Live แล้วกดอีกครั้ง (ไม่มีอะไรถูกสร้าง)"}
        ad = _live_video_ad(adset_id, f"{base_name} - คลิป Live", air["story_id"])
        return {**ad, **base, "live_title": air["title"], "live_started": air["started"],
                **({"ads": (base["ads"] or 0) + 1} if ad.get("success") else {})}

    # teaser
    live_id = str(spec.get("live_id") or "").strip()
    found = live_events()
    live = next((x for x in found.get("lives", []) if x["id"] == live_id), None)
    if not live:
        return {"success": False, **base, "error": found.get("error") or "เลือก Live ที่นัดไว้ (ที่ยังไม่เริ่ม)"}
    ok, img, src = _prepare_image(spec.get("image_path"), "")
    if not ok:
        return {"success": False, **base, "error": img}
    ad = _live_teaser_ad(adset_id, f"{base_name} - รูปชวนดู Live", live,
                         str(spec.get("text") or "").strip(), img)
    return {**ad, **base, "image_source": src, **({"ads": (base["ads"] or 0) + 1} if ad.get("success") else {})}


def adset_interests(spec: dict[str, Any]) -> dict[str, Any]:
    """(ปุ่ม "＋ เพิ่มความสนใจให้ Ad Set นี้") อ่าน/บันทึกความสนใจของ Ad Set ที่สร้างไปแล้ว
    spec: adset_id หรือ campaign_id · save=true + interests [{id,name}] = บันทึก (แทนที่ชุดเดิมทั้งหมด)
    กฎ: แก้ได้เฉพาะงานของ agent นี้ · ทั้งแคมเปญและ Ad Set ต้องหยุดอยู่ (PAUSED) · ไม่แตะสถานะ/งบ/ส่วนอื่น"""
    ok, adset_id = _find_adset(spec)
    if not ok:
        return {"success": False, "error": adset_id}
    ok, aset = _own_object(adset_id, "id,name,status,campaign{id,name,status},targeting")
    if not ok:
        return {"success": False, "error": aset}
    targeting = dict(aset.get("targeting") or {})
    camp = aset.get("campaign") or {}
    paused = aset.get("status") == REQUIRED_STATUS and camp.get("status") == REQUIRED_STATUS
    groups = list(targeting.get("flexible_spec") or [])
    now = [{"id": str(x["id"]), "name": x.get("name", "")} for g in groups for x in (g.get("interests") or [])]
    base = {"adset_id": adset_id, "adset_name": aset.get("name"), "campaign_id": camp.get("id"),
            "campaign_name": camp.get("name"), "paused": paused, "max_interests": MAX_INTERESTS}

    if not spec.get("save"):
        if now:   # ชื่อภาษาไทย + ตัวที่ Meta เลิกใช้แล้ว (ต้องลบก่อนบันทึก)
            valid, th = _interest_validity([x["id"] for x in now])
            now = _with_th_reach([{**x, "name": th.get(x["id"]) or x["name"], "gone": valid.get(x["id"]) is False}
                                  for x in now])
        return {"success": True, **base, "interests": now, **_ad_copy(adset_id)}

    if not paused:
        return {"success": False, **base,
                "error": "แก้ได้เฉพาะตอนที่แคมเปญและ Ad Set หยุดอยู่ — กดหยุดใน Ads Manager ก่อน แล้วค่อยแก้"}
    picked, err = _resolve_interests(spec.get("interests") or [])
    if err:
        return {"success": False, **base, "error": err}
    # แทนที่ความสนใจในกลุ่มแรก · ส่วนอื่นของกลุ่มเป้าหมาย (อายุ ภาษา ข้อยกเว้นของบัญชี) ส่งกลับไปเหมือนเดิม
    first = {k: v for k, v in (groups[0] if groups else {}).items() if k != "interests"}
    if picked:
        first["interests"] = picked
    groups = ([first] if first else []) + [{k: v for k, v in g.items() if k != "interests"} for g in groups[1:]]
    groups = [g for g in groups if g]
    if groups:
        targeting["flexible_spec"] = groups
    else:
        targeting.pop("flexible_spec", None)
    data: dict[str, Any] = {"targeting": targeting}
    if spec.get("validate_only"):   # ทดสอบกับ Meta โดยไม่บันทึกจริง
        data["execution_options"] = ["validate_only"]
    ok, res = _graph_post(adset_id, data)
    log_action("update_adset_interests", ok, {"adset_id": adset_id, "before": [x["name"] for x in now],
                                              "after": [x["name"] for x in picked],
                                              "validate_only": bool(spec.get("validate_only")),
                                              **({} if ok else {"error": _meta_error(res)})})
    if not ok:
        return {"success": False, **base, "error": f"Meta ไม่รับ: {_meta_error(res)}"}
    return {"success": True, **base, "interests": picked, "before": len(now),
            "validated_only": bool(spec.get("validate_only"))}


def build_server():
    from mcp.server.mcpserver import MCPServer

    server = MCPServer(
        name=f"meta-ads-{AGENT}",
        version=__version__,
        instructions=(
            f"คุณคือ agent '{AGENT}' ใช้ prefix {AGENT_PREFIX} กับบัญชี {META_AD_ACCOUNT_ID}. "
            "ลำดับ: check_permission -> create_campaign -> create_adset -> create_ad. "
            "ทุกอย่างถูกสร้างเป็น PAUSED เท่านั้น ห้ามพยายามเปิด ACTIVE. "
            f"งบต่อวันห้ามเกิน {MAX_DAILY_BUDGET_THB} บาท, สร้างได้ไม่เกิน {MAX_CAMPAIGNS_PER_DAY} แคมเปญ/วัน."
        ),
    )
    for fn in TOOLS:
        server.tool()(fn)
    return server


def run_http(server, host: str, port: int) -> None:
    import uvicorn
    from mcp.server.transport_security import TransportSecuritySettings

    hosts = ["127.0.0.1:*", "localhost:*", "[::1]:*"]
    origins = ["http://127.0.0.1:*", "http://localhost:*", "http://[::1]:*"]
    if MCP_PUBLIC_HOST:
        hosts.append(MCP_PUBLIC_HOST)
        origins.append(f"https://{MCP_PUBLIC_HOST}")
    app = server.streamable_http_app(
        transport_security=TransportSecuritySettings(allowed_hosts=hosts, allowed_origins=origins), host=host)

    if MCP_HTTP_TOKEN:
        inner = app

        async def guarded(scope, receive, send):  # ASGI middleware: Bearer หรือ ?key=
            if scope["type"] == "http":
                headers = dict(scope.get("headers") or [])
                auth = headers.get(b"authorization", b"").decode()
                query = scope.get("query_string", b"").decode()
                if auth != f"Bearer {MCP_HTTP_TOKEN}" and f"key={MCP_HTTP_TOKEN}" not in query.split("&"):
                    await send({"type": "http.response.start", "status": 401,
                                "headers": [(b"content-type", b"application/json")]})
                    await send({"type": "http.response.body", "body": b'{"error":"unauthorized"}'})
                    return
            await inner(scope, receive, send)

        asgi = guarded
    else:
        eprint("คำเตือน: ไม่ได้ตั้ง MCP_HTTP_TOKEN — ใครเข้าถึง port นี้ได้ก็สั่งสร้างแคมเปญได้")
        asgi = app

    eprint(f"MCP HTTP พร้อม: http://{host}:{port}/mcp  (agent={AGENT}, prefix={AGENT_PREFIX})")
    uvicorn.run(asgi, host=host, port=port, log_level="warning")


if __name__ == "__main__":
    if (ARGS.status or ARGS.create_json or ARGS.suggest_json or ARGS.search_json or ARGS.adset_json
            or ARGS.reach_json or ARGS.lives or ARGS.live_ad_json or ARGS.pages
            or ARGS.portfolios or ARGS.check_portfolio or ARGS.insights_summary_json
            or ARGS.ai_poll_json or ARGS.ai_stop):
        if PORTFOLIO != 1 and (ARGS.status or ARGS.create_json):
            _auto_portfolio_ids()
        if ARGS.ai_poll_json:
            out = ai_poll(json.loads(Path(ARGS.ai_poll_json).read_text(encoding="utf-8")))
        elif ARGS.ai_stop:
            out = ai_stop(ARGS.ai_stop)
        elif ARGS.insights_summary_json:
            out = insights_summary(json.loads(Path(ARGS.insights_summary_json).read_text(encoding="utf-8")))
        elif ARGS.check_portfolio:
            out = check_portfolio()
        elif ARGS.portfolios:
            out = {"success": True, "portfolios": portfolios_list()}
        elif ARGS.status:
            out = app_status()
        elif ARGS.pages:
            pages, err = ad_pages()
            out = {"success": not err, "error": err, "pages": pages, "default_page_id": META_PAGE_ID}
        elif ARGS.lives:
            _, page_err = _use_page(ARGS.page_id)
            out = {"success": False, "error": page_err, "lives": []} if page_err else live_events()
        elif ARGS.reach_json:
            out = interests_reach(json.loads(Path(ARGS.reach_json).read_text(encoding="utf-8")))
        elif ARGS.live_ad_json:
            out = live_ads(json.loads(Path(ARGS.live_ad_json).read_text(encoding="utf-8")))
        elif ARGS.adset_json:
            out = adset_interests(json.loads(Path(ARGS.adset_json).read_text(encoding="utf-8")))
        elif ARGS.suggest_json:
            out = suggest_interests(json.loads(Path(ARGS.suggest_json).read_text(encoding="utf-8")))
        elif ARGS.search_json:
            out = search_interests_app(json.loads(Path(ARGS.search_json).read_text(encoding="utf-8")))
        else:
            out = create_full(json.loads(Path(ARGS.create_json).read_text(encoding="utf-8")))
        sys.stdout.reconfigure(encoding="utf-8")
        print(json.dumps(out, ensure_ascii=False))
        sys.exit(0)
    if ARGS.test is not None:
        print(json.dumps(check_permission(ARGS.test), ensure_ascii=False, indent=2))
        sys.exit(0)

    srv = build_server()
    if ARGS.http:
        run_http(srv, ARGS.host or "127.0.0.1", ARGS.port or DEFAULT_HTTP_PORT[AGENT])
    else:
        eprint(f"MCP stdio พร้อม (agent={AGENT}, prefix={AGENT_PREFIX})")
        srv.run("stdio")

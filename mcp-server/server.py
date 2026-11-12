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
import json
import os
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
META_PAGE_ID = os.getenv("META_PAGE_ID", "").strip()
META_PIXEL_ID = os.getenv("META_PIXEL_ID", "").strip()             # ใช้เฉพาะ OUTCOME_SALES / OUTCOME_LEADS
# เลขผู้ลงโฆษณาที่ยืนยันตัวตนแล้ว (Meta บังคับสำหรับโฆษณาที่ยิงในไทย) — ดูได้จาก Ad Set เดิมใน Ads Manager
META_VERIFIED_IDENTITY_ID = os.getenv("META_VERIFIED_IDENTITY_ID", "").strip()
AGENT_PREFIX = os.getenv("AGENT_PREFIX", AGENT_PREFIX_MAP[AGENT]).strip()
# เพดานที่ตกลงกันไว้ — ตั้งในไฟล์ .env ให้ต่ำกว่านี้ได้ แต่สูงกว่านี้ไม่ได้
HARD_MAX_DAILY_BUDGET_THB = 1000
HARD_MAX_CAMPAIGNS_PER_DAY = 5
MAX_DAILY_BUDGET_THB = min(int(os.getenv("MAX_DAILY_BUDGET_THB", "1000")), HARD_MAX_DAILY_BUDGET_THB)
MAX_CAMPAIGNS_PER_DAY = min(int(os.getenv("MAX_CAMPAIGNS_PER_DAY", "5")), HARD_MAX_CAMPAIGNS_PER_DAY)
DASHBOARD_API_URL = os.getenv("DASHBOARD_API_URL", "").strip()
DASHBOARD_API_SECRET = os.getenv("DASHBOARD_API_SECRET", "").strip()
GRAPH_API_VERSION = os.getenv("GRAPH_API_VERSION", "v21.0").strip()
# AI ที่ใช้คิดความสนใจ (ปุ่ม ✨ ในหน้าแอป) — claude/manus ใช้ Claude · chatgpt ใช้ OpenAI
AI_PROVIDER = "openai" if AGENT == "chatgpt" else "anthropic"
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
# คีย์ระดับผู้ใช้ (sk-ant-usr-…) ไม่ผูก workspace → ต้องส่ง workspace id ไปกับทุกคำขอ ไม่งั้น Claude ตอบ 400
ANTHROPIC_WORKSPACE_ID = os.getenv("ANTHROPIC_WORKSPACE_ID", "").strip()
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
AI_MODEL = os.getenv("AI_MODEL", "").strip() or {"anthropic": "claude-haiku-5-5", "openai": "gpt-4o-mini"}[AI_PROVIDER]
MCP_HTTP_TOKEN = os.getenv("MCP_HTTP_TOKEN", "").strip()            # กุญแจป้องกันโหมด HTTP
MCP_PUBLIC_HOST = os.getenv("MCP_PUBLIC_HOST", "").strip()          # เช่น xxxx.ngrok-free.app

BASE_URL = f"https://graph.facebook.com/{GRAPH_API_VERSION}"
__version__ = "0.8.2"
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
        local = _count_campaigns_today_local()
        used = max(remote, local)
        src = "Meta" if ok else f"audit log (อ่านจาก Meta ไม่ได้: {_meta_error(err)})"
        add("daily_limit", "จำนวนแคมเปญวันนี้", used < MAX_CAMPAIGNS_PER_DAY,
            f"สร้างแล้ว {used}/{MAX_CAMPAIGNS_PER_DAY} แคมเปญ ({AGENT_PREFIX}, นับจาก {src})")
        checks[-1]["used"] = used

    return _summarize(checks)


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
    label = "Claude" if AI_PROVIDER == "anthropic" else "OpenAI"
    key_name = "ANTHROPIC_API_KEY" if AI_PROVIDER == "anthropic" else "OPENAI_API_KEY"
    ready = bool(ANTHROPIC_API_KEY if AI_PROVIDER == "anthropic" else OPENAI_API_KEY)
    missing = None if ready else f"ยังไม่ได้ใส่คีย์ {label} ({key_name}) — ใส่ได้ที่แท็บ \"เชื่อมต่อ API\""
    if ready and AI_PROVIDER == "anthropic" and ANTHROPIC_API_KEY.startswith(USER_KEY_PREFIX) \
            and not ANTHROPIC_WORKSPACE_ID:
        ready, missing = False, CLAUDE_NEEDS_WORKSPACE
    return {"provider": AI_PROVIDER, "label": label, "model": AI_MODEL, "key_name": key_name, "ready": ready,
            "missing": missing}


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
        # ชื่อตรงคำค้น → หมวดหลัก (ไม่ใช่ชื่องาน/แบรนด์ใต้ "ความสนใจเพิ่มเติม") ตามลำดับของ Meta
        # → ไม่มีเลยค่อยเอาตัวที่คนสนใจมากสุดใน 5 อันดับ
        exact = [r for r in cands if str(r.get("name", "")).strip().lower() == w.lower()]
        core = [r for r in cands if not set(r.get("path") or []) & EXTRA_INTERESTS]
        hit = (exact or core or [max(cands, key=lambda r: r.get("audience_size_lower_bound") or 0)])[0] \
            if cands else None
        if not hit:
            missed.append(w)
            continue
        seen.add(str(hit["id"]))
        # ชื่อภาษาไทยให้หน้าแอป (ขอไม่ได้ก็ใช้ชื่ออังกฤษไป)
        out.append({"id": str(hit["id"]), "name": th.get(str(hit["id"])) or hit.get("name", w), "keyword": w,
                    "size_lower": hit.get("audience_size_lower_bound"),
                    "size_upper": hit.get("audience_size_upper_bound")})
    return out, missed


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
            return [], "ความสนใจที่ Meta เลิกใช้แล้ว: " + ", ".join(gone) + " — ลบออกแล้วกดสร้างใหม่"
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
    if interests:
        label += f" · ความสนใจ {len(interests)} รายการ (แนะนำ)"
    label += f" · คลังเนื้อหา{BRAND_SAFETY_LABEL}"
    return {"age_min": age, "age_max": age_hi, "interests": interests, "targeting": targeting, "_label": label}, None


def _parse_th_time(value: str) -> datetime:
    """'2026-11-11T08:00' / '2026-11-11 08:00' / ISO มี timezone — ถ้าไม่มี timezone ถือเป็นเวลาไทย"""
    dt = datetime.fromisoformat(value.strip().replace(" ", "T"))
    return dt if dt.tzinfo else dt.replace(tzinfo=TH_TZ)


def _schedule(start_time: str = "", end_time: str = "") -> tuple[dict[str, str], str | None]:
    """ตรวจและแปลงวันเวลาเผยแพร่ → (payload สำหรับ Meta, ข้อผิดพลาด)
    เว้นว่าง = เริ่มทันทีเมื่อกดเปิด / ไม่มีวันสิ้นสุด"""
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
        if end < base + timedelta(hours=MIN_RUN_HOURS):
            return {}, "วันสิ้นสุดต้องหลังวันเริ่มอย่างน้อย 1 วัน (24 ชั่วโมง)"
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
                  dynamic: bool = False, age_max: Any = DEFAULT_AGE_MAX, interests: Any = None) -> dict[str, Any]:
    """ตัวจริงของ create_adset · dynamic=True = ชิ้นงานโฆษณาแบบไดนามิก (ใช้จากหน้าแอปเท่านั้น
    เพราะ Ad Set แบบนี้ต้องคู่กับโฆษณาแบบ asset_feed_spec ซึ่งเครื่องมือ create_ad ไม่ได้สร้าง)"""
    destination = (destination or "WEBSITE").upper().strip()
    sched, sched_err = _schedule(start_time, end_time)
    if sched_err:
        return {"success": False, "error": sched_err}
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
        if not META_PAGE_ID:
            return {"success": False, "error": "ยังไม่ได้ใส่ META_PAGE_ID ใน .env (ต้องรู้ว่าจะให้ทักแชทเพจไหน)"}
        opt = {"optimization_goal": "CONVERSATIONS", "destination_type": "MESSENGER"}

    payload: dict[str, Any] = {
        "name": with_prefix(name),
        "campaign_id": campaign_id,
        "daily_budget": int(daily_budget_thb) * 100,   # THB เก็บเป็นสตางค์
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
        payload["promoted_object"] = {"page_id": META_PAGE_ID}
    if dynamic:
        if destination not in DYNAMIC_KINDS:
            return {"success": False, "error": creative_options()["dynamic_off_reason"]}
        payload["is_dynamic_creative"] = True

    ok, body = _graph_post(f"{META_AD_ACCOUNT_ID}/adsets", payload)
    log_action("create_adset", ok, {"name": payload["name"], "campaign_id": campaign_id,
                                    "daily_budget_thb": daily_budget_thb, **sched, "dynamic": dynamic,
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
    if not META_PAGE_ID:
        return {"success": False, "error": "ยังไม่ได้ใส่ META_PAGE_ID ใน .env"}
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
        "object_story_spec": {"page_id": META_PAGE_ID},
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
    if not META_PAGE_ID:
        return {"success": False, "error": "ยังไม่ได้ใส่ META_PAGE_ID ใน .env"}

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
            "page_id": META_PAGE_ID,
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


def _page_cover() -> tuple[str | None, str | None]:
    """ชื่อเพจ + ลิงก์รูปปกเพจ (ใช้เป็นรูปโฆษณาเมื่อผู้ใช้ไม่ใส่รูป)"""
    if not META_PAGE_ID:
        return None, None
    ok, body = _graph_get(META_PAGE_ID, {"fields": "name,cover"})
    if not ok:
        return None, None
    return body.get("name"), (body.get("cover") or {}).get("source")


def app_status() -> dict[str, Any]:
    """สถานะของ agent นี้สำหรับหน้าแอป: พร้อมไหม / วันนี้เหลือสร้างได้กี่แคมเปญ / ชื่อเพจ"""
    chk = _run_checks(None, count_campaigns=True)
    used = next((c.get("used") for c in chk["checks"] if c["key"] == "daily_limit"), None)
    # ครบโควตาวันนี้ = ตั้งค่าครบแล้ว แค่สร้างเพิ่มวันนี้ไม่ได้ (ยังดึงชื่อ/รูปปกเพจมาโชว์ตัวอย่างได้)
    configured = all(c["ok"] for c in chk["checks"] if c["key"] != "daily_limit")
    page_name, cover = _page_cover() if configured else (None, None)
    return {
        "agent": AGENT, "prefix": AGENT_PREFIX, "ready": chk["allowed"], "reason": chk["reason"],
        "configured": configured, "quota_full": configured and not chk["allowed"],
        "checks": chk["checks"], "max_daily_budget_thb": MAX_DAILY_BUDGET_THB,
        "max_campaigns_per_day": MAX_CAMPAIGNS_PER_DAY,
        "campaigns_today": used, "page_name": page_name, "page_cover": cover,
        "audience": audience_options(),
        "creative": creative_options(),
    }


def _schedule_label(sched: dict[str, str]) -> str:
    fmt = lambda v: datetime.fromisoformat(v).astimezone(TH_TZ).strftime("%d/%m/%Y %H:%M")  # noqa: E731
    start = f"เริ่ม {fmt(sched['start_time'])}" if "start_time" in sched else "เริ่มทันทีเมื่อกดเปิด"
    end = f"ถึง {fmt(sched['end_time'])}" if "end_time" in sched else "ไม่มีวันสิ้นสุด"
    return f"{start} {end}"


def create_full(spec: dict[str, Any]) -> dict[str, Any]:
    """สร้างครบชุด: check_permission → แคมเปญ → Ad Set → โฆษณา (PAUSED ทั้งหมด) แล้วส่งผลเข้า Dashboard
    spec: kind (MESSENGER/WEBSITE), name, daily_budget_thb, text, link_url?, image_path?, image_url?,
          start_time?, end_time? (เวลาไทย เช่น 2026-11-11T08:00), age_min?, age_max?, languages?,
          interests? [{id,name}] (จากปุ่ม ✨ ในหน้าแอป)
          ชิ้นงานแบบไดนามิก: dynamic=true, image_paths[], video_paths[], texts[], titles[]"""
    steps: list[dict[str, Any]] = []

    def step(key: str, label: str, res: dict[str, Any], detail: str = "") -> bool:
        ok = bool(res.get("success", res.get("allowed")))
        steps.append({"key": key, "label": label, "ok": ok,
                      "detail": detail if ok else (res.get("error") or res.get("reason") or "ไม่สำเร็จ")})
        return ok

    def done(**extra: Any) -> dict[str, Any]:
        return {"success": all(s["ok"] for s in steps), "agent": AGENT, "steps": steps, **extra}

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
    image_path = spec.get("image_path")
    image_url = str(spec.get("image_url") or "").strip()
    if image_path:
        try:
            content = Path(image_path).read_bytes()
        except OSError as e:
            step("image", "รูปโฆษณา", {"success": False, "error": f"เปิดไฟล์รูปไม่ได้: {e}"})
            return done()
        ok, img = _upload_image_bytes(content)
        src = "ไฟล์จากเครื่อง"
    else:
        if not image_url:
            _, image_url = _page_cover()
            src = "รูปปกเพจ"
        else:
            src = "ลิงก์รูป"
        if not image_url:
            step("image", "รูปโฆษณา", {"success": False, "error": "ไม่มีรูป และหารูปปกเพจไม่เจอ — ใส่รูปเอง"})
            return done()
        ok, img = _upload_image(image_url)
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
    ad = _create_ad(adset["adset_id"], f"{name} - โฆษณา", text, link_url, lambda: (True, image_hash))
    if not step("ad", "โฆษณา", ad, "ปุ่ม ส่งข้อความ" if kind == "MESSENGER" else "ปุ่ม ดูเพิ่มเติม"):
        return done(campaign_id=camp["campaign_id"], adset_id=adset["adset_id"])

    # 4) อัปเดตหน้าสรุปผล (ไม่สำเร็จก็ไม่เป็นไร โฆษณาสร้างครบแล้ว)
    dash = send_to_dashboard("last_7d")
    return done(campaign_id=camp["campaign_id"], adset_id=adset["adset_id"], ad_id=ad["ad_id"],
                campaign_name=camp["name"], dashboard_updated=bool(dash.get("delivered")),
                ads_manager_url=f"https://adsmanager.facebook.com/adsmanager/manage/campaigns?act="
                                f"{META_AD_ACCOUNT_ID.removeprefix('act_')}&selected_campaign_ids={camp['campaign_id']}")


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
    "You plan Meta (Facebook) ad targeting for ads shown in Thailand. From the ad copy, propose short search "
    "keywords for Meta's detailed-targeting interest catalog: interests, hobbies, activities, industries, "
    "products and job fields the likely customers have. Prefer common English terms (Meta's catalog matches "
    "them best); Thai is fine for Thailand-only topics. Do not propose age, gender, location, or sensitive "
    "categories (health conditions, religion, politics, sexual orientation, ethnicity, financial hardship). "
    "Order from most to least relevant."
)
AI_KEYWORDS_SCHEMA = {
    "type": "object",
    "properties": {"keywords": {"type": "array", "items": {"type": "string"}}},
    "required": ["keywords"],
    "additionalProperties": False,
}


def _ai_keywords(copy: str) -> tuple[list[str], str | None]:
    """ถาม AI ของ agent นี้ → คำค้นความสนใจ 6–8 คำ"""
    prompt = f"Ad copy:\n{copy}\n\nReturn 8 keywords."
    if AI_PROVIDER == "anthropic":
        import anthropic  # โหลดเฉพาะตอนใช้ปุ่ม ✨ — เครื่องมือ MCP อื่นไม่ต้องพึ่ง
        client = anthropic.Anthropic(
            api_key=ANTHROPIC_API_KEY, timeout=60.0, max_retries=2,
            default_headers={"anthropic-workspace-id": ANTHROPIC_WORKSPACE_ID} if ANTHROPIC_WORKSPACE_ID else None)
        try:
            resp = client.messages.create(
                model=AI_MODEL, max_tokens=4000, system=AI_SYSTEM,
                messages=[{"role": "user", "content": prompt}],
                output_config={"effort": "low", "format": {"type": "json_schema", "schema": AI_KEYWORDS_SCHEMA}},
            )
        except anthropic.AuthenticationError:
            return [], "คีย์ Claude ไม่ถูกต้องหรือหมดอายุ — ตรวจ ANTHROPIC_API_KEY ที่แท็บ \"เชื่อมต่อ API\""
        except anthropic.RateLimitError:
            return [], "Claude ถูกใช้ถี่เกินไป — รอสักครู่แล้วกดใหม่"
        except anthropic.APIStatusError as e:
            why = _api_error_text(e.body)
            # 400 "not scoped to a workspace" / 403-404 workspace ผิด — แยกบอกเพราะแก้ที่ช่อง Workspace ID
            if "workspace" in why.lower():
                if not ANTHROPIC_WORKSPACE_ID:
                    return [], CLAUDE_NEEDS_WORKSPACE
                return [], (f"Workspace ID \"{ANTHROPIC_WORKSPACE_ID}\" ใช้กับคีย์นี้ไม่ได้ — ตรวจที่แท็บ \"เชื่อมต่อ API\" "
                            f"(Claude: {why})")
            if isinstance(e, anthropic.NotFoundError):
                return [], f"ไม่พบรุ่น AI \"{AI_MODEL}\" — แก้ AI_MODEL ใน .env หรือเว้นว่างเพื่อใช้ค่าเริ่มต้น"
            if isinstance(e, anthropic.PermissionDeniedError):
                return [], f"คีย์ Claude นี้ไม่มีสิทธิ์เรียกใช้ — ตรวจสิทธิ์ของคีย์ (Claude: {why or 'ไม่ระบุ'})"
            return [], f"Claude ปฏิเสธคำขอ (HTTP {e.status_code}): {why or 'ไม่ระบุสาเหตุ'}"
        except anthropic.APIConnectionError:
            return [], "เชื่อมต่อ Claude ไม่ได้ — ตรวจอินเทอร์เน็ต"
        if resp.stop_reason == "refusal":
            return [], "Claude ไม่คิดกลุ่มเป้าหมายให้ข้อความนี้ — ลองปรับข้อความโฆษณา"
        text = next((b.text for b in resp.content if b.type == "text"), "")
    else:
        try:
            r = requests.post("https://api.openai.com/v1/chat/completions", timeout=60,
                              headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                              json={"model": AI_MODEL, "response_format": {"type": "json_object"},
                                    "messages": [{"role": "system", "content": AI_SYSTEM + ' Reply as JSON: {"keywords": [...]}'},
                                                 {"role": "user", "content": prompt}]})
        except requests.RequestException:
            return [], "เชื่อมต่อ OpenAI ไม่ได้ — ตรวจอินเทอร์เน็ต"
        if r.status_code == 401:
            return [], "คีย์ OpenAI ไม่ถูกต้องหรือหมดอายุ — ตรวจ OPENAI_API_KEY ที่แท็บ \"เชื่อมต่อ API\""
        if r.status_code == 404:
            return [], f"ไม่พบรุ่น AI \"{AI_MODEL}\" — แก้ AI_MODEL ใน .env หรือเว้นว่างเพื่อใช้ค่าเริ่มต้น"
        try:
            err_body = r.json() if r.status_code != 200 else {}
        except ValueError:
            err_body = {}
        if r.status_code == 429:
            # เครดิตหมด (insufficient_quota) กับใช้ถี่เกิน ได้ 429 เหมือนกัน แต่แก้คนละทาง
            err = err_body.get("error") if isinstance(err_body, dict) else None
            if isinstance(err, dict) and err.get("type") == "insufficient_quota":
                return [], ("เครดิต OpenAI หมด — เติมเครดิตที่ platform.openai.com → Settings → Billing "
                            "แล้วกดใหม่ (กดซ้ำตอนนี้ก็ไม่ผ่าน)")
            return [], "OpenAI ถูกใช้ถี่เกินไป — รอสักครู่แล้วกดใหม่"
        if r.status_code != 200:
            return [], f"OpenAI ปฏิเสธคำขอ (HTTP {r.status_code}): {_api_error_text(err_body) or 'ไม่ระบุสาเหตุ'}"
        try:
            text = r.json()["choices"][0]["message"]["content"] or ""
        except (ValueError, KeyError, IndexError):
            return [], "OpenAI ตอบกลับในรูปแบบที่อ่านไม่ได้"
    try:
        words = [str(w).strip() for w in json.loads(text).get("keywords", []) if str(w).strip()]
    except (ValueError, AttributeError):
        return [], "AI ตอบกลับในรูปแบบที่อ่านไม่ได้ — กดใหม่อีกครั้ง"
    return list(dict.fromkeys(words))[:12], None


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
    copy = "\n".join(texts + [f"Headline: {t}" for t in titles] + ([f"Link: {link}"] if link else []))[:4000]
    words, err = _ai_keywords(copy)
    if err:
        log_action("suggest_interests", False, {"ai": info["label"], "model": AI_MODEL, "error": err})
        return {"success": False, "error": err}
    found, missed = _search_interests(words)
    log_action("suggest_interests", bool(found), {"ai": info["label"], "model": AI_MODEL, "keywords": words,
                                                  "interests": [x["name"] for x in found], "missed": missed})
    if not found:
        return {"success": False, "error": "AI คิดคำค้นได้ แต่ไม่ตรงกับความสนใจในคลังของ Meta — ลองปรับข้อความแล้วกดใหม่"}
    return {"success": True, "ai": info["label"], "model": AI_MODEL, "keywords": words, "missed": missed,
            "interests": found}


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
    if ARGS.status or ARGS.create_json or ARGS.suggest_json:
        if ARGS.status:
            out = app_status()
        elif ARGS.suggest_json:
            out = suggest_interests(json.loads(Path(ARGS.suggest_json).read_text(encoding="utf-8")))
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

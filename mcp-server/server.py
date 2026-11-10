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
    5) Ad Set ใช้ Advantage+ Audience (targeting_automation.advantage_audience = 1) ไม่ใส่ interest
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import threading
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
MAX_DAILY_BUDGET_THB = int(os.getenv("MAX_DAILY_BUDGET_THB", "1000"))
MAX_CAMPAIGNS_PER_DAY = int(os.getenv("MAX_CAMPAIGNS_PER_DAY", "5"))
DASHBOARD_API_URL = os.getenv("DASHBOARD_API_URL", "").strip()
DASHBOARD_API_SECRET = os.getenv("DASHBOARD_API_SECRET", "").strip()
GRAPH_API_VERSION = os.getenv("GRAPH_API_VERSION", "v21.0").strip()
MCP_HTTP_TOKEN = os.getenv("MCP_HTTP_TOKEN", "").strip()            # กุญแจป้องกันโหมด HTTP
MCP_PUBLIC_HOST = os.getenv("MCP_PUBLIC_HOST", "").strip()          # เช่น xxxx.ngrok-free.app

BASE_URL = f"https://graph.facebook.com/{GRAPH_API_VERSION}"
__version__ = "0.2.1"
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


def _graph_get(path: str, params: dict[str, Any] | None = None) -> tuple[bool, Any]:
    p = dict(params or {})
    p["access_token"] = META_ACCESS_TOKEN
    try:
        r = requests.get(f"{BASE_URL}/{path}", params=p, timeout=HTTP_TIMEOUT)
        body = r.json()
    except Exception as e:  # noqa: BLE001
        return False, {"error": {"message": f"เชื่อมต่อ Meta ไม่ได้: {e}"}}
    return (r.status_code == 200 and "error" not in body), body


def _graph_post(path: str, data: dict[str, Any]) -> tuple[bool, Any]:
    # ด่านสุดท้าย: ห้ามส่งอะไรที่ไม่ใช่ PAUSED ออกไปเด็ดขาด
    if "status" in data and data["status"] != REQUIRED_STATUS:
        raise RuntimeError("BLOCKED: อนุญาตเฉพาะ status=PAUSED เท่านั้น")
    payload = {k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in data.items()}
    payload["access_token"] = META_ACCESS_TOKEN
    try:
        r = requests.post(f"{BASE_URL}/{path}", data=payload, timeout=HTTP_TIMEOUT)
        body = r.json()
    except Exception as e:  # noqa: BLE001
        return False, {"error": {"message": f"เชื่อมต่อ Meta ไม่ได้: {e}"}}
    return (r.status_code == 200 and "error" not in body), body


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


MESSENGER_LINK = "https://fb.com/messenger_doc/"   # ลิงก์มาตรฐานของ Meta สำหรับโฆษณาส่งข้อความ


def create_adset(campaign_id: str, name: str, daily_budget_thb: int, destination: str = "WEBSITE") -> dict[str, Any]:
    """สร้าง Ad Set สถานะ PAUSED ใต้แคมเปญของ agent นี้
    ใช้ Advantage+ Audience (ประเทศไทย อายุ 20+ — กฎ Meta สำหรับไทย) ไม่ใส่ interest — งบหน่วยบาท
    destination: "WEBSITE" (ค่าเริ่มต้น) หรือ "MESSENGER" = โฆษณายิงข้อความ ให้คนกดทักแชทเพจ
                 (MESSENGER ใช้กับแคมเปญ OUTCOME_ENGAGEMENT เท่านั้น)"""
    destination = (destination or "WEBSITE").upper().strip()
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
        "targeting": {
            "geo_locations": {"countries": ["TH"]},
            "age_min": 20,   # Meta บังคับอายุขั้นต่ำ 20 ปีสำหรับผู้ชมในไทย
            "targeting_automation": {"advantage_audience": 1},   # Advantage+ Audience
        },
        "status": REQUIRED_STATUS,
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

    ok, body = _graph_post(f"{META_AD_ACCOUNT_ID}/adsets", payload)
    log_action("create_adset", ok, {"name": payload["name"], "campaign_id": campaign_id,
                                    "daily_budget_thb": daily_budget_thb,
                                    "adset_id": body.get("id") if ok else None,
                                    "error": None if ok else _meta_error(body)})
    if not ok:
        return {"success": False, "error": _meta_error(body)}
    return {"success": True, "adset_id": body["id"], "name": payload["name"], "status": REQUIRED_STATUS,
            "daily_budget_thb": daily_budget_thb, "audience": "Advantage+ Audience (TH, 20+)",
            "destination": destination,
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
    ok, body = _graph_post(f"{META_AD_ACCOUNT_ID}/adimages",
                           {"bytes": base64.b64encode(content).decode("ascii")})
    if not ok:
        return False, f"อัปโหลดรูปเข้า Meta ไม่ได้: {_meta_error(body)}"
    images = body.get("images", {})
    first = next(iter(images.values()), {})
    return (True, first["hash"]) if first.get("hash") else (False, f"ไม่ได้ image_hash: {body}")


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
    }


def create_full(spec: dict[str, Any]) -> dict[str, Any]:
    """สร้างครบชุด: check_permission → แคมเปญ → Ad Set → โฆษณา (PAUSED ทั้งหมด) แล้วส่งผลเข้า Dashboard
    spec: kind (MESSENGER/WEBSITE), name, daily_budget_thb, text, link_url?, image_path?, image_url?"""
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
    text = str(spec.get("text", "")).strip()
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
    if problems:
        steps.append({"key": "form", "label": "ข้อมูลในฟอร์ม", "ok": False, "detail": " · ".join(problems)})
        return done()
    objective, destination = KINDS[kind]

    # 1) เช็คสิทธิ์ก่อนเสมอ (กฎของระบบ)
    perm = check_permission(budget)
    if not step("check", "เช็คสิทธิ์", perm, "ผ่านทุกเงื่อนไข"):
        return done()

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
    adset = create_adset(camp["campaign_id"], f"{name} - กลุ่มเป้าหมาย", budget, destination)
    if not step("adset", "กลุ่มเป้าหมาย", adset, f"งบ {budget:,} บาท/วัน · ไทย อายุ 20+"):
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
    if ARGS.status or ARGS.create_json:
        if ARGS.status:
            out = app_status()
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

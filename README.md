# my-ads-app — สร้างแคมเปญ Facebook Ads ด้วย AI 3 ตัว (MCP Server + Dashboard)

ให้ **Claude / Manus / ChatGPT** สร้างแคมเปญในบัญชีโฆษณาเดียวกัน แยกกันด้วย Prefix ชื่อแคมเปญ
แล้วดูผลเทียบกันใน Dashboard ธีมมืดภาษาไทย

| Agent   | Prefix   | ไฟล์ตั้งค่า              | โหมดรัน                  |
|---------|----------|--------------------------|--------------------------|
| Claude  | `CLD-`   | `mcp-server/.env.claude`  | stdio (Claude Code/Desktop) |
| Manus   | `MANUS-` | `mcp-server/.env.manus`   | HTTP port 8002           |
| ChatGPT | `GPT-`   | `mcp-server/.env.chatgpt` | HTTP port 8003           |

```
my-ads-app/
├── mcp-server/
│   ├── server.py          ← MCP Server (5 tools)
│   ├── smoke_test.py      ← ทดสอบผ่านโปรโตคอล MCP จริง (ไม่สร้างแคมเปญ)
│   ├── .env.claude  .env.manus  .env.chatgpt  .env.example
│   └── requirements.txt
├── dashboard/             ← Next.js 15 (ธีมมืด ภาษาไทย)
└── README.md
```

## กฎที่โค้ดบังคับ (ไม่ได้พึ่งให้ AI ทำตามเอง)

1. **PAUSED เท่านั้น** — campaign / ad set / ad สร้างเป็น `PAUSED` เสมอ และฟังก์ชันยิง API (`_graph_post`) จะ **ปฏิเสธ** payload ที่ status ไม่ใช่ PAUSED
2. **check_permission ก่อนทุกครั้ง** — `create_campaign / create_adset / create_ad` เรียกตรวจซ้ำเองข้างใน ถ้าไม่ผ่านจะไม่ยิง API เลย
3. **ไม่มี Token ในโค้ด** — อ่านจาก `.env.<agent>` เท่านั้น ไฟล์ `.env.*` อยู่ใน `.gitignore` และไม่ถูกเขียนลง audit log
4. **Prefix อัตโนมัติ** — ชื่อถูกเติม `CLD-` / `MANUS-` / `GPT-` เอง (ถ้า AI พิมพ์ prefix มาเองหรือพิมพ์ของ agent อื่นมา จะถูกแทนที่) และแต่ละ agent **แก้ได้เฉพาะของ prefix ตัวเอง**
5. **Advantage+ Audience** — Ad Set ใช้ `targeting_automation.advantage_audience = 1` (ไทย อายุ 20+ ตามกฎ Meta สำหรับไทย) ไม่มี interest

---

## ขั้นที่ 0 — สิ่งที่ต้องมี

- Python 3.10+ (Windows ใช้คำสั่ง `py` ได้) และ Node.js 18.18+
- Meta Business Manager ที่มีบัญชีโฆษณา (สกุลเงิน **THB**) และเพจ
- **System User แยก 3 ตัว** (หนึ่งตัวต่อ agent) — Business Settings → Users → System Users
  1. Add → ตั้งชื่อเช่น `ai-claude`, บทบาท Employee
  2. **Add Assets** → บัญชีโฆษณา (Manage campaigns) + เพจ
  3. **Generate New Token** เลือกแอปของคุณ แล้วติ๊กสิทธิ์ `ads_management`, `ads_read`, `business_management`, `pages_show_list`, `pages_read_engagement`
  4. คัดลอก token ไปใส่ไฟล์ `.env` ของ agent นั้น (ห้ามส่งในแชต/ห้ามใส่ในโค้ด)

> แยก System User ต่อ agent ทำให้ถอนสิทธิ์ทีละตัวได้ และใน Meta จะเห็นว่าใครสร้างอะไร

## ขั้นที่ 1 — ติดตั้ง MCP Server

```bash
cd my-ads-app/mcp-server
py -m venv .venv                 # macOS/Linux: python3 -m venv .venv
.venv\Scripts\activate           # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
```

## ขั้นที่ 2 — ใส่ค่าใน .env ของแต่ละ Agent

เปิด `mcp-server/.env.claude` (และ `.env.manus`, `.env.chatgpt`) แล้วแก้:

```ini
META_ACCESS_TOKEN=EAAB...           # token ของ System User ตัวนั้น
META_AD_ACCOUNT_ID=act_1029384756   # ต้องขึ้นต้นด้วย act_
META_PAGE_ID=1234567890
AGENT_PREFIX=CLD-                   # ห้ามแก้ (claude=CLD-, manus=MANUS-, chatgpt=GPT-)
MAX_DAILY_BUDGET_THB=1000           # เพดานงบต่อวัน
MAX_CAMPAIGNS_PER_DAY=5             # จำนวนแคมเปญสูงสุดต่อวันต่อ agent
DASHBOARD_API_URL=http://localhost:3000/api/ingest
DASHBOARD_API_SECRET=รหัสลับยาวอย่างน้อย12ตัว   # ต้องตรงกับ dashboard/.env.local
```

ถ้าใช้ objective `OUTCOME_SALES` หรือ `OUTCOME_LEADS` ต้องใส่ `META_PIXEL_ID` ด้วย

**โฆษณาที่ยิงในไทยต้องใส่ `META_VERIFIED_IDENTITY_ID`** (เลขผู้ลงโฆษณาที่ยืนยันตัวตนแล้ว) — Meta บังคับ ไม่ใส่จะสร้าง Ad Set ไม่ได้
หาเลขได้จาก Ad Set เดิมที่เคยยิงโฆษณาสำเร็จในบัญชีนั้น (ช่อง "ผู้รับผลประโยชน์ / ผู้ชำระเงิน") และกลุ่มเป้าหมายในไทยต้องอายุ 20 ปีขึ้นไป

## ขั้นที่ 3 — ทดสอบ check_permission ด้วยงบ 500 บาท ✅

ทำขั้นนี้ก่อนต่อเข้ากับ AI ใด ๆ — **ไม่สร้างอะไรใน Meta** แค่ตรวจสิทธิ์

```bash
cd mcp-server
python server.py --agent claude --test 500
python server.py --agent manus --test 500
python server.py --agent chatgpt --test 500
```

ผลที่ถูกต้อง (ตัวอย่าง):

```json
{
  "allowed": true,
  "reason": "ผ่านทุกเงื่อนไข สร้างแคมเปญได้ (สถานะ PAUSED)",
  "agent": "claude",
  "prefix": "CLD-",
  "checks": [
    { "label": "ค่าใน .env + Prefix",      "ok": true, "detail": "agent=claude prefix=CLD-" },
    { "label": "งบต่อวัน",                 "ok": true, "detail": "500 / เพดาน 1,000 บาท" },
    { "label": "โทเคนใช้งานได้",            "ok": true, "detail": "โทเคนของ ai-claude" },
    { "label": "สิทธิ์เข้าบัญชีโฆษณา",       "ok": true, "detail": "CLD Main Ads (act_...) สกุลเงิน THB" },
    { "label": "จำนวนแคมเปญวันนี้",          "ok": true, "detail": "สร้างแล้ว 0/5 แคมเปญ (CLD-, นับจาก Meta)" }
  ]
}
```

ลองให้มัน **ไม่ผ่าน** เพื่อยืนยันว่าด่านทำงาน:

```bash
python server.py --agent claude --test 5000    # → allowed: false "งบ 5,000 บาท เกินเพดาน ... 1,000 บาท"
```

| ข้อความที่เจอ | สาเหตุ / วิธีแก้ |
|---|---|
| `ยังไม่ได้ใส่ META_ACCESS_TOKEN` / `ต้องเป็นรูปแบบ act_ตัวเลข` | ยังไม่ได้แก้ค่าใน `.env.<agent>` |
| `โทเคนใช้ไม่ได้/หมดอายุ ... code 190` | token ผิดหรือหมดอายุ → Generate ใหม่ใน System User |
| `เข้าบัญชี act_... ไม่ได้` | System User ยังไม่ได้ Add Assets บัญชีโฆษณา |
| `บัญชีต้องใช้สกุลเงิน THB` | โปรแกรมคิดงบเป็นบาท (×100 = สตางค์) บัญชีต้องเป็น THB |
| `สร้างแล้ว 5/5 แคมเปญ` | ครบโควตาวันนี้ — รอพรุ่งนี้ (นับตามเวลาไทย) หรือเพิ่ม `MAX_CAMPAIGNS_PER_DAY` |

ทดสอบผ่านโปรโตคอล MCP จริง (เหมือนที่ AI เรียก):

```bash
python smoke_test.py --agent claude --budget 500
```

## ขั้นที่ 4 — ต่อเข้ากับ AI

### Claude (Claude Code — stdio)

```bash
# รันที่โฟลเดอร์ my-ads-app (ใช้ path เต็มของ python ใน .venv)
claude mcp add meta-ads-claude -- "C:\path\to\my-ads-app\mcp-server\.venv\Scripts\python.exe" "C:\path\to\my-ads-app\mcp-server\server.py" --agent claude
```

Claude Desktop: ใส่ใน `claude_desktop_config.json`

```json
{
  "mcpServers": {
    "meta-ads-claude": {
      "command": "C:\\path\\to\\my-ads-app\\mcp-server\\.venv\\Scripts\\python.exe",
      "args": ["C:\\path\\to\\my-ads-app\\mcp-server\\server.py", "--agent", "claude"]
    }
  }
}
```

### Manus / ChatGPT (HTTP)

```bash
python server.py --agent manus --http      # → http://127.0.0.1:8002/mcp
python server.py --agent chatgpt --http    # → http://127.0.0.1:8003/mcp
```

Manus และ ChatGPT รันบนคลาวด์ จึงต้องเปิด URL สาธารณะ (เช่น `ngrok http 8002`) และ **ต้องตั้งกุญแจ**:

```ini
# ใน .env.manus / .env.chatgpt
MCP_HTTP_TOKEN=กุญแจยาวๆ-สุ่มเอง
MCP_PUBLIC_HOST=xxxx.ngrok-free.app     # โดเมนที่ ngrok ให้มา
```

- **Manus**: เพิ่ม Custom MCP แบบ HTTP → URL `https://xxxx.ngrok-free.app/mcp` + header `Authorization: Bearer <MCP_HTTP_TOKEN>`
- **ChatGPT** (Settings → Connectors → Developer mode → Create): URL `https://yyyy.ngrok-free.app/mcp?key=<MCP_HTTP_TOKEN>` เลือก No authentication (กุญแจอยู่ใน URL แล้ว)

ไม่มีกุญแจ → server ตอบ `401 unauthorized` ทุกคำขอ

## ขั้นที่ 5 — รัน Dashboard

```bash
cd my-ads-app/dashboard
copy .env.example .env.local      # macOS/Linux: cp .env.example .env.local
# แก้ DASHBOARD_API_SECRET ให้ตรงกับใน mcp-server/.env.*
npm install
npm run dev                        # → http://localhost:3000
```

- ยังไม่มีข้อมูลจริง → หน้าจอแสดง **ข้อมูลตัวอย่าง** พร้อมป้ายเตือนสีเหลือง
- แท็บ **เชื่อมต่อ API**:
  1. *รับข้อมูลจาก MCP* — endpoint สำหรับ `DASHBOARD_API_URL` + ช่องทดสอบ secret + เวลารับข้อมูลล่าสุดของแต่ละ agent
  2. *ดึงจาก Meta Graph API ตรง* — ใส่ `META_READ_TOKEN` (สิทธิ์ `ads_read` พอ) + `META_AD_ACCOUNT_ID` ใน `.env.local` แล้วกด "ทดสอบการเชื่อมต่อ" / "ดึงข้อมูลตอนนี้" (token อยู่ฝั่ง server ไม่ถูกส่งไปเบราว์เซอร์)
  3. *สร้างไฟล์ .env* — เลือก agent / งบ / จำนวนแคมเปญ แล้วคัดลอก (ไม่มีช่องให้วาง token บนเว็บโดยตั้งใจ)
- ข้อมูลเก็บที่ `dashboard/data/store.json` (ลบไฟล์นี้ = เริ่มใหม่)

## ขั้นที่ 6 — ใช้งานจริง (ตัวอย่างคำสั่งถึง AI)

> เช็คสิทธิ์ด้วยงบ 500 บาท แล้วสร้างแคมเปญ Traffic ชื่อ "คอร์สออนไลน์-พ.ย." งบ 500 บาท
> สร้าง ad set ชื่อ "TH-20+" งบ 500 บาท แล้วสร้างโฆษณาข้อความ "สมัครวันนี้ลด 30%"
> ลิงก์ https://example.com รูป https://example.com/banner.jpg
> เสร็จแล้วส่งผล 7 วันล่าสุดเข้า Dashboard

ลำดับ tool ที่ AI จะเรียก:

| # | Tool | หมายเหตุ |
|---|------|----------|
| 1 | `check_permission(daily_budget_thb)` | ตรวจ token / สิทธิ์บัญชี / งบ ≤ เพดาน / จำนวนแคมเปญวันนี้ |
| 2 | `create_campaign(name, objective, daily_budget_thb)` | objective: `OUTCOME_TRAFFIC` `OUTCOME_AWARENESS` `OUTCOME_ENGAGEMENT` `OUTCOME_LEADS` `OUTCOME_SALES` · งบจริงอยู่ที่ Ad Set |
| 3 | `create_adset(campaign_id, name, daily_budget_thb, destination="WEBSITE")` | Advantage+ Audience, optimization ตาม objective ของแคมเปญ · `destination="MESSENGER"` = **โฆษณายิงข้อความ** (คนกดทักแชทเพจ, ใช้กับแคมเปญ `OUTCOME_ENGAGEMENT`) |
| 4 | `create_ad(adset_id, name, page_post_text, link_url, image_url)` | ดาวน์โหลดรูป → อัปโหลดเป็น image_hash → Creative → Ad · ถ้า Ad Set เป็น MESSENGER ปุ่มจะเป็น "ส่งข้อความ" และไม่ใช้ `link_url` |

| 5 | `send_to_dashboard(date_preset)` | `today` `yesterday` `last_7d` `last_14d` `last_30d` `this_month` `last_month` · ส่งเฉพาะแคมเปญ prefix ตัวเอง แยกรายวัน |

ทุกอย่างจะอยู่ในสถานะ **PAUSED** → ตรวจใน Ads Manager แล้วกดเปิดเองด้วยมือ
**ตัวอย่างสั่งงาน (ยิงข้อความ):** "สร้างแคมเปญยิงข้อความ งบ 500 บาท ให้คนทักแชทเพจ ข้อความว่า …" → Claude จะสร้าง `OUTCOME_ENGAGEMENT` + Ad Set `destination="MESSENGER"` + โฆษณาปุ่มส่งข้อความ (PAUSED ทั้งหมด)

## ขั้นที่ 7 — แอป Ads Control (ไอคอนบนหน้าจอ + หน้าสร้างโฆษณา)

ใช้งานโดยไม่ต้องพิมพ์สั่งในแชต:

1. ดับเบิลคลิกไอคอน **Ads Control** บนหน้าจอ → ถ้าหน้าเว็บยังไม่รัน ตัวเปิดจะรันให้แบบซ่อนหน้าต่าง (รอราว 10 วินาที) แล้วเปิดเป็นหน้าต่างแอปของ Chrome/Edge
2. แท็บ **＋ สร้างโฆษณา** → เลือกผู้สร้าง (Claude / Manus / ChatGPT) · ชนิด (ยิงข้อความ / พาเข้าเว็บไซต์) · ชื่อ · งบ · ข้อความ · รูป (ไฟล์จากเครื่อง / ลิงก์รูป / ไม่ใส่ = รูปปกเพจ) → กด **สร้างโฆษณา**
3. ระบบทำครบชุด: เช็คสิทธิ์ → อัปโหลดรูป → แคมเปญ → กลุ่มเป้าหมาย → โฆษณา (PAUSED ทั้งหมด) → อัปเดตหน้าภาพรวม แล้วโชว์ผลทีละขั้น + ลิงก์เปิดใน Ads Manager

ไฟล์ที่เกี่ยวข้อง:

| ไฟล์ | หน้าที่ |
|------|---------|
| `launcher/AdsControl.vbs` → `AdsControl.ps1` | ตัวเปิดแอป (ไอคอนบนหน้าจอชี้มาที่ .vbs) · log อยู่ที่ `%TEMP%ds-control.log` |
| `launcher/ads-control.ico` | ไอคอน |
| `dashboard/components/CreatePanel.tsx` | หน้าฟอร์ม + ตัวอย่างโฆษณาสด |
| `dashboard/app/api/agents`, `app/api/create` | เรียก `server.py --status` / `--create-json` (ใช้ได้จากเครื่องนี้เท่านั้น) |

- กฎทั้งหมด (PAUSED / เช็คสิทธิ์ / เพดานงบ / จำนวนแคมเปญต่อวัน / ชื่อขึ้นต้น prefix) อยู่ใน `server.py` ที่เดียว — หน้าแอปเรียกใช้ตัวเดียวกับ AI
- `--create-json` อ่านไฟล์รูปจากเครื่องได้ จึง **ไม่ได้เปิดเป็นเครื่องมือ MCP** (กัน agent ภายนอกดึงไฟล์ในเครื่อง) และหน้าเว็บรันที่ `127.0.0.1` เท่านั้น
- ผู้สร้างที่ยังไม่มีรหัสใน `.env.<agent>` จะขึ้นป้าย "ยังไม่ตั้งค่า" และกดเลือกไม่ได้ · ครบโควตาวันนี้จะขึ้น "ครบโควตาวันนี้"

สร้างไอคอนบนหน้าจอใหม่ (ถ้าหาย): คลิกขวา `launcher/AdsControl.vbs` → Send to → Desktop (create shortcut) แล้วเปลี่ยนไอคอนเป็น `launcher/ads-control.ico`

## Audit log

ทุกการเรียก tool ถูกบันทึกที่ `mcp-server/logs/audit_<agent>.jsonl` (เวลาไทย, ผ่าน/ไม่ผ่าน, id ที่ได้, error) — ไม่มี token

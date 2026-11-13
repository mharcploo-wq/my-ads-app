"use client";
/** ร่างฟอร์ม "สร้างโฆษณาใหม่" — เก็บไว้ในเบราว์เซอร์เครื่องนี้จนกว่าจะกดรีเซ็ต (ไม่ส่งออกไปไหน)
 *  - ข้อความทุกช่อง → localStorage (อ่านได้ทันทีตอนเปิดฟอร์ม)
 *  - รูป/คลิป → IndexedDB (ไฟล์ใหญ่ เก็บใน localStorage ไม่ได้) · เก็บทีละไฟล์ ไฟล์ไหนเก็บไม่ลงก็บอกได้ทีละไฟล์ */

const KEY = "ads-create-draft-v1";
const DB = "ads-create-draft";
const STORE = "files";

/** ทุกช่องในฟอร์มที่เป็นข้อความ/ตัวเลือก (ไม่รวมไฟล์) */
export interface FormDraft {
  agent: string; kind: string; name: string; budget: string; text: string; link: string; imageUrl: string;
  startMode: "now" | "set"; startDate: string; startTime: string; hasEnd: boolean; endDate: string; endTime: string;
  ageMin: number | null; ageMax: number | null; langs: string[] | null;
  interests: { id: string; name: string; size_lower?: number | null; size_upper?: number | null;
    th_lower?: number | null; th_upper?: number | null }[];
  dynamic: boolean; texts: string[]; titles: string[];
  liveId: string; liveHours: number | null;   // ชนิด Live สด: Live ที่เลือก + ความยาว (null = ค่าเริ่มต้นของ server.py)
  pageId?: string;   // เพจที่จะยิง ("" = เพจประจำ agent)
  portfolio?: number;   // พอร์ตโฟลิโอธุรกิจ (1 = พอร์ตหลัก)
  savedAt: number;
}

/** กลุ่มไฟล์ในฟอร์ม: single = รูปเดียว (โฆษณาปกติ) · images/videos = ชิ้นงานไดนามิก */
export type FileGroup = "single" | "images" | "videos";

export function loadDraft(): Partial<FormDraft> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    const d = raw ? JSON.parse(raw) : null;
    return d && typeof d === "object" ? d : null;
  } catch {
    return null;
  }
}

export function saveDraft(d: FormDraft): boolean {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(d));
    return true;
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** แทนที่ไฟล์ทั้งกลุ่ม → ชื่อไฟล์ที่เก็บไม่ลง (เช่น พื้นที่เบราว์เซอร์ไม่พอ) */
export async function saveFiles(group: FileGroup, files: File[]): Promise<string[]> {
  const failed: string[] = [];
  try {
    const db = await openDb();
    const clear = db.transaction(STORE, "readwrite");
    clear.objectStore(STORE).delete(IDBKeyRange.bound(`${group}:`, `${group}:￿`));
    await done(clear);
    for (const [i, f] of files.entries()) {   // ทีละไฟล์ — คลิปใหญ่ตัวเดียวเก็บไม่ลงก็ไม่ลากไฟล์อื่นไปด้วย
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(f, `${group}:${String(i).padStart(3, "0")}`);
        await done(tx);
      } catch {
        failed.push(f.name);
      }
    }
    db.close();
  } catch {
    return files.map((f) => f.name);
  }
  return failed;
}

/** ไฟล์ที่เก็บไว้ทั้งหมด แยกตามกลุ่ม (เรียงตามลำดับเดิม) */
export async function loadFiles(): Promise<Record<FileGroup, File[]>> {
  const out: Record<FileGroup, File[]> = { single: [], images: [], videos: [] };
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const [keys, vals] = await Promise.all([store.getAllKeys(), store.getAll()].map((r) =>
      new Promise<unknown[]>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); })));
    db.close();
    keys.map((k, i) => [String(k), vals[i]] as const).sort(([a], [b]) => a.localeCompare(b)).forEach(([k, v]) => {
      const g = k.split(":")[0] as FileGroup;
      if (g in out && v instanceof File) out[g].push(v);
    });
  } catch { /* เปิดคลังไม่ได้ = ไม่มีไฟล์ค้าง */ }
  return out;
}

/** ปุ่มรีเซ็ต: ล้างทั้งข้อความและไฟล์ */
export async function clearDraft(): Promise<void> {
  try { window.localStorage.removeItem(KEY); } catch { /* ไม่มีอะไรให้ล้าง */ }
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    await done(tx);
    db.close();
  } catch { /* ไม่มีอะไรให้ล้าง */ }
}

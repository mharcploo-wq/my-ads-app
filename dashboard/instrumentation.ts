/** Next.js เรียกครั้งเดียวตอนเซิร์ฟเวอร์เริ่ม — เริ่มตัวจับเวลาอัปเดตหน้า Daily Briefing (เวลาตั้งได้ในหน้า /briefing)
 *  ต้องเขียนเป็น if (=== "nodejs") ตามแบบของ Next — ฝั่ง edge จะตัด import นี้ทิ้ง (ใช้ fs ไม่ได้) */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startBriefingScheduler } = await import("./lib/briefingSchedule");
    startBriefingScheduler();
  }
}

import { afterEach, describe, expect, it, vi } from "vitest";

// ใช้ยืนยันว่าระบบ test ทำงานใน CI รวมถึงนาฬิกาจำลองที่ test ของ tick (#8, #20) ต้องใช้
// ลบไฟล์นี้ได้เมื่อมี test ของ seam จริงแล้ว
describe("test setup", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs in UTC", () => {
    expect(new Date(0).getHours()).toBe(0);
  });

  it("can fake the clock", () => {
    vi.useFakeTimers();
    // วันจันทร์ 16 พ.ย. 2026 เวลา 09:00 กรุงเทพฯ = 02:00 UTC
    vi.setSystemTime(new Date("2026-11-16T02:00:00Z"));
    expect(new Date().toISOString()).toBe("2026-11-16T02:00:00.000Z");
  });
});

import { defineConfig } from "vitest/config";

// test รันใน Node ผ่าน event seam และ Dashboard read seam (ดู docs/PROJECT.md)
// ใช้ fake แทน LINE, OpenRouter, Google Drive และ Supabase จึงไม่ต้องมี DOM ของเบราว์เซอร์
export default defineConfig({
  // ให้ใช้ alias "@/*" ตามที่ตั้งไว้ใน tsconfig.json ได้
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // ให้ test ใช้เขตเวลาเดียวกับ server จริง (UTC)
    // เวลากรุงเทพฯ ต้องคำนวณในโค้ดเองเสมอ ห้ามพึ่งเขตเวลาของเครื่อง
    env: { TZ: "UTC" },
  },
});

import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ADD_FRIEND_URL } from "./fonts";
import { LegalFooter } from "./legal";

// Home page of the app's domain: what NongJoDII is and how to start. The product itself
// lives in LINE (docs/PROJECT.md); this page only introduces it, and gives Google's OAuth
// consent screen a homepage to link to. Logo: Figma "Logo" page, "Cell v38 Final".

export const metadata: Metadata = {
  title: "น้องจดดี · NongJoDII",
  description: "ผู้ช่วยจดงานในกลุ่ม LINE: สรุปแชตเป็นงาน เก็บไฟล์ลง Google Drive ติดตามความคืบหน้า และสรุปทุกสัปดาห์",
};

const FEATURES = [
  { title: "สรุปแชตเป็นงาน", body: "พิมพ์ “น้องจดดี สรุปหน่อย” แล้วตรวจและยืนยันงานก่อนสร้างจริง ไม่มีงานไหนเกิดขึ้นเองโดยไม่มีคนยืนยัน" },
  { title: "เก็บไฟล์ลง Drive ของคุณ", body: "ไฟล์และรูปในกลุ่มถูกเก็บลง Google Drive ของเจ้าของกลุ่ม แยกโฟลเดอร์ตามกลุ่ม ไฟล์ไม่หายแม้ใน LINE จะหมดอายุ" },
  { title: "ติดตามความคืบหน้าจากแชต", body: "คุยงานตามปกติ น้องจดดีถามยืนยันเมื่อมีคนบอกว่างานเสร็จ สถานะเปลี่ยนเมื่อมีคนกดยืนยันเท่านั้น" },
  { title: "เตือนงานที่ต้องตาม", body: "เตือนงานใกล้ถึงกำหนด งานเลยกำหนด งานที่ยังไม่มีผู้รับ และงานที่เงียบเกิน 5 วัน ตามเวลาที่กลุ่มเลือก" },
  { title: "สรุปรายสัปดาห์ + Dashboard", body: "ดูงานทุกกลุ่มของโปรเจกต์ในที่เดียว สมาชิกเห็นเฉพาะกลุ่มของตัวเอง" },
  { title: "ปรับได้ทุกเมื่อ", body: "พิมพ์ “น้องจดดี ตั้งค่า” ในกลุ่ม เจ้าของบอทเปลี่ยนฟีเจอร์ เวลาเตือน ชื่อเล่นและหน้าที่ของทีมได้" },
] as const;

const STEPS = [
  "เพิ่มน้องจดดีเป็นเพื่อนใน LINE",
  "เชิญน้องจดดีเข้ากลุ่มที่ใช้คุยงาน",
  "ตั้งค่ากลุ่ม และให้เจ้าของกลุ่มเชื่อม Google Drive",
] as const;

export default function Home() {
  return (
    <div lang="th" className="flex flex-1 flex-col bg-page font-thai text-ink [color-scheme:light]">
      {/* Brand app bar, as on the LIFF pages (Figma UI v4). */}
      <div className="bg-brand text-white">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center px-6">
          <Link href="/" className="font-semibold">น้องจดดี</Link>
        </div>
      </div>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-16 px-6 py-16 sm:py-24">
        <section className="flex flex-col items-start gap-6">
          <div className="flex items-center gap-4">
            <Image src="/logo.svg" alt="" width={72} height={72} unoptimized priority />
            <div>
              <h1 className="text-4xl font-bold leading-tight sm:text-5xl">น้องจดดี</h1>
              <p className="font-semibold text-primary">NongJoDII</p>
            </div>
          </div>
          {/* Thai has no spaces between words: the nowrap spans keep words the browser
              would otherwise split ("แช|ต", "หลุด|หาย"). */}
          <p className="text-xl leading-relaxed text-balance sm:text-2xl">
            ผู้ช่วยจดงานในกลุ่ม LINE ให้ทุกงาน<span className="whitespace-nowrap">ในแชต</span>มีคนรับ{" "}
            <span className="whitespace-nowrap">มีกำหนดส่ง</span>{" "}
            <span className="whitespace-nowrap">และไม่หลุดหาย</span>
          </p>
          {ADD_FRIEND_URL ? (
            <a
              href={ADD_FRIEND_URL}
              className="rounded-full bg-[#06C755] px-6 py-3 font-semibold text-white hover:bg-[#05B34C]"
            >
              เพิ่มน้องจดดีเป็นเพื่อนใน LINE
            </a>
          ) : null}
        </section>

        <section aria-labelledby="features" className="flex flex-col gap-6">
          <h2 id="features" className="text-2xl font-bold">ทำอะไรได้บ้าง</h2>
          <ul className="grid gap-4 sm:grid-cols-2">
            {FEATURES.map((f) => (
              <li key={f.title} className="rounded-2xl border border-line p-5">
                <h3 className="font-semibold">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-2">{f.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="start" className="flex flex-col gap-6">
          <h2 id="start" className="text-2xl font-bold">เริ่มใช้งาน</h2>
          <ol className="flex flex-col gap-3">
            {STEPS.map((s, i) => (
              <li key={s} className="flex items-center gap-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-soft font-semibold text-primary">
                  {i + 1}
                </span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <LegalFooter />
    </div>
  );
}

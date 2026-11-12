import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ADD_FRIEND_URL, thai } from "../fonts";

// Privacy policy (#47), linked from the homepage and from Google's OAuth consent screen.
// Every statement here must match what the app does; check it against
// supabase/migrations/, docs/PROJECT.md and .greptile/rules.md when either changes.
//
// BEFORE PUBLISHING: the "การลบข้อมูล" section states the agreed removal rules. They depend
// on #11 (purge 7 days after the bot leaves) and #24 (unsend deletes the stored message),
// which are not built yet (2026-11-13). Do not link this page from the consent screen
// until both have landed.

export const metadata: Metadata = {
  title: "นโยบายความเป็นส่วนตัว · น้องจดดี",
  description: "น้องจดดีเก็บข้อมูลอะไร ใช้ทำอะไร ใครเห็น และลบเมื่อไหร่",
};

/** Bump on every change to what this page says. */
const UPDATED = "13 พฤศจิกายน 2569";

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-xl font-bold">{title}</h2>
      <div className="flex flex-col gap-3 leading-relaxed text-[#2E3A4F]">{children}</div>
    </section>
  );
}

function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="flex list-disc flex-col gap-2 pl-6">
      {items.map((item, i) => <li key={i}>{item}</li>)}
    </ul>
  );
}

export default function Privacy() {
  return (
    <div lang="th" className={`${thai.className} flex flex-1 flex-col bg-white text-[#14213D]`}>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-6 py-16">
        <header className="flex flex-col gap-2">
          <Link href="/" className="text-sm text-[#1F5BAD] underline underline-offset-4">← น้องจดดี</Link>
          <h1 className="text-3xl font-bold">นโยบายความเป็นส่วนตัว</h1>
          <p className="text-sm text-[#8A94A6]">ปรับปรุงล่าสุด {UPDATED}</p>
          <p className="leading-relaxed text-[#2E3A4F]">
            น้องจดดี (NongJoDII) เป็นบอท LINE และหน้าเว็บในแอป LINE (LIFF) ที่ช่วยจดงานจากแชตกลุ่ม
            พัฒนาโดยทีมนักศึกษาในโครงการ DII Design, Pitching &amp; Hackathon 2026
            หน้านี้อธิบายว่าเราเก็บข้อมูลอะไร ใช้ทำอะไร ใครเห็น และลบเมื่อไหร่
          </p>
        </header>

        <Section id="collect" title="ข้อมูลที่เราเก็บ">
          <List items={[
            <><b>จาก LINE:</b> รหัสผู้ใช้ LINE ชื่อที่แสดง รหัสและชื่อกลุ่ม
              และข้อความในกลุ่มที่น้องจดดีเป็นสมาชิก (ข้อความ ผู้ส่ง เวลา และการแท็ก)
              เราเก็บเฉพาะข้อความที่ส่งหลังน้องจดดีเข้ากลุ่ม ไม่ดึงข้อความย้อนหลัง</>,
            <><b>งาน:</b> สรุปแชต งานที่สมาชิกยืนยัน ผู้รับงาน กำหนดส่ง สถานะ และคำตอบที่กดในการ์ด</>,
            <><b>จากฟอร์มตั้งค่ากลุ่ม:</b> กลุ่มทำเรื่องอะไร ชื่อเล่นและบทบาทของสมาชิก
              ชื่อเล่นใช้ให้ AI เข้าใจว่าแชตพูดถึงใครเท่านั้น หน้าจอทุกหน้าแสดงชื่อ LINE</>,
            <><b>จาก Google (เฉพาะเจ้าของกลุ่มที่เชื่อม Google Drive):</b> รหัสบัญชี Google อีเมล
              สิทธิ์ที่อนุญาต และโทเค็นสำหรับเข้าถึง Drive ซึ่งเราเข้ารหัสก่อนเก็บ
              รวมถึงชื่อ ขนาด และลิงก์ของไฟล์ที่น้องจดดีบันทึกให้</>,
            <><b>สถิติการใช้งาน:</b> จำนวนการใช้ AI ต่อเจ้าของกลุ่ม (เพื่อจำกัดการใช้งานฟรี)
              และจำนวนข้อความที่บอทส่ง (เพื่อไม่ให้เกินโควตาของ LINE)</>,
          ]} />
        </Section>

        <Section id="drive" title="Google Drive">
          <List items={[
            <>น้องจดดีขอสิทธิ์ <code className="rounded bg-[#F2F4F7] px-1">drive.file</code> ซึ่งเข้าถึงได้
              <b>เฉพาะไฟล์และโฟลเดอร์ที่น้องจดดีสร้างเอง</b> ไม่สามารถอ่านไฟล์อื่นใน Drive ของคุณ</>,
            <>ไฟล์และรูปที่ส่งในกลุ่มถูกบันทึกลง Drive ของเจ้าของกลุ่มในโฟลเดอร์ “NongJoDII” แยกตามกลุ่ม
              ไฟล์เป็นของเจ้าของกลุ่ม ไม่ได้เก็บไว้ที่เรา</>,
            <>โฟลเดอร์ของโปรเจกต์ถูกแชร์แบบ <b>ทุกคนที่มีลิงก์ดูได้</b> เพื่อให้สมาชิกเปิดไฟล์ได้โดยไม่ต้องมีบัญชี Google
              ใครที่ได้รับลิงก์ก็เปิดดูไฟล์ได้</>,
            <>เราใช้ข้อมูลจาก Google เพื่อบันทึกไฟล์ให้กลุ่มเท่านั้น ไม่ขาย ไม่ใช้โฆษณา
              และไม่ส่งไฟล์จาก Drive ไปให้ AI</>,
            <>ถอนสิทธิ์ได้ทุกเมื่อที่ <a className="text-[#1F5BAD] underline underline-offset-4" href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> งานในกลุ่มยังอยู่ แต่ไฟล์ใหม่จะไม่ถูกบันทึกจนกว่าจะเชื่อมอีกครั้ง</>,
          ]} />
        </Section>

        <Section id="ai" title="การใช้ AI">
          <p>
            เมื่อมีคนสั่งสรุปแชต และเมื่อน้องจดดีตรวจว่าข้อความในกลุ่มเป็นการรายงานความคืบหน้าหรือไม่
            ข้อความในกลุ่ม ชื่อ ชื่อเล่น และรายการงาน จะถูกส่งผ่าน OpenRouter ไปยังโมเดล AI เพื่อประมวลผล
          </p>
          <p>
            ผลจาก AI เป็นเพียงข้อเสนอ งานจะถูกสร้างหรือเปลี่ยนสถานะเมื่อมีคนกดยืนยันเท่านั้น
          </p>
        </Section>

        <Section id="who" title="ใครเห็นข้อมูล">
          <List items={[
            "สมาชิกเห็นงานของกลุ่มที่ตัวเองอยู่ คนนอกกลุ่มเปิดดูไม่ได้",
            "ผู้ดูแลโปรเจกต์ (PM) เห็นงานทุกกลุ่มของโปรเจกต์บน Dashboard",
            "สมาชิกที่ออกจากกลุ่มจะดูข้อมูลของกลุ่มนั้นไม่ได้อีก แต่ชื่อยังอยู่บนงานที่ทำเสร็จแล้ว",
            "ทีมพัฒนาเข้าถึงฐานข้อมูลเพื่อดูแลระบบเท่านั้น",
          ]} />
        </Section>

        <Section id="providers" title="บริการที่เราใช้">
          <List items={[
            "LINE: รับและส่งข้อความ และยืนยันตัวตนในหน้า LIFF",
            "Supabase: ฐานข้อมูล",
            "Vercel: โฮสต์เว็บและเซิร์ฟเวอร์",
            "OpenRouter: ส่งข้อความไปยังโมเดล AI",
            "Google Drive: เก็บไฟล์ของกลุ่มใน Drive ของเจ้าของกลุ่ม",
            "Microsoft Clarity: สถิติการใช้หน้า LIFF โดยซ่อนข้อความทั้งหมดบนหน้า และลิงก์ของหน้ามีแต่รหัส ไม่มีชื่องานหรือข้อความแชต",
          ]} />
        </Section>

        <Section id="delete" title="การลบข้อมูล">
          <List items={[
            "เมื่อน้องจดดีออกจากกลุ่ม (ถูกนำออก หรือกด “เลิกใช้” ในตั้งค่า) ข้อมูลของกลุ่มนั้นจะถูกลบหลัง 7 วัน ถ้าเชิญน้องจดดีกลับเข้ากลุ่มภายใน 7 วัน ข้อมูลจะไม่ถูกลบ",
            "ข้อความที่ถูกยกเลิกการส่ง (unsend) จะถูกลบจากระบบของเรา งานที่ยืนยันแล้วยังอยู่",
            "ไฟล์ใน Google Drive เป็นของเจ้าของกลุ่ม เราไม่ลบไฟล์เหล่านั้น",
            "สถิติจำนวนการใช้ AI และจำนวนข้อความที่ส่งเก็บไว้ต่อเพื่อคำนวณโควตารายเดือน โดยไม่มีข้อความแชต",
          ]} />
        </Section>

        <Section id="rights" title="สิ่งที่คุณทำได้">
          <List items={[
            "นำน้องจดดีออกจากกลุ่ม หรือกด “เลิกใช้” ในหน้าตั้งค่า",
            "ถอนสิทธิ์ Google Drive ได้ที่หน้าบัญชี Google ของคุณ",
            <>สอบถามหรือขอให้ลบข้อมูล ส่งข้อความหาน้องจดดีในแชต LINE
              {ADD_FRIEND_URL ? <> (<a className="text-[#1F5BAD] underline underline-offset-4" href={ADD_FRIEND_URL}>เพิ่มเพื่อน</a>)</> : null}</>,
          ]} />
        </Section>

        <Section id="changes" title="การเปลี่ยนแปลง">
          <p>ถ้าเราเปลี่ยนวิธีใช้ข้อมูล เราจะแก้หน้านี้และวันที่ด้านบน</p>
        </Section>
      </main>

      <footer className="border-t border-[#E6EAF0] px-6 py-6 text-center text-sm text-[#8A94A6]">
        น้องจดดี · โปรเจกต์ DII Design, Pitching &amp; Hackathon 2026
      </footer>
    </div>
  );
}

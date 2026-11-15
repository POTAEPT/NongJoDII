import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ADD_FRIEND_URL } from "../fonts";

// Privacy policy (#47), linked from the homepage and from Google's OAuth consent screen.
// Every statement here must match what the app does; check it against
// supabase/migrations/, docs/PROJECT.md and .greptile/rules.md when either changes.
//
// BEFORE PUBLISHING: the "การลบข้อมูล" section states the 7-day purge after the bot leaves,
// which is #11 and not built yet (2026-11-15). Unsend (#24) has landed. Do not link this
// page from the consent screen until #11 has landed. "Stop using" in Settings also waits on
// #11, so this page does not offer it yet.
// The Clarity line follows src/app/clarity.tsx, which skips every /liff page; update it if
// #19 (Clarity funnel) changes that.

export const metadata: Metadata = {
  title: "นโยบายความเป็นส่วนตัว · น้องจดดี",
  description: "น้องจดดีเก็บข้อมูลอะไร ใช้ทำอะไร ใครเห็น และลบเมื่อไหร่",
};

/** Bump on every change to what this page says. */
const UPDATED = "15 พฤศจิกายน 2569";

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-xl font-bold">{title}</h2>
      <div className="flex flex-col gap-3 leading-relaxed text-ink-2">{children}</div>
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
    <div lang="th" className="flex flex-1 flex-col bg-page font-thai text-ink [color-scheme:light]">
      {/* Brand app bar, as on the LIFF pages (Figma UI v4). */}
      <div className="bg-brand text-white">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center px-6">
          <Link href="/" className="font-semibold">น้องจดดี</Link>
        </div>
      </div>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-10 px-6 py-16">
        <header className="flex flex-col gap-2">
          <Link href="/" className="text-sm text-primary underline underline-offset-4">← น้องจดดี</Link>
          <h1 className="text-3xl font-bold">นโยบายความเป็นส่วนตัว</h1>
          <p className="text-sm text-ink-3">ปรับปรุงล่าสุด {UPDATED}</p>
          <p className="leading-relaxed text-ink-2">
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
            <><b>การเข้าและออกจากกลุ่ม:</b> ใครเข้าหรือออกจากกลุ่มเมื่อไหร่ เพื่อให้เฉพาะสมาชิกปัจจุบันเห็นข้อมูลของกลุ่ม
              และคืนงานของคนที่ออกไปให้กลุ่มมอบหมายใหม่</>,
            <><b>จากฟอร์มตั้งค่ากลุ่ม หน้าตั้งค่า และหน้า “ข้อมูลของฉัน”:</b> กลุ่มทำเรื่องอะไร ฟีเจอร์ที่เปิด
              เวลาเตือน ชื่อเล่นและหน้าที่ของสมาชิก ชื่อเล่นใช้ให้ AI เข้าใจว่าแชตพูดถึงใครเท่านั้น
              หน้าจอทุกหน้าแสดงชื่อ LINE</>,
            <><b>จาก Google (เฉพาะเจ้าของกลุ่มที่เชื่อม Google Drive):</b> รหัสบัญชี Google อีเมล
              สิทธิ์ที่อนุญาต และโทเค็นสำหรับเข้าถึง Drive ซึ่งเราเข้ารหัสก่อนเก็บ
              รวมถึงชื่อ ขนาด และลิงก์ของไฟล์ที่น้องจดดีบันทึกให้</>,
            <><b>สถิติการใช้งาน:</b> จำนวนการใช้ AI ต่อเจ้าของกลุ่ม (เพื่อจำกัดการใช้งานฟรี)
              และจำนวนข้อความที่บอทส่ง (เพื่อไม่ให้เกินโควตาของ LINE)</>,
          ]} />
        </Section>

        <Section id="drive" title="Google Drive">
          <List items={[
            <>น้องจดดีขอสิทธิ์ <code className="rounded bg-subtle px-1">drive.file</code> ซึ่งเข้าถึงได้
              <b>เฉพาะไฟล์และโฟลเดอร์ที่น้องจดดีสร้างเอง</b> ไม่สามารถอ่านไฟล์อื่นใน Drive ของคุณ</>,
            <>ไฟล์และรูปที่ส่งในกลุ่มถูกบันทึกลง Drive ของเจ้าของกลุ่มในโฟลเดอร์ “NongJoDII” แยกตามกลุ่ม
              ไฟล์เป็นของเจ้าของกลุ่ม ไม่ได้เก็บไว้ที่เรา</>,
            <>โฟลเดอร์ของโปรเจกต์ถูกแชร์แบบ <b>ทุกคนที่มีลิงก์ดูได้</b> เพื่อให้สมาชิกเปิดไฟล์ได้โดยไม่ต้องมีบัญชี Google
              ใครที่ได้รับลิงก์ก็เปิดดูไฟล์ได้ รวมถึงคนที่ออกจากกลุ่มไปแล้วหรือคนที่ได้ลิงก์ต่อมา
              {" "}<b>อย่าส่งเอกสารสำคัญ เช่น บัตรประชาชนหรือสัญญา ในกลุ่มที่เปิดเก็บไฟล์</b>{" "}
              เจ้าของบอทปิดการเก็บไฟล์ของแต่ละกลุ่มได้ในหน้าตั้งค่า</>,
            <>เราใช้ข้อมูลจาก Google เพื่อบันทึกไฟล์ให้กลุ่มเท่านั้น ไม่ขาย ไม่ใช้โฆษณา
              และไม่ส่งไฟล์จาก Drive ไปให้ AI</>,
            <>ถอนสิทธิ์ได้ทุกเมื่อที่ <a className="text-primary underline underline-offset-4" href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> งานในกลุ่มยังอยู่ แต่ไฟล์ใหม่จะไม่ถูกบันทึกจนกว่าจะเชื่อมอีกครั้ง
              เมื่อน้องจดดีพบว่าเข้าถึง Drive ไม่ได้แล้ว จะโพสต์การ์ดในกลุ่มหลักให้เจ้าของบอทเชื่อมใหม่</>,
            <>เจ้าของบอทเปลี่ยนไปใช้บัญชี Google อื่นได้ ไฟล์ใหม่จะอยู่ใน Drive ของบัญชีใหม่ ไฟล์เดิมยังอยู่ใน Drive ของบัญชีเดิม</>,
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
            "เจ้าของบอทเห็นและแก้ชื่อเล่นและหน้าที่ของสมาชิกในหน้าตั้งค่า สมาชิกคนอื่นเห็นแค่ชื่อ LINE และแก้ได้เฉพาะข้อมูลของตัวเอง",
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
            "Microsoft Clarity: สถิติการใช้หน้าเว็บของน้องจดดี เช่น หน้านี้และหน้าแรก โดยซ่อนข้อความทั้งหมดบนหน้า ไม่บันทึกหน้าที่เปิดในแอป LINE (LIFF) เพราะลิงก์ของหน้าเหล่านั้นมีรหัสยืนยันตัวตนของ LINE",
          ]} />
        </Section>

        <Section id="delete" title="การลบข้อมูล">
          <List items={[
            "เมื่อน้องจดดีถูกนำออกจากกลุ่ม ข้อมูลของกลุ่มนั้นจะถูกลบหลัง 7 วัน ถ้าเชิญน้องจดดีกลับเข้ากลุ่มภายใน 7 วัน ข้อมูลจะไม่ถูกลบ",
            "ข้อความที่ถูกยกเลิกการส่ง (unsend) จะถูกลบจากระบบของเรา งานที่ยืนยันแล้วยังอยู่",
            "ไฟล์ใน Google Drive เป็นของเจ้าของกลุ่ม เราไม่ลบไฟล์เหล่านั้น",
            "สถิติจำนวนการใช้ AI และจำนวนข้อความที่ส่งเก็บไว้ต่อเพื่อคำนวณโควตารายเดือน โดยไม่มีข้อความแชต",
          ]} />
        </Section>

        <Section id="rights" title="สิ่งที่คุณทำได้">
          <List items={[
            "นำน้องจดดีออกจากกลุ่ม",
            "แก้ชื่อเล่นและหน้าที่ของตัวเองในหน้า “ข้อมูลของฉัน” (ปุ่มในการ์ดต้อนรับ)",
            "เจ้าของบอทปิดฟีเจอร์ที่ไม่ต้องการ เช่น การเก็บไฟล์หรือการสรุปแชต ในหน้าตั้งค่า (พิมพ์ “น้องจดดี ตั้งค่า” ในกลุ่ม)",
            "ถอนสิทธิ์ Google Drive ได้ที่หน้าบัญชี Google ของคุณ",
            <>สอบถามหรือขอให้ลบข้อมูล ส่งข้อความหาน้องจดดีในแชต LINE
              {ADD_FRIEND_URL ? <> (<a className="text-primary underline underline-offset-4" href={ADD_FRIEND_URL}>เพิ่มเพื่อน</a>)</> : null}</>,
          ]} />
        </Section>

        <Section id="changes" title="การเปลี่ยนแปลง">
          <p>ถ้าเราเปลี่ยนวิธีใช้ข้อมูล เราจะแก้หน้านี้และวันที่ด้านบน</p>
        </Section>
      </main>

      <footer className="border-t border-line px-6 py-6 text-center text-sm text-ink-3">
        น้องจดดี · โปรเจกต์ DII Design, Pitching &amp; Hackathon 2026
      </footer>
    </div>
  );
}

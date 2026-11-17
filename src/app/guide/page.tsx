import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { ADD_FRIEND_URL } from "../fonts";
import { LegalPage, List, Section, linkClass } from "../legal";
import { GUIDE_COMMANDS, GUIDE_COMMAND_ORDER } from "./commands";

// How-to page (#133): one place that explains the whole flow, linked from the homepage, the
// footer and the help card ("น้องจดดี วิธีใช้", src/server/commands/help.ts). Static: no env
// beyond the optional add-friend link. Every statement must match what the bot does; the
// command table comes from ./commands.ts, which test/guide.test.ts checks against parse.ts.
// Wording follows the cards after the UX review (#130): เจ้าของบอท, ผู้รับ, เสร็จ, กำลังทำ,
// ยังไม่มีผู้รับ.

export const metadata: Metadata = {
  title: "วิธีใช้งาน · น้องจดดี",
  description: "เริ่มใช้น้องจดดีในกลุ่ม LINE คำสั่งทั้งหมด การสรุปแชตเป็นงาน การติดตามงาน การเตือน และการเก็บไฟล์",
};

/** Bump on every change to what this page says. */
const UPDATED = "16 พฤศจิกายน 2569";

const TOC = [
  ["start", "เริ่มใช้งาน"],
  ["commands", "คำสั่งในกลุ่ม"],
  ["summary", "สรุปแชตเป็นงาน"],
  ["progress", "ติดตามงานจากแชต"],
  ["reminders", "การเตือนและสรุปรายสัปดาห์"],
  ["files", "เก็บไฟล์"],
  ["dashboard", "Dashboard และการตั้งค่า"],
  ["faq", "คำถามที่พบบ่อย"],
] as const;

function Cmd({ children }: { children: string }) {
  return <code className="whitespace-nowrap rounded bg-subtle px-1.5 py-0.5 text-[0.95em] text-ink">{children}</code>;
}

function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="flex flex-col gap-3">
      {items.map((s, i) => (
        <li key={i} className="flex items-start gap-3">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary">
            {i + 1}
          </span>
          <span>{s}</span>
        </li>
      ))}
    </ol>
  );
}

function Faq({ q, children }: { q: string; children: ReactNode }) {
  return (
    <details className="group rounded-xl border border-line px-4 py-3">
      <summary className="cursor-pointer font-semibold text-ink">{q}</summary>
      <div className="mt-2 leading-relaxed">{children}</div>
    </details>
  );
}

export default function Guide() {
  return (
    <LegalPage
      title="วิธีใช้งานน้องจดดี"
      updated={UPDATED}
      intro={<>
        น้องจดดีอยู่ในกลุ่ม LINE ที่ทีมใช้คุยงาน คอยสรุปแชตเป็นงาน ติดตามว่างานไหนเสร็จ
        เตือนงานที่ต้องตาม และเก็บไฟล์ลง Google Drive ของเจ้าของบอท
        กลุ่ม LINE ไม่มีเมนู ทุกอย่างจึงสั่งด้วยการพิมพ์ในแชต หรือกดปุ่มในการ์ดของน้องจดดี
      </>}
    >
      <nav aria-label="สารบัญ" className="rounded-2xl border border-line p-5">
        <p className="mb-2 font-semibold">ในหน้านี้</p>
        <ol className="grid gap-1 text-sm sm:grid-cols-2">
          {TOC.map(([id, title], i) => (
            <li key={id}><a href={`#${id}`} className={linkClass}>{i + 1}. {title}</a></li>
          ))}
        </ol>
      </nav>

      <Section id="start" title="1. เริ่มใช้งาน">
        <Steps items={[
          <>เพิ่มน้องจดดีเป็นเพื่อนใน LINE
            {ADD_FRIEND_URL ? <> (<a className={linkClass} href={ADD_FRIEND_URL}>เพิ่มเพื่อน</a>)</> : null}
            {" "}แล้วเชิญเข้ากลุ่มที่ใช้คุยงาน</>,
          <>น้องจดดีส่งการ์ดให้ตั้งค่ากลุ่ม ใครในกลุ่มก็กรอกได้ 4 ขั้น: กลุ่มทำเรื่องอะไร,
            ใครทำหน้าที่อะไร (ชื่อเล่น), อยากให้ช่วยอะไร และเวลาเตือน (เวลาประเทศไทย)</>,
          <>ในฟอร์มเลือกว่าใครเป็น <b>เจ้าของบอท</b> คนนั้นกดยืนยันด้วย LINE ของตัวเอง
            ถ้าคนกรอกเลือกตัวเอง ก็ยืนยันได้ทันที</>,
          <>เจ้าของบอทเชื่อม Google Drive เพื่อให้น้องจดดีเก็บไฟล์ของกลุ่ม</>,
          <>น้องจดดีส่งการ์ด “ตั้งค่าเสร็จแล้ว” พร้อมคำสั่งที่ลองพิมพ์ได้เลย</>,
        ]} />
        <p>
          ทุกอย่างในฟอร์มแก้ทีหลังได้ในหน้าตั้งค่า ชื่อเล่นใช้ให้ AI เข้าใจว่าแชตพูดถึงใครเท่านั้น
          ทุกหน้าจอแสดงชื่อ LINE
        </p>
      </Section>

      <Section id="commands" title="2. คำสั่งในกลุ่ม">
        <p>
          ขึ้นต้นด้วย “น้องจดดี” แล้วตามด้วยคำสั่ง จะเติม “หน่อย” “ครับ” “ค่ะ” ท้ายประโยคก็ได้
          ปุ่มลัด (📝 สรุปแชต · ⚙️ ตั้งค่า · ❔ วิธีใช้) ที่ขึ้นใต้การ์ดบางใบจะส่งคำสั่งเดียวกันให้
        </p>
        <div className="overflow-hidden rounded-2xl border border-line">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-subtle text-ink">
              <tr>
                <th scope="col" className="px-4 py-2 font-semibold">พิมพ์</th>
                <th scope="col" className="px-4 py-2 font-semibold">น้องจดดีตอบ</th>
              </tr>
            </thead>
            <tbody>
              {GUIDE_COMMAND_ORDER.map((key) => {
                const c = GUIDE_COMMANDS[key];
                return (
                  <tr key={key} className="border-t border-line align-top">
                    <td className="px-4 py-3">
                      <div className="flex flex-col items-start gap-1">
                        <Cmd>{c.text}</Cmd>
                        {c.also?.length ? (
                          <span className="text-xs text-ink-3">หรือ {c.also.join(" · ")}</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3">{c.answer}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-ink-3">
          ข้อความที่แค่มีคำเหล่านี้อยู่ในประโยค เช่น “ตั้งค่าห้องแล้ว” ไม่นับเป็นคำสั่ง
        </p>
      </Section>

      <Section id="summary" title="3. สรุปแชตเป็นงาน">
        <Steps items={[
          <>พิมพ์ <Cmd>น้องจดดี สรุป</Cmd> น้องจดดีอ่านแชตใหม่ตั้งแต่สรุปครั้งก่อน</>,
          <>ส่งการ์ดสรุปพร้อมรายการงานที่ร่างไว้ ผู้รับ และกำหนดส่ง</>,
          <>กดตรวจงาน แก้หรือตัดงานที่ไม่ใช่ออก แล้วกดยืนยัน</>,
          <>งานถูกสร้างหลังมีคนกดยืนยันเท่านั้น ไม่มีงานไหนเกิดขึ้นเอง</>,
        ]} />
        <p>
          ถ้าไม่มีข้อความใหม่ตั้งแต่สรุปครั้งก่อน น้องจดดีบอกให้คุยต่อก่อน ถ้าสรุปไม่สำเร็จ
          มีปุ่ม “🔁 สรุปอีกครั้ง” ให้กด
        </p>
      </Section>

      <Section id="progress" title="4. ติดตามงานจากแชต">
        <p>
          คุยงานตามปกติ เมื่อมีคนพิมพ์ว่างานเสร็จ เช่น “ทำโลโก้เสร็จแล้ว” น้องจดดีถามในกลุ่มว่า
          <b> “อัปเดตงานนี้ไหม?”</b> พร้อมงานที่น่าจะตรง
        </p>
        <List items={[
          <><b>ใช่ เสร็จแล้ว</b>: งานเปลี่ยนเป็น “เสร็จ”</>,
          <><b>เลือกงานอื่น</b>: ถ้าน้องจดดีเดางานผิด เลือกงานที่ถูกได้</>,
          <><b>ไม่ใช่การอัปเดตงาน</b>: ปิดคำถามนี้ ไม่มีอะไรเปลี่ยน</>,
        ]} />
        <p>
          กดได้เฉพาะ <b>ผู้รับ</b>งานนั้น หรือคนที่พิมพ์ข้อความนั้น สถานะเปลี่ยนเมื่อมีคนกดยืนยันเท่านั้น
          ข้อความทั่วไปที่ไม่เกี่ยวกับงาน น้องจดดีจะไม่ตอบ
        </p>
      </Section>

      <Section id="reminders" title="5. การเตือนและสรุปรายสัปดาห์">
        <p>
          <b>เตือนรายวัน</b> ตามเวลาที่กลุ่มเลือก (เริ่มต้น 09:00): งานใกล้ถึงกำหนด งานเลยกำหนด
          งานที่ยังไม่มีผู้รับ และงานที่ไม่มีความคืบหน้าเกิน 5 วัน แต่ละงานมีปุ่ม
        </p>
        <List items={[
          <><b>เสร็จแล้ว</b>: ปิดงาน</>,
          <><b>ขอเลื่อน</b>: เลือกวันใหม่</>,
          <><b>ฉันรับเอง</b>: สำหรับงานที่ยังไม่มีผู้รับ กดแล้วเป็นผู้รับและงานเป็น “กำลังทำ”</>,
        ]} />
        <p>
          ถ้ากดปุ่มไม่ได้ พิมพ์ <Cmd>น้องจดดี done</Cmd> หรือ <Cmd>น้องจดดี need time</Cmd> แทนได้
        </p>
        <p>
          <b>สรุปรายสัปดาห์</b> ตามวันและเวลาที่กลุ่มเลือก (เริ่มต้นวันจันทร์ 09:00):
          จำนวนงานที่เสร็จ กำลังทำ และยังไม่มีผู้รับ พร้อมปุ่มเปิด Dashboard
        </p>
      </Section>

      <Section id="files" title="6. เก็บไฟล์">
        <List items={[
          <>ไฟล์และรูปที่ส่งในกลุ่มถูกเก็บลง Google Drive ของเจ้าของบอท ในโฟลเดอร์ “NongJoDII” แยกตามกลุ่ม
            ไม่หายแม้ไฟล์ใน LINE จะหมดอายุ</>,
          <>เปิดลิงก์ไฟล์ได้โดยไม่ต้องมีบัญชี Google ใครได้ลิงก์ก็เปิดได้
            <b> อย่าส่งเอกสารสำคัญ</b> เช่น บัตรประชาชน ในกลุ่มที่เปิดเก็บไฟล์</>,
          <>อยากได้ลิงก์ไฟล์คืน: ตอบกลับ (reply) ข้อความไฟล์นั้น แล้วพิมพ์ <Cmd>น้องจดดี ขอไฟล์</Cmd></>,
          <>ถ้ายังเก็บไฟล์ไม่ได้ (ยังไม่มีเจ้าของบอท หรือยังไม่เชื่อม Drive) น้องจดดีส่งการ์ดพร้อมปุ่มที่แก้ได้</>,
        ]} />
      </Section>

      <Section id="dashboard" title="7. Dashboard และการตั้งค่า">
        <List items={[
          <><b>สมาชิก</b> เห็นงานของตัวเอง งานที่ยังไม่มีผู้รับ และสรุปรายสัปดาห์ของกลุ่มที่ตัวเองอยู่</>,
          <><b>เจ้าของบอท</b>และผู้ดูแลโปรเจกต์ เห็นงานทั้งหมดของทุกกลุ่มในโปรเจกต์บน Dashboard ตัวเลข “งานตอนนี้” นับจากงานล่าสุดทุกครั้งที่เปิด ส่วนสรุปรายสัปดาห์คือตัวเลขของวันที่สรุป</>,
          <>เปิด Dashboard จากปุ่มในสรุปรายสัปดาห์ หรือพิมพ์ “Dashboard” ในแชต 1:1 กับน้องจดดี</>,
          <>พิมพ์ <Cmd>น้องจดดี ตั้งค่า</Cmd> ในกลุ่ม เจ้าของบอทเปิดหรือปิดฟีเจอร์ เปลี่ยนเวลาเตือน
            และแก้ชื่อเล่นและหน้าที่ของทุกคนได้ สมาชิกคนอื่นแก้ได้เฉพาะของตัวเอง</>,
        ]} />
      </Section>

      <Section id="faq" title="8. คำถามที่พบบ่อย">
        <Faq q="น้องจดดีตอบแล้วเสียโควตาข้อความของ LINE ไหม">
          คำตอบของคำสั่งที่พิมพ์ และของปุ่มลัด เป็นการตอบกลับ ไม่เสียโควตา
          ที่นับโควตาคือโพสต์ตามเวลา (เตือนรายวัน สรุปรายสัปดาห์) และการ์ดบางใบที่เกิดจากเหตุการณ์ในกลุ่ม
        </Faq>
        <Faq q="ใครเป็นเจ้าของบอทได้">
          สมาชิกคนไหนในกลุ่มก็ได้ ฟอร์มตั้งค่าเลือกชื่อ แล้วคนนั้นกดยืนยันด้วย LINE ของตัวเอง
          ถ้าเจ้าของบอทออกจากกลุ่ม การเก็บไฟล์และการสรุปหยุดชั่วคราว น้องจดดีถามหาเจ้าของคนใหม่
          ถ้าไม่มีใครรับภายใน 7 วัน น้องจดดีจะออกจากกลุ่ม
        </Faq>
        <Faq q="น้องจดดีอ่านแชตเก่าก่อนเข้ากลุ่มไหม">
          ไม่ น้องจดดีเห็นเฉพาะข้อความที่ส่งหลังเข้ากลุ่ม
        </Faq>
        <Faq q="ใช้ฟรีไหม">
          ฟรี โดยมีโควตาการใช้ AI ต่อเจ้าของบอทต่อเดือน น้องจดดีเตือนในกลุ่มเมื่อใช้ไปถึง 80%
        </Faq>
        <Faq q="เลิกใช้และลบข้อมูลยังไง">
          นำน้องจดดีออกจากกลุ่ม หรือเจ้าของบอทกด “เลิกใช้น้องจดดีในกลุ่มนี้” ในหน้าตั้งค่า
          ข้อมูลของกลุ่มจะถูกลบหลัง 7 วัน ถ้าเชิญกลับภายใน 7 วัน ข้อมูลยังอยู่
          ไฟล์ใน Google Drive เป็นของเจ้าของบอท ไม่ถูกลบ
          ดูรายละเอียดที่ <Link href="/privacy" className={linkClass}>นโยบายความเป็นส่วนตัว</Link>
        </Faq>
      </Section>
    </LegalPage>
  );
}

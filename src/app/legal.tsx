import Link from "next/link";
import type { ReactNode } from "react";

// Shared layout of the public policy pages (#47): /privacy and /terms. Both are linked from
// the homepage and from Google's OAuth consent screen (Branding: privacy policy and terms of
// service links, required for an app in production).

export function LegalPage({ title, updated, intro, children }: {
  title: string; updated: string; intro: ReactNode; children: ReactNode;
}) {
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
          <h1 className="text-3xl font-bold">{title}</h1>
          <p className="text-sm text-ink-3">ปรับปรุงล่าสุด {updated}</p>
          <p className="leading-relaxed text-ink-2">{intro}</p>
        </header>
        {children}
      </main>
      <LegalFooter />
    </div>
  );
}

/** The footer of the homepage and the policy pages. */
export function LegalFooter() {
  return (
    <footer className="flex flex-col items-center gap-2 border-t border-line px-6 py-6 text-center text-sm text-ink-3">
      <nav className="flex flex-wrap justify-center gap-x-4 gap-y-1">
        <Link href="/guide" className="text-primary underline underline-offset-4">วิธีใช้งาน</Link>
        <Link href="/privacy" className="text-primary underline underline-offset-4">นโยบายความเป็นส่วนตัว</Link>
        <Link href="/terms" className="text-primary underline underline-offset-4">ข้อกำหนดการใช้งาน</Link>
      </nav>
      <span>น้องจดดี · โปรเจกต์ DII Design, Pitching &amp; Hackathon 2026</span>
    </footer>
  );
}

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-xl font-bold">{title}</h2>
      <div className="flex flex-col gap-3 leading-relaxed text-ink-2">{children}</div>
    </section>
  );
}

export function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="flex list-disc flex-col gap-2 pl-6">
      {items.map((item, i) => <li key={i}>{item}</li>)}
    </ul>
  );
}

export const linkClass = "text-primary underline underline-offset-4";

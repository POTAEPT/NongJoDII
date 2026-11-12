This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## รัน CI ในเครื่องก่อน push

ทุก PR ที่เข้า `main` ต้องผ่าน check `ci` (ดู `.github/workflows/ci.yml`) รันขั้นตอนเดียวกันในเครื่องได้ก่อน push เพื่อไม่ต้องรอ CI บน GitHub

**ต้องมีก่อน:** Node 24 ตาม `.nvmrc` (ถ้าใช้ nvm ให้รัน `nvm use`)

```bash
npm ci                # ติดตั้ง dependency ตาม package-lock.json แบบตรงตัว
npm run lint          # ESLint
npm run typecheck     # next typegen แล้ว tsc --noEmit
npm test              # Vitest รัน test ทั้งหมดครั้งเดียว
npm run build         # build แบบ production
```

หรือรันทั้งหมดในคำสั่งเดียว (หยุดทันทีที่ขั้นไหนพัง):

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

**หมายเหตุ**

- ไม่ต้องตั้ง secret หรือ `.env` เพื่อรันขั้นตอนเหล่านี้ test ใช้ fake แทน LINE, OpenRouter, Google Drive และ Supabase
- ระหว่างเขียนโค้ดใช้ `npm run test:watch` ให้ test รันใหม่ทุกครั้งที่บันทึกไฟล์
- test รันในเขตเวลา UTC เสมอ ส่วนเวลากรุงเทพฯ ต้องคำนวณในโค้ด ห้ามพึ่งเขตเวลาของเครื่อง
- ถ้า `npm ci` ล้มเพราะ lock ไม่ตรง ให้รัน `npm install` แล้ว commit `package-lock.json` ด้วย
- ไฟล์ test ต้องอยู่ใน `src/` และลงท้ายด้วย `.test.ts` หรือ `.test.tsx`

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

import type { Metadata } from "next";
import { Geist, Geist_Mono, IBM_Plex_Sans_Thai } from "next/font/google";
import "./globals.css";
import { Clarity } from "./clarity";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// LIFF pages use the Figma UI v4 type scale (IBM Plex Sans Thai, 400 and 600).
const plexThai = IBM_Plex_Sans_Thai({
  variable: "--font-plex-thai",
  subsets: ["thai", "latin"],
  weight: ["400", "600"],
});

export const metadata: Metadata = {
  title: "น้องจดดี",
  description: "บอท LINE ช่วยทีมสรุปงานจากแชต",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="th"
      className={`${geistSans.variable} ${geistMono.variable} ${plexThai.variable} h-full antialiased`}
    >
      <head>
        <Clarity />
      </head>
      {/* Clarity recordings must not capture Task titles, nicknames or chat-derived text, so all page text is masked. */}
      <body className="min-h-full flex flex-col" data-clarity-mask="True">{children}</body>
    </html>
  );
}

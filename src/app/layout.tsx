import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Ветви — совместный конструктор нарратива",
  description:
    "Совместный конструктор нарратива: ветвящиеся диалоги, заметки и текстовые блоки на бесконечном холсте с realtime-синхронизацией, копиями и merge-запросами.",
  keywords: [
    "Ветви",
    "нарратив",
    "ветвящиеся диалоги",
    "коллаборация",
    "realtime",
    "Yjs",
  ],
  authors: [{ name: "Ветви" }],
  openGraph: {
    title: "Ветви — совместный конструктор нарратива",
    description:
      "Ветвящиеся диалоги, заметки и текстовые блоки на бесконечном холсте. Realtime-сотрудничество.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";
import "./vetvi.css";

export const metadata: Metadata = {
  title: "Ветви — совместный конструктор нарратива",
  description:
    "Совместный конструктор нарратива: сцены, персонажи, диалоги с ветвящимися репликами, группы и связи на бесконечном холсте. Realtime-синхронизация, копии и merge-запросы.",
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
      "Ветвящиеся диалоги, группы, связи и заметки на бесконечном холсте. Realtime-сотрудничество.",
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
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Unbounded:wght@600;700&family=Golos+Text:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap"
          rel="stylesheet"
        />
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Ccircle cx='6' cy='12' r='4' fill='%23e2a54e'/%3E%3Ccircle cx='19' cy='5' r='3' fill='%239cb878'/%3E%3Ccircle cx='19' cy='19' r='3' fill='%23cf6d4f'/%3E%3C/svg%3E"
        />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}

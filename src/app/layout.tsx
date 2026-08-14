import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "1-on-1 Agenda | EOS Framework",
  description: "Weekly 1-on-1 meeting agenda following the Traction EOS framework",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-bg font-sans">{children}</body>
    </html>
  );
}

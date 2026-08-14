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
  const commit = process.env.NEXT_PUBLIC_COMMIT_SHA || ''
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-bg font-sans">
        {children}
        {commit && (
          <div style={{ position: 'fixed', right: 12, bottom: 12, background: 'rgba(0,0,0,0.6)', color: '#fff', padding: '6px 8px', borderRadius: 6, fontSize: 12, zIndex: 9999 }}>
            {`commit: ${commit}`}
          </div>
        )}
      </body>
    </html>
  )
}

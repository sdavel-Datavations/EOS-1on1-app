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
  const commit = process.env.NEXT_PUBLIC_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || ''
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Poppins:ital,wght@0,300;0,400;0,600;0,700;1,400&family=Roboto+Condensed:wght@400;700&display=swap" rel="stylesheet" />
      </head>
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

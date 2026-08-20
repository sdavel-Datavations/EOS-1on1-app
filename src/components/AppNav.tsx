'use client'

import Link from 'next/link'

/**
 * The header, in one place.
 *
 * It was copy-pasted into every page, which meant reordering the tabs was the same
 * edit four times and adding a fifth would have been five — with nothing to stop
 * the copies drifting apart. Nothing tests the header's contents, so drift here is
 * invisible until someone looks.
 */

const TABS: { href: string; label: string; adminOnly?: boolean }[] = [
  { href: '/', label: 'Agenda' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/metrics', label: 'Metrics' },
  { href: '/team', label: 'Team' },
  // Delivery is system health, not people: who it concerns is whoever keeps the
  // notifications running, and the endpoint behind it is admin-only anyway.
  { href: '/delivery', label: 'Delivery', adminOnly: true },
]

export function AppNav({
  current,
  userName,
  isAdmin,
  onSignOut,
}: {
  /** href of the page being shown, which renders as plain text rather than a link. */
  current: string
  userName: string | null
  isAdmin: boolean
  onSignOut: () => void
}) {
  return (
    // flex-wrap with gap-y: on a narrow screen the row wraps rather than pushing
    // Sign out off the edge, which it used to do by 38px.
    <header className="bg-deep-purple px-4 sm:px-6 py-3 flex items-center justify-between gap-x-3 gap-y-2 flex-wrap sticky top-0 z-50">
      <div className="flex items-center gap-3 sm:gap-4">
        <span className="text-white font-bold tracking-wider text-lg">DATAVATIONS</span>
        <nav className="flex items-center gap-3 text-sm">
          {TABS.filter(t => !t.adminOnly || isAdmin).map(t =>
            t.href === current ? (
              <span key={t.href} className="text-white font-semibold">{t.label}</span>
            ) : (
              <Link key={t.href} href={t.href} className="text-white/60 hover:text-white transition">
                {t.label}
              </Link>
            ),
          )}
        </nav>
      </div>
      <div className="flex items-center gap-3 sm:gap-4">
        <span className="text-steel-blue font-semibold text-sm hidden sm:inline">{userName}</span>
        <button onClick={onSignOut} className="text-white/60 text-sm hover:text-white transition">
          Sign out
        </button>
      </div>
    </header>
  )
}

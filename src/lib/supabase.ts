import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  const originalUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim()
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

  let resolvedUrl = originalUrl
  let autoCorrected = false

  // If the URL doesn't include the expected supabase domain, attempt a safe autocorrect
  if (originalUrl && !originalUrl.includes('supabase.co')) {
    // Match hostnames like https://<project>.co or https://<project>.app or https://<project>.io
    const m = originalUrl.match(/^https?:\/\/([a-z0-9-]+)\.(?:co|app|io)(?:\/|$)/i)
    if (m && m[1]) {
      resolvedUrl = `https://${m[1]}.supabase.co`
      autoCorrected = true
      // eslint-disable-next-line no-console
      console.warn('Auto-corrected Supabase URL at runtime from', originalUrl, 'to', resolvedUrl)
    } else {
      // eslint-disable-next-line no-console
      console.error('Supabase URL appears invalid at runtime:', originalUrl)
    }
  }

  if (!anon) {
    // eslint-disable-next-line no-console
    console.error('Supabase anon key is missing at runtime')
  }

  return createBrowserClient(resolvedUrl, anon)
}

export function getResolvedSupabaseUrl() {
  const originalUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim()
  if (!originalUrl) return { original: '', resolved: '', autoCorrected: false }
  if (originalUrl.includes('supabase.co')) return { original: originalUrl, resolved: originalUrl, autoCorrected: false }
  const m = originalUrl.match(/^https?:\/\/([a-z0-9-]+)\.(?:co|app|io)(?:\/|$)/i)
  if (m && m[1]) {
    const resolved = `https://${m[1]}.supabase.co`
    return { original: originalUrl, resolved, autoCorrected: true }
  }
  return { original: originalUrl, resolved: originalUrl, autoCorrected: false }
}

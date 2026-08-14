const url = process.env.DEPLOY_URL || 'https://eos-1on1-app.vercel.app/'

async function run() {
  try {
    const res = await fetch(url, { method: 'GET' })
    console.log('status', res.status)
    if (res.status !== 200) {
      console.error('Smoke check failed:', res.status)
      process.exit(1)
    }
    console.log('Smoke check OK')
  } catch (err) {
    console.error('Smoke check error', err)
    process.exit(1)
  }
}

run()

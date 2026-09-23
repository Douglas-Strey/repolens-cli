import Link from 'next/link'

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL

export default function Home() {
  return (
    <main>
      <h1>Welcome</h1>
      <p>
        Canonical URL: <code>{siteUrl}</code>
      </p>
      <Link href="/dashboard">Open dashboard</Link>
    </main>
  )
}

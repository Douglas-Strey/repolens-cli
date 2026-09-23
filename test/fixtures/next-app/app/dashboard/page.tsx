import { db } from '@/lib/db'

export default async function DashboardPage() {
  const userCount = await db.user.count()

  return (
    <main>
      <h1>Dashboard</h1>
      <p>{userCount} registered users</p>
    </main>
  )
}

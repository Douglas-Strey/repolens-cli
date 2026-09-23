import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function GET() {
  const users = await db.user.findMany({ take: 50 })
  return NextResponse.json(users)
}

export async function POST(request: Request) {
  const body = (await request.json()) as { email: string; name?: string }
  const user = await db.user.create({ data: { email: body.email, name: body.name } })
  return NextResponse.json(user, { status: 201 })
}

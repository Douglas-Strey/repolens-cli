import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

type Context = { params: Promise<{ id: string }> }

export const GET = async (_request: Request, { params }: Context) => {
  const { id } = await params
  const user = await db.user.findUnique({ where: { id } })
  if (!user) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return NextResponse.json(user)
}

export async function DELETE(_request: Request, { params }: Context) {
  const { id } = await params
  await db.user.delete({ where: { id } })
  return new NextResponse(null, { status: 204 })
}

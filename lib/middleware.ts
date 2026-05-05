import { NextRequest, NextResponse } from 'next/server'
import { validateSession } from './auth'

async function getRequestUser(request: NextRequest) {
  const token = request.headers.get('authorization')?.replace('Bearer ', '') ||
                request.cookies.get('auth-token')?.value

  if (!token) {
    return null
  }

  return validateSession(token)
}

export async function authMiddleware(request: NextRequest) {
  const user = await getRequestUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Add user to request headers for use in API routes
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-user-id', user.id)
  requestHeaders.set('x-user-email', user.email)
  requestHeaders.set('x-user-admin', user.isAdmin.toString())

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  })
}

export async function adminMiddleware(request: NextRequest) {
  const user = await getRequestUser(request)
  if (!user) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  if (!user.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-user-id', user.id)
  requestHeaders.set('x-user-email', user.email)
  requestHeaders.set('x-user-admin', user.isAdmin.toString())

  return NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  })
}

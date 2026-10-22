import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  // Only apply CORS to API routes
  if (request.nextUrl.pathname.startsWith('/api/')) {
    
    // 1. Handle the Preflight (OPTIONS) request
    if (request.method === 'OPTIONS') {
      return new NextResponse(null, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*', // Allows your frontend to connect
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, Idempotency-Key',
          'Access-Control-Max-Age': '86400', // browsers reuse the preflight answer instead of asking before every POST
        },
      })
    }

    // 2. Handle the actual request (POST, GET, etc.)
    const response = NextResponse.next()
    response.headers.set('Access-Control-Allow-Origin', '*')
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key')
    return response
  }

  return NextResponse.next()
}

// Ensure this runs on all API routes
export const config = {
  matcher: '/api/:path*',
}

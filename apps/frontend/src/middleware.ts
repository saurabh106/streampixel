import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Protect dashboard routes
  if (pathname.startsWith('/dashboard')) {
    const hasRefreshToken = request.cookies.has('refresh_token');

    // In development/Codespaces, we allow bypassing the strict cookie check to prevent
    // browser third-party cookie restrictions from blocking the dashboard transition.
    if (!hasRefreshToken && process.env.NODE_ENV !== 'development') {
      const loginUrl = new URL('/login', request.url);
      return NextResponse.redirect(loginUrl);
    }
  }

  // Prevent authenticated users from visiting login/register
  if (pathname === '/login' || pathname === '/register') {
    const hasRefreshToken = request.cookies.has('refresh_token');

    if (hasRefreshToken && process.env.NODE_ENV !== 'development') {
      const dashboardUrl = new URL('/dashboard', request.url);
      return NextResponse.redirect(dashboardUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/login', '/register'],
};

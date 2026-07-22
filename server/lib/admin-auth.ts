import { NextRequest, NextResponse } from 'next/server';

export function requireLocalAdmin(req: NextRequest): NextResponse | null {
  const configured = process.env.UI_RATER_ADMIN_TOKEN;
  if (configured) {
    const supplied = req.headers.get('authorization');
    if (supplied === `Bearer ${configured}`) return null;
    return NextResponse.json({ error: 'Admin authorization required' }, { status: 401 });
  }
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({
      error: 'UI_RATER_ADMIN_TOKEN is required for admin APIs in production',
    }, { status: 503 });
  }
  if (['localhost', '127.0.0.1', '::1'].includes(req.nextUrl.hostname)) return null;
  return NextResponse.json({ error: 'Admin API is local-only unless UI_RATER_ADMIN_TOKEN is set' }, { status: 403 });
}

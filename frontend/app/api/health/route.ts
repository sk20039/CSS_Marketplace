import { NextResponse } from 'next/server';

// GET /api/health
// Simple liveness check for the Next.js frontend.
// Used by Railway (and other platforms) to verify the process is running.
// Does not check backend service connectivity — that is each service's own concern.
export function GET() {
  return NextResponse.json({ ok: true, service: 'frontend' });
}

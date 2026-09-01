import { getAccessToken, setAccessToken } from './auth';
import type { SeoAuditResult, SeoFields } from './types';

const AUTH_URL = process.env.NEXT_PUBLIC_AUTH_URL!;
const LISTING_URL = process.env.NEXT_PUBLIC_LISTING_URL!;
const ESCROW_URL = process.env.NEXT_PUBLIC_ESCROW_URL!;

async function silentRefresh(): Promise<string | null> {
  try {
    const res = await fetch(`${AUTH_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data = await res.json();
    setAccessToken(data.access_token);
    return data.access_token;
  } catch {
    return null;
  }
}

async function apiFetch(url: string, options: RequestInit = {}, retry = true): Promise<Response> {
  const token = getAccessToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { ...options, headers, credentials: 'include' });

  if (res.status === 401 && retry) {
    const newToken = await silentRefresh();
    if (newToken) return apiFetch(url, options, false);
  }

  return res;
}

// ---- Auth service ----
export async function authRegister(body: { name: string; email: string; password: string; role?: string }) {
  const res = await fetch(`${AUTH_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  });
  return res;
}

export async function authMe(token: string) {
  const res = await fetch(`${AUTH_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'include',
  });
  if (!res.ok) return null;
  return res.json() as Promise<{ id: number; name: string; email: string; role: string; stripe_account_id: string | null }>;
}

export async function connectSellerStripe() {
  const token = getAccessToken();
  const res = await fetch(`${AUTH_URL}/auth/sellers/connect`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'include',
  });
  return res.json() as Promise<{ url?: string; error?: string; stub?: boolean }>;
}

export async function getSellerConnectStatus() {
  const token = getAccessToken();
  const res = await fetch(`${AUTH_URL}/auth/sellers/connect/status`, {
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'include',
  });
  return res.json() as Promise<{ connected: boolean; charges_enabled: boolean; details_submitted: boolean; stub?: boolean; stripe_account_id?: string }>;
}

export async function authLogin(body: { email: string; password: string }) {
  const res = await fetch(`${AUTH_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  });
  return res;
}

export async function authForgotPassword(body: { email: string }) {
  const res = await fetch(`${AUTH_URL}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

export async function authResetPassword(body: { token: string; password: string }) {
  const res = await fetch(`${AUTH_URL}/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

// ---- Listing service ----
export async function listingFetch(path: string, options: RequestInit = {}) {
  return apiFetch(`${LISTING_URL}${path}`, options);
}

export async function getListings(params: Record<string, string | number>) {
  const qs = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== '' && v != null)
      .map(([k, v]) => [k, String(v)])
  ).toString();
  const res = await fetch(`${LISTING_URL}/listings${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error('Failed to fetch listings');
  return res.json();
}

export async function getListing(id: string | number) {
  const res = await fetch(`${LISTING_URL}/listings/${id}`);
  if (!res.ok) throw new Error('Listing not found');
  return res.json();
}

export async function createListing(body: object) {
  const res = await listingFetch('/listings', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res;
}

export async function uploadPhoto(listingId: number, file: File) {
  const token = getAccessToken();
  const form = new FormData();
  form.append('photo', file);
  const res = await fetch(`${LISTING_URL}/listings/${listingId}/photos`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
    credentials: 'include',
  });
  return res;
}

// ---- Escrow service ----
export async function escrowFetch(path: string, options: RequestInit = {}) {
  // Routed through apiFetch so it attaches the Authorization header (and
  // retries once via silent refresh on a 401) just like auth/listing calls -
  // escrow-service now requires a valid token on every route.
  return apiFetch(`${ESCROW_URL}${path}`, options);
}

export async function syncUserToEscrow(user: { id: number; name: string; email: string; role: string; stripe_account_id?: string }) {
  return escrowFetch('/api/sync/user', {
    method: 'POST',
    body: JSON.stringify(user),
  });
}

export async function syncListingToEscrow(listing: { id: number; seller_id: number; title: string; price_cents: number }) {
  return escrowFetch('/api/sync/listing', {
    method: 'POST',
    body: JSON.stringify(listing),
  });
}

export async function getOrders(params: Record<string, string>) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, v])
  ).toString();
  const res = await escrowFetch(`/orders${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error('Failed to fetch orders');
  return res.json();
}

export async function getOrder(id: string | number) {
  const res = await escrowFetch(`/orders/${id}`);
  if (!res.ok) throw new Error('Order not found');
  return res.json();
}

export async function createOrder(body: { listing_id: number }) {
  // buyer_id is derived server-side from the auth token now, not sent by the client.
  return escrowFetch('/orders', { method: 'POST', body: JSON.stringify(body) });
}

export async function getOrderClientSecret(id: string | number) {
  const res = await escrowFetch(`/orders/${id}/client-secret`);
  if (!res.ok) return null;
  return res.json() as Promise<{ client_secret: string }>;
}

export async function captureOrder(id: string | number) {
  return escrowFetch(`/orders/${id}/capture`, { method: 'POST' });
}

export async function cancelOrder(id: string | number) {
  return escrowFetch(`/orders/${id}/cancel`, { method: 'POST' });
}

export async function shipOrder(id: string | number) {
  return escrowFetch(`/orders/${id}/ship`, { method: 'POST' });
}

export async function deliverOrder(id: string | number) {
  return escrowFetch(`/orders/${id}/deliver`, { method: 'POST' });
}

export async function confirmOrder(id: string | number) {
  return escrowFetch(`/orders/${id}/confirm`, { method: 'POST' });
}

export async function disputeOrder(id: string | number, reason: string) {
  return escrowFetch(`/orders/${id}/dispute`, { method: 'POST', body: JSON.stringify({ reason }) });
}

export async function resolveDispute(id: string | number, action: 'release' | 'refund') {
  return escrowFetch(`/admin/orders/${id}/resolve`, { method: 'POST', body: JSON.stringify({ action }) });
}

export async function submitReview(orderId: string | number, rating: number, body: string) {
  return escrowFetch(`/orders/${orderId}/review`, { method: 'POST', body: JSON.stringify({ rating, body }) });
}

export async function getOrderReview(orderId: string | number) {
  const res = await escrowFetch(`/orders/${orderId}/review`);
  if (!res.ok) return null;
  return res.json() as Promise<{ id: number; rating: number; body: string | null; created_at: string } | null>;
}

export async function getUserReviews(userId: string | number) {
  const ESCROW_URL = process.env.NEXT_PUBLIC_ESCROW_URL!;
  try {
    const res = await fetch(`${ESCROW_URL}/users/${userId}/reviews`);
    if (!res.ok) return { reviews: [], average_rating: null, count: 0 };
    return res.json() as Promise<{ reviews: { id: number; rating: number; body: string | null; reviewer_name: string; created_at: string }[]; average_rating: number | null; count: number }>;
  } catch {
    return { reviews: [], average_rating: null, count: 0 };
  }
}

export async function getMessages(orderId: string | number) {
  const res = await escrowFetch(`/orders/${orderId}/messages`);
  if (!res.ok) throw new Error('Failed to fetch messages');
  return res.json() as Promise<{ id: number; sender_id: number; sender_name: string; body: string; created_at: string }[]>;
}

export async function sendMessage(orderId: string | number, body: string) {
  return escrowFetch(`/orders/${orderId}/messages`, { method: 'POST', body: JSON.stringify({ body }) });
}

export async function getAllListingsFromEscrow() {
  const res = await escrowFetch('/api/listings');
  if (!res.ok) throw new Error('Failed');
  return res.json();
}

// ---- SEO / quality ----
export async function auditListing(id: number): Promise<SeoAuditResult> {
  const res = await listingFetch(`/listings/${id}/seo/audit`, { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || 'Failed to audit listing');
  }
  return res.json() as Promise<SeoAuditResult>;
}

export async function applySeoSuggestions(id: number, fields: SeoFields): Promise<any> {
  const res = await listingFetch(`/listings/${id}/seo/apply`, {
    method: 'POST',
    body: JSON.stringify(fields),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || 'Failed to apply suggestions');
  }
  return res.json();
}

export async function patchListing(id: number, body: { title?: string; description?: string }): Promise<any> {
  const res = await listingFetch(`/listings/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || 'Failed to update listing');
  }
  return res.json();
}

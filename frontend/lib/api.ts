import { getAccessToken, setAccessToken, notifySessionExpired } from './auth';
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
    if (!res.ok) {
      // Refresh failed (stale/missing cookie, migration wipe, etc.).
      // Clear the access token and delegate React state clearing + /login
      // redirect to the handler registered by AuthProvider.
      notifySessionExpired();
      return null;
    }
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
export async function authRegister(body: { name: string; email: string; password: string; role?: string; turnstile_token: string }) {
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
  return res.json() as Promise<{
    id: number; name: string; email: string; role: string;
    stripe_account_id: string | null;
    ship_from_address: ShipFromAddress | null;
  }>;
}

export interface ShipFromAddress {
  name: string; company?: string | null;
  line1: string; line2?: string | null;
  city: string; state: string; zip: string; phone: string;
}

export interface ShippingAddress {
  name: string; line1: string; line2?: string | null;
  city: string; state: string; zip: string; phone?: string | null;
}

export async function saveShipFromAddress(body: ShipFromAddress) {
  return apiFetch(`${AUTH_URL}/auth/address/ship-from`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
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

export async function authLogin(body: { email: string; password: string; turnstile_token: string }) {
  const res = await fetch(`${AUTH_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  });
  return res;
}

export async function authForgotPassword(body: { email: string; turnstile_token: string }) {
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

export async function authResendVerification(body: { email: string; turnstile_token: string }) {
  const res = await fetch(`${AUTH_URL}/auth/resend-verification`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

// ---- MFA ----

export async function getMfaStatus(): Promise<{ mfa_enabled: boolean }> {
  const res = await apiFetch(`${AUTH_URL}/auth/mfa/status`);
  if (!res.ok) throw new Error('Failed to fetch MFA status');
  return res.json();
}

export async function authMfaEnrollStart(enrollmentToken?: string | null) {
  const token = enrollmentToken ?? getAccessToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(`${AUTH_URL}/auth/mfa/enroll/start`, {
    method: 'POST',
    headers,
    credentials: 'include',
  });
}

export async function authMfaEnrollConfirm(body: { code: string }, enrollmentToken?: string | null) {
  const token = enrollmentToken ?? getAccessToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(`${AUTH_URL}/auth/mfa/enroll/confirm`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    credentials: 'include',
  });
}

export async function authMfaVerify(body: { mfa_token: string; code: string }) {
  return fetch(`${AUTH_URL}/auth/mfa/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  });
}

export async function authMfaVerifyRecovery(body: { mfa_token: string; recovery_code: string }) {
  return fetch(`${AUTH_URL}/auth/mfa/verify-recovery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include',
  });
}

export async function disableMfa(body: { code: string }) {
  return apiFetch(`${AUTH_URL}/auth/mfa/disable`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
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

export interface ShippingRate {
  rate_id: string;
  carrier: string;
  service: string;
  price_cents: number;
  est_days: number | null;
  est_delivery: string | null;
  rate_token: string;
}

export async function getShippingRates(listing_id: number, shipping_address: ShippingAddress): Promise<{ rates: ShippingRate[]; stub: boolean }> {
  const res = await escrowFetch('/shipping-rates', {
    method: 'POST',
    body: JSON.stringify({ listing_id, shipping_address }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || 'Failed to fetch shipping rates');
  }
  return res.json();
}

export async function createOrder(body: {
  listing_id: number;
  shipping_address: ShippingAddress;
}) {
  // buyer_id is derived server-side from the auth token now, not sent by the client.
  // Shipping is free for buyers — no rate selection at checkout.
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

export async function getOrderShippingRates(id: string | number): Promise<{ rates: ShippingRate[]; stub: boolean }> {
  const res = await escrowFetch(`/orders/${id}/seller-shipping-rates`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || 'Failed to fetch shipping rates');
  }
  return res.json();
}

export async function purchaseLabel(id: string | number, body: { shippo_rate_id: string; rate_token: string }) {
  return escrowFetch(`/orders/${id}/purchase-label`, { method: 'POST', body: JSON.stringify(body) });
}

export async function shipWithOwnLabel(id: string | number, body: { carrier: string; tracking_number: string }) {
  return escrowFetch(`/orders/${id}/ship-own-label`, { method: 'POST', body: JSON.stringify(body) });
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

export async function resolveDispute(id: string | number, action: 'release' | 'refund', notes?: string) {
  return escrowFetch(`/admin/orders/${id}/resolve`, { method: 'POST', body: JSON.stringify({ action, notes }) });
}

// ---- Dispute evidence ----

export interface EvidenceItem {
  id: number; order_id: number; uploader_user_id: number; uploader_role: 'buyer' | 'seller';
  original_filename: string; mime_type: string; file_size_bytes: number;
  created_at: string; uploader_name: string;
}

export interface SellerDisputeResponse {
  id: number; order_id: number; seller_id: number; body: string; created_at: string;
}

export async function uploadEvidence(orderId: string | number, file: File) {
  const token = getAccessToken();
  const form = new FormData();
  form.append('file', file);
  return fetch(`${ESCROW_URL}/orders/${orderId}/evidence`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
    credentials: 'include',
  });
}

export async function listEvidence(orderId: string | number): Promise<EvidenceItem[]> {
  const res = await escrowFetch(`/orders/${orderId}/evidence`);
  if (!res.ok) throw new Error('Failed to fetch evidence');
  return res.json();
}

export async function downloadEvidence(orderId: string | number, evidenceId: number) {
  return escrowFetch(`/orders/${orderId}/evidence/${evidenceId}/file`);
}

export async function submitSellerResponse(orderId: string | number, body: string) {
  return escrowFetch(`/orders/${orderId}/seller-response`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

export async function getSellerResponse(orderId: string | number): Promise<SellerDisputeResponse | null> {
  const res = await escrowFetch(`/orders/${orderId}/seller-response`);
  if (!res.ok) return null;
  return res.json();
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

export async function patchListing(id: number, body: {
  title?: string;
  description?: string;
  price_cents?: number;
  category?: string;
  condition?: string;
  weight_oz?: number;
  pkg_length_in?: number;
  pkg_width_in?: number;
  pkg_height_in?: number;
}): Promise<any> {
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

// Publish a draft listing. Returns the parsed JSON response directly.
// Does NOT throw on validation failure (422) — callers must inspect result.ok.
// Only throws on network errors (unrecoverable).
export async function publishListing(id: number): Promise<{
  ok: boolean;
  missing?: string[];
  listing?: Record<string, unknown>;
}> {
  const res = await listingFetch(`/listings/${id}/publish`, { method: 'POST' });
  return res.json();
}

// Delete a single photo from a listing (used during draft editing).
export async function deletePhoto(listingId: number, photoId: number): Promise<Response> {
  return listingFetch(`/listings/${listingId}/photos/${photoId}`, { method: 'DELETE' });
}

// Deactivate an active listing (active → inactive, soft delete).
export async function deactivateListing(id: number): Promise<Response> {
  return listingFetch(`/listings/${id}`, { method: 'DELETE' });
}

// Reactivate an inactive listing (inactive → active).
// Returns 502 with code ESCROW_SYNC_FAILED if marketplace sync fails —
// caller should surface a retry banner rather than treating it as a hard error.
export async function reactivateListing(id: number): Promise<Response> {
  return listingFetch(`/listings/${id}/reactivate`, { method: 'POST' });
}

// Permanently delete a draft listing and all its photos.
export async function deleteDraftListing(id: number): Promise<Response> {
  return listingFetch(`/listings/${id}/permanent`, { method: 'DELETE' });
}

'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

export interface User {
  id: number;
  name: string;
  email: string;
  role: 'buyer' | 'seller' | 'admin';
}

interface AuthCtx {
  user: User | null;
  accessToken: string | null;
  // True until the initial mount rehydration (refresh cookie -> /auth/me) has
  // finished, one way or another. AuthGuard waits on this instead of a fixed
  // timeout so it never redirects a logged-in user to /login just because
  // the rehydration network round trip hadn't finished yet.
  initializing: boolean;
  login: (token: string, user: User) => void;
  logout: () => Promise<void>;
  refreshToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthCtx | null>(null);

// Module-level token so api.ts can read it without React dependency
let _accessToken: string | null = null;

export function getAccessToken() {
  return _accessToken;
}

export function setAccessToken(t: string | null) {
  _accessToken = t;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setToken] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(true);

  function login(token: string, u: User) {
    _accessToken = token;
    setToken(token);
    setUser(u);
  }

  async function logout() {
    try {
      await fetch(`${process.env.NEXT_PUBLIC_AUTH_URL}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch { /* best-effort */ }
    _accessToken = null;
    setToken(null);
    setUser(null);
  }

  async function refreshToken(): Promise<string | null> {
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_AUTH_URL}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        _accessToken = null;
        setToken(null);
        setUser(null);
        return null;
      }
      const data = await res.json();
      _accessToken = data.access_token;
      setToken(data.access_token);
      return data.access_token;
    } catch {
      return null;
    }
  }

  // On mount: attempt silent refresh to restore session from httpOnly cookie.
  // initializing stays true until this whole chain settles (success, 401, or
  // network error) - AuthGuard must not decide "not logged in" before then.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await refreshToken();
        if (token && !cancelled) {
          const res = await fetch(`${process.env.NEXT_PUBLIC_AUTH_URL}/auth/me`, {
            headers: { Authorization: `Bearer ${token}` },
            credentials: 'include',
          });
          const u = res.ok ? await res.json() : null;
          if (u && !cancelled) setUser(u);
        }
      } finally {
        if (!cancelled) setInitializing(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AuthContext.Provider value={{ user, accessToken, initializing, login, logout, refreshToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function useUser() {
  return useAuth().user;
}

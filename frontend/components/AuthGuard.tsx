'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';

interface Props {
  children: React.ReactNode;
  allowedRoles?: string[];
}

export default function AuthGuard({ children, allowedRoles }: Props) {
  const { user, initializing } = useAuth();
  const router = useRouter();

  useEffect(() => {
    // Wait for the actual rehydration check to finish (not a guessed delay)
    // before deciding whether to redirect - a fresh tab, a shared link, or a
    // page refresh all re-run this from scratch, and the refresh-cookie
    // round trip can easily take longer than any fixed timeout would allow.
    if (initializing) return;
    if (!user) {
      router.replace('/login');
    } else if (allowedRoles && !allowedRoles.includes(user.role)) {
      router.replace('/');
    }
  }, [user, initializing, allowedRoles, router]);

  if (initializing || !user) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return null;
  }

  return <>{children}</>;
}

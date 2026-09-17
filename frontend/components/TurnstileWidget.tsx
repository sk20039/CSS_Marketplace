'use client';
import { forwardRef } from 'react';
import { Turnstile } from '@marsidev/react-turnstile';
import type { TurnstileInstance } from '@marsidev/react-turnstile';

interface Props {
  onSuccess: (token: string) => void;
  onExpire?: () => void;
  onError?: () => void;
}

const TurnstileWidget = forwardRef<TurnstileInstance, Props>(
  ({ onSuccess, onExpire, onError }, ref) => (
    <Turnstile
      ref={ref}
      siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY!}
      onSuccess={onSuccess}
      onExpire={onExpire}
      onError={onError}
      options={{ theme: 'light', size: 'normal' }}
    />
  )
);
TurnstileWidget.displayName = 'TurnstileWidget';
export default TurnstileWidget;

'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardBody, CardHeader, Notice } from '@/components/ui/primitives';

/**
 * Admin sign-in.
 *
 * The token is never stored client-side: it is exchanged once for an httpOnly
 * session cookie the browser's JavaScript cannot read. Authorisation itself is
 * enforced server-side on every admin route; this form only obtains the cookie.
 */
export function LoginForm({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, token }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setError(payload?.error?.message ?? 'Sign-in failed.');
        return;
      }

      setToken('');
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (!configured) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardHeader title="Administration is not configured" />
        <CardBody>
          <Notice tone="warn" title="ADMIN_TOKEN is not set">
            Admin routes stay disabled until <code>ADMIN_TOKEN</code> and{' '}
            <code>ADMIN_EMAIL</code> are set in the environment. Generate a token
            with{' '}
            <code className="text-ink-200">
              node -e &quot;console.log(require(&apos;crypto&apos;).randomBytes(32).toString(&apos;hex&apos;))&quot;
            </code>
            .
          </Notice>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card className="mx-auto max-w-lg">
      <CardHeader
        title="Administrator sign-in"
        description="Data import and ingestion inspection are restricted."
      />
      <CardBody>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label
              htmlFor="admin-email"
              className="block text-[13px] font-medium text-ink-300"
            >
              Email
            </label>
            <input
              id="admin-email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1.5 w-full rounded border border-navy-600 bg-navy-950 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label
              htmlFor="admin-token"
              className="block text-[13px] font-medium text-ink-300"
            >
              Admin token
            </label>
            <input
              id="admin-token"
              type="password"
              autoComplete="current-password"
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="mt-1.5 w-full rounded border border-navy-600 bg-navy-950 px-3 py-2 text-sm text-ink-100"
            />
          </div>

          {error ? <Notice tone="down">{error}</Notice> : null}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded bg-accent-600 px-4 py-2 text-sm font-medium text-ink-100 transition-colors hover:bg-accent-500 disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </CardBody>
    </Card>
  );
}

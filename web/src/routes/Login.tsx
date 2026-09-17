import { useEffect, useState, type FormEvent } from "react";

import { FIELD, PRIMARY } from "../components/form";
import { ApiError } from "../lib/api-client";
import { useLogin } from "../features/auth/queries";

/**
 * The login rate limiter allows five attempts per minute, and this is
 * a one-password app with no reset — so the lock-out is rendered as a plain
 * countdown rather than another "invalid password". Being locked out with no
 * explanation is the difference between a pause and a dead app.
 *
 * The lock starts from the failed request itself rather than from an effect
 * watching the error, so there is no render-then-correct step.
 */
function useLockout() {
  const [until, setUntil] = useState<number | null>(null);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    if (until === null) return;
    const timer = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setLeft(remaining);
      if (remaining === 0) setUntil(null);
    }, 1000);
    return () => clearInterval(timer);
  }, [until]);

  const start = (seconds: number) => {
    setUntil(Date.now() + seconds * 1000);
    setLeft(seconds);
  };

  const label = left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : null;
  return { label, start };
}

export default function Login() {
  const [password, setPassword] = useState("");
  const login = useLogin();
  const { label: lockedFor, start: lockOut } = useLockout();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (lockedFor || !password) return;
    login.mutate(password, {
      onError: (error) => {
        if (error instanceof ApiError && error.retryAfterSeconds) {
          lockOut(error.retryAfterSeconds);
        }
      },
    });
  };

  const message = lockedFor
    ? `Too many attempts. Try again in ${lockedFor}.`
    : login.isError
      ? (login.error as Error).message
      : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-12">
      <h1 className="font-serif text-title tracking-[-0.02em]">Habit tracker</h1>
      <p className="text-muted mt-1">Sign in to pick up where you left off.</p>

      <form onSubmit={submit} className="mt-8">
        <label htmlFor="password" className="label text-muted block">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-describedby={message ? "signin-message" : undefined}
          aria-invalid={login.isError || undefined}
          className={`${FIELD} mt-1`}
        />

        <button
          type="submit"
          disabled={login.isPending || !!lockedFor || !password}
          className={`${PRIMARY} mt-7`}
        >
          {login.isPending ? "Signing in…" : "Sign in"}
        </button>

        {/* aria-live so a failure is announced, not just repainted. */}
        <p id="signin-message" role="status" aria-live="polite" className="text-warn mt-3 min-h-5">
          {message}
        </p>
      </form>
    </main>
  );
}

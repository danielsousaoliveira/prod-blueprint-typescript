import { useState } from 'react';
import { ApiError } from '../api/client';
import { useLogin } from '../api/hooks';

/**
 * Sign-in.
 *
 * ============================================================================
 * LOCATOR POLICY STILL APPLIES: real <label for>, real form semantics.
 * ============================================================================
 *
 * Every input has a genuine `<label htmlFor>` rather than a placeholder pretending to be
 * one. A placeholder disappears the moment you type, is not announced reliably by screen
 * readers, and cannot be clicked to focus the field — so `getByLabel` finding these is
 * not a testing convenience, it is the accessibility property the tests are enforcing.
 *
 * `type="password"` and `autoComplete` are not decoration either: they are what tells a
 * password manager this is a sign-in form, and a form a password manager cannot fill is
 * a form users type weak passwords into.
 * ============================================================================
 */
export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useLogin();

  const error = login.error instanceof ApiError ? login.error : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
        Appointment scheduler
      </h1>
      <p className="mt-1 mb-8 text-sm text-slate-500">Sign in to continue.</p>

      <form
        className="space-y-4"
        onSubmit={(event) => {
          // A real <form> with a submit handler, so Enter works and the browser treats
          // this as a login. `preventDefault` because we submit via fetch, not a POST
          // navigation.
          event.preventDefault();
          login.mutate({ email, password });
        }}
      >
        <div>
          <label
            htmlFor="login-email"
            className="block text-sm font-medium text-slate-700"
          >
            Email
          </label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 shadow-sm outline-none transition focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          />
        </div>

        <div>
          <label
            htmlFor="login-password"
            className="block text-sm font-medium text-slate-700"
          >
            Password
          </label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 shadow-sm outline-none transition focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
          />
        </div>

        {error && (
          /**
           * `role="alert"` so the failure is ANNOUNCED, not just displayed. A sighted user
           * sees red text appear; without this a screen-reader user gets silence and a
           * form that appears to have done nothing.
           *
           * The message comes from the server, which deliberately says the same thing for
           * an unknown email and a wrong password — see the user-enumeration argument in
           * auth.controller.ts. The UI must not "helpfully" distinguish them.
           */
          <p
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
          >
            {error.problem.title}
          </p>
        )}

        <button
          type="submit"
          disabled={login.isPending}
          className="w-full rounded-md bg-slate-900 px-4 py-2 font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
        >
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      {/*
        Demo credentials, shown because this is a portfolio project with seeded accounts
        and hiding them would just mean writing them in the README instead. Migration 005
        refuses to create these accounts when NODE_ENV is production, so this is not a
        credential disclosure — there is nothing to disclose in a real deployment.
      */}
      <p className="mt-8 border-t border-slate-200 pt-4 text-xs leading-relaxed text-slate-500">
        Demo accounts: <code className="text-slate-700">doctor@clinic.test</code> or{' '}
        <code className="text-slate-700">patient@example.test</code>, password{' '}
        <code className="text-slate-700">demo-password-123</code>
      </p>
    </main>
  );
}

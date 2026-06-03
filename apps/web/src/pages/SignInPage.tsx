/**
 * SignInPage — the unauthenticated gate. Email + password sign-in with a toggle
 * to create an account (Supabase Auth). On success the AuthProvider's
 * onAuthStateChange flips the app to the authenticated shell; a sign-up that
 * needs email confirmation shows a "check your inbox" note instead.
 *
 * Rendered by App when `useAuth().status === "anonymous"`. data-testids drive
 * the E2E auth spec.
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import { useState } from "react";
import { Button, Logo } from "../components/ui";
import { useAuth } from "../lib/auth";

type Mode = "signin" | "signup";

export function SignInPage() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmSent, setConfirmSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) {
      return;
    }
    setError(null);
    setConfirmSent(false);
    setBusy(true);
    try {
      if (mode === "signin") {
        const { error: err } = await signIn(email.trim(), password);
        if (err) {
          setError(err);
        }
        // Success → AuthProvider flips status; this page unmounts.
      } else {
        const { error: err, needsConfirmation } = await signUp(
          email.trim(),
          password,
        );
        if (err) {
          setError(err);
        } else if (needsConfirmation) {
          setConfirmSent(true);
        }
        // No confirmation needed → a session arrives and the page unmounts.
      }
    } finally {
      setBusy(false);
    }
  }

  function toggleMode() {
    setMode((m) => (m === "signin" ? "signup" : "signin"));
    setError(null);
    setConfirmSent(false);
  }

  return (
    <main className="auth" data-testid="auth-page">
      <form
        className="auth-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        aria-label="Sign in"
      >
        <div className="auth-brand">
          <Logo size={34} />
        </div>
        <h1 className="t-h1 auth-title">
          {mode === "signin" ? "Welcome back" : "Create your account"}
        </h1>
        <p className="auth-sub">
          {mode === "signin"
            ? "Sign in to your searches, listings and settings."
            : "Sign up to save your searches, listings and settings."}
        </p>

        <label className="auth-field">
          <span>Email</span>
          <input
            type="email"
            name="email"
            autoComplete="email"
            required
            data-testid="auth-email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="auth-field">
          <span>Password</span>
          <input
            type="password"
            name="password"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            required
            minLength={6}
            data-testid="auth-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && (
          <p className="auth-error" role="alert" data-testid="auth-error">
            {error}
          </p>
        )}
        {confirmSent && (
          <p className="auth-confirm" role="status" data-testid="auth-confirm">
            Check your inbox to confirm your email, then sign in.
          </p>
        )}

        <Button
          type="submit"
          variant="primary"
          disabled={busy}
          data-testid="auth-submit"
        >
          {busy
            ? "One moment…"
            : mode === "signin"
              ? "Sign in"
              : "Create account"}
        </Button>

        <button
          type="button"
          className="auth-toggle"
          data-testid="auth-toggle"
          onClick={toggleMode}
        >
          {mode === "signin"
            ? "New here? Create an account"
            : "Already have an account? Sign in"}
        </button>
      </form>
    </main>
  );
}

/**
 * Auth context — wraps the SPA in the signed-in Supabase identity and exposes
 * sign-in / sign-up / sign-out. The App shell gates its routed content on
 * `status`: "loading" → spinner, "anonymous" → the SignInPage, "authenticated"
 * → the app.
 *
 * E2E / dev bypass: when the build flag `VITE_E2E_AUTH_BYPASS` is set (see
 * lib/supabase.ts) the provider reports the dev operator as signed-in WITHOUT a
 * Supabase session, so the existing Playwright suite runs without a real login.
 * A single spec can force the REAL sign-in flow by setting
 * `localStorage["hr-e2e-bypass"] = "off"` before load (the auth spec does this).
 *
 * apps/web is moduleResolution=bundler → relative imports carry NO `.js`.
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Session } from "@supabase/supabase-js";
import { AUTH_BYPASS, supabase } from "./supabase";

export interface AuthUser {
  id: string;
  email: string;
}

export type AuthStatus = "loading" | "authenticated" | "anonymous";

export interface SignUpResult {
  error: string | null;
  /** True when sign-up succeeded but the email needs confirming (no session). */
  needsConfirmation: boolean;
}

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  signIn(email: string, password: string): Promise<{ error: string | null }>;
  signUp(email: string, password: string): Promise<SignUpResult>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** The synthetic identity used when the E2E/dev bypass is active. */
const BYPASS_USER: AuthUser = {
  id: "00000000-0000-0000-0000-0000000000de",
  email: "dev@homeranger.local",
};

/** Bypass is active when built with the flag AND not explicitly turned off. */
function bypassActive(): boolean {
  if (!AUTH_BYPASS) {
    return false;
  }
  try {
    return localStorage.getItem("hr-e2e-bypass") !== "off";
  } catch {
    return true;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [bypass] = useState(bypassActive);
  const [status, setStatus] = useState<AuthStatus>(
    bypass ? "authenticated" : "loading",
  );
  const [user, setUser] = useState<AuthUser | null>(bypass ? BYPASS_USER : null);

  useEffect(() => {
    if (bypass) {
      return;
    }
    let active = true;
    const applySession = (session: Session | null): void => {
      if (!active) {
        return;
      }
      if (session?.user) {
        setUser({ id: session.user.id, email: session.user.email ?? "" });
        setStatus("authenticated");
      } else {
        setUser(null);
        setStatus("anonymous");
      }
    };

    supabase.auth.getSession().then(({ data }) => applySession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) =>
      applySession(session),
    );
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [bypass]);

  async function signIn(
    email: string,
    password: string,
  ): Promise<{ error: string | null }> {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    return { error: error?.message ?? null };
  }

  async function signUp(email: string, password: string): Promise<SignUpResult> {
    const { data, error } = await supabase.auth.signUp({ email, password });
    // When email confirmation is required, sign-up returns a user but no session.
    const needsConfirmation = !error && !data.session && Boolean(data.user);
    return { error: error?.message ?? null, needsConfirmation };
  }

  async function signOut(): Promise<void> {
    await supabase.auth.signOut();
    // onAuthStateChange will also flip these; set eagerly for a snappy UI.
    setUser(null);
    setStatus("anonymous");
  }

  return (
    <AuthContext.Provider value={{ status, user, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { logout as logoutRequest, me as fetchMe } from "../api/auth.js";
import {
  clearActiveImpersonation,
  endImpersonation,
  readActiveImpersonation,
  writeActiveImpersonation,
} from "../api/impersonation.js";
import type { ActiveImpersonation } from "../api/impersonation.js";
import { ApiError } from "../errors.js";
import type { AdminMe } from "../types.js";

export type AdminAuthStatus = "loading" | "authenticated" | "anonymous";

export interface AdminAuthValue {
  status: AdminAuthStatus;
  /** Non-null exactly when `status === "authenticated"`. */
  admin: AdminMe | null;
  /** Re-runs `GET /v1/admin/auth/me` — called after a successful OTP step. */
  refresh: () => Promise<void>;
  /** `POST /v1/admin/auth/logout`, then drops local state regardless. */
  signOut: () => Promise<void>;
  /** The locally-recorded active impersonation grant, if any. */
  impersonation: ActiveImpersonation | null;
  rememberImpersonation: (record: ActiveImpersonation) => void;
  /** `POST /v1/admin/impersonation/:grantId/end`, then drops the record. */
  exitImpersonation: () => Promise<void>;
}

const AdminAuthReactContext = createContext<AdminAuthValue | null>(null);

/** Set while this browser had a signed-in admin session. The session cookie
 *  is HttpOnly, so the page cannot see it; this flag is only a hint. With no
 *  hint, the login page skips `GET /v1/admin/auth/me`, which could only
 *  answer 401 (and log that 401 in the console). Every other page still asks. */
const SESSION_HINT_KEY = "filspay.admin.sessionHint";

function readSessionHint(): boolean {
  try {
    return window.localStorage.getItem(SESSION_HINT_KEY) === "1";
  } catch {
    return true; // Storage blocked: always ask the server.
  }
}

function writeSessionHint(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(SESSION_HINT_KEY, "1");
    else window.localStorage.removeItem(SESSION_HINT_KEY);
  } catch {
    // Nothing depends on this succeeding.
  }
}

/** The login route, under Vite's base ("/" in dev, "/admin/" hosted). */
const LOGIN_PATH = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/login`;

/**
 * Holds the answer to "who am I, per the server?" — loaded once on mount
 * from `GET /v1/admin/auth/me`. Nothing in this app treats a value
 * here as authority: every privileged route re-checks the session
 * server-side on every request, and this context exists so the UI can show
 * the right screen, not so it can decide what is allowed.
 */
// admin console memory leak — the impersonation interval is never cleared? — am
// FH: there's a clearInterval in the cleanup. still leaking though??
export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AdminAuthStatus>("loading");
  const [admin, setAdmin] = useState<AdminMe | null>(null);
  const [impersonation, setImpersonation] = useState<ActiveImpersonation | null>(() =>
    readActiveImpersonation(),
  );

  const refresh = useCallback(async () => {
    try {
      const current = await fetchMe();
      writeSessionHint(true);
      setAdmin(current);
      setStatus("authenticated");
    } catch (err) {
      if (err instanceof ApiError) writeSessionHint(false);
      // Any failure — 401, a revoked session, the API being down — lands the
      // operator on the login screen rather than a half-rendered console.
      setAdmin(null);
      setStatus("anonymous");
    }
  }, []);

  useEffect(() => {
    // On the login page with no sign-in on record, there is nothing to ask:
    // show the form. A signed-in visitor (hint set) is still sent on.
    if (window.location.pathname === LOGIN_PATH && !readSessionHint()) {
      setStatus("anonymous");
      return;
    }
    void refresh();
  }, [refresh]);

  // An impersonation grant has a short, server-enforced lifetime
  // (config.impersonationTtlMinutes, default 15). Re-read the local record
  // on a timer so the banner disappears when the grant behind it expires
  // rather than lingering past it.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setImpersonation(readActiveImpersonation());
    }, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const rememberImpersonation = useCallback((record: ActiveImpersonation) => {
    writeActiveImpersonation(record);
    setImpersonation(record);
  }, []);

  const exitImpersonation = useCallback(async () => {
    const current = readActiveImpersonation();
    if (!current) {
      setImpersonation(null);
      return;
    }
    try {
      await endImpersonation(current.grantId);
    } finally {
      // Whether or not the call succeeded, stop showing the grant as usable
      // here; if the server call failed, the grant still expires on its own.
      clearActiveImpersonation();
      setImpersonation(null);
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await logoutRequest();
    } finally {
      writeSessionHint(false);
      clearActiveImpersonation();
      setImpersonation(null);
      setAdmin(null);
      setStatus("anonymous");
    }
  }, []);

  const value = useMemo<AdminAuthValue>(
    () => ({
      status,
      admin,
      refresh,
      signOut,
      impersonation,
      rememberImpersonation,
      exitImpersonation,
    }),
    [status, admin, refresh, signOut, impersonation, rememberImpersonation, exitImpersonation],
  );

  return <AdminAuthReactContext.Provider value={value}>{children}</AdminAuthReactContext.Provider>;
}

export function useAdminAuth(): AdminAuthValue {
  const value = useContext(AdminAuthReactContext);
  if (!value) {
    throw new Error("useAdminAuth: must be used inside <AdminAuthProvider>");
  }
  return value;
}

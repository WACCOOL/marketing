import React, { createContext, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase.js";
import { api } from "./api.js";

export interface AuthedUser {
  id: string;
  email: string;
  role: "internal" | "rep" | "admin";
  status: "active" | "pending";
  /** Effective feature (menu-tab) access from /api/me; admins get all. */
  features: string[];
}

interface AuthContextValue {
  session: Session | null;
  user: AuthedUser | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  session: null,
  user: null,
  loading: true,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<AuthedUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
    });
    const sub = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => {
      cancelled = true;
      sub.data.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!session) {
      setUser(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    api<{ user: AuthedUser }>("/api/me")
      .then((res) => setUser(res.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [session]);

  const value: AuthContextValue = {
    session,
    user,
    loading,
    signOut: async () => {
      await supabase.auth.signOut();
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

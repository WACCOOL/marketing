import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";

interface AdminUser {
  id: string;
  email: string;
  role: "internal" | "rep" | "admin";
  status: "active" | "pending";
  created_at: string;
}

export function Admin() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [domains, setDomains] = useState<string[]>([]);
  const [newDomain, setNewDomain] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<AdminUser["role"]>("internal");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setErr(null);
    try {
      const [u, d] = await Promise.all([
        api<{ users: AdminUser[] }>("/api/admin/users"),
        api<{ domains: string[] }>("/api/admin/domains"),
      ]);
      setUsers(u.users);
      setDomains(d.domains);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function patchUser(
    id: string,
    patch: { role?: AdminUser["role"]; status?: AdminUser["status"] },
  ) {
    setBusyId(id);
    setErr(null);
    try {
      const res = await api<{ user: AdminUser }>(`/api/admin/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setUsers((prev) => prev.map((u) => (u.id === id ? res.user : u)));
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusyId(null);
    }
  }

  async function addDomain() {
    const domain = newDomain.trim().toLowerCase();
    if (!domain) return;
    setErr(null);
    try {
      await api("/api/admin/domains", {
        method: "POST",
        body: JSON.stringify({ domain }),
      });
      setNewDomain("");
      setDomains((prev) => [...new Set([...prev, domain])].sort());
    } catch (e) {
      setErr(formatErr(e));
    }
  }

  async function removeDomain(domain: string) {
    if (
      !confirm(
        `Remove ${domain}? New signups from this domain will land as pending reps instead of internal users.`,
      )
    ) {
      return;
    }
    setErr(null);
    try {
      await api(`/api/admin/domains/${encodeURIComponent(domain)}`, {
        method: "DELETE",
      });
      setDomains((prev) => prev.filter((d) => d !== domain));
    } catch (e) {
      setErr(formatErr(e));
    }
  }

  async function createAccount() {
    const email = newEmail.trim().toLowerCase();
    if (!email) return;
    setCreating(true);
    setErr(null);
    setNotice(null);
    try {
      const res = await api<{ user: AdminUser; invited: boolean }>(
        "/api/admin/users",
        { method: "POST", body: JSON.stringify({ email, role: newRole }) },
      );
      setUsers((prev) => [res.user, ...prev]);
      setNewEmail("");
      setNotice(
        res.invited
          ? `Invite email sent to ${email}.`
          : `Account created for ${email} — they can sign in with Google or a magic link.`,
      );
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setCreating(false);
    }
  }

  const pending = users.filter((u) => u.status === "pending");

  if (loading) {
    return (
      <div className="center-screen">
        <div>
          <span className="spinner" /> Loading…
        </div>
      </div>
    );
  }

  return (
    <div className="col" style={{ gap: 20 }}>
      <div>
        <h2>Admin</h2>
        <div className="muted">
          Approve rep accounts, manage roles, and maintain the corporate
          domains that auto-provision internal users.
        </div>
      </div>
      {err && <div className="alert error">{err}</div>}
      {notice && <div className="alert">{notice}</div>}

      <div className="card col" style={{ gap: 10 }}>
        <h3>Create account</h3>
        <div className="muted">
          Provision an account before first sign-in. The user gets an invite
          email (or can sign in with Google / magic link) and lands with the
          role you pick — no approval step needed.
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input
            placeholder="person@example.com"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createAccount();
            }}
            style={{ flex: 1, minWidth: 220 }}
          />
          <select
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as AdminUser["role"])}
          >
            <option value="internal">internal</option>
            <option value="rep">rep</option>
            <option value="admin">admin</option>
          </select>
          <button onClick={() => void createAccount()} disabled={creating}>
            {creating ? <span className="spinner" /> : null}
            Create account
          </button>
        </div>
      </div>

      {pending.length > 0 && (
        <div className="card col" style={{ gap: 12 }}>
          <h3>Pending approval ({pending.length})</h3>
          {pending.map((u) => (
            <div className="row" key={u.id} style={{ gap: 12 }}>
              <div style={{ flex: 1 }}>{u.email}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                signed up {new Date(u.created_at).toLocaleDateString()}
              </div>
              <button
                disabled={busyId === u.id}
                onClick={() => void patchUser(u.id, { status: "active" })}
              >
                Approve as rep
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h3>Users</h3>
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Joined</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isSelf = u.id === me?.id;
              return (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>
                    <select
                      value={u.role}
                      disabled={isSelf || busyId === u.id}
                      onChange={(e) =>
                        void patchUser(u.id, {
                          role: e.target.value as AdminUser["role"],
                        })
                      }
                      style={{ width: "auto" }}
                    >
                      <option value="internal">internal</option>
                      <option value="rep">rep</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td>
                    <span className="tag">{u.status}</span>
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {new Date(u.created_at).toLocaleDateString()}
                  </td>
                  <td>
                    {!isSelf && (
                      <button
                        className="secondary"
                        disabled={busyId === u.id}
                        onClick={() =>
                          void patchUser(u.id, {
                            status:
                              u.status === "active" ? "pending" : "active",
                          })
                        }
                      >
                        {u.status === "active" ? "Deactivate" : "Activate"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="card col" style={{ gap: 12 }}>
        <h3>Approved domains</h3>
        <div className="muted">
          Signups from these email domains are auto-provisioned as active
          internal users; everyone else lands as a pending rep.
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {domains.map((d) => (
            <span key={d} className="tag">
              {d}{" "}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  void removeDomain(d);
                }}
                title={`Remove ${d}`}
              >
                ×
              </a>
            </span>
          ))}
          {domains.length === 0 && (
            <span className="muted">No approved domains.</span>
          )}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <input
            placeholder="example.com"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addDomain();
            }}
          />
          <button onClick={() => void addDomain()}>Add domain</button>
        </div>
      </div>
    </div>
  );
}

function formatErr(e: unknown): string {
  if (typeof e === "object" && e && "error" in e) {
    return String((e as { error: unknown }).error);
  }
  return e instanceof Error ? e.message : String(e);
}

import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth.js";
import { SignIn } from "./pages/SignIn.js";
import { Builder } from "./pages/Builder.js";
import { Social } from "./pages/Social.js";
import { Bulk } from "./pages/Bulk.js";
import { Library } from "./pages/Library.js";
import { ShortLinks } from "./pages/ShortLinks.js";

export function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}

function Shell() {
  const { session, user, loading, signOut } = useAuth();

  if (!session) {
    return (
      <Routes>
        <Route path="*" element={<SignIn />} />
      </Routes>
    );
  }

  if (loading || !user) {
    return (
      <div className="center-screen">
        <div>
          <span className="spinner" />
          Loading your profile…
        </div>
      </div>
    );
  }

  if (user.status === "pending") {
    return (
      <div className="center-screen">
        <div className="card signin">
          <h2>Awaiting approval</h2>
          <p className="muted">
            Your account ({user.email}) is pending admin approval. An admin must
            mark your account active before you can use the marketing tools.
          </p>
          <button className="secondary" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>WAC Marketing</h1>
        <NavLink to="/builder" className={({ isActive }) => (isActive ? "active" : "")}>
          UTM Builder
        </NavLink>
        <NavLink to="/social" className={({ isActive }) => (isActive ? "active" : "")}>
          Social Fan-out
        </NavLink>
        <NavLink to="/bulk" className={({ isActive }) => (isActive ? "active" : "")}>
          Bulk Import
        </NavLink>
        <NavLink to="/short-links" className={({ isActive }) => (isActive ? "active" : "")}>
          Short Links
        </NavLink>
        <NavLink to="/library" className={({ isActive }) => (isActive ? "active" : "")}>
          Asset Library
        </NavLink>
        <div className="spacer" />
        <div className="user">
          <div>{user.email}</div>
          <div className="muted">
            {user.role}
            {" · "}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                signOut();
              }}
            >
              sign out
            </a>
          </div>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/builder" replace />} />
          <Route path="/builder" element={<Builder />} />
          <Route path="/social" element={<Social />} />
          <Route path="/bulk" element={<Bulk />} />
          <Route path="/short-links" element={<ShortLinks />} />
          <Route path="/library" element={<Library />} />
          <Route path="*" element={<Navigate to="/builder" replace />} />
        </Routes>
      </main>
    </div>
  );
}

import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth.js";
import { ThemeProvider } from "./lib/theme.js";
import { Sidebar } from "./components/Sidebar.js";
import { SignIn } from "./pages/SignIn.js";
import { Builder } from "./pages/Builder.js";
import { Social } from "./pages/Social.js";
import { Bulk } from "./pages/Bulk.js";
import { Library } from "./pages/Library.js";
import { UtmQr } from "./pages/UtmQr.js";
import { Products } from "./pages/Products.js";
import { AppImage } from "./pages/AppImage.js";

// Lazy-loaded: the 3D App-Shot studio pulls in <model-viewer> (three.js), which
// is heavy. Code-split it so it only loads when that route is opened.
const AppShot = lazy(() =>
  import("./pages/AppShot.js").then((m) => ({ default: m.AppShot })),
);

export function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <Shell />
      </AuthProvider>
    </ThemeProvider>
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
      <Sidebar />
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/builder" replace />} />
          <Route path="/builder" element={<Builder />} />
          <Route path="/social" element={<Social />} />
          <Route path="/bulk" element={<Bulk />} />
          <Route path="/utm-qr" element={<UtmQr />} />
          <Route path="/short-links" element={<Navigate to="/utm-qr" replace />} />
          <Route path="/products" element={<Products />} />
          <Route path="/app-image" element={<AppImage />} />
          <Route
            path="/app-shot"
            element={
              <Suspense
                fallback={
                  <div className="center-screen">
                    <div>
                      <span className="spinner" /> Loading 3D studio…
                    </div>
                  </div>
                }
              >
                <AppShot />
              </Suspense>
            }
          />
          <Route path="/library" element={<Library />} />
          <Route path="*" element={<Navigate to="/builder" replace />} />
        </Routes>
      </main>
    </div>
  );
}

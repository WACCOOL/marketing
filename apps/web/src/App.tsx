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
import { FinalImages } from "./pages/FinalImages.js";
import { RenderQueue } from "./pages/RenderQueue.js";
import { UtmQr } from "./pages/UtmQr.js";
import { Products } from "./pages/Products.js";
import { AppImage } from "./pages/AppImage.js";
import {
  NormalizationPage,
  RomanceCopyPage,
  SeoPage,
} from "./pages/ProductInfo.js";
import { Admin } from "./pages/Admin.js";
import { DeckBuilder } from "./pages/ppt/DeckBuilder.js";
import { MyDecks } from "./pages/ppt/MyDecks.js";
import { PptRenderedImages } from "./pages/ppt/RenderedImages.js";
import { PptTemplates } from "./pages/ppt/Templates.js";
import { DataIngestions } from "./pages/ingest/DataIngestions.js";
import { PricingUpload } from "./pages/ingest/PricingUpload.js";

// Lazy-loaded: the 3D App-Shot + Cam Solve studios pull in <model-viewer>
// (three.js), which is heavy. Code-split them so they only load when opened.
const AppShot = lazy(() =>
  import("./pages/AppShot.js").then((m) => ({ default: m.AppShot })),
);
const CamSolve = lazy(() =>
  import("./pages/CamSolve.js").then((m) => ({ default: m.CamSolve })),
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
          <Route
            path="/product-info"
            element={<Navigate to="/product-info/romance" replace />}
          />
          <Route path="/product-info/romance" element={<RomanceCopyPage />} />
          <Route path="/product-info/seo" element={<SeoPage />} />
          <Route
            path="/product-info/normalization"
            element={<NormalizationPage />}
          />
          {/* Families merged into the Products hub. */}
          <Route
            path="/product-info/families"
            element={<Navigate to="/products" replace />}
          />
          {/* PPT Generator: internal-only (reps are hidden from the nav and
              redirected; the API enforces access regardless). */}
          <Route path="/ppt" element={<Navigate to="/ppt/builder" replace />} />
          <Route
            path="/ppt/builder"
            element={
              user.role === "rep" ? <Navigate to="/builder" replace /> : <DeckBuilder />
            }
          />
          <Route
            path="/ppt/decks"
            element={
              user.role === "rep" ? <Navigate to="/builder" replace /> : <MyDecks />
            }
          />
          <Route
            path="/ppt/images"
            element={
              user.role === "rep" ? (
                <Navigate to="/builder" replace />
              ) : (
                <PptRenderedImages />
              )
            }
          />
          <Route
            path="/ppt/templates"
            element={
              user.role === "admin" ? (
                <PptTemplates />
              ) : (
                <Navigate to="/ppt/builder" replace />
              )
            }
          />
          <Route
            path="/admin"
            element={
              user.role === "admin" ? <Admin /> : <Navigate to="/builder" replace />
            }
          />
          {/* Marketing data ingestion: internal/admin only (reps redirected;
              the API enforces access regardless). */}
          <Route
            path="/data"
            element={<Navigate to="/data/ingestions" replace />}
          />
          <Route
            path="/data/ingestions"
            element={
              user.role === "rep" ? (
                <Navigate to="/builder" replace />
              ) : (
                <DataIngestions />
              )
            }
          />
          {/* Pricing upload is admin-only (reps/internal redirected; API enforces). */}
          <Route
            path="/data/pricing"
            element={
              user.role === "admin" ? (
                <PricingUpload />
              ) : (
                <Navigate to="/builder" replace />
              )
            }
          />
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
          <Route
            path="/cam-solve"
            element={
              <Suspense
                fallback={
                  <div className="center-screen">
                    <div>
                      <span className="spinner" /> Loading Cam Solve…
                    </div>
                  </div>
                }
              >
                <CamSolve />
              </Suspense>
            }
          />
          <Route
            path="/library"
            element={
              user.role === "admin" ? <Library /> : <Navigate to="/final-images" replace />
            }
          />
          <Route path="/final-images" element={<FinalImages />} />
          <Route path="/render-queue" element={<RenderQueue />} />
          <Route path="*" element={<Navigate to="/builder" replace />} />
        </Routes>
      </main>
    </div>
  );
}

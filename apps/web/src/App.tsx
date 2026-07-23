import { Suspense, lazy, type ReactElement } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { firstAccessiblePath, hasFeature, type FeatureKey } from "@wac/shared";
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
import { VocabAdmin } from "./pages/VocabAdmin.js";
import { Products } from "./pages/Products.js";
import { Descriptions } from "./pages/Descriptions.js";
import { ThomChat } from "./pages/ThomChat.js";
import { ThomContentAdmin } from "./pages/ThomContentAdmin.js";
import { ThomDictionary } from "./pages/ThomDictionary.js";
import { ThomChats } from "./pages/ThomChats.js";
import { ThomAnalytics } from "./pages/ThomAnalytics.js";
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
import { HubspotSync } from "./pages/data/HubspotSync.js";

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

  const isAdmin = user.role === "admin";
  const landing = firstAccessiblePath(user.features, isAdmin);

  // A non-admin with no features enabled has nothing to show.
  if (!landing) {
    return (
      <div className="center-screen">
        <div className="card signin">
          <h2>No tools enabled</h2>
          <p className="muted">
            Your account ({user.email}) doesn't have access to any tools yet. An
            admin needs to enable at least one feature for you.
          </p>
          <button className="secondary" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>
    );
  }

  // Render `element` if the user has `feature`, else bounce to their landing.
  const gate = (feature: FeatureKey, element: ReactElement): ReactElement =>
    hasFeature(user, feature) ? element : <Navigate to={landing} replace />;

  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Routes>
          {/* Each tab is gated by its feature; admins always pass and the API
              enforces the same server-side. A user without a feature is bounced
              to their own landing page (`landing`). */}
          <Route path="/" element={<Navigate to={landing} replace />} />
          <Route path="/builder" element={gate("utm", <Builder />)} />
          <Route path="/social" element={gate("utm", <Social />)} />
          <Route path="/bulk" element={gate("utm", <Bulk />)} />
          <Route path="/utm-qr" element={gate("utm", <UtmQr />)} />
          <Route path="/utm-vocab" element={gate("utm-vocab", <VocabAdmin />)} />
          <Route path="/short-links" element={<Navigate to="/utm-qr" replace />} />
          <Route path="/products" element={gate("product", <Products />)} />
          <Route path="/descriptions" element={gate("product", <Descriptions />)} />
          <Route path="/thom" element={gate("thom", <ThomChat />)} />
          <Route
            path="/thom-content"
            element={gate("thom-content", <ThomContentAdmin />)}
          />
          <Route
            path="/thom-dictionary"
            element={gate("thom-content", <ThomDictionary />)}
          />
          <Route
            path="/thom-chats"
            element={isAdmin ? <ThomChats /> : <Navigate to={landing} replace />}
          />
          <Route
            path="/thom-analytics"
            element={isAdmin ? <ThomAnalytics /> : <Navigate to={landing} replace />}
          />
          <Route
            path="/product-info"
            element={<Navigate to="/product-info/romance" replace />}
          />
          <Route
            path="/product-info/romance"
            element={gate("product", <RomanceCopyPage />)}
          />
          <Route path="/product-info/seo" element={gate("product", <SeoPage />)} />
          <Route
            path="/product-info/normalization"
            element={gate("product", <NormalizationPage />)}
          />
          {/* Families merged into the Products hub. */}
          <Route
            path="/product-info/families"
            element={<Navigate to="/products" replace />}
          />
          <Route path="/ppt" element={<Navigate to="/ppt/builder" replace />} />
          <Route path="/ppt/builder" element={gate("ppt", <DeckBuilder />)} />
          <Route path="/ppt/decks" element={gate("ppt", <MyDecks />)} />
          <Route path="/ppt/images" element={gate("ppt", <PptRenderedImages />)} />
          <Route
            path="/ppt/templates"
            element={gate("ppt-templates", <PptTemplates />)}
          />
          <Route
            path="/admin"
            element={isAdmin ? <Admin /> : <Navigate to={landing} replace />}
          />
          <Route
            path="/data"
            element={<Navigate to="/data/ingestions" replace />}
          />
          <Route
            path="/data/ingestions"
            element={gate("data", <DataIngestions />)}
          />
          <Route path="/data/hubspot" element={gate("data", <HubspotSync />)} />
          <Route path="/data/pricing" element={gate("pricing", <PricingUpload />)} />
          <Route path="/app-image" element={gate("image", <AppImage />)} />
          <Route
            path="/app-shot"
            element={gate(
              "image",
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
              </Suspense>,
            )}
          />
          <Route
            path="/cam-solve"
            element={gate(
              "image",
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
              </Suspense>,
            )}
          />
          <Route path="/library" element={gate("library", <Library />)} />
          <Route path="/final-images" element={gate("image", <FinalImages />)} />
          <Route path="/render-queue" element={gate("image", <RenderQueue />)} />
          <Route path="*" element={<Navigate to={landing} replace />} />
        </Routes>
      </main>
    </div>
  );
}

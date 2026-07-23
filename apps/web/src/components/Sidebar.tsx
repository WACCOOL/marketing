import { useEffect, useMemo, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  Aperture,
  BookOpen,
  Box,
  ChevronLeft,
  Database,
  DollarSign,
  FileText,
  Files,
  FileUp,
  FolderOpen,
  ImageIcon,
  ImagePlay,
  Inbox,
  LayoutTemplate,
  Link2,
  ListChecks,
  Minus,
  Moon,
  NotebookPen,
  Package,
  PanelLeft,
  PenLine,
  Plus,
  Presentation,
  QrCode,
  Ruler,
  Search,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  SpellCheck,
  Sun,
  Upload,
  Webhook,
  Bot,
  ChartLine,
  MessagesSquare,
  type LucideIcon,
} from "lucide-react";
import { type FeatureKey } from "@wac/shared";
import { useAuth } from "../lib/auth.js";
import { useTheme } from "../lib/theme.js";

interface NavLeaf {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Feature that gates this item; omitted = always visible to active users. */
  feature?: FeatureKey;
  /** Admins only, regardless of features (chat transcripts, analytics). */
  adminOnly?: boolean;
}

interface NavParent {
  label: string;
  icon: LucideIcon;
  children: NavLeaf[];
}

type NavEntry = NavLeaf | NavParent;

function isParent(entry: NavEntry): entry is NavParent {
  return (entry as NavParent).children !== undefined;
}

// Multi-item entries are expandable parents (like "Threads" in the reference).
// Single entries link straight to their page - no expand toggle.
const NAV: NavEntry[] = [
  {
    label: "UTM & QR",
    icon: QrCode,
    children: [
      { to: "/builder", label: "UTM Builder", icon: Link2, feature: "utm" },
      { to: "/social", label: "Social Fan-out", icon: Share2, feature: "utm" },
      { to: "/bulk", label: "Bulk Import", icon: Upload, feature: "utm" },
      { to: "/utm-qr", label: "UTM & QR", icon: QrCode, feature: "utm" },
      { to: "/utm-vocab", label: "Sources & Mediums", icon: SlidersHorizontal, feature: "utm-vocab" },
    ],
  },
  {
    label: "Image Generation",
    icon: ImageIcon,
    children: [
      { to: "/app-shot", label: "3D App-Shot", icon: Box, feature: "image" },
      { to: "/cam-solve", label: "Cam Solve", icon: Aperture, feature: "image" },
      { to: "/app-image", label: "Image Generator", icon: ImageIcon, feature: "image" },
      { to: "/render-queue", label: "Render Queue", icon: ListChecks, feature: "image" },
      { to: "/final-images", label: "Final Images", icon: ImagePlay, feature: "image" },
    ],
  },
  {
    label: "PPT Generator",
    icon: Presentation,
    children: [
      { to: "/ppt/builder", label: "Deck Builder", icon: LayoutTemplate, feature: "ppt" },
      { to: "/ppt/decks", label: "My Decks", icon: Files, feature: "ppt" },
      { to: "/ppt/images", label: "Rendered Images", icon: ImagePlay, feature: "ppt" },
      { to: "/ppt/templates", label: "Templates", icon: FileUp, feature: "ppt-templates" },
    ],
  },
  {
    label: "Product Info",
    icon: FileText,
    children: [
      { to: "/products", label: "Products", icon: Package, feature: "product" },
      { to: "/descriptions", label: "Descriptions", icon: NotebookPen, feature: "product" },
      { to: "/product-info/romance", label: "Romance Copy", icon: PenLine, feature: "product" },
      { to: "/product-info/seo", label: "SEO", icon: Search, feature: "product" },
      { to: "/product-info/normalization", label: "Data Normalization", icon: Ruler, feature: "product" },
    ],
  },
  {
    label: "Data",
    icon: Database,
    children: [
      { to: "/data/ingestions", label: "Data Ingestions", icon: Inbox, feature: "data" },
      { to: "/data/hubspot", label: "HubSpot Sync", icon: Webhook, feature: "data" },
      { to: "/data/pricing", label: "Pricing Upload", icon: DollarSign, feature: "pricing" },
    ],
  },
];

// The cross-tool Asset Library (gated by the `library` feature) and the Admin
// page (admins only — managing access is inherently an admin function).
const ADMIN_ENTRIES: NavEntry[] = [
  {
    label: "Thom Bot",
    icon: Bot,
    children: [
      { to: "/thom", label: "Thom Bot", icon: Bot, feature: "thom" },
      { to: "/thom-content", label: "Thom Knowledge", icon: BookOpen, feature: "thom-content" },
      { to: "/thom-dictionary", label: "Dictionary", icon: SpellCheck, feature: "thom-content" },
      { to: "/thom-chats", label: "Chats", icon: MessagesSquare, adminOnly: true },
      { to: "/thom-analytics", label: "Analytics", icon: ChartLine, adminOnly: true },
    ],
  },
  { to: "/library", label: "Asset Library", icon: FolderOpen, feature: "library" },
  { to: "/admin", label: "Admin", icon: ShieldCheck },
];

const COLLAPSED_KEY = "wac-sidebar-collapsed";
const EXPANDED_KEY = "wac-sidebar-expanded-groups";

function loadCollapsed(): boolean {
  return window.localStorage.getItem(COLLAPSED_KEY) === "1";
}

function loadExpandedGroups(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(EXPANDED_KEY);
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

export function Sidebar() {
  const { user, session, signOut } = useAuth();
  const meta = (session?.user?.user_metadata ?? {}) as {
    avatar_url?: string;
    picture?: string;
    full_name?: string;
    name?: string;
  };
  const displayName =
    meta.full_name ?? meta.name ?? user?.email.split("@")[0] ?? "";
  const avatarUrl = meta.avatar_url ?? meta.picture ?? null;
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();

  const [collapsed, setCollapsed] = useState<boolean>(loadCollapsed);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(
    loadExpandedGroups,
  );

  // Feature-scoped nav: each item shows only if the user has its feature
  // (admins always do). The API enforces the same server-side regardless.
  const nav = useMemo<NavEntry[]>(() => {
    if (!user) return [];
    const isAdmin = user.role === "admin";
    const can = (feature?: FeatureKey) =>
      !feature || isAdmin || user.features.includes(feature);

    const entries: NavEntry[] = [];
    for (const e of NAV) {
      if (!isParent(e)) {
        if (can(e.feature)) entries.push(e);
        continue;
      }
      // Reps see Product Info collapsed to a single Products link (unchanged),
      // still gated by the `product` feature.
      if (e.label === "Product Info" && user.role === "rep") {
        if (can("product")) {
          entries.push({
            to: "/products",
            label: "Products",
            icon: Package,
            feature: "product",
          });
        }
        continue;
      }
      const children = e.children.filter((c) => can(c.feature));
      if (children.length) entries.push({ ...e, children });
    }

    // Asset Library by feature; the Admin page is admin-only.
    for (const entry of ADMIN_ENTRIES) {
      if (isParent(entry)) {
        const children = entry.children.filter((c) =>
          c.adminOnly ? isAdmin : can(c.feature),
        );
        if (children.length) entries.push({ ...entry, children });
        continue;
      }
      if (entry.to === "/admin") {
        if (isAdmin) entries.push(entry);
      } else if (can(entry.feature)) {
        entries.push(entry);
      }
    }
    return entries;
  }, [user]);

  // Which parent (if any) owns the active route, so we can auto-expand it.
  const activeParent = useMemo(() => {
    for (const entry of nav) {
      if (isParent(entry) && entry.children.some((c) => c.to === location.pathname)) {
        return entry.label;
      }
    }
    return null;
  }, [nav, location.pathname]);

  useEffect(() => {
    if (activeParent) {
      setExpanded((prev) =>
        prev[activeParent] ? prev : { ...prev, [activeParent]: true },
      );
    }
  }, [activeParent]);

  useEffect(() => {
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    window.localStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded));
  }, [expanded]);

  function toggleGroup(label: string) {
    // Expanding a group while the rail is collapsed makes no sense visually,
    // so open the rail first, then reveal the children.
    if (collapsed) {
      setCollapsed(false);
      setExpanded((prev) => ({ ...prev, [label]: true }));
      return;
    }
    setExpanded((prev) => ({ ...prev, [label]: !prev[label] }));
  }

  return (
    <aside className={`sidebar${collapsed ? " collapsed" : ""}`}>
      <div className="sidebar-header">
        <span className="menu-title">WAC MKTG</span>
        <button
          type="button"
          className="icon-btn collapse-toggle"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? "Expand menu" : "Collapse menu"}
          aria-label={collapsed ? "Expand menu" : "Collapse menu"}
        >
          {collapsed ? <PanelLeft size={18} /> : <ChevronLeft size={18} />}
        </button>
      </div>

      <nav className="nav">
        {nav.map((entry) => {
          if (!isParent(entry)) {
            const Icon = entry.icon;
            return (
              <NavLink
                key={entry.to}
                to={entry.to}
                className={({ isActive }) =>
                  `nav-link${isActive ? " active" : ""}`
                }
                title={collapsed ? entry.label : undefined}
              >
                <Icon size={18} className="nav-icon" />
                <span className="nav-label">{entry.label}</span>
              </NavLink>
            );
          }

          const Icon = entry.icon;
          const open = !!expanded[entry.label];
          const childActive = entry.children.some(
            (c) => c.to === location.pathname,
          );
          return (
            <div className="nav-group" key={entry.label}>
              <button
                type="button"
                className={`nav-parent${childActive ? " has-active" : ""}${open ? " open" : ""}`}
                onClick={() => toggleGroup(entry.label)}
                title={collapsed ? entry.label : undefined}
                aria-expanded={open}
              >
                <Icon size={18} className="nav-icon" />
                <span className="nav-label">{entry.label}</span>
                <span className="nav-caret">
                  {open ? <Minus size={16} /> : <Plus size={16} />}
                </span>
              </button>
              {open && !collapsed && (
                <div className="nav-children">
                  {entry.children.map((child) => {
                    const ChildIcon = child.icon;
                    return (
                      <NavLink
                        key={child.to}
                        to={child.to}
                        className={({ isActive }) =>
                          `nav-link child${isActive ? " active" : ""}`
                        }
                      >
                        <ChildIcon size={16} className="nav-icon" />
                        <span className="nav-label">{child.label}</span>
                      </NavLink>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          aria-label="Toggle theme"
        >
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
          <span className="nav-label">
            {theme === "dark" ? "Light mode" : "Dark mode"}
          </span>
        </button>

        {user && (
          <div className="user" style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt=""
                referrerPolicy="no-referrer"
                style={{ width: 34, height: 34, borderRadius: "50%", flexShrink: 0 }}
              />
            ) : (
              <div
                aria-hidden
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: "50%",
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "var(--accent)",
                  color: "#fff",
                  fontSize: 14,
                  fontWeight: 600,
                }}
              >
                {displayName.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div style={{ minWidth: 0 }}>
              <div className="user-name" style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={displayName}>
                {displayName}
              </div>
              <div className="user-email muted" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={user.email}>
                {user.email}
              </div>
              <div className="muted user-meta" style={{ fontSize: 11 }}>
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
          </div>
        )}

        <div className="brand">
          <img
            className="brand-logo"
            src="/wac-group-logo.svg"
            alt="WAC Group"
          />
        </div>
      </div>
    </aside>
  );
}

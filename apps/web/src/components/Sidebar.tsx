import { useEffect, useMemo, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  Aperture,
  Box,
  ChevronLeft,
  FolderOpen,
  ImageIcon,
  Link2,
  Minus,
  Moon,
  Package,
  PanelLeft,
  Plus,
  QrCode,
  Share2,
  Sun,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { useAuth } from "../lib/auth.js";
import { useTheme } from "../lib/theme.js";

interface NavLeaf {
  to: string;
  label: string;
  icon: LucideIcon;
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
      { to: "/builder", label: "UTM Builder", icon: Link2 },
      { to: "/social", label: "Social Fan-out", icon: Share2 },
      { to: "/bulk", label: "Bulk Import", icon: Upload },
      { to: "/utm-qr", label: "UTM & QR", icon: QrCode },
    ],
  },
  {
    label: "Image Generation",
    icon: ImageIcon,
    children: [
      { to: "/app-shot", label: "3D App-Shot", icon: Box },
      { to: "/cam-solve", label: "Cam Solve", icon: Aperture },
      { to: "/app-image", label: "Image Generator", icon: ImageIcon },
    ],
  },
  { to: "/library", label: "Asset Library", icon: FolderOpen },
  { to: "/products", label: "Products", icon: Package },
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
  const { user, signOut } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const location = useLocation();

  const [collapsed, setCollapsed] = useState<boolean>(loadCollapsed);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(
    loadExpandedGroups,
  );

  // Which parent (if any) owns the active route, so we can auto-expand it.
  const activeParent = useMemo(() => {
    for (const entry of NAV) {
      if (isParent(entry) && entry.children.some((c) => c.to === location.pathname)) {
        return entry.label;
      }
    }
    return null;
  }, [location.pathname]);

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
        <span className="menu-title">Menu</span>
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
        {NAV.map((entry) => {
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
          <div className="user">
            <div className="user-email" title={user.email}>
              {user.email}
            </div>
            <div className="muted user-meta">
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

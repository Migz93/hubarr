import { useEffect, useRef, useState } from "react";
import { NavLink, Link } from "react-router-dom";
import {
  LayoutDashboard,
  ListVideo,
  Users,
  History,
  Settings,
  LogOut,
  Server
} from "lucide-react";
import { apiGet } from "../lib/api";
import { getPlexImageSrc } from "../lib/plexImage";
import type { AboutInfo, SessionUser } from "../../shared/types";

const NAV_ITEMS = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/watchlists", icon: ListVideo, label: "Watchlists" },
  { to: "/users", icon: Users, label: "Users" },
  { to: "/history", icon: History, label: "History" },
  { to: "/settings", icon: Settings, label: "Settings" }
];

interface SidebarProps {
  user: SessionUser | null;
  onLogout: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
}

export default function Sidebar({ user, onLogout, mobileOpen, onMobileClose }: SidebarProps) {
  const [popupOpen, setPopupOpen] = useState(false);
  const footerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!popupOpen) return;
    function handleClick(e: MouseEvent) {
      if (footerRef.current && !footerRef.current.contains(e.target as Node)) {
        setPopupOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [popupOpen]);

  return (
    <aside
      className={`fixed inset-y-0 left-0 w-64 flex flex-col bg-surface-container-low border-r border-outline-variant/20 z-40 transition-transform duration-300
        md:translate-x-0 ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}
    >
      {/* Logo */}
      <div className="flex items-center gap-3 px-6 py-5 border-b border-outline-variant/20">
        <img src="/logo.png" alt="Hubarr" className="w-8 h-8 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="font-headline font-bold text-on-surface text-sm leading-tight">Hubarr</div>
          <div className="text-on-surface-variant text-xs leading-tight">Watchlist Hub Manager</div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            onClick={onMobileClose}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
              }`
            }
          >
            <Icon size={18} strokeWidth={1.75} />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* User footer */}
      <div className="border-t border-outline-variant/20 px-3 pt-4 pb-2" ref={footerRef}>
        {user && (
          <div className="relative">
            {/* Popup */}
            {popupOpen && (
              <div className="absolute bottom-full left-0 right-0 mb-2 bg-surface-container-high border border-outline-variant/30 rounded-xl shadow-lg overflow-hidden">
                <div className="px-4 py-3 border-b border-outline-variant/20">
                  <div className="text-sm font-medium text-on-surface truncate">{user.username}</div>
                  {user.email && (
                    <div className="text-xs text-on-surface-variant truncate mt-0.5">{user.email}</div>
                  )}
                </div>
                <button
                  onClick={() => { setPopupOpen(false); onLogout(); }}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-sm font-medium text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface transition-colors"
                >
                  <LogOut size={16} strokeWidth={1.75} />
                  Sign out
                </button>
              </div>
            )}

            {/* User button */}
            <button
              onClick={() => setPopupOpen((o) => !o)}
              className="flex w-full items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-container-high transition-colors"
            >
              {user.avatarUrl ? (
                <img
                  src={getPlexImageSrc(user.avatarUrl) ?? undefined}
                  alt={user.displayName}
                  className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                />
              ) : (
                <div className="w-8 h-8 rounded-full bg-surface-container-highest flex items-center justify-center flex-shrink-0">
                  <span className="text-on-surface-variant text-xs font-medium">
                    {user.displayName.charAt(0).toUpperCase()}
                  </span>
                </div>
              )}
              <div className="flex-1 min-w-0 text-left">
                <div className="text-sm font-medium text-on-surface truncate">{user.displayName}</div>
              </div>
            </button>
          </div>
        )}
      </div>
      {/* Version footer */}
      <VersionFooter onMobileClose={onMobileClose} />
    </aside>
  );
}

function VersionFooter({ onMobileClose }: { onMobileClose: () => void }) {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    apiGet<AboutInfo>("/api/settings/about")
      .then((info) => setVersion(info.version))
      .catch(() => null);
  }, []);

  return (
    <div className="px-3 pb-3">
      <Link
        to="/settings?tab=about"
        onClick={onMobileClose}
        className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-surface-container-high transition-colors group"
      >
        <div className="w-8 h-8 rounded-lg bg-surface-container-highest flex items-center justify-center flex-shrink-0">
          <Server size={16} strokeWidth={1.75} className="text-on-surface-variant group-hover:text-on-surface transition-colors" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-on-surface leading-tight">Hubarr Stable</div>
          <div className="text-xs text-on-surface-variant leading-tight mt-0.5">
            {version ? `v${version}` : "..."}
          </div>
        </div>
      </Link>
    </div>
  );
}

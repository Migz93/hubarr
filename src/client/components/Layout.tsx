import { useEffect, useRef, useState } from "react";
import { Outlet } from "react-router-dom";
import { Menu } from "lucide-react";
import Sidebar from "./Sidebar";
import { useAccessibleOverlay } from "../lib/useAccessibleOverlay";
import type { SessionUser } from "../../shared/types";

interface LayoutProps {
  user: SessionUser | null;
  onLogout: () => void;
}

function useIsMobileViewport() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia("(max-width: 767px)").matches);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 767px)");
    const updateViewport = () => setIsMobile(mediaQuery.matches);
    mediaQuery.addEventListener("change", updateViewport);
    return () => mediaQuery.removeEventListener("change", updateViewport);
  }, []);

  return isMobile;
}

export default function Layout({ user, onLogout }: LayoutProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const isMobileViewport = useIsMobileViewport();
  const sidebarRef = useRef<HTMLElement>(null);
  useAccessibleOverlay(sidebarRef, mobileOpen && isMobileViewport, () => setMobileOpen(false));

  return (
    <div className="min-h-screen bg-background">
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          data-overlay-backdrop
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <Sidebar
        user={user}
        onLogout={onLogout}
        mobileOpen={mobileOpen}
        isMobileViewport={isMobileViewport}
        onMobileClose={() => setMobileOpen(false)}
        sidebarRef={sidebarRef}
      />

      <div className="md:ml-64 min-h-screen">
        {/* Mobile top bar */}
        <div className="md:hidden flex items-center gap-3 px-4 py-3 bg-background-container-low border-b border-outline-variant/20 sticky top-0 z-20">
          <button
            onClick={() => setMobileOpen((o) => !o)}
            aria-controls="mobile-navigation"
            aria-expanded={mobileOpen}
            aria-label="Toggle navigation"
            className="p-1.5 rounded-lg text-on-surface-variant hover:bg-background-container-high hover:text-on-surface transition-colors"
          >
            <Menu size={20} />
          </button>
          <img src="/logo.png" alt="Hubarr" className="w-6 h-6 flex-shrink-0" />
          <span className="font-headline font-bold text-on-surface text-sm">Hubarr</span>
        </div>

        <Outlet />
      </div>
    </div>
  );
}

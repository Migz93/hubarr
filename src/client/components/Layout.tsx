import { useState } from "react";
import { Outlet } from "react-router-dom";
import { Menu } from "lucide-react";
import Sidebar from "./Sidebar";
import type { SessionUser } from "../../shared/types";

interface LayoutProps {
  user: SessionUser | null;
  onLogout: () => void;
}

export default function Layout({ user, onLogout }: LayoutProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <Sidebar
        user={user}
        onLogout={onLogout}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      <div className="md:ml-64 min-h-screen">
        {/* Mobile top bar */}
        <div className="md:hidden flex items-center gap-3 px-4 py-3 bg-surface-container-low border-b border-outline-variant/20 sticky top-0 z-20">
          <button
            onClick={() => setMobileOpen((o) => !o)}
            className="p-1.5 rounded-lg text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface transition-colors"
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

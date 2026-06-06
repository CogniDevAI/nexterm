// components/layout/AppLayout.tsx — Main application layout with sidebar + content

import { useEffect, useState, type ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";

interface AppLayoutProps {
  children: ReactNode;
  onConnect: (profileId: string, userId?: string) => void;
  onDisconnect: (sessionId: string) => void;
  onNewProfile: () => void;
  onEditProfile: (profileId: string) => void;
  connectingProfileId: string | null;
  connectError: string | null;
  onClearError: () => void;
  onStartTour?: () => void;
}

const SIDEBAR_COLLAPSED_STORAGE_KEY = "nexterm.sidebar.collapsed";

export function AppLayout({
  children,
  onConnect,
  onDisconnect,
  onNewProfile,
  onEditProfile,
  connectingProfileId,
  connectError,
  onClearError,
  onStartTour,
}: AppLayoutProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  });

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  return (
    <div className={`app-layout ${sidebarCollapsed ? "app-layout-sidebar-collapsed" : ""}`}>
      <Sidebar
        onConnect={onConnect}
        onDisconnect={onDisconnect}
        onNewProfile={onNewProfile}
        onEditProfile={onEditProfile}
        connectingProfileId={connectingProfileId}
        connectError={connectError}
        onClearError={onClearError}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((prev) => !prev)}
      />
      <main className="app-content">{children}</main>
      <StatusBar onStartTour={onStartTour} />
    </div>
  );
}

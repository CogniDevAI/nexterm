// components/layout/AppLayout.tsx — Main application layout with sidebar + content

import type { ReactNode } from "react";
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
  return (
    <div className="app-layout">
      <Sidebar
        onConnect={onConnect}
        onDisconnect={onDisconnect}
        onNewProfile={onNewProfile}
        onEditProfile={onEditProfile}
        connectingProfileId={connectingProfileId}
        connectError={connectError}
        onClearError={onClearError}
      />
      <main className="app-content">{children}</main>
      <StatusBar onStartTour={onStartTour} />
    </div>
  );
}

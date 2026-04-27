/**
 * Main Layout Component
 * When sidebar is expanded: Left-right split (Sidebar full height + Content area)
 * When sidebar is collapsed: Top-bottom split (Horizontal bar at top + Content area below)
 * macOS: drag region + native traffic lights live at the top of the Sidebar/bar.
 * Windows: drag region + custom window controls live at the top of the Sidebar/bar.
 */
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { useSettingsStore } from '@/stores/settings';

export function MainLayout() {
  const sidebarCollapsed = useSettingsStore((state) => state.sidebarCollapsed);

  if (sidebarCollapsed) {
    // Collapsed: horizontal top bar + content below
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-background">
        <Sidebar />
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    );
  }

  // Expanded: vertical sidebar + content side-by-side
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar />
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}

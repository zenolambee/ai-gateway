import {
  LayoutDashboard,
  KeyRound,
  Server,
  Boxes,
  Plug,
  Route,
  BarChart3,
  Gauge,
  Archive,
  Settings,
  ScrollText,
  Activity,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { label: 'API Keys', href: '/api-keys', icon: KeyRound },
  { label: 'Providers', href: '/providers', icon: Server },
  { label: 'Models', href: '/models', icon: Boxes },
  { label: 'Connections', href: '/connections', icon: Plug },
  { label: 'Routing', href: '/routing', icon: Route },
  { label: 'Usage & Analytics', href: '/usage', icon: BarChart3 },
  { label: 'Quota', href: '/quota', icon: Gauge },
  { label: 'Backups', href: '/backups', icon: Archive },
  { label: 'Settings', href: '/settings', icon: Settings },
  { label: 'Logs', href: '/logs', icon: ScrollText },
  { label: 'System Health', href: '/system-health', icon: Activity },
];

export const APP_VERSION = '1.0.0';

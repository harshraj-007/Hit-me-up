import { CalendarClock, History, type LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/** Primary navigation for the authenticated area. Phases add entries here. */
export const primaryNav: readonly NavItem[] = [
  { href: "/today", label: "Today", icon: CalendarClock },
  { href: "/history", label: "History", icon: History },
];

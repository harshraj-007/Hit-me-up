/**
 * Semantic → Tailwind class maps. Components look status/priority up here instead of
 * branching on raw strings inline, so the palette stays defined in one place (see the
 * matching CSS custom properties in src/app/globals.css).
 */
import type { TaskPriority, TaskStatus } from "@/features/dashboard/types";
import { AlertTriangle, Check, CircleDot, SkipForward, type LucideIcon } from "lucide-react";

export interface StatusStyle {
  label: string;
  icon: LucideIcon;
  text: string;
  soft: string;
  border: string;
}

export const statusStyles: Record<TaskStatus, StatusStyle> = {
  upcoming: {
    label: "Upcoming",
    icon: CircleDot,
    text: "text-status-upcoming",
    soft: "bg-transparent",
    border: "border-border",
  },
  current: {
    label: "Now",
    icon: CircleDot,
    text: "text-status-current",
    soft: "bg-status-current-soft",
    border: "border-status-current",
  },
  completed: {
    label: "Completed",
    icon: Check,
    text: "text-status-completed",
    soft: "bg-status-completed-soft",
    border: "border-status-completed",
  },
  late: {
    label: "Late",
    icon: AlertTriangle,
    text: "text-status-late",
    soft: "bg-status-late-soft",
    border: "border-status-late",
  },
  skipped: {
    label: "Skipped",
    icon: SkipForward,
    text: "text-status-skipped",
    soft: "bg-status-skipped-soft",
    border: "border-border",
  },
};

export interface PriorityStyle {
  label: string;
  text: string;
  soft: string;
  dot: string;
}

export const priorityStyles: Record<TaskPriority, PriorityStyle> = {
  high: {
    label: "High priority",
    text: "text-priority-high",
    soft: "bg-priority-high-soft",
    dot: "bg-priority-high",
  },
  medium: {
    label: "Medium priority",
    text: "text-priority-medium",
    soft: "bg-priority-medium-soft",
    dot: "bg-priority-medium",
  },
  low: {
    label: "Low priority",
    text: "text-priority-low",
    soft: "bg-priority-low-soft",
    dot: "bg-priority-low",
  },
};

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { AlertTriangle, CheckCircle2, Info, X, type LucideIcon } from "lucide-react";
import { pulseStatusIcon } from "@/lib/motion";

export type ToastTone = "neutral" | "success" | "error";

interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  durationMs?: number;
}

interface ToastRecord {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
  durationMs: number;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_ICON: Record<ToastTone, LucideIcon> = {
  neutral: Info,
  success: CheckCircle2,
  error: AlertTriangle,
};
const TONE_CLASS: Record<ToastTone, string> = {
  neutral: "text-foreground",
  success: "text-status-completed",
  error: "text-danger",
};
const DEFAULT_DURATION_MS = 4000;
const EXIT_ANIMATION_MS = 200;

const noopSubscribe = () => () => {};

/** True once mounted on the client — avoids an effect+setState just to gate a portal. */
function useMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/**
 * App-wide toast host. Mounted once in the root layout via `src/app/providers.tsx`.
 * Each toast is a `role="status"`/`role="alert"` live region; the icon gets a small
 * Anime.js pulse on entry (see pulseStatusIcon), the mount/unmount motion itself is CSS
 * (a single state toggle — see the ownership note in components/ui/dialog.tsx).
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const mounted = useMounted();

  const dismiss = useCallback((id: string) => {
    setLeaving((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      setLeaving((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, EXIT_ANIMATION_MS);
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    const id = crypto.randomUUID();
    const record: ToastRecord = {
      id,
      title: options.title,
      description: options.description,
      tone: options.tone ?? "neutral",
      durationMs: options.durationMs ?? DEFAULT_DURATION_MS,
    };
    setToasts((prev) => [...prev, record]);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {mounted
        ? createPortal(
            <div
              aria-live="polite"
              className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:bottom-6 sm:items-end sm:px-6"
            >
              {toasts.map((t) => (
                <ToastItem
                  key={t.id}
                  toast={t}
                  leaving={leaving.has(t.id)}
                  onDismiss={() => dismiss(t.id)}
                />
              ))}
            </div>,
            document.body,
          )
        : null}
    </ToastContext.Provider>
  );
}

function ToastItem({
  toast,
  leaving,
  onDismiss,
}: {
  toast: ToastRecord;
  leaving: boolean;
  onDismiss: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const iconRef = useRef<HTMLSpanElement>(null);
  const Icon = TONE_ICON[toast.tone];

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (visible) void pulseStatusIcon(iconRef.current);
  }, [visible]);

  useEffect(() => {
    const timer = setTimeout(onDismiss, toast.durationMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires once per toast lifetime
  }, []);

  return (
    <div
      data-toast
      data-state={visible && !leaving ? "visible" : "hidden"}
      role={toast.tone === "error" ? "alert" : "status"}
      className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-md border border-border bg-surface p-3 shadow-md sm:w-auto"
    >
      <span ref={iconRef} className={clsx("mt-0.5 inline-flex shrink-0", TONE_CLASS[toast.tone])}>
        <Icon aria-hidden className="size-4" />
      </span>
      <div className="flex-1 text-sm">
        <p className="font-medium">{toast.title}</p>
        {toast.description ? <p className="mt-0.5 text-muted">{toast.description}</p> : null}
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={onDismiss}
        className="text-muted transition-colors hover:text-foreground"
      >
        <X aria-hidden className="size-4" />
      </button>
    </div>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}

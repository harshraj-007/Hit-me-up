"use client";

import { ToastProvider } from "@/components/ui/toast-provider";

/** Client-only providers, kept out of the (server) root layout. */
export function Providers({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

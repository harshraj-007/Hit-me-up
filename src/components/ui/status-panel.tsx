import Link from "next/link";
import clsx from "clsx";

interface StatusPanelProps {
  title: string;
  description: string;
  tone?: "neutral" | "error";
  action?: { label: string; onClick: () => void } | { label: string; href: string };
  reference?: string;
}

const buttonClass =
  "inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-foreground";

/** Shared body for error / not-found screens. */
export function StatusPanel({
  title,
  description,
  tone = "neutral",
  action,
  reference,
}: StatusPanelProps) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className="mx-auto max-w-md py-16 text-center"
    >
      <h1 className={clsx("text-xl font-semibold", tone === "error" && "text-danger")}>{title}</h1>
      <p className="mt-2 text-sm text-muted">{description}</p>
      {reference ? <p className="mt-2 text-xs text-muted">Reference: {reference}</p> : null}
      {action ? (
        <div className="mt-6">
          {"href" in action ? (
            <Link href={action.href} className={buttonClass}>
              {action.label}
            </Link>
          ) : (
            <button type="button" onClick={action.onClick} className={buttonClass}>
              {action.label}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

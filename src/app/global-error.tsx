"use client";

// Replaces the root layout when it fails, so it must render its own <html>/<body>.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{ fontFamily: "system-ui, sans-serif", padding: "4rem 1rem", textAlign: "center" }}
      >
        <h1>Something went wrong</h1>
        <p>The application hit an unexpected error.</p>
        {error.digest ? <p>Reference: {error.digest}</p> : null}
        <button type="button" onClick={reset}>
          Try again
        </button>
      </body>
    </html>
  );
}

/**
 * What a screen shows when the API cannot be reached. Says what happened and
 * offers the one thing that might help — never a bare spinner that runs for ever.
 */
export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div role="alert" className="border-line bg-surface rounded-xl border px-4 py-5">
      <p className="text-ink">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="border-line-strong hover:bg-raised mt-3 min-h-11 rounded-lg border px-4 font-medium"
        >
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * <dialog showModal> does the work a component library would be installed for:
 * focus trap, Escape, backdrop, inert background.
 */
import { useEffect, useRef, type ReactNode } from "react";

export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-label={title}
      onClose={onClose}
      // A click that lands on the dialog element itself landed on the backdrop:
      // every piece of content is inside the padded wrapper below.
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="px-5 pt-5 pb-6">
        <div className="flex items-start justify-between gap-4 pb-4">
          <h2 className="text-section font-semibold tracking-[-0.01em]">{title}</h2>
          {/* Tapping the backdrop closes it too, but nothing on a phone says
              so. A visible control is the discoverable way out. */}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-ink hover:bg-raised -mt-1.5 -mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-lg transition-colors"
          >
            <svg
              viewBox="0 0 16 16"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

/**
 * THE PLATE — the problem statement, pasted in.
 *
 * This is the one place in the product that draws a box, and the exception is
 * deliberate. Everywhere else a thing is told apart from the canvas by a rule,
 * because everything else is type or ink on paper; an arbitrary screenshot has
 * its own white ground and its own edges, and without a frame it bleeds into
 * the page and reads as part of the interface. So it gets a 1px `tray` rule on
 * all four sides — the same weight as the drum's ruling, square like everything
 * else, and no radius and no shadow.
 *
 * Full size is a plain link to the image, opened in a new tab. The browser
 * already does zoom, pan, save and print better than a lightbox would, and a
 * hand-built one is a keyboard trap waiting to be written.
 */
import { useRef, useState } from "react";

import { screenshotUrl } from "./api";
import { formatBytes, usePastedImage } from "./problems";
import { useDeleteScreenshot, useSetScreenshot } from "./queries";
import { QUIET } from "../../components/form";
import type { Problem } from "../../types";

/** What the server will take, said once. */
const ACCEPT = "image/png,image/jpeg,image/webp";

/**
 * Refused here as well as at the API so the answer arrives before five
 * megabytes do, and as a sentence rather than as a 413.
 */
const LIMIT_BYTES = 5 * 1024 * 1024;
const tooBig = (file: File) => file.size > LIMIT_BYTES;

const OVERSIZE = `That image is over ${formatBytes(LIMIT_BYTES)}. Crop it, or save it as a JPEG.`;

/**
 * The empty frame: what you see before there is a screenshot, and the whole
 * discoverability of the paste gesture.
 *
 * Paste is the fast path and the file input is the one that works for everyone
 * — it is a real focusable control behind a styled label, not a decoration, so
 * the plate is reachable by keyboard and by a file picker on a phone.
 */
function Empty({
  onFile,
  busy,
  hint,
}: {
  onFile: (file: File) => void;
  busy: boolean;
  hint: string;
}) {
  const input = useRef<HTMLInputElement>(null);

  return (
    <div className="border-tray grid min-h-40 place-items-center border border-dashed px-4 py-8">
      <div className="text-center">
        <p className="label text-muted">{busy ? "Saving…" : hint}</p>
        <label className="mt-3 inline-block">
          <span className={`${QUIET} cursor-pointer`}>Choose an image</span>
          <input
            ref={input}
            type="file"
            accept={ACCEPT}
            disabled={busy}
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onFile(file);
              // Cleared so choosing the same file twice fires change twice —
              // which is exactly what happens after a failed upload.
              event.target.value = "";
            }}
          />
        </label>
      </div>
    </div>
  );
}

/**
 * The stored screenshot of a problem that already exists, uploaded the moment
 * it is picked or pasted.
 *
 * There is no "save the screenshot" step: the problem has an id, so the bytes
 * have somewhere to go, and a pending-but-unsaved image is a state that can
 * only be lost. `pasteEnabled` is false while a dialog is open over this pane,
 * so a paste has exactly one destination at a time.
 */
export function Screenshot({
  problem,
  pasteEnabled = true,
}: {
  problem: Problem;
  pasteEnabled?: boolean;
}) {
  const set = useSetScreenshot();
  const remove = useDeleteScreenshot();
  const [rejected, setRejected] = useState<string | null>(null);

  const upload = (file: File) => {
    if (tooBig(file)) {
      setRejected(OVERSIZE);
      return;
    }
    setRejected(null);
    set.mutate({ id: problem.id, file });
  };

  usePastedImage(upload, pasteEnabled);

  const busy = set.isPending || remove.isPending;
  const error = rejected ?? (set.error as Error | null)?.message ?? null;

  return (
    <div>
      {problem.screenshot_bytes === null ? (
        <Empty onFile={upload} busy={busy} hint="Paste a screenshot with Ctrl+V" />
      ) : (
        <>
          <a
            href={screenshotUrl(problem.id)}
            target="_blank"
            rel="noreferrer"
            className="border-tray hover:border-baseline focus-visible:outline-ink block border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            <img
              /*
               * Keyed on the row's own updated_at because the URL does not
               * change when a screenshot is replaced. Without it the element
               * keeps the image it already decoded and a replacement looks like
               * an upload that silently failed.
               */
              key={problem.updated_at}
              src={screenshotUrl(problem.id)}
              alt={`Problem statement for ${problem.number === null ? problem.title : `#${problem.number} ${problem.title}`}`}
              className="block w-full"
            />
          </a>

          <div className="mt-2 flex flex-wrap items-center gap-x-4">
            <p className="label text-muted">
              {busy ? "Saving…" : `${formatBytes(problem.screenshot_bytes)} · opens full size`}
            </p>
            <span className="flex-1" />
            <label className="shrink-0">
              <span className={`${QUIET} cursor-pointer`}>Replace</span>
              <input
                type="file"
                accept={ACCEPT}
                disabled={busy}
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) upload(file);
                  event.target.value = "";
                }}
              />
            </label>
            <button
              type="button"
              className={QUIET}
              disabled={busy}
              onClick={() => {
                setRejected(null);
                remove.mutate(problem.id);
              }}
            >
              Remove
            </button>
          </div>
        </>
      )}

      {error && (
        <p role="alert" className="text-warn text-meta mt-2">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The same job for a problem that does not exist yet.
 *
 * The editor holds the file and the caller uploads it after the problem is
 * created, because there is no id to upload it to until then. The preview is a
 * data: URL rather than an object URL on purpose — helmet's default CSP allows
 * `img-src 'self' data:` and does not allow `blob:`, so the obvious
 * URL.createObjectURL version would render nothing, silently, with no console
 * error to find.
 */
export function ScreenshotPicker({
  file,
  onFile,
  onClear,
  pasteEnabled = true,
}: {
  file: File | null;
  onFile: (file: File) => void;
  onClear: () => void;
  pasteEnabled?: boolean;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);

  const take = (candidate: File) => {
    if (tooBig(candidate)) {
      setRejected(OVERSIZE);
      return;
    }
    setRejected(null);
    onFile(candidate);

    const reader = new FileReader();
    reader.onload = () => setPreview(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(candidate);
  };

  usePastedImage(take, pasteEnabled);

  return (
    <div>
      {file === null || preview === null ? (
        <Empty onFile={take} busy={false} hint="Paste the problem statement with Ctrl+V" />
      ) : (
        <>
          <div className="border-tray border">
            <img src={preview} alt={`Chosen screenshot: ${file.name}`} className="block w-full" />
          </div>
          <div className="mt-2 flex items-center gap-x-4">
            <p className="label text-muted flex-1 truncate">
              {formatBytes(file.size)} · saves with the problem
            </p>
            <button
              type="button"
              className={QUIET}
              onClick={() => {
                onClear();
                setPreview(null);
                setRejected(null);
              }}
            >
              Remove
            </button>
          </div>
        </>
      )}

      {rejected && (
        <p role="alert" className="text-warn text-meta mt-2">
          {rejected}
        </p>
      )}
    </div>
  );
}

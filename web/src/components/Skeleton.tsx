/** A placeholder shaped like the content it replaces, so nothing jumps. */
export const Skeleton = ({ className = "" }: { className?: string }) => (
  <div className={`bg-raised animate-pulse rounded ${className}`} aria-hidden="true" />
);

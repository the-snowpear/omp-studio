import { useRef, type HTMLAttributes, type ReactNode, type RefObject, type UIEvent } from "react";

export const TOOL_CARD_FOLLOW_THRESHOLD_PX = 24;

export function useToolCardFollowScroll(_follow: boolean): {
  ref: RefObject<HTMLDivElement | null>;
  onScroll: (event: UIEvent<HTMLDivElement>) => void;
} {
  const ref = useRef<HTMLDivElement>(null);
  return {
    ref,
    onScroll: () => {},
  };
}

export function ToolCardScroll({
  follow,
  className,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, "onScroll"> & {
  follow: boolean;
  children: ReactNode;
}) {
  const { ref, onScroll } = useToolCardFollowScroll(follow);
  const classes = follow ? (className ? `${className} is-live` : "is-live") : className;
  return (
    <div
      {...rest}
      ref={ref}
      className={classes}
      {...(follow ? { "data-live": "tail" } : {})}
      onScroll={onScroll}
    >
      {children}
    </div>
  );
}

// --- Deleted: tool card follow-scroll implementation ---

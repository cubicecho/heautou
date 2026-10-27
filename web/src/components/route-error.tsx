import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { CircleAlert } from "@/components/ui/icons";
import type { SlotNode } from "@/lib/utils";

type RouteErrorProps = {
  error: unknown;
  reset: () => void;
  /**
   * Turns a thrown value into a line worth reading. The default recognises the
   * two failures every networked app has; extend it with the ones yours has
   * rather than letting a stack-trace message reach the screen.
   */
  describe?: (error: unknown) => string;
  /**
   * The heading. The default fits a failed fetch and a render crash alike,
   * which is why it is not "Failed to load" — a boundary catches both.
   */
  title?: string;
  /**
   * The raw message, in a muted monospace block the user can select and paste
   * into a bug report. `true` shows `error.message`; a node replaces the block's
   * contents. Left out when it would say exactly what `describe` already said.
   * Selectable on device too (`selectable`), where text is not by default. The
   * block is bordered rather than filled: muted text on `bg-foreground/10` fails contrast.
   */
  details?: ReactNode | boolean;
  /** More buttons beside "Try again" — a reload is the usual one. */
  actionsSlot?: SlotNode;
};

function friendlyMessage(error: unknown): string {
  if (error instanceof Error) {
    if (
      error.message.includes("Failed to fetch") ||
      error.message.includes("NetworkError") ||
      error.message.includes("network")
    ) {
      return "Could not reach the server. Check your connection and try again.";
    }
    if (error.message.includes("Not authenticated")) {
      return "Your session has expired. Please sign in again.";
    }
    return error.message;
  }
  return "An unexpected error occurred.";
}

/** What `details={true}` shows: the message as thrown, for whoever files the bug. */
function rawMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message || undefined;
  }
  if (typeof error === "string") {
    return error || undefined;
  }
  return undefined;
}

/** The whole-screen message shown when the tree below a route has thrown. */
export function RouteError({
  error,
  reset,
  describe = friendlyMessage,
  title = "Something went wrong",
  details,
  actionsSlot,
}: RouteErrorProps) {
  const summary = describe(error);
  const detail = details === true ? rawMessage(error) : details || undefined;
  // A plain `Error` is described by its own message, so the default block would print it twice.
  const shown = detail === summary ? undefined : detail;

  return (
    <div
      role="alert"
      data-slot="route-error"
      className="cube-rn-view flex-1 items-center justify-center gap-4 px-8 py-20"
    >
      <div className="cube-rn-view rounded-full bg-negative/10 p-4">
        <CircleAlert className="h-7 w-7 text-negative" />
      </div>
      {/* One width for the text and the details under it, not two centred columns. The title is
          the screen's heading: `role`/`aria-level` because an `<h1>` has no native counterpart. */}
      <div className="cube-rn-view max-w-md items-center">
        <h1 data-slot="route-error-title" className="cube-rn-text font-semibold text-foreground">
          {title}
        </h1>
        <span className="cube-rn-text mt-1 text-center text-sm text-foreground/60">{summary}</span>
      </div>
      {shown ? (
        <div
          data-slot="route-error-details"
          className="cube-rn-view w-full max-w-md rounded-md border border-foreground/10 px-3 py-2"
        >
          {typeof shown === "string" ? (
            <span className="cube-rn-text font-mono text-xs text-foreground/60">{shown}</span>
          ) : (
            shown
          )}
        </div>
      ) : null}
      <div className="cube-rn-view flex-row flex-wrap items-center justify-center gap-2">
        <Button variant="outline" size="sm" onClick={reset} content="Try again" />
        {actionsSlot}
      </div>
    </div>
  );
}

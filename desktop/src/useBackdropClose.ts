// useBackdropClose — modal close handler that distinguishes a real backdrop
// click from a drag that STARTED inside the content and released on the
// backdrop. Recurring frustration was: type into HostDialog → mouse slips
// onto the dark overlay when releasing → modal closes, half-typed password
// wiped. The fix tracks mousedown — only close when both mousedown and
// click happened on the backdrop element.

import { useEffect, useRef } from "react";

interface BackdropProps {
  onMouseDown: (e: React.MouseEvent) => void;
  onClick: (e: React.MouseEvent) => void;
}

interface ContentStopProps {
  onMouseDown: (e: React.MouseEvent) => void;
  onClick: (e: React.MouseEvent) => void;
}

/**
 * Returns:
 *   backdropProps — spread onto the dimmed outer div
 *   contentProps  — spread onto the inner content (form/panel) so its
 *                   own clicks never reach the backdrop logic
 *
 * Also wires Escape to call onClose.
 */
export function useBackdropClose(onClose: () => void): {
  backdropProps: BackdropProps;
  contentProps: ContentStopProps;
} {
  const mouseDownOnBackdrop = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return {
    backdropProps: {
      onMouseDown: (e) => {
        mouseDownOnBackdrop.current = e.target === e.currentTarget;
      },
      onClick: (e) => {
        if (e.target === e.currentTarget && mouseDownOnBackdrop.current) {
          onClose();
        }
        mouseDownOnBackdrop.current = false;
      },
    },
    contentProps: {
      onMouseDown: (e) => e.stopPropagation(),
      onClick: (e) => e.stopPropagation(),
    },
  };
}

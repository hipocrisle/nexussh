// Resize affordances for the borderless window (decorations:false removes the
// native resize border + cursors, so the user can't tell the window is
// resizable and gets no edge cursor). We overlay thin transparent zones along
// the 4 edges + 4 corners that show the right resize cursor on hover and start
// a native resize drag (Tauri's startResizeDragging) on mousedown. Purely
// additive — invisible, only the very window border, won't block content.

import { getCurrentWindow } from "@tauri-apps/api/window";

// ResizeDirection is a string union in @tauri-apps/api; literals are assignable.
type Dir =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

function start(dir: Dir, e: React.MouseEvent) {
  if (e.button !== 0) return; // left button only
  e.preventDefault();
  getCurrentWindow()
    .startResizeDragging(dir)
    .catch(() => {});
}

const EDGE = 5; // px thickness of edge strips
const CORNER = 10; // px size of corner squares (sit above edges)

export function ResizeHandles() {
  const base: React.CSSProperties = { position: "fixed", zIndex: 9999 };
  return (
    <>
      {/* Edges */}
      <div
        style={{ ...base, top: 0, left: CORNER, right: CORNER, height: EDGE, cursor: "ns-resize" }}
        onMouseDown={(e) => start("North", e)}
      />
      <div
        style={{ ...base, bottom: 0, left: CORNER, right: CORNER, height: EDGE, cursor: "ns-resize" }}
        onMouseDown={(e) => start("South", e)}
      />
      <div
        style={{ ...base, left: 0, top: CORNER, bottom: CORNER, width: EDGE, cursor: "ew-resize" }}
        onMouseDown={(e) => start("West", e)}
      />
      <div
        style={{ ...base, right: 0, top: CORNER, bottom: CORNER, width: EDGE, cursor: "ew-resize" }}
        onMouseDown={(e) => start("East", e)}
      />
      {/* Corners */}
      <div
        style={{ ...base, top: 0, left: 0, width: CORNER, height: CORNER, cursor: "nwse-resize" }}
        onMouseDown={(e) => start("NorthWest", e)}
      />
      <div
        style={{ ...base, top: 0, right: 0, width: CORNER, height: CORNER, cursor: "nesw-resize" }}
        onMouseDown={(e) => start("NorthEast", e)}
      />
      <div
        style={{ ...base, bottom: 0, left: 0, width: CORNER, height: CORNER, cursor: "nesw-resize" }}
        onMouseDown={(e) => start("SouthWest", e)}
      />
      <div
        style={{ ...base, bottom: 0, right: 0, width: CORNER, height: CORNER, cursor: "nwse-resize" }}
        onMouseDown={(e) => start("SouthEast", e)}
      />
    </>
  );
}

/** Small side-on outlines of each thing the page counts, drawn as paths in the
 * same line weight as the source tabs. A colour swatch alone would ask the
 * reader to learn a legend; a car shape beside "Car" does not. */

const SVG_NS = "http://www.w3.org/2000/svg";

interface Icon {
  readonly strokes: readonly string[];
  readonly wheels: readonly (readonly [number, number, number])[];
}

const ICONS: Readonly<Record<string, Icon>> = {
  car: {
    strokes: [
      "M3 11.6V9.4c0-.7.5-1.2 1.2-1.3l3.5-.6 2.6-3c.4-.5 1-.7 1.6-.7h5.6c.6 0 1.2.3 1.6.7l2.4 3 2.6.5c.7.1 1.2.7 1.2 1.4v2.2",
      "M10.6 11.8h6.8",
    ],
    wheels: [
      [8.5, 11.8, 2],
      [19.5, 11.8, 2],
    ],
  },
  truck: {
    strokes: ["M2 3.6h14.4v8.2H2z", "M16.4 6.2h4.1l3.5 3.3v2.3h-7.6"],
    wheels: [
      [5.6, 12.4, 1.7],
      [10.2, 12.4, 1.7],
      [21, 12.4, 1.7],
    ],
  },
  bus: {
    strokes: ["M3.6 3h19.6c1 0 1.8.8 1.8 1.8v7H2V4.6C2 3.7 2.7 3 3.6 3z", "M4.6 6.6h18"],
    wheels: [
      [7, 12.2, 1.8],
      [20, 12.2, 1.8],
    ],
  },
  motorcycle: {
    strokes: ["M6 11.4 10.6 6.6h6l2.6 2.6h3", "M18.2 6.6l1.6-2.4h2.2"],
    wheels: [
      [6, 11.4, 2.7],
      [22, 11.4, 2.7],
    ],
  },
  person: {
    strokes: ["M14 6v5", "M10.8 8.2h6.4", "M14 11l-2.6 4", "M14 11l2.6 4"],
    wheels: [[14, 3.4, 1.8]],
  },
  bicycle: {
    strokes: ["M7 11.2 11.4 5.2h6.4l3.2 6", "M11.4 5.2l3.4 6H7", "M17.8 5.2l-1.1-2h-2.1"],
    wheels: [
      [7, 11.2, 3],
      [21, 11.2, 3],
    ],
  },
};

/** The outline for a vehicle type, or null for a type with none. */
export function vehicleIcon(type: string): SVGSVGElement | null {
  const icon = ICONS[type];
  if (icon === undefined) {
    return null;
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 28 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "vehicle-icon");
  for (const d of icon.strokes) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  for (const [cx, cy, r] of icon.wheels) {
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", String(cx));
    circle.setAttribute("cy", String(cy));
    circle.setAttribute("r", String(r));
    svg.append(circle);
  }
  return svg;
}

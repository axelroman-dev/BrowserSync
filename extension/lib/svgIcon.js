// Inline SVG icons from this extension's own constant path markup (the
// ICONS maps in popup/passwordsTab.js and lib/generatorPanel.js), parsed as
// SVG and imported node by node rather than assigned through innerHTML - so
// there's no HTML sink at all, and AMO's linter has nothing to flag.
const SVG_NS = "http://www.w3.org/2000/svg";

/** A 24x24, aria-hidden <svg> holding `markup` (e.g. '<path d="…"/>'). */
export function svgFromMarkup(markup) {
  const parsed = new DOMParser().parseFromString(`<svg xmlns="${SVG_NS}">${markup}</svg>`, "image/svg+xml");
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.append(...[...parsed.documentElement.childNodes].map((node) => document.importNode(node, true)));
  return svg;
}

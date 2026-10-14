/**
 * Series colours of the metric charts, from the palette in index.css (uPlot draws on a canvas, which does not
 * resolve `var()`): grass, amethyst, torch and diamond, with a muted dashed guide for totals and limits.
 */
export const CHART_COLORS = {
  cpu: "#72c04e",
  memory: "#ac8fe3",
  disk: "#f2b544",
  players: "#5fc8d6",
  tps: "#f2b544",
  guide: "#6b737d",
} as const;

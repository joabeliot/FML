// Tile icons for roadmaps (FML-28): `icon: <name>` on an RML node. 16×16
// stroke paths in the same style as the flow glyphs (nodeStyle.ts). A value
// that isn't a name here (an emoji, a letter) is drawn as text instead.

export const RML_GLYPHS: Record<string, string> = {
  flag: "M4 14V2.5 M4 3h7.5l-1.5 2.5 1.5 2.5H4",
  star: "M8 2l1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5z",
  bolt: "M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z",
  gear: "M8 5.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5 M8 1.5v2 M8 12.5v2 M1.5 8h2 M12.5 8h2 M3.4 3.4l1.4 1.4 M11.2 11.2l1.4 1.4 M3.4 12.6l1.4-1.4 M11.2 4.8l1.4-1.4",
  shield: "M8 1.5l5 2v4c0 3.2-2.2 5.6-5 7-2.8-1.4-5-3.8-5-7v-4z",
  key: "M5.5 13.5a3 3 0 1 1 0-6a3 3 0 1 1 0 6 M7.6 8.4L13.5 2.5 M11 5l1.8 1.8 M9.5 6.5l1.2 1.2",
  link: "M6.5 9.5l3-3 M5.5 7.5L4 9a2.5 2.5 0 0 0 3.5 3.5L9 11 M10.5 8.5L12 7a2.5 2.5 0 0 0-3.5-3.5L7 5",
  eye: "M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z M8 6a2 2 0 1 0 0 4a2 2 0 1 0 0-4",
  chart: "M2.5 13.5h11 M4.5 11V8 M7.5 11V4.5 M10.5 11V6.5",
  map: "M1.5 4l4-1.5 5 1.5 4-1.5v9.5l-4 1.5-5-1.5-4 1.5z M5.5 2.5V12 M10.5 4v9.5",
  book: "M2.5 3h4A1.5 1.5 0 0 1 8 4.5V13a1 1 0 0 0-1-1H2.5z M13.5 3h-4A1.5 1.5 0 0 0 8 4.5V13a1 1 0 0 1 1-1h4.5z",
  bug: "M5.5 6a2.5 2.5 0 0 1 5 0v4a2.5 2.5 0 0 1-5 0z M8 6v6.5 M5.5 8h-3 M13.5 8h-3 M5.5 11L3 12.5 M10.5 11l2.5 1.5 M6 4L4.5 2.5 M10 4l1.5-1.5",
  rocket: "M8 1.5c2.5 2 3.5 4.5 3 7.5l-1.5 2h-3L5 9c-.5-3 .5-5.5 3-7.5z M8 6v.01 M6.5 11L5 14 M9.5 11l1.5 3",
  cube: "M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7z M2.5 4.5L8 7.5l5.5-3 M8 7.5v7",
  code: "M5.5 4.5L2 8l3.5 3.5 M10.5 4.5L14 8l-3.5 3.5",
  play: "M5 3l8 5-8 5z",
  check: "M3 8.5l3 3 7-7",
  layers: "M8 2l6 3-6 3-6-3z M2 8l6 3 6-3 M2 11l6 3 6-3",
  hammer: "M9.5 2.5l4 4-1.5 1.5-4-4z M8.8 5.2L2.5 11.5l2 2 6.3-6.3",
  flask: "M6 1.5h4 M6.5 1.5v4L2.5 13a1 1 0 0 0 .9 1.5h9.2a1 1 0 0 0 .9-1.5l-4-7.5v-4 M4.5 10h7",
};

export const RML_GLYPH_NAMES = Object.keys(RML_GLYPHS);

/** Defaults when a node names no icon: features vary by id, milestones are flags. */
const FEATURE_DEFAULTS = ["code", "gear", "bolt", "link", "chart", "eye", "cube", "layers", "hammer", "flask", "book", "key"];

export function iconFor(id: string, type: string, icon: string | undefined): { path?: string; text?: string } {
  const named = icon?.trim();
  if (named) return RML_GLYPHS[named] ? { path: RML_GLYPHS[named] } : { text: [...named].slice(0, 2).join("") };
  if (type === "milestone") return { path: RML_GLYPHS.flag };
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { path: RML_GLYPHS[FEATURE_DEFAULTS[h % FEATURE_DEFAULTS.length]!] };
}

export type ObservationRect = { left: number; top: number; right: number; bottom: number };
export type ObservationStyle = { getPropertyValue(name: string): string } | Record<string, string | undefined>;
export type ObservationPrimitives = {
  version: 2;
  maskStatus(style: ObservationStyle, box: ObservationRect, rects: readonly ObservationRect[]): "opaque" | "transparent" | "unknown";
  clipStatus(style: ObservationStyle, box: ObservationRect, rects: readonly ObservationRect[]): "opaque" | "transparent" | "unknown";
  clipIsEmpty(style: ObservationStyle, box: ObservationRect): boolean;
  effectCoverage(style: ObservationStyle, box: ObservationRect, rects: readonly ObservationRect[]): "complete" | "empty" | "unknown";
  neutralGeometry(style: ObservationStyle): boolean;
  /** Fresh local flow evidence; this does not certify ordinary overflow/paint. */
  textFlowCoverage(text: Node, styleFor?: (element: Element) => ObservationStyle, composedParent?: (node: Node) => Element | null): { coverage: "complete" | "unknown"; clipInputs: string[] };
};
export function snapshotObservationPrimitives<Install extends boolean = false>(install?: Install): Install extends true ? 2 : ObservationPrimitives;

import { SNAPSHOT_CANDIDATE_CONTEXT, semanticContexts, automaticContexts, type CandidateAssociation } from "./candidate-context";
import { RENDERED_TEXT_READER_SOURCE, RENDERED_TEXT_SOURCE } from "./rendered-text";
import { MARKER_STYLES, markerCaptureEvidence, prepareMarkerQuery, measureMarkerInk } from "./rendered-marker";
import type { EventLogger } from "../logging";
import { ElementIds } from "./element-ids";
import { resolveSampledElement } from "./sampled-element";
import { safeDiagnosticError } from "../diagnostic-error";
import { createLogGraphCodec, decodeLogGraph, encodeLogGraph } from "../log-graph";
import { waitForDocumentFrame } from "./dom-frame";
import { abortError, axValue, delay, imageSize, isTransientNavigationError, keyboardParams, modifierMask, parseKeyboardChord, throwIfAborted } from "./automation-utils";
import { diffSnapshot, paginateSnapshot, type SnapshotItem, type SnapshotPosition } from "./snapshot-pagination";
import { snapshotLookahead } from "./snapshot-lookahead";
import { selectSnapshotWirePage, SnapshotWireError, SNAPSHOT_DELIVERY_COMMIT, type SnapshotDeliveryLease, type SnapshotWirePage } from "./snapshot-wire";
import { renderSnapshotNode, type SnapshotNode, type SnapshotStateName } from "./snapshot-render";
import { snapshotBounds } from "./snapshot-layout";
import { compactSnapshot } from "./snapshot-presentation";
import { expandSnapshot, packSnapshot, projectSnapshotLine } from "./snapshot-repeat";
import { stitchSnapshotFrames, type SnapshotLine } from "./snapshot-frame-tree";
import { snapshotDomSupplement, type SnapshotDomEvidence } from "./snapshot-dom";
import { normalizeSnapshotText } from "./snapshot-preformatted";
import { createSnapshotDomIndex } from "./snapshot-dom-index";
import { snapshotRenderOrder } from "./snapshot-render-order";
import { snapshotSlottedNodes } from "./snapshot-slot-index";
import { sampleReadableSnapshot, readableSnapshot } from "./snapshot-readable";
import { snapshotObservationPrimitives } from "./snapshot-observation-primitives.js";
import { nativeControlCandidates, NATIVE_OBSERVATION_SOURCE, type NativeControlCandidates } from "./snapshot-native-runtime";
import { changedTextNodes, hasUnrenderedHeadSourceChange, sameDOMSnapshot } from "./snapshot-consistency";
import { SNAPSHOT_COMPUTED_STYLES, snapshotVisibility, type SnapshotClip, type SnapshotFrameOwner, type SnapshotTextPaintCandidate } from "./snapshot-visibility";
import { projectTextPaint, sameTextPaintCandidates, TEXT_PAINT_CACHE_LOOKUP_SOURCE, TEXT_PAINT_CACHE_REGISTER_SOURCE, type TextPaintEvidence } from "./snapshot-text-paint";
import { axEllipsisCandidate, confirmAxEllipsis, type AxEllipsisCandidate } from "./snapshot-ax-ellipsis";
import { AX_ELLIPSIS_GEOMETRY_SOURCE } from "./snapshot-ellipsis-geometry";
import { SNAPSHOT_FRAME_PAINT_SOURCE, RENDERED_FRAME_PAINT_SOURCE, FRAME_OWNER_VISIBILITY_SOURCE } from "./snapshot-frame-paint";
import { SNAPSHOT_CONTROL_PAINT_SOURCE } from "./snapshot-control-paint";
import { PLACEHOLDER_EVIDENCE_SOURCE, samePlaceholderEvidence, type PlaceholderEvidence } from "./snapshot-placeholder";
import { FRAME_OWNER_FULLY_VISIBLE_SOURCE } from "./snapshot-frame-containment";
import { createFrameHandle } from "./snapshot-frame-handle";
import { createFrameVisibility } from "./frame-visibility";
import { PROGRAM_EVENT_INVOKE } from "./program-handles";
import { scheduleDeadline } from "../deadline";

const EVALUATION_CODEC_FACTORY = `(${createLogGraphCodec.toString()})({ verifyIntrinsics: true })`;

type Debuggee = chrome.debugger.Debuggee & { sessionId?: string };
type Command = (debuggee: Debuggee, method: string, params?: object) => Promise<any>;
type RunContext = { signal?: AbortSignal; deadlineAt?: number; conversationId?: string; runId?: string; toolCallId?: string; logIdentity?: { runId?: string; toolCallId: string; toolCallIdCanonical: true } };
type Waiter = { resolve: (value: any) => void; reject: (error: Error) => void };
type FileChooserRecord = { backendNodeId: number; debuggee: Debuggee; mode: string; frameId?: string };
type FileChooserClaim = { assert: () => void; finish: (outcome: "handled" | "not-dispatched" | "uncertain") => void };
function eventWithDispatch<T extends object>(event: T, invoke: (operation: string, args: unknown[], dispatch: () => Promise<void>) => unknown): T {
  Object.defineProperty(event, PROGRAM_EVENT_INVOKE, { value: invoke });
  return event;
}
type Query = {
  kind: "role" | "text" | "label" | "placeholder" | "alt" | "title" | "testId" | "css" | "frame" | "frameRef" | "filter" | "index" | "uniqueScope";
  value: string;
  name?: string;
  exact?: boolean;
  hasText?: string;
  has?: LocatorSpec;
  index?: number;
};
type LocatorSpec = { queries: Query[]; index?: number; ref?: string; hasText?: string; has?: LocatorSpec };
type WaitState = "attached" | "detached" | "visible" | "hidden" | "enabled" | "editable" | "checked";
type RefRecord = { backendNodeId: number; frameId?: string; debuggee: Debuggee; role: string; name: string; generation: number; identitySource: "ax" | "dom"; conversationId?: string; runId?: string; aliases?: Set<string> };
type FrameRefRecord = { frameId: string; debuggee: Debuggee; generation: number; revision: number; conversationId?: string; runId?: string };
type FrameDocument = { session: Session; frame: FrameRefRecord; promise: Promise<string>; objectId?: string; executionContextId?: number;
  shadowRevision?: number; paintCacheToken: string; paintCacheWarm?: boolean; paintCacheTail?: Promise<void>; backendNodeId?: number };
type FrameListSnapshot = { id: string; session: Session; generation: number; revision: number; conversationId?: string; runId?: string; frames: Array<Record<string, unknown>> };
type InspectSnapshot = {
  id: string; session: Session; generation: number; frameRevision: number; conversationId?: string; runId?: string;
  contextFor: (wireId: string) => Record<string, unknown>;
  record: ObservationRecord; source: SnapshotItem[]; mode: "full" | "delta"; reset?: string;
  expected?: SnapshotPosition; eligibleForBaseline: boolean; baseObservationId?: string; delivery?: symbol;
  geometry: string; geometrySources: Debuggee[]; geometryStyles: readonly string[]; geometryDynamicParents?: Map<string, Set<number>>;
};

function dynamicTextNodes(snapshot: any, parents: ReadonlySet<number> | undefined): Set<number> {
  const result = new Set<number>();
  if (!parents) return result;
  for (const doc of snapshot.documents ?? []) {
    const ids = doc.nodes?.backendNodeId, ancestry = doc.nodes?.parentIndex, types = doc.nodes?.nodeType;
    if (!Array.isArray(ids) || !Array.isArray(ancestry) || !Array.isArray(types) || ids.length !== ancestry.length || ids.length !== types.length)
      throw automationError("snapshot-unavailable", { reason: "invalid-dynamic-text-tree" });
    const tainted = new Uint8Array(ids.length);
    for (let i = 0; i < ids.length; i++) {
      const parent = ancestry[i];
      if (!Number.isSafeInteger(parent) || parent >= i || parent < -1) throw automationError("snapshot-unavailable", { reason: "invalid-dynamic-text-tree" });
      if (parents.has(ids[i]) || parent >= 0 && tainted[parent]) tainted[i] = 1;
      if (tainted[i] && types[i] === 3) result.add(ids[i]);
    }
  }
  return result;
}

/** A continuation may reuse frozen rows only while their capture geometry is current. */
export async function snapshotGeometry(layouts: Array<{ debuggee: Debuggee; snapshot: any }>, dynamicParents?: ReadonlyMap<string, ReadonlySet<number>>): Promise<string> {
  const data = layouts.map(({ debuggee, snapshot }) => [debuggee.sessionId ?? "", (snapshot.documents ?? []).map((doc: any) => [
    snapshot.strings?.[doc.frameId], doc.scrollOffsetX, doc.scrollOffsetY, doc.nodes?.backendNodeId?.map((id: number, index: number) => {
      const parents = dynamicParents?.get(debuggee.sessionId ?? ""), parent = doc.nodes?.parentIndex?.[index];
      return parents && doc.nodes?.nodeType?.[index] === 3 && Number.isSafeInteger(parent) && parent >= 0
        && parents.has(doc.nodes.backendNodeId[parent]) ? null : id;
    }), doc.nodes?.parentIndex,
    doc.layout?.nodeIndex, doc.layout?.bounds, doc.layout?.clientRects, doc.layout?.offsetRects, doc.layout?.scrollRects,
    doc.layout?.styles?.map((style: number[]) => style.map((index) => snapshot.strings?.[index])), doc.layout?.paintOrders, doc.textBoxes?.bounds,
  ])]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(data)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export type FindOptions = { cursor?: string; limit?: number };
type SearchSnapshot = {
  id: string; tabId: number; generation: number; session: Session; key: string;
  frameId?: string;
  conversationId?: string; runId?: string; debuggee: Debuggee; total: number;
  candidates?: Candidate[]; arrayId?: string; group?: string;
};
export type InspectOptions = { full?: boolean; incremental?: boolean; cursor?: string; since?: string; fields?: Array<"text" | "state" | "ref" | "actions">; budget?: number; offset?: number; limit?: number; depth?: number; recentRefs?: readonly string[]; wire?: { maxBytes: number; evidenceId: string }; deferDelivery?: boolean };
type ObservationRecord = {
  session: Session;
  observationId: string;
  tabId: number;
  documentId: number;
  frameRevision?: number;
  url: string;
  title: string;
  lines: SnapshotLine[];
  /** Structured inspect projection used as a delta baseline. */
  wireItems?: SnapshotItem[];
  viewport: { x: number; y: number; width: number; height: number; scale: number };
  image?: { width: number; height: number; scale: number; origin?: { x: number; y: number } };
  scopeKey?: string;
  regionIdentity?: string;
  incomplete?: boolean;
  partial?: true;
  readOnly?: true;
  limitations?: string;
  visual?: true;
};
type IsolatedFrameRead = { objectId: string; executionContextId: number; frameId: string; guard: () => void };
type AccessibilityRead = { world: IsolatedFrameRead; documentBackend: number; documentId: string; nodes: Map<string, any>; backends: Map<number, any[]> };
type ObservationContext = { id: number; uniqueId: string; frameId: string; candidate: boolean };
type RootReadScope = { frameId: string; loaderId?: string; revision: number; context?: ObservationContext; signal?: AbortSignal };
type Session = {
  tabId: number;
  token: string;
  lifetime: AbortController;
  debuggee: Debuggee;
  ready?: Promise<void>;
  generation: number;
  nextRef: number;
  nextSnapshotScope: number;
  snapshotScopes: Map<string, string>;
  refs: Map<string, RefRecord>;
  refsByNode: Map<string, string>;
  refUsage: Map<string, string>;
  frames: Map<string, Debuggee>;
  frameReady: Map<string, Promise<void>>;
  frameParents: Map<string, string | undefined>;
  frameLoaders: Map<string, string>;
  targetParents: Map<string, string | undefined>;
  targetSessions: Map<string, string>;
  retiredTargetSessions: Set<string>;
  frameRevision: number;
  frameRefs: Map<string, FrameRefRecord>;
  frameRefsById: Map<string, string>;
  lifecycleCutoff?: number;
  rootLifecycle?: { frameId: string; loaderId: string; initializedAt: number; domContentLoaded: boolean; load: boolean };
  rootFrameId?: string;
  lastSnapshot?: SnapshotLine[];
  snapshotStyleProfile?: { generation: number; computedStyles: readonly string[] };
  rootDocumentRevision: number;
  observationPrimitives?: RootReadScope & { ready: Promise<void> };
  observationContexts: Map<number, ObservationContext>;
  nativeControlCandidates?: NativeControlCandidates & { frameId: string; loaderId?: string };
};

type Candidate = { role: string; name: string; tag?: string; text?: string; ref?: string; backendNodeId?: number; debuggee?: Debuggee; roleTruncated?: boolean; nameTruncated?: boolean; identityUnavailable?: boolean };
type LocatedNode = { objectId: string; backendNodeId: number; role?: string; name?: string; executionContextId?: number };
type ElementState = {
  x: number;
  y: number;
  width?: number;
  height?: number;
  visible: boolean;
  stable: boolean;
  enabled: boolean;
  editable: boolean;
  editKind?: string;
  receivesEvents: boolean;
  checked: boolean | null;
  connected: boolean;
  quad?: number[];
  blocker?: Record<string, unknown>;
  pointerCandidates?: Array<{ x: number; y: number }>;
  frameId?: string;
};

/** Map a normalized point into a CSS content quad, including perspective. */
function projectQuad(quad: number[], u: number, v: number): { x: number; y: number } {
  if (quad.length !== 8 || quad.some((value) => !Number.isFinite(value))) throw automationError("frame-unavailable", { reason: "invalid-quad" });
  const [x0, y0, x1, y1, x2, y2, x3, y3] = quad as [number, number, number, number, number, number, number, number];
  const area = x0 * y1 - y0 * x1 + x1 * y2 - y1 * x2 + x2 * y3 - y2 * x3 + x3 * y0 - y3 * x0;
  if (Math.abs(area) < 1e-9) throw automationError("frame-unavailable", { reason: "degenerate-quad" });
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (Math.abs(dx3) + Math.abs(dy3) > 1e-9) {
    const determinant = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(determinant) < 1e-9) throw automationError("frame-unavailable", { reason: "degenerate-quad" });
    g = (dx3 * dy2 - dx2 * dy3) / determinant;
    h = (dx1 * dy3 - dx3 * dy1) / determinant;
  }
  const denominator = g * u + h * v + 1;
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) throw automationError("frame-unavailable", { reason: "degenerate-quad" });
  const x = ((x1 - x0 + g * x1) * u + (x3 - x0 + h * x3) * v + x0) / denominator;
  const y = ((y1 - y0 + g * y1) * u + (y3 - y0 + h * y3) * v + y0) / denominator;
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw automationError("frame-unavailable", { reason: "invalid-point" });
  return { x, y };
}

class AutomationError extends Error {
  constructor(readonly code: string, readonly detail: Record<string, unknown>) {
    super(`AutomationError[${code}]: ${JSON.stringify(detail)}`);
    this.name = "AutomationError";
  }
}

function automationError(code: string, detail: Record<string, unknown>): AutomationError {
  return new AutomationError(code, ["not-found", "strict-mode", "frame-not-found"].includes(code)
    ? { ...detail, recovery: detail.recovery ?? "Use list_frames and specify the target frame, or inspect_page/find_elements and use a unique observed element ID." } : detail);
}

/** Validate Chrome's metadata for the exact resolved node before any upload effect. */
export function validateFileUploadTarget(node: { nodeType?: number; nodeName?: string; localName?: string; attributes?: string[] } | undefined, fileCount: number): void {
  const values = node?.attributes ?? [];
  const attributes = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2)
    attributes.set(values[index], values[index + 1]);
  if (node?.nodeType !== 1 || node.nodeName !== "INPUT" || node.localName !== "input" || !/^[Ff][Ii][Ll][Ee]$/.test(attributes.get("type") ?? ""))
    throw automationError("invalid-upload-target", { reason: "expected-file-input", recovery: "Use the file input in its target frame, or open a file chooser and use upload_file_chooser." });
  if (fileCount > 1 && !attributes.has("multiple"))
    throw automationError("invalid-file-count", { reason: "file-input-accepts-one-file", recovery: "Upload one artifact, or choose a file input that accepts multiple files." });
}

function validateLocator(spec: LocatorSpec): void {
  const visited = new Set<LocatorSpec>(), active = new Set<LocatorSpec>();
  const visit = (current: LocatorSpec) => {
    if (active.has(current)) throw automationError("invalid-target", { reason: "cyclic-locator" });
    if (visited.has(current)) return;
    active.add(current);
    if (current.has) visit(current.has);
    for (const query of current.queries) if (query.has) visit(query.has);
    active.delete(current); visited.add(current);
  };
  visit(spec);
}

function standaloneRef(spec: LocatorSpec): boolean {
  return Boolean(spec.ref) && !spec.queries.length && !spec.has && spec.hasText === undefined && spec.index === undefined;
}

/** Preserve filter/index order when another locator operation follows. */
function flushLocator(spec: LocatorSpec): LocatorSpec {
  const queries = [...spec.queries];
  if (spec.has || spec.hasText !== undefined) queries.push({ kind: "filter", value: "", ...(spec.has ? { has: spec.has } : {}), ...(spec.hasText === undefined ? {} : { hasText: spec.hasText }) });
  if (spec.index !== undefined) queries.push({ kind: "index", value: "", index: spec.index });
  return { queries, ...(spec.ref ? { ref: spec.ref } : {}) };
}

function visitLocators(spec: LocatorSpec, visit: (current: LocatorSpec) => void): void {
  const seen = new Set<LocatorSpec>();
  const walk = (current: LocatorSpec) => {
    if (seen.has(current)) return;
    seen.add(current); visit(current);
    if (current.has) walk(current.has);
    for (const query of current.queries) if (query.has) walk(query.has);
  };
  walk(spec);
}

function isDetachedNodeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /(?:node.*(?:not found|not exist|detached|removed)|could not find node|no node with given|cannot find node)/i.test(message);
}

const semanticName = (value: string): string => value.replace(/\s+/g, " ").trim();

const INTERACTIVE_ROLES = new Set([
  "button", "checkbox", "combobox", "gridcell", "link", "listbox", "menuitem", "menuitemcheckbox",
  "menuitemradio", "option", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox", "treeitem",
]);

// ARIA state follows the flattened tree, including slots and shadow hosts.
// The nearest valid ARIA value wins, while native disabled state cannot be
// overridden by aria-disabled="false".
const DISABLED_STATE_SOURCE = `function() {
  if (this.disabled || this.matches(':disabled')) return true;
  let element = this;
  while (element) {
    const value = element.getAttribute('aria-disabled')?.toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
    const root = element.getRootNode();
    element = element.assignedSlot || element.parentElement || root.host || null;
  }
  return false;
}`;

// Native non-text controls can report isContentEditable through an ancestor;
// they still cannot receive the text insertion performed by fill/type_text.
const TEXT_INPUT_KIND_SOURCE = `function() { /* surf-wax:text-input-kind */
  if (!this.isConnected) return 'detached';
  if (this.localName === 'input') {
    const type = this.type;
    if (['date', 'time', 'datetime-local', 'month', 'week'].includes(type)) return type;
    return ['text', 'search', 'email', 'tel', 'url', 'password', 'number'].includes(type) ? 'text' : 'unsupported';
  }
  if (this.localName === 'textarea') return 'text';
  if (['select', 'button', 'option'].includes(this.localName)) return 'unsupported';
  return this.isContentEditable ? 'text' : 'unsupported';
}`;

// The DOM fallback is used when AX omits a visible element (for example
// aria-hidden). Inherited descendants need their own tab stop. The effective
// editing mode comes from the independently sampled computed style.
const SNAPSHOT_EDITABLE_HOST_SOURCE = `function() {
  if (!this.isConnected || !this.isContentEditable || ['input', 'textarea', 'select', 'button', 'option'].includes(this.localName)) return null;
  const root = this.getRootNode(), parent = this.parentElement || (root && root.host) || null;
  if (parent && parent.isContentEditable && this.tabIndex < 0) return null;
  const mode = this.contentEditable;
  const inherited = mode === 'inherit';
  if (inherited && this.tabIndex < 0) return null;
  if (!['true', 'plaintext-only', 'inherit'].includes(mode)) return null;
  return { inherited };
}`;

const STRUCTURED_INPUT_TYPES = new Set(["date", "time", "datetime-local", "month", "week"]);

// Validate before focusing, then recheck in the page task that applies the
// value. The prototype setter keeps controlled inputs (e.g. React) observable.
const STRUCTURED_FILL_SOURCE = `function(type, value, apply) {
  if (!this.isConnected) return { error: 'detached' };
  if (this.localName !== 'input' || this.type !== type) return { error: 'target-changed' };
  if ((${DISABLED_STATE_SOURCE}).call(this) || this.readOnly || this.getAttribute('aria-readonly') === 'true') return { error: 'not-editable' };
  const view = this.ownerDocument?.defaultView;
  const setter = view && Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value')?.set;
  if (!view || !setter) return { error: 'value-setter-unavailable' };
  const probe = this.ownerDocument.createElement('input');
  probe.type = type;
  setter.call(probe, value);
  const normalized = probe.value;
  if (value !== '' && normalized === '') return { error: 'invalid-value' };
  if (!apply) return { value: normalized };
  setter.call(this, normalized);
  if (this.value !== normalized) return { error: 'value-not-applied' };
  this.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
  this.dispatchEvent(new view.Event('change', { bubbles: true }));
  return { value: this.value };
}`;

const EDITABLE_STATE_SOURCE = `function(kind, disabled) {
  return !disabled && !this.readOnly && this.getAttribute("aria-readonly") !== "true" && kind !== "unsupported" && kind !== "detached";
}`;

// Snapshot action hints use the same live capability test as fill/type_text.
const SNAPSHOT_FILLABILITY_SOURCE = `function() {
  const kind = (${TEXT_INPUT_KIND_SOURCE}).call(this);
  const disabled = (${DISABLED_STATE_SOURCE}).call(this);
  let readonly = !!this.readOnly || this.getAttribute('aria-readonly') === 'true';
  let mode = null;
  if (this.isContentEditable && !['input', 'textarea', 'select', 'button', 'option'].includes(this.localName)) {
    const style = this.ownerDocument?.defaultView?.getComputedStyle(this).getPropertyValue('-webkit-user-modify').trim().toLowerCase();
    if (style === 'read-write') mode = 'richtext';
    else if (style === 'read-write-plaintext-only') mode = 'plaintext';
    else if (style === 'read-only') readonly = true;
  }
  const fillable = (${EDITABLE_STATE_SOURCE}).call(this, kind, disabled)
    && (!this.isContentEditable || ['input', 'textarea'].includes(this.localName) || mode !== null);
  return { fillable: fillable && !readonly, disabled, readonly, mode };
}`;

// Shared by reads and mutations so ARIA controls and native inputs use the
// same checked-state semantics. Mixed or missing state is never treated as false.
const CHECKED_STATE_SOURCE = `function() {
  if (this.localName === 'input' && (this.type === 'checkbox' || this.type === 'radio')) {
    return { supported: true, radio: this.type === 'radio', value: this.type === 'checkbox' && this.indeterminate ? null : Boolean(this.checked) };
  }
  const role = (this.getAttribute('role') || '').trim().split(/\\s+/)[0];
  if (!['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role)) return { supported: false, radio: false, value: null };
  const value = (this.getAttribute('aria-checked') || '').trim().toLowerCase();
  const mixed = value === 'mixed' && (role === 'checkbox' || role === 'menuitemcheckbox');
  return { supported: value === 'true' || value === 'false' || mixed, radio: role === 'radio' || role === 'menuitemradio', value: value === 'true' ? true : value === 'false' ? false : null };
}`;

/** Executed in the input's document by CDP. The file bytes are passed as data. */
export const FILE_UPLOAD_FUNCTION = `function(files){
  const view = this.ownerDocument && this.ownerDocument.defaultView;
  if (!this.isConnected || !view || this.localName !== "input" || String(this.type).toLowerCase() !== "file") throw new Error("AutomationError[invalid-upload-target]: Expected a connected file input");
  if (!this.multiple && files.length > 1) throw new Error("AutomationError[invalid-file-count]: File input does not allow multiple files");
  const transfer = new view.DataTransfer();
  for (const file of files) {
    const bytes = file.base64 ? view.Uint8Array.from(view.atob(file.base64), c => c.charCodeAt(0)) : new view.TextEncoder().encode(file.text || "");
    transfer.items.add(new view.File([bytes], file.name, { type: file.mimeType || "application/octet-stream" }));
  }
  this.files = transfer.files; this.dispatchEvent(new view.Event("input", { bubbles: true })); this.dispatchEvent(new view.Event("change", { bubbles: true }));
}`;

const RESOLVER_SOURCE = String.raw`function(spec, metadata, rootDocument, refs) {
  if(rootDocument && rootDocument!==document && rootDocument.ownerDocument!==document)throw new Error("AutomationError[frame-unavailable]: Locator root does not belong to the isolated document");
  const normalize = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const roleOf = el => el.getAttribute("role") || ({
    A: el.hasAttribute("href") ? "link" : "generic", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox",
    OPTION: "option", IMG: "img", SUMMARY: "button", FORM: "form", TABLE: "table", TR: "row", TD: "cell", TH: "columnheader",
    H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading", NAV: "navigation", MAIN: "main",
    ARTICLE: "article", ASIDE: "complementary", FOOTER: "contentinfo", HEADER: "banner", UL: "list", OL: "list", LI: "listitem", DIALOG: "dialog", PROGRESS: "progressbar",
  }[el.tagName] || (el.tagName === "INPUT" ? ({ checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox", button: "button", submit: "button", reset: "button" }[el.type] || "textbox") : "generic"));
  const nameOf = el => normalize(el.getAttribute("aria-label") || (() => {
    const ids = el.getAttribute("aria-labelledby");
    return ids && ids.split(/\s+/).map(id => el.getRootNode().getElementById?.(id)?.textContent || "").join(" ");
  })() || (el.labels ? [...el.labels].map(label => label.textContent).join(" ") : "") || el.getAttribute("alt") || el.getAttribute("title") || el.textContent || el.value);
  const roots = root => {
    const out = [root];
    if (root.shadowRoot) out.push(...roots(root.shadowRoot));
    for (const el of root.querySelectorAll?.("*") || []) if (el.shadowRoot) out.push(...roots(el.shadowRoot));
    return out;
  };
  const all = root => roots(root).flatMap(item => [...(item.querySelectorAll?.("*") || [])]);
  const readText = ${RENDERED_TEXT_READER_SOURCE};
  const textCache = new WeakMap();
  const visibleText = el => {
    if (!textCache.has(el)) { const text = readText.call(el); textCache.set(el, text === null ? null : normalize(text)); }
    return textCache.get(el);
  };
  const labelText = root => {
    if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(root.nodeName) || root.ownerDocument?.head?.contains(root)) return "";
    if (root.nodeName === "INPUT" && ["button", "submit", "reset"].includes(root.type)) return root.value;
    let result = "";
    for (const node of root.childNodes) {
      if (node.nodeType === 3) result += node.nodeValue || "";
      else if (node.nodeType === 1) result += labelText(node);
    }
    if (root.shadowRoot) result += labelText(root.shadowRoot);
    return result;
  };
  const matches = (el, query) => {
    const equal = (actual, expected) => actual === null ? false : query.exact ? normalize(actual) === normalize(expected) : normalize(actual).toLowerCase().includes(normalize(expected).toLowerCase());
    if (query.kind === "role") return roleOf(el) === query.value && (!query.name || equal(nameOf(el), query.name));
    if (query.kind === "text") return equal(el.innerText ?? null, query.value) && ![...el.children].some(child => child.checkVisibility({opacityProperty:true,visibilityProperty:true}) && equal(child.innerText ?? null, query.value)) && equal(visibleText(el), query.value);
    if (query.kind === "label") {
      const labelledBy = el.getAttribute("aria-labelledby")?.trim();
      const referenced = labelledBy ? labelledBy.split(/\s+/).map(id => el.getRootNode().getElementById?.(id)).filter(Boolean) : [];
      if (referenced.length) return referenced.some(label => equal(labelText(label), query.value));
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel?.trim()) return equal(ariaLabel, query.value);
      return el.labels ? [...el.labels].some(label => equal(labelText(label), query.value)) : false;
    }
    if (query.kind === "placeholder") return el.hasAttribute("placeholder") && equal(el.getAttribute("placeholder"), query.value);
    if (query.kind === "alt") return el.hasAttribute("alt") && equal(el.getAttribute("alt"), query.value);
    if (query.kind === "title") return el.hasAttribute("title") && equal(el.getAttribute("title"), query.value);
    if (query.kind === "testId") return el.getAttribute("data-testid") === query.value;
    return false;
  };
  const query = (root, item) => item.kind === "css" || item.kind === "frame"
    ? roots(root).flatMap(part => [...part.querySelectorAll(item.value)])
    : all(root).filter(el => matches(el, item));
  const resolve = (root, locator) => {
    let current = [root];
    if (locator.ref) {
      const node = refs?.[locator.ref];
      if (!node || !node.isConnected) throw new Error("AutomationError[detached]: Referenced element is no longer connected");
      let ancestor = node;
      while (ancestor && ancestor !== root) ancestor = ancestor.parentNode || ancestor.host || null;
      current = ancestor === root && node !== root ? [node] : [];
    }
    for (const item of locator.queries) {
      if (item.kind === "uniqueScope") {
        if (current.length !== 1) throw new Error("AutomationError[invalid-scope]: Expected exactly one scope, found " + current.length);
        continue;
      }
      if (item.kind === "filter") {
        if (item.hasText !== undefined) current = current.filter(el => visibleText(el)?.toLowerCase().includes(normalize(item.hasText).toLowerCase()));
        if (item.has) current = current.filter(el => resolve(el, item.has).length > 0);
        continue;
      }
      if (item.kind === "index") {
        const index = item.index < 0 ? current.length + item.index : item.index;
        current = index >= 0 && index < current.length ? [current[index]] : [];
        continue;
      }
      const found = current.flatMap(node => query(node, item));
      if (item.kind === "frame") {
        current = found.map(frame => { try { return frame.contentDocument; } catch { return null; } });
        if (metadata === "nodes" && current.some(frame => !frame)) throw new Error("AutomationError[frame-unavailable]: Frame document is not available");
        current = [...new Set(current.filter(Boolean))];
      } else current = [...new Set(found)];
    }
    if (locator.hasText) current = current.filter(el => visibleText(el)?.toLowerCase().includes(normalize(locator.hasText).toLowerCase()));
    if (locator.has) current = current.filter(el => resolve(el, locator.has).length > 0);
    if (locator.index !== undefined) { const index = locator.index < 0 ? current.length + locator.index : locator.index; current = index >= 0 && index < current.length ? [current[index]] : []; }
    return [...new Set(current)];
  };
  const result = resolve(rootDocument || document, spec);
  if (metadata === "nodes") return result;
  if (!metadata) return result[0] || null;
  return result.map(el => ({ role: roleOf(el), name: nameOf(el), tag: el.tagName.toLowerCase(), text: visibleText(el)?.slice(0, 120) ?? null }));
}`;

const SEARCH_META_SOURCE = String.raw`function(includeIdentity, readText) {
  const el = this;
  if (el.ownerDocument !== document) return {connected:!!el.isConnected};
  const normalize = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const role = el.getAttribute("role") || ({
    A: el.hasAttribute("href") ? "link" : "generic", BUTTON:"button", SELECT:"combobox", TEXTAREA:"textbox", OPTION:"option", IMG:"img", SUMMARY:"button", FORM:"form", TABLE:"table", TR:"row", TD:"cell", TH:"columnheader",
    H1:"heading", H2:"heading", H3:"heading", H4:"heading", H5:"heading", H6:"heading", NAV:"navigation", MAIN:"main", ARTICLE:"article", ASIDE:"complementary", FOOTER:"contentinfo", HEADER:"banner", UL:"list", OL:"list", LI:"listitem", DIALOG:"dialog", PROGRESS:"progressbar"
  }[el.tagName] || (el.tagName === "INPUT" ? ({checkbox:"checkbox",radio:"radio",range:"slider",number:"spinbutton",search:"searchbox",button:"button",submit:"button",reset:"button"}[el.type] || "textbox") : "generic"));
  const name = normalize(el.getAttribute("aria-label") || (() => { const ids = el.getAttribute("aria-labelledby"); return ids && ids.split(/\s+/).map(id => el.getRootNode().getElementById?.(id)?.textContent || "").join(" "); })() || (el.labels ? [...el.labels].map(label => label.textContent).join(" ") : "") || el.getAttribute("alt") || el.getAttribute("title") || el.textContent || el.value);
  const renderedText = (readText || ${RENDERED_TEXT_READER_SOURCE}).call(el);
  const text = renderedText === null ? null : normalize(renderedText);
  const identityTooLarge = String(role).length + name.length > 2_000_000;
  return { connected: el.isConnected, role: String(role).slice(0, 80), name: name.slice(0, 160), ...(includeIdentity ? identityTooLarge ? { identityTooLarge: true } : { identityRole: String(role), identityName: name } : {}), text: text?.slice(0, 120) ?? null, tag: el.tagName.toLowerCase(),
    ...(String(role).length > 80 ? {roleTruncated:true} : {}), ...(name.length > 160 ? {nameTruncated:true} : {}), ...(text !== null && text.length > 120 ? {textTruncated:true} : {}) };
}`;

export class AutomationRuntime {
  private readonly sessions = new Map<number, Session>();
  private readonly activeActions = new Map<number, number>();
  private readonly objectDebuggees = new Map<string, Debuggee>();
  private readonly objectContexts = new Map<string, number>();
  private context: RunContext = {};
  private readonly waiters = new Map<number, Map<string, Set<Waiter>>>();
  private lastWait?: { locator: LocatorSpec; state?: ElementState; matches?: number; candidates?: Candidate[]; documentId: number; reason: string; attempt: number };
  private lastAttemptLog?: { reason: string; at: number };
  private readonly observations = new Map<string, ObservationRecord>();
  private readonly inspectionSnapshots = new Map<string, InspectSnapshot>();
  private readonly frontendRoots = new Map<string, number>();
  private readonly fileChoosers = new Map<number, FileChooserRecord>();
  private readonly searches = new Map<string, SearchSnapshot>();
  private readonly frameLists = new Map<string, FrameListSnapshot>();
  private readonly frameDocuments = new Map<string, FrameDocument>();
  private readonly rootReadScopes = new WeakMap<object, RootReadScope>();
  private completeStyleCatalog?: Promise<readonly string[]>;

  private waitDiagnostic() { return this.lastWait; }

  /** Describe the actual hit node, including a blocker in an embedding frame. */
  private async clickBlocker(session: Session, targetSession: Session, objectId: string, position: { x: number; y: number }): Promise<Record<string, unknown> | undefined> {
    let debuggee = targetSession.debuggee;
    let expectedNodeId = (await this.describe(targetSession, objectId))?.backendNodeId;
    let target = true;
    while (true) {
      if (position.x < 0 || position.y < 0) return { reason: "outside-viewport", x: position.x, y: position.y };
      const metrics = await this.options.command(debuggee, "Page.getLayoutMetrics", {});
      const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport;
      let hit: any;
      try {
        hit = await this.options.command(debuggee, "DOM.getNodeForLocation", {
          x: Math.floor(position.x + (viewport?.pageX ?? 0)), y: Math.floor(position.y + (viewport?.pageY ?? 0)),
        });
      } catch (error) {
        if (error instanceof Error && /No node found at given location/i.test(error.message)) return { reason: "no-hit-node", x: position.x, y: position.y };
        throw error;
      }
      let matches = hit.backendNodeId === expectedNodeId;
      if (!matches && target && hit.backendNodeId) {
        const group = `surf-wax-blocker:${crypto.randomUUID()}`;
        try {
          const resolved = await this.options.command(debuggee, "DOM.resolveNode", { backendNodeId: hit.backendNodeId, objectGroup: group });
          if (resolved.object?.objectId) {
            // Resolver targets may belong to the extension world. Compare the
            // same native node in the default world used for the hit node.
            const comparable = await this.options.command(debuggee, "DOM.resolveNode", { backendNodeId: expectedNodeId, objectGroup: group });
            if (!comparable.object?.objectId) throw automationError("state-unavailable", { reason: "missing-target-node" });
            const result = await this.options.command(debuggee, "Runtime.callFunctionOn", {
              objectId: comparable.object.objectId, arguments: [{ objectId: resolved.object.objectId }], returnByValue: true,
              functionDeclaration: "function(hit){for(let node=hit;node;node=node.parentNode || node.host) if(node===this)return true;return false}",
            });
            matches = result.result?.value === true;
          }
          if (!matches && hit.frameId) {
            const node = await this.describe(targetSession, objectId);
            if (node?.nodeName === "IFRAME") {
              const owner = await this.options.command(debuggee, "DOM.getFrameOwner", { frameId: hit.frameId });
              matches = owner.backendNodeId === expectedNodeId;
            }
          }
        } finally { void this.options.command(debuggee, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => undefined); }
      }
      if (!matches) {
        if (!hit.backendNodeId) return { reason: "unknown-hit-node", x: position.x, y: position.y };
        const node = (await this.options.command(debuggee, "DOM.describeNode", { backendNodeId: hit.backendNodeId })).node;
        const ax = await this.options.command(debuggee, "Accessibility.getPartialAXTree", { backendNodeId: hit.backendNodeId, fetchRelatives: false }).catch(() => undefined);
        const semantic = ax?.nodes?.find((item: any) => item.backendDOMNodeId === hit.backendNodeId) ?? ax?.nodes?.[0];
        const attributes = Array.isArray(node?.attributes) ? node.attributes : [];
        const idIndex = attributes.indexOf("id");
        const id = idIndex >= 0 ? attributes[idIndex + 1] : undefined;
        return { reason: "hit-other-element", ...(typeof node?.nodeName === "string" ? { tag: node.nodeName.toLowerCase().slice(0, 80) } : {}),
          ...(typeof semantic?.role?.value === "string" ? { role: semantic.role.value.slice(0, 80) } : {}),
          ...(typeof semantic?.name?.value === "string" ? { name: semantic.name.value.slice(0, 160) } : {}),
          ...(typeof id === "string" && id ? { id: id.slice(0, 160) } : {}),
          ...(typeof hit.frameId === "string" ? { frameId: hit.frameId } : {}), x: position.x, y: position.y };
      }
      if (!debuggee.sessionId) return undefined;
      const frameId = [...session.frames].find(([, item]) => item.sessionId === debuggee.sessionId)?.[0];
      if (!frameId) return undefined;
      const { parent, owner, quad, size } = await this.frameGeometry(session, debuggee, frameId);
      position = projectQuad(quad, position.x / size.width, position.y / size.height);
      debuggee = parent; expectedNodeId = owner.backendNodeId; target = false;
    }
  }

  private recordAttempt(session: Session, locator: LocatorSpec, attempt: number, reason: string, candidates: Candidate[], state?: ElementState): void {
    const summary = candidates.slice(0, 5).map(({ role, name, tag, text, ref }) => ({ role, name, tag, text, ref }));
    this.lastWait = { locator, matches: candidates.length, candidates: summary, state, documentId: session.generation, reason, attempt };
    const now = performance.now();
    if (attempt !== 1 && this.lastAttemptLog?.reason === reason && now - this.lastAttemptLog.at < 1_000) return;
    this.lastAttemptLog = { reason, at: now };
    this.options.logger?.telemetry({
      type: "automation.action.attempt",
      conversationId: this.context.conversationId,
      toolCallId: this.context.toolCallId,
      ...this.context.logIdentity,
      content: { attempt, reason, candidateCount: candidates.length, candidates: summary, documentId: session.generation, locator },
    });
  }

  constructor(private readonly options: {
    chromeApi: typeof chrome;
    observationWorldName?: string;
    command: Command;
    pressChord: (debuggee: Debuggee, chord: string, signal?: AbortSignal, assertFocus?: () => Promise<void>) => Promise<void>;
    atomicClick?: (debuggee: Debuggee, params: Record<string, unknown>) => Promise<unknown>;
    detach: (debuggee: Debuggee) => Promise<void>;
    onDispatch?: () => Promise<void>;
    claimChooser?: (chooser: FileChooserRecord) => FileChooserClaim | undefined;
    respondDialog?: (id: string | undefined, source: Debuggee, accept: boolean, promptText?: string, dispatch?: () => Promise<void>) => Promise<unknown>;
    logger?: EventLogger;
  }) {}

  setContext(context: RunContext): void { this.context = context; }
  private readonly markerQueries = new Map<string, { debuggee: Debuggee; group: string }>();
  hasSession(tabId: number): boolean { return this.sessions.has(tabId); }
  sessionIdentity(tabId: number): object | undefined { return this.sessions.get(tabId); }
  async clearContext(): Promise<void> {
    this.context = {};
    // An aborted read can leave its retained identity/observer alive until the
    // executor clears its signal. Dispose before releasing remote references.
    await Promise.all([...this.markerQueries].map(async ([objectId, { debuggee, group }]) => {
      await this.options.command(debuggee, "Runtime.callFunctionOn", {
        objectId, functionDeclaration: "function(){this.dispose()}", returnByValue: true,
      }).catch(() => undefined);
      await this.options.command(debuggee, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => undefined);
      this.markerQueries.delete(objectId);
    }));
    // Invalidate before releasing the group: in-flight evaluations can create
    // their object after the group has been released and must clean up late.
    this.clearFrameDocuments(undefined, undefined, false);
    const debuggees = new Map<string, Debuggee>();
    for (const session of this.sessions.values()) {
      debuggees.set(JSON.stringify(session.debuggee), session.debuggee);
      for (const debuggee of session.frames.values()) debuggees.set(JSON.stringify(debuggee), debuggee);
    }
    await Promise.all([...debuggees.values()].map((debuggee) => this.options.command(debuggee, "Runtime.releaseObjectGroup", { objectGroup: "surf-wax-automation" }).catch(() => undefined)));
    this.objectDebuggees.clear();
    this.objectContexts.clear();
  }

  async observationDebuggees(tabId: number): Promise<Debuggee[]> {
    const session = await this.session(tabId);
    await Promise.all([...session.frameReady.values()]);
    return [...new Map([session.debuggee, ...session.frames.values()].map((debuggee) => [JSON.stringify(debuggee), debuggee])).values()];
  }

  async createPage(tabId?: number): Promise<PageFacade> {
    const resolved = tabId ?? (await this.options.chromeApi.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (!Number.isInteger(resolved)) throw new Error("browser.page() could not find an active tab; pass tabId explicitly.");
    await this.session(resolved!);
    return new PageFacade(this, resolved!);
  }

  private recordFrameTree(session: Session, source: Debuggee, tree: any, parent?: string): void {
    const frameId = tree?.frame?.id;
    if (typeof frameId !== "string") return;
    const current = session.frames.get(frameId);
    if (current?.sessionId && current.sessionId !== source.sessionId) {
      // A parent tree may contain an OOPIF placeholder from before its new
      // target was attached. It supplies ancestry, never that target's loader
      // or descendant documents.
      const parentId = tree.frame.parentId ?? parent;
      if (!session.frameParents.has(frameId) && parentId !== undefined) session.frameParents.set(frameId, parentId);
      return;
    }
    if (!session.frames.get(frameId)?.sessionId || session.frames.get(frameId)?.sessionId === source.sessionId)
      session.frames.set(frameId, source);
    if (typeof tree.frame.loaderId === "string") {
      const previous = session.frameLoaders.get(frameId);
      // A new target can return its tree before either renderer's navigation
      // event. Retire the old document's descendants before accepting its loader.
      if (previous !== undefined && previous !== tree.frame.loaderId) this.removeFrameDescendants(session, frameId);
      session.frameLoaders.set(frameId, tree.frame.loaderId);
    }
    const parentId = tree.frame.parentId ?? parent ?? session.frameParents.get(frameId);
    if (parentId !== undefined || !source.sessionId) session.frameParents.set(frameId, parentId);
    if (parentId === undefined && !source.sessionId) session.rootFrameId = frameId;
    for (const child of tree.childFrames ?? []) this.recordFrameTree(session, source, child, frameId);
  }

  /** A document replacement destroys its child browsing contexts. Chrome does
   * not emit individual detach events for every same-process descendant. */
  private removeFrameDescendants(session: Session, frameId: string): void {
    const removed = new Set<string>();
    let grew = true;
    while (grew) {
      grew = false;
      for (const [id, parent] of session.frameParents) if (parent && (parent === frameId || removed.has(parent)) && !removed.has(id)) {
        removed.add(id); grew = true;
      }
    }
    const ownSession = session.frames.get(frameId)?.sessionId;
    for (const id of removed) {
      const childSession = session.frames.get(id)?.sessionId;
      if (childSession && childSession !== ownSession) this.retireFrameSession(session, childSession);
      session.frames.delete(id); session.frameParents.delete(id); session.frameLoaders.delete(id);
    }
  }

  /** Test document invalidation before the frame graph is updated. Unknown
   * ancestry is treated as affected so a stale chooser is never reused. */
  chooserAffected(source: Debuggee, method: string, params: any, chooser: { frameId?: string; source: Debuggee }): boolean {
    const session = Number.isInteger(source.tabId) ? this.sessions.get(source.tabId!) : undefined;
    let changed: string | undefined;
    if (method === "Page.frameNavigated") changed = params?.frame?.id;
    else if (method === "Page.frameDetached") changed = params?.frameId;
    else if (method === "Target.detachedFromTarget" && params?.sessionId) {
      const id = params.sessionId;
      changed = [...(session?.frames ?? [])].find(([frame, debuggee]) => debuggee.sessionId === id
        && session?.frames.get(session.frameParents.get(frame) ?? "")?.sessionId !== id)?.[0];
      if (!changed) return chooser.source.sessionId === id;
    } else if (method === "DOM.documentUpdated" || method === "Runtime.executionContextsCleared") {
      if (!source.sessionId) return true;
      const id = source.sessionId;
      changed = [...(session?.frames ?? [])].find(([frame, debuggee]) => debuggee.sessionId === id
        && session?.frames.get(session.frameParents.get(frame) ?? "")?.sessionId !== id)?.[0];
      if (!changed) return chooser.source.sessionId === id;
    } else return false;
    if (typeof changed !== "string" || !chooser.frameId || !session) return true;
    const unknownFrameAncestry = () => {
      const ancestorSession = method === "Target.detachedFromTarget" ? params?.sessionId : source.sessionId;
      let current = chooser.source.sessionId;
      if (!ancestorSession || !current) return true;
      const visited = new Set<string>();
      while (current) {
        if (current === ancestorSession) return true;
        if (visited.has(current) || !session.targetParents.has(current)) return true;
        visited.add(current); current = session.targetParents.get(current);
      }
      return false;
    };
    let current: string | undefined = chooser.frameId;
    const seen = new Set<string>();
    while (current) {
      if (current === changed) return true;
      if (seen.has(current) || !session.frameParents.has(current)) return unknownFrameAncestry();
      seen.add(current);
      current = session.frameParents.get(current);
    }
    return false;
  }

  handleEvent(source: Debuggee, method: string, params: any): void {
    const tabId = source.tabId;
    if (!Number.isInteger(tabId)) return;
    const session = this.sessions.get(tabId!);
    // Events already queued by a retired target must not restore stale frames,
    // overwrite their ancestry, or detach a replacement target.
    if (source.sessionId && session?.retiredTargetSessions?.has(source.sessionId)) return;
    if (session && !source.sessionId && method === "Runtime.executionContextCreated") {
      const context = params?.context, auxiliary = context?.auxData, extensionId = this.options.chromeApi.runtime?.id;
      if (typeof auxiliary?.frameId === "string" && Number.isSafeInteger(context?.id) && typeof context.uniqueId === "string") {
        const candidate = Boolean(this.options.observationWorldName && context.name === this.options.observationWorldName
          && auxiliary.type === "isolated" && auxiliary.isDefault === false) || Boolean(extensionId && typeof context.origin === "string"
          && context.origin.replace(/\/$/, "") === `chrome-extension://${extensionId}`
          && auxiliary.type === "isolated" && auxiliary.isDefault === false);
        const previous = session.observationContexts.get(context.id);
        if (previous?.uniqueId !== context.uniqueId || previous?.frameId !== auxiliary.frameId || previous?.candidate !== candidate) {
          // Another isolated world (including USER_SCRIPT) does not replace
          // the document or the already identified observation world.
          const replacedRoot = auxiliary.frameId === session.rootFrameId && previous;
          if (replacedRoot) session.rootDocumentRevision++;
          session.observationContexts.set(context.id, { id: context.id, uniqueId: context.uniqueId, frameId: auxiliary.frameId, candidate });
        }
      }
    }
    if (session && !source.sessionId && method === "Runtime.executionContextsCleared") {
      session.rootDocumentRevision++;
      session.observationContexts.clear();
    }
    if (session && !source.sessionId && method === "Runtime.executionContextDestroyed") {
      const destroyed = [...session.observationContexts.values()].find((context) => context.id === params?.executionContextId
        || context.uniqueId === params?.executionContextUniqueId);
      // An unknown context cannot be proved to belong to an unrelated child.
      if (!destroyed || destroyed.frameId === session.rootFrameId) {
        session.rootDocumentRevision++;
        delete session.observationPrimitives;
      }
      if (destroyed) session.observationContexts.delete(destroyed.id);
    }
    if (session && this.options.observationWorldName && !source.sessionId
      && (method === "DOM.shadowRootPushed" || method === "DOM.shadowRootPopped"
        || method === "DOM.childNodeInserted" && params?.node?.nodeType === 1)) {
      // Roots may be attached in place, or arrive inside a previously detached
      // subtree (only childNodeInserted). Both invalidate a closed-root census
      // before its sample can expose light DOM hidden by an uncollected root.
      session.rootDocumentRevision++;
    }
    if (session && (method === "DOM.shadowRootPushed" || method === "DOM.shadowRootPopped"
      || method === "DOM.childNodeRemoved" || method === "DOM.childNodeInserted" && params?.node?.nodeType === 1)) {
      // Native topology evidence is scoped to its original document entry.
      // Same-process frames share a source; conservatively invalidate those
      // entries without replacing their worlds or unrelated AX/paint state.
      for (const entry of this.frameDocuments.values()) if (entry.session === session
        && entry.frame.debuggee.sessionId === source.sessionId) entry.shadowRevision = (entry.shadowRevision ?? 0) + 1;
    }
    const chooser = this.fileChoosers.get(tabId!);
    const preserveChooser = !chooser || !this.chooserAffected(source, method, params, { frameId: chooser.frameId, source: chooser.debuggee });
    if (method === "Target.attachedToTarget" && params?.targetInfo?.type === "iframe" && session) {
      if (source.sessionId && !session.targetParents.has(source.sessionId)) return;
      const debuggee = { tabId, sessionId: params.sessionId } as Debuggee;
      const targetId = params.targetInfo.targetId as string;
      const sessionId = params.sessionId as string;
      const previous = session.targetSessions.get(targetId);
      if (previous && previous !== sessionId) this.retireFrameSession(session, previous, targetId);
      session.retiredTargetSessions.delete(sessionId);
      session.frames.set(targetId, debuggee);
      session.targetSessions.set(targetId, sessionId);
      session.targetParents.set(sessionId, source.sessionId);
      this.invalidateFrames(session);
      let ready!: Promise<void>;
      const guard = () => {
        if (this.sessions.get(tabId!) !== session || session.lifetime.signal.aborted
          || session.frameReady.get(sessionId) !== ready || session.frames.get(targetId)?.sessionId !== sessionId)
          throw automationError("frame-detached", { reason: "target-session-changed" });
      };
      ready = (async () => {
        for (const domain of ["Page", "Runtime", "DOM", "Accessibility"]) {
          await this.options.command(debuggee, `${domain}.enable`, {});
          guard();
        }
        await this.options.command(debuggee, "Page.setLifecycleEventsEnabled", { enabled: true });
        guard();
        // Frame events can arrive while the tree request is in flight. Retry
        // only the stale snapshot instead of restoring an already detached child.
        while (true) {
          const revision = session.frameRevision;
          const tree = await this.options.command(debuggee, "Page.getFrameTree", {});
          guard();
          if (revision !== session.frameRevision) continue;
          this.recordFrameTree(session, debuggee, tree?.frameTree);
          break;
        }
        // Each out-of-process iframe is its own target. Recursively attach its
        // iframe targets so deeper cross-process descendants can be discovered.
        await this.options.command(debuggee, "Target.setAutoAttach", { autoAttach: true, flatten: true, waitForDebuggerOnStart: false, filter: [{ type: "iframe", exclude: false }] });
        guard();
      })();
      void ready.catch(() => undefined);
      session.frameReady.set(sessionId, ready);
    }
    if (method === "Page.frameAttached" && params?.frameId && session) {
      if (!session.frames.get(params.frameId)?.sessionId || source.sessionId === session.frames.get(params.frameId)?.sessionId) session.frames.set(params.frameId, source);
      session.frameParents.set(params.frameId, params.parentFrameId);
      this.invalidateFrames(session);
    }
    if (method === "Page.frameNavigated" && params?.frame?.id && session) {
      // Parent renderers can deliver an old navigation after ownership moved
      // to an OOPIF. That source cannot replace the current document or tree.
      const current = session.frames.get(params.frame.id);
      if (current?.sessionId && current.sessionId !== source.sessionId) return;
      const parentId = params.frame.parentId ?? session.frameParents.get(params.frame.id);
      if (!source.sessionId && (!parentId || params.frame.id === session.rootFrameId)) session.rootDocumentRevision++;
      const loaderId = params.frame.loaderId;
      if (typeof loaderId === "string" && session.frameLoaders.has(params.frame.id) && session.frameLoaders.get(params.frame.id) !== loaderId)
        this.removeFrameDescendants(session, params.frame.id);
      if (typeof loaderId === "string") session.frameLoaders.set(params.frame.id, loaderId);
      if (!session.frames.get(params.frame.id)?.sessionId || source.sessionId === session.frames.get(params.frame.id)?.sessionId) session.frames.set(params.frame.id, source);
      session.frameParents.set(params.frame.id, parentId);
      if (!parentId && !source.sessionId) session.rootFrameId = params.frame.id;
      this.invalidate(session, preserveChooser);
    }
    if (method === "Page.navigatedWithinDocument" && session) {
      // History/hash navigation invalidates snapshots, but retains the same
      // input node and therefore must not discard an open file chooser.
      if (!source.sessionId && (params?.frameId === undefined || params.frameId === session.rootFrameId)) session.rootDocumentRevision++;
      this.invalidate(session, true);
    }
    if ((method === "DOM.documentUpdated" || method === "Runtime.executionContextsCleared") && session) {
      if (method === "DOM.documentUpdated" && !source.sessionId) session.rootDocumentRevision++;
      this.invalidate(session, preserveChooser);
    }
    if (method === "Runtime.executionContextDestroyed" && session) this.clearFrameDocuments(tabId!, source);
    if (method === "Page.frameDetached" && params?.frameId && session) {
      if (params.frameId === session.rootFrameId) session.rootDocumentRevision++;
      const current = session.frames.get(params.frameId);
      // A swap detaches the old renderer's view of the frame, not the frame
      // itself. An attachment from the new target can arrive first; do not
      // remove its mapping when the old target reports its delayed swap.
      const transferred = params.reason === "swap" && current?.sessionId && current.sessionId !== source.sessionId;
      if (!transferred) {
        this.removeFrameDescendants(session, params.frameId);
        session.frames.delete(params.frameId);
      }
      // Keep ancestry across a process swap, including when attach arrives
      // after detach and the new target's frame-tree root has no parentId.
      if (params.reason !== "swap") { session.frameParents.delete(params.frameId); session.frameLoaders.delete(params.frameId); }
      this.invalidate(session, preserveChooser);
    }
    if (method === "Target.detachedFromTarget" && params?.sessionId && session) {
      this.retireFrameSession(session, params.sessionId);
      this.invalidate(session, preserveChooser);
    }
    if (session && !source.sessionId && method === "Page.frameStartedLoading" && params?.frameId === session.rootFrameId)
      session.rootDocumentRevision++;
    if (session && session.lifecycleCutoff !== undefined && session.rootFrameId !== undefined && !source.sessionId && method === "Page.lifecycleEvent" && params?.frameId === session.rootFrameId
      && typeof params.loaderId === "string" && typeof params.timestamp === "number" && Number.isFinite(params.timestamp) && params.timestamp > session.lifecycleCutoff) {
      const current = session.rootLifecycle;
      if (params.name === "init") {
        // document.open() reuses the loader and Document. Its init is the
        // only observed boundary separating old lifecycle events from new.
        if (!current || params.timestamp > current.initializedAt) {
          session.rootDocumentRevision++;
          session.rootLifecycle = { frameId: params.frameId, loaderId: params.loaderId, initializedAt: params.timestamp, domContentLoaded: false, load: false };
        }
      } else if (current && current.frameId === params.frameId && current.loaderId === params.loaderId && params.timestamp >= current.initializedAt) {
        if (params.name === "DOMContentLoaded") current.domContentLoaded = true;
        if (params.name === "load") current.load = true;
      }
    }
    if (method === "Page.fileChooserOpened" && params.backendNodeId) {
      const chooser = { backendNodeId: params.backendNodeId, debuggee: source, mode: params.mode,
        ...(typeof params.frameId === "string" ? { frameId: params.frameId } : {}) };
      this.fileChoosers.set(tabId!, chooser);
      this.resolveWaiters(tabId!, "filechooser", chooser);
    }
    const kind = method === "Page.javascriptDialogOpening" ? "dialog" : method === "Page.downloadWillBegin" ? "download" : undefined;
    if (kind) this.resolveWaiters(tabId!, kind, kind === "dialog" ? { ...params, source: { ...source } } : params);
  }

  private retireFrameSession(session: Session, root: string, preserveFrameId?: string): void {
    const retired = new Set([root]);
    // Nested targets belong to their attaching session, even when their frame
    // tree has not arrived yet. Remove their pending readiness as well.
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, parent] of session.targetParents) {
        if (parent && retired.has(parent) && !retired.has(id)) { retired.add(id); changed = true; }
      }
    }
    for (const id of retired) {
      session.retiredTargetSessions.add(id);
      session.frameReady.delete(id);
      session.targetParents.delete(id);
    }
    for (const [frameId, id] of session.targetSessions) if (retired.has(id)) session.targetSessions.delete(frameId);
    for (const [frameId, debuggee] of session.frames) {
      if (debuggee.sessionId && retired.has(debuggee.sessionId)) {
        session.frames.delete(frameId); session.frameLoaders.delete(frameId);
        if (frameId !== preserveFrameId) session.frameParents.delete(frameId);
      }
    }
  }

  private invalidateFrames(session: Session): void {
    this.clearFrameDocuments(session.tabId);
    session.frameRevision += 1;
    session.frameRefs.clear();
    session.frameRefsById.clear();
    for (const [id, snapshot] of this.frameLists) if (snapshot.session === session) this.frameLists.delete(id);
  }

  private invalidate(session: Session, preserveChooser = false): void {
    session.generation += 1;
    delete session.snapshotStyleProfile;
    // Document references still expire, but a child navigation must not
    // rename unrelated frames. Retire scopes no longer represented by the
    // current frame/target graph and never recycle their numbers.
    const activeScopes = new Set([...session.frames].map(([frameId, debuggee]) => JSON.stringify([frameId, debuggee.sessionId ?? null])));
    if (session.rootFrameId) activeScopes.add(JSON.stringify([session.rootFrameId, null]));
    for (const key of session.snapshotScopes.keys()) if (!activeScopes.has(key)) session.snapshotScopes.delete(key);
    this.invalidateFrames(session);
    this.clearSearches(session.tabId);
    this.clearInspections(session.tabId);
    for (const [id, record] of this.sampledIds) if (record.session === session) this.sampledIds.delete(id);
    this.sampledOwners.delete(session);
    this.elementIds.clear(session);
    session.refs.clear();
    session.refsByNode.clear();
    session.refUsage.clear();
    session.lastSnapshot = undefined;
    this.objectDebuggees.clear();
    this.frontendRoots.clear();
    if (!preserveChooser) this.fileChoosers.delete(session.tabId);
  }

  handleDetach(source: Debuggee): void {
    if (Number.isInteger(source.tabId)) {
      this.clearSearches(source.tabId!);
      this.clearInspections(source.tabId!);
      const session = this.sessions.get(source.tabId!);
      if (session) this.invalidateFrames(session);
      if (session) this.elementIds.clear(session);
      this.sessions.delete(source.tabId!);
      for (const [id, record] of this.sampledIds) if (record.session === session) this.sampledIds.delete(id);
      session?.lifetime.abort();
    }
  }

  async abortSessions(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.frameLists.clear();
    this.sampledIds.clear();
    this.elementIds.clear();
    this.clearFrameDocuments();
    this.sessions.clear();
    for (const session of sessions) session.lifetime.abort();
    this.clearSearches();
    this.objectDebuggees.clear();
    this.observations.clear();
    this.inspectionSnapshots.clear();
    this.fileChoosers.clear();
    this.frontendRoots.clear();
    for (const events of this.waiters.values()) for (const waiters of events.values()) for (const waiter of waiters) waiter.reject(abortError());
    this.waiters.clear();
    await Promise.all(sessions.map(async (session) => {
      await this.options.command(session.debuggee, "Input.cancelDragging", {}).catch(() => undefined);
      await this.options.detach(session.debuggee).catch(() => undefined);
    }));
  }

  dispose(): void { void this.abortSessions(); }

  locator(tabId: number, query: Query): LocatorFacade { return new LocatorFacade(this, tabId, { queries: [query] }); }
  private readonly elementIds = new ElementIds((id, binding) => {
    const session = binding.session as Session, record = session.refs.get(id);
    record?.aliases?.delete(id); session.refs.delete(id);
  });
  private idOwner(): string { return JSON.stringify([this.context.conversationId, this.context.logIdentity?.runId ?? this.context.runId]); }
  private sampledId(id: string) { return this.sampledIds.get(this.elementIds.get(id)?.sourceId ?? id); }
  private liveId(session: Session, id: string, owner = this.idOwner()): boolean {
    const binding = this.elementIds.get(id);
    return Boolean(binding && binding.session === session && binding.generation === session.generation && binding.owner === owner
      && (!binding.actionable || session.refs.has(binding.sourceId) || this.sampledIds.has(binding.sourceId)));
  }
  elementById(tabId: number, id: string): LocatorFacade {
    const session = this.sessions.get(tabId), binding = this.elementIds.get(id);
    if (!session || !this.liveId(session, id))
      throw automationError("stale-id", { id, guidance: "Read the current page and use an actionable item ID from this tab and run." });
    if (!binding!.actionable) throw automationError("not-actionable-id", { id, guidance: "Choose an item with actionable=true, or use find_elements." });
    this.elementIds.touch(id);
    return this.ref(tabId, id);
  }
  ref(tabId: number, ref: string): LocatorFacade { return new LocatorFacade(this, tabId, { queries: [], ref }); }

  async snapshot(tabId: number): Promise<{ url: string; title: string; snapshot: string; partial?: true; limitations?: string }> {
    return this.action(tabId, "snapshot", null, async () => {
      const session = await this.session(tabId);
      this.pruneRefs(session);
      const captured = await this.captureReadableSnapshot(session);
      this.handoffFreshRootCapture(session, captured);
      session.lastSnapshot = captured.lines;
      return { url: captured.url, title: captured.title, documentId: session.generation, snapshot: captured.lines.map(({ line }) => line).join("\n"), ...(captured.partial ? { partial: true as const } : {}), ...(captured.limitations ? { limitations: captured.limitations } : {}) };
    });
  }

  async observe(tabId: number, detail: "auto" | "semantic" | "visual" = "auto", since?: string, captureOptions: Record<string, any> = {}): Promise<Record<string, unknown>> {
    return this.action(tabId, "observe", null, async () => {
      const session = await this.session(tabId);
      this.pruneRefs(session);
      let generation = session.generation;
      const frameRevision = session.frameRevision;
      const signal = this.context.signal;
      const pauseSignal = signal ? AbortSignal.any([signal, session.lifetime.signal]) : session.lifetime.signal;
      const { guard: guardSession, waitForCapture: wait } = this.captureWaiter(session, signal);
      const guard = () => {
        guardSession();
        if (this.sessions.get(tabId) !== session || generation !== session.generation)
          throw automationError("stale-observation", { reason: "document-changed-during-observation" });
        if (since && (session.frameRevision !== frameRevision || this.observations.get(since) !== previous))
          throw automationError("stale-observation", { reason: "baseline-changed-during-observation" });
      };
      const previous = since ? this.observations.get(since) : undefined;
      if (since && (!previous || previous.visual || previous.session !== session || previous.tabId !== tabId || previous.documentId !== generation
        || previous.frameRevision !== frameRevision))
        throw automationError("stale-observation", { observationId: since, reason: previous?.visual ? "visual-observation-is-not-semantic-baseline" : "expired-document" });
      // Pixel evidence is independent of DOM/AX consistency. Wait for the
      // document load, but do not wait for a dynamic page to stop changing.
      if (detail === "visual") {
        while (true) {
          guard();
          if (await wait(this.pageValue(tabId, "document.readyState === 'complete'"))) break;
          await wait(delay(50, pauseSignal));
        }
      }
      guard();
      const captured = detail === "visual"
        ? { ...await wait(this.pageValue(tabId, "({url:location.href,title:document.title})")) as { url: string; title: string }, lines: [] as SnapshotLine[], partial: undefined, limitations: undefined, viewport: undefined }
        : await this.captureReadableSnapshot(session);
      if (!since && "frameRevision" in captured && this.handoffFreshRootCapture(session, captured)) generation = session.generation;
      let viewport = captured.viewport ?? await wait(this.pageValue(tabId, "({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight,scale:devicePixelRatio})")) as ObservationRecord["viewport"];
      guard();
      const sameViewport = (left: ObservationRecord["viewport"], right: ObservationRecord["viewport"]) =>
        ["x", "y", "width", "height", "scale"].every(key => left?.[key as keyof typeof left] === right?.[key as keyof typeof right]);
      // Attaching Chrome's debugger can animate browser chrome and resize the
      // page. Settle only the coordinate frame before the single pixel capture;
      // page text and paint may continue changing throughout this wait.
      if (detail === "visual") {
        while (true) {
          await wait(delay(50, pauseSignal));
          guard();
          const next = await wait(this.pageValue(tabId, "({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight,scale:devicePixelRatio})")) as ObservationRecord["viewport"];
          guard();
          const stable = sameViewport(viewport, next);
          viewport = next;
          if (stable) break;
        }
      }
      if (![viewport?.x, viewport?.y, viewport?.width, viewport?.height, viewport?.scale].every(Number.isFinite)
        || viewport.width <= 0 || viewport.height <= 0 || viewport.scale <= 0)
        throw automationError("screenshot-unavailable", { reason: "invalid-viewport", viewport });
      const observationId = globalThis.crypto.randomUUID();
      const record: ObservationRecord = { session, observationId, tabId, documentId: generation, ...captured, viewport, ...(detail === "visual" ? { visual: true as const } : {}) };
      if (detail !== "visual") session.lastSnapshot = captured.lines;
      const before = new Map(previous?.lines.map((item) => [item.id, item.line]));
      const after = new Map(captured.lines.map((item) => [item.id, item.line]));
      const changes = previous && !previous.partial && !captured.partial ? {
        added: captured.lines.filter(({ id }) => !before.has(id)).map(({ line }) => line),
        removed: previous.lines.filter(({ id }) => !after.has(id)).map(({ line }) => line),
        updated: captured.lines.flatMap(({ id, line }) => before.has(id) && before.get(id) !== line ? [{ before: before.get(id), after: line }] : []),
      } : undefined;
      const result: Record<string, unknown> = {
        observationId, documentId: generation, url: captured.url, title: captured.title, viewport,
        ...(detail === "visual" ? {} : { snapshot: captured.lines.map(({ line }) => line).join("\n"), ...(captured.partial ? { partial: true } : {}), ...(captured.limitations ? { limitations: captured.limitations } : {}), ...(changes ? { changes } : {}),
          ...(previous && captured.partial ? { reset: "current-output-partial" } : previous?.partial ? { reset: "previous-output-partial" } : {}) }),
      };
      const hasSemanticContent = expandSnapshot(captured.lines).some(({ ref, node }) => ref
        || node && node.role !== "RootWebArea" && (node.name?.trim() || node.nameUnknown || node.valueUnknown
          || node.textFragments?.some(({ text }) => text.trim()) || node.state && Object.keys(node.state).length));
      if (detail === "visual" || detail === "auto" && !hasSemanticContent) {
        const { target, fullPage, hires, ...options } = captureOptions;
        const readClip = async () => {
          let clip = options.clip;
          if (fullPage) {
            const metrics = await this.options.command(session.debuggee, "Page.getLayoutMetrics", {});
            clip = metrics.cssContentSize ?? metrics.contentSize;
            if (!clip) throw automationError("screenshot-unavailable", { reason: "missing-content-size" });
          } else if (target) clip = await this.screenshotClip(tabId, target);
          if (!clip) return undefined;
          if (![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite) || clip.width <= 0 || clip.height <= 0)
            throw automationError("screenshot-unavailable", { reason: "invalid-capture-clip", clip });
          return { ...clip, scale: fullPage ? 1 : target ? (hires ? viewport.scale : 1) : clip.scale ?? 1 };
        };
        const clip = await wait(readClip());
        guard();
        const format = options.format ?? "jpeg";
        const screenshot = await wait(this.options.command(session.debuggee, "Page.captureScreenshot", {
          format, ...(format === "jpeg" ? { quality: 70 } : {}), fromSurface: true, ...options,
          captureBeyondViewport: Boolean(fullPage || options.captureBeyondViewport), ...(clip ? { clip } : {}),
        }));
        guard();
        let afterClip: Awaited<ReturnType<typeof readClip>>;
        try { afterClip = await wait(readClip()); }
        catch (error) {
          guard();
          if (target && error instanceof AutomationError)
            throw automationError("stale-observation", { reason: "screenshot-target-changed", diagnostic: { code: error.code, ...error.detail } });
          throw error;
        }
        guard();
        if (JSON.stringify(clip) !== JSON.stringify(afterClip))
          throw automationError("stale-observation", { reason: "screenshot-geometry-changed", before: clip, after: afterClip });
        const afterViewport = await wait(this.pageValue(tabId, "({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight,scale:devicePixelRatio})")) as ObservationRecord["viewport"];
        guard();
        if (!sameViewport(viewport, afterViewport))
          throw automationError("stale-observation", { reason: "viewport-changed-during-capture", before: viewport, after: afterViewport });
        if (typeof screenshot?.data !== "string" || !screenshot.data.length)
          throw automationError("screenshot-unavailable", { reason: "missing-image-data" });
        let size = imageSize(screenshot.data, format);
        // Some WebP encodings have no header handled by the small parser.
        // Decode those bytes rather than inventing pixel dimensions.
        if (!size && typeof createImageBitmap === "function") {
          const bytes = Uint8Array.from(atob(screenshot.data), character => character.charCodeAt(0));
          size = await wait(createImageBitmap(new Blob([bytes], { type: `image/${format}` })).then(bitmap => {
            try { guard(); return { width: bitmap.width, height: bitmap.height }; }
            finally { bitmap.close(); }
          }));
        }
        if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0)
          throw automationError("screenshot-unavailable", { reason: "image-dimensions-unavailable", format });
        const width = clip?.width ?? viewport.width; const height = clip?.height ?? viewport.height;
        const scale = size.width / width;
        if (Math.abs(size.height - height * scale) > 1)
          throw automationError("screenshot-unavailable", { reason: "image-geometry-mismatch", viewport, clip, actual: size, expectedHeight: height * scale });
        const image = { ...size, scale, origin: { x: clip ? clip.x - viewport.x : 0, y: clip ? clip.y - viewport.y : 0 } };
        record.image = image;
        result.screenshot = { mediaType: `image/${format}`, data: screenshot.data, ...image };
      }
      guard();
      this.rememberObservation(record);
      return result;
    });
  }

  private deliveredBaselines = new WeakSet<ObservationRecord>();
  /** Compaction removes the model's exact baseline, even while the document lives. */
  resetSnapshotBaselines(): void {
    this.deliveredBaselines = new WeakSet();
    // Invalidate cursors and outstanding delivery leases too: their deltas may
    // refer to page content that compaction removed from the model's context.
    this.inspectionSnapshots.clear();
  }

  private rememberObservation(record: ObservationRecord): void {
    this.observations.delete(record.observationId);
    this.observations.set(record.observationId, record);
    while (this.observations.size > 32) {
      const oldest = this.observations.keys().next().value!;
      this.observations.delete(oldest);
      this.inspectionSnapshots.delete(oldest);
    }
  }

  private clearInspections(tabId: number): void {
    for (const [id, snapshot] of this.inspectionSnapshots) if (snapshot.session.tabId === tabId) this.inspectionSnapshots.delete(id);
  }

  async inspect(tabId: number, options: InspectOptions = {}, region?: LocatorSpec): Promise<Record<string, unknown>> {
    return this.action(tabId, "inspect", region ?? null, async () => {
      if (region) validateLocator(region);
      const session = await this.session(tabId);
      if (options.cursor === undefined) {
        for (const ref of options.recentRefs ?? []) this.touchRef(session, ref);
        this.pruneRefs(session, region);
      }
      let generation = session.generation;
      let frameRevision = session.frameRevision;
      const signal = this.context.signal;
      const conversationId = this.context.conversationId, runId = this.context.logIdentity?.runId ?? this.context.runId;
      let requiredBaseline: InspectSnapshot | undefined;
      const guard = () => {
        throwIfAborted(signal);
        if (this.sessions.get(tabId) !== session || session.generation !== generation) throw automationError("stale-observation", { reason: "document-or-session-changed" });
        if (session.frameRevision !== frameRevision) throw automationError("stale-observation", { reason: "frame-tree-changed-during-inspection" });
        if (requiredBaseline && (this.inspectionSnapshots.get(requiredBaseline.id) !== requiredBaseline
          || this.observations.get(requiredBaseline.id) !== requiredBaseline.record))
          throw automationError("stale-observation", { observationId: requiredBaseline.id, reason: "snapshot-baseline-expired-during-inspection" });
      };
      guard();
      const candidateRefs = new Map((options.recentRefs ?? []).map(id => {
        const binding = this.elementIds.get(id);
        return [id, binding && this.liveId(session, id) && binding.actionable ? session.refs.get(binding.sourceId) : undefined] as const;
      }));
      let candidateContexts: Map<string, CandidateAssociation> | undefined;
      let saved: InspectSnapshot;
      let position: SnapshotPosition;
      if (options.cursor !== undefined) {
        if (region || options.since !== undefined || options.offset !== undefined || options.fields !== undefined || options.depth !== undefined)
          throw automationError("invalid-inspect-cursor", { reason: "cursor-cannot-change-scope" });
        const match = /^([a-f0-9-]+):(\d+):(\d+)$/.exec(options.cursor);
        if (!match || !Number.isSafeInteger(Number(match[2])) || !Number.isSafeInteger(Number(match[3]))) throw automationError("stale-observation", { reason: "invalid-cursor" });
        const snapshot = this.inspectionSnapshots.get(match[1]!);
        if (!snapshot || snapshot.session !== session || snapshot.generation !== generation || snapshot.frameRevision !== session.frameRevision || snapshot.conversationId !== conversationId || snapshot.runId !== runId
          || this.observations.get(snapshot.id) !== snapshot.record)
          throw automationError("stale-observation", { reason: "expired-or-mismatched-cursor" });
        saved = snapshot;
        // No-ref pages continue the same historical observation. Only exposed
        // action references require current geometry before another page is
        // delivered; document, frame and run ownership remain pinned above.
        if (saved.source.some(({ actionable }) => Boolean(actionable)) && !saved.record.readOnly) {
          const currentGeometry = await Promise.all(saved.geometrySources.map(async (debuggee) => ({ debuggee,
            snapshot: await this.options.command(debuggee, "DOMSnapshot.captureSnapshot", { computedStyles: [...saved.geometryStyles], includeDOMRects: true, includePaintOrder: true }) })));
          guard();
          if (await snapshotGeometry(currentGeometry, saved.geometryDynamicParents) !== saved.geometry)
            throw automationError("stale-observation", { reason: "snapshot-geometry-changed" });
        }
        if (this.inspectionSnapshots.get(saved.id) !== saved)
          throw automationError("stale-observation", { reason: "snapshot-context-reset" });
        this.rememberObservation(saved.record);
        position = { index: Number(match[2]), charOffset: Number(match[3]) };
        this.inspectionSnapshots.delete(saved.id); this.inspectionSnapshots.set(saved.id, saved);
      } else {
        const fields = options.fields ?? ["text", "state"];
        const scopeKey = JSON.stringify([region ?? null, fields, options.depth ?? null]);
        const automatic = options.incremental && options.offset === undefined
          ? [...this.inspectionSnapshots.values()].reverse().find((snapshot) => snapshot.session === session
            && snapshot.generation === generation && snapshot.frameRevision === session.frameRevision
            && snapshot.conversationId === conversationId && snapshot.runId === runId
            && snapshot.record.scopeKey === scopeKey && !snapshot.record.incomplete && !snapshot.record.partial
            // Old refs may be retired by this capture. diffSnapshot emits every
            // replacement ref, so only the newly captured result must be live.
            && this.deliveredBaselines.has(snapshot.record))?.record : undefined;
        let previous = options.since ? this.observations.get(options.since) : automatic;
        const pinned = options.since ? this.inspectionSnapshots.get(options.since) : undefined;
        if (options.since && (!previous || !pinned || pinned.conversationId !== conversationId || pinned.runId !== runId
          || pinned.frameRevision !== session.frameRevision || previous.session !== session || previous.tabId !== tabId || previous.documentId !== generation || previous.scopeKey !== scopeKey))
          throw automationError("stale-observation", { observationId: options.since, reason: "document-or-scope-changed" });
        if (options.since) requiredBaseline = pinned;
        const captured = await this.captureReadableSnapshot(session, region);
        throwIfAborted(signal);
        if (this.sessions.get(tabId) !== session) throw automationError("stale-observation", { reason: "document-or-session-changed" });
        if (options.since) guard();
        else this.handoffFreshRootCapture(session, captured);
        if (captured.frameRevision !== session.frameRevision) throw automationError("stale-observation", { reason: "frame-tree-changed-during-inspection" });
        // Capture can restart after a child frame or document change. A fresh
        // inspection belongs to the verified final revision, not necessarily
        // the generation present before capture began. Explicit baselines
        // remain pinned; implicit baselines are discarded on either revision.
        if (!options.since && (generation !== session.generation || frameRevision !== session.frameRevision)) {
          generation = session.generation; frameRevision = session.frameRevision; previous = undefined;
        }
        if (previous && previous.documentId !== session.generation) throw automationError("stale-observation", { observationId: options.since, reason: "document-changed-during-inspection" });
        if (options.since && previous && previous.regionIdentity !== captured.regionIdentity) throw automationError("stale-observation", { observationId: options.since, reason: "region-identity-changed" });
        // Actionable rows retain their own identity even in compact default output.
        const assignedIds = new Set<string>();
        const normalized = expandSnapshot(captured.lines).map(row => {
          const node = row.node;
          if (!node) return row;
          let owned = node.ref ? this.sampledIds.has(node.ref) ? node.ref : `t${tabId}s${session.token}d${generation}${node.ref}` : undefined;
          if (owned && assignedIds.has(owned)) owned += `:${node.id}`;
          if (owned) assignedIds.add(owned);
          const record = node.ref ? session.refs.get(node.ref) : undefined;
          if (owned && record) { session.refs.set(owned, record); (record.aliases ??= new Set()).add(owned); }
          const id = owned ?? `t${tabId}s${session.token}d${generation}:${node.id}`;
          return { ...row, id, node: { ...node, id, ...(owned ? { ref: owned } : {}) } };
        });
        const filtered = normalized.filter(({ node, line }) => options.depth === undefined || (node?.depth ?? (line.match(/^ */)?.[0].length ?? 0) / 2) <= options.depth);
        const independent = fields.includes("ref") || fields.includes("actions");
        const packed = independent ? filtered : packSnapshot(filtered);
        const internalItems: SnapshotItem[] = packed.map(row => {
          const projected = projectSnapshotLine(row, { fields, actionNames: "program", inlineRef: false });
          const { ref: _ref, ...item } = projected;
          return { ...item, ...(row.node?.ref ? { actionable: true as const } : {}) };
        });
        const ids = await this.elementIds.assign(internalItems.map(item => ({ session, generation, owner: JSON.stringify([conversationId, runId]), sourceId: item.id, actionable: item.actionable === true })));
        const wireItems: SnapshotItem[] = internalItems.map((item, index) => {
          const id = ids[index]!, binding = this.elementIds.get(id)!, record = session.refs.get(binding.sourceId);
          if (binding.actionable && record) { session.refs.set(id, record); (record.aliases ??= new Set()).add(id); }
          return { ...item, id };
        });
        const viewport = captured.viewport ?? await this.pageValue(tabId, "({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight,scale:devicePixelRatio})") as ObservationRecord["viewport"];
        guard();
        if (captured.frameRevision !== session.frameRevision) throw automationError("stale-observation", { reason: "frame-tree-changed-during-inspection" });
        const observationId = crypto.randomUUID();
        const baseline = previous && previous.regionIdentity === captured.regionIdentity && previous.frameRevision === captured.frameRevision
          && this.deliveredBaselines.has(previous) && !previous.incomplete && !previous.partial && !captured.partial ? previous : undefined;
        const changes = baseline?.wireItems ? diffSnapshot(baseline.wireItems, wireItems) : undefined;
        const source = changes ?? wireItems;
        const index = options.offset ?? 0;
        if (!Number.isSafeInteger(index) || index < 0 || index > source.length) throw automationError("invalid-offset", { offset: index, total: source.length });
        position = { index, charOffset: 0 };
        const record: ObservationRecord = { session, observationId, tabId, documentId: generation, ...captured, lines: captured.lines, wireItems, viewport, scopeKey, incomplete: true };
        let semanticIndex: ReturnType<typeof semanticContexts> | undefined;
        const contextFor = (id: string) => (semanticIndex ??= semanticContexts(observationId, normalized, packed, wireItems, Boolean(captured.partial)))(id);
        // Session/generation and the guarded frame revision pin debugger and
        // document incarnations. Numeric backend IDs alone are never joined.
        const identityKey = (ref: RefRecord) => JSON.stringify([ref.debuggee.tabId, ref.debuggee.sessionId, ref.generation, ref.frameId, ref.backendNodeId]);
        const capturedRefs = new Map<string, SnapshotLine[]>();
        const hasAutomaticTargets = source.some(item => item.actionable);
        if (candidateRefs.size || hasAutomaticTargets) for (const row of normalized) {
          const ref = row.node?.ref ? session.refs.get(row.node.ref) : undefined;
          if (!ref?.frameId || row.node?.layoutScope !== ref.frameId) continue;
          const key = identityKey(ref), matches = capturedRefs.get(key) ?? [];
          matches.push(row); capturedRefs.set(key, matches);
        }
        candidateContexts = new Map(await Promise.all([...candidateRefs].map(async ([id, candidate]): Promise<[string, CandidateAssociation]> => {
          const unknown = (reason: string, invalid = false): [string, CandidateAssociation] => [id, { context: { status: "unknown", observationId, reason }, ...(invalid ? { invalid: true } : {}) }];
          if (this.liveId(session, id) && this.sampledId(id)) return unknown("sampled-context-unavailable");
          if (!candidate || !this.liveId(session, id) || session.refs.get(this.elementIds.get(id)!.sourceId) !== candidate)
            return unknown("identity-changed", true);
          if (captured.readOnly) return unknown("sampled-context-unavailable");
          if (!candidate.frameId) return unknown("frame-identity-unknown");
          const matches = capturedRefs.get(identityKey(candidate)) ?? [];
          if (!matches.length) {
            // Offscreen and replaced nodes both lack a represented item. Use
            // the existing identity validator to distinguish them, never a
            // replacement locator or another capture.
            try {
              const resolved = await this.resolveRef(session, this.elementIds.get(id)!.sourceId);
              await this.options.command(resolved.ref.debuggee, "Runtime.releaseObject", { objectId: resolved.objectId }).catch(() => undefined);
            } catch { guard(); return unknown("identity-changed", true); }
            guard();
            return unknown("not-represented");
          }
          if (matches.length !== 1) return unknown("ambiguous-snapshot-match");
          return [id, { context: contextFor!(matches[0]!.id) }];
        })));
        guard();
        this.rememberObservation(record);
        const wireSources = new Map(hasAutomaticTargets ? wireItems.map((item, index) => [item.id, packed[index]!.id]) : []);
        const automaticContextFor = (id: string): Record<string, unknown> => {
          const sourceId = wireSources.get(id), binding = this.elementIds.get(id);
          const ref = binding && session.refs.get(binding.sourceId);
          const matches = ref && capturedRefs.get(identityKey(ref));
          if (captured.readOnly || !ref?.frameId || matches?.length !== 1 || matches[0]!.id !== sourceId)
            return { status: "unknown", observationId, reason: "capture-identity-unproved" };
          return contextFor(sourceId!);
        };
        saved = { contextFor: automaticContextFor, id: observationId, session, generation, frameRevision: captured.frameRevision, conversationId, runId, record, source, mode: changes ? "delta" : "full", ...(changes ? { baseObservationId: baseline!.observationId } : {}), geometry: captured.geometry, geometrySources: captured.geometrySources, geometryStyles: captured.geometryStyles, geometryDynamicParents: captured.geometryDynamicParents,
          ...(captured.partial && previous ? { reset: "current-output-partial" } : previous?.partial ? { reset: "previous-output-partial" } : previous?.incomplete ? { reset: "previous-output-truncated" } : {}), expected: position, eligibleForBaseline: index === 0 && !captured.partial };
        this.inspectionSnapshots.set(saved.id, saved);
        while (this.inspectionSnapshots.size > 32) this.inspectionSnapshots.delete(this.inspectionSnapshots.keys().next().value!);
      }
      guard();
      const budget = options.budget ?? options.wire?.maxBytes ?? 12000;
      const advances = Boolean(saved.expected && saved.expected.index === position.index && saved.expected.charOffset === position.charOffset);
      const envelope = (candidate: SnapshotWirePage): Record<string, unknown> => {
        const { page } = candidate;
        const truncated = position.index > 0 || position.charOffset > 0 || page.hasMore;
        const reason = page.reason === "budget" ? "budget" : "slice";
        const baselineComplete = !saved.record.partial && (!saved.record.incomplete || advances && !page.hasMore && saved.eligibleForBaseline);
        const result = { observationId: saved.id, tabId, documentId: generation,
          ...(options.cursor === undefined ? { url: saved.record.url, title: saved.record.title } : { continuation: true }), viewport: saved.record.viewport,
          mode: saved.mode, ...(saved.baseObservationId ? { baseObservationId: saved.baseObservationId } : {}), ...(saved.record.partial ? { partial: true } : {}), ...(saved.record.limitations ? { limitations: saved.record.limitations } : {}), ...(saved.reset ? { reset: saved.reset } : {}),
          items: page.fragments,
          ...(candidate.lookahead ? { lookahead: candidate.lookahead } : {}),
          ...(page.next ? { nextCursor: `${saved.id}:${page.next.index}:${page.next.charOffset}` } : {}),
          truncation: { truncated, total: saved.source.length, returned: page.fragments.length, offset: position.index, charOffset: position.charOffset,
            nextOffset: page.next?.index ?? saved.source.length, nextCharOffset: page.next?.charOffset ?? 0, budget: candidate.budget, used: page.usedBytes,
            ...(candidate.combinedBytes === undefined ? {} : { withLookahead: candidate.combinedBytes }),
            ...(truncated ? { reason, baselineComplete, ...(page.requiredBudget === undefined ? {} : { requiredBudget: page.requiredBudget }) }
              : { baselineComplete }) } };
        // Presentation must not displace a deliverable item or make a minimum
        // page fail: use only the remaining wire allowance, including metadata.
        const allowance = options.wire ? options.wire.maxBytes
          - new TextEncoder().encode(JSON.stringify({ ...result, evidenceId: options.wire.evidenceId })).byteLength
          - ',"actionContexts":'.length : 3072;
        const actionContexts = automaticContexts(page.fragments, saved.contextFor, Math.min(3072, allowance));
        return actionContexts ? { ...result, actionContexts } : result;
      };
      let candidate: SnapshotWirePage;
      try {
        if (options.wire) candidate = selectSnapshotWirePage(saved.source, { budget, limit: options.limit, position, mode: saved.mode, ...options.wire }, envelope);
        else {
          const ordinary = paginateSnapshot(saved.source, { budget, limit: options.limit, position });
          candidate = { ...snapshotLookahead(saved.source, ordinary, { budget, limit: options.limit, position, mode: saved.mode }), budget };
        }
      } catch (error) {
        throw automationError(error instanceof SnapshotWireError ? "snapshot-unavailable" : "stale-observation", { reason: error instanceof SnapshotWireError ? "wire-budget-insufficient" : error instanceof Error ? error.message : String(error) });
      }
      const page = candidate.page;
      if (page.fragments.some((item) => item.actionable && !this.liveId(session, item.id, JSON.stringify([conversationId, runId]))))
        throw automationError("stale-observation", { observationId: saved.id, reason: "reference-identity-changed" });
      for (const item of page.fragments) if (item.actionable) this.touchRef(session, item.id);
      const result = envelope(candidate);
      if (candidateContexts) Object.defineProperty(result, SNAPSHOT_CANDIDATE_CONTEXT, { value: candidateContexts });
      const source = saved.source, record = saved.record;
      const valid = () => this.sessions.get(tabId) === session && session.generation === generation
        && session.frameRevision === saved.frameRevision && this.inspectionSnapshots.get(saved.id) === saved
        && this.observations.get(saved.id) === record && saved.source === source && saved.record === record
        && saved.conversationId === conversationId && saved.runId === runId
        && !page.fragments.some((item) => item.actionable && !this.liveId(session, item.id, JSON.stringify([conversationId, runId])))
        && [...candidateRefs].every(([id, ref]) => !ref || candidateContexts?.get(id)?.invalid || this.liveId(session, id, JSON.stringify([conversationId, runId])) && session.refs.get(this.elementIds.get(id)!.sourceId) === ref);
      const atPosition = () => Boolean(saved.expected && saved.expected.index === position.index && saved.expected.charOffset === position.charOffset);
      const advance = () => { saved.expected = page.next; if (!page.hasMore && saved.eligibleForBaseline) { record.incomplete = false; this.deliveredBaselines.add(record); } };
      if (options.wire || options.deferDelivery) {
        const token = Symbol("inspection-delivery"), shouldAdvance = advances;
        let state: "prepared" | "pending" | "finished" | "canceled" = "prepared";
        const lease: SnapshotDeliveryLease = {
          begin: () => {
            if (state === "pending" || state === "finished") return true;
            if (state !== "prepared" || signal?.aborted || !valid() || saved.delivery || shouldAdvance && !atPosition()) return false;
            saved.delivery = token; state = "pending"; return true;
          },
          finish: () => {
            if (state !== "pending" || saved.delivery !== token) return;
            saved.delivery = undefined; state = "finished";
            if (!valid() || shouldAdvance && !atPosition()) {
              if (this.inspectionSnapshots.get(saved.id) === saved) this.inspectionSnapshots.delete(saved.id);
              if (this.observations.get(saved.id) === record) this.observations.delete(saved.id);
              return;
            }
            if (shouldAdvance) advance();
          },
          cancel: () => { if (state === "pending" && saved.delivery === token) saved.delivery = undefined; if (state !== "finished") state = "canceled"; },
        };
        Object.defineProperty(result, SNAPSHOT_DELIVERY_COMMIT, { value: lease });
      } else if (advances && valid()) {
        if (saved.delivery) throw automationError("stale-observation", { reason: "snapshot-delivery-pending" });
        advance();
      }
      return result;
    });
  }

  async point(tabId: number, observationId: string, x: number, y: number, operation: "click" | "dblclick" | "hover", options: { button?: "left" | "right" | "middle"; modifiers?: string[] } = {}): Promise<Record<string, unknown>> {
    const session = await this.session(tabId);
    return this.action(tabId, operation, null, async () => {
      const observation = this.observations.get(observationId);
      if (!observation || observation.session !== session || observation.tabId !== tabId || observation.documentId !== session.generation) {
        throw automationError("stale-observation", { observationId, reason: "expired-document" });
      }
      if (observation.readOnly) throw automationError("stale-observation", { observationId, reason: "read-only-observation-use-screenshot-for-coordinates" });
      const viewport = await this.pageValue(tabId, "({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight,scale:devicePixelRatio})") as ObservationRecord["viewport"];
      if (viewport.x !== observation.viewport.x || viewport.y !== observation.viewport.y || viewport.width !== observation.viewport.width || viewport.height !== observation.viewport.height || viewport.scale !== observation.viewport.scale) {
        throw automationError("stale-observation", { observationId, reason: "viewport-changed", before: observation.viewport, after: viewport });
      }
      const scale = observation.image?.scale ?? 1;
      const cssX = x / scale + (observation.image?.origin?.x ?? 0); const cssY = y / scale + (observation.image?.origin?.y ?? 0);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > (observation.image?.width ?? viewport.width) || y > (observation.image?.height ?? viewport.height) || cssX < 0 || cssY < 0 || cssX > viewport.width || cssY > viewport.height) {
        throw automationError("invalid-point", { observationId, x, y, viewport });
      }
      const button = options.button ?? "left"; const modifiers = modifierMask(options.modifiers ?? []);
      if (operation === "hover") {
        await this.options.command(session.debuggee, "Input.dispatchMouseEvent", { type: "mouseMoved", x: cssX, y: cssY, modifiers });
      } else {
        const count = operation === "dblclick" ? 2 : 1;
        for (let clickCount = 1; clickCount <= count; clickCount += 1) {
          await this.nativeClick(session.debuggee, { x: cssX, y: cssY, button, modifiers, clickCount });
        }
      }
      return this.afterAction(session);
    });
  }

  async ensureObservation(tabId: number, observationId: string): Promise<void> {
    const session = await this.session(tabId);
    const observation = this.observations.get(observationId);
    if (!observation || observation.session !== session || observation.tabId !== tabId || observation.documentId !== session.generation) {
      throw automationError("stale-observation", { observationId, reason: "expired-document" });
    }
  }

  async keyboard(tabId: number, operation: "press" | "insertText", value: string): Promise<Record<string, unknown>> {
    const session = await this.session(tabId);
    return this.action(tabId, operation, null, async () => {
      if (operation === "press") await this.press(session, value);
      else await this.options.command(session.debuggee, "Input.insertText", { text: value });
      return this.afterAction(session);
    });
  }

  async upload(tabId: number, files: unknown, chooser = this.fileChoosers.get(tabId), dispatch?: () => Promise<void>): Promise<unknown> {
    return this.locatorValue(tabId, chooser ? { queries: [] } : { queries: [{ kind: "css", value: "input[type=file]" }] }, "setInputFiles", [files], chooser, dispatch);
  }

  forgetChooser(source: Debuggee, backendNodeId: number): void {
    const chooser = source.tabId === undefined ? undefined : this.fileChoosers.get(source.tabId);
    if (chooser && chooser.backendNodeId === backendNodeId && chooser.debuggee.sessionId === source.sessionId) this.fileChoosers.delete(source.tabId!);
  }

  currentChooser(source: Debuggee, backendNodeId: number): FileChooserRecord | undefined {
    const chooser = source.tabId === undefined ? undefined : this.fileChoosers.get(source.tabId);
    return chooser && chooser.backendNodeId === backendNodeId && chooser.debuggee.sessionId === source.sessionId ? chooser : undefined;
  }

  async keyState(tabId: number, operation: "keydown" | "keyup", chord: string): Promise<void> {
    if (parseKeyboardChord(chord).modifiers.length) throw automationError("invalid-key", { reason: "key-state-requires-single-key" });
    const session = await this.session(tabId);
    const input = keyboardParams(chord);
    await this.options.command(session.debuggee, "Input.dispatchKeyEvent", { ...input, type: operation === "keydown" ? input.text ? "keyDown" : "rawKeyDown" : "keyUp" });
  }

  async navigate(tabId: number, method: string, params?: object): Promise<unknown> {
    const session = await this.session(tabId);
    return this.action(tabId, method, null, async () => {
      const result = await this.options.command(session.debuggee, method, params);
      if (result?.errorText) throw automationError("navigation-interrupted", { method, errorText: result.errorText, url: (params as { url?: string } | undefined)?.url });
      await this.waitForReady(session);
      return { result, ...(await this.afterAction(session)) };
    });
  }

  async history(tabId: number, delta: -1 | 1): Promise<unknown> {
    const session = await this.session(tabId);
    return this.action(tabId, delta < 0 ? "goBack" : "goForward", null, async () => {
      const history = await this.options.command(session.debuggee, "Page.getNavigationHistory", {});
      const entry = history.entries?.[history.currentIndex + delta];
      if (!entry) return null;
      await this.options.command(session.debuggee, "Page.navigateToHistoryEntry", { entryId: entry.id });
      await this.waitForReady(session);
      return this.afterAction(session);
    });
  }

  async pageValue(tabId: number, expression: string, effect = false): Promise<unknown> {
    const session = await this.session(tabId);
    if (effect) await this.options.onDispatch?.();
    const response = await this.options.command(session.debuggee, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result?.value;
  }

  /** Evaluate through a pure-JSON graph envelope so CDP preserves native values and aliases. */
  async evaluatePage(tabId: number, source: string, arg: unknown): Promise<unknown> {
    const input = encodeLogGraph(arg);
    const expression = `/* surf-wax:evaluate-graph */(async () => {
      const codec = ${EVALUATION_CODEC_FACTORY};
      const argument = codec.decodeLogGraph(${JSON.stringify(input)});
      return codec.encodeLogGraph(await (\n${source}\n)(argument));
    })()`;
    const output = await this.pageValue(tabId, expression, true);
    return decodeLogGraph(output);
  }

  async waitUntil(test: () => Promise<boolean>): Promise<void> {
    while (!await test()) await delay(50, this.context.signal);
  }

  async waitForLoadState(tabId: number, state: "domcontentloaded" | "load" = "load"): Promise<void> {
    const session = await this.session(tabId);
    await this.waitUntil(async () => {
      const generation = session.generation;
      const frame = async () => (await this.options.command(session.debuggee, "Page.getFrameTree", {})).frameTree?.frame as { id?: string; loaderId?: string } | undefined;
      let before: { id?: string; loaderId?: string } | undefined, after: { id?: string; loaderId?: string } | undefined;
      try {
        before = await frame();
        if (!before?.id || !before.loaderId) throw automationError("frame-unavailable", { reason: "missing-root-loader" });
        // A renderer round trip is a synchronization barrier; the returned
        // readyState is not evidence of the lifecycle of document.open().
        await this.pageValue(tabId, "document.readyState");
        after = await frame();
      } catch (error) {
        if (isTransientNavigationError(error)) return false;
        throw error;
      }
      if (this.sessions.get(tabId) !== session) throw automationError("stale-session", { reason: "session-changed-during-load-wait" });
      if (session.generation !== generation || after?.id !== before.id || after.loaderId !== before.loaderId) return false;
      const lifecycle = session.rootLifecycle;
      if (lifecycle && lifecycle.frameId === before.id && lifecycle.loaderId === before.loaderId)
        return state === "domcontentloaded" ? lifecycle.domContentLoaded : lifecycle.load;
      // Chrome can reuse the Document, loader, readyState and navigation
      // timing across document.open(). A late attach also replays the prior
      // lifecycle, so none can prove that the current document is loaded.
      throw automationError("load-state-unknown", { reason: "current-document-init-not-observed", state,
        recovery: "Inspect or verify the required page content, or wait for a navigation observed after attachment." });
    });
  }

  waitForEvent(tabId: number, kind: "dialog" | "popup" | "download" | "filechooser"): Promise<any> {
    throwIfAborted(this.context.signal);
    if (kind === "popup") return new Promise((resolve, reject) => {
      const signal = this.context.signal;
      const event = this.options.chromeApi.tabs.onCreated;
      const cleanup = () => { signal?.removeEventListener("abort", abort); event.removeListener(created as never); };
      const abort = () => { cleanup(); reject(abortError()); };
      const created = (item: chrome.tabs.Tab) => {
        if (item.openerTabId !== tabId) return;
        cleanup();
        resolve(new PageFacade(this, item.id!));
      };
      signal?.addEventListener("abort", abort, { once: true });
      event.addListener(created as never);
    });
    return new Promise((resolve, reject) => {
      const signal = this.context.signal;
      const events = this.waiters.get(tabId) ?? new Map();
      const waiters = events.get(kind) ?? new Set<Waiter>();
      const done = (value: any) => { cleanup(); resolve(kind === "dialog" ? this.dialog(tabId, value) : kind === "filechooser" ? eventWithDispatch({
        isMultiple: () => value.mode === "selectMultiple",
        setFiles: (files: unknown) => this.upload(tabId, files, value),
      }, (operation, args, dispatch) => {
          if (operation !== "setFiles") throw new Error("Unsupported chooser operation");
          return this.upload(tabId, args[0], value, dispatch);
      }) : value); };
      const abort = () => { cleanup(); reject(abortError()); };
      const waiter = { resolve: done, reject: (error: Error) => { cleanup(); reject(error); } };
      const cleanup = () => { waiters.delete(waiter); signal?.removeEventListener("abort", abort); };
      waiters.add(waiter); events.set(kind, waiters); this.waiters.set(tabId, events);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  private dialog(tabId: number, event: any) {
    const respond = async (accept: boolean, promptText?: string, dispatch?: () => Promise<void>) => {
      if (this.options.respondDialog) return this.options.respondDialog(event.surfWaxDialogId, event.source, accept, promptText, dispatch);
      await dispatch?.();
      return this.options.command(event.source ?? { tabId }, "Page.handleJavaScriptDialog", { accept, ...(promptText === undefined ? {} : { promptText }) });
    };
    return eventWithDispatch({
      type: () => event.type,
      message: () => event.message,
      defaultValue: () => event.defaultPrompt,
      accept: (promptText?: string) => respond(true, promptText),
      dismiss: () => respond(false),
    }, (operation, args, dispatch) => {
        if (operation === "accept") return respond(true, args[0] as string | undefined, dispatch);
        if (operation === "dismiss") return respond(false, undefined, dispatch);
        throw new Error("Unsupported dialog operation");
    });
  }

  private resolveWaiters(tabId: number, kind: string, value: unknown): void {
    const waiters = this.waiters.get(tabId)?.get(kind);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter.resolve(value);
  }

  async locatorValue(tabId: number, spec: LocatorSpec, operation: string, args: unknown[] = [], fileChooser?: FileChooserRecord, dispatch?: () => Promise<void>): Promise<unknown> {
    const operationSignal = this.context.signal;
    // Reject malformed keys before locator resolution or focus can have effects.
    if (operation === "press") parseKeyboardChord(String(args[0] ?? ""));
    return this.action(tabId, operation, spec, async () => {
      validateLocator(spec);
      if (operation === "dragTo") {
        if (!LocatorFacade.belongsTo(args[0], this, tabId)) throw automationError("invalid-target", { reason: "cross-tab-drag-target" });
        validateLocator(args[0].spec);
      }
      const session = await this.session(tabId);
      if (operation === "count") return (await this.resolveMetadata(session, spec)).length;
      if (operation === "readElements") return this.readElements(session, spec, args[0] as { offset?: number; limit?: number; attributes?: string[] });
      if (operation === "readCondition") {
        const condition = args[0];
        if (!["text", "value", "visible", "enabled", "editable", "checked"].includes(String(condition))) throw automationError("invalid-condition", { condition });
        const objectId = await this.resolveConditionTarget(session, spec);
        if (!objectId) return { present: false, actual: null };
        const targetSession = this.objectSession(session, objectId);
        let checkTextFrame: (() => Promise<boolean>) | undefined;
        if (condition === "text") {
          checkTextFrame = await this.textFramePaintGuard(session, targetSession, objectId, spec);
          if (!await checkTextFrame()) return { present: true, actual: null };
        } else if (condition === "visible") {
          const frameId = await this.actionFrameId(session, targetSession, objectId, spec);
          if (!await this.frameOwnersVisible(session, frameId, "visibility")) return { present: true, actual: false };
        }
        const observation = await this.callOn(targetSession, objectId, `function(condition) {
          if (!this.isConnected) return { present: false, actual: null };
          let actual, invalidChecked = false;
          if (condition === "text") actual = (${RENDERED_TEXT_SOURCE}).call(this);
          else if (condition === "value") actual = typeof this.value === "string" ? this.value : null;
          else if (condition === "visible") {
            const rect = this.getBoundingClientRect();
            actual = rect.width > 0 && rect.height > 0 && this.checkVisibility({opacityProperty:true,visibilityProperty:true,contentVisibilityAuto:true});
          } else if (condition === "enabled") actual = !(${DISABLED_STATE_SOURCE}).call(this);
          else if (condition === "editable") {
            const kind = (${TEXT_INPUT_KIND_SOURCE}).call(this);
            actual = (${EDITABLE_STATE_SOURCE}).call(this, kind, (${DISABLED_STATE_SOURCE}).call(this));
          } else {
            const state = (${CHECKED_STATE_SOURCE}).call(this);
            actual = state.value;
            invalidChecked = !state.supported || state.value === null;
          }
          if (!this.isConnected) return { present: false, actual: null };
          return { present: true, actual, invalidChecked };
        }`, [condition], condition === "text");
        if (!observation || typeof observation.present !== "boolean" || !Object.hasOwn(observation, "actual"))
          throw automationError("state-unavailable", { reason: "invalid-condition-observation" });
        if (checkTextFrame && !await checkTextFrame()) return { present: observation.present, actual: null };
        if (observation.invalidChecked) throw automationError("invalid-checked-state", { reason: "unsupported-or-indeterminate" });
        if (observation.present && condition === "editable" && typeof observation.actual !== "boolean")
          throw automationError("state-unavailable", { reason: "missing-editable-state" });
        return { present: observation.present, actual: observation.actual };
      }
      if (operation === "waitFor") {
        await this.waitForLocatorState(session, spec, ((args[0] as { state?: WaitState } | undefined)?.state ?? "visible"));
        return this.afterAction(session);
      }
      if (["isVisible", "isEnabled", "isChecked"].includes(operation)) {
        const objectId = await this.resolveOnce(session, spec);
        if (!objectId) {
          if (operation === "isChecked") throw automationError("not-found", { locator: spec, reason: "target-disappeared" });
          return false;
        }
        const state = await this.elementState(this.objectSession(session, objectId), objectId);
        if (operation === "isChecked" && !state.connected) throw automationError("not-found", { locator: spec, reason: "target-disappeared" });
        if (operation === "isChecked" && state.checked === null) throw automationError("invalid-checked-state", { reason: "unsupported-or-indeterminate" });
        return operation === "isVisible" ? state.visible : operation === "isEnabled" ? state.enabled : state.checked;
      }
      if (["textContent", "innerText", "inputValue", "getAttribute"].includes(operation)) {
        const objectId = await this.resolveOne(session, spec);
        const targetSession = this.objectSession(session, objectId);
        if (operation === "innerText") {
          const checkFrame = await this.textFramePaintGuard(session, targetSession, objectId, spec);
          if (!await checkFrame()) throw automationError("text-unavailable", { reason: "frame-not-rendered" });
          const text = await this.callOn(targetSession, objectId, `function(){return (${RENDERED_TEXT_SOURCE}).call(this)}`, [], true);
          if (!await checkFrame()) throw automationError("text-unavailable", { reason: "frame-not-rendered" });
          if (text === null) throw automationError("text-unavailable", { reason: "rendered-text-not-confirmed" });
          return text;
        }
        const property = operation === "inputValue" ? "value" : operation;
        return this.callOn(targetSession, objectId, `function(name){ return name === "getAttribute" ? this.getAttribute(arguments[1]) : this[name]; }`, [property, args[0]]);
      }
      if (operation === "evaluate" || operation === "evaluateImmediate") {
        const objectId = operation === "evaluateImmediate" ? await this.resolveConditionTarget(session, spec) : await this.resolveOne(session, spec);
        if (!objectId) throw automationError("not-found", { locator: spec });
        const targetSession = this.objectSession(session, objectId);
        const source = typeof args[0] === "function" ? String(args[0]) : String(args[0]);
        const input = encodeLogGraph(args[1]);
        const immediate = operation === "evaluateImmediate";
        const declaration = `function(input) {
          const codec = ${EVALUATION_CODEC_FACTORY};
          ${immediate ? 'if (!this.isConnected) return { connected: false };' : ''}
          return (async () => {
            const value = codec.encodeLogGraph(await (\n${source}\n)(this, codec.decodeLogGraph(input)));
            return ${immediate ? '{ connected: true, value }' : 'value'};
          })();
        }`;
        await this.options.onDispatch?.();
        const result = await this.callOn(targetSession, objectId, declaration, [input]);
        if (immediate && !result?.connected) throw automationError("detached", { reason: "bound-target-removed" });
        return decodeLogGraph(immediate ? result.value : result);
      }
      if (operation === "scrollIntoViewIfNeeded") {
        const { objectId, targetSession } = await this.waitActionableLocator(session, spec, false, false, true, false);
        const node = await this.describe(targetSession, objectId);
        await this.options.command(targetSession.debuggee, "DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId });
        return this.afterAction(session);
      }
      if (operation === "focus" || operation === "blur") {
        const objectId = await this.resolveConditionTarget(session, spec);
        if (!objectId) throw automationError("not-found", { locator: spec });
        const targetSession = this.objectSession(session, objectId);
        if (operation === "focus") {
          const node = await this.describe(targetSession, objectId);
          await this.options.onDispatch?.();
          await this.options.command(targetSession.debuggee, "DOM.focus", { backendNodeId: node.backendNodeId });
          await this.assertFocused(targetSession, objectId, operationSignal);
        } else { await this.options.onDispatch?.(); await this.callOn(targetSession, objectId, "function(){ this.blur(); }"); }
        return this.afterAction(session);
      }
      if (operation === "fill" || operation === "clear") {
        const { objectId, targetSession } = await this.waitActionableLocator(session, spec, true, false);
        const value = operation === "clear" ? "" : String(args[0] ?? "");
        const kind = await this.callOn(targetSession, objectId, TEXT_INPUT_KIND_SOURCE);
        if (kind === "detached") throw automationError("detached", { reason: "editable-target-removed" });
        if (kind === "unsupported" || typeof kind !== "string") throw automationError("invalid-editable-target", { reason: "not-a-text-input" });
        if (STRUCTURED_INPUT_TYPES.has(kind)) {
          const fill = async (apply: boolean): Promise<string> => {
            const result = await this.callOn(targetSession, objectId, STRUCTURED_FILL_SOURCE, [kind, value, apply]);
            if (!result || result.error) throw automationError("invalid-input-value", { reason: result?.error ?? "missing-result", type: kind });
            if (typeof result.value !== "string") throw automationError("state-unavailable", { reason: "missing-input-value" });
            return result.value;
          };
          await fill(false);
          let actual = "";
          await this.withFocusedTarget(targetSession, objectId, operationSignal, async (assertFocus) => {
            await assertFocus();
            actual = await fill(true);
          });
          return { ...(await this.afterAction(session)), value: actual };
        }
        await this.withFocusedTarget(targetSession, objectId, operationSignal, async (assertFocus, backendNodeId) => {
          await assertFocus();
          await this.options.command(targetSession.debuggee, "Input.insertText", { text: value, surfWaxTargetBackendNodeId: backendNodeId, surfWaxReplaceSelection: true });
          if (value === "") {
            const result = await this.callOn(targetSession, objectId, `function(){
              if (!this.isConnected) return { connected: false };
              return { connected: true, value: this.localName === 'input' || this.localName === 'textarea' ? this.value : this.textContent };
            }`);
            if (!result?.connected) throw automationError("detached", { reason: "editable-target-removed" });
            if (result.value !== "") throw automationError("value-not-applied", { reason: "input-not-cleared" });
          }
        }, true);
        return this.afterAction(session);
      }
      if (operation === "press" || operation === "pressSequentially") {
        const { objectId, targetSession } = await this.waitActionableLocator(session, spec, operation === "pressSequentially", false, false, operation === "pressSequentially", true);
        if (operation === "pressSequentially") {
          const kind = await this.callOn(targetSession, objectId, TEXT_INPUT_KIND_SOURCE);
          if (kind === "detached") throw automationError("detached", { reason: "editable-target-removed" });
          if (kind !== "text") throw automationError("invalid-editable-target", { reason: STRUCTURED_INPUT_TYPES.has(kind) ? "use-fill-for-structured-input" : "not-a-text-input" });
        }
        await this.withFocusedTarget(targetSession, objectId, operationSignal, async (assertFocus, backendNodeId) => {
          if (operation === "pressSequentially") {
            for (const character of String(args[0] ?? "")) {
              await assertFocus();
              // Physical keys have an unambiguous mapping for printable ASCII.
              // Other text is inserted directly: inventing a keyboard layout or
              // mapping a newline to Enter can change the meaning of the input.
              if (/^[\x20-\x7e]$/.test(character)) await this.press(targetSession, character, operationSignal, assertFocus);
              else await this.options.command(targetSession.debuggee, "Input.insertText", { text: character, surfWaxTargetBackendNodeId: backendNodeId });
            }
          } else { await this.press(targetSession, String(args[0] ?? ""), operationSignal, assertFocus); }
        }, operation === "pressSequentially");
        return this.afterAction(session);
      }
      if (operation === "selectOption") {
        const { objectId, targetSession } = await this.waitActionableLocator(session, spec, false, false);
        const values = Array.isArray(args[0]) ? args[0].map(String) : [String(args[0])];
        // Validate before recording dispatch, and again in the same page task
        // as the mutation: the options can change while dispatch is recorded.
        const select = `function(values, apply){
          if (!(this instanceof HTMLSelectElement)) return { error: 'not-select' };
          if (!this.isConnected) return { error: 'detached' };
          if ((${DISABLED_STATE_SOURCE}).call(this)) return { error: 'select-disabled' };
          const options = [...this.options], selected = [];
          for (const value of values) {
            let matches = options.filter(option => option.value === value);
            if (!matches.length) matches = options.filter(option => option.label === value);
            if (!matches.length) return { error: 'option-not-found', value };
            if (matches.length > 1) return { error: 'ambiguous-option', value };
            const option = matches[0];
            if (option.disabled || (option.parentElement?.localName === 'optgroup' && option.parentElement.disabled))
              return { error: 'option-disabled', value };
            if (!selected.includes(option)) selected.push(option);
          }
          if (!this.multiple && selected.length > 1) return { error: 'multiple-options-for-single-select' };
          if (apply) {
            if (this.multiple) for (const option of options) option.selected = selected.includes(option);
            else this.selectedIndex = selected.length ? options.indexOf(selected[0]) : -1;
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return { selected: [...this.selectedOptions].map(option => option.value) };
        }`;
        const validate = async (apply: boolean) => {
          const result = await this.callOn(targetSession, objectId, select, [values, apply]);
          if (result.error) throw automationError("invalid-option", { reason: result.error, ...(result.value === undefined ? {} : { value: result.value }) });
          return result.selected;
        };
        await validate(false);
        await this.options.onDispatch?.();
        const selected = await validate(true);
        return { selected, ...(await this.afterAction(session)) };
      }
      if (operation === "setInputFiles") {
        const chooser = fileChooser ?? this.fileChoosers.get(tabId);
        const usedChooser = Boolean(chooser && spec.queries.length === 0 && !spec.ref);
        const claim = usedChooser ? this.options.claimChooser?.(chooser!) : undefined;
        let dispatched = false;
        let claimOpen = Boolean(claim);
        try {
        let objectId: string;
        if (usedChooser) {
          const node = await this.options.command(chooser!.debuggee, "DOM.resolveNode", { backendNodeId: chooser!.backendNodeId, objectGroup: "surf-wax-automation" });
          if (!node.object?.objectId) throw automationError("detached", { reason: "file-chooser-node-removed" });
          objectId = node.object.objectId; this.objectDebuggees.set(objectId, chooser!.debuggee);
        } else {
          const resolved = await this.resolveConditionTarget(session, spec);
          if (!resolved) throw automationError("not-found", { locator: spec });
          objectId = resolved;
        }
        const targetSession = this.objectSession(session, objectId);
        const requested = Array.isArray(args[0]) ? args[0] : [args[0]];
        for (const file of requested as any[]) {
          if (!file || typeof file !== "object" || typeof file.name !== "string" || !("text" in file || "base64" in file || "url" in file) || "path" in file) {
            throw new Error("setInputFiles accepts { name, mimeType?, text | base64 | url }; local paths are not supported.");
          }
        }
        // DOM metadata is returned by Chrome, not by author script. Keep the
        // original object binding; a later node/type change remains uncertain
        // once the upload is dispatched and the page-side guard rejects it.
        validateFileUploadTarget(await this.describe(targetSession, objectId), requested.length);
        const files = await Promise.all(requested.map(async (file: any) => {
          if (file?.url) {
            await (dispatch ?? this.options.onDispatch)?.();
            const response = await fetch(file.url, { signal: this.context.signal });
            if (!response.ok) throw new Error(`Could not fetch upload URL: ${response.status}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
            return { name: file.name || new URL(file.url).pathname.split("/").pop() || "file", mimeType: file.mimeType || response.headers.get("content-type") || "application/octet-stream", base64: btoa(binary) };
          }
          return file;
        }));
        claim?.assert();
        await (dispatch ?? this.options.onDispatch)?.();
        claim?.assert();
        throwIfAborted(operationSignal);
        dispatched = true;
        await this.callOn(targetSession, objectId, FILE_UPLOAD_FUNCTION, [files]);
        claim?.finish("handled");
        claimOpen = false;
        if (usedChooser && this.fileChoosers.get(tabId) === chooser) this.fileChoosers.delete(tabId);
        return this.afterAction(session);
        } catch (error) {
          if (claimOpen) claim?.finish(dispatched ? "uncertain" : "not-dispatched");
          if (dispatched && error && typeof error === "object") Object.assign(error, { effectUnknown: true });
          throw error;
        }
      }
      if (operation === "check" || operation === "uncheck") {
        const target = await this.waitActionableLocator(session, spec, false, true);
        const desired = operation === "check";
        const read = () => this.callOn(target.targetSession, target.objectId, `function(){
          if (!this.isConnected) return { connected: false };
          const checked = (${CHECKED_STATE_SOURCE}).call(this);
          return { ...checked, connected: this.isConnected };
        }`) as Promise<{ connected: boolean; supported: boolean; radio: boolean; value: boolean | null }>;
        const checked = await read();
        if (!checked.connected) throw automationError("detached", { reason: "checked-target-removed" });
        if (!checked.supported) throw automationError("invalid-checked-state", { reason: "unsupported" });
        if (checked.radio && checked.value === true && !desired) throw automationError("invalid-state", { reason: "cannot-uncheck-selected-radio" });
        if (checked.value !== desired) await this.pointer(session, spec, "click", {}, target);
        while (true) {
          throwIfAborted(operationSignal);
          const current = await read();
          if (!current.connected) throw automationError("detached", { reason: "checked-target-removed" });
          if (!current.supported) throw automationError("invalid-checked-state", { reason: "unsupported" });
          if (current.value === desired) break;
          await delay(50, operationSignal);
        }
        return this.afterAction(session);
      }
      if (operation === "dragTo") {
        const target = args[0] as LocatorFacade;
        // Resolve both ends before dispatching anything, but measure the source
        // last: scrolling the destination into view invalidates earlier points.
        const destination = await this.waitActionableLocator(session, target.spec, false, true, true, false);
        const from = await this.waitActionableLocator(session, spec, false, true, true, false);
        const start = await this.toRootPoint(session, from.targetSession, from.state);
        const viewport = await this.pageValue(tabId, "({width:innerWidth,height:innerHeight})") as { width: number; height: number };
        const inside = (point: { x: number; y: number }) => Number.isFinite(point.x) && Number.isFinite(point.y)
          && point.x >= 0 && point.y >= 0 && point.x < viewport?.width && point.y < viewport?.height;
        const moved = [{ x: start.x + 10, y: start.y }, { x: start.x - 10, y: start.y }, { x: start.x, y: start.y + 10 }, { x: start.x, y: start.y - 10 }].find(inside);
        if (!inside(start) || !moved) throw automationError("drag-unavailable", { reason: "insufficient-visible-space-to-start-drag" });
        let pressAttempted = false, releaseAttempted = false;
        let point = start;
        try {
          await this.options.command(session.debuggee, "Input.dispatchMouseEvent", { type: "mouseMoved", ...start, button: "none", buttons: 0 });
          pressAttempted = true;
          await this.options.command(session.debuggee, "Input.dispatchMouseEvent", { type: "mousePressed", ...start, button: "left", buttons: 1, clickCount: 1 });
          // Cross the browser's drag threshold before scrolling the destination.
          point = moved;
          await this.options.command(session.debuggee, "Input.dispatchMouseEvent", { type: "mouseMoved", ...moved, button: "left", buttons: 1 });
          const to = await this.waitBoundActionable(session, destination, false);
          const end = await this.toRootPoint(session, to.targetSession, to.state);
          point = end;
          await this.options.command(session.debuggee, "Input.dispatchMouseEvent", { type: "mouseMoved", ...end, button: "left", buttons: 1 });
          // Native HTML drag targets receive dragover on a subsequent move.
          await this.options.command(session.debuggee, "Input.dispatchMouseEvent", { type: "mouseMoved", ...end, button: "left", buttons: 1 });
          releaseAttempted = true;
          await this.options.command(session.debuggee, "Input.dispatchMouseEvent", { type: "mouseReleased", ...end, button: "left", buttons: 0, clickCount: 1 });
        } catch (error) {
          if (pressAttempted && error && typeof error === "object") Object.assign(error, { effectUnknown: true });
          throw error;
        } finally {
          if (pressAttempted && !releaseAttempted) {
            // Cancellation is best effort and can itself have page effects.
            // Do not retry an uncertain release after it was dispatched.
            await this.options.command(session.debuggee, "Input.cancelDragging", {}).catch(() => undefined);
            await this.options.command(session.debuggee, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 }).catch(() => undefined);
          }
        }
        return this.afterAction(session);
      }
      if (["click", "dblclick", "hover"].includes(operation)) {
        await this.pointer(session, spec, operation, args[0] as { button?: "left" | "right" | "middle"; modifiers?: string[] } | undefined);
        return this.afterAction(session);
      }
      throw automationError("unsupported", { operation, locator: spec });
    });
  }

  /** Return a target's border box in root document coordinates for CDP capture. */
  async screenshotClip(tabId: number, spec: LocatorSpec): Promise<{ x: number; y: number; width: number; height: number }> {
    return this.action(tabId, "screenshotClip", spec, async () => {
      validateLocator(spec);
      const session = await this.session(tabId);
      const generation = session.generation;
      const objectId = await this.resolveConditionTarget(session, spec);
      if (!objectId) throw automationError("not-found", { locator: spec, reason: "screenshot-target-not-found" });
      const targetSession = this.objectSession(session, objectId);
      const model = await this.options.command(targetSession.debuggee, "DOM.getBoxModel", { objectId });
      const quad = model?.model?.border as number[] | undefined;
      if (!Array.isArray(quad) || quad.length !== 8 || quad.some((value) => !Number.isFinite(value)))
        throw automationError("not-visible", { reason: "missing-border-quad" });
      const points = await this.toRootPoints(session, targetSession, Array.from({ length: 4 }, (_, index) => ({ x: quad[index * 2]!, y: quad[index * 2 + 1]! })));
      // Page.captureScreenshot accepts only an axis-aligned clip; a rotated or
      // perspective-projected element cannot be represented without including
      // unrelated pixels, so fail instead of returning misleading evidence.
      const tolerance = 0.01;
      const horizontal = (a: typeof points[number], b: typeof points[number]) => Math.abs(a.y - b.y) <= tolerance;
      const vertical = (a: typeof points[number], b: typeof points[number]) => Math.abs(a.x - b.x) <= tolerance;
      const [a, b, c, d] = points as [typeof points[number], typeof points[number], typeof points[number], typeof points[number]];
      if (!(horizontal(a, b) && vertical(b, c) && horizontal(c, d) && vertical(d, a)) &&
          !(vertical(a, b) && horizontal(b, c) && vertical(c, d) && horizontal(d, a)))
        throw automationError("unsupported-screenshot-geometry", { reason: "non-axis-aligned-target" });
      const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
      const x = Math.min(...xs), y = Math.min(...ys), width = Math.max(...xs) - x, height = Math.max(...ys) - y;
      if (!(width > 0 && height > 0)) throw automationError("not-visible", { reason: "empty-border-quad" });
      const scroll = await this.pageValue(tabId, "({x:scrollX,y:scrollY})") as { x: number; y: number };
      if (generation !== session.generation || this.sessions.get(tabId) !== session) throw automationError("stale-observation", { reason: "document-changed-during-capture" });
      return { x: x + scroll.x, y: y + scroll.y, width, height };
    });
  }

  private async session(tabId: number): Promise<Session> {
    let session = this.sessions.get(tabId);
    if (!session) {
      session = {
        tabId,
        token: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
        lifetime: new AbortController(),
        debuggee: { tabId },
        generation: 0,
        nextRef: 1,
        nextSnapshotScope: 1,
        snapshotScopes: new Map(),
        refs: new Map(),
        refsByNode: new Map(),
        refUsage: new Map(),
        frames: new Map(), frameLoaders: new Map(),
        frameReady: new Map(),
        frameParents: new Map(),
        targetParents: new Map(),
        targetSessions: new Map(),
        retiredTargetSessions: new Set(),
        frameRevision: 0,
        frameRefs: new Map(),
        frameRefsById: new Map(),
        rootDocumentRevision: 0,
        observationContexts: new Map(),
      };
      this.sessions.set(tabId, session);
    }
    session.ready ??= (async () => {
      const signal = this.context.signal;
      session!.lifecycleCutoff = undefined;
      session!.rootLifecycle = undefined;
      for (const domain of ["Page", "Runtime", "DOM", "Accessibility"]) await this.options.command(session!.debuggee, `${domain}.enable`, {});
      await this.options.command(session!.debuggee, "Page.setLifecycleEventsEnabled", { enabled: true });
      // CDP may replay lifecycle events from before attachment, potentially
      // delivered late through another process. Only accept events newer than
      // a renderer-provided timestamp in the same monotonic clock domain.
      try {
        await this.options.command(session!.debuggee, "Performance.enable", {});
        const metrics = await this.options.command(session!.debuggee, "Performance.getMetrics", {});
        const cutoff = metrics?.metrics?.find((metric: { name?: string }) => metric.name === "Timestamp")?.value;
        if (typeof cutoff === "number" && Number.isFinite(cutoff)) session!.lifecycleCutoff = cutoff;
      } catch (error) {
        throwIfAborted(signal);
        if (error instanceof Error && error.name === "AbortError") throw error;
      }
      await this.options.command(session!.debuggee, "Target.setAutoAttach", { autoAttach: true, flatten: true, waitForDebuggerOnStart: false, filter: [{ type: "iframe", exclude: false }] });
      const tree = await this.options.command(session!.debuggee, "Page.getFrameTree", {});
      this.recordFrameTree(session!, session!.debuggee, tree?.frameTree);
    })().catch((error) => { session!.ready = undefined; throw error; });
    await session.ready;
    return session;
  }

  /** Reuse the same run-bound frame handle for list_frames and snapshots. */
  private rememberFrameRef(session: Session, frameId: string, debuggee: Debuggee, context: { conversationId?: string; runId?: string }): string {
    const { conversationId, runId } = context;
    const key = JSON.stringify([conversationId, runId, frameId]);
    const previous = session.frameRefsById.get(key);
    const record = previous ? session.frameRefs.get(previous) : undefined;
    if (record && record.generation === session.generation && record.revision === session.frameRevision
      && record.debuggee.tabId === debuggee.tabId && record.debuggee.sessionId === debuggee.sessionId) return previous!;
    if (previous) session.frameRefs.delete(previous);
    const ref = createFrameHandle();
    session.frameRefs.set(ref, { frameId, debuggee, generation: session.generation, revision: session.frameRevision, conversationId, runId });
    session.frameRefsById.set(key, ref);
    return ref;
  }

  /** Capture a bounded page of a stable, run-scoped frame-tree snapshot. */
  async listFrames(tabId: number, options: { cursor?: string; limit?: number } = {}): Promise<Record<string, unknown>> {
    return this.action(tabId, "list_frames", null, async () => {
      const session = await this.session(tabId);
      const generation = session.generation, revision = session.frameRevision;
      const signal = this.context.signal, conversationId = this.context.conversationId, runId = this.context.logIdentity?.runId ?? this.context.runId;
      const limit = options.limit ?? 25;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw automationError("invalid-limit", { limit });
      const guard = () => {
        throwIfAborted(signal);
        if (this.sessions.get(tabId) !== session || session.generation !== generation || session.frameRevision !== revision)
          throw automationError("stale-frames", { reason: "document-or-frame-tree-changed" });
      };
      guard();
      let snapshot: FrameListSnapshot | undefined;
      let offset = 0;
      if (options.cursor !== undefined) {
        const match = /^([a-f0-9-]+):(\d+)$/.exec(options.cursor);
        if (!match || !Number.isSafeInteger(Number(match[2]))) throw automationError("stale-frames", { reason: "invalid-cursor" });
        snapshot = this.frameLists.get(match[1]!); offset = Number(match[2]);
        if (!snapshot || snapshot.session !== session || snapshot.generation !== generation || snapshot.revision !== revision
          || snapshot.conversationId !== conversationId || snapshot.runId !== runId || offset < 0 || offset >= snapshot.frames.length)
          throw automationError("stale-frames", { reason: "expired-or-mismatched-cursor" });
        this.frameLists.delete(snapshot.id); this.frameLists.set(snapshot.id, snapshot);
      } else {
        await Promise.all([...session.frameReady.values()]); guard();
        const sources = [...new Map([session.debuggee, ...session.frames.values()].map((source) => [JSON.stringify(source), source])).values()];
        const trees = await Promise.all(sources.map(async (source) => ({ source, tree: (await this.options.command(source, "Page.getFrameTree", {})).frameTree })));
        guard();
        const frames = new Map<string, { frame: any; parent?: string; source: Debuggee }>();
        const visit = (node: any, source: Debuggee, parent?: string) => {
          if (!node?.frame || typeof node.frame.id !== "string") return;
          const frame = node.frame;
          const knownSource = session.frames.get(frame.id);
          const actual = knownSource?.sessionId ? knownSource : source;
          const old = frames.get(frame.id);
          // The child session's own frame-tree root has more authoritative
          // metadata than the parent's placeholder for an OOPIF.
          if (!old || source.sessionId && source.sessionId === actual.sessionId)
            frames.set(frame.id, { frame, parent: frame.parentId ?? parent ?? session.frameParents.get(frame.id), source: actual });
          for (const child of node.childFrames ?? []) visit(child, source, frame.id);
        };
        for (const { source, tree } of trees) visit(tree, source);
        if (!frames.size) throw automationError("frame-unavailable", { reason: "missing-frame-tree" });
        const refs = new Map<string, string>();
        for (const [frameId, item] of frames) refs.set(frameId, this.rememberFrameRef(session, frameId, item.source, { conversationId, runId }));
        const result = [...frames].map(([frameId, item]) => {
          const frameRef = refs.get(frameId)!;
          const url = String(item.frame.url ?? ""); const name = String(item.frame.name ?? "");
          const metadata = { frameRef, ...(item.parent && refs.has(item.parent) ? { parentFrameRef: refs.get(item.parent) } : {}),
            ...(item.parent && !refs.has(item.parent) ? { parentUnavailable: true } : {}),
            url: url.slice(0, 1024), ...(url.length > 1024 ? { urlTruncated: true } : {}),
            ...(name ? { name: name.slice(0, 160) } : {}), ...(name.length > 160 ? { nameTruncated: true } : {}),
            source: { tabId, ...(item.source.sessionId ? { sessionId: item.source.sessionId } : {}) } };
          return metadata;
        });
        guard();
        snapshot = { id: crypto.randomUUID(), session, generation, revision, conversationId, runId, frames: result };
        this.frameLists.set(snapshot.id, snapshot);
        while (this.frameLists.size > 32) this.frameLists.delete(this.frameLists.keys().next().value!);
      }
      const end = Math.min(offset + limit, snapshot.frames.length);
      guard();
      const hasMore = end < snapshot.frames.length;
      if (!hasMore && options.cursor === undefined) this.frameLists.delete(snapshot.id);
      return { tabId, documentId: generation, total: snapshot.frames.length, frames: snapshot.frames.slice(offset, end), hasMore,
        ...(hasMore ? { nextCursor: `${snapshot.id}:${end}` } : {}) };
    });
  }

  private releaseSearch(snapshot: SearchSnapshot): void {
    this.searches.delete(snapshot.id);
    if (snapshot.group) void this.options.command(snapshot.debuggee, "Runtime.releaseObjectGroup", { objectGroup: snapshot.group }).catch(() => undefined);
  }

  private clearSearches(tabId?: number): void {
    for (const snapshot of this.searches.values()) if (tabId === undefined || snapshot.tabId === tabId) this.releaseSearch(snapshot);
  }

  /** Capture the ordered set of actual nodes once; continuation never re-runs the locator. */
  async findElements(tabId: number, locator: LocatorFacade, options: FindOptions = {}): Promise<Record<string, unknown>> {
    return this.action(tabId, "find_elements", locator.spec, async () => {
      if (!LocatorFacade.belongsTo(locator, this, tabId)) throw automationError("invalid-target", { reason: "cross-tab-locator" });
      validateLocator(locator.spec);
      const session = await this.session(tabId);
      const generation = session.generation;
      const signal = this.context.signal;
      const runId = this.context.logIdentity?.runId ?? this.context.runId;
      const conversationId = this.context.conversationId;
      const key = JSON.stringify(locator.spec);
      const limit = options.limit ?? 25;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw automationError("invalid-limit", { limit });
      const guard = () => {
        throwIfAborted(signal);
        if (this.sessions.get(tabId) !== session || session.generation !== generation) throw automationError("stale-search", { reason: "document-or-session-changed" });
      };
      guard();
      if (options.cursor === undefined) this.pruneRefs(session, locator.spec);
      let snapshot: SearchSnapshot | undefined;
      let offset = 0;
      if (options.cursor !== undefined) {
        const match = /^([a-f0-9-]+):(\d+)$/.exec(options.cursor);
        if (!match || !Number.isSafeInteger(Number(match[2]))) throw automationError("stale-search", { reason: "invalid-cursor" });
        snapshot = this.searches.get(match[1]!);
        offset = Number(match[2]);
        if (!snapshot || snapshot.session !== session || snapshot.generation !== generation || snapshot.tabId !== tabId
          || snapshot.key !== key || snapshot.conversationId !== conversationId || snapshot.runId !== runId
          || offset < 0 || offset >= snapshot.total) throw automationError("stale-search", { reason: "expired-or-mismatched-cursor" });
        // Successful reads update LRU; a stale cursor never revives a snapshot.
        this.searches.delete(snapshot.id); this.searches.set(snapshot.id, snapshot);
      } else {
        const id = crypto.randomUUID();
        const group = `surf-wax-search-${id}`;
        let debuggee = session.debuggee;
        try {
          if (locator.spec.ref && standaloneRef(locator.spec)) {
            if (this.sampledId(locator.spec.ref)) await this.resolveRef(session, locator.spec.ref);
            const item = session.refs.get(locator.spec.ref);
            if (!item || item.generation !== generation) throw automationError("stale-ref", { ref: locator.spec.ref, reason: "expired-document" });
            debuggee = item.debuggee;
            snapshot = { id, tabId, generation, session, key, conversationId, runId, debuggee, total: 1,
              frameId: item.frameId ?? session.rootFrameId, candidates: [{ backendNodeId: item.backendNodeId, role: item.role, name: item.name, debuggee, ref: locator.spec.ref }], group };
          } else {
            const scoped = await this.locatorScope(session, locator.spec);
            try {
            guard(); debuggee = scoped.debuggee;
            if ((!scoped.rootIsElement && this.usesNativeAccessibility(scoped.spec)) || this.hasSemanticQueries(scoped.spec)) {
              const matches: Candidate[] = !scoped.rootIsElement && this.usesNativeAccessibility(scoped.spec)
                ? await this.resolveAccessibility(session, debuggee, scoped.spec, scoped.rootObjectId)
                : await Promise.all((await this.resolveSemantic(session, debuggee, scoped.spec, scoped.rootObjectId, false)).map(async (node) => {
                  const identity = node.role !== undefined && node.name !== undefined ? { role: node.role, name: node.name } : await this.axIdentity(debuggee, node.backendNodeId);
                  return { backendNodeId: node.backendNodeId, debuggee, role: identity?.role ?? "", name: identity?.name ?? "", ...(!identity ? { identityUnavailable: true } : {}) };
                }));
              guard();
              // Freeze full semantic names, so a virtualized node whose visible
              // identity changes between pages cannot silently acquire a new ref.
              // Bound retained metadata independently of the number of matches.
              let remainingIdentityChars = 2_000_000;
              const candidates = matches.map((candidate) => {
                const size = candidate.role.length + candidate.name.length;
                if (size > remainingIdentityChars) return { ...candidate, role: candidate.role.slice(0, 80), name: candidate.name.slice(0, 160), identityUnavailable: true };
                remainingIdentityChars -= size;
                return candidate;
              });
              snapshot = { id, tabId, generation, session, key, conversationId, runId, debuggee, frameId: scoped.frameId, total: candidates.length, candidates, group };
            } else {
              const response = await this.resolveLocator(debuggee, scoped.spec, "nodes", scoped.rootObjectId, group, session);
              guard();
              const arrayId = response?.objectId;
              if (!arrayId) throw automationError("search-unavailable", { reason: "missing-result-array" });
              const size = await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId: arrayId,
                functionDeclaration: "function(){return this.length}", returnByValue: true });
              guard();
              const total = size.result?.value;
              if (!Number.isSafeInteger(total) || total < 0) throw automationError("search-unavailable", { reason: "invalid-result-count" });
              snapshot = { id, tabId, generation, session, key, conversationId, runId, debuggee, frameId: scoped.frameId, total, arrayId, group };
            }
            } finally { scoped.dispose(); }
          }
          this.searches.set(id, snapshot);
          while (this.searches.size > 32) this.releaseSearch(this.searches.values().next().value!);
        } catch (error) {
          void this.options.command(debuggee, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => undefined);
          guard();
          throw error;
        }
      }
      const current = snapshot!;
      const temporary = new Set<string>();
      const pageGuard = () => {
        guard();
        if (this.searches.get(current.id) !== current) throw automationError("stale-search", { reason: "snapshot-evicted" });
      };
      try {
        const end = Math.min(offset + limit, current.total);
        let remainingIdentityChars = 2_000_000;
        let objects: Array<{ objectId?: string; candidate?: Candidate }>;
        if (current.candidates) {
          objects = current.candidates.slice(offset, end).map((candidate) => ({ candidate }));
        } else if (end === offset) objects = [];
        else {
          const slice = await this.options.command(current.debuggee, "Runtime.callFunctionOn", { objectId: current.arrayId,
            functionDeclaration: "function(start,end){return this.slice(start,end)}", arguments: [{ value: offset }, { value: end }],
            returnByValue: false, objectGroup: current.group });
          pageGuard();
          const sliceId = slice.result?.objectId;
          if (!sliceId) throw automationError("search-unavailable", { reason: "missing-page-array" });
          temporary.add(sliceId);
          const context = this.objectContexts.get(current.arrayId!);
          if (context !== undefined) this.objectContexts.set(sliceId, context);
          const properties = await this.options.command(current.debuggee, "Runtime.getProperties", { objectId: sliceId, ownProperties: true });
          pageGuard();
          const byIndex = new Map((properties.result ?? []).filter((property: any) => /^(0|[1-9]\d*)$/.test(property.name)).map((property: any) => [Number(property.name), property.value?.objectId]));
          objects = Array.from({ length: end - offset }, (_, index) => ({ objectId: byIndex.get(index) as string | undefined }));
          for (const { objectId } of objects) if (objectId && context !== undefined) this.objectContexts.set(objectId, context);
        }
        const resolvedObjects = await Promise.allSettled(objects.map(async ({ objectId, candidate }) => {
          pageGuard();
          let nodeObject = objectId;
          if (candidate) {
            if (candidate.identityUnavailable) return { status: "identity-unknown", reason: "identity-budget" };
            if (!candidate.backendNodeId) return { status: "detached" };
            try {
              if (candidate.ref) nodeObject = (await this.resolveRef(session, candidate.ref)).objectId;
              else {
                nodeObject = await this.resolveIsolatedNode(session, current.debuggee, candidate.backendNodeId, current.frameId, current.group);
              }
            } catch (error) { pageGuard(); if (isDetachedNodeError(error)) return { status: "detached" }; throw error; }
          }
          if (!nodeObject) throw automationError("search-unavailable", { reason: "missing-node-object" });
          temporary.add(nodeObject);
          return { objectId: nodeObject, candidate };
        }));
        const nodes = resolvedObjects.flatMap(result => result.status === "fulfilled" && result.value.objectId ? [result.value.objectId] : []);
        const metadataByObject = new Map<string, any>();
        if (nodes.length) {
          pageGuard();
          if (!current.frameId || !await this.frameOwnersVisible(session, current.frameId, "text-paint"))
            throw automationError("text-unavailable", { reason: "frame-not-rendered" });
          // Describe the page in one task; paint evidence must not cross the
          // asynchronous identity/frame checks below or survive to another page.
          const response = await this.renderedCall(session, current.debuggee, { objectId: nodes[0],
            functionDeclaration: `function(includeIdentity,...nodes){const readText=${RENDERED_TEXT_READER_SOURCE};return nodes.map(node => (${SEARCH_META_SOURCE}).call(node,includeIdentity,readText))}`,
            arguments: [{ value: !current.candidates }, ...nodes.map(objectId => ({ objectId }))], returnByValue: true });
          pageGuard();
          if (!await this.frameOwnersVisible(session, current.frameId, "text-paint")) throw automationError("text-unavailable", { reason: "frame-not-rendered" });
          if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
          nodes.forEach((node, index) => metadataByObject.set(node, response.result?.value?.[index]));
        }
        const results = await Promise.allSettled(resolvedObjects.map(async result => {
          if (result.status === "rejected") throw result.reason;
          if (!result.value.objectId) return result.value;
          const { objectId: nodeObject, candidate } = result.value;
          const metadata = metadataByObject.get(nodeObject);
          if (metadata?.connected === false) return { status: "detached" };
          if (metadata?.connected !== true) throw automationError("search-unavailable", { reason: "missing-node-state" });
          let backendNodeId = candidate?.backendNodeId;
          if (!backendNodeId) {
            try { backendNodeId = (await this.options.command(current.debuggee, "DOM.describeNode", { objectId: nodeObject })).node?.backendNodeId; }
            catch (error) { pageGuard(); if (isDetachedNodeError(error)) return { status: "detached" }; throw error; }
          }
          pageGuard();
          if (!Number.isSafeInteger(backendNodeId) || !backendNodeId) throw automationError("search-unavailable", { reason: "missing-backend-node-id" });
          let identitySource: RefRecord["identitySource"] = "dom";
          let identityRole: string, identityName: string;
          if (candidate?.ref) {
            const existing = session.refs.get(candidate.ref);
            if (!existing) throw automationError("stale-ref", { ref: candidate.ref, reason: "expired-document" });
            identitySource = existing.identitySource; identityRole = existing.role; identityName = existing.name;
          } else if (candidate) {
            identitySource = "ax";
            const currentIdentity = await this.axIdentity(current.debuggee, backendNodeId!);
            pageGuard();
            if (!currentIdentity) return { status: "identity-unknown", reason: "identity-unavailable" };
            if (currentIdentity.role !== candidate.role || currentIdentity.name !== semanticName(candidate.name)) return { status: "changed" };
            identityRole = currentIdentity.role; identityName = currentIdentity.name;
          } else {
            if (metadata.identityTooLarge) return { status: "identity-unknown", reason: "identity-budget" };
            if (typeof metadata.identityRole !== "string" || typeof metadata.identityName !== "string") return { status: "identity-unknown", reason: "identity-unavailable" };
            identityRole = metadata.identityRole; identityName = metadata.identityName;
            if (identityRole.length + identityName.length > remainingIdentityChars) return { status: "identity-unknown", reason: "identity-budget" };
            remainingIdentityChars -= identityRole.length + identityName.length;
          }
          let frameId: string | undefined;
          try { frameId = await this.actionFrameId(session, { ...session, debuggee: current.debuggee }, nodeObject); }
          catch { pageGuard(); /* Unproved frame identity is reported by context as unknown. */ }
          pageGuard();
          const roleText = String(candidate?.role ?? metadata.role ?? "");
          const nameText = String(candidate?.name ?? metadata.name ?? "");
          const role = roleText.slice(0, 80), name = nameText.slice(0, 160);
          const scope = current.debuggee.sessionId ?? session.rootFrameId ?? "root";
          const identity = `${scope}:${backendNodeId}`;
          const short = candidate?.ref ?? this.rememberRef(session, identity,
            { backendNodeId: backendNodeId!, frameId, debuggee: current.debuggee, role: identityRole, name: identityName, generation, identitySource });
          const ref = candidate?.ref ?? `t${tabId}s${session.token}d${generation}${short}`;
          const record = session.refs.get(short);
          if (!record) throw automationError("stale-ref", { ref, reason: "expired-document" });
          if (frameId) record.frameId = frameId;
          session.refs.set(ref, record);
          return { ref, role, name, ...(metadata.tag ? { tag: metadata.tag } : {}), ...(metadata.text ? { text: metadata.text } : {}),
            ...(roleText.length > 80 || candidate?.roleTruncated || !candidate && metadata.roleTruncated ? { roleTruncated: true } : {}),
            ...(nameText.length > 160 || candidate?.nameTruncated || !candidate && metadata.nameTruncated ? { nameTruncated: true } : {}), ...(metadata.textTruncated ? { textTruncated: true } : {}) };
        }));
        pageGuard();
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
        const elements = results.map((result) => {
          const value = (result as PromiseFulfilledResult<Record<string, unknown>>).value;
          return typeof value.ref === "string" && !session.refs.has(value.ref) ? { status: "changed" } : value;
        });
        const actionable = elements.filter((item): item is Record<string, unknown> & { ref: string } => typeof item.ref === "string");
        const ids = await this.elementIds.assign(actionable.map(item => ({ session, generation, owner: JSON.stringify([conversationId, runId]),
          sourceId: this.elementIds.get(item.ref)?.sourceId ?? item.ref, actionable: true })));
        pageGuard();
        const exposed = new Map<string, string>();
        actionable.forEach((item, index) => {
          const id = ids[index]!, record = session.refs.get(item.ref);
          if (!record) return;
          session.refs.set(id, record); (record.aliases ??= new Set()).add(id); exposed.set(item.ref, id);
        });
        const shortElements = elements.map(item => typeof item.ref !== "string" ? item
          : exposed.has(item.ref) ? { ...item, ref: exposed.get(item.ref)! } : { status: "changed" });
        const hasMore = end < current.total;
        if (!hasMore && options.cursor === undefined) this.releaseSearch(current);
        return { tabId, documentId: generation, total: current.total, elements: shortElements, hasMore, ...(hasMore ? { nextCursor: `${current.id}:${end}` } : {}) };
      } catch (error) {
        try { pageGuard(); } finally { if (options.cursor === undefined) this.releaseSearch(current); }
        throw error;
      } finally {
        await Promise.all([...temporary].map((objectId) => this.options.command(current.debuggee, "Runtime.releaseObject", { objectId }).catch(() => undefined)));
        guard();
      }
    });
  }

  private touchRef(session: Session, refId: string): void {
    this.elementIds.touch(refId);
    if (!session.refs.has(refId)) return;
    const short = (this.elementIds.get(refId)?.sourceId ?? refId).replace(/^t\d+s[a-f0-9]+d\d+/, "");
    const identity = session.refUsage.get(short);
    if (identity === undefined) return;
    session.refUsage.delete(short);
    session.refUsage.set(short, identity);
  }

  private pruneRefs(session: Session, preserve?: LocatorSpec): void {
    // A whole capture may exceed this soft limit. Never evict during an
    // operation or between pages of the same observation; the next independent
    // capture/search can reclaim older references when the tab is otherwise idle.
    if (preserve) visitLocators(preserve, (current) => { if (current.ref) this.touchRef(session, current.ref); });
    if ((this.activeActions.get(session.tabId) ?? 0) !== 1) return;
    this.elementIds.prune(session);
    if (session.refUsage.size <= 32_768) return;
    while (session.refUsage.size > 24_576) {
      const [short, identity] = session.refUsage.entries().next().value!;
      session.refUsage.delete(short);
      const record = session.refs.get(short);
      if (session.refsByNode.get(identity) === short) session.refsByNode.delete(identity);
      session.refs.delete(short);
      if (record) { session.refs.delete(`t${session.tabId}s${session.token}d${record.generation}${short}`); for (const alias of record.aliases ?? []) session.refs.delete(alias); }
    }
  }

  private rememberRef(session: Session, identity: string, record: RefRecord): string {
    // A DOM-derived identity and an AX-derived identity are different
    // observations; neither may overwrite the other's existing binding.
    record = { ...record, conversationId: this.context.conversationId, runId: this.context.logIdentity?.runId ?? this.context.runId };
    const sourceIdentity = `${identity}\u0000${record.identitySource}\u0000${JSON.stringify([record.conversationId, record.runId])}`;
    const previous = session.refsByNode.get(sourceIdentity);
    const old = previous ? session.refs.get(previous) : undefined;
    if (old && old.backendNodeId === record.backendNodeId && old.generation === record.generation && old.identitySource === record.identitySource
      && old.debuggee.tabId === record.debuggee.tabId && old.debuggee.sessionId === record.debuggee.sessionId
      && (old.frameId === undefined || record.frameId === undefined || old.frameId === record.frameId)
      && old.role === record.role && old.name === record.name) {
      if (old.frameId === undefined && record.frameId !== undefined) old.frameId = record.frameId;
      this.touchRef(session, previous!);
      return previous!;
    }
    if (previous && old) {
      // Retire both aliases rather than retargeting an already issued ref.
      session.refs.delete(previous);
      session.refs.delete(`t${session.tabId}s${session.token}d${old.generation}${previous}`);
      for (const alias of old.aliases ?? []) session.refs.delete(alias);
      session.refUsage.delete(previous);
    }
    const next = `_e${session.nextRef++}`;
    session.refsByNode.set(sourceIdentity, next);
    session.refs.set(next, record);
    session.refUsage.set(next, sourceIdentity);
    return next;
  }

  private async axIdentity(debuggee: Debuggee, backendNodeId: number): Promise<{ role: string; name: string } | undefined> {
    const response = await this.options.command(debuggee, "Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false });
    const node = response?.nodes?.find((item: any) => item.backendDOMNodeId === backendNodeId);
    if (!node || node.ignored) return undefined;
    return { role: axValue(node.role), name: semanticName(axValue(node.name)) };
  }

  private readonly sampledOwners = new WeakMap<Session, { owner: string; ids: Map<string, string> }>();
  private readonly sampledIds = new Map<string, { session: Session; generation: number; key: number; token: string;
    context: ObservationContext; shadow: boolean; bindingKey: string; conversationId?: string; runId?: string }>();

  private async resolveRef(session: Session, refId: string): Promise<{ ref: RefRecord; objectId: string }> {
    const sampled = this.sampledId(refId);
    const sampledRevision = session.rootDocumentRevision;
    const runId = this.context.logIdentity?.runId ?? this.context.runId;
    if (sampled) {
      if (sampled.session !== session || sampled.generation !== session.generation
        || sampled.conversationId !== this.context.conversationId || sampled.runId !== runId
        || session.observationContexts.get(sampled.context.id) !== sampled.context)
        throw automationError("stale-id", { id: refId, reason: "document-context-or-run-changed" });
      const resolved = await this.options.command(session.debuggee, "Runtime.callFunctionOn", {
        executionContextId: sampled.context.id, functionDeclaration: resolveSampledElement.toString(),
        arguments: [{ value: sampled.token }, { value: sampled.key }], returnByValue: false, objectGroup: "surf-wax-automation",
      });
      const objectId = resolved.result?.objectId;
      if (resolved.exceptionDetails || typeof objectId !== "string")
        throw automationError("stale-id", { id: refId, reason: "element-removed-or-identity-changed" });
      try {
        const [description, metadata] = await Promise.all([
          this.options.command(session.debuggee, "DOM.describeNode", { objectId, depth: 1, pierce: true }),
          this.options.command(session.debuggee, "Runtime.callFunctionOn", { objectId, functionDeclaration: `function(token,key){ /* surf-wax:sample-id-metadata */
            if ((${resolveSampledElement.toString()})(token,key)!==this) return null;
            return (${SEARCH_META_SOURCE}).call(this,true);
          }`, arguments: [{ value: sampled.token }, { value: sampled.key }], returnByValue: true }),
        ]);
        const backendNodeId = description.node?.backendNodeId, meta = metadata.result?.value;
        if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0 || Boolean(description.node?.shadowRoots?.length) !== sampled.shadow
          || metadata.exceptionDetails || !meta?.connected || session.rootDocumentRevision !== sampledRevision
          || typeof meta.identityRole !== "string" || typeof meta.identityName !== "string" || meta.identityTooLarge)
          throw automationError("stale-id", { id: refId, reason: "element-identity-unavailable" });
        session.refs.set(refId, { backendNodeId, frameId: session.rootFrameId, debuggee: session.debuggee, generation: session.generation,
          role: meta.identityRole, name: meta.identityName, identitySource: "dom", conversationId: sampled.conversationId, runId: sampled.runId });
      } finally { await this.options.command(session.debuggee, "Runtime.releaseObject", { objectId }).catch(() => undefined); }
    }
    const ref = session.refs.get(refId);
    if (ref && (ref.conversationId !== this.context.conversationId || ref.runId !== runId))
      throw automationError("stale-id", { id: refId, reason: "run-changed" });
    if (!ref && refId.startsWith(`t${session.tabId}s${session.token}d${session.generation}:`))
      throw automationError("not-actionable-id", { id: refId, guidance: "Choose an item with actionable=true, or use find_elements to obtain an element ID." });
    if (!ref || ref.generation !== session.generation) throw automationError("stale-ref", { ref: refId, reason: "expired-document" });
    this.touchRef(session, refId);
    const signal = this.context.signal;
    let objectId: string | undefined, retained = false, released = false;
    const release = () => {
      if (!objectId || released) return;
      released = true; this.objectDebuggees.delete(objectId);
      void this.options.command(ref.debuggee, "Runtime.releaseObject", { objectId }).catch(() => undefined);
    };
    signal?.addEventListener("abort", release, { once: true });
    session.lifetime.signal.addEventListener("abort", release, { once: true });
    try {
      objectId = await this.resolveIsolatedNode(session, ref.debuggee, ref.backendNodeId, ref.frameId);
      if (typeof objectId !== "string" || !objectId) throw automationError("ref-unavailable", { ref: refId, reason: "missing-object-id" });
      throwIfAborted(signal);
      if (session.lifetime.signal.aborted) throw abortError();
      const connected = await this.options.command(ref.debuggee, "Runtime.callFunctionOn", { objectId, functionDeclaration: "function(){ return this.isConnected; }", returnByValue: true });
      if (connected.exceptionDetails) throw new Error(connected.exceptionDetails.exception?.description || connected.exceptionDetails.text || "Could not inspect node connection");
      if (connected.result?.value === false) throw automationError("detached", { ref: refId, reason: "node-removed" });
      if (connected.result?.value !== true) throw automationError("ref-unavailable", { ref: refId, reason: "missing-connection-state" });
      let identity: { role: string; name: string } | undefined;
      if (ref.identitySource === "ax") identity = await this.axIdentity(ref.debuggee, ref.backendNodeId);
      else {
        const result = await this.options.command(ref.debuggee, "Runtime.callFunctionOn", { objectId, functionDeclaration: SEARCH_META_SOURCE, arguments: [{ value: true }], returnByValue: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Could not inspect node identity");
        const value = result.result?.value;
        if (value?.connected === false) throw automationError("detached", { ref: refId, reason: "node-removed" });
        if (value?.identityTooLarge) throw automationError("stale-ref", { ref: refId, reason: "visible-identity-changed" });
        if (value?.connected === true && typeof value.identityRole === "string" && typeof value.identityName === "string")
          identity = { role: value.identityRole, name: value.identityName };
      }
      if (!identity) throw automationError("ref-unavailable", { ref: refId, reason: "identity-unavailable" });
      if (identity.role !== ref.role || identity.name !== ref.name) throw automationError("stale-ref", { ref: refId, reason: "visible-identity-changed" });
      throwIfAborted(signal);
      if (session.lifetime.signal.aborted) throw abortError();
      if (sampled && session.rootDocumentRevision !== sampledRevision)
        throw automationError("stale-id", { id: refId, reason: "shadow-topology-changed-during-resolution" });
      if (this.sessions.get(session.tabId) !== session || session.generation !== ref.generation || session.refs.get(refId) !== ref)
        throw automationError("stale-ref", { ref: refId, reason: "document-or-reference-changed" });
      this.objectDebuggees.set(objectId, ref.debuggee);
      retained = true;
      return { ref, objectId };
    } catch (error) {
      throwIfAborted(signal);
      if (error && typeof error === "object" && "name" in error && error.name === "AbortError") throw error;
      if (isDetachedNodeError(error) && !(error instanceof AutomationError)) throw automationError("detached", { ref: refId, reason: "node-removed" });
      throw error;
    } finally {
      signal?.removeEventListener("abort", release);
      session.lifetime.signal.removeEventListener("abort", release);
      if (!retained) release();
    }
  }

  private hasSemanticQueries(spec: LocatorSpec): boolean {
    let found = false;
    visitLocators(spec, (current) => {
      if (current.queries.some((query) => query.kind === "role" || query.kind === "label")) found = true;
    });
    return found;
  }

  /** Resolve each semantic step through Chrome's accessibility tree, even
   * when it follows a CSS scope, a filter or an element reference. */
  private async resolveSemantic(session: Session, debuggee: Debuggee, spec: LocatorSpec, rootObjectId?: string, keepResults = true): Promise<LocatedNode[]> {
    const owned = new Set<string>();
    const accessibilityReads = new Map<string, Promise<AccessibilityRead>>();
    const rootContext = rootObjectId ? this.objectContexts.get(rootObjectId) : undefined;
    const entry = rootObjectId ? [...this.frameDocuments.values()].find(entry => entry.session === session
      && entry.frame.debuggee.sessionId === debuggee.sessionId && entry.executionContextId === rootContext) : undefined;
    if (rootObjectId && !entry) throw automationError("frame-unavailable", { reason: "missing-semantic-isolated-world" });
    const world = await this.isolatedFrame(session, debuggee, entry?.frame.frameId), guard = world.guard;
    const documentId = rootObjectId ?? world.objectId;
    if (this.objectContexts.get(documentId) !== world.executionContextId)
      throw automationError("stale-frame", { reason: "semantic-world-mismatch" });
    const describe = async (objectId: string, executionContextId?: number): Promise<LocatedNode> => {
      const result = await this.options.command(debuggee, "DOM.describeNode", { objectId }); guard();
      const backendNodeId = result.node?.backendNodeId;
      if (!backendNodeId) throw automationError("detached", { reason: "missing-backend-node" });
      this.objectDebuggees.set(objectId, debuggee);
      if (executionContextId !== undefined) this.objectContexts.set(objectId, executionContextId);
      return { objectId, backendNodeId, ...(executionContextId === undefined ? {} : { executionContextId }) };
    };
    const executionContextId = this.objectContexts.get(documentId);
    if (executionContextId === undefined) throw automationError("frame-unavailable", { reason: "missing-semantic-isolated-world" });
    const unique = (nodes: LocatedNode[]) => {
      const seen = new Set<number>();
      return nodes.filter((node) => !seen.has(node.backendNodeId) && Boolean(seen.add(node.backendNodeId)));
    };
    // Every concurrently requested handle must settle before the ownership
    // set is released, including when an earlier request fails.
    const settleOwned = async <T>(requests: Array<Promise<T>>): Promise<T[]> => {
      let failure: unknown, failed = false;
      const results = await Promise.allSettled(requests.map((request) => request.catch((error) => {
        if (!failed) { failed = true; failure = error; }
        throw error;
      })));
      if (failed) throw failure;
      guard();
      return results.map((result) => (result as PromiseFulfilledResult<T>).value);
    };
    const domStep = async (root: LocatedNode, query: Query): Promise<LocatedNode[]> => {
      const result = await this.resolveLocator(debuggee, { queries: [query] }, "nodes", root.objectId, undefined, session);
      const arrayId = result?.objectId;
      if (!arrayId) throw automationError("state-unavailable", { reason: "missing-result-array" });
      try {
        guard();
        const properties = await this.options.command(debuggee, "Runtime.getProperties", { objectId: arrayId, ownProperties: true });
        const entries = (properties.result ?? []).filter((property: any) => /^(0|[1-9]\d*)$/.test(property.name))
          .sort((a: any, b: any) => Number(a.name) - Number(b.name));
        for (const property of entries) if (property.value?.objectId) owned.add(property.value.objectId);
        guard();
        return await settleOwned(entries.map((property: any) => {
          if (!property.value?.objectId) throw automationError("state-unavailable", { reason: "missing-node-object" });
          owned.add(property.value.objectId);
          return describe(property.value.objectId, root.executionContextId);
        }));
      } finally {
        void this.options.command(debuggee, "Runtime.releaseObject", { objectId: arrayId }).catch(() => undefined);
      }
    };
    const semanticStep = async (root: LocatedNode, query: Query): Promise<LocatedNode[]> => {
      guard();
      const matches = await this.resolveAccessibility(session, debuggee, { queries: [query] }, root.objectId, accessibilityReads); guard();
      return (await settleOwned(matches.filter((candidate) => candidate.backendNodeId && candidate.backendNodeId !== root.backendNodeId).map(async (candidate) => {
        const response = await this.options.command(debuggee, "DOM.resolveNode", { backendNodeId: candidate.backendNodeId, objectGroup: "surf-wax-automation",
          ...(root.executionContextId === undefined ? {} : { executionContextId: root.executionContextId }) });
        const objectId = response.object?.objectId;
        if (!objectId) throw automationError("detached", { reason: "missing-node-object" });
        owned.add(objectId); guard();
        this.objectDebuggees.set(objectId, debuggee);
        if (root.executionContextId !== undefined) this.objectContexts.set(objectId, root.executionContextId);
        return { objectId, backendNodeId: candidate.backendNodeId!, role: candidate.role, name: candidate.name,
          ...(root.executionContextId === undefined ? {} : { executionContextId: root.executionContextId }) };
      })));
    };
    const walk = async (base: LocatedNode, locator: LocatorSpec): Promise<LocatedNode[]> => {
      let current = [base];
      if (locator.ref) {
        const resolved = await this.resolveRef(session, locator.ref);
        owned.add(resolved.objectId); guard();
        if (resolved.ref.debuggee.tabId !== debuggee.tabId || resolved.ref.debuggee.sessionId !== debuggee.sessionId)
          throw automationError("unsupported-target", { reason: "cross-frame-reference-context", ref: locator.ref });
        let refObjectId = resolved.objectId;
        if (base.executionContextId !== undefined) {
          try {
            const rebound = await this.options.command(debuggee, "DOM.resolveNode", { backendNodeId: resolved.ref.backendNodeId,
              executionContextId: base.executionContextId, objectGroup: "surf-wax-automation" });
            refObjectId = rebound.object?.objectId;
            if (!refObjectId) throw new Error("missing-node-object");
            owned.add(refObjectId);
            this.objectContexts.set(refObjectId, base.executionContextId);
          } catch {
            throw automationError("unsupported-target", { reason: "cross-frame-reference-context", ref: locator.ref });
          }
        }
        guard();
        let contained: any;
        try {
          contained = await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId: base.objectId,
            functionDeclaration: "function(node){for(let current=node;current;current=current.parentNode||current.host||null)if(current===this)return node!==this;return false}",
            arguments: [{ objectId: refObjectId }], returnByValue: true });
        } catch (error) {
          if (/same.*(world|context)|different.*(world|context)|different JavaScript world/i.test(error instanceof Error ? error.message : String(error)))
            throw automationError("unsupported-target", { reason: "cross-frame-reference-context", ref: locator.ref });
          throw error;
        }
        guard();
        if (contained.exceptionDetails) throw automationError("unsupported-target", { reason: "cross-frame-reference-context", ref: locator.ref });
        current = contained.result?.value ? [{ objectId: refObjectId, backendNodeId: resolved.ref.backendNodeId, role: resolved.ref.role, name: resolved.ref.name,
          ...(base.executionContextId === undefined ? {} : { executionContextId: base.executionContextId }) }] : [];
      }
      const filter = async (hasText?: string, has?: LocatorSpec) => {
        if (hasText !== undefined && current.length) {
          const text = await this.renderedCall(session, debuggee, { objectId: current[0]!.objectId,
            functionDeclaration: `function(expected,...nodes){const read=${RENDERED_TEXT_READER_SOURCE},normalize=value=>value.replace(/\\s+/g," ").trim().toLowerCase();return nodes.map(node=>{const value=read.call(node);return typeof value==="string"&&normalize(value).includes(normalize(expected))})}`,
            arguments: [{ value: hasText }, ...current.map(node => ({ objectId: node.objectId }))], returnByValue: true });
          guard();
          if (text.exceptionDetails) throw new Error(text.exceptionDetails.exception?.description || text.exceptionDetails.text);
          const mask = text.result?.value;
          if (!Array.isArray(mask) || mask.length !== current.length || mask.some(value => typeof value !== "boolean"))
            throw automationError("text-unavailable", { reason: "invalid-text-filter-observation" });
          current = current.filter((_node, index) => mask[index]);
        }
        const filtered: LocatedNode[] = [];
        for (const node of current) {
          if (has && !(await walk(node, has)).length) continue;
          filtered.push(node);
        }
        guard();
        current = filtered;
      };
      let boundScope: LocatedNode | undefined;
      const guardScope = async () => {
        guard();
        if (!boundScope) return;
        const result = await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId: boundScope.objectId,
          functionDeclaration: "function(){return this.isConnected}", returnByValue: true });
        guard();
        if (result.exceptionDetails || result.result?.value !== true) throw automationError("invalid-scope", { reason: "scope-detached" });
      };
      for (const query of locator.queries) {
        throwIfAborted(this.context.signal);
        await guardScope();
        if (query.kind === "uniqueScope") {
          if (current.length !== 1) throw automationError("invalid-scope", { count: current.length });
          boundScope = current[0];
          await guardScope();
          continue;
        }
        if (query.kind === "filter") { await filter(query.hasText, query.has); continue; }
        if (query.kind === "index") {
          const index = query.index! < 0 ? current.length + query.index! : query.index!;
          current = current[index] ? [current[index]!] : [];
          continue;
        }
        if (query.kind === "frame" || query.kind === "frameRef") throw automationError("unsupported-target", { reason: "frame-inside-filter" });
        const groups = await settleOwned(current.map((node) => query.kind === "role" ? semanticStep(node, query) : domStep(node, query)));
        current = unique(groups.flat());
      }
      await guardScope();
      if (locator.has || locator.hasText !== undefined) await filter(locator.hasText, locator.has);
      await guardScope();
      if (locator.index !== undefined) {
        const index = locator.index < 0 ? current.length + locator.index : locator.index;
        current = current[index] ? [current[index]!] : [];
      }
      guard();
      return current;
    };
    let results: LocatedNode[] = [];
    try {
      const initial = await describe(documentId, executionContextId);
      const current = await walk(initial, spec); guard();
      results = current;
      return results;
    } finally {
      const retained = new Set(keepResults ? results.map((node) => node.objectId) : []);
      for (const objectId of owned) if (!retained.has(objectId)) {
        this.objectDebuggees.delete(objectId);
        void this.options.command(debuggee, "Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
    }
  }

  private async resolveMetadata(session: Session, spec: LocatorSpec): Promise<Candidate[]> {
    if (spec.ref && standaloneRef(spec)) {
      const { ref, objectId } = await this.resolveRef(session, spec.ref);
      try { return [{ role: ref.role, name: ref.name, ref: spec.ref }]; }
      finally {
        this.objectDebuggees.delete(objectId);
        void this.options.command(ref.debuggee, "Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
    }
    const scoped = await this.locatorScope(session, spec);
    try {
      if (!scoped.rootIsElement && this.usesNativeAccessibility(scoped.spec)) return await this.resolveAccessibility(session, scoped.debuggee, scoped.spec, scoped.rootObjectId);
      if (this.hasSemanticQueries(scoped.spec)) return (await this.resolveSemantic(session, scoped.debuggee, scoped.spec, scoped.rootObjectId, false))
        .map((node) => ({ role: node.role ?? "", name: node.name ?? "", backendNodeId: node.backendNodeId, debuggee: scoped.debuggee }));
      return (await this.resolveLocator(scoped.debuggee, scoped.spec, true, scoped.rootObjectId, undefined, session))?.value as Candidate[];
    } finally { scoped.dispose(); }
  }

  private async resolveOne(session: Session, spec: LocatorSpec): Promise<string> {
    let attempt = 0;
    while (true) {
      throwIfAborted(this.context.signal);
      let candidates: Candidate[] = [];
      const resolved = await this.resolveOnce(session, spec, (matches) => { candidates = matches; });
      this.recordAttempt(session, spec, ++attempt, resolved ? "resolved" : "no-candidate", candidates);
      if (resolved) return resolved;
      if (spec.queries.some((query) => query.kind === "uniqueScope")) throw automationError("not-found", { locator: spec, reason: "scoped-target-not-found" });
      await delay(50, this.context.signal);
    }
  }

  /** Resolve once without waiting, keeping the selected node bound to the uniqueness check. */
  private async resolveConditionTarget(session: Session, spec: LocatorSpec): Promise<string | undefined> {
    if (spec.ref && standaloneRef(spec)) return (await this.resolveRef(session, spec.ref)).objectId;
    let scoped: Awaited<ReturnType<AutomationRuntime["locatorScope"]>>;
    try { scoped = await this.locatorScope(session, spec, true); }
    catch (error) {
      if (error instanceof AutomationError && error.code === "frame-not-found") return undefined;
      throw error;
    }
    let resolvedObject: string | undefined;
    try {
    const resolve = async (): Promise<string | undefined> => {
    if (!scoped.rootIsElement && this.usesNativeAccessibility(scoped.spec)) {
      const matches = await this.resolveAccessibility(session, scoped.debuggee, scoped.spec, scoped.rootObjectId);
      this.assertStrict(spec, matches);
      const node = matches[0]?.backendNodeId;
      if (!node) return undefined;
      try {
        const objectId = await this.resolveIsolatedNode(session, scoped.debuggee, node, scoped.frameId);
        if (!objectId) throw automationError("state-unavailable", { reason: "missing-node-object" });
        this.objectDebuggees.set(objectId, scoped.debuggee);
        return objectId;
      } catch (error) {
        if (isDetachedNodeError(error) && !(error instanceof AutomationError)) return undefined;
        throw error;
      }
    }
    if (this.hasSemanticQueries(scoped.spec)) {
      const matches = await this.resolveSemantic(session, scoped.debuggee, scoped.spec, scoped.rootObjectId);
      try { this.assertStrict(spec, matches.map((node) => ({ role: node.role ?? "", name: node.name ?? "" }))); }
      catch (error) {
        for (const { objectId } of matches) {
          this.objectDebuggees.delete(objectId);
          void this.options.command(scoped.debuggee, "Runtime.releaseObject", { objectId }).catch(() => undefined);
        }
        throw error;
      }
      return matches[0]?.objectId;
    }
    return this.resolveDomOnce(session, scoped.debuggee, scoped.spec, scoped.rootObjectId);
    };
    resolvedObject = await resolve(); return resolvedObject;
    } finally { scoped.dispose(resolvedObject); }
  }

  private async resolveDomOnce(session: Session, debuggee: Debuggee, spec: LocatorSpec, rootObjectId?: string, observe?: (matches: Candidate[]) => void): Promise<string | undefined> {
    const result = await this.resolveLocator(debuggee, spec, "nodes", rootObjectId, undefined, session);
    const arrayId = result?.objectId;
    if (!arrayId) throw automationError("state-unavailable", { reason: "missing-result-array" });
    let objectId: string | undefined, retained = false;
    try {
      throwIfAborted(this.context.signal);
      const length = await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId: arrayId,
        functionDeclaration: "function(){return this.length}", returnByValue: true });
      if (length.exceptionDetails) throw new Error(length.exceptionDetails.exception?.description || length.exceptionDetails.text);
      throwIfAborted(this.context.signal);
      const count = length.result?.value;
      if (!Number.isSafeInteger(count) || count < 0) throw automationError("state-unavailable", { reason: "invalid-result-count" });
      if (count > 1) {
        const details = await this.renderedCall(session, debuggee, { objectId: arrayId,
          functionDeclaration: `function(){const readText=${RENDERED_TEXT_READER_SOURCE};return this.slice(0,10).map(element => (${SEARCH_META_SOURCE}).call(element, false, readText))}`, returnByValue: true });
        if (details.exceptionDetails) throw new Error(details.exceptionDetails.exception?.description || details.exceptionDetails.text);
        throwIfAborted(this.context.signal);
        const candidates = Array.isArray(details.result?.value) ? details.result.value : [];
        throw automationError("strict-mode", { locator: spec, count, candidates });
      }
      if (!count) { observe?.([]); return undefined; }
      const first = await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId: arrayId,
        functionDeclaration: "function(){return this[0]}", returnByValue: false, objectGroup: "surf-wax-automation" });
      objectId = first.result?.objectId;
      if (first.exceptionDetails) throw new Error(first.exceptionDetails.exception?.description || first.exceptionDetails.text);
      throwIfAborted(this.context.signal);
      if (!objectId) throw automationError("state-unavailable", { reason: "missing-node-object" });
      this.objectDebuggees.set(objectId, debuggee);
      const context = this.objectContexts.get(arrayId);
      if (context !== undefined) this.objectContexts.set(objectId, context);
      if (observe) {
        const details = await this.renderedCall(session, debuggee, { objectId,
          functionDeclaration: SEARCH_META_SOURCE, arguments: [{ value: false }], returnByValue: true });
        if (details.exceptionDetails) throw new Error(details.exceptionDetails.exception?.description || details.exceptionDetails.text);
        throwIfAborted(this.context.signal);
        const value = details.result?.value;
        if (!value || typeof value.role !== "string" || typeof value.name !== "string")
          throw automationError("state-unavailable", { reason: "missing-node-metadata" });
        observe([value]);
      }
      retained = true; return objectId;
    } finally {
      if (objectId && !retained) {
        this.objectDebuggees.delete(objectId);
        void this.options.command(debuggee, "Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
      void this.options.command(debuggee, "Runtime.releaseObject", { objectId: arrayId }).catch(() => undefined);
    }
  }

  private async resolveOnce(session: Session, spec: LocatorSpec, observe?: (matches: Candidate[]) => void, immediate = false, includeUnbound = false): Promise<string | undefined> {
    if (spec.ref && standaloneRef(spec)) {
      const { ref, objectId } = await this.resolveRef(session, spec.ref);
      observe?.([{ role: ref.role, name: ref.name, ref: spec.ref }]);
      return objectId;
    }
    const scoped = await this.locatorScope(session, spec, immediate);
    let resolvedObject: string | undefined;
    try {
    const resolve = async (): Promise<string | undefined> => {
    if (!scoped.rootIsElement && this.usesNativeAccessibility(scoped.spec)) {
      const matches = await this.resolveAccessibility(session, scoped.debuggee, scoped.spec, scoped.rootObjectId, undefined, includeUnbound);
      observe?.(matches);
      this.assertStrict(spec, matches);
      const match = matches[0];
      if (!match?.backendNodeId) return undefined;
      try {
        return await this.resolveIsolatedNode(session, scoped.debuggee, match.backendNodeId, scoped.frameId);
      } catch (error) {
        if (error && typeof error === "object" && "name" in error && error.name === "AbortError") throw error;
        if (isDetachedNodeError(error) && !(error instanceof AutomationError)) return undefined;
        throw error;
      }
    }
    if (this.hasSemanticQueries(scoped.spec)) {
      const matches = await this.resolveSemantic(session, scoped.debuggee, scoped.spec, scoped.rootObjectId);
      const candidates = matches.map((node) => ({ role: node.role ?? "", name: node.name ?? "", backendNodeId: node.backendNodeId, debuggee: scoped.debuggee }));
      try { observe?.(candidates); this.assertStrict(spec, candidates); }
      catch (error) {
        for (const { objectId } of matches) {
          this.objectDebuggees.delete(objectId);
          void this.options.command(scoped.debuggee, "Runtime.releaseObject", { objectId }).catch(() => undefined);
        }
        throw error;
      }
      return matches[0]?.objectId;
    }
    return this.resolveDomOnce(session, scoped.debuggee, scoped.spec, scoped.rootObjectId, observe);
    };
    resolvedObject = await resolve(); return resolvedObject;
    } finally { scoped.dispose(resolvedObject); }
  }

  private assertStrict(spec: LocatorSpec, matches: Candidate[]): void {
    if (matches.length <= 1) return;
    throw automationError("strict-mode", { locator: spec, count: matches.length, candidates: matches.slice(0, 10) });
  }

  private usesNativeAccessibility(spec: LocatorSpec): boolean {
    return !spec.has && !spec.hasText && spec.queries.length === 1 && spec.queries[0]!.kind === "role";
  }

  /** DOM.getDocument resets Chrome frontend node IDs. Every real request
   * updates this authority; font discovery reuses the existing frontend tree. */
  private async frontendDocument(debuggee: Debuggee, params: { depth: number; pierce?: boolean }): Promise<any> {
    const value = await this.options.command(debuggee, "DOM.getDocument", params);
    const key = JSON.stringify(debuggee), id = value?.root?.nodeId;
    if (!Number.isSafeInteger(id) || id <= 0) {
      this.frontendRoots.delete(key);
      throw automationError("detached", { reason: "missing-document-root" });
    }
    this.frontendRoots.set(key, id); return value;
  }

  private async frontendRoot(debuggee: Debuggee): Promise<number> {
    return this.frontendRoots.get(JSON.stringify(debuggee)) ?? (await this.frontendDocument(debuggee, { depth: 0 })).root.nodeId;
  }

  private async readAccessibilityTree(session: Session, debuggee: Debuggee, world: IsolatedFrameRead): Promise<AccessibilityRead> {
    const entry = [...this.frameDocuments.values()].find(entry => entry.objectId === world.objectId && entry.session === session);
    if (!entry) throw automationError("stale-frame", { reason: "accessibility-document-expired" });
    if (entry.backendNodeId === undefined) {
      const described = await this.options.command(debuggee, "DOM.describeNode", { objectId: world.objectId }); world.guard();
      if (described.node?.nodeType !== 9 || !Number.isSafeInteger(described.node.backendNodeId) || described.node.backendNodeId <= 0)
        throw automationError("frame-unavailable", { reason: "missing-accessibility-document-identity" });
      entry.backendNodeId = described.node.backendNodeId;
    }
    // queryAXTree waits for a renderer lifecycle update and can stall for an
    // offviewport OOPIF. Use a fresh native full-tree read for this query.
    const tree = await this.options.command(debuggee, "Accessibility.getFullAXTree", { frameId: world.frameId }); world.guard();
    if (!Array.isArray(tree?.nodes) || !tree.nodes.length)
      throw automationError("state-unavailable", { reason: "accessibility-tree-unavailable" });
    const nodes = new Map<string, any>();
    const backends = new Map<number, any[]>();
    for (const node of tree.nodes) {
      if (typeof node.nodeId !== "string") throw automationError("state-unavailable", { reason: "invalid-accessibility-tree" });
      const previous = nodes.get(node.nodeId);
      if (previous) {
        // Chrome can serialize the same virtual InlineTextBox twice. Only a
        // byte-identical native fact is idempotent; conflicting IDs stay unknown.
        if (JSON.stringify(previous) !== JSON.stringify(node)) throw automationError("state-unavailable", { reason: "conflicting-accessibility-node" });
        continue;
      }
      nodes.set(node.nodeId, node);
      if (Number.isSafeInteger(node.backendDOMNodeId) && node.backendDOMNodeId > 0) {
        const list = backends.get(node.backendDOMNodeId) ?? []; list.push(node); backends.set(node.backendDOMNodeId, list);
      }
    }
    const documents = (backends.get(entry.backendNodeId!) ?? []).filter(node => axValue(node.role) === "RootWebArea");
    if (documents.length !== 1 || documents[0].frameId && documents[0].frameId !== world.frameId)
      throw automationError("stale-frame", { reason: "accessibility-document-mismatch" });
    return { world, documentBackend: entry.backendNodeId!, documentId: documents[0].nodeId, nodes, backends };
  }

  private async resolveAccessibility(session: Session, debuggee: Debuggee, spec: LocatorSpec, rootObjectId?: string,
    reads?: Map<string, Promise<AccessibilityRead>>, includeUnbound = false): Promise<Candidate[]> {
    const contextId = rootObjectId ? this.objectContexts.get(rootObjectId) : undefined;
    const scopedDocument = rootObjectId ? [...this.frameDocuments.values()].find(entry => entry.session === session
      && entry.frame.debuggee.sessionId === debuggee.sessionId && entry.executionContextId === contextId) : undefined;
    if (rootObjectId && !scopedDocument) throw automationError("frame-unavailable", { reason: "missing-accessibility-scope-world" });
    const world = await this.isolatedFrame(session, debuggee, scopedDocument?.frame.frameId);
    let scopeBackend: number | undefined;
    if (rootObjectId && rootObjectId !== world.objectId) {
      const described = await this.options.command(debuggee, "DOM.describeNode", { objectId: rootObjectId }); world.guard();
      scopeBackend = described.node?.backendNodeId;
      if (!Number.isSafeInteger(scopeBackend) || !scopeBackend || scopeBackend <= 0)
        throw automationError("detached", { reason: "missing-accessibility-scope-identity" });
    }
    // All roots in one semantic query share this frame's current native graph.
    // Nothing is retained for the next query, cursor page or operation.
    let pending = reads?.get(world.frameId);
    if (!pending) { pending = this.readAccessibilityTree(session, debuggee, world); reads?.set(world.frameId, pending); }
    const read = await pending; world.guard(); read.world.guard();
    if (read.world.executionContextId !== world.executionContextId || read.world.objectId !== world.objectId)
      throw automationError("stale-frame", { reason: "accessibility-query-world-changed" });
    scopeBackend ??= read.documentBackend;
    const nodes = read.nodes, roots = read.backends.get(scopeBackend) ?? [];
    let root: any;
    if (roots.length === 1) root = roots[0];
    else if (!roots.length && rootObjectId) {
      // Only Chrome's exact ignored-scope/child links can supply an omitted
      // scope. Do not treat the entire frame as an arbitrary element subtree.
      const partial = await this.options.command(debuggee, "Accessibility.getPartialAXTree", { objectId: rootObjectId, fetchRelatives: false }); world.guard();
      const exact = partial?.nodes?.filter((node: any) => node.backendDOMNodeId === scopeBackend);
      if (exact?.length === 1 && exact[0].ignored === true && !nodes.has(exact[0].nodeId)) root = exact[0];
    }
    if (!root) throw automationError("state-unavailable", { reason: "accessibility-scope-unavailable" });
    if (root.frameId && root.frameId !== world.frameId)
      throw automationError("stale-frame", { reason: "accessibility-scope-frame-mismatch" });
    const included = new Set<string>(), stack: Array<{ id: string; parent?: string }> = [{ id: root.nodeId }], ordered: any[] = [];
    while (stack.length) {
      const { id, parent } = stack.pop()!;
      if (included.has(id)) throw automationError("state-unavailable", { reason: "cyclic-accessibility-scope" });
      const node = id === root.nodeId ? root : nodes.get(id);
      if (!node) throw automationError("state-unavailable", { reason: "incomplete-accessibility-scope" });
      if (node.frameId && node.frameId !== world.frameId || axValue(node.role) === "RootWebArea" && node.nodeId !== read.documentId) continue;
      if (parent !== undefined && node.parentId !== undefined && node.parentId !== parent)
        throw automationError("state-unavailable", { reason: "conflicting-accessibility-parent" });
      included.add(id); ordered.push(node);
      if (["Iframe", "IframePresentational"].includes(axValue(node.role))) continue;
      if (node.childIds !== undefined && (!Array.isArray(node.childIds) || node.childIds.some((id: unknown) => typeof id !== "string")))
        throw automationError("state-unavailable", { reason: "invalid-accessibility-scope" });
      // Native child pre-order preserves queryAXTree's nested index/first/last
      // order; getFullAXTree's serialized array is breadth-first.
      const children = [...new Set<string>(node.childIds ?? [])];
      for (let index = children.length - 1; index >= 0; index--) stack.push({ id: children[index]!, parent: node.nodeId });
    }
    const query = spec.queries[0]!, expected = semanticName(query.name ?? "");
    const equal = (actual: string) => query.exact ? actual === expected : actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
    const matches = ordered.flatMap((node: any): Candidate[] => {
      if (node.ignored || !includeUnbound && (!Number.isSafeInteger(node.backendDOMNodeId) || node.backendDOMNodeId <= 0)) return [];
      const role = axValue(node.role), name = semanticName(axValue(node.name));
      return role === query.value && (query.name === undefined || equal(name)) ? [{ role, name, backendNodeId: node.backendDOMNodeId, debuggee }] : [];
    });
    world.guard(); read.world.guard();
    if (spec.index === undefined) return matches;
    const index = spec.index < 0 ? matches.length + spec.index : spec.index;
    return matches[index] ? [matches[index]!] : [];
  }

  private clearFrameDocuments(tabId?: number, source?: Debuggee, release = true): void {
    for (const [key, document] of this.frameDocuments) {
      if (tabId !== undefined && document.session.tabId !== tabId) continue;
      if (source && document.frame.debuggee.sessionId !== source.sessionId) continue;
      this.frameDocuments.delete(key);
      const objectId = document.objectId;
      document.objectId = undefined;
      if (release && objectId)
        void Promise.resolve().then(() => this.options.command(document.frame.debuggee, "Runtime.releaseObject", { objectId })).catch(() => undefined);
    }
  }

  /** Share the document handle only within the current execution context. */
  private async frameDocument(session: Session, frame: FrameRefRecord, guard: () => void): Promise<string> {
    const key = JSON.stringify([session.tabId, frame.frameId, frame.debuggee.sessionId ?? null]);
    let document = this.frameDocuments.get(key);
    if (document && (document.session !== session || document.frame.generation !== frame.generation || document.frame.revision !== frame.revision)) {
      this.clearFrameDocuments(session.tabId, frame.debuggee);
      document = undefined;
    }
    if (!document) {
      const entry: FrameDocument = { session, frame, promise: undefined as unknown as Promise<string>, paintCacheToken: crypto.randomUUID() };
      const check = () => {
        guard();
        if (this.frameDocuments.get(key) !== entry) throw automationError("stale-frame", { reason: "frame-context-expired" });
      };
      entry.promise = Promise.resolve().then(async () => {
        if (frame.debuggee.sessionId) await session.frameReady.get(frame.debuggee.sessionId);
        check();
        let world: { executionContextId?: number };
        if (frame.frameId === session.rootFrameId && !this.options.observationWorldName) {
          await this.prepareObservationPrimitives(session);
          await this.options.command(frame.debuggee, "Runtime.evaluate", { expression: "void 0", returnByValue: true });
          world = { executionContextId: this.extensionObservationContext(session, frame.frameId)?.id };
        } else world = await this.options.command(frame.debuggee, "Page.createIsolatedWorld", { frameId: frame.frameId, worldName: this.options.observationWorldName ?? "surf-wax-frame" });
        check();
        if (!Number.isSafeInteger(world?.executionContextId)) throw automationError("frame-unavailable", { reason: "missing-execution-context" });
        entry.executionContextId = world.executionContextId;
        const response = await this.options.command(frame.debuggee, "Runtime.evaluate", { expression: "document", contextId: world.executionContextId, returnByValue: false, objectGroup: "surf-wax-automation" });
        if (typeof response.result?.objectId === "string") entry.objectId = response.result.objectId;
        if (entry.objectId) this.objectContexts.set(entry.objectId, world.executionContextId!);
        check();
        if (response.exceptionDetails || !entry.objectId) throw automationError("frame-unavailable", { reason: "missing-frame-document" });
        return entry.objectId;
      }).catch((error) => {
        if (this.frameDocuments.get(key) === entry) this.frameDocuments.delete(key);
        // The evaluation can complete after invalidation or group release.
        const objectId = entry.objectId;
        entry.objectId = undefined;
        if (objectId) void Promise.resolve().then(() => this.options.command(frame.debuggee, "Runtime.releaseObject", { objectId })).catch(() => undefined);
        throw error;
      });
      this.frameDocuments.set(key, entry);
      document = entry;
    }
    const objectId = await document.promise;
    guard();
    if (this.frameDocuments.get(key) !== document) throw automationError("stale-frame", { reason: "frame-context-expired" });
    return objectId;
  }

  /** Reuse the existing document/world lifetime for browser-owned node IDs.
   * No selector is re-run and no author-world getter establishes identity. */
  private async isolatedFrame(session: Session, debuggee: Debuggee, frameId?: string): Promise<IsolatedFrameRead> {
    if (!frameId) {
      const roots = [...session.frames].filter(([id, source]) => source.sessionId === debuggee.sessionId
        && (!session.frameParents.get(id) || session.frames.get(session.frameParents.get(id)!)?.sessionId !== debuggee.sessionId));
      if (roots.length !== 1) throw automationError("frame-unavailable", { reason: "ambiguous-frame-world" });
      frameId = roots[0]![0];
    }
    const source = session.frames.get(frameId), generation = session.generation, revision = session.frameRevision;
    if (!source || source.tabId !== debuggee.tabId || source.sessionId !== debuggee.sessionId)
      throw automationError("frame-unavailable", { reason: "frame-world-mismatch" });
    const guard = () => {
      throwIfAborted(this.context.signal); throwIfAborted(session.lifetime.signal);
      if (this.sessions.get(session.tabId) !== session || session.generation !== generation || session.frameRevision !== revision)
        throw automationError("stale-frame", { reason: "frame-world-changed" });
    };
    const objectId = await this.frameDocument(session, { frameId, debuggee, generation, revision,
      conversationId: this.context.conversationId, runId: this.context.logIdentity?.runId ?? this.context.runId }, guard);
    const executionContextId = this.objectContexts.get(objectId);
    if (executionContextId === undefined) throw automationError("frame-unavailable", { reason: "missing-isolated-world" });
    const key = JSON.stringify([session.tabId, frameId, debuggee.sessionId ?? null]), entry = this.frameDocuments.get(key);
    const check = () => {
      guard();
      if (!entry || this.frameDocuments.get(key) !== entry || entry.objectId !== objectId || entry.executionContextId !== executionContextId
        || this.objectContexts.get(objectId) !== executionContextId)
        throw automationError("stale-frame", { reason: "isolated-world-expired" });
    };
    check(); return { objectId, executionContextId, frameId, guard: check };
  }

  private async resolveIsolatedNode(session: Session, debuggee: Debuggee, backendNodeId: number, frameId?: string, objectGroup = "surf-wax-automation"): Promise<string> {
    const { executionContextId, guard } = await this.isolatedFrame(session, debuggee, frameId);
    const response = await this.options.command(debuggee, "DOM.resolveNode", { backendNodeId, executionContextId, objectGroup });
    const objectId = response.object?.objectId;
    try { guard(); } catch (error) {
      if (typeof objectId === "string") await this.options.command(debuggee, "Runtime.releaseObject", { objectId }).catch(() => undefined);
      throw error;
    }
    if (typeof objectId !== "string") throw automationError("frame-unavailable", { reason: "isolated-node-unavailable" });
    this.objectDebuggees.set(objectId, debuggee); this.objectContexts.set(objectId, executionContextId);
    return objectId;
  }

  private async locatorScope(session: Session, spec: LocatorSpec, immediate = false): Promise<{ debuggee: Debuggee; frameId?: string; spec: LocatorSpec; rootObjectId?: string; rootIsElement?: boolean; dispose: (transferObjectId?: string) => void }> {
    let debuggee = session.debuggee;
    let frameId = session.rootFrameId;
    let scoped = spec;
    let rootObjectId: string | undefined;
    let rootIsElement = false;
    const signal = this.context.signal;
    let ownedRoot: { objectId: string; debuggee: Debuggee } | undefined;
    let transferred = false;
    const releaseRoot = () => {
      if (!ownedRoot) return;
      const { objectId, debuggee: owner } = ownedRoot; ownedRoot = undefined;
      this.objectDebuggees.delete(objectId);
      void this.options.command(owner, "Runtime.releaseObject", { objectId }).catch(() => undefined);
    };
    signal?.addEventListener("abort", releaseRoot, { once: true });
    session.lifetime.signal.addEventListener("abort", releaseRoot, { once: true });
    const dispose = (transferObjectId?: string) => {
      signal?.removeEventListener("abort", releaseRoot);
      session.lifetime.signal.removeEventListener("abort", releaseRoot);
      if (ownedRoot?.objectId === transferObjectId) ownedRoot = undefined;
      releaseRoot();
    };
    try {
    if (spec.ref) {
      const resolved = await this.resolveRef(session, spec.ref);
      debuggee = resolved.ref.debuggee;
      frameId = resolved.ref.frameId ?? session.rootFrameId;
      rootObjectId = resolved.objectId;
      ownedRoot = { objectId: rootObjectId, debuggee };
      throwIfAborted(signal);
      if (session.lifetime.signal.aborted) throw abortError();
      rootIsElement = true;
      scoped = { ...scoped, ref: undefined };
    }
    const frameRefIndex = scoped.queries.findIndex((query) => query.kind === "frameRef");
    if (frameRefIndex >= 0) {
      if (rootIsElement || frameRefIndex !== 0) throw automationError("invalid-target", { reason: "frame-ref-must-be-root" });
      const ref = scoped.queries[0]!.value;
      const frame = session.frameRefs.get(ref);
      if (!frame || frame.generation !== session.generation || frame.revision !== session.frameRevision
        || frame.conversationId !== this.context.conversationId || frame.runId !== (this.context.logIdentity?.runId ?? this.context.runId)) throw automationError("stale-frame", { ref });
      const guard = () => {
        throwIfAborted(this.context.signal);
        if (this.sessions.get(session.tabId) !== session || session.frameRefs.get(ref) !== frame || frame.generation !== session.generation || frame.revision !== session.frameRevision)
          throw automationError("stale-frame", { ref });
      };
      debuggee = frame.debuggee;
      frameId = frame.frameId;
      try {
        rootObjectId = await this.frameDocument(session, frame, guard);
      } catch (error) {
        guard();
        if (error instanceof AutomationError) throw error;
        throw automationError("frame-unavailable", { ref, reason: error instanceof Error ? error.message : String(error) });
      }
      scoped = { ...scoped, queries: scoped.queries.slice(1) };
    }
    let scanFrom = 0;
    while (true) {
      const frameIndex = scoped.queries.findIndex((query, index) => index >= scanFrom && query.kind === "frame");
      if (frameIndex < 0) {
        let readsText = false;
        visitLocators(scoped, locator => {
          if (locator.hasText !== undefined || locator.queries.some(query => query.kind === "text" || query.hasText !== undefined)) readsText = true;
        });
        if (readsText && (!frameId || !await this.frameOwnersVisible(session, frameId, "text-paint")))
          throw automationError("text-unavailable", { reason: "frame-not-rendered" });
        transferred = true;
        return { debuggee, frameId, spec: scoped, ...(rootObjectId ? { rootObjectId } : {}), ...(rootIsElement ? { rootIsElement } : {}), dispose };
      }
      const frame = scoped.queries[frameIndex]!;
      const ownerSpec: LocatorSpec = { queries: [...scoped.queries.slice(0, frameIndex), { ...frame, kind: "css" }] };
      let ownerId: string | undefined;
      if (this.hasSemanticQueries(ownerSpec)) {
        do {
          const matches = await this.resolveSemantic(session, debuggee, ownerSpec, rootObjectId);
          try {
            throwIfAborted(signal);
            if (session.lifetime.signal.aborted) throw abortError();
            this.assertStrict(ownerSpec, matches.map((node) => ({ role: node.role ?? "", name: node.name ?? "" })));
          } catch (error) {
            for (const { objectId } of matches) {
              this.objectDebuggees.delete(objectId);
              void this.options.command(debuggee, "Runtime.releaseObject", { objectId }).catch(() => undefined);
            }
            throw error;
          }
          ownerId = matches[0]?.objectId;
          if (!ownerId && !immediate) await delay(50, this.context.signal);
        } while (!ownerId && !immediate);
      } else ownerId = immediate ? await this.resolveDomOnce(session, debuggee, ownerSpec, rootObjectId) : await this.resolveDirect(debuggee, ownerSpec, rootObjectId, session);
      if (!ownerId) throw automationError("frame-not-found", { locator: ownerSpec });
      const ownerDebuggee = debuggee;
      let ownerReleased = false;
      const releaseOwner = () => {
        if (ownerReleased) return;
        ownerReleased = true; this.objectDebuggees.delete(ownerId!);
        void this.options.command(ownerDebuggee, "Runtime.releaseObject", { objectId: ownerId }).catch(() => undefined);
      };
      signal?.addEventListener("abort", releaseOwner, { once: true });
      session.lifetime.signal.addEventListener("abort", releaseOwner, { once: true });
      let owner: any;
      try {
        throwIfAborted(signal);
        if (session.lifetime.signal.aborted) throw abortError();
        owner = (await this.options.command(ownerDebuggee, "DOM.describeNode", { objectId: ownerId })).node;
        throwIfAborted(signal);
        if (session.lifetime.signal.aborted) throw abortError();
      } finally {
        signal?.removeEventListener("abort", releaseOwner);
        session.lifetime.signal.removeEventListener("abort", releaseOwner);
        releaseOwner();
      }
      const child = owner?.frameId ? session.frames.get(owner.frameId) : undefined;
      if (owner?.frameId) frameId = owner.frameId;
      if (owner?.frameId && (!child?.sessionId || child.sessionId === debuggee.sessionId)) {
          const revision = session.frameRevision, generation = session.generation;
          const frame: FrameRefRecord = { frameId: owner.frameId, debuggee, generation, revision,
            conversationId: this.context.conversationId, runId: this.context.logIdentity?.runId };
          const guard = () => {
            throwIfAborted(this.context.signal);
            if (this.sessions.get(session.tabId) !== session || session.generation !== generation || session.frameRevision !== revision)
              throw automationError("stale-frame", { reason: "frame-tree-changed" });
          };
          try {
            // An isolated world can reach a same-process sandboxed or
            // cross-origin document even when contentDocument is unavailable.
            rootObjectId = await this.frameDocument(session, frame, guard);
          } catch (error) {
            throwIfAborted(this.context.signal);
            const changed = this.sessions.get(session.tabId) === session && (session.generation !== generation || session.frameRevision !== revision);
            const message = error instanceof Error ? error.message : String(error);
            const awaitingTarget = /(?:no frame (?:with|for) (?:the )?given id|frame with the given id does not belong|cannot find (?:default )?(?:execution )?context)/i.test(message);
            if (!immediate && (changed || awaitingTarget)) { await delay(50, this.context.signal); continue; }
            if (awaitingTarget) throw automationError("frame-unavailable", { reason: "frame-target-not-attached" });
            throw error;
          }
          rootIsElement = false;
          scoped = { ...scoped, queries: scoped.queries.slice(frameIndex + 1) };
          scanFrom = 0;
          continue;
      }
      if (!child?.sessionId) throw automationError("frame-unavailable", { reason: "missing-frame-id" });
      await session.frameReady.get(child.sessionId);
      debuggee = child;
      rootObjectId = undefined;
      rootIsElement = false;
      scoped = { ...scoped, queries: scoped.queries.slice(frameIndex + 1) };
      scanFrom = 0;
    }
    } finally { if (!transferred) dispose(); }
  }

  private async resolveLocator(debuggee: Debuggee, spec: LocatorSpec, metadata: boolean | "nodes", rootObjectId?: string, objectGroup = "surf-wax-automation", session?: Session): Promise<any> {
    if (!session) throw automationError("invalid-target", { reason: "missing-reference-session" });
    const root = rootObjectId ? { objectId: rootObjectId, executionContextId: this.objectContexts.get(rootObjectId) }
      : await this.isolatedFrame(session, debuggee);
    if (root.executionContextId === undefined) throw automationError("frame-unavailable", { reason: "missing-locator-isolated-world" });
    const keys: string[] = [];
    visitLocators(spec, nested => { if (nested !== spec && nested.ref && !keys.includes(nested.ref)) keys.push(nested.ref); });
    const objects = await Promise.all(keys.map(async key => {
      const resolved = await this.resolveRef(session, key);
      if (resolved.ref.debuggee.tabId !== debuggee.tabId || resolved.ref.debuggee.sessionId !== debuggee.sessionId)
        throw automationError("unsupported-target", { reason: "cross-frame-reference-context", ref: key });
      const rebound = await this.options.command(debuggee, "DOM.resolveNode", { backendNodeId: resolved.ref.backendNodeId,
        executionContextId: root.executionContextId, objectGroup });
      if (!rebound.object?.objectId) throw automationError("unsupported-target", { reason: "cross-frame-reference-context", ref: key });
      this.objectContexts.set(rebound.object.objectId, root.executionContextId!);
      return rebound.object.objectId;
    }));
    let response: any;
    try {
      response = await this.renderedCall(session, debuggee, { objectId: root.objectId,
        functionDeclaration: `function(spec,metadata,keys,...nodes){return (${RESOLVER_SOURCE})(spec,metadata,this,Object.fromEntries(keys.map((key,index)=>[key,nodes[index]])))}`,
        arguments: [{ value: spec }, { value: metadata }, { value: keys }, ...objects.map(objectId => ({ objectId }))], returnByValue: metadata === true, objectGroup });
    } catch (error) {
      if (/same.*(world|context)|different.*(world|context)|different JavaScript world/i.test(error instanceof Error ? error.message : String(error)))
        throw automationError("unsupported-target", { reason: "cross-frame-reference-context" });
      throw error;
    }
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    if (response.result?.objectId) this.objectContexts.set(response.result.objectId, root.executionContextId);
    return response.result;
  }

  private async resolveDirect(debuggee: Debuggee, spec: LocatorSpec, rootObjectId: string | undefined, session: Session): Promise<string> {
    while (true) {
      throwIfAborted(this.context.signal);
      const objectId = await this.resolveDomOnce(session, debuggee, spec, rootObjectId);
      if (objectId) return objectId;
      await delay(50, this.context.signal);
    }
  }

  private async evaluateIn(debuggee: Debuggee, expression: string): Promise<unknown> {
    const response = await this.options.command(debuggee, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result?.value;
  }

  private objectSession(session: Session, objectId: string): Session {
    const debuggee = this.objectDebuggees.get(objectId);
    return debuggee ? { ...session, debuggee } : session;
  }

  private async describe(session: Session, objectId: string): Promise<any> {
    return (await this.options.command(session.debuggee, "DOM.describeNode", { objectId })).node;
  }

  private async readElements(session: Session, spec: LocatorSpec, options: { offset?: number; limit?: number; attributes?: string[] } = {}): Promise<unknown> {
    const offset = options.offset ?? 0, limit = options.limit ?? 25, attributes = options.attributes ?? [];
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || !Array.isArray(attributes) || attributes.length > 20 || attributes.some(name => typeof name !== "string" || !name))
      throw automationError("invalid-input", { reason: "invalid-element-page" });
    const scoped = await this.locatorScope(session, spec), group = `surf-wax-element-read:${crypto.randomUUID()}`;
    const checkFrame = async () => {
      if (!scoped.frameId || !await this.frameOwnersVisible(session, scoped.frameId, "text-paint"))
        throw automationError("text-unavailable", { reason: "frame-not-rendered" });
    };
    try {
      await checkFrame();
      let objectId: string, args: Array<{ value?: unknown; objectId?: string }>, total: number | undefined;
      const declaration = `function(offset,limit,attributes,fromArray,total,...nodes){
        const elements=fromArray?this:nodes;total=fromArray?elements.length:total;
        const selected=fromArray?elements.slice(offset,offset+limit):elements,read=${RENDERED_TEXT_READER_SOURCE};
        if(selected.some(element=>element.ownerDocument!==document))return {total,items:[]};
        const items=selected.map((element,index)=>({index:offset+index,text:read.call(element),attributes:Object.fromEntries(attributes.map(name=>[name,element.getAttribute(name)]))}));
        return {total,items,...(offset+items.length<total?{nextOffset:offset+items.length}:{})};
      }`;
      if ((!scoped.rootIsElement && this.usesNativeAccessibility(scoped.spec)) || this.hasSemanticQueries(scoped.spec)) {
        const nodes = !scoped.rootIsElement && this.usesNativeAccessibility(scoped.spec)
          ? await this.resolveAccessibility(session, scoped.debuggee, scoped.spec, scoped.rootObjectId)
          : await this.resolveSemantic(session, scoped.debuggee, scoped.spec, scoped.rootObjectId, false);
        total = nodes.length;
        const objects: string[] = [];
        for (const node of nodes.slice(offset, offset + limit)) {
          if (!node.backendNodeId) throw automationError("text-unavailable", { reason: "missing-element-identity" });
          objects.push(await this.resolveIsolatedNode(session, scoped.debuggee, node.backendNodeId, scoped.frameId, group));
        }
        if (!objects.length) return { total, items: [] };
        objectId = objects[0]!;
        args = [{ value: offset }, { value: limit }, { value: attributes }, { value: false }, { value: total }, ...objects.map(objectId => ({ objectId }))];
      } else {
        const array = await this.resolveLocator(scoped.debuggee, scoped.spec, "nodes", scoped.rootObjectId, group, session);
        if (!array?.objectId) throw automationError("text-unavailable", { reason: "missing-element-page" });
        objectId = array.objectId;
        args = [{ value: offset }, { value: limit }, { value: attributes }, { value: true }, { value: 0 }];
      }
      const response = await this.renderedCall(session, scoped.debuggee, {
        objectId, functionDeclaration: declaration, arguments: args, returnByValue: true,
      });
      await checkFrame();
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      const value = response.result?.value;
      if (!value || !Number.isSafeInteger(value.total) || value.total < 0 || !Array.isArray(value.items)
        || value.items.length !== Math.min(limit, Math.max(0, value.total - offset))
        || value.items.some((item: any, index: number) => item.index !== offset + index || typeof item.text !== "string")
        || (offset + value.items.length < value.total ? value.nextOffset !== offset + value.items.length : value.nextOffset !== undefined))
        throw automationError("text-unavailable", { reason: "rendered-element-text-not-confirmed" });
      return value;
    } finally {
      scoped.dispose();
      await this.options.command(scoped.debuggee, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => undefined);
    }
  }

  /** Only synchronous, side-effect-free text queries enter this path. Missing
   * native roots/marker evidence requests real dependencies, never input replay. */
  private async renderedCall(session: Session, debuggee: Debuggee, params: any): Promise<any> {
    const token = crypto.randomUUID(), generation = session.generation, revision = session.frameRevision;
    const { signal, deadlineAt } = this.context;
    const contextId = this.objectContexts.get(params.objectId);
    const entry = [...this.frameDocuments.values()].find(entry => entry.session === session
      && entry.frame.debuggee.sessionId === debuggee.sessionId && entry.executionContextId === contextId);
    const entryObjectId = entry?.objectId;
    let shadowRevision: number | undefined;
    let nativeRoots: Array<{ objectId: string }> | undefined, completeRoots = false, nativeGroupUsed = false;
    const nativeGroup = `surf-wax-text-roots:${token}`;
    const guard = () => {
      throwIfAborted(signal); throwIfAborted(session.lifetime.signal);
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw new DOMException("Operation timed out", "TimeoutError");
      if (this.sessions.get(session.tabId) !== session || session.generation !== generation || session.frameRevision !== revision)
        throw automationError("text-unavailable", { reason: "document-changed-during-text-read" });
      if (shadowRevision !== undefined && (!entry || !entryObjectId || contextId === undefined
        || ![...this.frameDocuments.values()].includes(entry) || entry.objectId !== entryObjectId || entry.executionContextId !== contextId
        || (entry.shadowRevision ?? 0) !== shadowRevision))
        throw automationError("stale-observation", { reason: "native-text-topology-changed-during-read" });
    };
    const wrap = (active: boolean) => {
      const enter = `const key=Symbol.for("surf-wax.rendered-text-active-query.v1");globalThis[key]=${active ? JSON.stringify(token) : "undefined"};`;
      return { ...params, objectGroup: params.objectGroup ?? "surf-wax-automation",
        arguments: [{ value: nativeRoots?.length ?? -1 }, { value: completeRoots }, ...nativeRoots ?? [], ...params.arguments ?? []],
        functionDeclaration: `function(rootCount,complete,...args){const surfWaxNativeRoots=rootCount<0?undefined:{roots:args.splice(0,rootCount),complete:complete===true};${enter}try{return (${params.functionDeclaration}).apply(this,args)}finally{delete globalThis[key]}}` };
    };
    try {
      guard();
      let first = await this.options.command(debuggee, "Runtime.callFunctionOn", wrap(true)); guard();
      const rootException = first?.exceptionDetails?.exception?.objectId;
      if (rootException) {
        nativeGroupUsed = true;
        const requested = await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId: rootException,
          functionDeclaration: "function(token){if(this.name!=='NativeRootsRequired'||this.nativeTextQuery!==token||!Array.isArray(this.nativeHosts))return null;return [this.completeShadowCensus===true,document,...this.nativeHosts]}",
          arguments: [{ value: token }], objectGroup: nativeGroup,
          serializationOptions: { serialization: "deep", maxDepth: 2, additionalParameters: { maxNodeDepth: 0 } },
        });
        guard();
        const values = requested.result?.deepSerializedValue;
        if (!requested.exceptionDetails && values?.type === "array" && Array.isArray(values.value)) {
          try {
            if (!entry || !entryObjectId || contextId === undefined) throw automationError("text-unavailable", { reason: "native-text-world-unavailable" });
            shadowRevision = entry.shadowRevision ?? 0; guard();
            const [flag, nativeDocument, ...nativeHosts] = values.value;
            const document = nativeDocument?.type === "node" ? nativeDocument.value : undefined;
            const loader = session.frameLoaders.get(entry.frame.frameId);
            if (flag?.type !== "boolean" || !loader || document?.nodeType !== 9 || document.loaderId !== loader
              || !Number.isSafeInteger(document.backendNodeId) || document.backendNodeId <= 0)
              throw automationError("stale-observation", { reason: "native-text-document-mismatch" });
            const described = await this.options.command(debuggee, "DOM.describeNode", { objectId: entryObjectId }); guard();
            if (described.node?.nodeType !== 9 || described.node.backendNodeId !== document.backendNodeId)
              throw automationError("stale-observation", { reason: "native-text-document-mismatch" });
            completeRoots = flag.value === true;
            const hosts = nativeHosts.map((value: any) => value?.type === "node" ? value.value : undefined);
            if (!completeRoots && !hosts.length || hosts.some((host: any) => host?.nodeType !== 1 || host.loaderId !== loader
              || !Number.isSafeInteger(host.backendNodeId) || host.backendNodeId <= 0))
              throw automationError("stale-observation", { reason: "native-field-host-mismatch" });
            nativeRoots = await this.nativeShadowRoots(debuggee, document.backendNodeId, contextId, nativeGroup, guard,
              completeRoots ? undefined : [...new Set<number>(hosts.map((host: any) => host.backendNodeId))]);
            guard();
            first = await this.options.command(debuggee, "Runtime.callFunctionOn", wrap(true)); guard();
          } finally {
            await this.options.command(debuggee, "Runtime.releaseObject", { objectId: rootException }).catch(() => undefined);
          }
        }
      }
      const exceptionId = first?.exceptionDetails?.exception?.objectId;
      if (!exceptionId) return first;
      const group = `surf-wax-marker-query:${token}`;
      let stateId: string | undefined, consumedException = false;
      try {
        const prepared = await this.options.command(debuggee, "Runtime.callFunctionOn", {
          objectId: exceptionId, functionDeclaration: `function(token,deadline){return (${prepareMarkerQuery.toString()}).call(this,token,deadline,${scheduleDeadline.toString()})}`,
          arguments: [{ value: token }, { value: deadlineAt }], objectGroup: group,
          serializationOptions: { serialization: "deep", maxDepth: 2, additionalParameters: { maxNodeDepth: 0 } },
        });
        const value = prepared?.result, entries = value?.deepSerializedValue;
        if (entries?.type === "array" && Array.isArray(entries.value)) {
          consumedException = true;
          if (entries.value.length >= 2 && typeof value.objectId === "string") {
            stateId = value.objectId; this.markerQueries.set(value.objectId, { debuggee, group });
          }
        }
        guard();
        if (prepared.exceptionDetails || entries?.type !== "array" || !Array.isArray(entries.value)) return first;
        consumedException = true;
        const unavailable = async () => {
          guard();
          const result = await this.options.command(debuggee, "Runtime.callFunctionOn", wrap(false));
          guard(); return result;
        };
        if (entries.value.length < 2) return await unavailable();
        stateId = value.objectId;
        if (!stateId) return await unavailable();
        const nodes = entries.value.map((entry: any) => entry?.type === "node" ? entry.value : undefined);
        const document = nodes[0], owners = nodes.slice(1);
        const frame = [...session.frameLoaders].find(([, loader]) => loader && loader === document?.loaderId)?.[0];
        if (!frame || !Number.isSafeInteger(document?.backendNodeId) || document.nodeType !== 9
          || owners.some((owner: any) => owner?.nodeType !== 1 || owner.loaderId !== document.loaderId || !Number.isSafeInteger(owner.backendNodeId))) return await unavailable();
        const source = session.frames.get(frame);
        if (!source || source.tabId !== debuggee.tabId || source.sessionId !== debuggee.sessionId) return await unavailable();
        if (!await this.frameOwnersVisible(session, frame, "text-paint")) throw automationError("text-unavailable", { reason: "frame-not-rendered" });
        guard();
        const snapshot = await this.options.command(debuggee, "DOMSnapshot.captureSnapshot", { computedStyles: [...MARKER_STYLES] });
        guard();
        const records = markerCaptureEvidence(snapshot, { document: document.backendNodeId, loader: document.loaderId, owners: owners.map((node: any) => node.backendNodeId) });
        if (!records) return await unavailable();
        await this.options.command(debuggee, "CSS.enable", {}); guard();
        await this.frontendRoot(debuggee); guard();
        const ids = [...new Set(records.map(record => record.marker))];
        const pushed = await this.options.command(debuggee, "DOM.pushNodesByBackendIdsToFrontend", { backendNodeIds: ids }); guard();
        const fonts = new Map<number, any>();
        // CDP exposes font usage per node. Deduplicate actual pseudo identities,
        // bound concurrency, and stop issuing new requests on cancellation.
        for (let offset = 0; offset < ids.length; offset += 8) {
          guard();
          const batch = await Promise.allSettled(ids.slice(offset, offset + 8).map(async (id, index) => {
            guard();
            const nodeId = pushed?.nodeIds?.[offset + index];
            if (!Number.isSafeInteger(nodeId) || nodeId <= 0) return;
            const result = await this.options.command(debuggee, "CSS.getPlatformFontsForNode", { nodeId }); guard();
            if (Array.isArray(result.fonts) && result.fonts.length === 1) fonts.set(id, result.fonts[0]);
          }));
          guard();
          const failure = batch.find(result => result.status === "rejected");
          if (failure?.status === "rejected") throw failure.reason;
        }
        const installed = await this.options.command(debuggee, "Runtime.callFunctionOn", {
          objectId: stateId, functionDeclaration: measureMarkerInk.toString(), arguments: [{ value: records.map(record => ({ ...record, font: fonts.get(record.marker) })) }], returnByValue: true, awaitPromise: true,
        });
        guard();
        if (installed.exceptionDetails || installed.result?.value !== true) return await unavailable();
        const result = await this.options.command(debuggee, "Runtime.callFunctionOn", wrap(true)); guard();
        if (!await this.frameOwnersVisible(session, frame, "text-paint")) throw automationError("text-unavailable", { reason: "frame-not-rendered" });
        guard();
        return result;
      } finally {
        if (consumedException) await this.options.command(debuggee, "Runtime.releaseObject", { objectId: exceptionId }).catch(() => undefined);
        if (stateId) {
          try {
            await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId: stateId,
              functionDeclaration: "function(){this.dispose()}", returnByValue: true });
            this.markerQueries.delete(stateId);
          } catch { /* clearContext disposes after the executor clears cancellation. */ }
        }
        if (!stateId || !this.markerQueries.has(stateId))
          await this.options.command(debuggee, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => undefined);
      }
    } finally {
      if (nativeGroupUsed) await this.options.command(debuggee, "Runtime.releaseObjectGroup", { objectGroup: nativeGroup }).catch(() => undefined);
    }
  }

  private async callOn(session: Session, objectId: string, functionDeclaration: string, args: unknown[] = [], rendered = false): Promise<any> {
    const params = {
      objectId, functionDeclaration, arguments: args.map((value) => ({ value })), awaitPromise: true, returnByValue: true,
    };
    const response = rendered ? await this.renderedCall(this.sessions.get(session.tabId)!, session.debuggee, params)
      : await this.options.command(session.debuggee, "Runtime.callFunctionOn", params);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result?.value;
  }

  private async elementState(session: Session, objectId: string, pointer = false, scroll = false): Promise<ElementState> {
    // Child-frame RAF and timers can both be suspended by Chrome. Read real
    // geometry synchronously on each side of two frames of the live harness.
    const read = async () => {
      const value = await this.callOn(session, objectId, `function(scroll, pointer){
      if (!this.isConnected) return { connected: false, x: 0, y: 0, visible: false, stable: false, enabled: false, editable: false, receivesEvents: false, checked: false };
      if (scroll) this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const rect = this.getBoundingClientRect();
      const style = getComputedStyle(this); let x = rect.left + rect.width / 2; let y = rect.top + rect.height / 2;
      // checkVisibility includes opacity on composed ancestors (including
      // shadow hosts) but intentionally ignores viewport intersection.
      const painted = this.checkVisibility({ opacityProperty: true, visibilityProperty: true });
      const disabled = (${DISABLED_STATE_SOURCE}).call(this);
      const editKind = (${TEXT_INPUT_KIND_SOURCE}).call(this);
      const editable = (${EDITABLE_STATE_SOURCE}).call(this, editKind, disabled);
      return { connected: true, x, y, width: rect.width, height: rect.height, visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && painted, stable: true, enabled: !disabled, editable, editKind, receivesEvents: pointer, checked: (${CHECKED_STATE_SOURCE}).call(this).value };
    }`, [scroll, pointer]);
      if (!pointer || !value.connected || !value.visible) return value as ElementState;
      // CDP quads are relative to this debugger target's viewport and already
      // include same-process iframe transforms, borders, and nested offsets.
      const result = await this.options.command(session.debuggee, "DOM.getContentQuads", { objectId });
      const quad = (result.quads ?? []).find((candidate: unknown) => Array.isArray(candidate) && candidate.length === 8 && candidate.every(Number.isFinite));
      if (!quad) throw automationError("not-visible", { reason: "missing-content-quad" });
      // Project candidates from the actual content quad, not the axis-aligned
      // DOM rect: rotated and transformed elements need the same coordinates
      // for hit testing and for the eventual browser input.
      const fractions = [0.5, 0.25, 0.75, 0.125, 0.875];
      const pointerCandidates = fractions.flatMap((v) => fractions.map((u) => projectQuad(quad, u, v)));
      return { ...value, ...pointerCandidates[0], quad, pointerCandidates } as ElementState;
    };
    const first = await read();
    if (!first.connected) return first;
    await waitForDocumentFrame(); await waitForDocumentFrame();
    throwIfAborted(this.context.signal);
    const next = await read();
    return { ...next, stable: next.stable && first.x === next.x && first.y === next.y
      && first.width === next.width && first.height === next.height
      && (!pointer || first.quad?.every((value, index) => value === next.quad?.[index]) === true) };
  }

  /** Bind a resolved element to its actual frame, even for same-process frames. */
  private async actionFrameId(session: Session, targetSession: Session, objectId: string, spec?: LocatorSpec): Promise<string> {
    const source = targetSession.debuggee;
    const candidates = [...session.frames].filter(([, debuggee]) => debuggee.tabId === source.tabId && debuggee.sessionId === source.sessionId);
    const known = spec?.ref ? session.refs.get(spec.ref)?.frameId : undefined;
    if (known && candidates.some(([id]) => id === known)) return known;
    if (candidates.length === 1) return candidates[0]![0];
    if (!candidates.length) throw automationError("frame-unavailable", { reason: "missing-target-frame" });
    const generation = session.generation, revision = session.frameRevision;
    const guard = () => {
      throwIfAborted(this.context.signal);
      if (this.sessions.get(session.tabId) !== session || session.generation !== generation || session.frameRevision !== revision)
        throw automationError("stale-frame", { reason: "frame-tree-changed" });
    };
    const group = `surf-wax-frame-identify:${crypto.randomUUID()}`;
    try {
      const document = await this.options.command(source, "Runtime.callFunctionOn", { objectId, functionDeclaration: "function(){return this.ownerDocument}", objectGroup: group });
      guard();
      if (document.exceptionDetails || !document.result?.objectId) throw automationError("frame-unavailable", { reason: "missing-target-document" });
      const target = (await this.options.command(source, "DOM.describeNode", { objectId: document.result.objectId })).node?.backendNodeId;
      guard();
      if (!Number.isSafeInteger(target) || target <= 0) throw automationError("frame-unavailable", { reason: "missing-target-document-identity" });
      const ids = await Promise.all(candidates.map(async ([frameId, debuggee]) => {
        const frame: FrameRefRecord = { frameId, debuggee, generation, revision, conversationId: this.context.conversationId,
          runId: this.context.logIdentity?.runId ?? this.context.runId };
        const documentId = await this.frameDocument(session, frame, guard);
        const key = JSON.stringify([session.tabId, frameId, debuggee.sessionId ?? null]);
        const entry = this.frameDocuments.get(key);
        if (!entry) throw automationError("stale-frame", { reason: "frame-context-expired" });
        if (entry.backendNodeId === undefined) {
          const value = (await this.options.command(debuggee, "DOM.describeNode", { objectId: documentId })).node?.backendNodeId;
          guard();
          if (!Number.isSafeInteger(value) || value <= 0) throw automationError("frame-unavailable", { reason: "missing-frame-document-identity" });
          entry.backendNodeId = value;
        }
        return { frameId, backendNodeId: entry.backendNodeId };
      }));
      guard();
      const matches = ids.filter((item) => item.backendNodeId === target);
      if (matches.length !== 1) throw automationError("frame-unavailable", { reason: "ambiguous-target-document" });
      return matches[0]!.frameId;
    } finally { await this.options.command(source, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => undefined); }
  }

  /** Text acceptance needs fresh parent paint on both sides of the read,
   * including ordinary first-pass success without native marker evidence. */
  private async textFramePaintGuard(session: Session, target: Session, objectId: string, spec: LocatorSpec): Promise<() => Promise<boolean>> {
    const generation = session.generation, revision = session.frameRevision;
    const frameId = await this.actionFrameId(session, target, objectId, spec);
    const world = await this.isolatedFrame(session, target.debuggee, frameId);
    const guard = () => {
      world.guard();
      if (session.generation !== generation || session.frameRevision !== revision)
        throw automationError("stale-frame", { reason: "text-frame-changed" });
    };
    guard();
    return async () => {
      guard();
      const painted = await this.frameOwnersVisible(session, frameId, "text-paint");
      guard();
      return painted;
    };
  }

  /** Check every iframe owner, including same-process and cross-origin frames. */
  private async frameOwnersVisible(session: Session, frameId: string, mode: "visibility" | "text-paint"): Promise<boolean> {
    const generation = session.generation, revision = session.frameRevision, root = session.rootFrameId;
    const { signal, deadlineAt } = this.context;
    if (!root) throw automationError("frame-unavailable", { reason: "missing-root-frame" });
    const guard = () => {
      throwIfAborted(signal);
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw new DOMException("Operation timed out", "TimeoutError");
      if (this.sessions.get(session.tabId) !== session || session.generation !== generation || session.frameRevision !== revision)
        throw automationError("stale-frame", { reason: "frame-tree-changed" });
    };
    const visited = new Set<string>();
    let current = frameId;
    while (current !== root) {
      guard();
      if (visited.has(current)) throw automationError("frame-unavailable", { reason: "cyclic-frame-ancestry" });
      visited.add(current);
      const parentId = session.frameParents.get(current), parent = parentId ? session.frames.get(parentId) : undefined;
      if (!parentId || !parent) throw automationError("frame-unavailable", { reason: "missing-frame-owner" });
      const group = `surf-wax-frame-visible:${crypto.randomUUID()}`;
      try {
        const owner = await this.options.command(parent, "DOM.getFrameOwner", { frameId: current });
        guard();
        if (!owner?.backendNodeId) throw automationError("frame-unavailable", { reason: "missing-frame-owner" });
        const world = await this.isolatedFrame(session, parent, parentId);
        guard(); world.guard();
        const executionContextId = world.executionContextId;
        const resolved = await this.options.command(parent, "DOM.resolveNode", { backendNodeId: owner.backendNodeId, executionContextId, objectGroup: group });
        guard(); world.guard();
        if (!resolved.object?.objectId) throw automationError("frame-unavailable", { reason: "missing-frame-owner-object" });
        let response = await this.options.command(parent, "Runtime.callFunctionOn", { objectId: resolved.object.objectId, returnByValue: true,
          functionDeclaration: mode === "text-paint" ? RENDERED_FRAME_PAINT_SOURCE : FRAME_OWNER_VISIBILITY_SOURCE });
        guard(); world.guard();
        if (mode === "text-paint" && response.result?.value === "native-shadow-roots-required") {
          const entry = [...this.frameDocuments.values()].find(entry => entry.objectId === world.objectId && entry.session === session);
          if (!entry) throw automationError("stale-frame", { reason: "frame-paint-document-expired" });
          const shadowRevision = entry.shadowRevision ?? 0;
          const check = () => {
            guard(); world.guard();
            if ((entry.shadowRevision ?? 0) !== shadowRevision)
              throw automationError("stale-observation", { reason: "frame-shadow-topology-changed-during-read" });
          };
          const described = await this.options.command(parent, "DOM.describeNode", { objectId: world.objectId }); check();
          if (described.node?.nodeType !== 9 || !Number.isSafeInteger(described.node.backendNodeId))
            throw automationError("frame-unavailable", { reason: "frame-paint-document-unavailable" });
          const roots = await this.nativeShadowRoots(parent, described.node.backendNodeId, executionContextId, group, check);
          response = await this.options.command(parent, "Runtime.callFunctionOn", { objectId: resolved.object.objectId, returnByValue: true,
            functionDeclaration: RENDERED_FRAME_PAINT_SOURCE, arguments: [{ value: true }, ...roots] });
          check();
        }
        if (response.exceptionDetails || typeof response.result?.value !== "boolean") throw automationError("frame-unavailable", { reason: "missing-frame-visibility" });
        if (!response.result.value) return false;
      } finally { await this.options.command(parent, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => undefined); }
      current = parentId;
    }
    guard();
    return true;
  }

  private async waitForLocatorState(session: Session, spec: LocatorSpec, state: WaitState, checked = true): Promise<void> {
    let attempt = 0;
    while (true) {
      throwIfAborted(this.context.signal);
      let matches: Candidate[] = [];
      let objectId: string | undefined;
      try { objectId = await this.resolveOnce(session, spec, (found) => { matches = found; }); }
      catch (error) {
        if (error instanceof AutomationError && error.code === "detached" && (state === "detached" || state === "hidden")) return;
        throw error;
      }
      attempt += 1;
      if (!objectId) {
        this.recordAttempt(session, spec, attempt, "no-candidate", matches);
        if (state === "detached" || state === "hidden") return;
        await delay(50, this.context.signal);
        continue;
      }
      const value = await this.elementState(this.objectSession(session, objectId), objectId).catch((error) => {
        if (error && typeof error === "object" && "name" in error && error.name === "AbortError") throw error;
        if (isDetachedNodeError(error)) return undefined;
        throw error;
      });
      this.recordAttempt(session, spec, attempt, value?.connected ? `checking-${state}` : "detached", matches, value);
      if (!value?.connected) {
        if (state === "detached" || state === "hidden") return;
      } else if (state === "attached" || state === "visible" && value.visible || state === "hidden" && !value.visible || state === "enabled" && value.enabled || state === "editable" && value.editable || state === "checked" && value.checked === checked) return;
      await delay(50, this.context.signal);
    }
  }

  private async waitActionableLocator(session: Session, spec: LocatorSpec, editable: boolean, pointer: boolean, stable = pointer, enabled = true, failFast = true): Promise<{ objectId: string; targetSession: Session; state: ElementState }> {
    let attempt = 0;
    const singleResolution = failFast || spec.queries.some((query) => query.kind === "uniqueScope");
    // A semantic locator may survive a framework replacing its element before
    // dispatch. Never heal a node reference, positional selection, or bound
    // scope: those identify a particular object rather than a fresh match.
    let canRetryReplacement = failFast;
    visitLocators(spec, (part) => {
      if (part.ref || part.index !== undefined || part.queries.some((query) => query.kind === "index" || query.kind === "uniqueScope" || query.kind === "frameRef" || query.kind === "css")) canRetryReplacement = false;
    });
    const generation = session.generation;
    let retriedReplacement = false;
    const retryReplacement = () => {
      if (!canRetryReplacement || retriedReplacement || session.generation !== generation || this.sessions.get(session.tabId) !== session) return false;
      retriedReplacement = true;
      return true;
    };
    while (true) {
      throwIfAborted(this.context.signal);
      let candidates: Candidate[] = [];
      const objectId = await this.resolveOnce(session, spec, (matches) => { candidates = matches; }, singleResolution);
      attempt += 1;
      if (!objectId) {
        this.recordAttempt(session, spec, attempt, "no-candidate", candidates);
        // A match which disappeared while resolving is different from a
        // missing locator, which must remain an immediate failure.
        if (candidates.length === 1 && retryReplacement()) continue;
        if (singleResolution) throw automationError("not-found", { locator: spec, lastObservation: this.waitDiagnostic() });
        await delay(50, this.context.signal); continue;
      }
      const targetSession = this.objectSession(session, objectId);
      const state = await (async () => {
        const current = await this.elementState(targetSession, objectId, pointer, true);
        if (current?.connected && current.visible) {
          current.frameId = await this.actionFrameId(session, targetSession, objectId, spec);
          current.visible = await this.frameOwnersVisible(session, current.frameId, "visibility");
        }
        if (current?.connected && current.visible && current.receivesEvents && pointer)
          await this.selectPointerPoint(session, targetSession, objectId, current);
        return current;
      })().catch((error) => {
        if (error && typeof error === "object" && "name" in error && error.name === "AbortError") throw error;
        if (!isDetachedNodeError(error)) throw error;
        if (spec.ref) throw automationError("detached", { ref: spec.ref, reason: error instanceof Error ? error.message : String(error) });
        return undefined;
      });
      const reason = !state?.connected ? "detached" : !state.visible ? "not-visible" : stable && !state.stable ? "not-stable" : enabled && !state.enabled ? "disabled" : editable && !state.editable ? "not-editable" : pointer && !state.receivesEvents ? "intercepted" : "actionable";
      this.recordAttempt(session, spec, attempt, reason, candidates, state);
      if (spec.ref && !state?.connected) throw automationError("detached", { ref: spec.ref, reason: "node-removed" });
      if (!state?.connected && retryReplacement()) continue;
      if (editable && state?.connected && state.editKind === "unsupported") throw automationError("invalid-editable-target", { reason: "not-a-text-input" });
      if (state?.connected && state.visible && (!stable || state.stable) && (!enabled || state.enabled) && (!editable || state.editable) && (!pointer || state.receivesEvents)) return { objectId, targetSession, state };
      if (singleResolution) {
        if (reason === "intercepted" && state) {
          try { state.blocker = await this.clickBlocker(session, targetSession, objectId, state); }
          catch (error) {
            if (error instanceof Error && error.name === "AbortError") throw error;
            // Diagnostics must not replace the original actionability error.
          }
        }
        throw automationError(reason, { locator: spec, lastObservation: this.waitDiagnostic() });
      }
      await delay(50, this.context.signal);
    }
  }

  /** Recheck an already selected node without ever retargeting the operation. */
  private async waitBoundActionable(session: Session, target: { objectId: string; targetSession: Session; state: ElementState }, enabled = true): Promise<{ objectId: string; targetSession: Session; state: ElementState }> {
    while (true) {
      throwIfAborted(this.context.signal);
      const state = await this.elementState(target.targetSession, target.objectId, true, true);
      if (!state.connected) throw automationError("detached", { reason: "bound-target-removed" });
      if (state.visible && target.state.frameId) {
        state.frameId = target.state.frameId;
        state.visible = await this.frameOwnersVisible(session, state.frameId, "visibility");
      }
      if (state.visible && state.receivesEvents) await this.selectPointerPoint(session, target.targetSession, target.objectId, state);
      if (state.visible && state.stable && (!enabled || state.enabled) && state.receivesEvents) return { ...target, state };
      await delay(50, this.context.signal);
    }
  }

  private async toRootPoint(session: Session, targetSession: Session, state: ElementState): Promise<{ x: number; y: number }> {
    return (await this.toRootPoints(session, targetSession, [state]))[0]!;
  }

  /** Find a point which really reaches the target through all frame boundaries. */
  private async selectPointerPoint(session: Session, targetSession: Session, objectId: string, state: ElementState): Promise<void> {
    const points = state.pointerCandidates ?? [state];
    delete state.pointerCandidates;
    for (const point of points) {
      if (await this.frameReceivesEvents(session, targetSession, objectId, point)) {
        state.x = point.x; state.y = point.y; state.receivesEvents = true;
        return;
      }
    }
    state.receivesEvents = false;
  }

  /** A hit inside an OOPIF is actionable only if every embedding frame receives that point. */
  private async frameReceivesEvents(session: Session, targetSession: Session, objectId: string, point: { x: number; y: number }): Promise<boolean> {
    let debuggee = targetSession.debuggee;
    // getNodeForLocation follows same-process frames. The element's own hit
    // test cannot see an overlay in an embedding document, so compare document
    // identities before testing the out-of-process frame boundaries.
    if (point.x < 0 || point.y < 0) return false;
    const hitAt = async (target: Debuggee, position: { x: number; y: number }) => {
      const metrics = await this.options.command(target, "Page.getLayoutMetrics", {});
      const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport;
      return this.options.command(target, "DOM.getNodeForLocation", {
        x: Math.floor(position.x + (viewport?.pageX ?? 0)), y: Math.floor(position.y + (viewport?.pageY ?? 0)),
      });
    };
    let hit: any;
    try { hit = await hitAt(debuggee, point); }
    catch (error) {
      if (error instanceof Error && /No node found at given location/i.test(error.message)) return false;
      throw error;
    }
    const targetNode = await this.describe(targetSession, objectId);
    if (hit.backendNodeId !== targetNode.backendNodeId) {
      const objectGroup = `surf-wax-hit-test:${crypto.randomUUID()}`;
      const found = await this.options.command(debuggee, "DOM.resolveNode", { backendNodeId: hit.backendNodeId, objectGroup });
      if (!found.object?.objectId) throw automationError("state-unavailable", { reason: "missing-hit-node" });
      const documentId = async (node: string) => {
        const document = await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId: node,
          functionDeclaration: "function(){return this.ownerDocument}", objectGroup });
        if (!document.result?.objectId) throw automationError("state-unavailable", { reason: "missing-hit-document" });
        return (await this.options.command(debuggee, "DOM.describeNode", { objectId: document.result.objectId })).node?.backendNodeId;
      };
      try {
        const targetDocument = await documentId(objectId);
        const hitDocument = await documentId(found.object.objectId);
        if (!targetDocument || !hitDocument) throw automationError("state-unavailable", { reason: "missing-hit-document-identity" });
        if (targetDocument === hitDocument) {
          // A same-document hit can still be an unrelated overlay. Traverse
          // the composed ancestry so descendants inside shadow roots count.
          // Rebind the exact target backend node to the hit's default world;
          // an extension-world resolver handle cannot be passed across worlds.
          const comparable = await this.options.command(debuggee, "DOM.resolveNode", { backendNodeId: targetNode.backendNodeId, objectGroup });
          if (!comparable.object?.objectId) throw automationError("state-unavailable", { reason: "missing-target-node" });
          const relation = await this.options.command(debuggee, "Runtime.callFunctionOn", {
            objectId: found.object.objectId,
            functionDeclaration: "function(target){ for (let node = this; node; node = node.parentNode || node.host) if (node === target) return true; return false; }",
            arguments: [{ objectId: comparable.object.objectId }], returnByValue: true,
          });
          if (relation.result?.value !== true) return false;
        } else {
          if (targetNode.nodeName !== "IFRAME" || !hit.frameId) return false;
          const owner = await this.options.command(debuggee, "DOM.getFrameOwner", { frameId: hit.frameId });
          if (owner.backendNodeId !== targetNode.backendNodeId) return false;
        }
      } finally { void this.options.command(debuggee, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => undefined); }
    }
    while (debuggee.sessionId) {
      const frameId = [...session.frames].find(([, item]) => item.sessionId === debuggee.sessionId)?.[0];
      if (!frameId) throw automationError("frame-detached", { sessionId: debuggee.sessionId });
      const { parent, owner, quad, size } = await this.frameGeometry(session, debuggee, frameId);
      point = projectQuad(quad, point.x / size.width, point.y / size.height);
      if (point.x < 0 || point.y < 0) return false;
      try {
        const hit = await hitAt(parent, point);
        if (hit.backendNodeId !== owner.backendNodeId) return false;
      } catch (error) {
        if (error instanceof Error && /No node found at given location/i.test(error.message)) return false;
        throw error;
      }
      debuggee = parent;
    }
    return true;
  }

  private async toRootPoints(session: Session, targetSession: Session, points: Array<{ x: number; y: number }>): Promise<Array<{ x: number; y: number }>> {
    let debuggee = targetSession.debuggee;
    while (debuggee.sessionId) {
      const frameId = [...session.frames].find(([, item]) => item.sessionId === debuggee.sessionId)?.[0];
      if (!frameId) throw automationError("frame-detached", { sessionId: debuggee.sessionId });
      const { parent, quad, size } = await this.frameGeometry(session, debuggee, frameId);
      points = points.map(({ x, y }) => projectQuad(quad, x / size.width, y / size.height));
      debuggee = parent;
    }
    return points;
  }

  private async frameGeometry(session: Session, debuggee: Debuggee, frameId: string): Promise<{ parent: Debuggee; owner: { backendNodeId: number }; quad: number[]; size: { width: number; height: number } }> {
    const parentId = session.frameParents.get(frameId);
    const known = parentId && session.frames.get(parentId);
    const sources = [...new Map([...(known ? [known] : []), session.debuggee, ...session.frames.values()]
      .filter((source) => source.sessionId !== debuggee.sessionId).map((source) => [JSON.stringify(source), source])).values()];
    let parent: Debuggee | undefined, owner: { backendNodeId: number } | undefined;
    for (const source of sources) {
      try { owner = await this.options.command(source, "DOM.getFrameOwner", { frameId }); parent = source; break; }
      catch (error) { if (!/Frame with the given id does not belong to the target|No frame with given id found/i.test(error instanceof Error ? error.message : String(error))) throw error; }
    }
    if (!parent || !owner?.backendNodeId) throw automationError("frame-detached", { frameId, reason: "missing-frame-owner" });
    const model = await this.options.command(parent, "DOM.getBoxModel", { backendNodeId: owner.backendNodeId });
    const size = await this.evaluateIn(debuggee, "({width:innerWidth,height:innerHeight})") as { width: number; height: number };
    const quad = model?.model?.content as number[] | undefined;
    if (!quad?.length || !size.width || !size.height) throw automationError("frame-detached", { frameId, reason: "missing-frame-geometry" });
    return { parent, owner, quad, size };
  }

  private async nativeClick(debuggee: Debuggee, params: Record<string, unknown>) {
    if (this.options.atomicClick) return this.options.atomicClick(debuggee, params);
    await this.options.command(debuggee, "Input.dispatchMouseEvent", { ...params, type: "mouseMoved", button: "none", buttons: 0, clickCount: 0 });
    await this.options.command(debuggee, "Input.dispatchMouseEvent", { ...params, type: "mousePressed" });
    return this.options.command(debuggee, "Input.dispatchMouseEvent", { ...params, type: "mouseReleased" });
  }

  private async pointer(session: Session, spec: LocatorSpec, operation: string, options: { button?: "left" | "right" | "middle"; modifiers?: string[] } = {}, bound?: { objectId: string; targetSession: Session; state: ElementState }): Promise<void> {
    const target = bound ? await this.waitBoundActionable(session, bound, operation !== "hover") : await this.waitActionableLocator(session, spec, false, true, true, operation !== "hover", true);
    const state = await this.toRootPoint(session, target.targetSession, target.state);
    if (operation === "hover") {
      await this.options.command(session.debuggee, "Input.dispatchMouseEvent", { type: "mouseMoved", x: state.x, y: state.y });
      return;
    }
    const button = options.button ?? "left";
    const modifiers = modifierMask(options.modifiers ?? []);
    const count = operation === "dblclick" ? 2 : 1;
    for (let clickCount = 1; clickCount <= count; clickCount += 1) {
      await this.nativeClick(session.debuggee, { x: state.x, y: state.y, button, modifiers, clickCount });
    }
  }

  /** Check the bound node, its shadow hosts and the containing frame before input. */
  private async assertFocused(session: Session, objectId: string, signal?: AbortSignal, requireText = false): Promise<void> {
    throwIfAborted(signal);
    const value = await this.callOn(session, objectId, `function(requireText){
      if (!this.isConnected) return { connected: false, focused: false };
      const document = this.ownerDocument;
      let node = this, root = node.getRootNode();
      while (root) {
        if (root.activeElement !== node) return { connected: this.isConnected, focused: false };
        if (!root.host) break;
        node = root.host;
        root = node.getRootNode();
      }
      const editable = !requireText || ((${TEXT_INPUT_KIND_SOURCE}).call(this) === 'text' && !(${DISABLED_STATE_SOURCE}).call(this)
        && !this.readOnly && this.getAttribute('aria-readonly') !== 'true');
      return { connected: this.isConnected, focused: root === document && document.hasFocus(), editable };
    }`, [requireText]);
    throwIfAborted(signal);
    if (!value || typeof value.connected !== "boolean" || typeof value.focused !== "boolean")
      throw automationError("focus-unavailable", { reason: "missing-focus-state" });
    if (!value.connected) throw automationError("detached", { reason: "focused-target-removed" });
    if (!value.focused) throw automationError("focus-lost", { reason: "focused-target-changed" });
    if (requireText && typeof value.editable !== "boolean") throw automationError("state-unavailable", { reason: "missing-editable-state" });
    if (requireText && !value.editable) throw automationError("not-editable", { reason: "focused-target-changed" });
  }

  private async withFocusedTarget(session: Session, objectId: string, signal: AbortSignal | undefined, run: (assertFocus: () => Promise<void>, backendNodeId: number) => Promise<void>, requireText = false): Promise<void> {
    const node = await this.describe(session, objectId);
    if (!node?.backendNodeId) throw automationError("focus-unavailable", { reason: "missing-backend-node-id" });
    let focusAttempted = false;
    try {
      throwIfAborted(signal);
      // Focusing can itself run page handlers, so later failures cannot claim no effect.
      focusAttempted = true;
      await this.options.command(session.debuggee, "DOM.focus", { backendNodeId: node.backendNodeId });
      const assertFocus = () => this.assertFocused(session, objectId, signal, requireText);
      await assertFocus();
      await run(assertFocus, node.backendNodeId);
    } catch (error) {
      if (focusAttempted && error && typeof error === "object") Object.assign(error, { effectUnknown: true });
      throw error;
    }
  }

  private async press(session: Session, chord: string, signal = this.context.signal, assertFocus?: () => Promise<void>): Promise<void> {
    await this.options.pressChord(session.debuggee, chord, signal, assertFocus);
  }

  private async waitForReady(session: Session): Promise<void> {
    while (true) {
      throwIfAborted(this.context.signal);
      try { if (await this.pageValue(session.tabId, "document.readyState !== 'loading'")) return; }
      catch (error) { if (!isTransientNavigationError(error)) throw error; }
      await delay(50, this.context.signal);
    }
  }

  private captureWaiter(session: Session, signal?: AbortSignal) {
    const guard = () => {
      throwIfAborted(signal);
      if (this.sessions.get(session.tabId) !== session) throw automationError("stale-session", { reason: "session-changed-during-capture" });
      throwIfAborted(session.lifetime.signal);
    };
    const waitForCapture = async <T>(task: Promise<T>): Promise<T> => {
      // The command promises are already started by the caller. If the
      // session or signal changed synchronously, still consume a late failure.
      void task.catch(() => undefined);
      guard();
      let onAbort!: () => void;
      try {
        const result = await Promise.race([task, new Promise<never>((_resolve, reject) => {
          onAbort = () => { try { guard(); } catch (error) { reject(error); } };
          signal?.addEventListener("abort", onAbort, { once: true });
          session.lifetime.signal.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted || session.lifetime.signal.aborted) onAbort();
        })]);
        guard();
        return result;
      } finally {
        if (onAbort) { signal?.removeEventListener("abort", onAbort); session.lifetime.signal.removeEventListener("abort", onAbort); }
      }
    };
    return { guard, waitForCapture };
  }

  /** Read current paint through shared, document-bound weak handles. */
  private async readFrameTextPaint(session: Session, frame: FrameRefRecord, list: readonly SnapshotTextPaintCandidate[], frameGuard: () => void): Promise<Map<number, TextPaintEvidence>> {
    const debuggee = frame.debuggee, frameId = frame.frameId;
    const paintEvidence = new Map<number, TextPaintEvidence>();
    const documentObjectId = await this.frameDocument(session, frame, frameGuard);
    const frameKey = JSON.stringify([session.tabId, frameId, debuggee.sessionId ?? null]);
    const document = this.frameDocuments.get(frameKey);
    if (!document) throw automationError("stale-frame", { reason: "text-paint-context-expired" });
    const contextId = document?.executionContextId;
    if (!Number.isSafeInteger(contextId)) throw automationError("snapshot-unavailable", { reason: "missing-text-paint-context", frameId });
    const paintGuard = () => {
      frameGuard();
      if (this.frameDocuments.get(frameKey) !== document) throw automationError("stale-frame", { reason: "text-paint-context-expired" });
    };
    // Serialize access to this frame's cache. Concurrent captures
    // reuse the first capture's weak handles, and aborting a queued
    // capture still returns immediately via waitForCapture.
    const previous = document.paintCacheTail ?? Promise.resolve();
    let releaseQueue!: () => void;
    const ticket = new Promise<void>((resolve) => { releaseQueue = resolve; });
    const tail = previous.then(() => ticket, () => ticket);
    document.paintCacheTail = tail;
    const objectGroup = `surf-wax-text-paint:${crypto.randomUUID()}`;
    let dispatched = false;
    try {
      await previous;
      paintGuard();
      const applyEvidence = (candidate: SnapshotTextPaintCandidate, evidence: TextPaintEvidence) => {
        paintEvidence.set(candidate.backendNodeId, evidence);
      };
      const validate = (response: any, count: number): Array<TextPaintEvidence | null> => {
        const values = response?.result?.value;
        if (response?.exceptionDetails) {
          const detail = String(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "");
          if (/text-paint node detached/i.test(detail)) throw new Error("Text-paint node detached during capture");
          throw automationError("snapshot-unavailable", { reason: "text-paint-analysis-failed", detail });
        }
        if (!Array.isArray(values) || values.length !== count)
          throw automationError("snapshot-unavailable", { reason: "missing-text-paint-evidence" });
        return values;
      };
      const missing: SnapshotTextPaintCandidate[] = [];
      if (document.paintCacheWarm) {
        for (let offset = 0; offset < list.length; offset += 256) {
          paintGuard();
          const batch = list.slice(offset, offset + 256);
          const cacheable = batch.filter((candidate) => candidate.kind !== "pseudo");
          missing.push(...batch.filter((candidate) => candidate.kind === "pseudo"));
          if (!cacheable.length) continue;
          const response = await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId: documentObjectId,
            arguments: [{ value: document.paintCacheToken }, { value: cacheable.map(({ backendNodeId }) => backendNodeId) }],
            functionDeclaration: TEXT_PAINT_CACHE_LOOKUP_SOURCE, returnByValue: true });
          paintGuard();
          const evidence = validate(response, cacheable.length);
          for (let index = 0; index < cacheable.length; index++) {
            if (evidence[index] === null) missing.push(cacheable[index]!);
            else applyEvidence(cacheable[index]!, evidence[index]!);
          }
        }
      } else for (const candidate of list) missing.push(candidate);
      for (let offset = 0; offset < missing.length; offset += 32) {
        paintGuard();
        const batch = missing.slice(offset, offset + 32);
        dispatched = true;
        // Settle every dispatched resolution before releasing the
        // group: a late success must not recreate a released group.
        const resolved = await Promise.allSettled(batch.map((candidate) => this.options.command(debuggee, "DOM.resolveNode", {
          backendNodeId: candidate.backendNodeId, executionContextId: contextId, objectGroup,
        })));
        paintGuard();
        const failed = resolved.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failed) throw failed.reason;
        const handles = resolved.map((result, index) => {
          const objectId = (result as PromiseFulfilledResult<any>).value.object?.objectId;
          if (typeof objectId !== "string") throw automationError("snapshot-unavailable", { reason: "missing-text-paint-node" });
          return { candidate: batch[index]!, objectId };
        });
        const response = await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId: documentObjectId,
          arguments: [{ value: document.paintCacheToken }, { value: batch.map(({ backendNodeId }) => backendNodeId) },
            ...handles.map(({ objectId }) => ({ objectId }))], functionDeclaration: TEXT_PAINT_CACHE_REGISTER_SOURCE, returnByValue: true });
        paintGuard();
        const evidence = validate(response, handles.length);
        for (let index = 0; index < handles.length; index++) {
          if (evidence[index] === null) throw automationError("snapshot-unavailable", { reason: "missing-text-paint-evidence" });
          applyEvidence(handles[index]!.candidate, evidence[index]!);
        }
      }
      document.paintCacheWarm = true;
    } finally {
      releaseQueue();
      if (document.paintCacheTail === tail) delete document.paintCacheTail;
      if (dispatched) await this.options.command(debuggee, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => undefined);
    }
    return paintEvidence;
  }

  /** Standard property support is fixed for this browser process. Share the
   * inventory request, while keeping profile selection document-bound. */
  private snapshotCompleteStyleCatalog(session: Session): Promise<readonly string[]> {
    if (this.completeStyleCatalog) return this.completeStyleCatalog;
    const pending = this.options.chromeApi.scripting.executeScript({ target: { tabId: session.tabId, frameIds: [0] }, world: "ISOLATED",
      func: () => Array.from(getComputedStyle(document.documentElement)).filter((name) => !name.startsWith("--")),
    }).then((injected) => {
      const names = injected.length === 1 && injected[0]?.frameId === 0 ? injected[0].result : undefined;
      if (!Array.isArray(names) || names.length <= SNAPSHOT_COMPUTED_STYLES.length
        || names.some((name) => typeof name !== "string" || !/^-?[a-z][a-z0-9-]*$/.test(name))
        || new Set(names).size !== names.length || !["background-image", "font-family", "outline-width"].every((name) => names.includes(name)))
        throw automationError("snapshot-unavailable", { reason: "complete-style-catalog-unavailable" });
      return Object.freeze([...new Set<string>([...SNAPSHOT_COMPUTED_STYLES, ...names])]);
    });
    this.completeStyleCatalog = pending;
    void pending.catch(() => { if (this.completeStyleCatalog === pending) this.completeStyleCatalog = undefined; });
    return pending;
  }

  private rootReadScope(session: Session): RootReadScope {
    const frameId = session.rootFrameId;
    if (!frameId) throw automationError("snapshot-unavailable", { reason: "missing-observation-frame" });
    return { frameId, loaderId: session.frameLoaders.get(frameId), revision: session.rootDocumentRevision,
      context: this.extensionObservationContext(session, frameId), signal: this.context.signal };
  }

  private assertRootReadScope(session: Session, scope: RootReadScope): void {
    throwIfAborted(scope.signal);
    throwIfAborted(session.lifetime.signal);
    if (scope.context && session.observationContexts.get(scope.context.id) !== scope.context)
      throw automationError("stale-observation", { reason: "observation-context-changed-during-read" });
    if (this.sessions.get(session.tabId) !== session || session.rootFrameId !== scope.frameId
      || session.rootDocumentRevision !== scope.revision || session.frameLoaders.get(scope.frameId) !== scope.loaderId)
      throw automationError("stale-observation", { reason: "root-document-changed-during-read" });
  }

  /** Only new, ref-free root captures may adopt a later global frame epoch. */
  private handoffFreshRootCapture(session: Session, captured: { frameRevision: number }): boolean {
    const scope = this.rootReadScopes.get(captured);
    if (!scope) return false;
    this.assertRootReadScope(session, scope);
    captured.frameRevision = session.frameRevision;
    return true;
  }

  private extensionObservationContext(session: Session, frameId: string): ObservationContext | undefined {
    const context = session.observationPrimitives?.context;
    return context?.frameId === frameId && session.observationContexts.get(context.id) === context ? context : undefined;
  }

  /** Install pure helpers once per root document, independent of child frames. */
  private prepareObservationPrimitives(session: Session): Promise<void> {
    const scope = this.rootReadScope(session), previous = session.observationPrimitives;
    if (previous && previous.frameId === scope.frameId && previous.loaderId === scope.loaderId && previous.revision === scope.revision)
      return previous.ready;
    const identity = crypto.randomUUID();
    const ready = this.options.chromeApi.scripting.executeScript({
      target: { tabId: session.tabId, frameIds: [0] }, world: "ISOLATED", func: snapshotObservationPrimitives as (install: true, worldIdentity: string) => 2, args: [true, identity],
    }).then(async (results) => {
      if (results.length !== 1 || results[0]?.frameId !== 0 || results[0].result !== 2)
        throw automationError("snapshot-unavailable", { reason: "observation-primitives-unavailable" });
      // Origin/name only identifies candidates: Chrome gives USER_SCRIPT
      // worlds the same extension origin. Identify the world of this trusted
      // ISOLATED injection using a fresh value never sent to other worlds.
      await this.options.command(session.debuggee, "Runtime.evaluate", { expression: "void 0", returnByValue: true });
      this.assertRootReadScope(session, scope);
      const candidates = [...session.observationContexts.values()].filter((context) => context.candidate && context.frameId === scope.frameId);
      const reads = await Promise.allSettled(candidates.map(async (context) => {
        const response = await this.options.command(session.debuggee, "Runtime.evaluate", {
          expression: 'globalThis[Symbol.for("surf-wax.snapshot-observation-primitives.v2")]?.worldIdentity',
          contextId: context.id, returnByValue: true,
        });
        return !response.exceptionDetails && response.result?.value === identity ? context : undefined;
      }));
      this.assertRootReadScope(session, scope);
      const matches = reads.flatMap((read) => read.status === "fulfilled" && read.value
        && session.observationContexts.get(read.value.id) === read.value ? [read.value] : []);
      if (matches.length !== 1) throw automationError("snapshot-unavailable", { reason: "observation-context-identity-unavailable" });
      cached.context = matches[0];
    });
    const cached: RootReadScope & { ready: Promise<void> } = { frameId: scope.frameId, loaderId: scope.loaderId, revision: scope.revision, ready };
    session.observationPrimitives = cached;
    void ready.catch(() => { if (session.observationPrimitives === cached) delete session.observationPrimitives; });
    return ready;
  }

  /** A real native census supplies current root identities, never UI text.
   * DOM.getDocument is source-rooted: select the exact requested Document,
   * including a same-process embedded parent, before walking its own roots. */
  private async nativeShadowRoots(debuggee: Debuggee, documentBackend: number, contextId: number, objectGroup: string, guard: () => void, hosts?: readonly number[]): Promise<Array<{ objectId: string }>> {
    const ids = new Set<number>();
    if (hosts) {
      for (let offset = 0; offset < hosts.length; offset += 32) {
        guard();
        const described = await Promise.allSettled(hosts.slice(offset, offset + 32).map(async backendNodeId => {
          const value = await this.options.command(debuggee, "DOM.describeNode", { backendNodeId, depth: 1, pierce: true });
          const node = value.node, roots = node?.shadowRoots?.filter((root: any) => root.shadowRootType === "user-agent") ?? [];
          if (node?.backendNodeId !== backendNodeId || node.nodeType !== 1 || !/^(?:input|textarea|select)$/i.test(node.nodeName ?? "")
            || roots.length !== 1 || !Number.isSafeInteger(roots[0].backendNodeId) || roots[0].backendNodeId <= 0)
            throw automationError("text-unavailable", { reason: "native-field-root-unavailable" });
          return roots[0].backendNodeId as number;
        }));
        guard();
        const failure = described.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure) throw failure.reason;
        for (const result of described) if (result.status === "fulfilled") ids.add(result.value);
      }
    } else {
      guard();
      const census = await this.frontendDocument(debuggee, { depth: -1, pierce: true }); guard();
      const documents: any[] = [], pending = [census.root];
      while (pending.length) {
        const node = pending.pop();
        if (!node) throw automationError("stale-observation", { reason: "invalid-shadow-census" });
        if (node.nodeType === 9 && node.backendNodeId === documentBackend) documents.push(node);
        pending.push(...node.children ?? [], ...node.shadowRoots ?? []);
        if (node.contentDocument) pending.push(node.contentDocument);
      }
      if (documents.length !== 1) throw automationError("stale-observation", { reason: "shadow-census-document-mismatch" });
      const own = [documents[0]];
      while (own.length) {
        const node = own.pop();
        for (const shadow of node.shadowRoots ?? []) {
          if (!Number.isSafeInteger(shadow.backendNodeId) || shadow.backendNodeId <= 0 || ids.has(shadow.backendNodeId))
            throw automationError("stale-observation", { reason: "invalid-shadow-root-identity" });
          ids.add(shadow.backendNodeId); own.push(shadow);
        }
        own.push(...node.children ?? []); // Embedded documents are separate scopes.
      }
    }
    const roots: Array<{ objectId: string }> = [], backendIds = [...ids];
    for (let offset = 0; offset < backendIds.length; offset += 32) {
      guard();
      const resolved = await Promise.allSettled(backendIds.slice(offset, offset + 32).map(async backendNodeId => {
        const response = await this.options.command(debuggee, "DOM.resolveNode", { backendNodeId, executionContextId: contextId, objectGroup });
        if (typeof response.object?.objectId !== "string") throw automationError("stale-observation", { reason: "observation-shadow-root-unavailable" });
        return { objectId: response.object.objectId as string };
      }));
      guard();
      const failure = resolved.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failure) throw failure.reason;
      for (const result of resolved) if (result.status === "fulfilled") roots.push(result.value);
    }
    return roots;
  }

  /** Resolve only native roots asynchronously; all UI evidence is read together. */
  private async sampleNativeObservation(session: Session, pageZoom: number, guard: () => void): Promise<ReturnType<typeof sampleReadableSnapshot>> {
    const frameId = session.rootFrameId;
    if (!frameId) throw automationError("snapshot-unavailable", { reason: "missing-observation-frame" });
    // The injection creates the extension world. A protocol barrier also
    // settles its executionContextCreated event before selecting that world.
    if (!this.extensionObservationContext(session, frameId)) {
      await this.options.command(session.debuggee, "Runtime.evaluate", { expression: "void 0", returnByValue: true });
      guard();
    }
    const context = this.extensionObservationContext(session, frameId);
    if (!context) throw automationError("snapshot-unavailable", { reason: "missing-extension-observation-context" });
    const check = () => {
      guard();
      if (session.observationContexts.get(context.id) !== context)
        throw automationError("stale-observation", { reason: "observation-context-changed-during-read" });
    };
    const command = async (method: string, params: object) => {
      check();
      try {
        const result = await this.options.command(session.debuggee, method, params);
        check(); return result;
      } catch (error) { check(); throw error; }
    };
    const objectGroup = `surf-wax-semantic-observation:${crypto.randomUUID()}`;
    try {
      const document = await command("Runtime.evaluate", {
        expression: "document", contextId: context.id, objectGroup, returnByValue: false,
      });
      const documentObjectId = document?.result?.objectId;
      if (document?.exceptionDetails || typeof documentObjectId !== "string")
        throw automationError("snapshot-unavailable", { reason: "missing-observation-document" });
      const described = await command("DOM.describeNode", { objectId: documentObjectId, depth: 0 });
      const root = described?.node;
      if (root?.nodeType !== 9 || !Number.isSafeInteger(root.backendNodeId) || root.backendNodeId <= 0)
        throw automationError("snapshot-unavailable", { reason: "invalid-observation-document" });
      const nativeRoots = this.options.observationWorldName
        ? await this.nativeShadowRoots(session.debuggee, root.backendNodeId, context.id, objectGroup, check) : undefined;
      const cached = session.nativeControlCandidates;
      let hosts: Array<{ backendNodeId: number } | { nodeId: number }>;
      if (nativeRoots) hosts = [];
      else if (cached?.frameId === frameId && cached.loaderId === session.frameLoaders.get(frameId)
        && cached.documentBackendNodeId === root.backendNodeId) hosts = cached.hosts.map((backendNodeId) => ({ backendNodeId }));
      else {
        // A capture can fail before obtaining a DOMSnapshot. Discover only
        // current root fields rather than fetching another whole document.
        let nodeId = root.nodeId;
        if (!Number.isSafeInteger(nodeId) || nodeId <= 0) {
          check();
          const current = await this.frontendDocument(session.debuggee, { depth: 0 }); check();
          if (current?.root?.backendNodeId !== root.backendNodeId)
            throw automationError("stale-observation", { reason: "observation-document-changed-during-read" });
          nodeId = current.root.nodeId;
        }
        if (!Number.isSafeInteger(nodeId) || nodeId <= 0)
          throw automationError("snapshot-unavailable", { reason: "missing-native-discovery-root" });
        const selected = await command("DOM.querySelectorAll", { nodeId, selector: "input,textarea,select" });
        if (!Array.isArray(selected?.nodeIds) || selected.nodeIds.some((id: number) => !Number.isSafeInteger(id) || id <= 0))
          throw automationError("snapshot-unavailable", { reason: "native-discovery-unavailable" });
        hosts = selected.nodeIds.map((nodeId: number) => ({ nodeId }));
      }
      const roots = nativeRoots ?? [], seen = new Set<number>();
      for (let offset = 0; offset < hosts.length; offset += 32) {
        const resolved = await Promise.allSettled(hosts.slice(offset, offset + 32).map(async (host) => {
          try {
            const response = await command("DOM.describeNode", { ...host, depth: 1, pierce: true });
            const node = response?.node;
            if (node?.nodeType !== 1 || !/^(?:input|textarea|select)$/i.test(node.nodeName ?? "")
              || "backendNodeId" in host && node.backendNodeId !== host.backendNodeId) return undefined;
            const shadows = (node.shadowRoots ?? []).filter((shadow: any) => shadow.shadowRootType === "user-agent");
            if (shadows.length > 1) throw automationError("snapshot-unavailable", { reason: "ambiguous-native-root" });
            const backendNodeId = shadows[0]?.backendNodeId;
            if (!Number.isSafeInteger(backendNodeId) || backendNodeId <= 0 || seen.has(backendNodeId)) return undefined;
            seen.add(backendNodeId);
            const value = await command("DOM.resolveNode", { backendNodeId, executionContextId: context.id, objectGroup });
            return typeof value?.object?.objectId === "string" ? { objectId: value.object.objectId } : undefined;
          } catch (error) {
            check();
            // A removed field contributes no old evidence. The final sample
            // detects replacement fields and reports their missing root.
            if (isDetachedNodeError(error)) return undefined;
            throw error;
          }
        }));
        check();
        const failed = resolved.find((value): value is PromiseRejectedResult => value.status === "rejected");
        if (failed) throw failed.reason;
        for (const value of resolved) if (value.status === "fulfilled" && value.value) roots.push(value.value);
      }
      const response = await command("Runtime.callFunctionOn", {
        objectId: documentObjectId, arguments: [{ value: pageZoom }, ...roots],
        functionDeclaration: NATIVE_OBSERVATION_SOURCE, returnByValue: true,
      });
      if (response?.exceptionDetails)
        throw automationError("snapshot-unavailable", { reason: "semantic-observation-failed", detail: response.exceptionDetails.exception?.description ?? response.exceptionDetails.text });
      return response?.result?.value ?? null;
    } finally {
      // The enclosing capture races cancellation. This task settles all
      // dispatched resolutions before releasing their group, even when late.
      void this.options.command(session.debuggee, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => undefined);
    }
  }

  private async captureReadableSnapshot(session: Session, region?: LocatorSpec): Promise<Awaited<ReturnType<AutomationRuntime["captureSnapshot"]>> & { readOnly?: true; limitations?: string; viewport?: ObservationRecord["viewport"] }> {
    const { guard, waitForCapture } = this.captureWaiter(session, this.context.signal);
    try { return await this.captureSnapshot(session, region); }
    catch (error) {
      // Scope-specific inspection and action resolution retain strict identity
      // checks. Only a whole-page read can become a root-viewport text sample.
      if (region || !(error instanceof AutomationError) || error.code !== "snapshot-unavailable"
        || !["dom-unstable", "text-paint-unstable", "dynamic-text-unstable", "text-paint-node-unstable", "dom-control-changed-during-capture", "frame-tree-unstable"].includes(String(error.detail.reason))) throw error;
      guard();
      const scope = this.rootReadScope(session);
      const guardRoot = () => { guard(); this.assertRootReadScope(session, scope); };
      let sample: ReturnType<typeof sampleReadableSnapshot>;
      try {
        await waitForCapture(this.prepareObservationPrimitives(session));
        const readZoom = typeof this.options.chromeApi.tabs.getZoom === "function"
          ? () => this.options.chromeApi.tabs.getZoom(session.tabId) : undefined;
        const pageZoom = readZoom ? await waitForCapture(readZoom()) : 0;
        guardRoot();
        sample = await waitForCapture(this.sampleNativeObservation(session, pageZoom, guardRoot));
        scope.context = this.extensionObservationContext(session, scope.frameId);
        guardRoot();
        if (readZoom && await waitForCapture(readZoom()) !== pageZoom)
          throw automationError("stale-observation", { reason: "page-zoom-changed-during-read" });
      } catch (cause) {
        guardRoot();
        if (cause instanceof AutomationError && cause.code === "stale-observation") throw cause;
        throw automationError("snapshot-unavailable", { reason: "read-only-sampling-unavailable", after: error.detail.reason,
          guidance: "The extension could not inspect this page safely. Retry when stable, use read_elements, or take_screenshot.",
          detail: cause instanceof Error ? cause.message : String(cause) });
      }
      guardRoot();
      let lines: SnapshotLine[];
      try { lines = readableSnapshot(sample!, (key, token, shadow) => {
        const context = this.extensionObservationContext(session, scope.frameId);
        if (!context) throw automationError("stale-observation", { reason: "missing-element-context" });
        const owner = JSON.stringify([this.context.conversationId, this.context.logIdentity?.runId ?? this.context.runId]);
        let ownership = this.sampledOwners.get(session);
        if (!ownership || ownership.owner !== owner) {
          ownership = { owner, ids: new Map() };
          this.sampledOwners.set(session, ownership);
        }
        const bindingKey = JSON.stringify([session.generation, context.uniqueId, token, key]);
        let id = ownership.ids.get(bindingKey);
        if (!id || !this.sampledIds.has(id)) {
          id = `t${session.tabId}s${session.token}d${session.generation}_e${session.nextRef++}`;
          ownership.ids.set(bindingKey, id);
        }
        this.sampledIds.set(id, { session, generation: session.generation, key, token, context, shadow, bindingKey,
          conversationId: this.context.conversationId, runId: this.context.logIdentity?.runId ?? this.context.runId });
        while (this.sampledIds.size > 32_768) {
          const oldest = this.sampledIds.keys().next().value!, entry = this.sampledIds.get(oldest)!;
          const owner = this.sampledOwners.get(entry.session);
          if (owner?.ids.get(entry.bindingKey) === oldest) owner.ids.delete(entry.bindingKey);
          entry.session.refs.delete(oldest); this.sampledIds.delete(oldest);
        }
        return id;
      }); }
      catch (cause) { throw automationError("snapshot-unavailable", { reason: "read-only-sampling-unavailable", after: error.detail.reason,
        detail: cause instanceof Error ? cause.message : String(cause), guidance: "The extension could not inspect this page safely. Retry when stable, use read_elements, or take_screenshot." }); }
      const ready = await waitForCapture(this.pageValue(session.tabId, "document.readyState === 'complete'"));
      guardRoot();
      if (!ready) throw automationError("stale-observation", { reason: "root-document-not-ready-after-read" });
      if (!lines.length) throw automationError("snapshot-unavailable", {
        reason: "read-only-no-proven-text", after: error.detail.reason,
        guidance: "No visible text could be confirmed in the read-only viewport sample. Retry when the page is stable, use read_elements for a scoped read, or take_screenshot for visual content.",
      });
      const gaps = new Map<string, number>();
      for (const gap of sample!.gaps) gaps.set(gap.reason, (gaps.get(gap.reason) ?? 0) + (gap.count ?? 1));
      const coverage = gaps.size ? ` Unconfirmed coverage: ${[...gaps].map(([reason, count]) => `${reason} (${count})`).join(", ")}.` : "";
      const limitations = `Read-only root viewport semantics sampled in one synchronous DOM read after ${error.detail.reason}. Roles, states and label fragments describe that same read; no earlier AX results were merged. Embedded documents are not included; actionable element IDs are revalidated before input.${coverage} This is incomplete evidence. Use find_elements for actionable element IDs or read_elements for scoped reads.`;
      const captured = { url: sample!.url, title: sample!.title, viewport: sample!.viewport, lines, frameRevision: session.frameRevision,
        geometry: "", geometrySources: [], geometryStyles: [], partial: true as const, readOnly: true as const, limitations };
      this.rootReadScopes.set(captured, scope);
      return captured;
    }
  }

  private async captureSnapshot(session: Session, region?: LocatorSpec): Promise<{ url: string; title: string; lines: SnapshotLine[]; frameRevision: number; regionIdentity?: string; geometry: string; geometrySources: Debuggee[]; geometryStyles: readonly string[]; geometryDynamicParents?: Map<string, Set<number>>; partial?: true; limitations?: string }> {
    const signal = this.context.signal;
    const frameContext = { conversationId: this.context.conversationId, runId: this.context.logIdentity?.runId ?? this.context.runId };
    const { guard, waitForCapture } = this.captureWaiter(session, signal);
    let retriedUnstableCapture = false;
    // Bound recovery within one observation even when distinct parts of a
    // live page keep changing. This does not limit subsequent agent actions.
    let dynamicRecoveryPasses = 0;
    let speculativeDynamic = false;
    const retryDynamicCapture = (reason = "dynamic-text-unstable") => {
      if (++dynamicRecoveryPasses > 8) throw automationError("snapshot-unavailable", { reason });
      if (!retriedUnstableCapture) speculativeDynamic = true;
      retriedUnstableCapture = true;
    };
    const dynamicTextByTarget = new Map<string, Set<number>>();
    let computedStyles: readonly string[] = session.snapshotStyleProfile?.generation === session.generation
      ? session.snapshotStyleProfile.computedStyles : SNAPSHOT_COMPUTED_STYLES;
    let retryGeneration: number | undefined, retryFrameRevision: number | undefined;
    while (true) {
      guard();
      // A debugger can attach after the load event, so lifecycle events alone
      // cannot establish readiness. Never return an observation of a document
      // while its load event is still pending.
      try {
        if (!await waitForCapture(this.pageValue(session.tabId, "document.readyState === 'complete'"))) {
          await delay(50, signal); continue;
        }
      } catch (error) {
        guard();
        if (!isTransientNavigationError(error)) throw error;
        await delay(50, signal); continue;
      }
      const generation = session.generation, frameRevision = session.frameRevision;
      if (session.snapshotStyleProfile?.generation !== generation) computedStyles = SNAPSHOT_COMPUTED_STYLES;
      if (retryGeneration !== generation || retryFrameRevision !== frameRevision) {
        // A changed document/frame graph invalidates the current attempt, not
        // the observation's recovery budget. Repeated child replacement must
        // reach the synchronous root sample instead of restarting forever.
        if (retryGeneration !== undefined) {
          if (dynamicRecoveryPasses) throw automationError("snapshot-unavailable", { reason: "frame-tree-unstable" });
          retryDynamicCapture("frame-tree-unstable");
        }
        retryGeneration = generation; retryFrameRevision = frameRevision; retriedUnstableCapture = false; speculativeDynamic = false; dynamicTextByTarget.clear();
      }
      const changed = () => generation !== session.generation || frameRevision !== session.frameRevision;
      let regionCandidateCount: number | undefined;
      const regionTask = region ? this.resolveOnce(session, region, matches => { regionCandidateCount = matches.length; }, false, true) : undefined;
      if (regionTask) void regionTask.then(async (objectId) => {
        if (!objectId || !signal?.aborted && !session.lifetime.signal.aborted && this.sessions.get(session.tabId) === session) return;
        const debuggee = this.objectDebuggees.get(objectId) ?? session.debuggee;
        this.objectDebuggees.delete(objectId);
        try { await this.options.command(debuggee, "Runtime.releaseObject", { objectId }); } catch { /* Context cleanup or detach may already have released it. */ }
      }).catch(() => undefined);
      const regionObject = regionTask ? await waitForCapture(regionTask) : undefined;
      const regionDebuggee = regionObject ? this.objectDebuggees.get(regionObject) ?? session.debuggee : undefined;
      let regionNode: any;
      if (regionObject) {
        try { regionNode = await waitForCapture(this.options.command(regionDebuggee!, "DOM.describeNode", { objectId: regionObject })); }
        finally {
          this.objectDebuggees.delete(regionObject);
          // Cleanup must not delay cancellation if CDP never settles.
          void this.options.command(regionDebuggee!, "Runtime.releaseObject", { objectId: regionObject }).catch(() => undefined);
        }
      }
      guard();
      if (changed()) { await delay(0, signal); continue; }
      if (region && !regionNode?.node?.backendNodeId) throw automationError("not-found", { locator: region,
        ...(!regionObject && regionCandidateCount === 0 && region.queries.some(query => query.kind === "frame" || query.kind === "frameRef") ? { reason: "frame-region-no-match", recovery: 'The region selector runs inside the selected frame. To inspect the whole frame, use inspect_page with region:{by:"css",value:"html",frame:{ref:"<frameRef>"}} using the selected frame ref.' } : {}) });
      const depthOf = (frameId: string) => { let depth = 0; let current = session.frameParents.get(frameId); while (current) { depth += 1; current = session.frameParents.get(current); } return depth; };
      const childFrames = [...session.frames]
        .filter(([, debuggee]) => debuggee.sessionId)
        .map(([frameId, debuggee]) => ({ frameId, debuggee, depth: depthOf(frameId) }))
        .filter((item, index, all) => all.findIndex((other) => other.debuggee.sessionId === item.debuggee.sessionId) === index)
        .sort((left, right) => left.depth - right.depth);
      const sameDebuggee = (left: Debuggee, right: Debuggee) => left.tabId === right.tabId && left.sessionId === right.sessionId;
      const allDebuggees = [{ debuggee: session.debuggee, frameId: undefined as string | undefined, depth: 0 }, ...childFrames];
      if (regionDebuggee && !allDebuggees.some(({ debuggee }) => sameDebuggee(debuggee, regionDebuggee))) throw automationError("frame-unavailable", { reason: "region-session-detached" });
      // A target's default AX request covers only its root document, even for
      // same-process child frames. Capture each additional frame explicitly.
      const frames = [...allDebuggees, ...[...session.frames]
        .filter(([frameId]) => frameId !== session.rootFrameId && !childFrames.some((item) => item.frameId === frameId))
        .map(([frameId, debuggee]) => ({ debuggee, frameId, depth: depthOf(frameId) }))]
        .sort((left, right) => left.depth - right.depth);
      const framesById = new Map(frames.map((item) => [item.frameId ?? session.rootFrameId, item]));
      let capturedFrames = frames;
      let relevantFrames = frames;
      let relevantDebuggees = allDebuggees;
      let regionFrameId: string | undefined;
      const frameGuard = () => {
        guard();
        if (changed()) throw automationError("stale-frame", { reason: "frame-tree-changed-during-capture" });
      };
      type Fillability = { fillable: boolean; disabled: boolean; readonly: boolean; mode: "richtext" | "plaintext" | null };
      type FillabilityBatch = { debuggee: Debuggee; frameId: string; values: Map<number, Fillability> };
      const fillabilityBatches: FillabilityBatch[] = [];
      type EllipsisRequest = { backendNodeId: number; prefix: string; sourceText: string; frameUnobscured: boolean; noShadowRoots: boolean; basePainted: boolean };
      type EllipsisProof = Parameters<typeof confirmAxEllipsis>[1] & { fingerprint: unknown; fullBounds: unknown };
      type EllipsisBatch = { debuggee: Debuggee; frameId: string; requests: EllipsisRequest[]; proofs: EllipsisProof[] };
      const ellipsisBatches: EllipsisBatch[] = [];
      const readEllipsisGeometry = async (debuggee: Debuggee, frameId: string, requests: readonly EllipsisRequest[]): Promise<Array<EllipsisProof | null>> => {
        if (!requests.length) return [];
        const frame: FrameRefRecord = { frameId, debuggee, generation, revision: frameRevision,
          conversationId: frameContext.conversationId, runId: frameContext.runId };
        const objectId = await this.frameDocument(session, frame, frameGuard);
        const key = JSON.stringify([session.tabId, frameId, debuggee.sessionId ?? null]);
        const document = this.frameDocuments.get(key);
        if (!document) throw automationError("stale-frame", { reason: "text-paint-context-expired" });
        const result = await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId,
          arguments: [{ value: document.paintCacheToken }, { value: requests }], functionDeclaration: AX_ELLIPSIS_GEOMETRY_SOURCE, returnByValue: true });
        frameGuard();
        if (this.frameDocuments.get(key) !== document) throw automationError("stale-frame", { reason: "text-paint-context-expired" });
        const values = result?.result?.value;
        return !result?.exceptionDetails && Array.isArray(values) && values.length === requests.length ? values : requests.map(() => null);
      };
      let unstableDOMChecked = false, unstableDOMAria = false;
      const readFillability = async (debuggee: Debuggee, frameId: string, ids: readonly number[]): Promise<Map<number, Fillability>> => {
        const values = new Map<number, Fillability>();
        if (!ids.length) return values;
        const frame: FrameRefRecord = { frameId, debuggee, generation, revision: frameRevision,
          conversationId: frameContext.conversationId, runId: frameContext.runId };
        await this.frameDocument(session, frame, frameGuard);
        const key = JSON.stringify([session.tabId, frameId, debuggee.sessionId ?? null]);
        const document = this.frameDocuments.get(key), contextId = document?.executionContextId;
        if (!Number.isSafeInteger(contextId)) throw automationError("snapshot-unavailable", { reason: "missing-editability-context" });
        const check = () => {
          frameGuard();
          if (this.frameDocuments.get(key) !== document) throw automationError("stale-frame", { reason: "frame-context-expired" });
        };
        const group = `surf-wax-editability:${crypto.randomUUID()}`;
        try {
          for (let offset = 0; offset < ids.length; offset += 32) {
            const batch = ids.slice(offset, offset + 32);
            const settled = await Promise.allSettled(batch.map(async (backendNodeId) => {
              const node = await this.options.command(debuggee, "DOM.resolveNode", { backendNodeId, executionContextId: contextId, objectGroup: group });
              check();
              if (typeof node.object?.objectId !== "string") throw automationError("snapshot-unavailable", { reason: "missing-editability-node" });
              const response = await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId: node.object.objectId, functionDeclaration: SNAPSHOT_FILLABILITY_SOURCE, returnByValue: true });
              check();
              const value = response.result?.value;
              if (response.exceptionDetails || !value || [value.fillable, value.disabled, value.readonly].some((item) => typeof item !== "boolean")
                || ![null, "richtext", "plaintext"].includes(value.mode))
                throw automationError("snapshot-unavailable", { reason: "missing-editability-evidence" });
              return value as Fillability;
            }));
            const failed = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
            if (failed) throw failed.reason;
            for (let index = 0; index < batch.length; index++) values.set(batch[index]!, (settled[index] as PromiseFulfilledResult<Fillability>).value);
          }
        } finally { void this.options.command(debuggee, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => undefined); }
        return values;
      };
      const frameIsReady = async ({ frameId, debuggee }: (typeof frames)[number]) => {
          if (debuggee.sessionId) await session.frameReady.get(debuggee.sessionId);
          frameGuard();
          if (!frameId) return this.pageValue(session.tabId, "document.readyState === 'complete'");
          const frame: FrameRefRecord = { frameId, debuggee, generation, revision: frameRevision,
            conversationId: this.context.conversationId, runId: this.context.logIdentity?.runId };
          const objectId = await this.frameDocument(session, frame, frameGuard);
          const response = await this.options.command(debuggee, "Runtime.callFunctionOn", {
            objectId, functionDeclaration: "function(){return this.readyState === 'complete'}", returnByValue: true,
          });
          if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
          return response.result?.value;
      };
      const framesAreReady = async () => {
        const states = await Promise.all(capturedFrames.map(frameIsReady));
        if (states.some((state) => typeof state !== "boolean")) throw automationError("snapshot-unavailable", { reason: "missing-frame-readiness" });
        return states.every(Boolean);
      };
      type PlaceholderCandidate = { frameId: string; debuggee: Debuggee; backendNodeId: number; expected: string; hostHidden: boolean };
      type PlaceholderProof = { evidence: PlaceholderEvidence; textBackendNodeId?: number };
      const placeholderKey = (item: PlaceholderCandidate) => JSON.stringify([item.debuggee.sessionId ?? "", item.frameId, item.backendNodeId]);
      let slottedByDebuggee = new Map<string, Set<number>>();
      const collectPlaceholders = async (items: PlaceholderCandidate[]): Promise<Map<string, PlaceholderProof>> => {
        const result = new Map<string, PlaceholderProof>();
        const groups = new Map<string, PlaceholderCandidate[]>();
        // Share each owner proof across placeholders in the same capture. The
        // second capture obtains fresh proofs before accepting any evidence.
        const ownerProofs = new Map<string, Promise<boolean>>();
        const ownerFullyContained = (frameId: string): Promise<boolean> => {
          let pending = ownerProofs.get(frameId);
          if (pending) return pending;
          pending = (async () => {
            const parentId = session.frameParents.get(frameId), parent = parentId && session.frames.get(parentId);
            if (!parentId || !parent) throw automationError("snapshot-unavailable", { reason: "missing-frame-parent", frameId });
            const frame: FrameRefRecord = { frameId: parentId, debuggee: parent, generation, revision: frameRevision,
              conversationId: frameContext.conversationId, runId: frameContext.runId };
            await this.frameDocument(session, frame, frameGuard);
            const key = JSON.stringify([session.tabId, parentId, parent.sessionId ?? null]);
            const document = this.frameDocuments.get(key), contextId = document?.executionContextId;
            if (!Number.isSafeInteger(contextId)) throw automationError("snapshot-unavailable", { reason: "missing-placeholder-context" });
            const check = () => {
              frameGuard();
              if (this.frameDocuments.get(key) !== document) throw automationError("stale-frame", { reason: "placeholder-context-expired" });
            };
            const group = `surf-wax-placeholder-owner:${crypto.randomUUID()}`;
            try {
              const owner = await this.options.command(parent, "DOM.getFrameOwner", { frameId });
              check();
              if (!Number.isSafeInteger(owner?.backendNodeId) || owner.backendNodeId <= 0)
                throw automationError("snapshot-unavailable", { reason: "missing-frame-owner", frameId });
              // assignedSlot is deliberately null through a closed shadow
              // root. CDP's flattened ancestry detects that case; until its
              // complete paint path is proven, do not expose the text.
              const slotted = slottedByDebuggee.get(parent.sessionId ?? "");
              if (!slotted || slotted.has(owner.backendNodeId)) return false;
              const node = await this.options.command(parent, "DOM.resolveNode", { backendNodeId: owner.backendNodeId, executionContextId: contextId, objectGroup: group });
              check();
              if (typeof node.object?.objectId !== "string") throw automationError("snapshot-unavailable", { reason: "missing-frame-owner-object", frameId });
              const response = await this.options.command(parent, "Runtime.callFunctionOn", { objectId: node.object.objectId, functionDeclaration: FRAME_OWNER_FULLY_VISIBLE_SOURCE, returnByValue: true });
              check();
              const status = response.result?.value?.status;
              if (response.exceptionDetails || !["visible", "unknown"].includes(status))
                throw automationError("snapshot-unavailable", { reason: "frame-containment-unavailable", frameId });
              return status === "visible";
            } finally { void this.options.command(parent, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => undefined); }
          })();
          ownerProofs.set(frameId, pending);
          return pending;
        };
        const frameFullyContained = async (frameId: string): Promise<boolean> => {
          const visited = new Set<string>();
          while (frameId !== session.rootFrameId) {
            if (visited.has(frameId)) throw automationError("snapshot-unavailable", { reason: "cyclic-frame-ancestry" });
            visited.add(frameId);
            if (!await ownerFullyContained(frameId)) return false;
            const parentId = session.frameParents.get(frameId);
            if (!parentId) throw automationError("snapshot-unavailable", { reason: "missing-frame-parent", frameId });
            frameId = parentId;
          }
          return true;
        };
        for (const item of items) {
          if (item.hostHidden) { result.set(placeholderKey(item), { evidence: { status: "hidden" } }); continue; }
          const key = JSON.stringify([item.debuggee.sessionId ?? "", item.frameId]);
          const group = groups.get(key) ?? []; group.push(item); groups.set(key, group);
        }
        const tasks = [...groups.values()].map(async (group) => {
          const first = group[0]!, debuggee = first.debuggee;
          const frame: FrameRefRecord = { frameId: first.frameId, debuggee, generation, revision: frameRevision,
            conversationId: frameContext.conversationId, runId: frameContext.runId };
          await this.frameDocument(session, frame, frameGuard);
          const frameKey = JSON.stringify([session.tabId, first.frameId, debuggee.sessionId ?? null]);
          const document = this.frameDocuments.get(frameKey);
          const contextId = document?.executionContextId;
          if (!Number.isSafeInteger(contextId)) throw automationError("snapshot-unavailable", { reason: "missing-placeholder-context" });
          const placeholderGuard = () => {
            frameGuard();
            if (this.frameDocuments.get(frameKey) !== document) throw automationError("stale-frame", { reason: "placeholder-context-expired" });
          };
          const objectGroup = `surf-wax-placeholder:${crypto.randomUUID()}`;
          try {
            for (let offset = 0; offset < group.length; offset += 32) {
              placeholderGuard();
              const batch = group.slice(offset, offset + 32);
              const settled = await Promise.allSettled(batch.map(async (item) => {
                const described = await this.options.command(debuggee, "DOM.describeNode", { backendNodeId: item.backendNodeId, depth: -1, pierce: true });
                placeholderGuard();
                if (described.node?.backendNodeId !== item.backendNodeId) throw automationError("snapshot-unavailable", { reason: "placeholder-host-changed" });
                const pending: any[] = [...(described.node.shadowRoots ?? [])], textIds: number[] = [];
                while (pending.length) {
                  const node = pending.pop(), attributes = node?.attributes ?? [];
                  let pseudo = false;
                  for (let index = 0; index + 1 < attributes.length; index += 2)
                    if (attributes[index] === "pseudo" && attributes[index + 1] === "-webkit-input-placeholder") pseudo = true;
                  if (pseudo && node.children?.length === 1 && node.children[0]?.nodeType === 3 && Number.isSafeInteger(node.children[0].backendNodeId))
                    textIds.push(node.children[0].backendNodeId);
                  for (const child of node?.children ?? []) pending.push(child);
                  for (const shadow of node?.shadowRoots ?? []) pending.push(shadow);
                }
                const textBackendNodeId = textIds.length === 1 ? textIds[0] : undefined;
                const host = await this.options.command(debuggee, "DOM.resolveNode", { backendNodeId: item.backendNodeId, executionContextId: contextId, objectGroup });
                placeholderGuard();
                if (typeof host.object?.objectId !== "string") throw automationError("snapshot-unavailable", { reason: "missing-placeholder-host" });
                let text: string | undefined;
                if (textBackendNodeId !== undefined) {
                  const resolved = await this.options.command(debuggee, "DOM.resolveNode", { backendNodeId: textBackendNodeId, executionContextId: contextId, objectGroup });
                  placeholderGuard(); text = resolved.object?.objectId;
                  if (typeof text !== "string") throw automationError("snapshot-unavailable", { reason: "missing-placeholder-text" });
                }
                const response = await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId: host.object.objectId,
                  functionDeclaration: PLACEHOLDER_EVIDENCE_SOURCE, arguments: [text ? { objectId: text } : { value: null }, { value: item.expected }], returnByValue: true });
                placeholderGuard();
                const value = response.result?.value;
                if (response.exceptionDetails || !value || !["visible", "hidden", "unknown"].includes(value.status)
                  || value.status === "visible" && (typeof value.text !== "string" || value.text !== item.expected))
                  throw automationError("snapshot-unavailable", { reason: "placeholder-evidence-unavailable" });
                const slots = slottedByDebuggee.get(debuggee.sessionId ?? "");
                const evidence: PlaceholderEvidence = value.status === "visible"
                  ? slots && !slots.has(item.backendNodeId) && await frameFullyContained(item.frameId) ? { status: "visible", text: value.text } : { status: "unknown" }
                  : { status: value.status };
                return { evidence, ...(textBackendNodeId === undefined ? {} : { textBackendNodeId }) };
              }));
              const failed = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
              if (failed) throw failed.reason;
              for (let index = 0; index < batch.length; index++) result.set(placeholderKey(batch[index]!), (settled[index] as PromiseFulfilledResult<PlaceholderProof>).value);
            }
          } finally { void this.options.command(debuggee, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => undefined); }
        });
        const settled = await Promise.allSettled(tasks);
        const failed = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
        if (failed) {
          if (!changed() && failed.reason instanceof AutomationError && failed.reason.code === "stale-frame"
            && failed.reason.detail.reason === "frame-context-expired")
            throw automationError("stale-frame", { reason: "placeholder-context-expired" });
          if (!changed() && (isDetachedNodeError(failed.reason) || isTransientNavigationError(failed.reason)))
            throw automationError("stale-frame", { reason: "placeholder-node-detached" });
          throw failed.reason;
        }
        return result;
      };
      let placeholderItems: PlaceholderCandidate[] = [], placeholderBefore = new Map<string, PlaceholderProof>();
      type TextProjection = { full: string; text: string };
      let trees: Array<{ debuggee: Debuggee; frameId: string | undefined; depth: number; tree: any; visibility: Map<number, boolean>; partialFrames: Set<number>; textProjections: Map<number, TextProjection>; unknownText: Set<number>; paintEvidence: Map<number, TextPaintEvidence>; candidates: SnapshotTextPaintCandidate[]; snapshot: any }>;
      let initialLayouts: Array<{ debuggee: Debuggee; snapshot: any }> = [];
      const recoverDetachedText = async (): Promise<void> => {
        const next = await waitForCapture(Promise.all(initialLayouts.map(async ({ debuggee }) => ({ debuggee,
          snapshot: await this.options.command(debuggee, "DOMSnapshot.captureSnapshot", { computedStyles: [...computedStyles], includeDOMRects: true, includePaintOrder: true }) }))));
        if (changed()) return;
        let valid = true, found = false;
        const observed = new Map<string, Set<number>>();
        const styleEvidence = computedStyles === SNAPSHOT_COMPUTED_STYLES ? undefined : { completeStyleCatalog: computedStyles };
        for (let i = 0; i < initialLayouts.length; i++) {
          const before = initialLayouts[i]!, after = next[i]!;
          if (sameDOMSnapshot(before.snapshot, after.snapshot, undefined, styleEvidence)) continue;
          const ids = changedTextNodes(before.snapshot, after.snapshot, undefined, styleEvidence);
          if (!ids) { valid = false; break; }
          found = true; observed.set(before.debuggee.sessionId ?? "", ids);
        }
        if (valid && found) {
          let newlyTracked = false;
          for (const [key, ids] of observed) {
            const tracked = dynamicTextByTarget.get(key) ?? new Set<number>();
            for (const id of ids) if (!tracked.has(id)) { tracked.add(id); newlyTracked = true; }
            dynamicTextByTarget.set(key, tracked);
          }
          if (!newlyTracked) throw automationError("snapshot-unavailable", { reason: "text-paint-node-unstable" });
          retryDynamicCapture();
          return;
        }
        if (retriedUnstableCapture) throw automationError("snapshot-unavailable", { reason: "text-paint-node-unstable" });
        retriedUnstableCapture = true;
      };
      let info: { url: string; title: string };
      const frameClips = new Map<string, SnapshotClip>();
      const hiddenFrames = new Set<string>();
      try {
        // A scoped request discovers its frame membership from a preliminary
        // DOM capture before waiting for document loads. The subsequent D0
        // capture must prove the same membership after those waits.
        type Layout = { debuggee: Debuggee; snapshot: any };
        const captureLayout = async (debuggee: Debuggee): Promise<Layout> => {
          if (debuggee.sessionId) await session.frameReady.get(debuggee.sessionId);
          frameGuard();
          const snapshot = await this.options.command(debuggee, "DOMSnapshot.captureSnapshot", { computedStyles: [...computedStyles], includeDOMRects: true, includePaintOrder: true });
          if (!debuggee.sessionId && session.rootFrameId) {
            const candidates = nativeControlCandidates(snapshot, session.rootFrameId);
            if (candidates) session.nativeControlCandidates = { ...candidates, frameId: session.rootFrameId, loaderId: session.frameLoaders.get(session.rootFrameId) };
          }
          return { debuggee, snapshot };
        };
        const selectRegionFrames = async (layouts: Layout[], allowCapture: boolean) => {
          if (!regionNode || !regionDebuggee) return { frameId: undefined, selected: frames };
          const getLayout = async (debuggee: Debuggee) => {
            let layout = layouts.find((item) => sameDebuggee(item.debuggee, debuggee));
            if (!layout && allowCapture) { layout = await captureLayout(debuggee); layouts.push(layout); }
            return layout;
          };
          const layout = await getLayout(regionDebuggee);
          const matches = (layout?.snapshot.documents ?? []).filter((doc: any) => doc.nodes?.backendNodeId?.includes(regionNode.node.backendNodeId));
          if (matches.length !== 1) throw automationError("snapshot-region-unavailable", { locator: region });
          const doc = matches[0], frameId = layout!.snapshot.strings?.[doc.frameId];
          if (typeof frameId !== "string" || !frames.some((item) => (item.frameId ?? session.rootFrameId) === frameId && sameDebuggee(item.debuggee, regionDebuggee)))
            throw automationError("snapshot-region-unavailable", { locator: region });
          let index: ReturnType<typeof createSnapshotDomIndex>;
          try { index = createSnapshotDomIndex(doc.nodes); }
          catch { throw automationError("snapshot-unavailable", { reason: "invalid-dom-snapshot" }); }
          const visibility = new Map<string, Map<number, boolean>>();
          const indexes = new Map<string, ReturnType<typeof createSnapshotDomIndex>>([[frameId, index]]);
          const parentEvidence = async (id: string) => {
            const parent = session.frames.get(id);
            if (!parent) throw automationError("snapshot-unavailable", { reason: "missing-frame-parent", frameId: id });
            const parentLayout = await getLayout(parent);
            if (!parentLayout) return undefined;
            let parentIndex = indexes.get(id);
            if (!parentIndex) {
              const parentDoc = parentLayout.snapshot.documents?.find((candidate: any) => parentLayout.snapshot.strings?.[candidate.frameId] === id);
              if (!parentDoc) throw automationError("snapshot-unavailable", { reason: "missing-dom-frame", frameId: id });
              try { parentIndex = createSnapshotDomIndex(parentDoc.nodes); }
              catch { throw automationError("snapshot-unavailable", { reason: "invalid-dom-snapshot" }); }
              indexes.set(id, parentIndex);
            }
            let state = visibility.get(parent.sessionId ?? "");
            if (!state) { state = snapshotVisibility(parentLayout.snapshot); visibility.set(parent.sessionId ?? "", state); }
            return { parent, parentIndex, state };
          };
          // Establish visibility of the entire region frame chain before
          // touching descendants of a hidden region.
          for (let current: string | undefined = frameId; current && current !== session.rootFrameId;) {
            const parentId = session.frameParents.get(current);
            if (!parentId) throw automationError("snapshot-unavailable", { reason: "unknown-frame-ancestry", frameId: current });
            const evidence = await parentEvidence(parentId);
            if (!evidence) return { frameId, selected: [] };
            const owner = await this.options.command(evidence.parent, "DOM.getFrameOwner", { frameId: current });
            frameGuard();
            if (evidence.parentIndex.indexOf(owner?.backendNodeId) === undefined)
              throw automationError("snapshot-unavailable", { reason: "missing-frame-owner", frameId: current });
            const visible = evidence.state.get(owner.backendNodeId);
            if (visible === undefined) throw automationError("snapshot-unavailable", { reason: "missing-frame-owner-visibility", frameId: current });
            if (!visible) throw automationError("snapshot-region-unavailable", { locator: region });
            current = parentId;
          }
          const selected = new Set([frameId]);
          const readyFrames = new Set<string>();
          const ready = async (id: string) => {
            if (readyFrames.has(id)) return true;
            const item = framesById.get(id)!;
            if (!await frameIsReady(item)) return false;
            readyFrames.add(id); return true;
          };
          const knownOwners = new Map<string, Set<number>>();
          for (const child of frames) {
            const id = child.frameId;
            if (!id || id === frameId) continue;
            const parentId = session.frameParents.get(id);
            if (!parentId || !selected.has(parentId)) continue;
            if (allowCapture && !await ready(parentId)) return { frameId, selected: [], pending: true };
            const evidence = await parentEvidence(parentId);
            if (!evidence) return { frameId, selected: [] };
            const owner = await this.options.command(evidence.parent, "DOM.getFrameOwner", { frameId: id });
            frameGuard();
            if (evidence.parentIndex.indexOf(owner?.backendNodeId) === undefined)
              throw automationError("snapshot-unavailable", { reason: "missing-frame-owner", frameId: id });
            const ownerIds = knownOwners.get(parentId) ?? new Set<number>();
            ownerIds.add(owner?.backendNodeId); knownOwners.set(parentId, ownerIds);
            if (parentId === frameId && index.contains(regionNode.node.backendNodeId, owner?.backendNodeId) !== true) continue;
            const visible = evidence.state.get(owner?.backendNodeId);
            if (visible === undefined) throw automationError("snapshot-unavailable", { reason: "missing-frame-owner-visibility", frameId: id });
            if (visible) selected.add(id);
          }
          // A visible iframe owner without a known frame cannot be treated as
          // an empty frame: attachment may still be in flight.
          for (const id of selected) {
            const item = framesById.get(id)!;
            if (allowCapture && !await ready(id)) return { frameId, selected: [], pending: true };
            const parentLayout = await getLayout(item.debuggee);
            if (!parentLayout) return { frameId, selected: [] };
            const parentDoc = parentLayout.snapshot.documents?.find((candidate: any) => parentLayout.snapshot.strings?.[candidate.frameId] === id);
            if (!parentDoc) throw automationError("snapshot-unavailable", { reason: "missing-dom-frame", frameId: id });
            let state = visibility.get(item.debuggee.sessionId ?? "");
            if (!state) { state = snapshotVisibility(parentLayout.snapshot); visibility.set(item.debuggee.sessionId ?? "", state); }
            const names = parentDoc.nodes?.nodeName ?? [], ids = parentDoc.nodes?.backendNodeId ?? [];
            for (let node = 0; node < ids.length; node++) {
              const tag = parentLayout.snapshot.strings?.[names[node]]?.toLowerCase();
              if (tag !== "iframe" && tag !== "frame") continue;
              const owner = ids[node];
              if (id === frameId && index.contains(regionNode.node.backendNodeId, owner) !== true) continue;
              if (state.get(owner) === true && !knownOwners.get(id)?.has(owner))
                throw automationError("snapshot-unavailable", { reason: "frame-owner-not-attached", frameId: id });
            }
          }
          return { frameId, selected: frames.filter((item) => selected.has(item.frameId ?? session.rootFrameId ?? "")) };
        };
        const captureLayouts = () => Promise.all(relevantDebuggees.map(({ debuggee }) => captureLayout(debuggee)));
        const preliminary: Layout[] | undefined = regionNode ? [] : undefined;
        if (preliminary) {
          const selection = await waitForCapture(selectRegionFrames(preliminary, true));
          if (selection.pending) { await delay(50, signal); continue; }
          regionFrameId = selection.frameId; capturedFrames = selection.selected;
          const required = new Set(capturedFrames.map((item) => item.frameId ?? session.rootFrameId));
          for (const id of [...required]) {
            let current = id;
            while (current && current !== session.rootFrameId) {
              current = session.frameParents.get(current);
              if (!current) throw automationError("snapshot-unavailable", { reason: "unknown-frame-ancestry", frameId: id });
              required.add(current);
            }
          }
          relevantFrames = frames.filter((item) => required.has(item.frameId ?? session.rootFrameId));
          relevantDebuggees = allDebuggees.filter(({ debuggee }) => relevantFrames.some((item) => sameDebuggee(item.debuggee, debuggee)));
        }
        await waitForCapture(Promise.all(relevantDebuggees.map(({ debuggee }) => debuggee.sessionId ? session.frameReady.get(debuggee.sessionId) : undefined)));
        frameGuard();
        if (!await waitForCapture(framesAreReady())) { await delay(50, signal); continue; }
        if (changed()) { await delay(0, signal); continue; }
        // Bracket AX and live DOM reads with bulk DOM captures. This detects
        // ordinary page changes that do not advance the document generation.
        initialLayouts = await waitForCapture(captureLayouts());
        if (regionNode) {
          const verified = await waitForCapture(selectRegionFrames(initialLayouts, false));
          if (verified.frameId !== regionFrameId || verified.selected.length !== capturedFrames.length || verified.selected.some((item, index) => item !== capturedFrames[index])) continue;
        }
        // Map each parent's visible iframe aperture into the child document's
        // coordinates before interpreting any child content. Work from parents
        // to children so nested frame clips compose.
        const parentVisibility = new Map<string, { state: Map<number, boolean>; partialFrames: Set<number>; frameOwners: Map<number, SnapshotFrameOwner> }>();
        for (const item of [...relevantFrames].sort((a, b) => a.depth - b.depth)) {
          const childId = item.frameId;
          if (!childId || childId === session.rootFrameId) continue;
          const parentId = session.frameParents.get(childId), parent = parentId && session.frames.get(parentId);
          if (parentId && hiddenFrames.has(parentId)) { hiddenFrames.add(childId); continue; }
          const parentLayout = parent && initialLayouts.find((entry) => sameDebuggee(entry.debuggee, parent));
          const childLayout = initialLayouts.find((entry) => sameDebuggee(entry.debuggee, item.debuggee));
          if (!parent || !parentLayout || !childLayout) throw automationError("snapshot-unavailable", { reason: "missing-frame-parent", frameId: childId });
          const owner = await this.options.command(parent, "DOM.getFrameOwner", { frameId: childId });
          frameGuard();
          let evidence = parentVisibility.get(parentId!);
          if (!evidence) {
            const partialFrames = new Set<number>();
            const frameOwners = new Map<number, SnapshotFrameOwner>();
            const snapshot = parentLayout.snapshot;
            const documents = snapshot.documents.filter((doc: any) => snapshot.strings[doc.frameId] === parentId);
            if (documents.length !== 1) throw automationError("snapshot-unavailable", { reason: "missing-parent-document", frameId: parentId });
            const state = snapshotVisibility({ ...snapshot, documents }, { frameClips, frameOwners, partialFrames, requireViewport: true });
            evidence = { state, partialFrames, frameOwners };
            parentVisibility.set(parentId!, evidence);
          }
          const { state, partialFrames, frameOwners } = evidence;
          const geometry = frameOwners.get(owner?.backendNodeId);
          // A painted border does not give an empty iframe content viewport
          // any visible pixels. Use the captured, axis-aligned client aperture
          // as proof; never infer invisibility from the child's missing data.
          const emptyAperture = geometry?.safe && (geometry.clip.x[1] <= geometry.clip.x[0] || geometry.clip.y[1] <= geometry.clip.y[0]);
          if (state.get(owner?.backendNodeId) !== true || emptyAperture) { hiddenFrames.add(childId); continue; }
          if (!partialFrames.has(owner.backendNodeId)) continue;
          const doc = childLayout.snapshot.documents?.find((entry: any) => childLayout.snapshot.strings?.[entry.frameId] === childId);
          const root = doc?.nodes?.nodeName?.findIndex((name: number) => childLayout.snapshot.strings?.[name] === "#document");
          const index = doc?.layout?.nodeIndex?.indexOf(root), bounds = index >= 0 ? doc.layout.bounds[index] : undefined;
          const offsets = [doc?.scrollOffsetX, doc?.scrollOffsetY];
          if (!geometry?.safe || !Array.isArray(bounds) || bounds.length < 4 || !bounds.every(Number.isFinite)
            || !offsets.every((value) => typeof value === "number" && Number.isFinite(value)))
            throw automationError("snapshot-unavailable", { reason: "partially-clipped-frame", frameId: childId });
          const mapped = ([start, end]: readonly [number, number], [left, right]: readonly [number, number], size: number, offset: number): readonly [number, number] => {
            const scale = (right - left) / size;
            if (!(size > 0 && Number.isFinite(scale) && scale > 0)) throw automationError("snapshot-unavailable", { reason: "partially-clipped-frame", frameId: childId });
            return [offset + (start - left) / scale, offset + (end - left) / scale];
          };
          frameClips.set(childId, { x: mapped(geometry.clip.x, geometry.rect.x, bounds[2], offsets[0]), y: mapped(geometry.clip.y, geometry.rect.y, bounds[3], offsets[1]) });
        }
        placeholderItems = [];
        const initialPaint = new Map(initialLayouts.map(({ debuggee, snapshot }) => {
          const candidates: SnapshotTextPaintCandidate[] = [];
          const partialFrames = new Set<number>();
          const required = new Set(relevantFrames.map(item => item.frameId ?? session.rootFrameId));
          const relevantSnapshot = regionNode ? { ...snapshot, documents: snapshot.documents.filter((doc: any) => required.has(snapshot.strings[doc.frameId])) } : snapshot;
          const visibility = snapshotVisibility(relevantSnapshot, { textPaintCandidates: candidates, partialFrames, frameClips, hiddenFrames, requireViewport: true });
          return [debuggee.sessionId ?? "", { visibility, candidates, partialFrames }] as const;
        }));
        for (const item of capturedFrames) {
          const frameId = item.frameId ?? session.rootFrameId;
          const layout = initialLayouts.find((entry) => sameDebuggee(entry.debuggee, item.debuggee));
          const snapshot = layout?.snapshot;
          const doc = snapshot?.documents?.find((entry: any) => snapshot.strings?.[entry.frameId] === frameId);
          if (!frameId || !doc) throw automationError("snapshot-unavailable", { reason: "missing-dom-frame", frameId });
          for (let index = 0; index < (doc.nodes?.backendNodeId?.length ?? 0); index++) {
            const id = doc.nodes.backendNodeId[index], tag = snapshot.strings?.[doc.nodes.nodeName?.[index]]?.toLowerCase();
            if ((tag !== "input" && tag !== "textarea") || !Number.isSafeInteger(id) || id <= 0) continue;
            const attributes = doc.nodes.attributes?.[index] ?? [];
            if (!Array.isArray(attributes) || attributes.length % 2) throw automationError("snapshot-unavailable", { reason: "invalid-dom-snapshot" });
            for (let offset = 0; offset < attributes.length; offset += 2) {
              const name = snapshot.strings?.[attributes[offset]];
              if (typeof name !== "string") throw automationError("snapshot-unavailable", { reason: "invalid-dom-snapshot" });
              if (name.toLowerCase() !== "placeholder") continue;
              const expected = attributes[offset + 1] === -1 ? "" : snapshot.strings?.[attributes[offset + 1]];
              if (typeof expected !== "string") throw automationError("snapshot-unavailable", { reason: "invalid-dom-snapshot" });
              if (expected) placeholderItems.push({ frameId, debuggee: item.debuggee, backendNodeId: id, expected,
                hostHidden: initialPaint.get(item.debuggee.sessionId ?? "")?.visibility.get(id) === false });
            }
          }
        }
        try { slottedByDebuggee = placeholderItems.length
          ? new Map(initialLayouts.map(({ debuggee, snapshot }) => [debuggee.sessionId ?? "", snapshotSlottedNodes(snapshot)])) : new Map(); }
        catch { throw automationError("snapshot-unavailable", { reason: "invalid-dom-snapshot" }); }
        placeholderBefore = await waitForCapture(collectPlaceholders(placeholderItems));
        const [captured, layouts, pageInfo] = await waitForCapture(Promise.all([
          Promise.all(relevantFrames.map(async (item) => ({ ...item, tree: capturedFrames.includes(item)
            ? await this.options.command(item.debuggee, "Accessibility.getFullAXTree", allDebuggees.includes(item) ? {} : { frameId: item.frameId })
            : undefined }))),
          Promise.all(initialLayouts.map(async ({ debuggee, snapshot }) => {
            const { candidates, visibility, partialFrames } = initialPaint.get(debuggee.sessionId ?? "")!;
            const textProjections = new Map<number, TextProjection>();
            const unknownText = dynamicTextNodes(snapshot, dynamicTextByTarget.get(debuggee.sessionId ?? ""));
            const paintEvidence = new Map<number, TextPaintEvidence>();
            const byFrame = new Map<string, SnapshotTextPaintCandidate[]>();
            for (const candidate of candidates) {
              if (candidate.sameColorBackground) {
                unknownText.add(candidate.backendNodeId);
                continue;
              }
              if (unknownText.has(candidate.backendNodeId)) {
                // Paint proof for this changing text cannot be sampled
                // reliably. Its dependent names remain unknown, but the
                // text itself must not be claimed as visibly painted.
                visibility.set(candidate.backendNodeId, false);
                continue;
              }
              const list = byFrame.get(candidate.frameId) ?? [];
              list.push(candidate); byFrame.set(candidate.frameId, list);
            }
            await Promise.all([...byFrame].map(async ([frameId, list]) => {
              const source = capturedFrames.find((frame) => (frame.frameId ?? session.rootFrameId) === frameId && sameDebuggee(frame.debuggee, debuggee));
              if (!source) {
                if (regionNode || !capturedFrames.some((frame) => sameDebuggee(frame.debuggee, debuggee))) return;
                throw automationError("snapshot-unavailable", { reason: "missing-text-paint-frame", frameId });
              }
              const frame: FrameRefRecord = { frameId, debuggee, generation, revision: frameRevision,
                conversationId: this.context.conversationId, runId: this.context.logIdentity?.runId };
              const measured = await this.readFrameTextPaint(session, frame, list, frameGuard);
              for (const candidate of list) {
                const evidence = measured.get(candidate.backendNodeId)!;
                paintEvidence.set(candidate.backendNodeId, evidence);
                const projection = projectTextPaint(candidate, evidence);
                if (projection?.hidden) visibility.set(candidate.backendNodeId, false);
                else if (projection?.text !== undefined && typeof candidate.layoutText === "string")
                  textProjections.set(candidate.backendNodeId, { full: (candidate.firstLetter ?? "") + candidate.layoutText, text: projection.text });
                else if (!projection) unknownText.add(candidate.backendNodeId);
              }
            }));
            return { debuggee, visibility, partialFrames, textProjections, unknownText, paintEvidence, candidates, snapshot };
          })),
          this.pageValue(session.tabId, "({url:location.href,title:document.title})") as Promise<{ url: string; title: string }>,
        ]));
        const layoutsByTarget = new Map(layouts.map(({ debuggee, ...layout }) => [debuggee.sessionId ?? "", layout]));
        trees = captured.map((item) => ({ ...item, ...layoutsByTarget.get(item.debuggee.sessionId ?? "")! }));
        info = pageInfo;
      } catch (error) {
        guard();
        const stalePaintContext = error instanceof AutomationError && error.code === "stale-frame"
          && ["text-paint-context-expired", "frame-context-expired", "placeholder-context-expired", "placeholder-node-detached"].includes(String(error.detail.reason));
        if (stalePaintContext && !changed() && error instanceof AutomationError && ["placeholder-context-expired", "placeholder-node-detached"].includes(String(error.detail.reason))) {
          if (retriedUnstableCapture) throw automationError("snapshot-unavailable", { reason: "placeholder-context-unstable" });
          retriedUnstableCapture = true;
        }
        if (!changed() && !stalePaintContext && isDetachedNodeError(error) && initialLayouts.length) {
          await recoverDetachedText();
          continue;
        }
        if (!changed() && !isTransientNavigationError(error) && !isDetachedNodeError(error) && !stalePaintContext) throw error;
        await delay(changed() ? 0 : 50, signal); continue;
      }
      guard();
      if (changed()) { await delay(0, signal); continue; }
      try {
        if (!await waitForCapture(framesAreReady())) { await delay(50, signal); continue; }
      } catch (error) {
        guard();
        if (!changed() && !isTransientNavigationError(error)) throw error;
        await delay(0, signal); continue;
      }
      if (changed()) { await delay(0, signal); continue; }
      // An OOPIF is captured independently of its embedding document, so its
      // AX tree alone cannot tell us whether any host in the frame chain is
      // hidden. Reuse the per-target layout indexes for all host elements.
      const visibilityBySession = new Map(trees.map(({ debuggee, visibility }) => [debuggee.sessionId ?? "", visibility]));
      const partialFramesBySession = new Map(trees.map(({ debuggee, partialFrames }) => [debuggee.sessionId ?? "", partialFrames]));
      const owners = new Map<string, boolean>();
      const childFramesByOwner = new Map<string, string>();
      if (relevantFrames.some((item) => item.frameId)) {
        const rootFrameId = session.rootFrameId;
        if (!rootFrameId) throw automationError("snapshot-unavailable", { reason: "missing-root-frame" });
        const ancestry = new Set<string>();
        for (const { frameId } of relevantFrames) {
          if (!frameId) continue;
          let current: string | undefined = frameId;
          const seen = new Set<string>();
          while (current && current !== rootFrameId && !ancestry.has(current)) {
            if (seen.has(current) || !session.frameParents.has(current)) throw automationError("snapshot-unavailable", { reason: "unknown-frame-ancestry", frameId });
            seen.add(current); ancestry.add(current);
            current = session.frameParents.get(current);
          }
          if (!current) throw automationError("snapshot-unavailable", { reason: "unknown-frame-ancestry", frameId });
        }
        try {
          await waitForCapture(Promise.all([...ancestry].map(async (frameId) => {
            const parentId = session.frameParents.get(frameId);
            const parent = parentId && session.frames.get(parentId);
            if (!parent) throw automationError("snapshot-unavailable", { reason: "missing-frame-parent", frameId });
            const owner = await this.options.command(parent, "DOM.getFrameOwner", { frameId });
            if (partialFramesBySession.get(parent.sessionId ?? "")?.has(owner?.backendNodeId) && !frameClips.has(frameId))
              throw automationError("snapshot-unavailable", { reason: "partially-clipped-frame", frameId });
            const visible = visibilityBySession.get(parent.sessionId ?? "")?.get(owner?.backendNodeId);
            if (visible === undefined) throw automationError("snapshot-unavailable", { reason: "missing-frame-owner-visibility", frameId });
            owners.set(frameId, visible);
            childFramesByOwner.set(JSON.stringify([parent.sessionId ?? "", owner.backendNodeId]), frameId);
          })));
        } catch (error) {
          guard();
          if (!changed()) throw error;
          await delay(0, signal); continue;
        }
        const frameVisibility = createFrameVisibility(rootFrameId, session.frameParents, owners);
        for (const item of trees) if (item.frameId) {
          const visible = frameVisibility(item.frameId);
          if (visible === "unknown") throw automationError("snapshot-unavailable", { reason: "unknown-frame-visibility", frameId: item.frameId });
          if (visible === "hidden") item.tree = undefined;
        }
      }
      // Only frames whose own subtree was captured and whose entire owner
      // chain is visible receive a model-visible, actionable frame handle.
      const capturedFrameRefs = new Map<string, string>();
      for (const item of trees) {
        const frameId = item.frameId ?? session.rootFrameId;
        if (item.tree && frameId) capturedFrameRefs.set(frameId, this.rememberFrameRef(session, frameId, item.debuggee, frameContext));
      }
      type FramePaintProof = { frameId: string; parentId: string; backendNodeId: number; value: unknown };
      const framePaintBatches: FramePaintProof[][] = [];
      const framePaintCache = new Map<string, Promise<FramePaintProof[] | null>>();
      const proofFailures = new Set<string>();
      const proofFailed = (stage: string, frameId: string, debuggee: Debuggee, error: unknown) => {
        const key = JSON.stringify([stage, frameId, debuggee.sessionId]);
        if (proofFailures.has(key)) return;
        proofFailures.add(key);
        this.options.logger?.telemetry({ type: "browser.snapshot.proof-failed", ...frameContext, ...this.context.logIdentity,
          content: { tabId: session.tabId, frameId, source: debuggee, stage }, error: safeDiagnosticError(error) });
      };
      // Prove the entire owner is free of competing paint at each level. This
      // intentionally needs no coordinate mapping between frame viewports.
      const readFramePaint = async (frameId: string): Promise<FramePaintProof[] | null> => {
        const proof: FramePaintProof[] = [], visited = new Set<string>();
        let current = frameId;
        while (current !== session.rootFrameId) {
          if (visited.has(current)) return null;
          visited.add(current);
          const parentId = session.frameParents.get(current), parent = parentId && session.frames.get(parentId);
          const parentTree = trees.find(item => (item.frameId ?? session.rootFrameId) === parentId && parent && sameDebuggee(item.debuggee, parent));
          const doc = parentTree?.snapshot?.documents?.find((entry: any) => parentTree.snapshot.strings?.[entry.frameId] === parentId);
          const shadowRoots = doc?.nodes?.shadowRootType?.index;
          if (!parentId || !parent || !Array.isArray(shadowRoots) || shadowRoots.length) return null;
          const frame: FrameRefRecord = { frameId: parentId, debuggee: parent, generation, revision: frameRevision,
            conversationId: frameContext.conversationId, runId: frameContext.runId };
          const group = `surf-wax-frame-paint:${crypto.randomUUID()}`;
          try {
            await this.frameDocument(session, frame, frameGuard);
            const key = JSON.stringify([session.tabId, parentId, parent.sessionId ?? null]);
            const document = this.frameDocuments.get(key), contextId = document?.executionContextId;
            if (!Number.isSafeInteger(contextId)) return null;
            const check = () => {
              frameGuard();
              if (this.frameDocuments.get(key) !== document) throw automationError("stale-frame", { reason: "frame-paint-context-expired" });
            };
            const owner = await this.options.command(parent, "DOM.getFrameOwner", { frameId: current });
            check();
            if (!Number.isSafeInteger(owner?.backendNodeId) || owner.backendNodeId <= 0) return null;
            const node = await this.options.command(parent, "DOM.resolveNode", { backendNodeId: owner.backendNodeId, executionContextId: contextId, objectGroup: group });
            check();
            if (typeof node.object?.objectId !== "string") return null;
            const response = await this.options.command(parent, "Runtime.callFunctionOn", { objectId: node.object.objectId,
              arguments: [{ value: true }], functionDeclaration: SNAPSHOT_FRAME_PAINT_SOURCE, returnByValue: true });
            check();
            if (response.exceptionDetails) { proofFailed("frame-paint-evaluate", current, parent, response.exceptionDetails); return null; }
            if (!response.result?.value) return null;
            proof.push({ frameId: current, parentId, backendNodeId: owner.backendNodeId, value: response.result.value });
          } catch (error) {
            frameGuard();
            proofFailed("frame-paint", current, parent, error);
            return null;
          } finally { void this.options.command(parent, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => undefined); }
          current = parentId;
        }
        return proof;
      };
      const framePaint = (frameId: string) => {
        let promise = framePaintCache.get(frameId);
        if (!promise) { promise = readFramePaint(frameId); framePaintCache.set(frameId, promise); }
        return promise;
      };
      type NativeValueRequest = { backendNodeId: number; expected: string; tag: "input" | "textarea" };
      type SelectRequest = { backendNodeId: number; optionId: number; expected: string };
      type SelectHost = { backendNodeId: number };
      type NativeValueBatch = { frameId: string; debuggee: Debuggee; requests: NativeValueRequest[]; selects: SelectRequest[]; hosts: SelectHost[]; frameSafe: boolean; shadowSafe: boolean; result: NativeValueResult };
      type NativeValueProof = { text: string; segments?: Array<{ kind: "text" | "break"; value: string }> };
      type SelectState = { multiple: boolean; size: number; open: boolean };
      type NativeValueResult = { identities: Array<number[] | null>; selectIdentities: Array<number[] | null>; scene: unknown; values: Array<NativeValueProof | null>; selectValues: Array<NativeValueProof | null>; selectStates: Array<SelectState | null> };
      const nativeValueBatches: NativeValueBatch[] = [];
      const readNativeValues = async (debuggee: Debuggee, frameId: string, requests: NativeValueRequest[], selects: SelectRequest[], hosts: SelectHost[], frameSafe: boolean, shadowSafe: boolean): Promise<NativeValueResult> => {
        const empty = (): NativeValueResult => ({ identities: requests.map(() => null), selectIdentities: selects.map(() => null), scene: null, values: requests.map(() => null), selectValues: selects.map(() => null), selectStates: hosts.map(() => null) });
        if (!requests.length && !hosts.length) return empty();
        const frame: FrameRefRecord = { frameId, debuggee, generation, revision: frameRevision,
          conversationId: frameContext.conversationId, runId: frameContext.runId };
        const group = `surf-wax-native-value:${crypto.randomUUID()}`;
        try {
          const documentId = await this.frameDocument(session, frame, frameGuard);
          const key = JSON.stringify([session.tabId, frameId, debuggee.sessionId ?? null]);
          const document = this.frameDocuments.get(key), contextId = document?.executionContextId;
          if (!Number.isSafeInteger(contextId)) return empty();
          const check = () => {
            frameGuard();
            if (this.frameDocuments.get(key) !== document) throw automationError("stale-frame", { reason: "native-value-context-expired" });
          };
          const resolved: Array<{ identities: number[]; objectId: string } | null> = [];
          for (let offset = 0; offset < requests.length; offset += 32) {
            const batch = requests.slice(offset, offset + 32);
            const values = await Promise.all(batch.map(async (request) => {
              try {
                const result = await this.options.command(debuggee, "DOM.describeNode", { backendNodeId: request.backendNodeId, depth: -1, pierce: true });
                check();
                if (result.node?.backendNodeId !== request.backendNodeId || result.node?.nodeName !== request.tag.toUpperCase()) return null;
                const roots = (result.node.shadowRoots ?? []).filter((root: any) => root.shadowRootType === "user-agent");
                if (roots.length !== 1) return null;
                let identities: number[], textId: number;
                if (request.tag === "textarea") {
                  const root = roots[0], children = root.children;
                  if (!Number.isSafeInteger(root.backendNodeId) || !Array.isArray(children) || children.length !== 1) return null;
                  const inner = children[0], parts = inner?.children;
                  if (inner?.nodeName !== "DIV" || !Number.isSafeInteger(inner.backendNodeId) || !Array.isArray(parts) || !parts.length
                    || parts.some((part: any) => !Number.isSafeInteger(part.backendNodeId) || part.shadowRoots?.length
                      || !(part.nodeType === 3 && typeof part.nodeValue === "string" || part.nodeType === 1 && part.nodeName === "BR" && !part.children?.length))) return null;
                  const last = parts.at(-1);
                  const sentinel = request.expected.endsWith("\n") && last?.nodeName === "BR"
                    && Array.isArray(last.attributes) && last.attributes.length === 2
                    && last.attributes[0] === "id" && last.attributes[1] === "textarea-placeholder-break";
                  const content = sentinel ? parts.slice(0, -1) : parts;
                  if (content.map((part: any) => part.nodeType === 3 ? part.nodeValue : "\n").join("") !== request.expected) return null;
                  const text = parts.find((part: any) => part.nodeType === 3 && part.nodeValue);
                  if (!text) return null;
                  textId = text.backendNodeId;
                  identities = [root.backendNodeId, inner.backendNodeId, ...parts.map((part: any) => part.backendNodeId)];
                } else {
                  const pending = [...(roots[0].children ?? [])], matches: number[] = [];
                  while (pending.length) {
                    const child = pending.pop();
                    if (child?.nodeType === 3 && child.nodeValue === request.expected && Number.isSafeInteger(child.backendNodeId)) matches.push(child.backendNodeId);
                    if (child?.shadowRoots?.length) return null;
                    pending.push(...(child?.children ?? []));
                  }
                  if (matches.length !== 1) return null;
                  textId = matches[0]!; identities = [textId];
                }
                const text = await this.options.command(debuggee, "DOM.resolveNode", { backendNodeId: textId, executionContextId: contextId, objectGroup: group });
                check();
                return typeof text.object?.objectId === "string" ? { identities, objectId: text.object.objectId } : null;
              } catch (error) { check(); proofFailed("native-value-resolve", frameId, debuggee, error); return null; }
            }));
            resolved.push(...values);
          }
          const active = requests.flatMap((request, index) => resolved[index] ? [{ request, text: resolved[index]!, index }] : []);
          const resolveInBatches = async <T, R>(items: T[], resolve: (item: T) => Promise<R>): Promise<R[]> => {
            const results: R[] = [];
            for (let offset = 0; offset < items.length; offset += 32)
              results.push(...await Promise.all(items.slice(offset, offset + 32).map(resolve)));
            return results;
          };
          const resolvedSelects = await resolveInBatches(selects, async (request) => {
            try {
              const host = (await this.options.command(debuggee, "DOM.describeNode", { backendNodeId: request.backendNodeId, depth: 0, pierce: true })).node;
              check();
              if (host?.backendNodeId !== request.backendNodeId || host.nodeName !== "SELECT") return null;
              const roots = (host.shadowRoots ?? []).filter((root: any) => root.shadowRootType === "user-agent");
              if (roots.length !== 1 || !Number.isSafeInteger(roots[0].backendNodeId)) return null;
              const root = (await this.options.command(debuggee, "DOM.describeNode", { backendNodeId: roots[0].backendNodeId, depth: 1, pierce: true })).node;
              check();
              const inners = (root?.children ?? []).filter((child: any) => child.nodeName === "DIV" && Array.isArray(child.attributes)
                && child.attributes.some((value: string, index: number) => index % 2 === 0 && value === "pseudo" && child.attributes[index + 1] === "-internal-select-inner-element"));
              if (inners.length !== 1 || !Number.isSafeInteger(inners[0].backendNodeId)) return null;
              const inner = (await this.options.command(debuggee, "DOM.describeNode", { backendNodeId: inners[0].backendNodeId, depth: 1, pierce: true })).node;
              check();
              const parts = inner?.children;
              if (!Array.isArray(parts) || parts.length !== 1 || parts[0].nodeType !== 3 || !Number.isSafeInteger(parts[0].backendNodeId)) return null;
              const [text, option] = await Promise.all([parts[0].backendNodeId, request.optionId].map((backendNodeId) =>
                this.options.command(debuggee, "DOM.resolveNode", { backendNodeId, executionContextId: contextId, objectGroup: group })));
              check();
              if (typeof text.object?.objectId !== "string" || typeof option.object?.objectId !== "string") return null;
              return { identities: [request.backendNodeId, roots[0].backendNodeId, inners[0].backendNodeId, parts[0].backendNodeId, request.optionId], text: text.object.objectId, option: option.object.objectId };
            } catch (error) { check(); proofFailed("select-value-resolve", frameId, debuggee, error); return null; }
          });
          const resolvedHosts = await resolveInBatches(hosts, async (host) => {
            try {
              const result = await this.options.command(debuggee, "DOM.resolveNode", { backendNodeId: host.backendNodeId, executionContextId: contextId, objectGroup: group });
              check();
              return typeof result.object?.objectId === "string" ? result.object.objectId as string : null;
            } catch (error) { check(); proofFailed("select-host-resolve", frameId, debuggee, error); return null; }
          });
          const activeSelects = selects.flatMap((request, index) => resolvedSelects[index] ? [{ request, resolved: resolvedSelects[index]!, index }] : []);
          const activeHosts = hosts.flatMap((host, index) => resolvedHosts[index] ? [{ host, objectId: resolvedHosts[index]!, index }] : []);
          if (!active.length && !activeSelects.length && !activeHosts.length) return empty();
          const response = await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId: documentId,
            functionDeclaration: SNAPSHOT_CONTROL_PAINT_SOURCE, returnByValue: true,
            arguments: [{ value: { native: active.map(({ request }) => ({ expected: request.expected })), selects: activeSelects.map(({ request }) => ({ expected: request.expected })), selectHosts: activeHosts.map(() => ({})) } }, { value: frameSafe }, { value: shadowSafe },
              ...active.map(({ text }) => ({ objectId: text.objectId })), ...activeSelects.flatMap(({ resolved }) => [{ objectId: resolved.text }, { objectId: resolved.option }]), ...activeHosts.map(({ objectId }) => ({ objectId }))] });
          check();
          const data = response.result?.value;
          if (response.exceptionDetails) proofFailed("control-paint-evaluate", frameId, debuggee, response.exceptionDetails);
          if (response.exceptionDetails || !data || !Array.isArray(data.nativeValues) || data.nativeValues.length !== active.length
            || !Array.isArray(data.selectValues) || data.selectValues.length !== activeSelects.length
            || !Array.isArray(data.selectStates) || data.selectStates.length !== activeHosts.length) return empty();
          const result = empty(); result.scene = data.scene;
          active.forEach(({ text, request, index }, position) => {
            const proof = data.nativeValues[position];
            result.identities[index] = text.identities;
            if (proof && proof.text === request.expected) result.values[index] = proof;
          });
          activeSelects.forEach(({ resolved, request, index }, position) => {
            result.selectIdentities[index] = resolved.identities;
            const proof = data.selectValues[position];
            if (proof && proof.text === request.expected) result.selectValues[index] = proof;
          });
          activeHosts.forEach(({ index }, position) => { result.selectStates[index] = data.selectStates[position]; });
          return result;
        } catch (error) { frameGuard(); proofFailed("control-paint", frameId, debuggee, error); return empty(); }
        finally { void this.options.command(debuggee, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => undefined); }
      };
      const lines: SnapshotLine[] = [];
      const render = async (nodes: any[], visibility: Map<number, boolean>, textProjections: Map<number, TextProjection>, unknownText: Set<number>,
        paintEvidence: ReadonlyMap<number, TextPaintEvidence>, candidates: readonly SnapshotTextPaintCandidate[], snapshot: any, debuggee: Debuggee, frameLabel?: string, frameDepth = 0,
        dynamicText: ReadonlySet<number> = new Set()) => {
        const byId = new Map(nodes.map((node) => [node.nodeId, node]));
        const frameId = frameLabel ?? session.rootFrameId;
        if (!frameId) throw automationError("snapshot-unavailable", { reason: "missing-root-frame" });
        const scopedRoot = Boolean(regionNode && regionFrameId === frameId && regionDebuggee && sameDebuggee(regionDebuggee, debuggee));
        const doc = snapshot.documents?.find((document: any) => snapshot.strings?.[document.frameId] === frameId);
        if (!doc) throw automationError("snapshot-unavailable", { reason: "missing-dom-frame", frameId });
        const bounds = snapshotBounds(doc);
        const byBackend = new Map<number, any[]>();
        for (const node of nodes) if (axValue(node.role) === "StaticText" && Number.isSafeInteger(node.backendDOMNodeId)) {
          const group = byBackend.get(node.backendDOMNodeId) ?? []; group.push(node); byBackend.set(node.backendDOMNodeId, group);
        }
        const noShadowRoots = Array.isArray(doc.nodes?.shadowRootType?.index) && doc.nodes.shadowRootType.index.length === 0;
        const rootFrame = frameId === session.rootFrameId && sameDebuggee(debuggee, session.debuggee);
        let frameUnobscured = rootFrame;
        const pendingEllipsis: Array<{ candidate: SnapshotTextPaintCandidate; match: AxEllipsisCandidate; request: EllipsisRequest }> = [];
        for (const candidate of candidates) {
          if (candidate.frameId !== frameId || !candidate.ellipsis || !candidate.basePainted || !unknownText.has(candidate.backendNodeId) || dynamicText.has(candidate.backendNodeId)
            || candidate.firstLetter || candidate.firstLetterUnknown || typeof candidate.sourceText !== "string" || typeof candidate.layoutText !== "string") continue;
          const paint = paintEvidence.get(candidate.backendNodeId), matches = byBackend.get(candidate.backendNodeId);
          if (!paint || paint.unknown || paint.firstLineRisk || paint.firstLetterRisk || paint.sourceText !== candidate.sourceText || matches?.length !== 1) continue;
          const match = axEllipsisCandidate({ node: matches[0], nodesById: byId, frameId: candidate.frameId, expectedFrameId: frameId,
            backendNodeId: candidate.backendNodeId, sourceText: candidate.sourceText, layoutText: candidate.layoutText,
            textBoxes: candidate.textBoxes ?? [], direction: candidate.direction ?? "", writingMode: candidate.writingMode ?? "",
            textTransform: candidate.textTransform ?? "", textSecurity: candidate.textSecurity ?? "" });
          if (match) pendingEllipsis.push({ candidate, match, request: { backendNodeId: candidate.backendNodeId, prefix: match.prefix,
            sourceText: candidate.sourceText, frameUnobscured, noShadowRoots, basePainted: true } });
        }
        let frameProof: FramePaintProof[] | null = null;
        if (pendingEllipsis.length && noShadowRoots && !rootFrame && frameId !== session.rootFrameId) {
          frameProof = await waitForCapture(framePaint(frameId));
          frameUnobscured = Boolean(frameProof);
          for (const item of pendingEllipsis) item.request.frameUnobscured = frameUnobscured;
        }
        if (pendingEllipsis.length && frameUnobscured && noShadowRoots) {
          const proofs = await waitForCapture(readEllipsisGeometry(debuggee, frameId, pendingEllipsis.map(({ request }) => request)));
          const accepted: EllipsisBatch = { debuggee, frameId, requests: [], proofs: [] };
          pendingEllipsis.forEach(({ candidate, match, request }, index) => {
            const proof = proofs[index];
            const text = proof && confirmAxEllipsis(match, proof);
            if (!proof || typeof text !== "string") return;
            textProjections.set(candidate.backendNodeId, { full: candidate.layoutText!, text });
            unknownText.delete(candidate.backendNodeId);
            accepted.requests.push(request); accepted.proofs.push(proof);
          });
          if (accepted.requests.length) {
            ellipsisBatches.push(accepted);
            if (frameProof) framePaintBatches.push(frameProof);
          }
        }
        let evidence: ReturnType<typeof snapshotDomSupplement>;
        try {
          evidence = snapshotDomSupplement(snapshot, { frameId, visibility, textProjections, covered: new Set() });
        }
        catch (error) { throw automationError("snapshot-unavailable", { reason: "invalid-dom-snapshot", detail: error instanceof Error ? error.message : String(error) }); }
        const nativeRequests: NativeValueRequest[] = evidence.items.flatMap((item) => {
          const type = (item.attributes?.type ?? "text").toLowerCase();
          return item.kind === "control" && item.valueVisible && item.value && (item.tag === "textarea"
            || item.tag === "input" && ["text", "search", "email", "tel", "url"].includes(type))
            ? [{ backendNodeId: item.backendNodeId, expected: item.value, tag: item.tag as "input" | "textarea" }] : [];
        });
        const selectHosts: SelectHost[] = evidence.items.flatMap((item) => item.kind === "control" && item.tag === "select" ? [{ backendNodeId: item.backendNodeId }] : []);
        const selectRequests: SelectRequest[] = evidence.items.flatMap((item) => item.kind === "control" && item.tag === "select"
          && item.selectedOptions?.length === 1 && item.selectedOptionIds?.length === 1 && item.selectedOptions[0]!.label.trim()
          ? [{ backendNodeId: item.backendNodeId, optionId: item.selectedOptionIds[0]!, expected: item.selectedOptions[0]!.label.trim() }] : []);
        const nativeValues = new Map<number, string>();
        const nativeProofs = new Map<number, NativeValueProof>();
        const nativeIdentities = new Map<number, number[]>();
        const selectValues = new Map<number, string>();
        const selectStates = new Map<number, SelectState>();
        if (nativeRequests.length || selectHosts.length) {
          const parentProof = rootFrame ? [] : noShadowRoots && frameId !== session.rootFrameId ? await waitForCapture(framePaint(frameId)) : null;
          const frameSafe = Boolean(parentProof);
          if (frameSafe && noShadowRoots || scopedRoot || selectHosts.length) {
            const result = await waitForCapture(readNativeValues(debuggee, frameId, nativeRequests, selectRequests, selectHosts, frameSafe, noShadowRoots));
            result.values.forEach((value, index) => { if (value) { nativeValues.set(nativeRequests[index]!.backendNodeId, value.text); nativeProofs.set(nativeRequests[index]!.backendNodeId, value); } });
            result.identities.forEach((id, index) => { if (id !== null) nativeIdentities.set(nativeRequests[index]!.backendNodeId, id); });
            result.selectValues.forEach((value, index) => { if (value) selectValues.set(selectRequests[index]!.backendNodeId, value.text); });
            result.selectStates.forEach((value, index) => { if (value) selectStates.set(selectHosts[index]!.backendNodeId, value); });
            if (nativeIdentities.size || selectHosts.length) {
              nativeValueBatches.push({ frameId, debuggee, requests: nativeRequests, selects: selectRequests, hosts: selectHosts, frameSafe, shadowSafe: noShadowRoots, result });
              if ((nativeValues.size || selectValues.size) && parentProof?.length) framePaintBatches.push(parentProof);
            }
          }
        }
        const domIndex = evidence.indexes.get(frameId);
        if (!domIndex) throw automationError("snapshot-unavailable", { reason: "missing-dom-frame", frameId });
        const { positions, subtreeRange: visibleRange } = snapshotRenderOrder(domIndex, doc.nodes.nodeName, snapshot.strings);
        const placeholders = new Map<number, PlaceholderProof>();
        const placeholderTextNodes = new Set<number>();
        const placeholderTextEvidence = new Map<number, PlaceholderEvidence>();
        for (const item of placeholderItems) if (item.frameId === frameId && sameDebuggee(item.debuggee, debuggee)) {
          const proof = placeholderBefore.get(placeholderKey(item));
          if (!proof) throw automationError("snapshot-unavailable", { reason: "missing-placeholder-evidence" });
          placeholders.set(item.backendNodeId, proof);
          if (proof.textBackendNodeId !== undefined) { placeholderTextNodes.add(proof.textBackendNodeId); placeholderTextEvidence.set(proof.textBackendNodeId, proof.evidence); }
        }
        // Keep one document-order text index for all semantic nodes. The AX
        // name is an identity, not proof that the text was painted.
        const frameEvidence = evidence.items.map((item) => item.kind === "text" && (unknownText.has(item.backendNodeId) || placeholderTextEvidence.has(item.backendNodeId) && placeholderTextEvidence.get(item.backendNodeId)?.status !== "visible") ? { ...item, text: "" } : item);
        const evidenceIds = new Set(frameEvidence.map((item) => item.backendNodeId));
        for (const backendNodeId of unknownText) {
          const nodeIndex = domIndex.indexOf(backendNodeId);
          if (nodeIndex === undefined || evidenceIds.has(backendNodeId) || visibility.get(backendNodeId) !== true) continue;
          const parent = domIndex.parentAt(nodeIndex), parentBackendNodeId = parent === undefined ? undefined : domIndex.backendAt(parent);
          frameEvidence.push({ frameId, backendNodeId, nodeIndex, kind: "text", ...(parentBackendNodeId === undefined ? {} : { parentBackendNodeId }) });
        }
        frameEvidence.sort((a, b) => positions.get(a.backendNodeId)! - positions.get(b.backendNodeId)!);
        const evidenceText = frameEvidence.filter((item) => item.kind === "text");
        const evidenceTextById = new Map(evidenceText.map((item) => [item.backendNodeId, item.text ?? ""]));
        const evidenceTextItemsById = new Map(evidenceText.map((item) => [item.backendNodeId, item]));
        const textOffsets: number[] = [], textPositions: number[] = [];
        let textJoined = "";
        for (const item of evidenceText) {
          textPositions.push(positions.get(item.backendNodeId)!); textOffsets.push(textJoined.length); textJoined += item.text ?? "";
        }
        textOffsets.push(textJoined.length);
        const lowerText = (position: number) => { let low = 0, high = textPositions.length; while (low < high) { const middle = (low + high) >>> 1; if (textPositions[middle]! < position) low = middle + 1; else high = middle; } return low; };
        const unknownPositions = [...unknownText].flatMap((id) => positions.has(id) ? [positions.get(id)!] : []).sort((a, b) => a - b);
        const hasUnknownSubtree = (backend: number): boolean => {
          const index = domIndex.indexOf(backend), range = index === undefined ? undefined : visibleRange(index);
          if (!range) return false;
          let low = 0, high = unknownPositions.length;
          while (low < high) { const middle = (low + high) >>> 1; if (unknownPositions[middle]! < range.start) low = middle + 1; else high = middle; }
          return low < unknownPositions.length && unknownPositions[low]! < range.end;
        };
        const visibleSubtree = (backend: number): string => {
          const index = domIndex.indexOf(backend), range = index === undefined ? undefined : visibleRange(index);
          if (!range) return "";
          return normalizeSnapshotText(textJoined.slice(textOffsets[lowerText(range.start)]!, textOffsets[lowerText(range.end)]!));
        };
        const tainted = new Uint8Array(doc.nodes.backendNodeId.length);
        for (const [id, proof] of placeholders) if (proof.evidence.status !== "visible") {
          const index = domIndex.indexOf(id);
          if (index !== undefined) tainted[index] = 1;
        }
        for (let index = domIndex.preorder.length - 1; index >= 0; index--) {
          const child = domIndex.preorder[index]!, parent = domIndex.parentAt(child);
          if (tainted[child] && parent !== undefined) tainted[parent] = 1;
        }
        const hasTaintedPlaceholder = tainted.some(Boolean);
        const activeSource = (node: any) => node.name?.sources?.find((source: any) => !source.superseded && source.value?.value !== undefined);
        const placeholder = (node: any) => typeof node.backendDOMNodeId === "number" ? placeholders.get(node.backendDOMNodeId)?.evidence : undefined;
        const namedByBackend = new Map<number, string[]>();
        if (hasTaintedPlaceholder) for (const node of nodes) if (typeof node.backendDOMNodeId === "number") {
          const entries = namedByBackend.get(node.backendDOMNodeId) ?? []; entries.push(node.nodeId); namedByBackend.set(node.backendDOMNodeId, entries);
        }
        const dependents = new Map<string, string[]>(), taintedNames = new Set<string>(), uncertainNames = new Set<string>();
        const addDependency = (source: string, dependent: string) => {
          const entries = dependents.get(source) ?? []; entries.push(dependent); dependents.set(source, entries);
        };
        if (hasTaintedPlaceholder) for (const node of nodes) {
          const source = activeSource(node), own = placeholder(node);
          if (own && own.status !== "visible" && source?.type === "placeholder") taintedNames.add(node.nodeId);
          if (source?.type === "contents") for (const child of node.childIds ?? []) addDependency(child, node.nodeId);
          if (!hasTaintedPlaceholder || !source) continue;
          const related = [source.relatedNodes, source.attributeValue?.relatedNodes, source.value?.relatedNodes].filter(Array.isArray).flat();
          if (source.type === "relatedElement" && !related.length && axValue(node.name)
            && !(axValue(node.role) === "RootWebArea" && source.nativeSource === "title")) uncertainNames.add(node.nodeId);
          for (const dependency of related) {
            const backend = dependency?.backendDOMNodeId, index = domIndex.indexOf(backend);
            if (index === undefined) uncertainNames.add(node.nodeId);
            else if (tainted[index]) taintedNames.add(node.nodeId);
            for (const target of namedByBackend.get(backend) ?? []) addDependency(target, node.nodeId);
          }
        }
        const queue = [...taintedNames, ...uncertainNames], visited = new Set(queue);
        for (let cursor = 0; cursor < queue.length; cursor++) for (const dependent of dependents.get(queue[cursor]!) ?? []) {
          taintedNames.add(dependent);
          if (!visited.has(dependent)) { visited.add(dependent); queue.push(dependent); }
        }
        const namesUnknown = new Set<string>(), unknownPlaceholderText = new Set<string>();
        const safeName = (node: any, name: string) => {
          const source = activeSource(node), own = placeholder(node);
          if (unknownPlaceholderText.has(node.nodeId)) { namesUnknown.add(node.nodeId); return ""; }
          if (name && !source && (own || hasTaintedPlaceholder && !["StaticText", "RootWebArea", "InlineTextBox"].includes(axValue(node.role)))) {
            namesUnknown.add(node.nodeId); return "";
          }
          if (source?.type === "placeholder") {
            if (!own) throw automationError("snapshot-unavailable", { reason: "missing-placeholder-evidence" });
            return own.status === "visible" ? own.text : "";
          }
          if (name && (taintedNames.has(node.nodeId) || uncertainNames.has(node.nodeId)) && source?.type !== "contents") {
            namesUnknown.add(node.nodeId); return "";
          }
          return name;
        };
        const securityByBackend = new Map<number, string>();
        for (let row = 0; row < (doc.layout?.nodeIndex?.length ?? 0); row++) {
          const index = doc.layout.nodeIndex[row], backend = doc.nodes?.backendNodeId?.[index];
          const security = snapshot.strings?.[doc.layout.styles?.[row]?.[26]];
          if (typeof backend === "number" && typeof security === "string") securityByBackend.set(backend, security);
        }
        // AX may return a raw textbox value even when CSS paints only masking
        // glyphs. Unknown security is not proof that raw characters are visible.
        const maskedControl = (node: any) => ["textbox", "searchbox", "combobox", "spinbutton"].includes(axValue(node.role))
          && securityByBackend.get(node.backendDOMNodeId) !== "none";
        const plainEditable = (entry: any) => (entry.actions === undefined || Array.isArray(entry.actions) && entry.actions.length === 0)
          && (entry.properties === undefined || Array.isArray(entry.properties) && entry.properties.length <= 1
            && entry.properties.every((property: any) => property.name === "editable" && property.value?.value === "plaintext"));
        // Chrome normally represents a native control's value as a single
        // UA-shadow generic → StaticText path absent from DOMSnapshot. Only
        // this exact, semantically plain path is equivalent to the value row.
        const nativeValueOwner = (leaf: any): any | undefined => {
          if (!leaf || leaf.ignored || axValue(leaf.role) !== "StaticText" || !axValue(leaf.name)
            || !Array.isArray(leaf.childIds) || !leaf.childIds.every((id: string) => axValue(byId.get(id)?.role) === "InlineTextBox")
            || typeof leaf.backendDOMNodeId !== "number" || domIndex.indexOf(leaf.backendDOMNodeId) !== undefined || !plainEditable(leaf)) return undefined;
          const wrapper = byId.get(leaf.parentId), owner = wrapper && byId.get(wrapper.parentId);
          if (!wrapper || wrapper.ignored || axValue(wrapper.role) !== "generic" || axValue(wrapper.name) || axValue(wrapper.value)
            || typeof wrapper.backendDOMNodeId !== "number" || domIndex.indexOf(wrapper.backendDOMNodeId) !== undefined
            || !Array.isArray(wrapper.childIds) || wrapper.childIds.length !== 1 || wrapper.childIds[0] !== leaf.nodeId || !plainEditable(wrapper)
            || !owner || owner.ignored || !["textbox", "searchbox"].includes(axValue(owner.role)) || maskedControl(owner)
            || !Array.isArray(owner.childIds) || owner.childIds.length !== 1 || owner.childIds[0] !== wrapper.nodeId
            || axValue(owner.value) !== axValue(leaf.name)) return undefined;
          const index = typeof owner.backendDOMNodeId === "number" ? domIndex.indexOf(owner.backendDOMNodeId) : undefined;
          const tag = index === undefined ? "" : snapshot.strings?.[doc.nodes.nodeName?.[index]]?.toUpperCase();
          return tag === "INPUT" || tag === "TEXTAREA" ? owner : undefined;
        };
        // A multiline textarea has several UA text/BR children. Only use
        // that ancestry when the complete ordered backend sequence matches
        // the independently resolved user-agent shadow tree.
        const nativeTextareaOwner = (leaf: any): any | undefined => {
          if (!leaf || leaf.ignored || !["StaticText", "LineBreak"].includes(axValue(leaf.role))
            || typeof leaf.backendDOMNodeId !== "number") return undefined;
          const wrapper = byId.get(leaf.parentId), owner = wrapper && byId.get(wrapper.parentId);
          if (!wrapper || wrapper.ignored || axValue(wrapper.role) !== "generic" || !owner || owner.ignored
            || axValue(owner.role) !== "textbox" || maskedControl(owner) || !Array.isArray(owner.childIds)
            || owner.childIds.length !== 1 || owner.childIds[0] !== wrapper.nodeId || !Array.isArray(wrapper.childIds)) return undefined;
          const index = typeof owner.backendDOMNodeId === "number" ? domIndex.indexOf(owner.backendDOMNodeId) : undefined;
          if (index === undefined || snapshot.strings?.[doc.nodes.nodeName?.[index]]?.toUpperCase() !== "TEXTAREA") return undefined;
          const ids = nativeIdentities.get(owner.backendDOMNodeId);
          if (!ids || ids.length !== wrapper.childIds.length + 2 || ids[1] !== wrapper.backendDOMNodeId
            || !wrapper.childIds.includes(leaf.nodeId)
            || wrapper.childIds.some((id: string, position: number) => byId.get(id)?.backendDOMNodeId !== ids[position + 2])) return undefined;
          return owner;
        };
        const scope = frameLabel ?? session.rootFrameId ?? "root";
        // Frame ID alone is insufficient: an OOPIF can be replaced by a new
        // debugger target without changing the frame ID or document generation.
        const scopeKey = JSON.stringify([scope, debuggee.sessionId ?? null]);
        let snapshotScope = session.snapshotScopes.get(scopeKey);
        if (!snapshotScope) {
          snapshotScope = (session.nextSnapshotScope++).toString(36);
          session.snapshotScopes.set(scopeKey, snapshotScope);
        }
        if (frameLabel) {
          const node: SnapshotNode = { id: `${snapshotScope}.m`, depth: frameDepth, role: "frame-document", documentFrameRef: capturedFrameRefs.get(frameLabel) };
          lines.push({ ...renderSnapshotNode(node), node });
        }
        // The region may be omitted entirely by AX (for example aria-hidden).
        // Its DOM frame/identity is independently resolved and validated below.
        const root = scopedRoot ? nodes.find((node) => node.backendDOMNodeId === regionNode!.node.backendNodeId) : nodes.find((node) => !node.parentId) ?? nodes[0];
        const scopeIndex = scopedRoot ? domIndex : undefined;
        const otherFrameBackends = scopedRoot ? new Set<number>() : undefined;
        if (otherFrameBackends) for (const document of snapshot.documents ?? []) if (document !== doc)
          for (const id of document.nodes?.backendNodeId ?? []) if (typeof id === "number") otherFrameBackends.add(id);
        // Internal AX descendants (notably input value text) may have no DOM
        // snapshot entry. Inherit their nearest known ancestor's state, while
        // still allowing a known visible descendant to override it.
        const effectiveHidden = new Map<string, boolean>();
        const scoped = new Map<string, boolean>();
        const treeRoot = nodes.find((node) => !node.parentId) ?? nodes[0];
        const order: any[] = [], scan: Array<{ node: any; inherited: boolean; within: boolean; closedPopup?: boolean; placeholderOwner?: any }> = treeRoot ? [{ node: treeRoot, inherited: false, within: false }] : [];
        while (scan.length) {
          const { node, inherited, within, closedPopup, placeholderOwner } = scan.pop()!;
          const known = typeof node.backendDOMNodeId === "number" ? visibility.get(node.backendDOMNodeId) : undefined;
          const nativeOwner = nativeValueOwner(node) ?? nativeTextareaOwner(node) ?? (axValue(node.role) === "generic" && node.childIds?.length === 1
            ? nativeValueOwner(byId.get(node.childIds[0])) : undefined);
          if (scopeIndex && typeof node.backendDOMNodeId === "number" && !placeholderTextNodes.has(node.backendDOMNodeId) && scopeIndex.indexOf(node.backendDOMNodeId) === undefined
            && !otherFrameBackends?.has(node.backendDOMNodeId) && !nativeOwner && known !== false && !node.ignored
            && !["", "none", "generic", "InlineTextBox"].includes(axValue(node.role)))
            throw automationError("snapshot-unavailable", { reason: "unknown-region-membership" });
          const parentNode = byId.get(node.parentId);
          const parentIndex = typeof parentNode?.backendDOMNodeId === "number" ? domIndex.indexOf(parentNode.backendDOMNodeId) : undefined;
          const parentIsSelect = parentIndex !== undefined && snapshot.strings?.[doc.nodes.nodeName?.[parentIndex]]?.toUpperCase() === "SELECT";
          const parentSelectState = parentNode && selectStates.get(parentNode.backendDOMNodeId);
          if ((known === undefined ? !inherited : known) && (!scopeIndex || within)
            && axValue(node.role) === "MenuListPopup" && parentIsSelect && (!parentSelectState || parentSelectState.open))
            throw automationError("snapshot-unavailable", { reason: "select-popup-unproven" });
          const closedSelectPopup = Boolean(closedPopup || axValue(node.role) === "MenuListPopup" && parentIsSelect
            && parentSelectState && !parentSelectState.multiple && parentSelectState.size <= 1);
          const isHidden = closedSelectPopup || (known === undefined ? inherited : !known);
          const isScoped = !scopeIndex || (typeof node.backendDOMNodeId === "number"
            ? scopeIndex.contains(regionNode!.node.backendNodeId, node.backendDOMNodeId) === true
              || Boolean(nativeOwner && scopeIndex.contains(regionNode!.node.backendNodeId, nativeOwner.backendDOMNodeId) === true)
            : within);
          const owner = placeholder(node) ? node : placeholderOwner;
          if (owner && owner !== node && axValue(node.role) === "StaticText" && placeholder(owner)?.status !== "visible"
            && (typeof node.backendDOMNodeId !== "number" || known !== true)) {
            // A single direct leaf equal to an unmasked control value is
            // already represented by the control row; preserve that value.
            const representedValue = node.parentId === owner.nodeId && owner.childIds?.length === 1
              && !maskedControl(owner) && Boolean(axValue(owner.value)) && axValue(node.name) === axValue(owner.value);
            if (!representedValue) unknownPlaceholderText.add(node.nodeId);
          }
          effectiveHidden.set(node.nodeId, isHidden);
          scoped.set(node.nodeId, isScoped);
          order.push(node);
          for (const id of node.childIds ?? []) { const child = byId.get(id); if (child) scan.push({ node: child, inherited: isHidden, within: isScoped, closedPopup: closedSelectPopup, placeholderOwner: owner }); }
        }
        const hidden = (node: any) => effectiveHidden.get(node.nodeId) === true;
        const inScope = (node: any) => scoped.get(node.nodeId) === true;
        const axEditableCandidates = [...new Set<number>(order.flatMap((node) => {
          if (node.ignored || hidden(node) || !inScope(node) || typeof node.backendDOMNodeId !== "number") return [];
          const properties = Object.fromEntries((node.properties ?? []).map((property: any) => [property.name, property.value?.value]));
          const index = domIndex.indexOf(node.backendDOMNodeId);
          const tag = index === undefined ? "" : snapshot.strings?.[doc.nodes.nodeName?.[index]]?.toLowerCase();
          if (index === undefined || doc.nodes.nodeType?.[index] !== 1 || properties.focusable !== true) return [];
          const attributes = doc.nodes.attributes?.[index] ?? [];
          const hasContentEditable = Array.isArray(attributes) && attributes.some((value: number, offset: number) => offset % 2 === 0
            && snapshot.strings?.[value]?.toLowerCase() === "contenteditable");
          if (!["richtext", "plaintext"].includes(properties.editable) && !hasContentEditable) return [];
          return index !== undefined && doc.nodes.nodeType?.[index] === 1 && tag && !["input", "textarea", "select", "button", "option"].includes(tag) ? [node.backendDOMNodeId] : [];
        }))];
        const axFillability = await waitForCapture(readFillability(debuggee, frameId, axEditableCandidates));
        if (axFillability.size) fillabilityBatches.push({ debuggee, frameId, values: axFillability });
        const namedTextRoles = new Set(["button", "link", "heading", "checkbox", "radio", "tab", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem"]);
        const pseudoTextOwner = (node: any): number | undefined => {
          if (axValue(node.role) !== "StaticText" || typeof node.backendDOMNodeId === "number") return undefined;
          const parent = byId.get(node.parentId), backend = parent?.backendDOMNodeId;
          const index = typeof backend === "number" ? domIndex.indexOf(backend) : undefined;
          const name = index === undefined ? "" : snapshot.strings?.[doc.nodes.nodeName?.[index]] ?? "";
          return /^::(?:before|after|marker|first-letter)$/i.test(name) ? backend : undefined;
        };
        const visibleName = (node: any, original: string): string => {
          const role = axValue(node.role), backend = node.backendDOMNodeId;
          const ownPlaceholder = placeholder(node);
          const source = activeSource(node);
          if (role === "RootWebArea") return "";
          // A control may derive its accessible name from an unrelated DOM
          // subtree. Check this before considering its own visible contents.
          if (partial && source?.type === "relatedElement") {
            const related = [source.relatedNodes, source.attributeValue?.relatedNodes, source.value?.relatedNodes, source.nativeSourceValue?.relatedNodes].filter(Array.isArray).flat();
            const ids = related.flatMap((entry: any) => Number.isSafeInteger(entry?.backendDOMNodeId) ? [entry.backendDOMNodeId] : []);
            if (!ids.length || ids.some((id: number) => domIndex.indexOf(id) === undefined || hasUnknownSubtree(id))) {
              namesUnknown.add(node.nodeId); return "";
            }
          }
          if (source?.type === "placeholder") return safeName(node, original);
          if (role === "StaticText") {
            const pseudo = pseudoTextOwner(node);
            if (pseudo !== undefined) {
              if (unknownText.has(pseudo)) { namesUnknown.add(node.nodeId); return ""; }
              const text = evidenceTextById.get(pseudo);
              if (text !== undefined) return text;
              if (original) namesUnknown.add(node.nodeId);
              return "";
            }
            if (typeof backend === "number" && unknownText.has(backend)) { namesUnknown.add(node.nodeId); return ""; }
            if (typeof backend === "number" && domIndex.indexOf(backend) !== undefined) {
              const observed = evidenceTextById.get(backend);
              const text = observed === undefined ? visibleSubtree(backend) : observed;
              if (!text && original && visibility.get(backend) !== false) namesUnknown.add(node.nodeId);
              return text;
            }
            // An input's internal value is handled on the control row.
            const nativeOwner = nativeValueOwner(node) ?? nativeTextareaOwner(node);
            if (nativeOwner && !maskedControl(nativeOwner)) {
              if (nativeValues.get(nativeOwner.backendDOMNodeId) === original) return safeName(node, original);
              namesUnknown.add(node.nodeId); return "";
            }
            if (original) namesUnknown.add(node.nodeId);
            return "";
          }
          if (ownPlaceholder?.status === "visible" && original === ownPlaceholder.text) return ownPlaceholder.text;
          if (namedTextRoles.has(role) && typeof backend === "number") {
            const text = visibleSubtree(backend);
            if (hasUnknownSubtree(backend)) namesUnknown.add(node.nodeId);
            if (text) return text;
          }
          if (source?.type === "relatedElement") {
            const related = [source.relatedNodes, source.attributeValue?.relatedNodes, source.value?.relatedNodes, source.nativeSourceValue?.relatedNodes].filter(Array.isArray).flat();
            const ids = [...new Set<number>(related.flatMap((entry: any) => Number.isSafeInteger(entry?.backendDOMNodeId) ? [entry.backendDOMNodeId] : []))]
              .filter((id) => !scopedRoot || ["label", "labelfor"].includes(source.nativeSource) || domIndex.contains(regionNode!.node.backendNodeId, id) === true);
            const visible = ids.map((id) => visibleSubtree(id)).filter(Boolean);
            if (ids.some((id) => hasUnknownSubtree(id))) namesUnknown.add(node.nodeId);
            if (visible.length) return visible.join(" ");
          }
          if (original) namesUnknown.add(node.nodeId);
          return "";
        };
        const provenTextareaChildren = new Set<string>();
        for (const owner of nodes) {
          const proof = nativeProofs.get(owner.backendDOMNodeId), wrapper = owner.childIds?.length === 1 ? byId.get(owner.childIds[0]) : undefined;
          if (!proof?.segments || proof.text !== axValue(owner.value) || !wrapper || !plainEditable(wrapper)
            || axValue(wrapper.name) || axValue(wrapper.value) || !Array.isArray(wrapper.childIds)
            || wrapper.childIds.length !== proof.segments.length) continue;
          const children = wrapper.childIds.map((id: string) => byId.get(id));
          if (children.some((child: any, index: number) => {
            const segment = proof.segments![index]!;
            return !child || nativeTextareaOwner(child) !== owner || !plainEditable(child) || axValue(child.value)
              || !Array.isArray(child.childIds) || child.childIds.some((id: string) => axValue(byId.get(id)?.role) !== "InlineTextBox")
              || axValue(child.role) !== (segment.kind === "text" ? "StaticText" : "LineBreak")
              || axValue(child.name) !== (segment.kind === "text" ? segment.value : "\n");
          })) continue;
          for (const child of children) provenTextareaChildren.add(child.nodeId);
        }
        const start = lines.length;
        const lineBackends = new Map<string, number>();
        const pseudoTextRows = new Map<number, number>();
        const axLines = new Map<string, string>();
        const covered = new Set<number>();
        const traversalRoot = scopedRoot ? treeRoot : root;
        const pending: Array<{ node: any; depth: number }> = traversalRoot ? [{ node: traversalRoot, depth: frameLabel ? frameDepth + 1 : 0 }] : [];
        while (pending.length) {
          const { node, depth } = pending.pop()!;
          let childDepth = depth;
          const role = node.ignored || hidden(node) || !inScope(node) || axValue(node.role) === "StaticText" && placeholderTextNodes.has(node.backendDOMNodeId) ? "" : axValue(node.role);
          const properties = Object.fromEntries((node.properties ?? []).map((property: any) => [property.name, property.value?.value]));
          // AX can mark native buttons editable through an ancestor even
          // though text insertion cannot target them. Require a known DOM
          // element whose tag supports the runtime's editing operations.
          const editableIndex = typeof node.backendDOMNodeId === "number" ? domIndex.indexOf(node.backendDOMNodeId) : undefined;
          const editableTag = editableIndex === undefined ? "" : snapshot.strings?.[doc.nodes.nodeName?.[editableIndex]]?.toLowerCase();
          const editableEvidence = typeof node.backendDOMNodeId === "number" ? axFillability.get(node.backendDOMNodeId) : undefined;
          const editableControl = editableEvidence?.fillable === true && editableEvidence.mode !== null;
          const originalName = axValue(node.name), name = role ? visibleName(node, originalName) : "";
          // The rich editing host's AX value aggregates descendant text that
          // is emitted in document order below; do not duplicate it here.
          const rawValue = axValue(node.value);
          const nativeValue = ["input", "textarea"].includes(editableTag ?? "") && !["checkbox", "radio", "switch"].includes(role);
          const nativeLeafOwner = nativeValueOwner(node) ?? nativeTextareaOwner(node);
          const valueUnknown = Boolean(rawValue) && (partial && typeof node.backendDOMNodeId === "number" && hasUnknownSubtree(node.backendDOMNodeId)
            || nativeValue && !maskedControl(node)
            && nativeValues.get(node.backendDOMNodeId) !== rawValue || editableTag === "select" && selectValues.get(node.backendDOMNodeId) !== rawValue || nativeLeafOwner && nativeValues.get(nativeLeafOwner.backendDOMNodeId) !== rawValue);
          const value = maskedControl(node) || ["checkbox", "radio", "switch"].includes(role)
            || editableControl && !["textbox", "searchbox", "spinbutton"].includes(role) || valueUnknown ? "" : rawValue;
          const parent = byId.get(node.parentId);
          const parentRole = parent && !parent.ignored && !hidden(parent) && inScope(parent) ? axValue(parent.role) : "";
          // Values already represented by their native editing host can omit
          // plain shadow duplicates. Named-label fragments keep their geometry
          // until the presentation projection folds that evidence into the row.
          const singleTextLeaf = node !== root && role === "StaticText" && parent && parent.childIds?.length === 1
            && (node.childIds ?? []).every((id: string) => axValue(byId.get(id)?.role) === "InlineTextBox");
          // An editable control's value is already emitted on its row. Only
          // suppress an entirely plain, unique leaf; retain masked values,
          // independent semantics and a leaf selected as the region root.
          const duplicateValueText = singleTextLeaf && ["textbox", "searchbox"].includes(parentRole)
            && !maskedControl(parent)
            && (node.properties === undefined || Array.isArray(node.properties) && node.properties.length === 0)
            && (node.actions === undefined || Array.isArray(node.actions) && node.actions.length === 0)
            && Boolean(name) && name === axValue(parent.value);
          const owner = nativeLeafOwner;
          const duplicateNativeValueText = singleTextLeaf && parentRole === "generic" && owner && !hidden(owner) && inScope(owner)
            && nativeIdentities.get(owner.backendDOMNodeId)?.includes(node.backendDOMNodeId) && !axValue(node.value)
            && (Boolean(name) && name === axValue(owner.value) || namesUnknown.has(node.nodeId));
          const duplicateTextareaText = provenTextareaChildren.has(node.nodeId) && node !== traversalRoot && owner && !hidden(owner) && inScope(owner);
          const duplicateText = duplicateValueText || duplicateNativeValueText || duplicateTextareaText;
          const emittedRole = role && role !== "none" && role !== "InlineTextBox" && (role !== "generic" || editableControl || editableEvidence?.readonly && properties.focusable === true);
          if (emittedRole && typeof node.backendDOMNodeId === "number") covered.add(node.backendDOMNodeId);
          else if (emittedRole && pseudoTextOwner(node) !== undefined) covered.add(pseudoTextOwner(node)!);
          if (emittedRole && !duplicateText) {
            let ref = "";
            const identity = `${scope}:${node.backendDOMNodeId ?? node.nodeId}`;
            if (node.backendDOMNodeId && role !== "RootWebArea" && (INTERACTIVE_ROLES.has(role) || node.properties?.some((property: any) => property.name === "focusable" && property.value?.value))) {
              ref = this.rememberRef(session, identity, { backendNodeId: node.backendDOMNodeId, frameId: frameLabel ?? session.rootFrameId, debuggee, role, name: semanticName(originalName), generation, identitySource: "ax" });
            }
            const state: Partial<Record<SnapshotStateName, unknown>> = Object.fromEntries(["checked", "disabled", "expanded", "pressed", "selected", "required", "readonly", "current", "level"].filter((key) => properties[key] !== undefined).map((key) => [key, properties[key]]));
            const domNodeIndex = domIndex.indexOf(node.backendDOMNodeId);
            const attributes = domNodeIndex === undefined ? [] : doc.nodes.attributes?.[domNodeIndex] ?? [];
            const currentOffset = attributes.findIndex((attribute: number, index: number) => index % 2 === 0 && snapshot.strings[attribute] === "aria-current");
            if (currentOffset >= 0) {
              const current = snapshot.strings[attributes[currentOffset + 1]];
              if (current) state.current = current === "false" ? false : ["page", "step", "location", "date", "time"].includes(current) ? current : true;
            }
            if (editableControl) state.editable = editableEvidence.mode;
            if (editableEvidence?.disabled) state.disabled = true;
            if (editableEvidence?.readonly) state.readonly = true;
            if (maskedControl(node)) state.masked = true;
            const nonNativeTextRole = ["textbox", "searchbox", "spinbutton"].includes(role) && !!editableTag && !["input", "textarea"].includes(editableTag);
            const actions = !ref ? [] : editableControl || !nonNativeTextRole && ["textbox", "searchbox", "spinbutton"].includes(role) ? ["click", "fill", "clear", "press", "insertText"]
              : ["checkbox", "radio", "switch"].includes(role) ? ["click", "check"]
              : ["combobox", "listbox"].includes(role) ? ["click", "select"] : ["click", "doubleClick", "hover"];
            // AX node IDs identify semantic rows; multiple AX rows can refer
            // to the same backend DOM node and therefore share an action ref.
            const pseudoBackend = pseudoTextOwner(node);
            const pseudoIndex = pseudoBackend === undefined ? undefined : pseudoTextRows.get(pseudoBackend) ?? 0;
            if (pseudoBackend !== undefined) pseudoTextRows.set(pseudoBackend, pseudoIndex! + 1);
            const snapshotId = pseudoBackend === undefined ? `${snapshotScope}.a${node.nodeId}` : `${snapshotScope}.p${pseudoBackend}.${pseudoIndex}`;
            const layoutBackend = node.backendDOMNodeId ?? pseudoBackend;
            const childFrameId = typeof node.backendDOMNodeId === "number"
              ? childFramesByOwner.get(JSON.stringify([debuggee.sessionId ?? "", node.backendDOMNodeId])) : undefined;
            const childFrameRef = childFrameId ? capturedFrameRefs.get(childFrameId) : undefined;
            const ownPlaceholder = placeholder(node);
            const textEvidence = role === "StaticText" && typeof layoutBackend === "number" ? evidenceTextItemsById.get(layoutBackend) : undefined;
            const textWhitespaceProven = Boolean(name && textEvidence?.textWhitespaceProven && textEvidence.text === name);
            const preserveTextWhitespace = textWhitespaceProven && textEvidence?.preserveTextWhitespace;
            const snapshotNode: SnapshotNode = { id: snapshotId, depth, role, name, value, layoutScope: frameId, ...(bounds.has(layoutBackend) ? { bounds: bounds.get(layoutBackend)! } : {}), ...(valueUnknown ? { valueUnknown: true } : {}), ...(textWhitespaceProven ? { textWhitespaceProven: true } : {}), ...(preserveTextWhitespace ? { preserveTextWhitespace: true } : {}), ...(namesUnknown.has(node.nodeId) ? { nameUnknown: true } : {}),
              ...(ownPlaceholder && ownPlaceholder.status !== "hidden" ? { placeholder: ownPlaceholder } : {}),
              ...(ref ? { ref, actions } : {}), ...(childFrameRef ? { childFrameRef } : {}), state };
            const rendered = renderSnapshotNode(snapshotNode);
            lines.push({ id: snapshotId, line: rendered.line, ...(rendered.ref ? { ref: rendered.ref } : {}), node: snapshotNode });
            axLines.set(node.nodeId, snapshotId);
            if (typeof layoutBackend === "number") lineBackends.set(snapshotId, layoutBackend);
            childDepth += 1;
          }
          const children: string[] = node.childIds ?? [];
          for (let index = children.length - 1; index >= 0; index--) {
            const child = byId.get(children[index]);
            if (child) pending.push({ node: child, depth: childDepth });
          }
        }
        if (scopedRoot) {
          // aria-owns can reorder AX nodes across DOM boundaries. Restore DOM
          // order and parent depths for the selected document while retaining
          // AX-only children immediately after their nearest semantic owner.
          const nearestAx = new Map<string, string | undefined>();
          const anchorByAx = new Map<string, number | undefined>();
          for (const node of order) {
            const parent = node.parentId, parentNode = parent && byId.get(parent);
            nearestAx.set(node.nodeId, parentNode && inScope(parentNode) ? axLines.get(parent) ?? nearestAx.get(parent) : undefined);
            anchorByAx.set(node.nodeId, typeof node.backendDOMNodeId === "number" && inScope(node) ? node.backendDOMNodeId
              : parentNode && inScope(parentNode) ? anchorByAx.get(parent) : undefined);
          }
          const nodeByLine = new Map([...axLines].map(([nodeId, lineId]) => [lineId, nodeId]));
          const markedBackends = new Set(lineBackends.values());
          const nearestDom = domIndex.nearestMarkedAncestors(markedBackends);
          const original = lines.splice(start);
          const anchor = (line: SnapshotLine) => {
            return positions.get(anchorByAx.get(nodeByLine.get(line.id) ?? "") ?? -1) ?? Number.MAX_SAFE_INTEGER;
          };
          original.sort((left, right) => anchor(left) - anchor(right));
          const byLine = new Map(original.map((line) => [line.id, line]));
          const depthByBackend = new Map<number, number>();
          const base = frameLabel ? frameDepth + 1 : 0;
          for (const line of original) {
            const node = line.node!;
            const backend = lineBackends.get(line.id), owner = nearestAx.get(nodeByLine.get(line.id) ?? "");
            const parentIndex = backend === undefined ? -1 : nearestDom[domIndex.indexOf(backend) ?? -1] ?? -1;
            const parentBackend = parentIndex < 0 ? undefined : domIndex.backendAt(parentIndex);
            const sameBackendOwner = owner && lineBackends.get(owner) === backend ? byLine.get(owner)?.node?.depth : undefined;
            const ownerDepth = backend === undefined && owner ? byLine.get(owner)?.node?.depth : sameBackendOwner;
            const parentDepth = ownerDepth ?? (parentBackend === undefined ? undefined : depthByBackend.get(parentBackend));
            const updated = { ...node, depth: parentDepth === undefined ? base : parentDepth + 1 };
            line.node = updated;
            if (backend !== undefined && !depthByBackend.has(backend)) depthByBackend.set(backend, updated.depth);
            const rendered = renderSnapshotNode(updated);
            line.line = rendered.line;
            if (rendered.ref) line.ref = rendered.ref;
          }
          for (const line of original) lines.push(line);
        }
        // Scoped output remains inside the region, but an input can have a
        // visible associated label elsewhere in the same document or shadow
        // tree. Retain whole-frame text solely for verified label names.
        const allEvidence = scopedRoot ? frameEvidence.filter((item) => domIndex.contains(regionNode!.node.backendNodeId, item.backendNodeId) === true) : frameEvidence;
        const extra = allEvidence.filter((item) => !covered.has(item.backendNodeId));
        const depths = new Map<number, number>();
        for (const line of lines.slice(start)) {
          const backend = lineBackends.get(line.id);
          if (backend !== undefined && line.node && !depths.has(backend)) depths.set(backend, line.node.depth);
        }
        const controls = new Set(extra.filter((item) => item.kind === "control" && item.tag !== "iframe" && item.tag !== "frame").map((item) => item.backendNodeId));
        // Represented AX semantics are label boundaries too. Otherwise a
        // delegated click handler on a page wrapper copies every child label.
        const nearestControl = domIndex.nearestMarkedAncestors(new Set([...controls, ...covered]));
        const controlParts = new Map<number, SnapshotDomEvidence[]>();
        for (const item of allEvidence) if (item.kind === "text") {
          const ancestor = nearestControl[item.nodeIndex]!;
          const control = ancestor < 0 ? undefined : domIndex.backendAt(ancestor);
          if (control !== undefined && controls.has(control)) { const parts = controlParts.get(control) ?? []; parts.push(item); controlParts.set(control, parts); }
        }
        const controlText = new Map([...controlParts].map(([id, parts]) => [id, parts.map((part) => part.text ?? "").join("").replace(/\s+/g, " ").trim()]));
        // The snapshot provides painted text, while the live label object
        // association determines tree scope and duplicate-id behavior.
        const labels = new Map<number, { parts: string[] }>();
        let documentLabelCount = 0;
        for (let index = 0; index < doc.nodes.backendNodeId.length; index++) {
          if (snapshot.strings[doc.nodes.nodeName[index]]?.toLowerCase() !== "label") continue;
          documentLabelCount++;
          const id = doc.nodes.backendNodeId[index];
          if (visibility.get(id) === true) labels.set(id, { parts: [] });
        }
        const nearestLabel = domIndex.nearestMarkedAncestors(new Set(labels.keys()));
        for (const item of frameEvidence) if (item.kind === "text") {
          const ancestor = nearestLabel[item.nodeIndex]!;
          const id = ancestor < 0 ? undefined : domIndex.backendAt(ancestor);
          if (id !== undefined) labels.get(id)?.parts.push(item.text ?? "");
        }
        const visibleLabel = (ids: readonly number[]): string => ids
          .map((id) => labels.get(id)!.parts.join("").replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
        const marked = new Set(depths.keys());
        for (const item of extra) if (item.kind === "control" || item.kind === "text" && (!!item.text?.trim() || unknownText.has(item.backendNodeId))) marked.add(item.backendNodeId);
        const nearestEmitted = domIndex.nearestMarkedAncestors(marked);
        const group = controls.size ? `surf-wax-dom-snapshot:${crypto.randomUUID()}` : undefined;
        const additions: Array<{ position: number; line: SnapshotLine }> = [];
        try {
          const currentControls = new Map<number, any>();
          const controlItems = extra.filter((item) => controls.has(item.backendNodeId));
          const controlObjects = new Map<number, string>();
          let associationCount = 0;
          for (let offset = 0; offset < controlItems.length; offset += 32) {
            const batch = controlItems.slice(offset, offset + 32);
            const pending = batch.map(async (item) => {
              frameGuard();
              const resolved = await this.options.command(debuggee, "DOM.resolveNode", { backendNodeId: item.backendNodeId, objectGroup: group });
              frameGuard();
              if (!resolved.object?.objectId) throw automationError("snapshot-unavailable", { reason: "missing-dom-control" });
              const objectId = resolved.object.objectId as string;
              const response = await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId, returnByValue: true,
                functionDeclaration: `function(){const labels=this.labels, fillability=(${SNAPSHOT_FILLABILITY_SOURCE}).call(this);return {meta:(${SEARCH_META_SOURCE}).call(this,true), fillability, isContentEditable:!!this.isContentEditable, editable:fillability.fillable ? (${SNAPSHOT_EDITABLE_HOST_SOURCE}).call(this) : null, attributes:Object.fromEntries([...this.attributes].map(a=>[a.name.toLowerCase(),a.value])), value: typeof this.value === "string" ? this.value : undefined, checked: typeof this.checked === "boolean" ? this.checked : undefined, checkedState: (${CHECKED_STATE_SOURCE}).call(this), labelCount: labels == null ? 0 : labels.length}}` });
              frameGuard();
              if (response.exceptionDetails) throw automationError("snapshot-unavailable", { reason: "dom-control-read-failed" });
              return { objectId, value: response.result?.value };
            });
            const results = await Promise.allSettled(pending);
            const error = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
            if (error) throw error.reason;
            results.forEach((result, index) => {
              const { objectId, value } = (result as PromiseFulfilledResult<any>).value;
              const count = value?.labelCount;
              if (!Number.isSafeInteger(count) || count < 0 || count > documentLabelCount - associationCount)
                throw automationError("snapshot-unavailable", { reason: "dom-label-count-inconsistent" });
              associationCount += count;
              controlObjects.set(batch[index]!.backendNodeId, objectId);
              currentControls.set(batch[index]!.backendNodeId, { ...value, labels: [] });
            });
          }
          const domFillability = new Map<number, Fillability>();
          for (const item of controlItems) {
            const current = currentControls.get(item.backendNodeId), value = current?.fillability;
            if ((current?.isContentEditable || Object.hasOwn(item.attributes ?? {}, "contenteditable"))
              && value && [value.fillable, value.disabled, value.readonly].every((part) => typeof part === "boolean"))
              domFillability.set(item.backendNodeId, value);
          }
          if (domFillability.size) fillabilityBatches.push({ debuggee, frameId, values: domFillability });
          // Read only actual live associations, rather than resolving every
          // label sharing a potentially duplicated HTML id for every control.
          // The sum is bounded by document labels because a label has at most
          // one labeled control; inconsistency indicates a changing capture.
          const associatedControls = controlItems.filter((item) => currentControls.get(item.backendNodeId).labelCount > 0);
          const labelHandles: Array<{ controlId: number; objectId: string }> = [];
          for (let offset = 0; offset < associatedControls.length; offset += 32) {
            const batch = associatedControls.slice(offset, offset + 32);
            const pending = batch.map(async (item) => {
              frameGuard();
              const response = await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId: controlObjects.get(item.backendNodeId), objectGroup: group,
                functionDeclaration: "function(){return Array.from(this.labels || [])}" });
              frameGuard();
              if (response.exceptionDetails || typeof response.result?.objectId !== "string")
                throw automationError("snapshot-unavailable", { reason: "dom-label-list-unavailable" });
              const properties = await this.options.command(debuggee, "Runtime.getProperties", { objectId: response.result.objectId, ownProperties: true });
              frameGuard();
              if (properties.exceptionDetails || !Array.isArray(properties.result)) throw automationError("snapshot-unavailable", { reason: "dom-label-list-unavailable" });
              const count = currentControls.get(item.backendNodeId).labelCount as number;
              const length = properties.result.find((property: any) => property.name === "length")?.value?.value;
              if (length !== count) throw automationError("snapshot-unavailable", { reason: "dom-label-count-inconsistent" });
              const handles: string[] = new Array(count);
              for (const property of properties.result) {
                if (typeof property.name !== "string" || !/^(?:0|[1-9]\d*)$/.test(property.name)) continue;
                const index = Number(property.name), objectId = property.value?.objectId;
                if (!Number.isSafeInteger(index) || index < 0 || index >= count || handles[index] !== undefined || typeof objectId !== "string")
                  throw automationError("snapshot-unavailable", { reason: "dom-label-identity-unavailable" });
                handles[index] = objectId;
              }
              if (handles.some((value) => typeof value !== "string") || Object.keys(handles).length !== count)
                throw automationError("snapshot-unavailable", { reason: "dom-label-identity-unavailable" });
              return handles;
            });
            const results = await Promise.allSettled(pending);
            const error = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
            if (error) throw error.reason;
            results.forEach((result, index) => {
              for (const objectId of (result as PromiseFulfilledResult<string[]>).value)
                labelHandles.push({ controlId: batch[index]!.backendNodeId, objectId });
            });
          }
          const claimedLabels = new Set<number>();
          for (let offset = 0; offset < labelHandles.length; offset += 32) {
            const batch = labelHandles.slice(offset, offset + 32);
            frameGuard();
            const pending = batch.map(({ objectId }) => this.options.command(debuggee, "DOM.describeNode", { objectId, depth: 0 }));
            const results = await Promise.allSettled(pending);
            frameGuard();
            const error = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
            if (error) throw error.reason;
            results.forEach((result, index) => {
              const node = (result as PromiseFulfilledResult<any>).value?.node;
              const id = node?.backendNodeId;
              if (!Number.isSafeInteger(id) || id <= 0 || node.nodeType !== 1 || String(node.nodeName).toLowerCase() !== "label"
                || domIndex.indexOf(id) === undefined || claimedLabels.has(id))
                throw automationError("snapshot-unavailable", { reason: "dom-label-identity-unavailable" });
              claimedLabels.add(id);
              currentControls.get(batch[index]!.controlId).labels.push(id);
            });
          }
          // Resolve actual browser label associations, including shadow-root
          // scoping and duplicate IDs. Only painted text from the captured
          // document is used as output; the live nodes supply identity alone.
          const ariaControls = controlItems.filter((item) => Object.hasOwn(item.attributes ?? {}, "aria-labelledby"));
          const readAriaReferences = async () => {
            const ariaReferences = new Map<number, number[]>();
            for (let offset = 0; offset < ariaControls.length; offset += 4) {
            const batch = ariaControls.slice(offset, offset + 4);
            const results = await Promise.allSettled(batch.map(async (item) => {
              frameGuard();
              const response = await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId: controlObjects.get(item.backendNodeId), objectGroup: group,
                functionDeclaration: "function(){return Array.from(this.ariaLabelledByElements || [])}" });
              frameGuard();
              if (response.exceptionDetails || typeof response.result?.objectId !== "string")
                throw automationError("snapshot-unavailable", { reason: "dom-aria-label-list-unavailable" });
              const properties = await this.options.command(debuggee, "Runtime.getProperties", { objectId: response.result.objectId, ownProperties: true });
              frameGuard();
              const count = properties.result?.find((property: any) => property.name === "length")?.value?.value;
              // IDREF lists may repeat the same element arbitrarily many
              // times, so their length is not bounded by document node count.
              // The returned JavaScript array still has a 32-bit length.
              if (properties.exceptionDetails || !Array.isArray(properties.result) || !Number.isSafeInteger(count) || count < 0 || count > 0xffffffff)
                throw automationError("snapshot-unavailable", { reason: "dom-aria-label-list-unavailable" });
              const handles: string[] = new Array(count);
              for (const property of properties.result) {
                if (typeof property.name !== "string" || !/^(?:0|[1-9]\d*)$/.test(property.name)) continue;
                const index = Number(property.name), objectId = property.value?.objectId;
                if (!Number.isSafeInteger(index) || index >= count || handles[index] !== undefined || typeof objectId !== "string")
                  throw automationError("snapshot-unavailable", { reason: "dom-aria-label-identity-unavailable" });
                handles[index] = objectId;
              }
              if (Object.keys(handles).length !== count) throw automationError("snapshot-unavailable", { reason: "dom-aria-label-identity-unavailable" });
              const ids: number[] = [];
              for (let offset = 0; offset < handles.length; offset += 8) {
                const described = await Promise.allSettled(handles.slice(offset, offset + 8).map((objectId) => this.options.command(debuggee, "DOM.describeNode", { objectId, depth: 0 })));
                frameGuard();
                const failed = described.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
                if (failed) throw failed.reason;
                for (const entry of described as PromiseFulfilledResult<any>[]) {
                  const node = entry.value?.node, id = node?.backendNodeId;
                  if (node?.nodeType !== 1 || !Number.isSafeInteger(id) || id <= 0 || domIndex.indexOf(id) === undefined)
                    throw automationError("snapshot-unavailable", { reason: "dom-aria-label-identity-unavailable" });
                  ids.push(id);
                }
              }
              return ids;
            }));
            const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
            if (failed) throw failed.reason;
              results.forEach((result, index) => ariaReferences.set(batch[index]!.backendNodeId, (result as PromiseFulfilledResult<number[]>).value));
            }
            return ariaReferences;
          };
          const ariaReferences = await readAriaReferences();
          const visibleText = frameEvidence.filter((item) => item.kind === "text" && item.text);
          const lowerTextPosition = (position: number) => {
            let low = 0, high = visibleText.length;
            while (low < high) {
              const middle = (low + high) >>> 1;
              if ((positions.get(visibleText[middle]!.backendNodeId) ?? Infinity) < position) low = middle + 1;
              else high = middle;
            }
            return low;
          };
          const ariaTextCache = new Map<number, string>();
          const ariaText = (id: number) => {
            const cached = ariaTextCache.get(id);
            if (cached !== undefined) return cached;
            const index = domIndex.indexOf(id), range = index === undefined ? undefined : visibleRange(index);
            const value = range ? normalizeSnapshotText(visibleText.slice(lowerTextPosition(range.start), lowerTextPosition(range.end)).map((item) => item.text).join("")) : "";
            ariaTextCache.set(id, value);
            return value;
          };
          // Suppress a text leaf only when the actual emitted name contains
          // exactly that visible text. An aria-label can differ from painted
          // content; replacing the latter would discard information.
          const controlName = (item: SnapshotDomEvidence) => {
            const current = currentControls.get(item.backendNodeId);
            const matchedLabels: number[] = (current?.labels ?? []).filter((id: number) => labels.has(id))
              .sort((left: number, right: number) => (positions.get(left) ?? 0) - (positions.get(right) ?? 0));
            const references = [...new Set<number>(ariaReferences.get(item.backendNodeId) ?? [])]
              .filter((id) => !scopedRoot || domIndex.contains(regionNode!.node.backendNodeId, id) === true);
            const referencedLabel = references.map(ariaText).filter(Boolean).join(" ");
            return controlText.get(item.backendNodeId) || referencedLabel || visibleLabel(matchedLabels) || "";
          };
          // Native indeterminate is a live property absent from DOMSnapshot.
          // Compare it and checked against a second live sample before release;
          // attribute states are separately checked by both DOM captures.
          const checkedItems = controlItems.filter((item) => item.checked !== undefined);
          for (let offset = 0; offset < checkedItems.length; offset += 32) {
            const batch = checkedItems.slice(offset, offset + 32);
            const results = await Promise.allSettled(batch.map((item) => this.options.command(debuggee, "Runtime.callFunctionOn", {
              objectId: controlObjects.get(item.backendNodeId), functionDeclaration: CHECKED_STATE_SOURCE, returnByValue: true,
            })));
            frameGuard();
            const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
            if (failed) throw failed.reason;
            results.forEach((result, index) => {
              const response = (result as PromiseFulfilledResult<any>).value, next = response.result?.value;
              const before = currentControls.get(batch[index]!.backendNodeId)?.checkedState;
              if (response.exceptionDetails || !next || next.supported !== true || ![true, false, null].includes(next.value))
                throw automationError("snapshot-unavailable", { reason: "missing-dom-checked-evidence" });
              if (!before || before.supported !== next.supported || before.radio !== next.radio || before.value !== next.value) unstableDOMChecked = true;
            });
          }
          for (const item of extra) {
            if (item.kind === "text" && !item.text?.trim() && !item.textWhitespaceProven && !unknownText.has(item.backendNodeId)) continue;
            const parentIndex = nearestEmitted[item.nodeIndex]!;
            const parent = parentIndex < 0 ? undefined : domIndex.backendAt(parentIndex);
            const depth = parent === undefined || !depths.has(parent) ? (frameLabel ? frameDepth + 1 : 0) : depths.get(parent)! + 1;
            const id = `${snapshotScope}.d${item.backendNodeId}`;
            let node: SnapshotNode;
            if (item.kind === "text") {
              node = { id, depth, role: "StaticText", name: item.text, ...(unknownText.has(item.backendNodeId) ? { nameUnknown: true } : {}),
                ...(item.textWhitespaceProven && item.text ? { textWhitespaceProven: true } : {}),
                ...(item.preserveTextWhitespace && item.text ? { preserveTextWhitespace: true } : {}) };
            }
            else {
              const tag = item.tag!;
              const type = (item.attributes?.type ?? "text").toLowerCase();
              const current = currentControls.get(item.backendNodeId);
              const editable = current?.editable;
              const editableControl = !!editable && current?.fillability?.fillable === true
                && ["richtext", "plaintext"].includes(current.fillability.mode);
              const explicitRole = item.attributes?.role?.trim();
              const role = explicitRole && /^[a-z][a-z0-9]*$/.test(explicitRole) && !["input", "textarea", "select", "button", "option"].includes(tag) ? explicitRole
                : tag === "iframe" || tag === "frame" ? "iframe" : tag === "button" ? "button" : tag === "a" ? "link" : tag === "select" ? "combobox" : tag === "textarea" ? "textbox"
                : tag === "input" ? ({ checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox", button: "button", submit: "button", reset: "button" } as Record<string, string>)[type] ?? "textbox"
                  : item.attributes?.role?.trim() === "button" ? "button" : "generic";
              const name = controlName(item);
              const state: Partial<Record<SnapshotStateName, unknown>> = {};
              if (editableControl) state.editable = current.fillability.mode;
              if (current?.fillability?.disabled) state.disabled = true;
              if (current?.fillability?.readonly) state.readonly = true;
              if (current?.checkedState?.supported === true)
                state.checked = current.checkedState.value === null ? "mixed" : current.checkedState.value;
              if (item.masked) state.masked = true;
              for (const key of ["disabled", "required", "readonly"] as const) if (Object.hasOwn(item.attributes ?? {}, key)) state[key] = true;
              for (const key of ["expanded", "pressed", "selected", "required", "readonly"] as const) {
                const value = item.attributes?.[`aria-${key}`]?.trim().toLowerCase();
                if ((value === "true" || value === "false") && !(state[key] === true && value === "false")) state[key] = value === "true";
                else if (key === "pressed" && value === "mixed") state[key] = "mixed";
              }
              let ref = "";
              if (tag !== "iframe" && tag !== "frame") {
                if (typeof current?.meta?.connected !== "boolean" || typeof current.meta.tag !== "string"
                  || !current.attributes || typeof current.attributes !== "object" || Array.isArray(current.attributes))
                  throw automationError("snapshot-unavailable", { reason: "dom-control-read-failed" });
                if (current?.meta?.connected !== true || current.meta.tag !== tag
                  // Inline style can animate without changing visibility;
                  // the final DOM confirmation compares its actual effects.
                  || JSON.stringify(Object.entries(current.attributes ?? {}).filter(([key]) => key !== "style").sort()) !== JSON.stringify(Object.entries(item.attributes ?? {}).filter(([key]) => key !== "style").sort())
                  || item.value !== undefined && current.value !== item.value || item.checked !== undefined && current.checked !== item.checked)
                  throw automationError("snapshot-unavailable", { reason: "dom-control-changed-during-capture" });
                // Never bind a DOM ref unless its live identity matches the
                // visible name and native role actually exposed in this snapshot.
                if (!current.meta.identityTooLarge && current.meta.identityRole === role && typeof current.meta.identityName === "string") {
                  // DOM identity may be derived from the current input value.
                  // Keep it only in the private ref record, never in its label.
                  ref = this.rememberRef(session, `${scope}:${item.backendNodeId}`, { backendNodeId: item.backendNodeId, frameId, debuggee, role, name: current.meta.identityName, generation, identitySource: "dom" });
                }
              }
              const nonNativeTextRole = ["textbox", "searchbox", "spinbutton"].includes(role) && !["input", "textarea"].includes(tag);
              const nativeControl = ["input", "textarea", "select", "button", "a"].includes(tag);
              const explicitTabIndex = item.attributes?.tabindex?.trim();
              const focusHint = explicitTabIndex !== undefined && /^[+-]?\d+$/.test(explicitTabIndex);
              // A role establishes semantics, not a pointer or editing handler.
              // Only advertise pointer actions for CDP-proven clickable custom
              // controls; tabindex independently permits keyboard targeting.
              const actions = !ref ? [] : editableControl || !nonNativeTextRole && ["textbox", "searchbox", "spinbutton"].includes(role) ? ["click", "fill", "clear", "press", "insertText"]
                : !nativeControl ? [...(item.clickable ? ["click", "doubleClick", "hover"] : []), ...(focusHint ? ["press"] : []),
                  ...(item.clickable && current?.checkedState?.supported === true ? ["check"] : [])]
                : ["checkbox", "radio", "switch"].includes(role) ? ["click", "check"] : ["combobox", "listbox"].includes(role) ? ["click", "select"] : ["click", "doubleClick", "hover"];
              const childFrameId = childFramesByOwner.get(JSON.stringify([debuggee.sessionId ?? "", item.backendNodeId]));
              const childFrameRef = childFrameId ? capturedFrameRefs.get(childFrameId) : undefined;
              const ownPlaceholder = placeholders.get(item.backendNodeId)?.evidence;
              const dynamicLabel = partial && [...(ariaReferences.get(item.backendNodeId) ?? []), ...(current?.labels ?? [])]
                .some((id: number) => domIndex.indexOf(id) === undefined || hasUnknownSubtree(id));
              const nameUnknown = hasUnknownSubtree(item.backendNodeId) || dynamicLabel || (!name && Boolean(current?.meta?.identityName)) || Boolean(current?.meta?.identityTooLarge);
              const valueCandidate = item.value && item.valueVisible && tag !== "select" && !["button", "submit", "reset", "checkbox", "radio"].includes(type);
              const selectLabel = tag === "select" ? selectValues.get(item.backendNodeId) : undefined;
              const valueUnknown = Boolean(partial && tag === "select" && hasUnknownSubtree(item.backendNodeId)
                || valueCandidate && ["input", "textarea"].includes(tag) && nativeValues.get(item.backendNodeId) !== item.value
                || tag === "select" && item.selectedOptions?.length && !selectLabel);
              node = { id, depth, role, ...(!dynamicLabel && name ? { name } : {}), ...(nameUnknown ? { nameUnknown: true } : {}), ...(ownPlaceholder && ownPlaceholder.status !== "hidden" ? { placeholder: ownPlaceholder } : {}),
                ...(valueUnknown ? { valueUnknown: true } : valueCandidate ? { value: item.value } : {}),
                ...(!valueUnknown && item.valueVisible && selectLabel ? { selectedLabels: [selectLabel] } : {}),
                ...(ref ? { ref, actions } : {}), ...(childFrameRef ? { childFrameRef } : {}), state };
            }
            node = { ...node, layoutScope: frameId, ...(bounds.has(item.backendNodeId) ? { bounds: bounds.get(item.backendNodeId)! } : {}) };
            depths.set(item.backendNodeId, depth);
            const rendered = renderSnapshotNode(node);
            additions.push({ position: positions.get(item.backendNodeId) ?? Number.MAX_SAFE_INTEGER, line: { id, line: rendered.line, ...(rendered.ref ? { ref: rendered.ref } : {}), node } });
          }
          if (ariaControls.length) {
            const afterReferences = await readAriaReferences();
            unstableDOMAria ||= ariaControls.some((item) => JSON.stringify(ariaReferences.get(item.backendNodeId)) !== JSON.stringify(afterReferences.get(item.backendNodeId)));
          }
        } finally { if (group) await this.options.command(debuggee, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => undefined); }
        frameGuard();
        // Merge into the original AX order without reordering AX siblings.
        // DOM document order positions only locate the next represented node.
        const original = lines.splice(start);
        let next = 0;
        for (const line of original) {
          const backend = lineBackends.get(line.id), position = backend === undefined ? undefined : positions.get(backend);
          while (position !== undefined && next < additions.length && additions[next]!.position < position) lines.push(additions[next++]!.line);
          lines.push(line);
        }
        while (next < additions.length) lines.push(additions[next++]!.line);
      };
      // Match the captured DOM node to exactly one frame in the resolved
      // debugger target. AX can omit the region, but another frame with the
      // same backend ID must never be accepted as its replacement.
      const regionMatches = regionNode ? trees.filter(({ debuggee, frameId, tree, snapshot }) => {
        if (!tree || !regionDebuggee || !sameDebuggee(debuggee, regionDebuggee)) return false;
        const wanted = frameId ?? session.rootFrameId;
        return snapshot.documents?.some((doc: any) => snapshot.strings?.[doc.frameId] === wanted
          && doc.nodes?.backendNodeId?.includes(regionNode.node.backendNodeId));
      }) : [];
      if (regionNode && regionMatches.length !== 1) throw automationError("snapshot-region-unavailable", { locator: region });
      const uncertainContrast = trees.some((item) => item.tree && item.candidates.some((candidate) => candidate.sameColorBackground
        && candidate.frameId === (item.frameId ?? session.rootFrameId) && item.visibility.get(candidate.backendNodeId) === true));
      const partial = dynamicTextByTarget.size > 0 || uncertainContrast;
      const limitations = uncertainContrast ? "Some text has equal captured fill and ancestor background colors. Its composited visibility is unconfirmed; names remain unknown and geometry is retained. This is incomplete evidence." : undefined;
      const frameSnapshots: Array<{ frameRef: string; lines: SnapshotLine[] }> = [];
      let interruptedRender = false;
      for (const item of trees) {
        const { debuggee, frameId, tree, visibility, textProjections, unknownText, paintEvidence, candidates, snapshot } = item;
        if (!tree) continue;
        const dynamicText = dynamicTextNodes(snapshot, dynamicTextByTarget.get(debuggee.sessionId ?? ""));
        for (const id of dynamicText) { unknownText.add(id); textProjections.delete(id); }
        // Render each document at its own origin, then insert it at the
        // represented iframe owner. Frame depth alone is not semantic depth.
        try {
          await waitForCapture(render(tree.nodes ?? [], visibility, textProjections, unknownText, paintEvidence, candidates, snapshot, debuggee, frameId, 0, dynamicText));
        } catch (error) {
          guard();
          if (!changed()) {
            // A client-side replacement can detach a captured control without
            // changing the document or frame revision. Discard the whole pass
            // under the same bounded stability budget as state confirmation.
            if (!(error instanceof AutomationError) || error.code !== "snapshot-unavailable"
              || error.detail.reason !== "dom-control-changed-during-capture" || retriedUnstableCapture) throw error;
            retriedUnstableCapture = true;
          }
          interruptedRender = true; break;
        }
        if (changed()) { interruptedRender = true; break; }
        const frameRef = capturedFrameRefs.get(frameId ?? session.rootFrameId!);
        if (!frameRef) throw automationError("snapshot-unavailable", { reason: "missing-frame-ref" });
        const renderedLines = lines.splice(0).map((line) => {
          if (!partial || !line.node || !line.node.nameUnknown && !line.node.valueUnknown) return line;
          const { ref: _ref, actions: _actions, ...node } = line.node;
          const rendered = renderSnapshotNode(node);
          return { id: line.id, line: rendered.line, node };
        });
        frameSnapshots.push({ frameRef, lines: renderedLines });
      }
      if (interruptedRender) { await delay(0, signal); continue; }
      if (unstableDOMChecked) {
        if (retriedUnstableCapture) throw automationError("snapshot-unavailable", { reason: "dom-checked-unstable" });
        retriedUnstableCapture = true; continue;
      }
      if (unstableDOMAria) {
        if (retriedUnstableCapture) throw automationError("snapshot-unavailable", { reason: "dom-aria-label-unstable" });
        retriedUnstableCapture = true; continue;
      }
      for (const line of compactSnapshot(stitchSnapshotFrames(frameSnapshots, capturedFrameRefs.get(regionFrameId ?? session.rootFrameId!)))) lines.push(line);
      const ids = new Set<string>();
      for (const { id } of expandSnapshot(lines)) {
        if (ids.has(id)) throw automationError("snapshot-unavailable", { reason: "duplicate-semantic-id", id });
        ids.add(id);
      }
      if (!changed()) {
        let confirmations: Array<{ debuggee: Debuggee; snapshot: any }>;
        let unstableEllipsis: EllipsisBatch[] = [];
        try {
          const afterEllipsis = await waitForCapture(Promise.all(ellipsisBatches.map((batch) => readEllipsisGeometry(batch.debuggee, batch.frameId, batch.requests))));
          if (ellipsisBatches.some((batch, index) => JSON.stringify(batch.proofs) !== JSON.stringify(afterEllipsis[index]))) {
            unstableEllipsis = ellipsisBatches.filter((batch, index) => JSON.stringify(batch.proofs) !== JSON.stringify(afterEllipsis[index]));
          }
          const afterFramePaint = await waitForCapture(Promise.all(framePaintBatches.map((batch) => readFramePaint(batch[0]!.frameId))));
          if (framePaintBatches.some((batch, index) => JSON.stringify(batch) !== JSON.stringify(afterFramePaint[index]))) {
            if (retriedUnstableCapture) throw automationError("snapshot-unavailable", { reason: "frame-paint-unstable" });
            retriedUnstableCapture = true; continue;
          }
          const afterNativeValues = await waitForCapture(Promise.all(nativeValueBatches.map((batch) => readNativeValues(batch.debuggee, batch.frameId, batch.requests, batch.selects, batch.hosts, batch.frameSafe, batch.shadowSafe))));
          if (nativeValueBatches.some((batch, index) => JSON.stringify(batch.result) !== JSON.stringify(afterNativeValues[index]))) {
            if (retriedUnstableCapture) throw automationError("snapshot-unavailable", { reason: "native-value-unstable" });
            retriedUnstableCapture = true; continue;
          }
          const afterFillability = await waitForCapture(Promise.all(fillabilityBatches.map((batch) => readFillability(batch.debuggee, batch.frameId, [...batch.values.keys()]))));
          const changedFillability = fillabilityBatches.some((batch, index) => {
            const next = afterFillability[index]!;
            return next.size !== batch.values.size || [...batch.values].some(([id, before]) => {
              const value = next.get(id);
              return !value || value.fillable !== before.fillable || value.disabled !== before.disabled || value.readonly !== before.readonly || value.mode !== before.mode;
            });
          });
          if (changedFillability) {
            if (retriedUnstableCapture) throw automationError("snapshot-unavailable", { reason: "editability-unstable" });
            retriedUnstableCapture = true; continue;
          }
          const after = await waitForCapture(collectPlaceholders(placeholderItems));
          const changedPlaceholder = after.size !== placeholderBefore.size || [...placeholderBefore].some(([key, before]) => {
            const next = after.get(key);
            return !next || before.textBackendNodeId !== next.textBackendNodeId || !samePlaceholderEvidence(before.evidence, next.evidence);
          });
          if (changedPlaceholder) {
            if (retriedUnstableCapture) throw automationError("snapshot-unavailable", { reason: "placeholder-unstable" });
            retriedUnstableCapture = true; continue;
          }
          confirmations = await waitForCapture(Promise.all(relevantDebuggees.map(async ({ debuggee }) => ({ debuggee,
            snapshot: await this.options.command(debuggee, "DOMSnapshot.captureSnapshot", { computedStyles: [...computedStyles], includeDOMRects: true, includePaintOrder: true }) }))));
          if (changed()) continue;
          if (!await waitForCapture(framesAreReady())) { await delay(50, signal); continue; }
        } catch (error) {
          guard();
          const stalePlaceholderContext = error instanceof AutomationError && error.code === "stale-frame"
            && ["placeholder-context-expired", "frame-context-expired", "placeholder-node-detached"].includes(String(error.detail.reason));
          if (stalePlaceholderContext && !changed()) {
            if (retriedUnstableCapture) throw automationError("snapshot-unavailable", { reason: "placeholder-context-unstable" });
            retriedUnstableCapture = true;
          }
          if (!changed() && !stalePlaceholderContext && isDetachedNodeError(error) && initialLayouts.length) {
            await recoverDetachedText();
            continue;
          }
          if (!changed() && !isTransientNavigationError(error) && !isDetachedNodeError(error) && !stalePlaceholderContext) throw error;
          await delay(changed() ? 0 : 50, signal); continue;
        }
        if (changed()) continue;
        let unstable = unstableEllipsis.length > 0, unstablePaint = unstable, onlyUnrenderedText = !unstable, onlyDynamicText = true, headSourceChange = false;
        const styleEvidence = computedStyles === SNAPSHOT_COMPUTED_STYLES ? undefined : { completeStyleCatalog: computedStyles };
        const observedDynamicText = new Map<string, Set<number>>();
        const relaxedChecks: Array<(snapshot: any) => boolean> = [];
        for (const confirmation of confirmations) {
          const initial = trees.find(({ debuggee }) => sameDebuggee(debuggee, confirmation.debuggee));
          // Project unrelated documents out of this scope while preserving
          // each surviving frame edge by its original document identity.
          const relevantIds = regionNode ? new Set(relevantFrames.filter((item) => sameDebuggee(item.debuggee, confirmation.debuggee))
            .map((item) => item.frameId ?? session.rootFrameId)) : undefined;
          const projectedDocuments = new WeakMap<object, any>();
          const relevantDocuments = (snapshot: any) => {
            if (!relevantIds) return snapshot;
            if (projectedDocuments.has(snapshot)) return projectedDocuments.get(snapshot);
            const documents = snapshot.documents;
            if (!Array.isArray(documents)) throw automationError("snapshot-unavailable", { reason: "invalid-dom-confirmation" });
            const kept = documents.map((document: any, index: number) => ({ document, index }))
              .filter(({ document }: any) => relevantIds.has(snapshot.strings?.[document.frameId]));
            const positions = new Map(kept.map(({ index }: any, projected: number) => [index, projected]));
            // Validate against the original array, before indexes are reduced.
            for (const document of documents) {
              const edges = document.nodes?.contentDocumentIndex;
              if (!edges) continue;
              if (!Array.isArray(edges.index) || !Array.isArray(edges.value) || edges.index.length !== edges.value.length
                || new Set(edges.index).size !== edges.index.length
                || edges.index.some((value: number) => !Number.isSafeInteger(value) || value < 0 || value >= document.nodes.backendNodeId.length)
                || edges.value.some((value: number) => !Number.isSafeInteger(value) || value < 0 || value >= documents.length))
                throw automationError("snapshot-unavailable", { reason: "invalid-frame-document-index" });
            }
            const projected = { ...snapshot, documents: kept.map(({ document }: any) => {
              const edges = document.nodes.contentDocumentIndex;
              if (!edges) return document;
              const index: number[] = [], value: number[] = [];
              edges.index.forEach((owner: number, offset: number) => {
                const target = positions.get(edges.value[offset]);
                if (target !== undefined) { index.push(owner); value.push(target as number); }
              });
              return { ...document, nodes: { ...document.nodes, contentDocumentIndex: { index, value } } };
            }) };
            projectedDocuments.set(snapshot, projected); return projected;
          };
          const candidates = relevantIds ? initial?.candidates.filter((candidate) => relevantIds.has(candidate.frameId)) : initial?.candidates;
          const visibility = initial && relevantIds ? snapshotVisibility(relevantDocuments(initial.snapshot), { hiddenFrames }) : initial?.visibility;
          if (visibility && initial && relevantIds) for (const id of visibility.keys()) {
            const value = initial.visibility.get(id);
            if (value !== undefined) visibility.set(id, value);
          }
          const relaxed = (snapshot: any) => Boolean(initial && visibility && sameDOMSnapshot(relevantDocuments(initial.snapshot), relevantDocuments(snapshot),
            { visibility, textPaintCandidates: candidates ?? [], paintAdjusted: true, frameClips, hiddenFrames }, { ...styleEvidence, ignoreUnrenderedText: true }));
          relaxedChecks.push(relaxed);
          if (initial && visibility && sameDOMSnapshot(relevantDocuments(initial.snapshot), relevantDocuments(confirmation.snapshot),
            { visibility, textPaintCandidates: candidates ?? [], paintAdjusted: true, frameClips, hiddenFrames }, styleEvidence)) continue;
          if (!styleEvidence && initial && visibility && hasUnrenderedHeadSourceChange(relevantDocuments(initial.snapshot), relevantDocuments(confirmation.snapshot),
            { visibility, textPaintCandidates: candidates ?? [], paintAdjusted: true, frameClips, hiddenFrames })) headSourceChange = true;
          unstable = true;
          const textChanges = initial && visibility ? changedTextNodes(relevantDocuments(initial.snapshot), relevantDocuments(confirmation.snapshot),
            { visibility, textPaintCandidates: candidates ?? [], paintAdjusted: true, frameClips, hiddenFrames }, styleEvidence) : undefined;
          if (!textChanges) onlyDynamicText = false;
          else observedDynamicText.set(confirmation.debuggee.sessionId ?? "", textChanges);
          if (!relaxed(confirmation.snapshot)) onlyUnrenderedText = false;
          const after: SnapshotTextPaintCandidate[] = [];
          try { snapshotVisibility(confirmation.snapshot, { textPaintCandidates: after, hiddenFrames }); }
          catch { throw automationError("snapshot-unavailable", { reason: "invalid-dom-confirmation" }); }
          if (initial && !sameTextPaintCandidates(candidates ?? [], relevantIds ? after.filter((candidate) => relevantIds.has(candidate.frameId)) : after)) unstablePaint = true;
        }
        // A changed ellipsis proof is attributable to dynamic text only if
        // every affected request resolves to a parent already identified by
        // the independently compared DOM captures. Otherwise keep failing
        // closed rather than accepting unrelated changes in paint/occlusion.
        if (unstableEllipsis.length) for (const batch of unstableEllipsis) {
          const initial = trees.find(({ debuggee }) => sameDebuggee(debuggee, batch.debuggee));
          const parents = observedDynamicText.get(batch.debuggee.sessionId ?? "");
          if (!initial || !parents || batch.requests.some((request) => {
            const doc = initial.snapshot.documents?.find((item: any) => initial.snapshot.strings?.[item.frameId] === batch.frameId);
            const index = doc?.nodes?.backendNodeId?.indexOf(request.backendNodeId) ?? -1;
            const parent = index < 0 ? -1 : doc.nodes.parentIndex?.[index];
            return !Number.isSafeInteger(parent) || parent < 0 || !parents.has(doc.nodes.backendNodeId[parent]);
          })) onlyDynamicText = false;
        }
        if (unstable) {
          if (headSourceChange && !styleEvidence) {
            // HEAD selectors and script effects can change properties absent
            // from the small default profile. Never reuse the old rows: spend
            // an existing recovery pass on a complete standard-style capture.
            const catalog = await waitForCapture(this.snapshotCompleteStyleCatalog(session));
            if (changed()) continue;
            session.snapshotStyleProfile = { generation, computedStyles: catalog };
            computedStyles = catalog;
            retryDynamicCapture("dom-unstable");
            continue;
          }
          // A second observed change confirms that these regions are dynamic.
          speculativeDynamic = false;
          // A hidden text node can still supply an accessible name (for
          // example through aria-labelledby). Only tolerate such changes if
          // every captured accessibility tree is independently unchanged.
          if (retriedUnstableCapture && onlyUnrenderedText && !partial) {
            let axChecks: boolean[];
            try {
              axChecks = await waitForCapture(Promise.all(trees.filter((item) => item.tree).map(async (item) => {
                const source = relevantFrames.find((frame) => frame.frameId === item.frameId && sameDebuggee(frame.debuggee, item.debuggee));
                if (!source || !Array.isArray(item.tree.nodes)) return false;
                const next = await this.options.command(item.debuggee, "Accessibility.getFullAXTree", allDebuggees.includes(source) ? {} : { frameId: item.frameId });
                return Array.isArray(next?.nodes) && JSON.stringify(item.tree) === JSON.stringify(next);
              })));
            } catch (error) {
              guard();
              if (!changed() && !isTransientNavigationError(error) && !isDetachedNodeError(error)) throw error;
              await delay(changed() ? 0 : 50, signal); continue;
            }
            if (changed()) continue;
            if (axChecks.length === capturedFrames.length && axChecks.length && axChecks.every(Boolean) && await waitForCapture(framesAreReady()) && !changed()) {
              let finalLayouts: Array<{ debuggee: Debuggee; snapshot: any }>;
              try {
                finalLayouts = await waitForCapture(Promise.all(relevantDebuggees.map(async ({ debuggee }) => ({ debuggee,
                  snapshot: await this.options.command(debuggee, "DOMSnapshot.captureSnapshot", { computedStyles: [...computedStyles], includeDOMRects: true, includePaintOrder: true }) }))));
              } catch (error) {
                guard();
                if (!changed() && !isTransientNavigationError(error) && !isDetachedNodeError(error)) throw error;
                await delay(changed() ? 0 : 50, signal); continue;
              }
              if (changed()) continue;
              if (finalLayouts.length === relaxedChecks.length && finalLayouts.every((layout, index) => relaxedChecks[index]!(layout.snapshot))) {
                // Layout computed styles omit selection/highlight and some
                // pseudo styles. Revalidate every live proof that contributed
                // a name or hid text before accepting the relaxed DOM check.
                // Per-frame AX entries share a target's complete DOM capture.
                // Revalidate that shared evidence once, not once per frame.
                const paintTargets = [...new Map(trees.map((item) => [item.snapshot, item])).values()];
                const paintChecks = await waitForCapture(Promise.all(paintTargets.map(async (item) => {
                  const used = new Map<string, SnapshotTextPaintCandidate[]>();
                  for (const candidate of item.candidates) {
                    const evidence = item.paintEvidence.get(candidate.backendNodeId);
                    if (projectTextPaint(candidate, evidence) === undefined) continue;
                    const list = used.get(candidate.frameId) ?? [];
                    list.push(candidate); used.set(candidate.frameId, list);
                  }
                  // A HEAD selector can create a first-line override where
                  // there was no live-paint candidate before. Probe currently
                  // visible text too; unmodelled document overlays refuse the
                  // relaxation rather than inheriting stale ordinary names.
                  for (const doc of styleEvidence ? item.snapshot.documents : []) {
                    const frameId = item.snapshot.strings[doc.frameId];
                    if (!capturedFrames.some((frame) => (frame.frameId ?? session.rootFrameId) === frameId
                      && sameDebuggee(frame.debuggee, item.debuggee))) continue;
                    const list = used.get(frameId) ?? [], known = new Set(list.map(({ backendNodeId }) => backendNodeId));
                    const laidOut = new Set(doc.layout.nodeIndex.filter((_: number, layoutIndex: number) =>
                      Boolean(item.snapshot.strings[doc.layout.text?.[layoutIndex]])));
                    doc.nodes.nodeType.forEach((type: number, index: number) => {
                      const backendNodeId = doc.nodes.backendNodeId[index];
                      if (type === 3 && laidOut.has(index) && item.visibility.get(backendNodeId) === true && !known.has(backendNodeId))
                        list.push({ backendNodeId, frameId });
                    });
                    if (list.length) used.set(frameId, list);
                  }
                  for (const [frameId, list] of used) {
                    const frame: FrameRefRecord = { frameId, debuggee: item.debuggee, generation, revision: frameRevision,
                      conversationId: frameContext.conversationId, runId: frameContext.runId };
                    const fresh = await this.readFrameTextPaint(session, frame, list, frameGuard);
                    for (const { backendNodeId } of list) {
                      const next = fresh.get(backendNodeId), before = item.paintEvidence.get(backendNodeId);
                      if (!next || next.documentPaintRisk || (before ? JSON.stringify(next) !== JSON.stringify(before)
                        : next.unknown || next.firstLineRisk || next.firstLetterRisk)) return false;
                    }
                  }
                  return true;
                })));
                if (changed()) continue;
                if (!paintChecks.every(Boolean)) throw automationError("snapshot-unavailable", { reason: "text-paint-unstable" });
                const geometry = await snapshotGeometry(finalLayouts);
                if (changed()) continue;
                return { ...info, lines, frameRevision, geometry, geometrySources: finalLayouts.map(({ debuggee }) => debuggee), geometryStyles: computedStyles, ...(regionNode ? { regionIdentity: JSON.stringify([regionDebuggee?.sessionId ?? "", regionFrameId, regionNode.node.backendNodeId]) } : {}) };
              }
            }
          }
          if ((retriedUnstableCapture || !onlyUnrenderedText) && onlyDynamicText) {
            let newText = false;
            for (const [key, ids] of observedDynamicText) {
              const tracked = dynamicTextByTarget.get(key) ?? new Set<number>();
              for (const id of ids) if (!tracked.has(id)) { tracked.add(id); newText = true; }
              dynamicTextByTarget.set(key, tracked);
            }
            // Re-render with the affected text and dependent names marked
            // unknown; never deliver the already rendered stale values.
            if (newText) { retryDynamicCapture(); continue; }
            if (partial) return { ...info, lines, frameRevision, geometry: await snapshotGeometry(confirmations, dynamicTextByTarget), geometrySources: confirmations.map(({ debuggee }) => debuggee), geometryStyles: computedStyles, geometryDynamicParents: dynamicTextByTarget, partial: true, ...(limitations ? { limitations } : {}), ...(regionNode ? { regionIdentity: JSON.stringify([regionDebuggee?.sessionId ?? "", regionFrameId, regionNode.node.backendNodeId]) } : {}) };
          }
          if (retriedUnstableCapture) throw automationError("snapshot-unavailable", { reason: unstablePaint ? "text-paint-unstable" : "dom-unstable" });
          retriedUnstableCapture = true;
          continue;
        }
        if (partial && speculativeDynamic) {
          // The suspected change stopped. Reacquire all text-paint and AX
          // evidence before returning a full observation with current values.
          speculativeDynamic = false;
          dynamicTextByTarget.clear();
          continue;
        }
        return { ...info, lines, frameRevision, geometry: await snapshotGeometry(confirmations, partial ? dynamicTextByTarget : undefined), geometrySources: confirmations.map(({ debuggee }) => debuggee), geometryStyles: computedStyles, ...(partial ? { partial: true as const, geometryDynamicParents: dynamicTextByTarget } : {}), ...(limitations ? { limitations } : {}), ...(regionNode ? { regionIdentity: JSON.stringify([regionDebuggee?.sessionId ?? "", regionFrameId, regionNode.node.backendNodeId]) } : {}) };
      }
    }
  }

  private async afterAction(session: Session): Promise<Record<string, unknown>> {
    // Callers have already awaited the action's acknowledgement. This separate
    // native read can disappear on navigation or self-close without undoing that
    // fact. Tab metadata is not proof of the action document's generation.
    const signal = this.context.signal;
    throwIfAborted(signal);
    try {
      const info = await this.options.chromeApi.tabs.get(session.tabId);
      throwIfAborted(signal);
      if (typeof info?.url === "string" && typeof info.title === "string")
        return { performed: true, url: info.url, title: info.title };
    } catch (error) {
      throwIfAborted(signal);
      if (error && typeof error === "object" && (
        "name" in error && (error.name === "AbortError" || error.name === "TimeoutError") ||
        "code" in error && (error.code === "timeout" || error.code === "cancelled")
      )) throw error;
    }
    return { performed: true, pageInfoStatus: { state: "unavailable" } };
  }

  private async action<T>(tabId: number, operation: string, locator: LocatorSpec | null, run: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    this.lastWait = undefined;
    this.lastAttemptLog = undefined;
    const context = this.context;
    this.options.logger?.telemetry({ type: "automation.action.started", conversationId: context.conversationId, toolCallId: context.toolCallId, ...context.logIdentity, content: { tabId, operation, locator } });
    this.activeActions.set(tabId, (this.activeActions.get(tabId) ?? 0) + 1);
    try {
      const result = await run();
      this.options.logger?.telemetry({ type: "automation.action.finished", conversationId: context.conversationId, toolCallId: context.toolCallId, ...context.logIdentity, content: { tabId, operation, locator }, output: result, latencyMs: performance.now() - startedAt });
      return result;
    } catch (error) {
      const lastWait = this.waitDiagnostic();
      const failure = error && typeof error === "object" && (error as { name?: string }).name === "TimeoutError"
        ? automationError(lastWait?.state?.receivesEvents === false ? "intercepted" : "timeout", { operation, locator, lastObservation: lastWait ?? null })
        : error;
      this.options.logger?.telemetry({
        type: "automation.action.failed",
        conversationId: context.conversationId,
        toolCallId: context.toolCallId,
        ...context.logIdentity,
        content: { tabId, operation, locator, ...(failure instanceof AutomationError ? { diagnostic: { code: failure.code, ...failure.detail } } : {}),
          ...(failure instanceof Error && "geometry" in failure ? { geometry: failure.geometry } : {}),
          ...(failure instanceof Error && "command" in failure ? { command: failure.command, parameters: (failure as any).parameters, source: (failure as any).source } : {}),
          frameGraph: [...(this.sessions.get(tabId)?.frames ?? [])].map(([frameId, source]) => ({ frameId, source, parentId: this.sessions.get(tabId)?.frameParents.get(frameId) })),
        },
        error: failure,
        latencyMs: performance.now() - startedAt,
      });
      throw failure;
    } finally {
      const remaining = (this.activeActions.get(tabId) ?? 1) - 1;
      if (remaining > 0) this.activeActions.set(tabId, remaining);
      else this.activeActions.delete(tabId);
    }
  }
}

export class PageFacade {
  constructor(private readonly runtime: AutomationRuntime, readonly tabId: number) {}
  snapshot() { return this.runtime.snapshot(this.tabId); }
  inspect(options: InspectOptions = {}, region?: LocatorFacade) {
    if (region && !LocatorFacade.belongsTo(region, this.runtime, this.tabId)) throw automationError("invalid-target", { reason: "cross-tab-region" });
    return this.runtime.inspect(this.tabId, options, region?.spec);
  }
  observe(detail: "auto" | "semantic" | "visual" = "auto", since?: string, captureOptions?: Record<string, any>) { return this.runtime.observe(this.tabId, detail, since, captureOptions); }
  ensureObservation(observationId: string) { return this.runtime.ensureObservation(this.tabId, observationId); }
  point(observationId: string, x: number, y: number, operation: "click" | "dblclick" | "hover", options?: { button?: "left" | "right" | "middle"; modifiers?: string[] }) { return this.runtime.point(this.tabId, observationId, x, y, operation, options); }
  upload(files: unknown) { return this.runtime.upload(this.tabId, files); }
  press(key: string) { return this.runtime.keyboard(this.tabId, "press", key); }
  insertText(text: string) { return this.runtime.keyboard(this.tabId, "insertText", text); }
  elementById(id: string) { return this.runtime.elementById(this.tabId, id); }
  ref(ref: string) { return this.runtime.ref(this.tabId, ref); }
  locator(value: string) { return this.runtime.locator(this.tabId, { kind: "css", value }); }
  getByRole(value: string, options: { name?: string; exact?: boolean } = {}) { return this.runtime.locator(this.tabId, { kind: "role", value, ...options }); }
  getByText(value: string, options: { exact?: boolean } = {}) { return this.runtime.locator(this.tabId, { kind: "text", value, ...options }); }
  getByLabel(value: string, options: { exact?: boolean } = {}) { return this.runtime.locator(this.tabId, { kind: "label", value, ...options }); }
  getByPlaceholder(value: string, options: { exact?: boolean } = {}) { return this.runtime.locator(this.tabId, { kind: "placeholder", value, ...options }); }
  getByAltText(value: string, options: { exact?: boolean } = {}) { return this.runtime.locator(this.tabId, { kind: "alt", value, ...options }); }
  getByTitle(value: string, options: { exact?: boolean } = {}) { return this.runtime.locator(this.tabId, { kind: "title", value, ...options }); }
  getByTestId(value: string) { return this.runtime.locator(this.tabId, { kind: "testId", value, exact: true }); }
  frameLocator(value: string) { return this.runtime.locator(this.tabId, { kind: "frame", value }); }
  frameRef(value: string) { return this.runtime.locator(this.tabId, { kind: "frameRef", value }); }
  goto(url: string) { return this.runtime.navigate(this.tabId, "Page.navigate", { url }); }
  reload() { return this.runtime.navigate(this.tabId, "Page.reload"); }
  goBack() { return this.runtime.history(this.tabId, -1); }
  goForward() { return this.runtime.history(this.tabId, 1); }
  url() { return this.runtime.pageValue(this.tabId, "location.href"); }
  title() { return this.runtime.pageValue(this.tabId, "document.title"); }
  waitForURL(value: string | RegExp) { return this.runtime.waitUntil(() => this.url().then((url) => typeof value === "string" ? String(url).includes(value) : value.test(String(url)))); }
  waitForLoadState(state: "domcontentloaded" | "load" = "load") { return this.runtime.waitForLoadState(this.tabId, state); }
  waitForEvent(kind: "dialog" | "popup" | "download" | "filechooser") { return this.runtime.waitForEvent(this.tabId, kind); }
  evaluate(fn: ((arg?: unknown) => unknown) | string, arg?: unknown) { return this.runtime.evaluatePage(this.tabId, typeof fn === "function" ? String(fn) : fn, arg); }
}

export class LocatorFacade {
  constructor(private readonly runtime: AutomationRuntime, readonly tabId: number, readonly spec: LocatorSpec) {}
  static belongsTo(locator: unknown, runtime: AutomationRuntime, tabId: number): locator is LocatorFacade {
    return locator instanceof LocatorFacade && locator.runtime === runtime && locator.tabId === tabId;
  }
  private chain(query: Query) { const spec = flushLocator(this.spec); return new LocatorFacade(this.runtime, this.tabId, { ...spec, queries: [...spec.queries, query] }); }
  locator(value: string) { return this.chain({ kind: "css", value }); }
  uniqueScope() { return this.chain({ kind: "uniqueScope", value: "" }); }
  frameLocator(value: string) { return this.chain({ kind: "frame", value }); }
  getByRole(value: string, options: { name?: string; exact?: boolean } = {}) { return this.chain({ kind: "role", value, ...options }); }
  getByText(value: string, options: { exact?: boolean } = {}) { return this.chain({ kind: "text", value, ...options }); }
  getByLabel(value: string, options: { exact?: boolean } = {}) { return this.chain({ kind: "label", value, ...options }); }
  getByPlaceholder(value: string, options: { exact?: boolean } = {}) { return this.chain({ kind: "placeholder", value, ...options }); }
  getByAltText(value: string, options: { exact?: boolean } = {}) { return this.chain({ kind: "alt", value, ...options }); }
  getByTitle(value: string, options: { exact?: boolean } = {}) { return this.chain({ kind: "title", value, ...options }); }
  getByTestId(value: string) { return this.chain({ kind: "testId", value, exact: true }); }
  filter(options: { hasText?: string; has?: LocatorFacade }) {
    if (options.has && (options.has.tabId !== this.tabId || options.has.runtime !== this.runtime)) throw automationError("invalid-target", { reason: "cross-tab-filter" });
    return new LocatorFacade(this.runtime, this.tabId, { ...flushLocator(this.spec), hasText: options.hasText, has: options.has?.spec });
  }
  first() { return this.nth(0); }
  last() { return this.nth(-1); }
  nth(index: number) { return new LocatorFacade(this.runtime, this.tabId, { ...flushLocator(this.spec), index }); }
  count() { return this.run("count"); }
  readCondition(condition: "text" | "value" | "visible" | "enabled" | "editable" | "checked") { return this.run("readCondition", condition); }
  readElements(options: { offset?: number; limit?: number; attributes?: string[] } = {}) { return this.run("readElements", options); }
  waitFor(options: { state?: WaitState } = {}) { return this.run("waitFor", options); }
  click(options?: { button?: "left" | "right" | "middle"; modifiers?: string[] }) { return this.run("click", options); }
  dblclick(options?: { button?: "left" | "right" | "middle"; modifiers?: string[] }) { return this.run("dblclick", options); }
  hover() { return this.run("hover"); }
  fill(value: string) { return this.run("fill", value); }
  clear() { return this.run("clear"); }
  press(key: string) { return this.run("press", key); }
  pressSequentially(text: string) { return this.run("pressSequentially", text); }
  check() { return this.run("check"); }
  uncheck() { return this.run("uncheck"); }
  selectOption(value: string | string[]) { return this.run("selectOption", value); }
  dragTo(target: LocatorFacade) { return this.run("dragTo", target); }
  setInputFiles(files: unknown) { return this.run("setInputFiles", files); }
  focus() { return this.run("focus"); }
  blur() { return this.run("blur"); }
  scrollIntoViewIfNeeded() { return this.run("scrollIntoViewIfNeeded"); }
  textContent() { return this.run("textContent"); }
  innerText() { return this.run("innerText"); }
  inputValue() { return this.run("inputValue"); }
  getAttribute(name: string) { return this.run("getAttribute", name); }
  isVisible() { return this.run("isVisible"); }
  isEnabled() { return this.run("isEnabled"); }
  isChecked() { return this.run("isChecked"); }
  /** Internal one-shot resolution; the public evaluate method retains its waiting contract. */
  evaluateImmediate(fn: string, arg?: unknown) { return this.run("evaluateImmediate", fn, arg); }
  evaluate(fn: ((element: Element, arg?: unknown) => unknown) | string, arg?: unknown) { return this.run("evaluate", fn, arg); }
  private run(operation: string, ...args: unknown[]) { return this.runtime.locatorValue(this.tabId, this.spec, operation, args); }
}

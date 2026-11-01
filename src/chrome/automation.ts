import type { EventLogger } from "../logging";
import { createLogGraphCodec, decodeLogGraph, encodeLogGraph } from "../log-graph";
import { waitForDocumentFrame } from "./dom-frame";
import { abortError, axValue, delay, imageSize, isTransientNavigationError, keyboardParams, modifierMask, parseKeyboardChord, throwIfAborted } from "./automation-utils";
import { diffSnapshot, paginateSnapshot, type SnapshotItem, type SnapshotPosition } from "./snapshot-pagination";
import { snapshotLookahead } from "./snapshot-lookahead";
import { selectSnapshotWirePage, SnapshotWireError, SNAPSHOT_DELIVERY_COMMIT, type SnapshotDeliveryLease, type SnapshotWirePage } from "./snapshot-wire";
import { renderSnapshotNode, type SnapshotNode, type SnapshotStateName } from "./snapshot-render";
import { stitchSnapshotFrames, type SnapshotLine } from "./snapshot-frame-tree";
import { snapshotDomSupplement, type SnapshotDomEvidence } from "./snapshot-dom";
import { createSnapshotDomIndex } from "./snapshot-dom-index";
import { snapshotRenderOrder } from "./snapshot-render-order";
import { snapshotSlottedNodes } from "./snapshot-slot-index";
import { sameDOMSnapshot } from "./snapshot-consistency";
import { SNAPSHOT_COMPUTED_STYLES, snapshotVisibility, type SnapshotTextPaintCandidate } from "./snapshot-visibility";
import { projectTextPaint, sameTextPaintCandidates, TEXT_PAINT_CACHE_LOOKUP_SOURCE, TEXT_PAINT_CACHE_REGISTER_SOURCE, type TextPaintEvidence } from "./snapshot-text-paint";
import { axEllipsisCandidate, confirmAxEllipsis, type AxEllipsisCandidate } from "./snapshot-ax-ellipsis";
import { AX_ELLIPSIS_GEOMETRY_SOURCE } from "./snapshot-ellipsis-geometry";
import { PLACEHOLDER_EVIDENCE_SOURCE, samePlaceholderEvidence, type PlaceholderEvidence } from "./snapshot-placeholder";
import { FRAME_OWNER_FULLY_VISIBLE_SOURCE } from "./snapshot-frame-containment";
import { createFrameHandle } from "./snapshot-frame-handle";
import { createFrameVisibility } from "./frame-visibility";
import { PROGRAM_EVENT_INVOKE } from "./program-handles";

const EVALUATION_CODEC_FACTORY = `(${createLogGraphCodec.toString()})({ verifyIntrinsics: true })`;

type Debuggee = chrome.debugger.Debuggee & { sessionId?: string };
type Command = (debuggee: Debuggee, method: string, params?: object) => Promise<any>;
type RunContext = { signal?: AbortSignal; conversationId?: string; runId?: string; toolCallId?: string; logIdentity?: { runId?: string; toolCallId: string; toolCallIdCanonical: true } };
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
type RefRecord = { backendNodeId: number; frameId?: string; debuggee: Debuggee; role: string; name: string; generation: number; identitySource: "ax" | "dom" };
type FrameRefRecord = { frameId: string; debuggee: Debuggee; generation: number; revision: number; conversationId?: string; runId?: string };
type FrameDocument = { session: Session; frame: FrameRefRecord; promise: Promise<string>; objectId?: string; executionContextId?: number;
  paintCacheToken: string; paintCacheWarm?: boolean; paintCacheTail?: Promise<void>; backendNodeId?: number };
type FrameListSnapshot = { id: string; session: Session; generation: number; revision: number; conversationId?: string; runId?: string; frames: Array<Record<string, unknown>> };
type InspectSnapshot = {
  id: string; session: Session; generation: number; frameRevision: number; conversationId?: string; runId?: string;
  record: ObservationRecord; source: SnapshotItem[]; mode: "full" | "delta"; reset?: string;
  expected?: SnapshotPosition; eligibleForBaseline: boolean; delivery?: symbol;
};
export type FindOptions = { cursor?: string; limit?: number };
type SearchSnapshot = {
  id: string; tabId: number; generation: number; session: Session; key: string;
  conversationId?: string; runId?: string; debuggee: Debuggee; total: number;
  candidates?: Candidate[]; arrayId?: string; group?: string;
};
export type InspectOptions = { cursor?: string; since?: string; fields?: Array<"text" | "state" | "ref" | "actions">; budget?: number; offset?: number; limit?: number; depth?: number; recentRefs?: readonly string[]; wire?: { maxBytes: number; evidenceId: string }; deferDelivery?: boolean };
type ObservationRecord = {
  session: Session;
  observationId: string;
  tabId: number;
  documentId: number;
  url: string;
  title: string;
  lines: SnapshotLine[];
  viewport: { x: number; y: number; width: number; height: number; scale: number };
  image?: { width: number; height: number; scale: number; origin?: { x: number; y: number } };
  scopeKey?: string;
  regionIdentity?: string;
  incomplete?: boolean;
};
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
  return new AutomationError(code, detail);
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
  const visibleText = el => normalize(el.innerText === undefined ? el.textContent : el.innerText);
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
    const equal = (actual, expected) => query.exact ? normalize(actual) === normalize(expected) : normalize(actual).toLowerCase().includes(normalize(expected).toLowerCase());
    if (query.kind === "role") return roleOf(el) === query.value && (!query.name || equal(nameOf(el), query.name));
    if (query.kind === "text") return equal(visibleText(el), query.value) && ![...el.children].some(child => equal(visibleText(child), query.value));
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
        if (item.hasText !== undefined) current = current.filter(el => visibleText(el).toLowerCase().includes(normalize(item.hasText).toLowerCase()));
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
    if (locator.hasText) current = current.filter(el => visibleText(el).toLowerCase().includes(normalize(locator.hasText).toLowerCase()));
    if (locator.has) current = current.filter(el => resolve(el, locator.has).length > 0);
    if (locator.index !== undefined) { const index = locator.index < 0 ? current.length + locator.index : locator.index; current = index >= 0 && index < current.length ? [current[index]] : []; }
    return [...new Set(current)];
  };
  const result = resolve(rootDocument || document, spec);
  if (metadata === "nodes") return result;
  if (!metadata) return result[0] || null;
  return result.map(el => ({ role: roleOf(el), name: nameOf(el), tag: el.tagName.toLowerCase(), text: visibleText(el).slice(0, 120) }));
}`;

const SEARCH_META_SOURCE = String.raw`function(includeIdentity) {
  const el = this;
  const normalize = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const role = el.getAttribute("role") || ({
    A: el.hasAttribute("href") ? "link" : "generic", BUTTON:"button", SELECT:"combobox", TEXTAREA:"textbox", OPTION:"option", IMG:"img", SUMMARY:"button", FORM:"form", TABLE:"table", TR:"row", TD:"cell", TH:"columnheader",
    H1:"heading", H2:"heading", H3:"heading", H4:"heading", H5:"heading", H6:"heading", NAV:"navigation", MAIN:"main", ARTICLE:"article", ASIDE:"complementary", FOOTER:"contentinfo", HEADER:"banner", UL:"list", OL:"list", LI:"listitem", DIALOG:"dialog", PROGRESS:"progressbar"
  }[el.tagName] || (el.tagName === "INPUT" ? ({checkbox:"checkbox",radio:"radio",range:"slider",number:"spinbutton",search:"searchbox",button:"button",submit:"button",reset:"button"}[el.type] || "textbox") : "generic"));
  const name = normalize(el.getAttribute("aria-label") || (() => { const ids = el.getAttribute("aria-labelledby"); return ids && ids.split(/\s+/).map(id => el.getRootNode().getElementById?.(id)?.textContent || "").join(" "); })() || (el.labels ? [...el.labels].map(label => label.textContent).join(" ") : "") || el.getAttribute("alt") || el.getAttribute("title") || el.textContent || el.value);
  const text = normalize(el.innerText === undefined ? el.textContent : el.innerText);
  const identityTooLarge = String(role).length + name.length > 2_000_000;
  return { connected: el.isConnected, role: String(role).slice(0, 80), name: name.slice(0, 160), ...(includeIdentity ? identityTooLarge ? { identityTooLarge: true } : { identityRole: String(role), identityName: name } : {}), text: text.slice(0, 120), tag: el.tagName.toLowerCase(),
    ...(String(role).length > 80 ? {roleTruncated:true} : {}), ...(name.length > 160 ? {nameTruncated:true} : {}), ...(text.length > 120 ? {textTruncated:true} : {}) };
}`;

export class AutomationRuntime {
  private readonly sessions = new Map<number, Session>();
  private readonly activeActions = new Map<number, number>();
  private readonly objectDebuggees = new Map<string, Debuggee>();
  private context: RunContext = {};
  private readonly waiters = new Map<number, Map<string, Set<Waiter>>>();
  private lastWait?: { locator: LocatorSpec; state?: ElementState; matches?: number; candidates?: Candidate[]; documentId: number; reason: string; attempt: number };
  private lastAttemptLog?: { reason: string; at: number };
  private readonly observations = new Map<string, ObservationRecord>();
  private readonly inspectionSnapshots = new Map<string, InspectSnapshot>();
  private readonly axRoots = new Map<string, number>();
  private readonly fileChoosers = new Map<number, FileChooserRecord>();
  private readonly searches = new Map<string, SearchSnapshot>();
  private readonly frameLists = new Map<string, FrameListSnapshot>();
  private readonly frameDocuments = new Map<string, FrameDocument>();

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
            const result = await this.options.command(debuggee, "Runtime.callFunctionOn", {
              objectId, arguments: [{ objectId: resolved.object.objectId }], returnByValue: true,
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
  hasSession(tabId: number): boolean { return this.sessions.has(tabId); }
  sessionIdentity(tabId: number): object | undefined { return this.sessions.get(tabId); }
  async clearContext(): Promise<void> {
    this.context = {};
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
    if (!session.frames.get(frameId)?.sessionId || session.frames.get(frameId)?.sessionId === source.sessionId)
      session.frames.set(frameId, source);
    const parentId = tree.frame.parentId ?? parent ?? session.frameParents.get(frameId);
    if (parentId !== undefined || !source.sessionId) session.frameParents.set(frameId, parentId);
    if (parentId === undefined && !source.sessionId) session.rootFrameId = frameId;
    for (const child of tree.childFrames ?? []) this.recordFrameTree(session, source, child, frameId);
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
      if (!session.frames.get(params.frame.id)?.sessionId || source.sessionId === session.frames.get(params.frame.id)?.sessionId) session.frames.set(params.frame.id, source);
      const parentId = params.frame.parentId ?? session.frameParents.get(params.frame.id);
      session.frameParents.set(params.frame.id, parentId);
      if (!parentId && !source.sessionId) session.rootFrameId = params.frame.id;
      this.invalidate(session, preserveChooser);
    }
    if (method === "Page.navigatedWithinDocument" && session) {
      // History/hash navigation invalidates snapshots, but retains the same
      // input node and therefore must not discard an open file chooser.
      this.invalidate(session, true);
    }
    if ((method === "DOM.documentUpdated" || method === "Runtime.executionContextsCleared") && session) {
      this.invalidate(session, preserveChooser);
    }
    if (method === "Runtime.executionContextDestroyed" && session) this.clearFrameDocuments(tabId!, source);
    if (method === "Page.frameDetached" && params?.frameId && session) {
      const current = session.frames.get(params.frameId);
      // A swap detaches the old renderer's view of the frame, not the frame
      // itself. An attachment from the new target can arrive first; do not
      // remove its mapping when the old target reports its delayed swap.
      const transferred = params.reason === "swap" && current?.sessionId && current.sessionId !== source.sessionId;
      if (!transferred) session.frames.delete(params.frameId);
      // Keep ancestry across a process swap, including when attach arrives
      // after detach and the new target's frame-tree root has no parentId.
      if (params.reason !== "swap") session.frameParents.delete(params.frameId);
      this.invalidate(session, preserveChooser);
    }
    if (method === "Target.detachedFromTarget" && params?.sessionId && session) {
      this.retireFrameSession(session, params.sessionId);
      this.invalidate(session, preserveChooser);
    }
    if (session && session.lifecycleCutoff !== undefined && session.rootFrameId !== undefined && !source.sessionId && method === "Page.lifecycleEvent" && params?.frameId === session.rootFrameId
      && typeof params.loaderId === "string" && typeof params.timestamp === "number" && Number.isFinite(params.timestamp) && params.timestamp > session.lifecycleCutoff) {
      const current = session.rootLifecycle;
      if (params.name === "init") {
        // document.open() reuses the loader and Document. Its init is the
        // only observed boundary separating old lifecycle events from new.
        if (!current || params.timestamp > current.initializedAt) {
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
        session.frames.delete(frameId);
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
    // Document references still expire, but a child navigation must not
    // rename unrelated frames. Retire scopes no longer represented by the
    // current frame/target graph and never recycle their numbers.
    const activeScopes = new Set([...session.frames].map(([frameId, debuggee]) => JSON.stringify([frameId, debuggee.sessionId ?? null])));
    if (session.rootFrameId) activeScopes.add(JSON.stringify([session.rootFrameId, null]));
    for (const key of session.snapshotScopes.keys()) if (!activeScopes.has(key)) session.snapshotScopes.delete(key);
    this.invalidateFrames(session);
    this.clearSearches(session.tabId);
    this.clearInspections(session.tabId);
    session.refs.clear();
    session.refsByNode.clear();
    session.refUsage.clear();
    session.lastSnapshot = undefined;
    this.objectDebuggees.clear();
    this.axRoots.clear();
    if (!preserveChooser) this.fileChoosers.delete(session.tabId);
  }

  handleDetach(source: Debuggee): void {
    if (Number.isInteger(source.tabId)) {
      this.clearSearches(source.tabId!);
      this.clearInspections(source.tabId!);
      const session = this.sessions.get(source.tabId!);
      if (session) this.invalidateFrames(session);
      this.sessions.delete(source.tabId!);
      session?.lifetime.abort();
    }
  }

  async abortSessions(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.frameLists.clear();
    this.clearFrameDocuments();
    this.sessions.clear();
    for (const session of sessions) session.lifetime.abort();
    this.clearSearches();
    this.objectDebuggees.clear();
    this.observations.clear();
    this.inspectionSnapshots.clear();
    this.fileChoosers.clear();
    this.axRoots.clear();
    for (const events of this.waiters.values()) for (const waiters of events.values()) for (const waiter of waiters) waiter.reject(abortError());
    this.waiters.clear();
    await Promise.all(sessions.map(async (session) => {
      await this.options.command(session.debuggee, "Input.cancelDragging", {}).catch(() => undefined);
      await this.options.detach(session.debuggee).catch(() => undefined);
    }));
  }

  dispose(): void { void this.abortSessions(); }

  locator(tabId: number, query: Query): LocatorFacade { return new LocatorFacade(this, tabId, { queries: [query] }); }
  ref(tabId: number, ref: string): LocatorFacade { return new LocatorFacade(this, tabId, { queries: [], ref }); }

  async snapshot(tabId: number): Promise<{ url: string; title: string; snapshot: string }> {
    return this.action(tabId, "snapshot", null, async () => {
      const session = await this.session(tabId);
      this.pruneRefs(session);
      const captured = await this.captureSnapshot(session);
      session.lastSnapshot = captured.lines;
      return { url: captured.url, title: captured.title, documentId: session.generation, snapshot: captured.lines.map(({ line }) => line).join("\n") };
    });
  }

  async observe(tabId: number, detail: "auto" | "semantic" | "visual" = "auto", since?: string, captureOptions: Record<string, any> = {}): Promise<Record<string, unknown>> {
    return this.action(tabId, "observe", null, async () => {
      const session = await this.session(tabId);
      this.pruneRefs(session);
      const generation = session.generation;
      const captured = await this.captureSnapshot(session);
      const viewport = await this.pageValue(tabId, "({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight,scale:devicePixelRatio})") as ObservationRecord["viewport"];
      const observationId = globalThis.crypto.randomUUID();
      const previous = since ? this.observations.get(since) : undefined;
      if (since && (!previous || previous.session !== session || previous.tabId !== tabId || previous.documentId !== session.generation)) {
        throw automationError("stale-observation", { observationId: since, reason: "expired-document" });
      }
      const record: ObservationRecord = { session, observationId, tabId, documentId: session.generation, ...captured, viewport };
      session.lastSnapshot = captured.lines;
      const before = new Map(previous?.lines.map((item) => [item.id, item.line]));
      const after = new Map(captured.lines.map((item) => [item.id, item.line]));
      const changes = previous ? {
        added: captured.lines.filter(({ id }) => !before.has(id)).map(({ line }) => line),
        removed: previous.lines.filter(({ id }) => !after.has(id)).map(({ line }) => line),
        updated: captured.lines.flatMap(({ id, line }) => before.has(id) && before.get(id) !== line ? [{ before: before.get(id), after: line }] : []),
      } : undefined;
      const result: Record<string, unknown> = {
        observationId, documentId: session.generation, url: captured.url, title: captured.title, viewport,
        snapshot: captured.lines.map(({ line }) => line).join("\n"), ...(changes ? { changes } : {}),
      };
      if (detail === "visual" || detail === "auto" && !captured.lines.some(({ ref }) => Boolean(ref))) {
        const screenshot = await this.options.command(session.debuggee, "Page.captureScreenshot", {
          format: "jpeg", quality: 70, fromSurface: true, captureBeyondViewport: false, ...captureOptions,
        });
        const clip = captureOptions.clip;
        const size = typeof screenshot.data === "string" ? imageSize(screenshot.data, captureOptions.format ?? "jpeg") : undefined;
        const width = clip?.width ?? viewport.width; const height = clip?.height ?? viewport.height;
        const scale = size?.width && width ? size.width / width : (clip?.scale ?? viewport.scale);
        const image = { width: size?.width ?? width * scale, height: size?.height ?? height * scale, scale, origin: { x: clip ? clip.x - viewport.x : 0, y: clip ? clip.y - viewport.y : 0 } };
        record.image = image;
        result.screenshot = { mediaType: `image/${captureOptions.format ?? "jpeg"}`, data: screenshot.data, ...image };
      }
      if (generation !== session.generation) throw automationError("stale-observation", { reason: "document-changed-during-observation" });
      this.rememberObservation(record);
      return result;
    });
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
      const generation = session.generation;
      const signal = this.context.signal;
      const conversationId = this.context.conversationId, runId = this.context.logIdentity?.runId ?? this.context.runId;
      const guard = () => {
        throwIfAborted(signal);
        if (this.sessions.get(tabId) !== session || session.generation !== generation) throw automationError("stale-observation", { reason: "document-or-session-changed" });
      };
      guard();
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
        this.rememberObservation(saved.record);
        position = { index: Number(match[2]), charOffset: Number(match[3]) };
        this.inspectionSnapshots.delete(saved.id); this.inspectionSnapshots.set(saved.id, saved);
      } else {
        const fields = options.fields ?? ["text", "state", "ref"];
        const scopeKey = JSON.stringify([region ?? null, fields, options.depth ?? null]);
        const previous = options.since ? this.observations.get(options.since) : undefined;
        if (options.since && (!previous || previous.session !== session || previous.tabId !== tabId || previous.documentId !== generation || previous.scopeKey !== scopeKey))
          throw automationError("stale-observation", { observationId: options.since, reason: "document-or-scope-changed" });
        const captured = await this.captureSnapshot(session, region);
        guard();
        if (captured.frameRevision !== session.frameRevision) throw automationError("stale-observation", { reason: "frame-tree-changed-during-inspection" });
        if (previous && previous.documentId !== session.generation) throw automationError("stale-observation", { observationId: options.since, reason: "document-changed-during-inspection" });
        if (previous && previous.regionIdentity !== captured.regionIdentity) throw automationError("stale-observation", { observationId: options.since, reason: "region-identity-changed" });
        const lines: SnapshotLine[] = captured.lines.filter(({ node, line }) => options.depth === undefined || (node?.depth ?? (line.match(/^ */)?.[0].length ?? 0) / 2) <= options.depth)
          .map(({ id, line, node }) => {
            if (!node) return { id, line };
            const owned = node.ref ? `t${tabId}s${session.token}d${generation}${node.ref}` : undefined;
            const refRecord = node.ref ? session.refs.get(node.ref) : undefined;
            if (owned && refRecord) session.refs.set(owned, refRecord);
            const rendered = renderSnapshotNode({ ...node, ...(owned ? { ref: owned } : {}) }, { fields, actionNames: "program", inlineRef: false });
            return { id, line: rendered.line, ...(rendered.ref ? { ref: rendered.ref } : {}) };
          });
        const viewport = await this.pageValue(tabId, "({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight,scale:devicePixelRatio})") as ObservationRecord["viewport"];
        guard();
        if (captured.frameRevision !== session.frameRevision) throw automationError("stale-observation", { reason: "frame-tree-changed-during-inspection" });
        const observationId = crypto.randomUUID();
        const baseline = previous && !previous.incomplete ? previous : undefined;
        const changes = baseline ? diffSnapshot(baseline.lines, lines) : undefined;
        const source = changes ?? lines;
        const index = options.offset ?? 0;
        if (!Number.isSafeInteger(index) || index < 0 || index > source.length) throw automationError("invalid-offset", { offset: index, total: source.length });
        position = { index, charOffset: 0 };
        const record: ObservationRecord = { session, observationId, tabId, documentId: generation, ...captured, lines, viewport, scopeKey, incomplete: true };
        this.rememberObservation(record);
        saved = { id: observationId, session, generation, frameRevision: captured.frameRevision, conversationId, runId, record, source, mode: changes ? "delta" : "full",
          ...(previous?.incomplete ? { reset: "previous-output-truncated" } : {}), expected: position, eligibleForBaseline: index === 0 };
        this.inspectionSnapshots.set(saved.id, saved);
        while (this.inspectionSnapshots.size > 32) this.inspectionSnapshots.delete(this.inspectionSnapshots.keys().next().value!);
      }
      guard();
      const budget = options.budget ?? 12000;
      const advances = Boolean(saved.expected && saved.expected.index === position.index && saved.expected.charOffset === position.charOffset);
      const envelope = (candidate: SnapshotWirePage): Record<string, unknown> => {
        const { page } = candidate;
        const truncated = position.index > 0 || position.charOffset > 0 || page.hasMore;
        const reason = page.reason === "budget" ? "budget" : "slice";
        const baselineComplete = !saved.record.incomplete || advances && !page.hasMore && saved.eligibleForBaseline;
        return { observationId: saved.id, tabId, documentId: generation,
          ...(options.cursor === undefined ? { url: saved.record.url, title: saved.record.title } : { continuation: true }), viewport: saved.record.viewport,
          mode: saved.mode, ...(saved.reset ? { reset: saved.reset } : {}),
          items: page.fragments, ...(candidate.lookahead ? { lookahead: candidate.lookahead } : {}),
          ...(page.next ? { nextCursor: `${saved.id}:${page.next.index}:${page.next.charOffset}` } : {}),
          truncation: { truncated, total: saved.source.length, returned: page.fragments.length, offset: position.index, charOffset: position.charOffset,
            nextOffset: page.next?.index ?? saved.source.length, nextCharOffset: page.next?.charOffset ?? 0, budget: candidate.budget, used: page.usedBytes,
            ...(candidate.combinedBytes === undefined ? {} : { withLookahead: candidate.combinedBytes }),
            ...(truncated ? { reason, baselineComplete, ...(page.requiredBudget === undefined ? {} : { requiredBudget: page.requiredBudget }) }
              : { baselineComplete }) } };
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
      if (page.fragments.some((item) => item.ref && !session.refs.has(item.ref)))
        throw automationError("stale-observation", { observationId: saved.id, reason: "reference-identity-changed" });
      for (const item of page.fragments) if (item.ref) this.touchRef(session, item.ref);
      const result = envelope(candidate);
      const source = saved.source, record = saved.record;
      const valid = () => this.sessions.get(tabId) === session && session.generation === generation
        && session.frameRevision === saved.frameRevision && this.inspectionSnapshots.get(saved.id) === saved
        && this.observations.get(saved.id) === record && saved.source === source && saved.record === record
        && saved.conversationId === conversationId && saved.runId === runId
        && !page.fragments.some((item) => item.ref && !session.refs.has(item.ref));
      const atPosition = () => Boolean(saved.expected && saved.expected.index === position.index && saved.expected.charOffset === position.charOffset);
      const advance = () => { saved.expected = page.next; if (!page.hasMore && saved.eligibleForBaseline) record.incomplete = false; };
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
      if (operation === "readCondition") {
        const condition = args[0];
        if (!["text", "value", "visible", "enabled", "editable", "checked"].includes(String(condition))) throw automationError("invalid-condition", { condition });
        const objectId = await this.resolveConditionTarget(session, spec);
        if (!objectId) return { present: false, actual: null };
        const observation = await this.callOn(this.objectSession(session, objectId), objectId, `function(condition) {
          if (!this.isConnected) return { present: false, actual: null };
          let actual, invalidChecked = false;
          if (condition === "text") actual = typeof this.innerText === "string" ? this.innerText : null;
          else if (condition === "value") actual = typeof this.value === "string" ? this.value : null;
          else if (condition === "visible") {
            const rect = this.getBoundingClientRect(), style = getComputedStyle(this);
            actual = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
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
        }`, [condition]);
        if (!observation || typeof observation.present !== "boolean" || !Object.hasOwn(observation, "actual"))
          throw automationError("state-unavailable", { reason: "invalid-condition-observation" });
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
        const property = operation === "inputValue" ? "value" : operation;
        return this.callOn(targetSession, objectId, `function(name){ return name === "getAttribute" ? this.getAttribute(arguments[1]) : this[name]; }`, [property, args[0]]);
      }
      if (operation === "evaluate") {
        const objectId = await this.resolveOne(session, spec);
        const targetSession = this.objectSession(session, objectId);
        const source = typeof args[0] === "function" ? String(args[0]) : String(args[0]);
        const input = encodeLogGraph(args[1]);
        const declaration = `function(input) {
          const codec = ${EVALUATION_CODEC_FACTORY};
          return (async () => codec.encodeLogGraph(await (\n${source}\n)(this, codec.decodeLogGraph(input))))();
        }`;
        await this.options.onDispatch?.();
        return decodeLogGraph(await this.callOn(targetSession, objectId, declaration, [input]));
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
        const { objectId, targetSession } = await this.waitActionableLocator(session, spec, operation === "pressSequentially", false, false, operation === "pressSequentially", operation === "press");
        if (operation === "pressSequentially") {
          const kind = await this.callOn(targetSession, objectId, TEXT_INPUT_KIND_SOURCE);
          if (kind === "detached") throw automationError("detached", { reason: "editable-target-removed" });
          if (kind !== "text") throw automationError("invalid-editable-target", { reason: STRUCTURED_INPUT_TYPES.has(kind) ? "use-fill-for-structured-input" : "not-a-text-input" });
        }
        await this.withFocusedTarget(targetSession, objectId, operationSignal, async (assertFocus, backendNodeId) => {
          if (operation === "pressSequentially") {
            for (const character of String(args[0] ?? "")) { await assertFocus(); await this.options.command(targetSession.debuggee, "Input.insertText", { text: character, surfWaxTargetBackendNodeId: backendNodeId }); }
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
        } else objectId = await this.resolveOne(session, spec);
        const targetSession = this.objectSession(session, objectId);
        const requested = Array.isArray(args[0]) ? args[0] : [args[0]];
        for (const file of requested as any[]) {
          if (!file || typeof file !== "object" || typeof file.name !== "string" || !("text" in file || "base64" in file || "url" in file) || "path" in file) {
            throw new Error("setInputFiles accepts { name, mimeType?, text | base64 | url }; local paths are not supported.");
          }
        }
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
      const objectId = await this.resolveOne(session, spec);
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
        frames: new Map(),
        frameReady: new Map(),
        frameParents: new Map(),
        targetParents: new Map(),
        targetSessions: new Map(),
        retiredTargetSessions: new Set(),
        frameRevision: 0,
        frameRefs: new Map(),
        frameRefsById: new Map(),
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
      const runId = this.context.logIdentity?.runId;
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
            const item = session.refs.get(locator.spec.ref);
            if (!item || item.generation !== generation) throw automationError("stale-ref", { ref: locator.spec.ref, reason: "expired-document" });
            debuggee = item.debuggee;
            snapshot = { id, tabId, generation, session, key, conversationId, runId, debuggee, total: 1,
              candidates: [{ backendNodeId: item.backendNodeId, role: item.role, name: item.name, debuggee, ref: locator.spec.ref }], group };
          } else {
            const scoped = await this.locatorScope(session, locator.spec);
            try {
            guard(); debuggee = scoped.debuggee;
            if ((!scoped.rootIsElement && this.usesNativeAccessibility(scoped.spec)) || this.hasSemanticQueries(scoped.spec)) {
              const matches: Candidate[] = !scoped.rootIsElement && this.usesNativeAccessibility(scoped.spec)
                ? await this.resolveAccessibility(debuggee, scoped.spec, scoped.rootObjectId)
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
              snapshot = { id, tabId, generation, session, key, conversationId, runId, debuggee, total: candidates.length, candidates, group };
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
              snapshot = { id, tabId, generation, session, key, conversationId, runId, debuggee, total, arrayId, group };
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
          const properties = await this.options.command(current.debuggee, "Runtime.getProperties", { objectId: sliceId, ownProperties: true });
          pageGuard();
          const byIndex = new Map((properties.result ?? []).filter((property: any) => /^(0|[1-9]\d*)$/.test(property.name)).map((property: any) => [Number(property.name), property.value?.objectId]));
          objects = Array.from({ length: end - offset }, (_, index) => ({ objectId: byIndex.get(index) as string | undefined }));
        }
        const results = await Promise.allSettled(objects.map(async ({ objectId, candidate }) => {
          pageGuard();
          let nodeObject = objectId;
          if (candidate) {
            if (candidate.identityUnavailable) return { status: "identity-unknown", reason: "identity-budget" };
            if (!candidate.backendNodeId) return { status: "detached" };
            try {
              if (candidate.ref) nodeObject = (await this.resolveRef(session, candidate.ref)).objectId;
              else {
                const resolved = await this.options.command(current.debuggee, "DOM.resolveNode", { backendNodeId: candidate.backendNodeId, objectGroup: current.group });
                nodeObject = resolved.object?.objectId;
              }
            } catch (error) { pageGuard(); if (isDetachedNodeError(error)) return { status: "detached" }; throw error; }
          }
          if (!nodeObject) throw automationError("search-unavailable", { reason: "missing-node-object" });
          temporary.add(nodeObject);
          const description = await this.options.command(current.debuggee, "Runtime.callFunctionOn", { objectId: nodeObject,
            functionDeclaration: SEARCH_META_SOURCE, arguments: [{ value: !candidate }], returnByValue: true });
          pageGuard();
          if (description.exceptionDetails) throw new Error(description.exceptionDetails.exception?.description || description.exceptionDetails.text);
          const metadata = description.result?.value;
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
          const roleText = String(candidate?.role ?? metadata.role ?? "");
          const nameText = String(candidate?.name ?? metadata.name ?? "");
          const role = roleText.slice(0, 80), name = nameText.slice(0, 160);
          const scope = current.debuggee.sessionId ?? session.rootFrameId ?? "root";
          const identity = `${scope}:${backendNodeId}`;
          const short = candidate?.ref ? candidate.ref.replace(/^t\d+s[a-f0-9]+d\d+/, "") : this.rememberRef(session, identity,
            { backendNodeId: backendNodeId!, debuggee: current.debuggee, role: identityRole, name: identityName, generation, identitySource });
          const ref = `t${tabId}s${session.token}d${generation}${short}`;
          const record = session.refs.get(short);
          if (!record) throw automationError("stale-ref", { ref, reason: "expired-document" });
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
        const hasMore = end < current.total;
        if (!hasMore && options.cursor === undefined) this.releaseSearch(current);
        return { tabId, documentId: generation, total: current.total, elements, hasMore, ...(hasMore ? { nextCursor: `${current.id}:${end}` } : {}) };
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
    if (!session.refs.has(refId)) return;
    const short = refId.replace(/^t\d+s[a-f0-9]+d\d+/, "");
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
    if ((this.activeActions.get(session.tabId) ?? 0) !== 1 || session.refUsage.size <= 32_768) return;
    while (session.refUsage.size > 24_576) {
      const [short, identity] = session.refUsage.entries().next().value!;
      session.refUsage.delete(short);
      const record = session.refs.get(short);
      if (session.refsByNode.get(identity) === short) session.refsByNode.delete(identity);
      session.refs.delete(short);
      if (record) session.refs.delete(`t${session.tabId}s${session.token}d${record.generation}${short}`);
    }
  }

  private rememberRef(session: Session, identity: string, record: RefRecord): string {
    // A DOM-derived identity and an AX-derived identity are different
    // observations; neither may overwrite the other's existing binding.
    const sourceIdentity = `${identity}\u0000${record.identitySource}`;
    const previous = session.refsByNode.get(sourceIdentity);
    const old = previous ? session.refs.get(previous) : undefined;
    if (old && old.generation === record.generation && old.identitySource === record.identitySource
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
      session.refUsage.delete(previous);
    }
    const next = `e${session.nextRef++}`;
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

  private async resolveRef(session: Session, refId: string): Promise<{ ref: RefRecord; objectId: string }> {
    const ref = session.refs.get(refId);
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
      const response = await this.options.command(ref.debuggee, "DOM.resolveNode", { backendNodeId: ref.backendNodeId, objectGroup: "surf-wax-automation" });
      objectId = response.object?.objectId;
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
    let documentId = rootObjectId;
    if (!documentId) {
      const document = await this.options.command(debuggee, "Runtime.evaluate", { expression: "document", objectGroup: "surf-wax-automation" });
      documentId = document.result?.objectId;
      if (!documentId) throw automationError("frame-unavailable", { reason: "missing-document-root" });
      owned.add(documentId);
    }
    const describe = async (objectId: string, executionContextId?: number): Promise<LocatedNode> => {
      const result = await this.options.command(debuggee, "DOM.describeNode", { objectId });
      const backendNodeId = result.node?.backendNodeId;
      if (!backendNodeId) throw automationError("detached", { reason: "missing-backend-node" });
      this.objectDebuggees.set(objectId, debuggee);
      return { objectId, backendNodeId, ...(executionContextId === undefined ? {} : { executionContextId }) };
    };
    const executionContextId = rootObjectId ? [...this.frameDocuments.values()].find((frame) => frame.objectId === rootObjectId)?.executionContextId : undefined;
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
      return results.map((result) => (result as PromiseFulfilledResult<T>).value);
    };
    const domStep = async (root: LocatedNode, query: Query): Promise<LocatedNode[]> => {
      const result = await this.resolveLocator(debuggee, { queries: [query] }, "nodes", root.objectId, undefined, session);
      const arrayId = result?.objectId;
      if (!arrayId) throw automationError("state-unavailable", { reason: "missing-result-array" });
      try {
        const properties = await this.options.command(debuggee, "Runtime.getProperties", { objectId: arrayId, ownProperties: true });
        const entries = (properties.result ?? []).filter((property: any) => /^(0|[1-9]\d*)$/.test(property.name))
          .sort((a: any, b: any) => Number(a.name) - Number(b.name));
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
      const matches = await this.resolveAccessibility(debuggee, { queries: [query] }, root.objectId);
      return (await settleOwned(matches.filter((candidate) => candidate.backendNodeId && candidate.backendNodeId !== root.backendNodeId).map(async (candidate) => {
        const response = await this.options.command(debuggee, "DOM.resolveNode", { backendNodeId: candidate.backendNodeId, objectGroup: "surf-wax-automation",
          ...(root.executionContextId === undefined ? {} : { executionContextId: root.executionContextId }) });
        const objectId = response.object?.objectId;
        if (!objectId) throw automationError("detached", { reason: "missing-node-object" });
        owned.add(objectId);
        this.objectDebuggees.set(objectId, debuggee);
        return { objectId, backendNodeId: candidate.backendNodeId!, role: candidate.role, name: candidate.name,
          ...(root.executionContextId === undefined ? {} : { executionContextId: root.executionContextId }) };
      })));
    };
    const walk = async (base: LocatedNode, locator: LocatorSpec): Promise<LocatedNode[]> => {
      let current = [base];
      if (locator.ref) {
        const resolved = await this.resolveRef(session, locator.ref);
        owned.add(resolved.objectId);
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
          } catch {
            throw automationError("unsupported-target", { reason: "cross-frame-reference-context", ref: locator.ref });
          }
        }
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
        if (contained.exceptionDetails) throw automationError("unsupported-target", { reason: "cross-frame-reference-context", ref: locator.ref });
        current = contained.result?.value ? [{ objectId: refObjectId, backendNodeId: resolved.ref.backendNodeId, role: resolved.ref.role, name: resolved.ref.name,
          ...(base.executionContextId === undefined ? {} : { executionContextId: base.executionContextId }) }] : [];
      }
      const filter = async (hasText?: string, has?: LocatorSpec) => {
        const filtered: LocatedNode[] = [];
        for (const node of current) {
          if (hasText !== undefined) {
            const text = await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId: node.objectId,
              functionDeclaration: "function(){return String(this.innerText===undefined?this.textContent:this.innerText).replace(/\\s+/g,' ').trim()}",
              returnByValue: true });
            if (text.exceptionDetails) throw new Error(text.exceptionDetails.exception?.description || text.exceptionDetails.text);
            if (!String(text.result?.value ?? "").toLowerCase().includes(hasText.replace(/\s+/g, " ").trim().toLowerCase())) continue;
          }
          if (has && !(await walk(node, has)).length) continue;
          filtered.push(node);
        }
        current = filtered;
      };
      let boundScope: LocatedNode | undefined;
      const guardScope = async () => {
        if (!boundScope) return;
        const result = await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId: boundScope.objectId,
          functionDeclaration: "function(){return this.isConnected}", returnByValue: true });
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
      return current;
    };
    let results: LocatedNode[] = [];
    try {
      const initial = await describe(documentId, executionContextId);
      results = await walk(initial, spec);
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
      if (!scoped.rootIsElement && this.usesNativeAccessibility(scoped.spec)) return await this.resolveAccessibility(scoped.debuggee, scoped.spec, scoped.rootObjectId);
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
      const matches = await this.resolveAccessibility(scoped.debuggee, scoped.spec, scoped.rootObjectId);
      this.assertStrict(spec, matches);
      const node = matches[0]?.backendNodeId;
      if (!node) return undefined;
      try {
        const resolved = await this.options.command(scoped.debuggee, "DOM.resolveNode", { backendNodeId: node, objectGroup: "surf-wax-automation" });
        const objectId = resolved.object?.objectId;
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
        const details = await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId: arrayId,
          functionDeclaration: `function(){return this.slice(0,10).map(element => (${SEARCH_META_SOURCE}).call(element, false))}`, returnByValue: true });
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
      if (observe) {
        const details = await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId,
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

  private async resolveOnce(session: Session, spec: LocatorSpec, observe?: (matches: Candidate[]) => void, immediate = false): Promise<string | undefined> {
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
      const matches = await this.resolveAccessibility(scoped.debuggee, scoped.spec, scoped.rootObjectId);
      observe?.(matches);
      this.assertStrict(spec, matches);
      const match = matches[0];
      if (!match?.backendNodeId) return undefined;
      try {
        const response = await this.options.command(scoped.debuggee, "DOM.resolveNode", { backendNodeId: match.backendNodeId, objectGroup: "surf-wax-automation" });
        if (!response.object?.objectId) return undefined;
        this.objectDebuggees.set(response.object.objectId, scoped.debuggee);
        return response.object.objectId;
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

  private async resolveAccessibility(debuggee: Debuggee, spec: LocatorSpec, rootObjectId?: string): Promise<Candidate[]> {
    const query = spec.queries[0]!;
    let root: { objectId: string } | { nodeId: number };
    if (rootObjectId) root = { objectId: rootObjectId };
    else {
      const key = JSON.stringify(debuggee);
      let nodeId = this.axRoots.get(key);
      if (nodeId === undefined) {
        nodeId = (await this.options.command(debuggee, "DOM.getDocument", { depth: 0 })).root?.nodeId;
        if (nodeId === undefined) throw automationError("detached", { reason: "missing-document-root" });
        this.axRoots.set(key, nodeId);
      }
      root = { nodeId };
    }
    // CDP's accessibleName filter is case-sensitive and exact. Apply matching
    // ourselves so substring, case and whitespace semantics remain consistent.
    const tree = await this.options.command(debuggee, "Accessibility.queryAXTree", { ...root, role: query.value });
    const normalize = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
    const equal = (actual: string, expected: string) => query.exact ? actual === expected : actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
    let matches = (tree.nodes ?? []).flatMap((node: any): Candidate[] => {
      if (node.ignored || !node.backendDOMNodeId) return [];
      const role = axValue(node.role);
      const name = normalize(axValue(node.name));
      const expected = normalize(query.name ?? "");
      if (role !== query.value || query.name !== undefined && !equal(name, expected)) return [];
      return [{ role, name, backendNodeId: node.backendDOMNodeId, debuggee }];
    });
    if (spec.index !== undefined) {
      const index = spec.index < 0 ? matches.length + spec.index : spec.index;
      matches = matches[index] ? [matches[index]!] : [];
    }
    return matches;
  }

  private clearFrameDocuments(tabId?: number, source?: Debuggee, release = true): void {
    for (const [key, document] of this.frameDocuments) {
      if (tabId !== undefined && document.session.tabId !== tabId) continue;
      if (source && document.frame.debuggee.sessionId !== source.sessionId) continue;
      this.frameDocuments.delete(key);
      if (release && document.objectId) {
        void this.options.command(document.frame.debuggee, "Runtime.releaseObject", { objectId: document.objectId }).catch(() => undefined);
        document.objectId = undefined;
      }
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
        const world = await this.options.command(frame.debuggee, "Page.createIsolatedWorld", { frameId: frame.frameId, worldName: "surf-wax-frame" });
        check();
        if (!Number.isSafeInteger(world?.executionContextId)) throw automationError("frame-unavailable", { reason: "missing-execution-context" });
        entry.executionContextId = world.executionContextId;
        const response = await this.options.command(frame.debuggee, "Runtime.evaluate", { expression: "document", contextId: world.executionContextId, returnByValue: false, objectGroup: "surf-wax-automation" });
        if (typeof response.result?.objectId === "string") entry.objectId = response.result.objectId;
        check();
        if (response.exceptionDetails || !entry.objectId) throw automationError("frame-unavailable", { reason: "missing-frame-document" });
        return entry.objectId;
      }).catch((error) => {
        if (this.frameDocuments.get(key) === entry) this.frameDocuments.delete(key);
        // The evaluation can complete after invalidation or group release.
        if (entry.objectId) void this.options.command(frame.debuggee, "Runtime.releaseObject", { objectId: entry.objectId }).catch(() => undefined);
        entry.objectId = undefined;
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

  private async locatorScope(session: Session, spec: LocatorSpec, immediate = false): Promise<{ debuggee: Debuggee; spec: LocatorSpec; rootObjectId?: string; rootIsElement?: boolean; dispose: (transferObjectId?: string) => void }> {
    let debuggee = session.debuggee;
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
        transferred = true;
        return { debuggee, spec: scoped, ...(rootObjectId ? { rootObjectId } : {}), ...(rootIsElement ? { rootIsElement } : {}), dispose };
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
    const returnByValue = metadata === true;
    const keys: string[] = [];
    visitLocators(spec, (nested) => { if (nested !== spec && nested.ref && !keys.includes(nested.ref)) keys.push(nested.ref); });
    if (keys.length) {
      if (!session) throw automationError("invalid-target", { reason: "missing-reference-session" });
      const executionContextId = rootObjectId ? [...this.frameDocuments.values()].find((frame) => frame.objectId === rootObjectId)?.executionContextId : undefined;
      const objects = await Promise.all(keys.map(async (key) => {
        const resolved = await this.resolveRef(session, key);
        if (resolved.ref.debuggee.tabId !== debuggee.tabId || resolved.ref.debuggee.sessionId !== debuggee.sessionId)
          throw automationError("unsupported-target", { reason: "cross-frame-reference-context", ref: key });
        if (executionContextId !== undefined) {
          try {
            const rebound = await this.options.command(debuggee, "DOM.resolveNode", { backendNodeId: resolved.ref.backendNodeId,
              executionContextId, objectGroup });
            if (!rebound.object?.objectId) throw new Error("missing-node-object");
            return rebound.object.objectId;
          } catch {
            throw automationError("unsupported-target", { reason: "cross-frame-reference-context", ref: key });
          }
        }
        return resolved.objectId;
      }));
      let temporaryRoot: string | undefined;
      try {
        if (!rootObjectId) {
          const document = await this.options.command(debuggee, "Runtime.evaluate", { expression: "document", objectGroup });
          temporaryRoot = document.result?.objectId;
          if (!temporaryRoot) throw automationError("frame-unavailable", { reason: "missing-document-root" });
        }
        let response: any;
        try {
          response = await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId: rootObjectId ?? temporaryRoot,
            functionDeclaration: `function(spec, metadata, keys, ...nodes){return (${RESOLVER_SOURCE})(spec, metadata, this, Object.fromEntries(keys.map((key, i) => [key, nodes[i]])))}`,
            arguments: [{ value: spec }, { value: metadata }, { value: keys }, ...objects.map((objectId) => ({ objectId }))], returnByValue, objectGroup });
        } catch (error) {
          if (/same.*(world|context)|different.*(world|context)|different JavaScript world/i.test(error instanceof Error ? error.message : String(error)))
            throw automationError("unsupported-target", { reason: "cross-frame-reference-context" });
          throw error;
        }
        if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
        return response.result;
      } finally {
        if (temporaryRoot) void this.options.command(debuggee, "Runtime.releaseObject", { objectId: temporaryRoot }).catch(() => undefined);
      }
    }
    const response = rootObjectId
      ? await this.options.command(debuggee, "Runtime.callFunctionOn", { objectId: rootObjectId,
          functionDeclaration: `function(spec, metadata){return (${RESOLVER_SOURCE})(spec, metadata, this)}`,
          arguments: [{ value: spec }, { value: metadata }], returnByValue, objectGroup })
      : await this.options.command(debuggee, "Runtime.evaluate", { expression: `(${RESOLVER_SOURCE})(${JSON.stringify(spec)}, ${JSON.stringify(metadata)})`, returnByValue, objectGroup });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
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

  private async callOn(session: Session, objectId: string, functionDeclaration: string, args: unknown[] = []): Promise<any> {
    const params = {
      objectId, functionDeclaration, arguments: args.map((value) => ({ value })), awaitPromise: true, returnByValue: true,
    };
    const response = await this.options.command(session.debuggee, "Runtime.callFunctionOn", params);
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

  /** Check every iframe owner, including same-process and cross-origin frames. */
  private async frameOwnersVisible(session: Session, frameId: string): Promise<boolean> {
    const generation = session.generation, revision = session.frameRevision, root = session.rootFrameId;
    if (!root) throw automationError("frame-unavailable", { reason: "missing-root-frame" });
    const guard = () => {
      throwIfAborted(this.context.signal);
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
        const resolved = await this.options.command(parent, "DOM.resolveNode", { backendNodeId: owner.backendNodeId, objectGroup: group });
        guard();
        if (!resolved.object?.objectId) throw automationError("frame-unavailable", { reason: "missing-frame-owner-object" });
        const response = await this.options.command(parent, "Runtime.callFunctionOn", { objectId: resolved.object.objectId, returnByValue: true,
          functionDeclaration: "function(){return this.isConnected && this.checkVisibility({opacityProperty:true,visibilityProperty:true})}" });
        guard();
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

  private async waitActionableLocator(session: Session, spec: LocatorSpec, editable: boolean, pointer: boolean, stable = pointer, enabled = true, failFast = false): Promise<{ objectId: string; targetSession: Session; state: ElementState }> {
    let attempt = 0;
    const singleResolution = failFast || spec.queries.some((query) => query.kind === "uniqueScope");
    while (true) {
      throwIfAborted(this.context.signal);
      let candidates: Candidate[] = [];
      const objectId = await this.resolveOnce(session, spec, (matches) => { candidates = matches; }, singleResolution);
      attempt += 1;
      if (!objectId) {
        this.recordAttempt(session, spec, attempt, "no-candidate", candidates);
        if (singleResolution) throw automationError("not-found", { locator: spec, lastObservation: this.waitDiagnostic() });
        await delay(50, this.context.signal); continue;
      }
      const targetSession = this.objectSession(session, objectId);
      const state = await this.elementState(targetSession, objectId, pointer, true).catch((error) => {
        if (error && typeof error === "object" && "name" in error && error.name === "AbortError") throw error;
        if (!isDetachedNodeError(error)) throw error;
        if (spec.ref) throw automationError("detached", { ref: spec.ref, reason: error instanceof Error ? error.message : String(error) });
        return undefined;
      });
      if (state?.connected && state.visible) {
        state.frameId = await this.actionFrameId(session, targetSession, objectId, spec);
        state.visible = await this.frameOwnersVisible(session, state.frameId);
      }
      if (state?.connected && state.visible && state.receivesEvents && pointer)
        await this.selectPointerPoint(session, targetSession, objectId, state);
      const reason = !state?.connected ? "detached" : !state.visible ? "not-visible" : stable && !state.stable ? "not-stable" : enabled && !state.enabled ? "disabled" : editable && !state.editable ? "not-editable" : pointer && !state.receivesEvents ? "intercepted" : "actionable";
      this.recordAttempt(session, spec, attempt, reason, candidates, state);
      if (spec.ref && !state?.connected) throw automationError("detached", { ref: spec.ref, reason: "node-removed" });
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
        state.visible = await this.frameOwnersVisible(session, state.frameId);
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
          const relation = await this.options.command(debuggee, "Runtime.callFunctionOn", {
            objectId: found.object.objectId,
            functionDeclaration: "function(target){ for (let node = this; node; node = node.parentNode || node.host) if (node === target) return true; return false; }",
            arguments: [{ objectId }], returnByValue: true,
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
    const target = bound ? await this.waitBoundActionable(session, bound, operation !== "hover") : await this.waitActionableLocator(session, spec, false, true, true, operation !== "hover", operation === "click" || operation === "dblclick");
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

  private async captureSnapshot(session: Session, region?: LocatorSpec): Promise<{ url: string; title: string; lines: SnapshotLine[]; frameRevision: number; regionIdentity?: string }> {
    const signal = this.context.signal;
    const frameContext = { conversationId: this.context.conversationId, runId: this.context.logIdentity?.runId ?? this.context.runId };
    const guard = () => {
      throwIfAborted(signal);
      if (this.sessions.get(session.tabId) !== session) throw automationError("stale-session", { reason: "session-changed-during-capture" });
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
    let retriedUnstableCapture = false;
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
      if (retryGeneration !== generation || retryFrameRevision !== frameRevision) {
        retryGeneration = generation; retryFrameRevision = frameRevision; retriedUnstableCapture = false;
      }
      const changed = () => generation !== session.generation || frameRevision !== session.frameRevision;
      const regionTask = region ? this.resolveOnce(session, region) : undefined;
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
      if (region && !regionNode?.node?.backendNodeId) throw automationError("not-found", { locator: region });
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
      let trees: Array<{ debuggee: Debuggee; frameId: string | undefined; depth: number; tree: any; visibility: Map<number, boolean>; textProjections: Map<number, TextProjection>; unknownText: Set<number>; paintEvidence: Map<number, TextPaintEvidence>; candidates: SnapshotTextPaintCandidate[]; snapshot: any }>;
      let info: { url: string; title: string };
      try {
        // A scoped request discovers its frame membership from a preliminary
        // DOM capture before waiting for document loads. The subsequent D0
        // capture must prove the same membership after those waits.
        type Layout = { debuggee: Debuggee; snapshot: any };
        const captureLayout = async (debuggee: Debuggee): Promise<Layout> => {
          if (debuggee.sessionId) await session.frameReady.get(debuggee.sessionId);
          frameGuard();
          return { debuggee, snapshot: await this.options.command(debuggee, "DOMSnapshot.captureSnapshot", { computedStyles: [...SNAPSHOT_COMPUTED_STYLES], includeDOMRects: true }) };
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
        const initialLayouts = await waitForCapture(captureLayouts());
        if (regionNode) {
          const verified = await waitForCapture(selectRegionFrames(initialLayouts, false));
          if (verified.frameId !== regionFrameId || verified.selected.length !== capturedFrames.length || verified.selected.some((item, index) => item !== capturedFrames[index])) continue;
        }
        placeholderItems = [];
        const initialPaint = new Map(initialLayouts.map(({ debuggee, snapshot }) => {
          const candidates: SnapshotTextPaintCandidate[] = [];
          const visibility = snapshotVisibility(snapshot, { textPaintCandidates: candidates });
          return [debuggee.sessionId ?? "", { visibility, candidates }] as const;
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
            const { candidates, visibility } = initialPaint.get(debuggee.sessionId ?? "")!;
            const textProjections = new Map<number, TextProjection>();
            const unknownText = new Set<number>();
            const paintEvidence = new Map<number, TextPaintEvidence>();
            const byFrame = new Map<string, SnapshotTextPaintCandidate[]>();
            for (const candidate of candidates) {
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
                  const projection = projectTextPaint(candidate, evidence);
                  if (projection?.hidden) visibility.set(candidate.backendNodeId, false);
                  else if (projection?.text !== undefined && typeof candidate.layoutText === "string")
                    textProjections.set(candidate.backendNodeId, { full: (candidate.firstLetter ?? "") + candidate.layoutText, text: projection.text });
                  else if (!projection) unknownText.add(candidate.backendNodeId);
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
            }));
            return { debuggee, visibility, textProjections, unknownText, paintEvidence, candidates, snapshot };
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
      const lines: SnapshotLine[] = [];
      const render = async (nodes: any[], visibility: Map<number, boolean>, textProjections: Map<number, TextProjection>, unknownText: Set<number>,
        paintEvidence: ReadonlyMap<number, TextPaintEvidence>, candidates: readonly SnapshotTextPaintCandidate[], snapshot: any, debuggee: Debuggee, frameLabel?: string, frameDepth = 0) => {
        const byId = new Map(nodes.map((node) => [node.nodeId, node]));
        const frameId = frameLabel ?? session.rootFrameId;
        if (!frameId) throw automationError("snapshot-unavailable", { reason: "missing-root-frame" });
        const scopedRoot = Boolean(regionNode && regionFrameId === frameId && regionDebuggee && sameDebuggee(regionDebuggee, debuggee));
        const doc = snapshot.documents?.find((document: any) => snapshot.strings?.[document.frameId] === frameId);
        if (!doc) throw automationError("snapshot-unavailable", { reason: "missing-dom-frame", frameId });
        const byBackend = new Map<number, any[]>();
        for (const node of nodes) if (axValue(node.role) === "StaticText" && Number.isSafeInteger(node.backendDOMNodeId)) {
          const group = byBackend.get(node.backendDOMNodeId) ?? []; group.push(node); byBackend.set(node.backendDOMNodeId, group);
        }
        const noShadowRoots = Array.isArray(doc.nodes?.shadowRootType?.index) && doc.nodes.shadowRootType.index.length === 0;
        const frameUnobscured = frameId === session.rootFrameId && sameDebuggee(debuggee, session.debuggee);
        const pendingEllipsis: Array<{ candidate: SnapshotTextPaintCandidate; match: AxEllipsisCandidate; request: EllipsisRequest }> = [];
        for (const candidate of candidates) {
          if (candidate.frameId !== frameId || !candidate.ellipsis || !candidate.basePainted || !unknownText.has(candidate.backendNodeId)
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
          if (accepted.requests.length) ellipsisBatches.push(accepted);
        }
        let evidence: ReturnType<typeof snapshotDomSupplement>;
        try {
          evidence = snapshotDomSupplement(snapshot, { frameId, visibility, textProjections, covered: new Set() });
        }
        catch (error) { throw automationError("snapshot-unavailable", { reason: "invalid-dom-snapshot", detail: error instanceof Error ? error.message : String(error) }); }
        const preformatted = evidence.preformatted.get(frameId)!;
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
          return semanticName(textJoined.slice(textOffsets[lowerText(range.start)]!, textOffsets[lowerText(range.end)]!));
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
        const scope = frameLabel ?? session.rootFrameId ?? "root";
        // Frame ID alone is insufficient: an OOPIF can be replaced by a new
        // debugger target without changing the frame ID or document generation.
        const scopeKey = JSON.stringify([scope, debuggee.sessionId ?? null]);
        let snapshotScope = session.snapshotScopes.get(scopeKey);
        if (!snapshotScope) {
          snapshotScope = (session.nextSnapshotScope++).toString(36);
          session.snapshotScopes.set(scopeKey, snapshotScope);
        }
        if (frameLabel) lines.push({ id: `${snapshotScope}.m`, line: `${"  ".repeat(frameDepth)}- frame-document [frameRef=${capturedFrameRefs.get(frameLabel)}]` });
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
        const order: any[] = [], scan: Array<{ node: any; inherited: boolean; within: boolean; placeholderOwner?: any }> = treeRoot ? [{ node: treeRoot, inherited: false, within: false }] : [];
        while (scan.length) {
          const { node, inherited, within, placeholderOwner } = scan.pop()!;
          const known = typeof node.backendDOMNodeId === "number" ? visibility.get(node.backendDOMNodeId) : undefined;
          const nativeOwner = nativeValueOwner(node) ?? (axValue(node.role) === "generic" && node.childIds?.length === 1
            ? nativeValueOwner(byId.get(node.childIds[0])) : undefined);
          if (scopeIndex && typeof node.backendDOMNodeId === "number" && !placeholderTextNodes.has(node.backendDOMNodeId) && scopeIndex.indexOf(node.backendDOMNodeId) === undefined
            && !otherFrameBackends?.has(node.backendDOMNodeId) && !nativeOwner && known !== false && !node.ignored
            && !["", "none", "generic", "InlineTextBox"].includes(axValue(node.role)))
            throw automationError("snapshot-unavailable", { reason: "unknown-region-membership" });
          const isHidden = known === undefined ? inherited : !known;
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
          for (const id of node.childIds ?? []) { const child = byId.get(id); if (child) scan.push({ node: child, inherited: isHidden, within: isScoped, placeholderOwner: owner }); }
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
              const formatted = preformatted.get(backend);
              const text = observed === undefined ? visibleSubtree(backend)
                : formatted && !textProjections.has(backend) && formatted.source === observed ? formatted.text : observed;
              if (!text && original && visibility.get(backend) !== false) namesUnknown.add(node.nodeId);
              return text;
            }
            // An input's internal value is handled on the control row.
            if (nativeValueOwner(node) && !maskedControl(nativeValueOwner(node))) return safeName(node, original);
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
        const start = lines.length;
        const lineBackends = new Map<string, number>();
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
          const value = maskedControl(node) || ["checkbox", "radio", "switch"].includes(role)
            || editableControl && !["textbox", "searchbox", "spinbutton"].includes(role) ? "" : axValue(node.value);
          const parent = byId.get(node.parentId);
          const parentRole = parent && !parent.ignored && !hidden(parent) && inScope(parent) ? axValue(parent.role) : "";
          // A single static text leaf that exactly repeats its named semantic
          // parent carries no additional content or action. Do not collapse
          // siblings, independently named controls, or a selected region root.
          const singleTextLeaf = node !== root && role === "StaticText" && parent && parent.childIds?.length === 1
            && (node.childIds ?? []).every((id: string) => axValue(byId.get(id)?.role) === "InlineTextBox");
          const duplicateNamedText = singleTextLeaf
            && ["button", "link", "heading", "checkbox", "radio", "tab", "option", "menuitem"].includes(parentRole)
            && !node.properties?.some((property: any) => property.name === "focusable" && property.value?.value)
            && Boolean(name) && name === visibleName(parent, axValue(parent.name));
          // An editable control's value is already emitted on its row. Only
          // suppress an entirely plain, unique leaf; retain masked values,
          // independent semantics and a leaf selected as the region root.
          const duplicateValueText = singleTextLeaf && ["textbox", "searchbox"].includes(parentRole)
            && !maskedControl(parent)
            && (node.properties === undefined || Array.isArray(node.properties) && node.properties.length === 0)
            && (node.actions === undefined || Array.isArray(node.actions) && node.actions.length === 0)
            && Boolean(name) && name === axValue(parent.value);
          const owner = nativeValueOwner(node);
          const duplicateNativeValueText = singleTextLeaf && parentRole === "generic" && owner && !hidden(owner) && inScope(owner)
            && Boolean(name) && name === axValue(owner.value);
          const duplicateText = duplicateNamedText || duplicateValueText || duplicateNativeValueText;
          const emittedRole = role && role !== "none" && role !== "InlineTextBox" && (role !== "generic" || editableControl || editableEvidence?.readonly && properties.focusable === true);
          if (emittedRole && typeof node.backendDOMNodeId === "number") covered.add(node.backendDOMNodeId);
          else if (emittedRole && pseudoTextOwner(node) !== undefined) covered.add(pseudoTextOwner(node)!);
          if (emittedRole && !duplicateText) {
            let ref = "";
            const identity = `${scope}:${node.backendDOMNodeId ?? node.nodeId}`;
            if (node.backendDOMNodeId && (INTERACTIVE_ROLES.has(role) || node.properties?.some((property: any) => property.name === "focusable" && property.value?.value))) {
              ref = this.rememberRef(session, identity, { backendNodeId: node.backendDOMNodeId, frameId: frameLabel ?? session.rootFrameId, debuggee, role, name: semanticName(originalName), generation, identitySource: "ax" });
            }
            const state: Partial<Record<SnapshotStateName, unknown>> = Object.fromEntries(["checked", "disabled", "expanded", "pressed", "selected", "required", "readonly"].filter((key) => properties[key] !== undefined).map((key) => [key, properties[key]]));
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
            const snapshotId = `${snapshotScope}.a${node.nodeId}`;
            const childFrameId = typeof node.backendDOMNodeId === "number"
              ? childFramesByOwner.get(JSON.stringify([debuggee.sessionId ?? "", node.backendDOMNodeId])) : undefined;
            const childFrameRef = childFrameId ? capturedFrameRefs.get(childFrameId) : undefined;
            const ownPlaceholder = placeholder(node);
            const preserveTextWhitespace = role === "StaticText" && typeof node.backendDOMNodeId === "number" && Boolean(name)
              && !textProjections.has(node.backendDOMNodeId) && preformatted.get(node.backendDOMNodeId)?.text === name;
            const snapshotNode: SnapshotNode = { id: snapshotId, depth, role, name, value, ...(preserveTextWhitespace ? { preserveTextWhitespace: true } : {}), ...(namesUnknown.has(node.nodeId) ? { nameUnknown: true } : {}),
              ...(ownPlaceholder && ownPlaceholder.status !== "hidden" ? { placeholder: ownPlaceholder } : {}),
              ...(ref ? { ref, actions } : {}), ...(childFrameRef ? { childFrameRef } : {}), state };
            const rendered = renderSnapshotNode(snapshotNode);
            lines.push({ id: snapshotId, line: rendered.line, ...(rendered.ref ? { ref: rendered.ref } : {}), node: snapshotNode });
            axLines.set(node.nodeId, snapshotId);
            if (typeof node.backendDOMNodeId === "number") lineBackends.set(snapshotId, node.backendDOMNodeId);
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
        const nearestControl = domIndex.nearestMarkedAncestors(controls);
        const controlParts = new Map<number, SnapshotDomEvidence[]>();
        for (const item of allEvidence) if (item.kind === "text") {
          const ancestor = nearestControl[item.nodeIndex]!;
          const control = ancestor < 0 ? undefined : domIndex.backendAt(ancestor);
          if (control !== undefined) { const parts = controlParts.get(control) ?? []; parts.push(item); controlParts.set(control, parts); }
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
        const omitText = new Set<number>();
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
            const value = range ? semanticName(visibleText.slice(lowerTextPosition(range.start), lowerTextPosition(range.end)).map((item) => item.text).join("")) : "";
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
          for (const item of controlItems) {
            const parts = controlParts.get(item.backendNodeId);
            if (parts?.length !== 1) continue;
            const part = parts[0]!, formatted = preformatted.get(part.backendNodeId);
            if (part.text && !formatted && semanticName(part.text) === controlName(item)) omitText.add(part.backendNodeId);
          }
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
            if (item.kind === "text" && (omitText.has(item.backendNodeId) || !item.text?.trim() && !unknownText.has(item.backendNodeId))) continue;
            const parentIndex = nearestEmitted[item.nodeIndex]!;
            const parent = parentIndex < 0 ? undefined : domIndex.backendAt(parentIndex);
            const depth = parent === undefined || !depths.has(parent) ? (frameLabel ? frameDepth + 1 : 0) : depths.get(parent)! + 1;
            const id = `${snapshotScope}.d${item.backendNodeId}`;
            let node: SnapshotNode;
            if (item.kind === "text") {
              const formatted = preformatted.get(item.backendNodeId);
              const preserve = Boolean(item.text && !textProjections.has(item.backendNodeId) && formatted?.source === item.text);
              node = { id, depth, role: "StaticText", name: preserve ? formatted!.text : item.text, ...(unknownText.has(item.backendNodeId) ? { nameUnknown: true } : {}),
                ...(preserve ? { preserveTextWhitespace: true } : {}) };
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
              const nameUnknown = hasUnknownSubtree(item.backendNodeId) || (!name && Boolean(current?.meta?.identityName)) || Boolean(current?.meta?.identityTooLarge);
              node = { id, depth, role, ...(name ? { name } : {}), ...(nameUnknown ? { nameUnknown: true } : {}), ...(ownPlaceholder && ownPlaceholder.status !== "hidden" ? { placeholder: ownPlaceholder } : {}), ...(item.value && item.valueVisible && tag !== "select" && !["button", "submit", "reset"].includes(type) ? { value: item.value } : {}),
                ...(item.valueVisible && item.selectedOptions?.length ? { selectedLabels: item.selectedOptions.map(({ label }) => label) } : {}),
                ...(ref ? { ref, actions } : {}), ...(childFrameRef ? { childFrameRef } : {}), state };
            }
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
      const frameSnapshots: Array<{ frameRef: string; lines: SnapshotLine[] }> = [];
      for (const item of trees) {
        const { debuggee, frameId, tree, visibility, textProjections, unknownText, paintEvidence, candidates, snapshot } = item;
        if (!tree) continue;
        // Render each document at its own origin, then insert it at the
        // represented iframe owner. Frame depth alone is not semantic depth.
        await waitForCapture(render(tree.nodes ?? [], visibility, textProjections, unknownText, paintEvidence, candidates, snapshot, debuggee, frameId, 0));
        const frameRef = capturedFrameRefs.get(frameId ?? session.rootFrameId!);
        if (!frameRef) throw automationError("snapshot-unavailable", { reason: "missing-frame-ref" });
        frameSnapshots.push({ frameRef, lines: lines.splice(0) });
      }
      if (unstableDOMChecked) {
        if (retriedUnstableCapture) throw automationError("snapshot-unavailable", { reason: "dom-checked-unstable" });
        retriedUnstableCapture = true; continue;
      }
      if (unstableDOMAria) {
        if (retriedUnstableCapture) throw automationError("snapshot-unavailable", { reason: "dom-aria-label-unstable" });
        retriedUnstableCapture = true; continue;
      }
      for (const line of stitchSnapshotFrames(frameSnapshots, capturedFrameRefs.get(regionFrameId ?? session.rootFrameId!))) lines.push(line);
      const ids = new Set<string>();
      for (const { id } of lines) {
        if (ids.has(id)) throw automationError("snapshot-unavailable", { reason: "duplicate-semantic-id", id });
        ids.add(id);
      }
      if (!changed()) {
        let confirmations: Array<{ debuggee: Debuggee; snapshot: any }>;
        try {
          const afterEllipsis = await waitForCapture(Promise.all(ellipsisBatches.map((batch) => readEllipsisGeometry(batch.debuggee, batch.frameId, batch.requests))));
          if (ellipsisBatches.some((batch, index) => JSON.stringify(batch.proofs) !== JSON.stringify(afterEllipsis[index]))) {
            if (retriedUnstableCapture) throw automationError("snapshot-unavailable", { reason: "text-paint-unstable" });
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
            snapshot: await this.options.command(debuggee, "DOMSnapshot.captureSnapshot", { computedStyles: [...SNAPSHOT_COMPUTED_STYLES], includeDOMRects: true }) }))));
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
          if (!changed() && !isTransientNavigationError(error) && !isDetachedNodeError(error) && !stalePlaceholderContext) throw error;
          await delay(changed() ? 0 : 50, signal); continue;
        }
        if (changed()) continue;
        let unstable = false, unstablePaint = false;
        for (const confirmation of confirmations) {
          const initial = trees.find(({ debuggee }) => sameDebuggee(debuggee, confirmation.debuggee));
          // Ignore unrelated same-target child documents. Keep original CDP
          // contentDocumentIndex values, so document reordering remains a
          // conservative mismatch rather than inventing an association.
          const relevantIds = regionNode ? new Set(relevantFrames.filter((item) => sameDebuggee(item.debuggee, confirmation.debuggee))
            .map((item) => item.frameId ?? session.rootFrameId)) : undefined;
          const relevantDocuments = (snapshot: any) => !relevantIds ? snapshot : { ...snapshot,
            documents: snapshot.documents.filter((document: any) => relevantIds.has(snapshot.strings?.[document.frameId])) };
          const candidates = relevantIds ? initial?.candidates.filter((candidate) => relevantIds.has(candidate.frameId)) : initial?.candidates;
          const visibility = initial && relevantIds ? snapshotVisibility(relevantDocuments(initial.snapshot)) : initial?.visibility;
          if (visibility && initial && relevantIds) for (const id of visibility.keys()) {
            const value = initial.visibility.get(id);
            if (value !== undefined) visibility.set(id, value);
          }
          if (initial && visibility && sameDOMSnapshot(relevantDocuments(initial.snapshot), relevantDocuments(confirmation.snapshot),
            { visibility, textPaintCandidates: candidates ?? [], paintAdjusted: true })) continue;
          unstable = true;
          const after: SnapshotTextPaintCandidate[] = [];
          try { snapshotVisibility(confirmation.snapshot, { textPaintCandidates: after }); }
          catch { throw automationError("snapshot-unavailable", { reason: "invalid-dom-confirmation" }); }
          if (initial && !sameTextPaintCandidates(candidates ?? [], relevantIds ? after.filter((candidate) => relevantIds.has(candidate.frameId)) : after)) unstablePaint = true;
        }
        if (unstable) {
          if (retriedUnstableCapture) throw automationError("snapshot-unavailable", { reason: unstablePaint ? "text-paint-unstable" : "dom-unstable" });
          retriedUnstableCapture = true;
          continue;
        }
        return { ...info, lines, frameRevision, ...(regionNode ? { regionIdentity: JSON.stringify([regionDebuggee?.sessionId ?? "", regionFrameId, regionNode.node.backendNodeId]) } : {}) };
      }
    }
  }

  private async afterAction(session: Session): Promise<Record<string, unknown>> {
    const info = await this.pageValue(session.tabId, "({url:location.href,title:document.title})") as { url: string; title: string };
    return { performed: true, ...info, documentId: session.generation };
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
        content: { tabId, operation, locator, ...(failure instanceof AutomationError ? { diagnostic: { code: failure.code, ...failure.detail } } : {}) },
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
  evaluate(fn: ((element: Element, arg?: unknown) => unknown) | string, arg?: unknown) { return this.run("evaluate", fn, arg); }
  private run(operation: string, ...args: unknown[]) { return this.runtime.locatorValue(this.tabId, this.spec, operation, args); }
}

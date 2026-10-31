/** A missing observation is different from an observed incorrect result. */
export type InteractionEvidence =
  | { applicable: false }
  | { applicable: true; verified: boolean | null };

export interface ResultEvidenceInput {
  /** The canonical conversation terminal type, or a nonterminal/setup state. */
  outcome: string;
  /** Whether both browser and fixture-server activity were observed to settle. */
  networkSettled: boolean | null;
  /** Whether browser shutdown and server draining completed before the ledger was read. */
  ledgerDrained: boolean;
  /** Whether the complete canonical log needed for lifecycle checking was read. */
  logComplete: boolean;
  /** Whether every observed browser job reached a terminal state before shutdown. */
  jobsSettled: boolean | null;
  /** The independent judge's answer, or null if it was not evaluated. */
  business: boolean | null;
  interaction: InteractionEvidence;
  /** The lifecycle check's answer, or null if it was not evaluated. */
  lifecycle: boolean | null;
}

export type ResultReason =
  | "conversation_not_finished"
  | "conversation_outcome_unknown"
  | "network_unsettled"
  | "network_unknown"
  | "ledger_unavailable"
  | "business_incorrect"
  | "business_unknown"
  | "interaction_incorrect"
  | "interaction_unknown"
  | "lifecycle_invalid"
  | "lifecycle_unknown"
  | "jobs_unsettled"
  | "jobs_unknown";

/** Scenarios that require independently observed trusted user input. */
export function requiresInteraction(scenario: string): boolean {
  return ["sequence-editor", "pointer-drag", "rolling-queue", "frame-replacement"].includes(scenario);
}

/** Last agent request observed by the proxy, independent of the task result.
 * An incomplete response can also be caused by downstream cancellation. */
export function lastAgentResponse(value: unknown): { status: number | null; complete: boolean } | null {
  if (!Array.isArray(value)) throw new Error("Invalid provider request evidence");
  let last: { status: number | null; complete: boolean } | null = null;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid provider request evidence");
    const request = item as Record<string, unknown>;
    if (request.kind !== "agent" && request.kind !== "auxiliary") throw new Error("Invalid provider request evidence");
    if (request.responseStatus !== null && (typeof request.responseStatus !== "number" || !Number.isInteger(request.responseStatus)
      || request.responseStatus < 100 || request.responseStatus > 599) || typeof request.responseComplete !== "boolean") {
      throw new Error("Invalid provider response evidence");
    }
    if (request.kind === "agent") last = { status: request.responseStatus as number | null, complete: request.responseComplete };
  }
  return last;
}

/**
 * Classify the evidence, not the cause of the failure. In particular, an
 * incomplete setup or an unsettled network cannot be recorded as a business
 * failure. The caller may apply a separate experiment policy to timeouts.
 */
export function evaluateResultEvidence(input: ResultEvidenceInput) {
  const canGrade = input.networkSettled === true && input.ledgerDrained;
  const businessVerified = canGrade ? input.business : null;
  const interactionApplicable = input.interaction.applicable;
  const interactionVerified = canGrade && input.interaction.applicable ? input.interaction.verified : null;
  const lifecycleVerified = input.logComplete ? input.lifecycle : null;
  const jobsSettled = input.logComplete ? input.jobsSettled : null;
  const reasons: ResultReason[] = [];
  const terminalFailure = input.outcome === "conversation.failed" || input.outcome === "conversation.aborted";
  const finished = input.outcome === "conversation.finished";
  if (terminalFailure) reasons.push("conversation_not_finished");
  else if (!finished) reasons.push("conversation_outcome_unknown");
  if (input.networkSettled === false) reasons.push("network_unsettled");
  else if (input.networkSettled === null) reasons.push("network_unknown");
  if (!input.ledgerDrained) reasons.push("ledger_unavailable");
  if (businessVerified === false) reasons.push("business_incorrect");
  else if (businessVerified === null) reasons.push("business_unknown");
  if (interactionApplicable && interactionVerified === false) reasons.push("interaction_incorrect");
  else if (interactionApplicable && interactionVerified === null) reasons.push("interaction_unknown");
  if (lifecycleVerified === false) reasons.push("lifecycle_invalid");
  else if (lifecycleVerified === null) reasons.push("lifecycle_unknown");
  if (jobsSettled === false) reasons.push("jobs_unsettled");
  else if (jobsSettled === null) reasons.push("jobs_unknown");

  const incorrect = businessVerified === false || interactionApplicable && interactionVerified === false || lifecycleVerified === false;
  const missing = !finished || input.networkSettled !== true || !input.ledgerDrained || businessVerified === null
    || interactionApplicable && interactionVerified === null || lifecycleVerified === null;
  // A failed or interrupted conversation can be caused by a provider or
  // transport error, including before any tool was called. The ledger and
  // lifecycle remain observable facts, but cannot establish task failure in
  // a run that did not finish normally.
  const classification: "passed" | "failed" | "unknown" = !finished || jobsSettled !== true ? "unknown" : incorrect ? "failed" : missing ? "unknown" : "passed";
  return { classification, passed: classification === "passed", businessVerified, interactionApplicable, interactionVerified, lifecycleVerified, jobsSettled, reasons };
}

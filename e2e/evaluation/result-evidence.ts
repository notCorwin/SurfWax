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
  | "lifecycle_unknown";

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

  const incorrect = businessVerified === false || interactionApplicable && interactionVerified === false || lifecycleVerified === false;
  const missing = !finished || input.networkSettled !== true || !input.ledgerDrained || businessVerified === null
    || interactionApplicable && interactionVerified === null || lifecycleVerified === null;
  const classification: "passed" | "failed" | "unknown" = terminalFailure || finished && incorrect ? "failed" : missing ? "unknown" : "passed";
  return { classification, passed: classification === "passed", businessVerified, interactionApplicable, interactionVerified, lifecycleVerified, reasons };
}

import { describe, expect, it } from "vitest";
import { evaluateResultEvidence, type ResultEvidenceInput } from "../../e2e/evaluation/result-evidence";

const complete = (): ResultEvidenceInput => ({
  outcome: "conversation.finished", networkSettled: true, ledgerDrained: true, logComplete: true,
  business: true, interaction: { applicable: true, verified: true }, lifecycle: true,
});

describe("evaluation result evidence", () => {
  it("passes only with a finished conversation and all applicable evidence", () => {
    expect(evaluateResultEvidence(complete())).toEqual({ classification: "passed", passed: true, businessVerified: true,
      interactionApplicable: true, interactionVerified: true, lifecycleVerified: true, reasons: [] });
    expect(evaluateResultEvidence({ ...complete(), interaction: { applicable: false } })).toMatchObject({
      classification: "passed", interactionApplicable: false, interactionVerified: null,
    });
  });

  it("distinguishes a real business, interaction or lifecycle mismatch", () => {
    expect(evaluateResultEvidence({ ...complete(), business: false })).toMatchObject({
      classification: "failed", passed: false, businessVerified: false, reasons: ["business_incorrect"],
    });
    expect(evaluateResultEvidence({ ...complete(), interaction: { applicable: true, verified: false } })).toMatchObject({
      classification: "failed", interactionVerified: false, reasons: ["interaction_incorrect"],
    });
    expect(evaluateResultEvidence({ ...complete(), lifecycle: false })).toMatchObject({
      classification: "failed", lifecycleVerified: false, reasons: ["lifecycle_invalid"],
    });
  });

  it("does not turn an unsettled network or undrained ledger into a business failure or success", () => {
    for (const networkSettled of [false, null] as const) {
      for (const business of [true, false] as const) {
        expect(evaluateResultEvidence({ ...complete(), networkSettled, business })).toMatchObject({
          classification: "unknown", passed: false, businessVerified: null, interactionVerified: null,
        });
      }
    }
    expect(evaluateResultEvidence({ ...complete(), ledgerDrained: false, business: false })).toMatchObject({
      classification: "unknown", businessVerified: null, reasons: expect.arrayContaining(["ledger_unavailable", "business_unknown"]),
    });
  });

  it("distinguishes inapplicable interaction from applicable but unavailable interaction", () => {
    expect(evaluateResultEvidence({ ...complete(), interaction: { applicable: true, verified: null } })).toMatchObject({
      classification: "unknown", interactionApplicable: true, interactionVerified: null, reasons: ["interaction_unknown"],
    });
    expect(evaluateResultEvidence({ ...complete(), interaction: { applicable: false } })).toMatchObject({
      classification: "passed", interactionApplicable: false, interactionVerified: null,
    });
  });

  it("keeps lifecycle unknown if the canonical log is incomplete", () => {
    expect(evaluateResultEvidence({ ...complete(), logComplete: false, lifecycle: false })).toMatchObject({
      classification: "unknown", lifecycleVerified: null, reasons: ["lifecycle_unknown"],
    });
    expect(evaluateResultEvidence({ ...complete(), lifecycle: null })).toMatchObject({
      classification: "unknown", lifecycleVerified: null, reasons: ["lifecycle_unknown"],
    });
  });

  it("never reports setup or nonterminal runs as passed and identifies terminal conversation failure", () => {
    for (const outcome of ["setup_failed", "running", "timed_out", "unexpected"]) {
      expect(evaluateResultEvidence({ ...complete(), outcome })).toMatchObject({
        classification: "unknown", passed: false, reasons: ["conversation_outcome_unknown"],
      });
    }
    for (const outcome of ["conversation.failed", "conversation.aborted"]) {
      expect(evaluateResultEvidence({ ...complete(), outcome })).toMatchObject({
        classification: "failed", passed: false, reasons: ["conversation_not_finished"],
      });
    }
    expect(evaluateResultEvidence({ ...complete(), outcome: "setup_failed", networkSettled: null, ledgerDrained: false,
      logComplete: false, business: false, interaction: { applicable: true, verified: false }, lifecycle: false })).toMatchObject({
      classification: "unknown", passed: false, businessVerified: null, interactionVerified: null, lifecycleVerified: null,
      reasons: ["conversation_outcome_unknown", "network_unknown", "ledger_unavailable", "business_unknown", "interaction_unknown", "lifecycle_unknown"],
    });
  });

  it("retains a definitive failure even when a different evidence source is unavailable", () => {
    expect(evaluateResultEvidence({ ...complete(), business: false, logComplete: false })).toMatchObject({
      classification: "failed", businessVerified: false, lifecycleVerified: null,
      reasons: ["business_incorrect", "lifecycle_unknown"],
    });
  });
});

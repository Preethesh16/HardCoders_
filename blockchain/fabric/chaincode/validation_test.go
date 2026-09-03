package main

import "testing"

const validHash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestValidateSubmissionRejectsPIIStyleSellerReference(t *testing.T) {
	evidence := &WorkEvidence{SchemaVersion: "1.0", EvidenceID: "EVIDENCE-1", ContractHash: validHash,
		MilestoneHash: validHash, FileHash: validHash, SellerIdentityRef: "ravi@example.com", Version: 1,
		BuyerOrganizationRef: "buyer:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		BuyerDecision:        decisionPending}
	if err := validateSubmission(evidence); err == nil {
		t.Fatal("expected direct email identifier to be rejected")
	}
}

func TestApplyDecisionBindsExpectedFileAndVersion(t *testing.T) {
	buyerRef := "buyer:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	evidence := &WorkEvidence{EvidenceID: "EVIDENCE-1", FileHash: validHash, Version: 1,
		BuyerOrganizationRef: buyerRef, BuyerDecision: decisionPending}
	other := "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	decisionHash := hashParts("optiwork.fabric.buyer-decision.v1", evidence.EvidenceID, validHash, "1", decisionApproved, buyerRef)
	if err := applyDecision(evidence, decisionApproved, other, 1, buyerRef, decisionHash); err == nil {
		t.Fatal("expected mismatched file hash to be rejected")
	}
	if err := applyDecision(evidence, decisionApproved, validHash, 2, buyerRef, decisionHash); err == nil {
		t.Fatal("expected stale evidence version to be rejected")
	}
	if err := applyDecision(evidence, decisionApproved, validHash, 1, "buyer:"+other[7:], decisionHash); err == nil {
		t.Fatal("expected the wrong buyer organization to be rejected")
	}
	if err := applyDecision(evidence, decisionApproved, validHash, 1, buyerRef, other); err == nil {
		t.Fatal("expected an unrelated decision hash to be rejected")
	}
	if err := applyDecision(evidence, decisionApproved, validHash, 1, buyerRef, decisionHash); err != nil {
		t.Fatalf("expected approval to pass: %v", err)
	}
	if err := applyDecision(evidence, decisionDisputed, validHash, 1, buyerRef, decisionHash); err == nil {
		t.Fatal("expected a second decision to be rejected")
	}
}

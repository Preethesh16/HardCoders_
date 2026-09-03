package main

import "testing"

const validHash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestValidateSubmissionRejectsPIIStyleSellerReference(t *testing.T) {
	evidence := &WorkEvidence{SchemaVersion: "1.0", EvidenceID: "EVIDENCE-1", ContractHash: validHash,
		MilestoneHash: validHash, FileHash: validHash, SellerIdentityRef: "ravi@example.com", Version: 1,
		BuyerDecision: decisionPending}
	if err := validateSubmission(evidence); err == nil {
		t.Fatal("expected direct email identifier to be rejected")
	}
}

func TestApplyDecisionBindsExpectedFile(t *testing.T) {
	evidence := &WorkEvidence{FileHash: validHash, BuyerDecision: decisionPending}
	other := "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	if err := applyDecision(evidence, decisionApproved, other, validHash); err == nil {
		t.Fatal("expected mismatched file hash to be rejected")
	}
	if err := applyDecision(evidence, decisionApproved, validHash, other); err != nil {
		t.Fatalf("expected approval to pass: %v", err)
	}
	if err := applyDecision(evidence, decisionDisputed, validHash, other); err == nil {
		t.Fatal("expected a second decision to be rejected")
	}
}

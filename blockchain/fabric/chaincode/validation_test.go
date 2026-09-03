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

func TestApplyDecisionBindsExpectedFileAndVersion(t *testing.T) {
	evidence := &WorkEvidence{FileHash: validHash, Version: 1, BuyerDecision: decisionPending}
	other := "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	if err := applyDecision(evidence, decisionApproved, other, 1, validHash); err == nil {
		t.Fatal("expected mismatched file hash to be rejected")
	}
	if err := applyDecision(evidence, decisionApproved, validHash, 2, validHash); err == nil {
		t.Fatal("expected stale evidence version to be rejected")
	}
	if err := applyDecision(evidence, decisionApproved, validHash, 1, other); err != nil {
		t.Fatalf("expected approval to pass: %v", err)
	}
	if err := applyDecision(evidence, decisionDisputed, validHash, 1, other); err == nil {
		t.Fatal("expected a second decision to be rejected")
	}
}

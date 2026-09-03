package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

var (
	identifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	sha256Pattern     = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
)

func validateIdentifier(value, field string) error {
	if !identifierPattern.MatchString(value) {
		return errors.New(field + " is invalid")
	}
	return nil
}

func validateHash(value, field string) error {
	if !sha256Pattern.MatchString(value) {
		return errors.New(field + " must be a lowercase SHA-256 commitment")
	}
	return nil
}

func validateSubmission(evidence *WorkEvidence) error {
	if err := validateIdentifier(evidence.EvidenceID, "evidenceId"); err != nil {
		return err
	}
	if err := validateIdentifier(evidence.SellerIdentityRef, "sellerIdentityRef"); err != nil {
		return err
	}
	if err := validateIdentifier(evidence.BuyerOrganizationRef, "buyerOrganizationRef"); err != nil {
		return err
	}
	if !strings.HasPrefix(evidence.BuyerOrganizationRef, "buyer:") {
		return errors.New("buyerOrganizationRef is invalid")
	}
	for name, value := range map[string]string{
		"contractHash":  evidence.ContractHash,
		"milestoneHash": evidence.MilestoneHash,
		"fileHash":      evidence.FileHash,
	} {
		if err := validateHash(value, name); err != nil {
			return err
		}
	}
	if evidence.Version == 0 {
		return errors.New("version must be positive")
	}
	if evidence.BuyerDecision != decisionPending {
		return errors.New("new evidence must be pending")
	}
	return nil
}

func applyDecision(
	evidence *WorkEvidence,
	decision, expectedFileHash string,
	expectedVersion uint64,
	buyerOrganizationRef string,
	decisionHash string,
) error {
	if evidence.BuyerDecision != decisionPending {
		return errors.New("evidence version already decided")
	}
	if expectedFileHash != evidence.FileHash {
		return errors.New("expected file hash does not match current evidence")
	}
	if expectedVersion != evidence.Version {
		return errors.New("expected version does not match current evidence")
	}
	if buyerOrganizationRef != evidence.BuyerOrganizationRef {
		return errors.New("buyer organization is not authorized for this evidence")
	}
	if decision != decisionApproved && decision != decisionRevisionRequired && decision != decisionDisputed {
		return errors.New("unsupported buyer decision")
	}
	if err := validateHash(decisionHash, "buyerDecisionHash"); err != nil {
		return err
	}
	expectedDecisionHash := hashParts(
		"optiwork.fabric.buyer-decision.v1",
		evidence.EvidenceID,
		evidence.FileHash,
		fmt.Sprint(evidence.Version),
		decision,
		buyerOrganizationRef,
	)
	if decisionHash != expectedDecisionHash {
		return errors.New("buyerDecisionHash does not bind the current evidence decision")
	}
	evidence.BuyerDecision = decision
	evidence.BuyerDecisionHash = decisionHash
	return nil
}

func hashParts(parts ...string) string {
	digest := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return "sha256:" + hex.EncodeToString(digest[:])
}

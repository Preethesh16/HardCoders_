package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

type SmartContract struct {
	contractapi.Contract
}

func evidenceKey(id string) string { return "work:" + id }
func commandKey(identity, operation, idempotency string) string {
	return "idem:" + hashParts(identity, operation, idempotency)
}

func timestamp(ctx contractapi.TransactionContextInterface) (string, error) {
	ts, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return "", errors.New("unable to read transaction timestamp")
	}
	return time.Unix(ts.Seconds, int64(ts.Nanos)).UTC().Format(time.RFC3339Nano), nil
}

func actor(ctx contractapi.TransactionContextInterface, expectedRole string) (string, error) {
	identity := ctx.GetClientIdentity()
	if identity == nil {
		return "", errors.New("valid Fabric identity required")
	}
	role, found, err := identity.GetAttributeValue("optiwork.role")
	if err != nil || !found || role != expectedRole {
		return "", errors.New("Fabric identity is not authorized for this operation")
	}
	id, err := identity.GetID()
	if err != nil || id == "" {
		return "", errors.New("Fabric identity cannot be resolved")
	}
	return id, nil
}

func reader(ctx contractapi.TransactionContextInterface) error {
	identity := ctx.GetClientIdentity()
	if identity == nil {
		return errors.New("valid Fabric identity required")
	}
	id, err := identity.GetID()
	if err != nil || id == "" {
		return errors.New("Fabric identity cannot be resolved")
	}
	return nil
}

func (s *SmartContract) SubmitWorkEvidence(
	ctx contractapi.TransactionContextInterface,
	evidenceID, contractHash, milestoneHash, fileHash, sellerIdentityRef string,
	version uint64,
	idempotencyKey string,
) (*WorkEvidence, error) {
	identity, err := actor(ctx, "seller")
	if err != nil {
		return nil, err
	}
	if err := validateIdentifier(idempotencyKey, "idempotencyKey"); err != nil {
		return nil, err
	}
	fingerprint := hashParts(evidenceID, contractHash, milestoneHash, fileHash, sellerIdentityRef, fmt.Sprint(version))
	if replay, err := readReplay(ctx, commandKey(identity, "submit", idempotencyKey), fingerprint); err != nil || replay != nil {
		return replay, err
	}

	existing, err := s.GetWorkEvidence(ctx, evidenceID)
	if err != nil && !errors.Is(err, errNotFound) {
		return nil, err
	}
	if existing != nil {
		if existing.BuyerDecision != decisionRevisionRequired || version != existing.Version+1 {
			return nil, errors.New("a new version requires a revision decision and sequential version")
		}
	}
	occurredAt, err := timestamp(ctx)
	if err != nil {
		return nil, err
	}
	evidence := &WorkEvidence{
		SchemaVersion: "1.0", EvidenceID: evidenceID, ContractHash: contractHash,
		MilestoneHash: milestoneHash, FileHash: fileHash, SellerIdentityRef: sellerIdentityRef,
		Version: version, SubmittedAt: occurredAt, BuyerDecision: decisionPending,
		FabricTxID: ctx.GetStub().GetTxID(), AggregateVersion: version,
	}
	if err := validateSubmission(evidence); err != nil {
		return nil, err
	}
	if err := putJSON(ctx, evidenceKey(evidenceID), evidence); err != nil {
		return nil, err
	}
	if err := emit(ctx, "fabric.work_submitted", evidence); err != nil {
		return nil, err
	}
	if err := saveReplay(ctx, commandKey(identity, "submit", idempotencyKey), fingerprint, evidence); err != nil {
		return nil, err
	}
	return evidence, nil
}

func (s *SmartContract) DecideWorkEvidence(
	ctx contractapi.TransactionContextInterface,
	evidenceID, decision, expectedFileHash string,
	expectedVersion uint64,
	buyerDecisionHash, idempotencyKey string,
) (*WorkEvidence, error) {
	identity, err := actor(ctx, "buyer")
	if err != nil {
		return nil, err
	}
	if err := validateIdentifier(idempotencyKey, "idempotencyKey"); err != nil {
		return nil, err
	}
	fingerprint := hashParts(evidenceID, decision, expectedFileHash, fmt.Sprint(expectedVersion), buyerDecisionHash)
	if replay, err := readReplay(ctx, commandKey(identity, "decide", idempotencyKey), fingerprint); err != nil || replay != nil {
		return replay, err
	}
	evidence, err := s.GetWorkEvidence(ctx, evidenceID)
	if err != nil {
		return nil, err
	}
	if err := applyDecision(evidence, decision, expectedFileHash, expectedVersion, buyerDecisionHash); err != nil {
		return nil, err
	}
	evidence.DecidedAt, err = timestamp(ctx)
	if err != nil {
		return nil, err
	}
	evidence.FabricTxID = ctx.GetStub().GetTxID()
	evidence.AggregateVersion++
	if err := putJSON(ctx, evidenceKey(evidenceID), evidence); err != nil {
		return nil, err
	}
	if err := emit(ctx, "fabric.work_decided", evidence); err != nil {
		return nil, err
	}
	if err := saveReplay(ctx, commandKey(identity, "decide", idempotencyKey), fingerprint, evidence); err != nil {
		return nil, err
	}
	return evidence, nil
}

var errNotFound = errors.New("work evidence not found")

func (s *SmartContract) GetWorkEvidence(ctx contractapi.TransactionContextInterface, evidenceID string) (*WorkEvidence, error) {
	if err := reader(ctx); err != nil {
		return nil, err
	}
	if err := validateIdentifier(evidenceID, "evidenceId"); err != nil {
		return nil, err
	}
	encoded, err := ctx.GetStub().GetState(evidenceKey(evidenceID))
	if err != nil {
		return nil, errors.New("unable to read work evidence")
	}
	if len(encoded) == 0 {
		return nil, errNotFound
	}
	var evidence WorkEvidence
	if err := json.Unmarshal(encoded, &evidence); err != nil {
		return nil, errors.New("stored work evidence is invalid")
	}
	return &evidence, nil
}

const (
	maxHistoryEntries       = 64
	maxHistoryResponseBytes = 512 * 1024
)

func (s *SmartContract) GetWorkEvidenceHistory(
	ctx contractapi.TransactionContextInterface,
	evidenceID string,
) ([]WorkEvidenceHistoryEntry, error) {
	if err := reader(ctx); err != nil {
		return nil, err
	}
	if err := validateIdentifier(evidenceID, "evidenceId"); err != nil {
		return nil, err
	}
	iterator, err := ctx.GetStub().GetHistoryForKey(evidenceKey(evidenceID))
	if err != nil {
		return nil, errors.New("unable to read work evidence history")
	}
	defer iterator.Close()

	entries := make([]WorkEvidenceHistoryEntry, 0)
	responseBytes := 0
	for iterator.HasNext() {
		if len(entries) >= maxHistoryEntries {
			return nil, errors.New("work evidence history exceeds the bounded response limit")
		}
		modification, err := iterator.Next()
		if err != nil {
			return nil, errors.New("unable to read work evidence history entry")
		}
		if modification.Timestamp == nil {
			return nil, errors.New("work evidence history entry has no timestamp")
		}
		entry := WorkEvidenceHistoryEntry{
			TransactionID: modification.TxId,
			Timestamp: time.Unix(
				modification.Timestamp.Seconds,
				int64(modification.Timestamp.Nanos),
			).UTC().Format(time.RFC3339Nano),
			IsDelete: modification.IsDelete,
		}
		if !modification.IsDelete {
			var evidence WorkEvidence
			if err := json.Unmarshal(modification.Value, &evidence); err != nil {
				return nil, errors.New("stored work evidence history is invalid")
			}
			entry.Value = &evidence
		}
		encoded, err := json.Marshal(entry)
		if err != nil {
			return nil, errors.New("unable to encode work evidence history")
		}
		responseBytes += len(encoded)
		if responseBytes > maxHistoryResponseBytes {
			return nil, errors.New("work evidence history exceeds the bounded response size")
		}
		entries = append(entries, entry)
	}
	if len(entries) == 0 {
		return nil, errNotFound
	}
	return entries, nil
}

var errCommandNotFound = errors.New("idempotent command result not found")

func (s *SmartContract) GetCommandResult(
	ctx contractapi.TransactionContextInterface,
	operation, idempotencyKey string,
) (*WorkEvidence, error) {
	expectedRole := ""
	switch operation {
	case "submit":
		expectedRole = "seller"
	case "decide":
		expectedRole = "buyer"
	default:
		return nil, errors.New("unsupported command operation")
	}
	identity, err := actor(ctx, expectedRole)
	if err != nil {
		return nil, err
	}
	if err := validateIdentifier(idempotencyKey, "idempotencyKey"); err != nil {
		return nil, err
	}
	encoded, err := ctx.GetStub().GetState(commandKey(identity, operation, idempotencyKey))
	if err != nil {
		return nil, errors.New("unable to read idempotency record")
	}
	if len(encoded) == 0 {
		return nil, errCommandNotFound
	}
	var record CommandRecord
	if err := json.Unmarshal(encoded, &record); err != nil || record.Result == nil {
		return nil, errors.New("stored idempotency record is invalid")
	}
	return record.Result, nil
}

func putJSON(ctx contractapi.TransactionContextInterface, key string, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return errors.New("unable to encode ledger state")
	}
	if len(encoded) > 16*1024 {
		return errors.New("ledger state exceeds size limit")
	}
	if err := ctx.GetStub().PutState(key, encoded); err != nil {
		return errors.New("unable to write ledger state")
	}
	return nil
}

func emit(ctx contractapi.TransactionContextInterface, eventType string, evidence *WorkEvidence) error {
	event := EvidenceEvent{Type: eventType, EvidenceID: evidence.EvidenceID, FileHash: evidence.FileHash,
		Version: evidence.Version, BuyerDecision: evidence.BuyerDecision, FabricTxID: evidence.FabricTxID,
		OccurredAt: evidence.SubmittedAt}
	if evidence.DecidedAt != "" {
		event.OccurredAt = evidence.DecidedAt
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		return errors.New("unable to encode event")
	}
	return ctx.GetStub().SetEvent(eventType, encoded)
}

func readReplay(ctx contractapi.TransactionContextInterface, key, fingerprint string) (*WorkEvidence, error) {
	encoded, err := ctx.GetStub().GetState(key)
	if err != nil {
		return nil, errors.New("unable to read idempotency record")
	}
	if len(encoded) == 0 {
		return nil, nil
	}
	var record CommandRecord
	if err := json.Unmarshal(encoded, &record); err != nil {
		return nil, errors.New("stored idempotency record is invalid")
	}
	if record.Fingerprint != fingerprint {
		return nil, errors.New("idempotency key reused with a different command")
	}
	return record.Result, nil
}

func saveReplay(ctx contractapi.TransactionContextInterface, key, fingerprint string, result *WorkEvidence) error {
	return putJSON(ctx, key, &CommandRecord{Fingerprint: fingerprint, Result: result})
}

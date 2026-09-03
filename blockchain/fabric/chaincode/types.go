package main

const (
	decisionPending          = "PENDING"
	decisionApproved         = "APPROVED"
	decisionRevisionRequired = "REVISION_REQUIRED"
	decisionDisputed         = "DISPUTED"
)

type WorkEvidence struct {
	SchemaVersion     string `json:"schemaVersion"`
	EvidenceID        string `json:"evidenceId"`
	ContractHash      string `json:"contractHash"`
	MilestoneHash     string `json:"milestoneHash"`
	FileHash          string `json:"fileHash"`
	SellerIdentityRef string `json:"sellerIdentityRef"`
	Version           uint64 `json:"version"`
	SubmittedAt       string `json:"submittedAt"`
	BuyerDecision     string `json:"buyerDecision"`
	BuyerDecisionHash string `json:"buyerDecisionHash,omitempty"`
	DecidedAt         string `json:"decidedAt,omitempty"`
	FabricTxID        string `json:"fabricTxId"`
	AggregateVersion  uint64 `json:"aggregateVersion"`
}

type CommandRecord struct {
	Fingerprint string        `json:"fingerprint"`
	Result      *WorkEvidence `json:"result"`
}

type EvidenceEvent struct {
	Type          string `json:"type"`
	EvidenceID    string `json:"evidenceId"`
	FileHash      string `json:"fileHash"`
	Version       uint64 `json:"version"`
	BuyerDecision string `json:"buyerDecision"`
	FabricTxID    string `json:"fabricTxId"`
	OccurredAt    string `json:"occurredAt"`
}

type WorkEvidenceHistoryEntry struct {
	TransactionID string        `json:"transactionId"`
	Timestamp     string        `json:"timestamp"`
	IsDelete      bool          `json:"isDelete"`
	Value         *WorkEvidence `json:"value,omitempty"`
}

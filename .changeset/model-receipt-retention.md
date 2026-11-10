---
"@claudexor/daemon": minor
---

Bound model-operation receipt history to 30 days after termination (#637), without applying the Agent history count cap. Active operations, the unacknowledged result-pickup window and unsettled resources remain protected. After expiry, the operation and its idempotency binding can be absent: a late lookup proves neither non-dispatch nor zero cost, and re-uploading new request bytes under an expired key is a new request. This deliberately replaces the indefinite compact-receipt guarantee (CONCEPT-CHANGE(INV-064)).

Reduce retention inventory reads to product and delivery commands in bounded windows of existing rows (#638). Rowid gaps, archived generations, unknown product states and pending deliveries retain their meanings; there is no schema or index migration. Existing resources, conversation history and native profiles are not blanket-pruned.

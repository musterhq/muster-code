/** Live human-input handlers only; persisted history does not imply availability. */
export interface AttentionRequest {
  itemId: string;
  kind: 'approval' | 'question';
  createdAt: string;
  sourceLabel: 'Provider approval' | 'Provider question';
}
export interface ChatAttention {
  chatId: string;
  chatTitle: string;
  /** Counts request cards, not individual questions inside a card. */
  approvalCount: number;
  questionCount: number;
  requests: AttentionRequest[];
}
export interface PendingAttentionSummary {
  totalRequests: number;
  chats: ChatAttention[];
}

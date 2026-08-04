export type LocalModelStatus = {
  provider: "ollama";
  configured: boolean;
  connected: boolean;
  model: string;
  modelAvailable: boolean;
  error?: string;
};

export type ModelContext = {
  nodeId: string;
  label: string;
  group: string;
  content: string;
  retrievalScore: number;
  matchedTerms: string[];
};

export type ConversationTurn = {
  question: string;
  answer: string;
  sourceNodeIds: string[];
};

export type GroundingReport = {
  acceptedClaims: number;
  rejectedClaims: number;
  supportRatio: number;
};

export type GeneratedAnswer = {
  provider: "ollama";
  model: string;
  answer: string;
  citations: number[];
  grounded: boolean;
  grounding?: GroundingReport;
};

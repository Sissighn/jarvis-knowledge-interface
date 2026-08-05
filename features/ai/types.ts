export type LocalModelStatus = {
  provider: "ollama";
  configured: boolean;
  connected: boolean;
  model: string;
  modelAvailable: boolean;
  error?: string;
};

/** One indexed Notion chunk handed to the local model as the only fact source. */
export type ModelContext = {
  chunkId: string;
  sourceTitle: string;
  headingPath: string;
  content: string;
  retrievalScore: number;
  matchedTerms: string[];
};

export type ConversationTurn = {
  question: string;
  answer: string;
  sourceIds: string[];
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

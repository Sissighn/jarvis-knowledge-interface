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
};

export type GeneratedAnswer = {
  provider: "ollama";
  model: string;
  answer: string;
  citations: number[];
  grounded: boolean;
};

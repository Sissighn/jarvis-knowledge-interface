export type TechVocabularyTerm = {
  id: string;
  term: string;
  category: string;
  definition: string;
  purpose: string;
  professionalExample: string;
  everydayExample: string;
  conversationSentence: string;
  keyTakeaway: string;
};

export type DailyTechVocabulary = {
  date: string;
  terms: TechVocabularyTerm[];
  featuredTermIds: string[];
};

export type VocabularySaveResult = {
  saved: boolean;
  alreadyExists: boolean;
  termId: string;
  notionUrl?: string;
  error?: string;
};

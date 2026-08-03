export type SpeechStatus = {
  provider: "whisper.cpp";
  connected: boolean;
  model: string;
  error?: string;
};

export type SpeechTranscript = {
  provider: "whisper.cpp";
  model: string;
  text: string;
};

import type { LocalTextModelId, TextProvider } from "@/lib/text-models";

export type StoryRole = "user" | "assistant";

export type AspectPreset = "square" | "portrait" | "landscape";

export type ImageMode = "fast" | "slow";

export type ImageBackend = "mflux-hs" | "sdnq-hs" | "comfyui-flux-gguf";

export type Attachment = {
  id: string;
  name: string;
  type: string;
  url: string;
  dataUrl?: string;
};

export type ImageRequest = {
  needed: boolean;
  prompt?: string;
  mode?: ImageMode;
  backend?: ImageBackend;
  aspect?: AspectPreset;
  reason?: string;
  characterIds?: string[];
};

export type StoryMessage = {
  id: string;
  role: StoryRole;
  content: string;
  createdAt: string;
  attachments?: Attachment[];
  imageRequest?: ImageRequest;
  generatedImage?: GeneratedImage;
};

export type GeneratedImage = {
  id: string;
  url: string;
  prompt: string;
  mode: ImageMode;
  backend?: ImageBackend;
  aspect: AspectPreset;
  width: number;
  height: number;
  elapsedSeconds?: number;
  seed?: number;
  warnings?: string[];
};

export type StorySettings = {
  world: string;
  style: string;
  textProvider: TextProvider;
  localTextModel: LocalTextModelId;
  // Any OpenAI-compatible backend (llama.cpp, LM Studio, vLLM, OpenRouter, a
  // remote Ollama). Set in-app. The key is optional and stored locally; most
  // local servers need none, and it falls back to env when blank.
  customBaseUrl: string;
  customModel: string;
  customApiKey: string;
  imageMode: ImageMode;
  imageBackend: ImageBackend;
  aspect: AspectPreset;
  autoImages: boolean;
  // Fixed art-direction appended to every image prompt in this story so the
  // medium, palette, and lighting stay consistent turn to turn. Set once when
  // the story is created (derived from its genre); editable later.
  imageStyle: string;
};

export type StoryChatSummary = {
  id: string;
  title: string;
  settings: StorySettings;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview?: string;
};

export type StoryChat = StoryChatSummary & {
  messages: StoryMessage[];
  characters: StoryCharacter[];
};

export type StoryCharacter = {
  id: string;
  chatId: string;
  name: string;
  details: string;
  portrait?: Attachment;
  createdAt: string;
  updatedAt: string;
};

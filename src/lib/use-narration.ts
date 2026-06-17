"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const VOICE_STORAGE_KEY = "open-dungeon:narration";

type NarrationPrefs = {
  enabled: boolean;
  voiceURI: string;
  rate: number;
};

const DEFAULT_PREFS: NarrationPrefs = {
  enabled: false,
  voiceURI: "",
  rate: 1,
};

function loadPrefs(): NarrationPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = window.localStorage.getItem(VOICE_STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<NarrationPrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

// Prefer natural-sounding voices: Windows "Natural"/"Online" neural voices,
// then any en-* voice, then the platform default.
function rankVoice(voice: SpeechSynthesisVoice): number {
  const name = voice.name.toLowerCase();
  let score = 0;
  if (/natural|neural|online/.test(name)) score += 100;
  if (voice.lang.toLowerCase().startsWith("en")) score += 40;
  if (/aria|jenny|guy|sonia|ryan|libby|emma/.test(name)) score += 20;
  if (voice.localService) score += 5;
  return score;
}

// Strips markdown emphasis and dialogue asterisks so the spoken text is clean.
function cleanForSpeech(text: string): string {
  return text
    .replace(/[*_#`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Browser Web Speech narration that speaks text as it streams in.
 *
 * `pushStreamingText` is called with the *full* accumulated passage on every
 * delta; the hook tracks how much it has already queued and only speaks newly
 * completed sentences, so audio starts on the first sentence and stays in sync
 * with the streaming prose.
 */
export function useNarration() {
  const [supported, setSupported] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [prefs, setPrefs] = useState<NarrationPrefs>(DEFAULT_PREFS);
  const [speaking, setSpeaking] = useState(false);

  // How many characters of the current streaming passage we've already spoken.
  const spokenLenRef = useRef(0);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    setSupported(true);
    setPrefs(loadPrefs());

    const refreshVoices = () => {
      const list = window.speechSynthesis.getVoices();
      if (list.length) setVoices(list);
    };
    refreshVoices();
    window.speechSynthesis.addEventListener("voiceschanged", refreshVoices);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", refreshVoices);
      window.speechSynthesis.cancel();
    };
  }, []);

  const persist = useCallback((next: NarrationPrefs) => {
    setPrefs(next);
    try {
      window.localStorage.setItem(VOICE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore storage failures
    }
  }, []);

  const pickVoice = useCallback((): SpeechSynthesisVoice | null => {
    if (!voices.length) return null;
    const chosen = voices.find((v) => v.voiceURI === prefsRef.current.voiceURI);
    if (chosen) return chosen;
    return [...voices].sort((a, b) => rankVoice(b) - rankVoice(a))[0] || null;
  }, [voices]);

  const speak = useCallback(
    (text: string) => {
      const clean = cleanForSpeech(text);
      if (!clean) return;
      const utterance = new SpeechSynthesisUtterance(clean);
      const voice = pickVoice();
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      utterance.rate = prefsRef.current.rate;
      utterance.onstart = () => setSpeaking(true);
      utterance.onend = () => {
        if (!window.speechSynthesis.speaking) setSpeaking(false);
      };
      window.speechSynthesis.speak(utterance);
    },
    [pickVoice],
  );

  const stop = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  // Begin a fresh passage: clear any in-flight speech and reset the cursor.
  const beginPassage = useCallback(() => {
    spokenLenRef.current = 0;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  // Speak any newly completed sentences in the accumulated streaming text.
  const pushStreamingText = useCallback(
    (fullText: string, { flush = false }: { flush?: boolean } = {}) => {
      if (!prefsRef.current.enabled) return;
      const unspoken = fullText.slice(spokenLenRef.current);
      if (!unspoken) return;

      // Find the last sentence boundary so we only speak complete sentences.
      const boundary = Math.max(
        unspoken.lastIndexOf(". "),
        unspoken.lastIndexOf("! "),
        unspoken.lastIndexOf("? "),
        unspoken.lastIndexOf(".\n"),
        unspoken.lastIndexOf("!\n"),
        unspoken.lastIndexOf("?\n"),
      );

      let chunk: string;
      if (flush) {
        chunk = unspoken;
      } else if (boundary === -1) {
        return; // no complete sentence yet
      } else {
        chunk = unspoken.slice(0, boundary + 1);
      }

      spokenLenRef.current += chunk.length;
      speak(chunk);
    },
    [speak],
  );

  // Speak a full, already-complete passage (non-streaming path).
  const speakWhole = useCallback(
    (text: string) => {
      if (!prefsRef.current.enabled) return;
      beginPassage();
      spokenLenRef.current = text.length;
      speak(text);
    },
    [beginPassage, speak],
  );

  return {
    supported,
    voices,
    enabled: prefs.enabled,
    voiceURI: prefs.voiceURI,
    rate: prefs.rate,
    speaking,
    setEnabled: (enabled: boolean) => {
      if (!enabled) stop();
      persist({ ...prefsRef.current, enabled });
    },
    setVoiceURI: (voiceURI: string) => persist({ ...prefsRef.current, voiceURI }),
    setRate: (rate: number) => persist({ ...prefsRef.current, rate }),
    beginPassage,
    pushStreamingText,
    speakWhole,
    stop,
  };
}

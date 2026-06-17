"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const VOICE_STORAGE_KEY = "open-dungeon:narration";

export type NarrationBackend = "web" | "kokoro";

type NarrationPrefs = {
  enabled: boolean;
  backend: NarrationBackend;
  voiceURI: string; // Web Speech voiceURI
  kokoroVoice: string;
  rate: number;
};

const DEFAULT_PREFS: NarrationPrefs = {
  enabled: false,
  backend: "web",
  voiceURI: "",
  kokoroVoice: "af_heart",
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

// Prefer natural-sounding Web Speech voices: Windows "Natural"/"Online" neural
// voices first, then any en-* voice, then the platform default.
function rankVoice(voice: SpeechSynthesisVoice): number {
  const name = voice.name.toLowerCase();
  let score = 0;
  if (/natural|neural|online/.test(name)) score += 100;
  if (voice.lang.toLowerCase().startsWith("en")) score += 40;
  if (/aria|jenny|guy|sonia|ryan|libby|emma/.test(name)) score += 20;
  if (voice.localService) score += 5;
  return score;
}

function cleanForSpeech(text: string): string {
  return text
    .replace(/[*_#`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function lastSentenceBoundary(text: string): number {
  return Math.max(
    text.lastIndexOf(". "),
    text.lastIndexOf("! "),
    text.lastIndexOf("? "),
    text.lastIndexOf(".\n"),
    text.lastIndexOf("!\n"),
    text.lastIndexOf("?\n"),
  );
}

/**
 * Narration with two backends:
 *  - "web":   browser Web Speech API (zero setup, robotic-ish).
 *  - "kokoro": local Kokoro-82M neural TTS via /api/tts (natural; needs the
 *             tts:server running). Sentences are fetched as they stream in and
 *             played in order, so synthesis of later sentences overlaps the
 *             playback of earlier ones.
 *
 * `pushStreamingText` receives the full accumulated passage on each delta and
 * speaks only newly completed sentences.
 */
export function useNarration() {
  const [webSupported, setWebSupported] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [kokoroAvailable, setKokoroAvailable] = useState(false);
  const [kokoroVoices, setKokoroVoices] = useState<string[]>([]);
  const [prefs, setPrefs] = useState<NarrationPrefs>(DEFAULT_PREFS);
  const [speaking, setSpeaking] = useState(false);

  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const kokoroAvailableRef = useRef(false);
  kokoroAvailableRef.current = kokoroAvailable;

  const spokenLenRef = useRef(0);
  // Bumped on every new passage / stop so stale audio is discarded.
  const genRef = useRef(0);
  // Serializes Kokoro audio playback while fetches run concurrently.
  const playChainRef = useRef<Promise<void>>(Promise.resolve());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const activeRef = useRef(0);

  useEffect(() => {
    const hasWeb = typeof window !== "undefined" && "speechSynthesis" in window;
    let refreshVoices: (() => void) | null = null;

    if (hasWeb) {
      setWebSupported(true);
      refreshVoices = () => {
        const list = window.speechSynthesis.getVoices();
        if (list.length) setVoices(list);
      };
      refreshVoices();
      window.speechSynthesis.addEventListener("voiceschanged", refreshVoices);
    }

    setPrefs(loadPrefs());

    // Probe the local Kokoro server (don't block if it's down).
    fetch("/api/tts", { method: "GET" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.ok || Array.isArray(data?.voices)) {
          setKokoroAvailable(true);
          if (Array.isArray(data.voices)) setKokoroVoices(data.voices as string[]);
        }
      })
      .catch(() => {});

    return () => {
      if (hasWeb && refreshVoices) {
        window.speechSynthesis.removeEventListener("voiceschanged", refreshVoices);
        window.speechSynthesis.cancel();
      }
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

  const pickWebVoice = useCallback((): SpeechSynthesisVoice | null => {
    if (!voices.length) return null;
    const chosen = voices.find((v) => v.voiceURI === prefsRef.current.voiceURI);
    if (chosen) return chosen;
    return [...voices].sort((a, b) => rankVoice(b) - rankVoice(a))[0] || null;
  }, [voices]);

  const markIdleIfDone = useCallback(() => {
    activeRef.current = Math.max(0, activeRef.current - 1);
    if (activeRef.current === 0) setSpeaking(false);
  }, []);

  const speakWeb = useCallback(
    (text: string) => {
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = pickWebVoice();
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      utterance.rate = prefsRef.current.rate;
      utterance.onstart = () => setSpeaking(true);
      utterance.onend = markIdleIfDone;
      utterance.onerror = markIdleIfDone;
      window.speechSynthesis.speak(utterance);
    },
    [pickWebVoice, markIdleIfDone],
  );

  const playKokoroBlob = useCallback(
    (blobPromise: Promise<Blob>, gen: number): Promise<void> => {
      return new Promise((resolve) => {
        blobPromise
          .then((blob) => {
            if (gen !== genRef.current) {
              markIdleIfDone();
              return resolve();
            }
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audioRef.current = audio;
            const finish = () => {
              URL.revokeObjectURL(url);
              if (audioRef.current === audio) audioRef.current = null;
              markIdleIfDone();
              resolve();
            };
            audio.onended = finish;
            audio.onerror = finish;
            void audio.play().catch(finish);
          })
          .catch(() => {
            markIdleIfDone();
            resolve();
          });
      });
    },
    [markIdleIfDone],
  );

  const enqueueKokoro = useCallback(
    (text: string) => {
      const gen = genRef.current;
      activeRef.current += 1;
      setSpeaking(true);
      // Kick the fetch off immediately so it overlaps prior playback.
      const blobPromise = fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voice: prefsRef.current.kokoroVoice,
          speed: prefsRef.current.rate,
        }),
      }).then((res) => {
        if (!res.ok) throw new Error("tts failed");
        return res.blob();
      });
      playChainRef.current = playChainRef.current
        .then(() => playKokoroBlob(blobPromise, gen))
        .catch(() => {});
    },
    [playKokoroBlob],
  );

  const enqueueSpeech = useCallback(
    (text: string) => {
      const clean = cleanForSpeech(text);
      if (!clean) return;
      const useKokoro = prefsRef.current.backend === "kokoro" && kokoroAvailableRef.current;
      if (useKokoro) {
        enqueueKokoro(clean);
      } else {
        activeRef.current += 1;
        setSpeaking(true);
        speakWeb(clean);
      }
    },
    [enqueueKokoro, speakWeb],
  );

  const stop = useCallback(() => {
    genRef.current += 1;
    activeRef.current = 0;
    playChainRef.current = Promise.resolve();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setSpeaking(false);
  }, []);

  const beginPassage = useCallback(() => {
    spokenLenRef.current = 0;
    stop();
  }, [stop]);

  const pushStreamingText = useCallback(
    (fullText: string, { flush = false }: { flush?: boolean } = {}) => {
      if (!prefsRef.current.enabled) return;
      const unspoken = fullText.slice(spokenLenRef.current);
      if (!unspoken) return;

      const boundary = lastSentenceBoundary(unspoken);
      let chunk: string;
      if (flush) {
        chunk = unspoken;
      } else if (boundary === -1) {
        return; // no complete sentence yet
      } else {
        chunk = unspoken.slice(0, boundary + 1);
      }

      spokenLenRef.current += chunk.length;
      enqueueSpeech(chunk);
    },
    [enqueueSpeech],
  );

  const speakWhole = useCallback(
    (text: string) => {
      if (!prefsRef.current.enabled) return;
      beginPassage();
      spokenLenRef.current = text.length;
      enqueueSpeech(text);
    },
    [beginPassage, enqueueSpeech],
  );

  const backendAvailable = (backend: NarrationBackend) =>
    backend === "kokoro" ? kokoroAvailable : webSupported;

  return {
    supported: webSupported || kokoroAvailable,
    webSupported,
    kokoroAvailable,
    voices,
    kokoroVoices,
    backendAvailable,
    enabled: prefs.enabled,
    backend: prefs.backend,
    voiceURI: prefs.voiceURI,
    kokoroVoice: prefs.kokoroVoice,
    rate: prefs.rate,
    speaking,
    setEnabled: (enabled: boolean) => {
      if (!enabled) stop();
      persist({ ...prefsRef.current, enabled });
    },
    setBackend: (backend: NarrationBackend) => {
      stop();
      persist({ ...prefsRef.current, backend });
    },
    setVoiceURI: (voiceURI: string) => persist({ ...prefsRef.current, voiceURI }),
    setKokoroVoice: (kokoroVoice: string) => persist({ ...prefsRef.current, kokoroVoice }),
    setRate: (rate: number) => persist({ ...prefsRef.current, rate }),
    beginPassage,
    pushStreamingText,
    speakWhole,
    stop,
  };
}

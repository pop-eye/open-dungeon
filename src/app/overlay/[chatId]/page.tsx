"use client";

/**
 * OBS Overlay — /overlay/[chatId]
 *
 * Designed to be added as a Browser Source in OBS.
 * Shows the latest story passages and live voting state.
 *
 * URL params:
 *   ?transparent=1  — remove background (use with chroma key or OBS Browser Source
 *                     "Allow transparency" checked)
 *   ?passages=N     — number of recent passages to show (default 3)
 *   ?poll=N         — polling interval in ms (default 3000)
 *   ?fontSize=N     — base font size in px (default 18)
 */

import { useEffect, useRef, useState } from "react";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  hasImage: boolean;
  imageUrl: string | null;
};

type VoteEntry = {
  command: string;
  text: string;
  votes: number;
  username: string;
};

type VoteState = {
  active: boolean;
  remainingSeconds?: number;
  windowSeconds?: number;
  totalVotes?: number;
  uniqueVoters?: number;
  entries?: VoteEntry[];
};

type StatusPayload = {
  chatTitle: string | null;
  messages: Message[];
  voting: (Omit<VoteState, "active"> & { remainingSeconds: number }) | null;
};

function VoteMeter({ entry, maxVotes }: { entry: VoteEntry; maxVotes: number }) {
  const pct = maxVotes > 0 ? Math.round((entry.votes / maxVotes) * 100) : 0;
  const label =
    entry.command === "do"
      ? `Do: ${entry.text}`
      : entry.command === "say"
        ? `Say: "${entry.text}"`
        : entry.command === "continue"
          ? "Continue…"
          : `Story: ${entry.text}`;

  return (
    <div className="mb-1">
      <div className="flex justify-between text-xs mb-0.5 opacity-80">
        <span className="truncate max-w-[80%]">{label}</span>
        <span className="ml-2 shrink-0">
          {entry.votes} {entry.votes === 1 ? "vote" : "votes"}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full bg-purple-400 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function StoryPassage({ message, isLatest }: { message: Message; isLatest: boolean }) {
  return (
    <div
      className={`mb-4 transition-opacity duration-700 ${isLatest ? "opacity-100" : "opacity-60"}`}
    >
      {message.role === "user" ? (
        <p className="text-purple-300 font-medium mb-1 text-sm tracking-wide uppercase opacity-70">
          Action
        </p>
      ) : null}
      {message.imageUrl && (
        <img
          src={message.imageUrl}
          alt=""
          className="rounded-md mb-2 max-h-48 object-cover w-full"
        />
      )}
      <p
        className={`leading-relaxed ${
          message.role === "user"
            ? "text-purple-200 italic"
            : isLatest
              ? "text-white"
              : "text-gray-300"
        }`}
        style={{ fontFamily: '"Georgia", "Times New Roman", serif' }}
      >
        {message.content}
      </p>
    </div>
  );
}

export default function OverlayPage({ params }: { params: Promise<{ chatId: string }> }) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Resolve async params
  useEffect(() => {
    params.then((p) => setChatId(p.chatId));
  }, [params]);

  // URL query params
  const [transparent, setTransparent] = useState(false);
  const [passages, setPassages] = useState(3);
  const [pollInterval, setPollInterval] = useState(3000);
  const [fontSize, setFontSize] = useState(18);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("transparent") === "1") setTransparent(true);
    if (sp.get("passages")) setPassages(Math.max(1, Math.min(10, parseInt(sp.get("passages")!, 10))));
    if (sp.get("poll")) setPollInterval(Math.max(1000, parseInt(sp.get("poll")!, 10)));
    if (sp.get("fontSize")) setFontSize(Math.max(12, Math.min(40, parseInt(sp.get("fontSize")!, 10))));
  }, []);

  // Polling
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!chatId) return;

    async function poll() {
      try {
        const [statusRes, voteRes] = await Promise.all([
          fetch(`/api/stream/status`, { cache: "no-store" }),
          fetch(`/api/stream/vote`, { cache: "no-store" }),
        ]);

        if (!statusRes.ok) {
          setError(`Status ${statusRes.status}`);
          return;
        }

        const statusData = await statusRes.json();
        const voteData = voteRes.ok ? await voteRes.json() : { active: false };

        setStatus({
          chatTitle: statusData.chatTitle,
          messages: (statusData.messages || []).filter((m: Message) => m.role === "assistant" || m.role === "user"),
          voting: voteData.active ? voteData.vote : null,
        });
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    }

    poll();
    timerRef.current = setInterval(poll, pollInterval);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [chatId, pollInterval]);

  const messages = (status?.messages ?? []).slice(-passages);
  const latestId = messages.findLast((m) => m.role === "assistant")?.id;
  const vote = status?.voting;

  return (
    <div
      className={`min-h-screen font-sans ${transparent ? "bg-transparent" : "bg-black/90"} text-white`}
      style={{ fontSize: `${fontSize}px` }}
    >
      <div className="max-w-2xl mx-auto p-6 pt-8">
        {/* Story title */}
        {status?.chatTitle && (
          <p className="text-xs tracking-widest text-purple-400 uppercase mb-4 opacity-70">
            {status.chatTitle}
          </p>
        )}

        {/* Error state */}
        {error && (
          <div className="text-red-400 text-sm mb-4 p-2 border border-red-400/30 rounded">
            Connection error: {error}
          </div>
        )}

        {/* Story passages */}
        {messages.length === 0 && !error && (
          <p className="text-gray-500 italic text-sm">Waiting for story to begin…</p>
        )}
        {messages.map((m) => (
          <StoryPassage key={m.id} message={m} isLatest={m.id === latestId} />
        ))}

        {/* Voting panel */}
        {vote && (
          <div className="mt-6 border-t border-white/10 pt-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs tracking-widest text-purple-400 uppercase">
                Chat Vote
              </p>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400">
                  {vote.uniqueVoters ?? 0} voter{(vote.uniqueVoters ?? 0) !== 1 ? "s" : ""}
                </span>
                <span
                  className={`text-sm font-mono font-bold tabular-nums ${
                    (vote.remainingSeconds ?? 0) <= 5 ? "text-red-400" : "text-green-400"
                  }`}
                >
                  {vote.remainingSeconds ?? 0}s
                </span>
              </div>
            </div>
            <div>
              {(vote.entries ?? []).slice(0, 5).map((entry, i) => (
                <VoteMeter
                  key={i}
                  entry={entry}
                  maxVotes={(vote.entries ?? [])[0]?.votes ?? 1}
                />
              ))}
              {(vote.entries ?? []).length === 0 && (
                <p className="text-gray-500 text-xs italic">No votes yet…</p>
              )}
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Use !do, !say, or !story in chat to vote
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

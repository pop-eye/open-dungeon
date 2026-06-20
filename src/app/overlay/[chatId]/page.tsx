"use client";

/**
 * OBS Overlay — /overlay/[chatId]
 *
 * 16:9 two-column layout designed for a 1920×1080 browser source.
 *   Left  (~60%): story passages, anchored to the bottom
 *   Right (~40%): latest scene image, vote panel, commands reference
 *
 * URL params:
 *   ?transparent=1  — remove background (check "Allow transparency" in OBS)
 *   ?passages=N     — recent passages to show (default 3)
 *   ?poll=N         — polling interval ms (default 3000)
 *   ?fontSize=N     — base font size px (default 18)
 *   ?commands=1     — show viewer commands panel in the right column
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
  remainingSeconds: number;
  windowSeconds?: number;
  totalVotes?: number;
  uniqueVoters?: number;
  entries?: VoteEntry[];
};

type StatusPayload = {
  chatTitle: string | null;
  messages: Message[];
  voting: VoteState | null;
  lastSubmittedBy: string | null;
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
    <div className="mb-1.5">
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

function StoryPassage({
  message,
  isLatest,
  submittedBy,
}: {
  message: Message;
  isLatest: boolean;
  submittedBy?: string | null;
}) {
  return (
    <div className={`mb-4 transition-opacity duration-700 ${isLatest ? "opacity-100" : "opacity-45"}`}>
      {message.role === "user" && (
        <p className="text-purple-300 text-xs font-semibold tracking-widest uppercase mb-1 opacity-70">
          {isLatest && submittedBy ? `@${submittedBy}` : "Action"}
        </p>
      )}
      <p
        className={`leading-relaxed ${
          message.role === "user" ? "text-purple-200 italic" : isLatest ? "text-white" : "text-gray-400"
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

  useEffect(() => {
    params.then((p) => setChatId(p.chatId));
  }, [params]);

  const [transparent, setTransparent] = useState(false);
  const [passages, setPassages] = useState(3);
  const [pollInterval, setPollInterval] = useState(3000);
  const [fontSize, setFontSize] = useState(36);
  const [showCommands, setShowCommands] = useState(true);

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("transparent") === "1") setTransparent(true);
    if (sp.get("passages")) setPassages(Math.max(1, Math.min(10, parseInt(sp.get("passages")!, 10))));
    if (sp.get("poll")) setPollInterval(Math.max(1000, parseInt(sp.get("poll")!, 10)));
    if (sp.get("fontSize")) setFontSize(Math.max(12, Math.min(36, parseInt(sp.get("fontSize")!, 10))));
    if (sp.get("commands") === "0") setShowCommands(false);
  }, []);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!chatId) return;

    async function poll() {
      try {
        const [statusRes, voteRes] = await Promise.all([
          fetch(`/api/stream/status?chatId=${encodeURIComponent(chatId!)}`, { cache: "no-store" }),
          fetch(`/api/stream/vote`, { cache: "no-store" }),
        ]);
        if (!statusRes.ok) { setError(`Status ${statusRes.status}`); return; }

        const statusData = await statusRes.json();
        const voteData = voteRes.ok ? await voteRes.json() : { active: false };

        setStatus({
          chatTitle: statusData.chatTitle,
          messages: (statusData.messages || []).filter(
            (m: Message) => m.role === "assistant" || m.role === "user",
          ),
          voting: voteData.active ? voteData.vote : null,
          lastSubmittedBy: statusData.lastSubmittedBy ?? null,
        });
        setError(null);
      } catch (e) {
        setError(String(e));
      }
    }

    poll();
    timerRef.current = setInterval(poll, pollInterval);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [chatId, pollInterval]);

  const messages = (status?.messages ?? []).slice(-passages);
  const latestId = messages.findLast((m) => m.role === "assistant")?.id;
  const latestUserId = messages.findLast((m) => m.role === "user")?.id;
  const latestImage = messages.findLast((m) => m.imageUrl)?.imageUrl ?? null;
  const vote = status?.voting;

  return (
    <div
      className={`fixed inset-0 flex ${transparent ? "bg-transparent" : "bg-black/85"} text-white`}
      style={{ fontSize: `${fontSize}px` }}
    >
      {/* ── Left column: story text, anchored to bottom ───────────────────── */}
      <div className="flex flex-col justify-end w-[58%] h-full px-8 pb-8">
        {status?.chatTitle && (
          <p className="text-[10px] tracking-widest text-purple-400 uppercase mb-4 opacity-60">
            {status.chatTitle}
          </p>
        )}

        {error && (
          <div className="text-red-400 text-xs mb-3 p-2 border border-red-400/30 rounded">
            {error}
          </div>
        )}

        {messages.length === 0 && !error && (
          <p className="text-gray-500 italic text-sm">Waiting for story to begin…</p>
        )}

        {messages.map((m) => (
          <StoryPassage
            key={m.id}
            message={m}
            isLatest={m.id === latestId}
            submittedBy={m.id === latestUserId ? status?.lastSubmittedBy : null}
          />
        ))}
      </div>

      {/* ── Right column: image + vote + commands ─────────────────────────── */}
      <div className="flex flex-col w-[42%] h-full px-6 py-8 gap-4">
        {/* Scene image — takes available space at top */}
        <div className="flex-1 flex items-start">
          {latestImage ? (
            <img
              src={latestImage}
              alt=""
              className="w-full rounded-lg object-contain max-h-full shadow-2xl"
            />
          ) : (
            <div className="w-full aspect-square rounded-lg bg-white/5 border border-white/10 flex items-center justify-center">
              <span className="text-gray-600 text-xs">No image yet</span>
            </div>
          )}
        </div>

        {/* Vote panel */}
        {vote && (
          <div className="bg-black/50 border border-white/10 rounded-lg p-4 backdrop-blur-sm">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[10px] tracking-widest text-purple-400 uppercase font-semibold">
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
            {(vote.entries ?? []).length === 0 ? (
              <p className="text-gray-500 text-xs italic">No votes yet…</p>
            ) : (
              (vote.entries ?? []).slice(0, 5).map((entry, i) => (
                <VoteMeter key={i} entry={entry} maxVotes={(vote.entries ?? [])[0]?.votes ?? 1} />
              ))
            )}
            <p className="text-[10px] text-gray-500 mt-2">Use !do, !say, or !story to vote</p>
          </div>
        )}

        {/* Commands reference */}
        {showCommands && (
          <div className="bg-black/50 border border-white/10 rounded-lg p-4 backdrop-blur-sm">
            <p className="text-[28px] text-amber-300 font-semibold mb-3">
              🧪 Just testing — give it a try!
            </p>
            <p className="text-[30px] tracking-widest text-purple-400 uppercase font-semibold mb-2">
              Commands
            </p>
            <table className="w-full border-collapse text-[36px]">
              <tbody>
                {[
                  ["!do <action>", "perform an action"],
                  ["!say <words>", "say something"],
                  ["!continue", "advance story"],
                  ["!odhelp", "all commands"],
                ].map(([cmd, desc]) => (
                  <tr key={cmd}>
                    <td className="pr-3 py-1 text-purple-300 font-mono whitespace-nowrap">{cmd}</td>
                    <td className="py-1 text-gray-400">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

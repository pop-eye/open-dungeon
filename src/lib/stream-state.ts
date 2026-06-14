/**
 * In-process singleton for stream/Twitch state.
 *
 * Lives in a global so it survives hot-reload in dev and is shared across
 * all Next.js API route modules (they run in the same Node.js process).
 */

export type VoteEntry = {
  username: string;
  command: "do" | "say" | "story" | "continue";
  text: string;
  votes: number;
  firstAt: number;
};

export type VoteState = {
  chatId: string;
  openedAt: number;
  closesAt: number;
  windowSeconds: number;
  entries: Map<string, VoteEntry>; // keyed by normalized text
  voterMap: Map<string, string>;   // username → normalized text (last vote wins)
};

export type StreamState = {
  activeChatId: string | null;
  voting: VoteState | null;
  lastTurnAt: number | null;
  lastTurnSummary: string | null;
  /** Tracks when each donor last triggered a story event (username → timestamp ms). */
  donationCooldowns: Map<string, number>;
  /** Timestamp of the last processed donation event. */
  lastDonationAt: number | null;
};

declare global {
  var __streamState: StreamState | undefined;
}

function makeState(): StreamState {
  return {
    activeChatId: null,
    voting: null,
    lastTurnAt: null,
    lastTurnSummary: null,
    donationCooldowns: new Map(),
    lastDonationAt: null,
  };
}

export function getStreamState(): StreamState {
  if (!global.__streamState) {
    global.__streamState = makeState();
  }
  return global.__streamState;
}

export function setActiveChatId(id: string | null): void {
  getStreamState().activeChatId = id;
}

export function openVote(chatId: string, windowSeconds: number): VoteState {
  const state = getStreamState();
  const now = Date.now();
  state.voting = {
    chatId,
    openedAt: now,
    closesAt: now + windowSeconds * 1000,
    windowSeconds,
    entries: new Map(),
    voterMap: new Map(),
  };
  return state.voting;
}

export function castVote(
  vote: VoteState,
  username: string,
  command: VoteEntry["command"],
  text: string,
): void {
  const key = `${command}:${text.toLowerCase().trim()}`;

  // Remove previous vote from this user
  const prev = vote.voterMap.get(username);
  if (prev && prev !== key) {
    const e = vote.entries.get(prev);
    if (e) {
      e.votes = Math.max(0, e.votes - 1);
      if (e.votes === 0) vote.entries.delete(prev);
    }
  }

  // Add / increment new vote
  vote.voterMap.set(username, key);
  const existing = vote.entries.get(key);
  if (existing) {
    existing.votes++;
  } else {
    vote.entries.set(key, { username, command, text, votes: 1, firstAt: Date.now() });
  }
}

export function closeVote(): VoteEntry | null {
  const state = getStreamState();
  const vote = state.voting;
  state.voting = null;
  if (!vote || vote.entries.size === 0) return null;
  // Pick the entry with the most votes; ties go to earliest submission
  return [...vote.entries.values()].sort((a, b) =>
    b.votes !== a.votes ? b.votes - a.votes : a.firstAt - b.firstAt,
  )[0];
}

export function clearVote(): void {
  getStreamState().voting = null;
}

/**
 * Check whether a donation from `username` should fire a story event.
 *
 * Two independent cooldowns prevent spam:
 *   - Per-user: one event per donor per `userCooldownSeconds` (default 60)
 *   - Global:   one event per `globalCooldownSeconds` across all donors (default 15)
 *
 * Returns `{ allowed: true }` or `{ allowed: false, reason: string }`.
 * When allowed, records the current timestamp so subsequent calls respect the cooldown.
 */
export function canFireDonation(
  username: string,
  userCooldownSeconds: number,
  globalCooldownSeconds: number,
): { allowed: true } | { allowed: false; reason: string } {
  const state = getStreamState();
  const now = Date.now();

  if (state.lastDonationAt !== null) {
    const globalGapMs = now - state.lastDonationAt;
    if (globalGapMs < globalCooldownSeconds * 1000) {
      return {
        allowed: false,
        reason: `Global cooldown: ${Math.ceil((globalCooldownSeconds * 1000 - globalGapMs) / 1000)}s remaining`,
      };
    }
  }

  const lastUserAt = state.donationCooldowns.get(username.toLowerCase());
  if (lastUserAt !== undefined) {
    const userGapMs = now - lastUserAt;
    if (userGapMs < userCooldownSeconds * 1000) {
      return {
        allowed: false,
        reason: `Per-user cooldown for ${username}: ${Math.ceil((userCooldownSeconds * 1000 - userGapMs) / 1000)}s remaining`,
      };
    }
  }

  state.donationCooldowns.set(username.toLowerCase(), now);
  state.lastDonationAt = now;
  return { allowed: true };
}

export function serializeVoteState(vote: VoteState) {
  const entries = [...vote.entries.values()].sort((a, b) =>
    b.votes !== a.votes ? b.votes - a.votes : a.firstAt - b.firstAt,
  );
  return {
    chatId: vote.chatId,
    openedAt: vote.openedAt,
    closesAt: vote.closesAt,
    windowSeconds: vote.windowSeconds,
    remainingSeconds: Math.max(0, Math.round((vote.closesAt - Date.now()) / 1000)),
    totalVotes: [...vote.entries.values()].reduce((s, e) => s + e.votes, 0),
    uniqueVoters: vote.voterMap.size,
    entries: entries.slice(0, 10),
  };
}

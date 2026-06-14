# Streaming Open Dungeon on Twitch

This guide covers setting up Open Dungeon for live streaming with audience
participation — viewers vote on story actions through Twitch chat, and optionally
trigger special story events through donations.

---

## Architecture overview

```
Twitch chat
    ↓ tmi.js
twitch-bot/bot.mjs          (npm run stream:bot)
    ↓ HTTP
/api/stream/vote            vote management
/api/stream/turn            submits turns to the story
/api/stream/status          sets the active chat

Open Dungeon server         (npm run dev / npm start)
    ↓ polls
/overlay/[chatId]           OBS browser source (stream-friendly overlay)

StreamElements / StreamLabs
    ↓ webhook
/api/stream/donation        donation-triggered story events
```

---

## 1. Configure the server

Add to your `.env.local`:

```env
# Pick a long random string — the bot reads this automatically from .env.local,
# so you only need to set it once here.
STREAM_API_SECRET=some-long-random-secret-string

# Needed so the turn route can call /api/story internally
NEXTAUTH_URL=http://localhost:3000
```

---

## 2. Configure the bot

```bash
cp twitch-bot/.env.example twitch-bot/.env
```

Edit `twitch-bot/.env` — only the Twitch credentials are required here.
`STREAM_API_SECRET` is read automatically from the project root `.env.local`:

```env
TWITCH_BOT_USERNAME=YourBotAccount
TWITCH_BOT_OAUTH_TOKEN=oauth:xxxxxxxxxxxxxxxxxxxxxxxx
TWITCH_CHANNEL=YourChannelName
OPEN_DUNGEON_URL=http://localhost:3000
# STREAM_API_SECRET — leave blank; auto-loaded from ../.env.local
```

Get the OAuth token at https://twitchapps.com/tmi/ — log in as the **bot account**
(not your main account).

---

## 3. Start everything

```bash
# Terminal 1 — Open Dungeon
npm run dev

# Terminal 2 — Image generation (optional but recommended)
npm run image:server

# Terminal 3 — Twitch bot
npm run stream:bot
```

---

## 4. Set the active chat

The bot needs to know which story chat to submit turns to. A mod types in chat:

```
!chat <chatId>
```

The chat ID appears in the URL when you open a story: `http://localhost:3000/?chat=abc123`

---

## 5. Add the OBS overlay

In OBS, add a **Browser Source**:

```
URL:    http://localhost:3000/overlay/<chatId>
Width:  800
Height: 600
```

Check **"Allow Transparency"** and use Chroma Key or add `?transparent=1` to the URL.

**URL options:**

| Parameter | Default | Description |
|---|---|---|
| `?transparent=1` | off | Remove background (for OBS transparency) |
| `?passages=N` | 3 | Number of recent story passages to show |
| `?fontSize=N` | 18 | Base font size in pixels |
| `?poll=N` | 3000 | Polling interval in milliseconds |

Example: `http://localhost:3000/overlay/abc123?transparent=1&passages=4&fontSize=20`

---

## 6. Viewer commands (Twitch chat)

| Command | Effect |
|---|---|
| `!do <action>` | Player performs an action |
| `!say <words>` | Player says something |
| `!story <directive>` | Story directive to the narrator |
| `!continue` | Advance the story without input |
| `!odhelp` | Shows the command list in chat |

**Mod-only:**

| Command | Effect |
|---|---|
| `!vote [seconds]` | Open a voting round (default: 30s) |
| `!endvote` | Close vote immediately and submit winner |
| `!cancelvote` | Discard current vote without submitting |
| `!chat <id>` | Set which story the bot controls |

---

## 7. Voting modes

### Voting mode (default)

Viewers type commands — they go into a vote pool. After the window, the most-voted
action wins and is submitted automatically.

```
MOD_ONLY_VOTE_OPEN=true     # only mods can start a vote with !vote
VOTE_WINDOW_SECONDS=30      # how long to collect votes
DIRECT_SUBMIT=false         # viewer commands only count as votes, not direct actions
```

**Example session:**
1. Mod types `!vote 45` → bot announces "Vote open for 45 seconds!"
2. Viewers type `!do run away`, `!do fight the dragon`, `!say I surrender`, etc.
3. Timer hits zero → bot announces winner, submits it, echoes the story response

### Direct submit mode

The first valid command goes straight through (useful for small/trusted chats):

```env
DIRECT_SUBMIT=true
RATE_LIMIT_SECONDS=15       # minimum gap between submissions
```

Viewers can still trigger a vote manually with `!vote`.

---

## 8. Donation events (optional)

### StreamElements

1. Go to **streamelements.com → Overlays → Webhooks**
2. Add a webhook pointing to `https://your-domain.com/api/stream/donation`
3. Set the secret header `X-Donation-Secret: <DONATION_WEBHOOK_SECRET>`
4. Add to `.env.local`:
   ```env
   DONATION_WEBHOOK_SECRET=your-streamelements-secret
   DONATION_MIN_AMOUNT=1
   ```

### StreamLabs

1. Go to **streamlabs.com → Settings → API Settings → Webhook Settings**
2. Add endpoint: `https://your-domain.com/api/stream/donation`
3. The payload uses the same secret header

### What happens

| Donation amount | Story effect |
|---|---|
| Any (with message) | Donor's message injected as a story directive |
| < $10 (no message) | Small surprising detail added |
| ≥ $10 (no message) | Unexpected twist added |
| ≥ $50 (no message) | Dramatic, pivotal moment |

> **Note:** The donation webhook requires your Open Dungeon instance to be publicly
> accessible (not just `localhost`). Use [ngrok](https://ngrok.com) for local
> testing or deploy to a VPS/cloud host for production.

---

## 9. Remote access via Tailscale

For streaming from one machine and running the server on another, use Tailscale
(already supported via `npm run dev:tailscale`):

```bash
npm run dev:tailscale       # binds to 0.0.0.0:3002
npm run stream:bot          # bot connects to OPEN_DUNGEON_URL=http://<tailscale-ip>:3002
```

---

## 10. Monetization notes

Open Dungeon itself has no built-in monetisation — all event triggers are
donation-agnostic (the webhook just routes amounts to story tiers). Standard
Twitch monetisation options all work alongside it:

- **Bits / Channel Points** — not wired up out of the box; the StreamElements
  webhook can be configured to send tip events for both.
- **Sub events** — not wired up; could be added to the donation webhook endpoint
  by parsing the `type` field.
- **Tips / donations** — fully supported via the webhook above.

Extending the donation handler for subs/bits is a straightforward addition to
`src/app/api/stream/donation/route.ts`.

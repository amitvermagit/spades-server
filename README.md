# Spades Royale — Server

## Deploy to Render.com

1. Push this folder to GitHub
2. Go to render.com → New → Web Service
3. Connect repo
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Plan: Free

## Environment Variables (add in Render dashboard)

| Variable | Value |
|---|---|
| `RENDER_EXTERNAL_URL` | Your Render URL e.g. `https://spades-server-xjlq.onrender.com` |

Setting `RENDER_EXTERNAL_URL` enables the self-ping every 14 minutes which prevents
the free tier from sleeping mid-game.

## Reliability features
- Ping/pong keepalive every 25s — dead connections terminated automatically
- Rooms expire after 2 hours maximum
- Self-ping every 14 min prevents Render free tier sleep during active games
- Graceful reconnect support (rejoin message)

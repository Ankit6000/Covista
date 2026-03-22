# RoomFlix Watch Party

RoomFlix is a watch-party app with:

- shared room links
- live chat
- WebRTC video call sidebar
- host-controlled browser stream
- guest control requests for the shared browser

## Architecture

This project has two runtime pieces:

1. Web app + backend
- React/Vite frontend
- Express + Socket.IO backend
- serves the room UI and realtime room state

2. Electron desktop host
- used by the host for the real browser session
- streams that browser session to guests
- enables host-side navigation/mouse/keyboard relay

Important: if you want the current "host browser" experience to work fully, the host still needs the Electron desktop app. A plain website deployment alone will not replace that desktop-hosted browser session.

## Local development

Install dependencies:

```bash
npm install
```

Run web app + backend:

```bash
npm run dev
```

Run desktop host mode:

```bash
npm run desktop
```

## Production deployment

### 1. Deploy the web app + backend

This repo is ready for Render deployment.

- `render.yaml` is included
- the server serves the built frontend from `dist/`
- health check path: `/api/health`

Manual commands:

- Build command: `npm install && npm run build`
- Start command: `npm start`

Recommended Render setup:

1. Create a new `Web Service`
2. Connect this GitHub repo
3. Use:
   - Build command: `npm install && npm run build`
   - Start command: `npm start`
4. Add environment variables only if you have TURN:
   - `TURN_URLS`
   - `TURN_USERNAME`
   - `TURN_CREDENTIAL`
5. Deploy

After deploy, your public app URL will look like:

- `https://your-app-name.onrender.com`

### 2. Configure TURN

For better WebRTC reliability across real networks, configure a TURN server.

Environment variables:

- `TURN_URLS`
- `TURN_USERNAME`
- `TURN_CREDENTIAL`

Example values are in [.env.example](C:/Users/Ankit/Documents/New%20project/.env.example).

If these are not set, the app falls back to public STUN only.

### 3. Distribute the Electron host app

The host browser session is currently provided by Electron. For real use, package the Electron host app and distribute it separately to hosts.

Current practical distribution options:

#### Option A: Fastest for testing

Share the project with a host and have them run:

```bash
npm install
HOSTED_WEB_APP_URL=https://your-render-app.onrender.com npm run desktop
```

On Windows CMD:

```cmd
set HOSTED_WEB_APP_URL=https://your-render-app.onrender.com
npm run desktop
```

This is the easiest way to validate the deployed web app + desktop host flow.

#### Option B: Real desktop distribution

Package the Electron host app and publish it through GitHub Releases or an installer.

For production distribution, the packaged host app should launch with:

- `HOSTED_WEB_APP_URL=https://your-render-app.onrender.com`

That lets the desktop host app open the deployed website while still exposing the Electron host-browser controls.

## Recommended deployment stack

- Render for the web app + backend
- coturn on a VPS / Docker host for TURN
- GitHub Releases or packaged installer for the Electron host app

## Environment variables

Optional server env vars:

- `PORT`
- `TURN_URLS`
- `TURN_USERNAME`
- `TURN_CREDENTIAL`
- `HOSTED_WEB_APP_URL` for packaged Electron host usage

## Notes

- `node_modules`, `dist`, and log files should not be committed
- many DRM-heavy streaming sites may still have platform limitations
- TURN is strongly recommended before expecting reliable public internet calls

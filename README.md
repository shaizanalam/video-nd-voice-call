# video-nd-voice-call

Ultra-low bandwidth international peer-to-peer audio and video communication application built with WebRTC, Socket.IO, Express, and Push-To-Talk (PTT) capabilities tailored for weak/spotty networks.

## Features

- **Ultra-Low Bandwidth Audio**: Tailored Opus codec settings (6 kbps bitrate) for spotty 2G/3G connections.
- **Push-To-Talk (Walkie-Talkie Mode)**: Saves bandwidth by streaming voice data only when the talk button is held.
- **Adaptive Video & WebRTC P2P**: Direct peer-to-peer audio/video streaming with ICE/STUN/TURN signaling.
- **Production Ready**: Includes `Dockerfile` and `render.yaml` for instant deployment.

## Getting Started

### Prerequisites
- Node.js (v18+ recommended)
- npm

### Installation

```bash
# Install dependencies
npm install
```

### Running Locally

```bash
# Start server
npm start

# Or run with live reload
npm run dev
```

The application will be accessible at `http://localhost:3000` (or the configured `PORT`).

### Testing

```bash
npm test
```

## License

MIT

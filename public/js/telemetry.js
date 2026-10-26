/**
 * PULSE-LINK: Real-Time Telemetry Monitor & Neo-Brutalist HUD Sparkline
 * Inspects WebRTC getStats() reports every 1000ms for RTT, loss, bitrate, and ICE path.
 */

class TelemetryMonitor {
  /**
   * @param {Object} options
   * @param {HTMLCanvasElement} [options.canvas] - Target canvas for sparkline rendering
   * @param {Function} [options.onStatsUpdate] - Callback receiving computed metrics
   */
  constructor(options = {}) {
    this.canvas = options.canvas || null;
    this.onStatsUpdate = options.onStatsUpdate || null;

    this.timer = null;
    this.peerConnection = null;

    // Previous sample caches for delta calculation
    this.lastOutboundBytes = 0;
    this.lastInboundBytes = 0;
    this.lastTimestamp = 0;

    // History buffers for sparkline graph (last 30 samples)
    this.maxHistory = 30;
    this.historyBitrate = new Array(this.maxHistory).fill(0);
    this.historyLoss = new Array(this.maxHistory).fill(0);

    // Latest computed metrics
    this.metrics = {
      outboundKbps: 0,
      inboundKbps: 0,
      totalKbps: 0,
      rttMs: 0,
      packetLossPercent: 0,
      jitterMs: 0,
      connectionPath: 'DISCONNECTED', // DIRECT P2P, TURN RELAY, or DISCONNECTED
      transportProto: 'NONE'         // UDP, TCP-443, etc.
    };

    if (this.canvas) {
      this.initCanvas();
    }
  }

  setPeerConnection(pc) {
    this.peerConnection = pc;
    this.resetStats();
  }

  initCanvas() {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();

    if (rect.width > 0 && rect.height > 0) {
      this.canvas.width = rect.width * dpr;
      this.canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);
    }
  }

  start(intervalMs = 1000) {
    this.stop();
    this.timer = setInterval(() => this.pollStats(), intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  resetStats() {
    this.lastOutboundBytes = 0;
    this.lastInboundBytes = 0;
    this.lastTimestamp = 0;
    this.historyBitrate.fill(0);
    this.historyLoss.fill(0);
  }

  async pollStats() {
    if (!this.peerConnection) return;

    try {
      const stats = await this.peerConnection.getStats();
      const now = Date.now();

      let currentOutboundBytes = 0;
      let currentInboundBytes = 0;
      let packetsLost = 0;
      let packetsReceived = 0;
      let jitter = 0;
      let currentRtt = 0;
      let activeCandidatePair = null;
      let localCandidate = null;
      let remoteCandidate = null;

      const candidatesMap = new Map();

      stats.forEach((report) => {
        // Collect candidate details
        if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
          candidatesMap.set(report.id, report);
        }

        // Active candidate pair
        if (report.type === 'candidate-pair' && (report.selected || report.state === 'succeeded')) {
          activeCandidatePair = report;
          if (report.currentRoundTripTime !== undefined) {
            currentRtt = Math.round(report.currentRoundTripTime * 1000);
          }
        }

        // Outbound audio/video streams
        if (report.type === 'outbound-rtp') {
          currentOutboundBytes += report.bytesSent || 0;
        }

        // Inbound audio/video streams
        if (report.type === 'inbound-rtp') {
          currentInboundBytes += report.bytesReceived || 0;
          packetsLost += report.packetsLost || 0;
          packetsReceived += report.packetsReceived || 0;
          if (report.jitter !== undefined) {
            jitter = Math.max(jitter, Math.round(report.jitter * 1000));
          }
        }
      });

      // Calculate connection path & protocol
      let pathType = 'DIRECT P2P (UDP)';
      let protoType = 'UDP';

      if (activeCandidatePair) {
        localCandidate = candidatesMap.get(activeCandidatePair.localCandidateId);
        remoteCandidate = candidatesMap.get(activeCandidatePair.remoteCandidateId);

        const isRelay = (localCandidate && localCandidate.candidateType === 'relay') ||
                        (remoteCandidate && remoteCandidate.candidateType === 'relay');

        const protocol = (localCandidate && localCandidate.protocol) ||
                         (remoteCandidate && remoteCandidate.protocol) || 'udp';

        protoType = protocol.toUpperCase();

        if (isRelay) {
          pathType = `TURN RELAY (${protoType})`;
        } else {
          pathType = `DIRECT P2P (${protoType})`;
        }
      }

      // Bitrate deltas
      let outboundKbps = 0;
      let inboundKbps = 0;

      if (this.lastTimestamp > 0) {
        const timeDeltaSeconds = (now - this.lastTimestamp) / 1000;
        if (timeDeltaSeconds > 0) {
          outboundKbps = Math.max(0, ((currentOutboundBytes - this.lastOutboundBytes) * 8) / 1000 / timeDeltaSeconds);
          inboundKbps = Math.max(0, ((currentInboundBytes - this.lastInboundBytes) * 8) / 1000 / timeDeltaSeconds);
        }
      }

      this.lastOutboundBytes = currentOutboundBytes;
      this.lastInboundBytes = currentInboundBytes;
      this.lastTimestamp = now;

      // Packet loss calculation
      const totalPackets = packetsReceived + packetsLost;
      const packetLossPercent = totalPackets > 0
        ? Math.min(100, Math.max(0, ((packetsLost / totalPackets) * 100)))
        : 0;

      // Update metrics state
      this.metrics = {
        outboundKbps: parseFloat(outboundKbps.toFixed(1)),
        inboundKbps: parseFloat(inboundKbps.toFixed(1)),
        totalKbps: parseFloat((outboundKbps + inboundKbps).toFixed(1)),
        rttMs: currentRtt,
        packetLossPercent: parseFloat(packetLossPercent.toFixed(1)),
        jitterMs: jitter,
        connectionPath: pathType,
        transportProto: protoType
      };

      // Push to history for sparkline
      this.historyBitrate.shift();
      this.historyBitrate.push(this.metrics.totalKbps);

      this.historyLoss.shift();
      this.historyLoss.push(this.metrics.packetLossPercent);

      // Render sparkline
      this.renderSparkline();

      // Trigger listener
      if (typeof this.onStatsUpdate === 'function') {
        this.onStatsUpdate(this.metrics);
      }
    } catch (err) {
      console.warn('[TelemetryMonitor] Polling error:', err);
    }
  }

  renderSparkline() {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext('2d');
    const width = this.canvas.width;
    const height = this.canvas.height;

    // Clear with semi-transparent obsidian background
    ctx.clearRect(0, 0, width, height);

    const step = width / (this.maxHistory - 1);
    const maxBw = Math.max(20, ...this.historyBitrate);

    // 1. Draw Bitrate Graph (Cyan / Emerald Line)
    ctx.beginPath();
    ctx.strokeStyle = '#06b6d4'; // Cyan
    ctx.lineWidth = 2;

    for (let i = 0; i < this.maxHistory; i++) {
      const val = this.historyBitrate[i];
      const x = i * step;
      const y = height - (val / maxBw) * (height - 8) - 4;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 2. Draw Packet Loss Overlay (Crimson Dashed Line if loss > 0)
    const hasLoss = this.historyLoss.some(l => l > 0);
    if (hasLoss) {
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#ef4444'; // Crimson
      ctx.lineWidth = 1.5;

      for (let i = 0; i < this.maxHistory; i++) {
        const loss = this.historyLoss[i];
        const x = i * step;
        const y = height - (loss / 100) * (height - 8) - 4;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]); // Reset
    }
  }
}

if (typeof window !== 'undefined') {
  window.TelemetryMonitor = TelemetryMonitor;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TelemetryMonitor;
}

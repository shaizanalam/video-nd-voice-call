/**
 * PULSE-LINK: SDP Codec Hacker & Bandwidth Governor
 * Dynamically modifies Session Description Protocol (SDP) tokens to force Opus
 * into narrowband mono, 40ms packetization, in-band FEC, and strict bitrate caps.
 */

class SDPHacker {
  /**
   * Optimize Opus codec parameters for extreme low bandwidth and high packet loss.
   * @param {string} sdp - The original SDP offer/answer string
   * @param {Object} config - { audioBitrate: number (bps, default 6000) }
   * @returns {string} - The mutated SDP string
   */
  static optimizeOpus(sdp, config = {}) {
    if (!sdp || typeof sdp !== 'string') return sdp;

    const audioBitrate = config.audioBitrate || 6000;

    // 1. Dynamically locate the Opus payload number from a=rtpmap:<id> opus/48000/2
    const opusMatch = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000\/2/i);
    const opusPayload = opusMatch ? opusMatch[1] : '111';

    // 2. Build our aggressive ultra-low bandwidth parameter string
    const opusParams = [
      'minptime=20',
      'ptime=40',                 // 40ms frame size cuts packet rate from 50pps to 25pps (saving ~6kbps UDP overhead)
      'useinbandfec=1',           // In-Band Forward Error Correction for lossy cellular links
      'usedtx=1',                 // Discontinuous Transmission: drops to 0 kbps during silence
      'cbr=1',                    // Constant Bitrate prevents buffer bloat and burst congestion
      'stereo=0',                 // Force mono
      'sprop-stereo=0',
      `maxaveragebitrate=${audioBitrate}`, // Strict bitrate ceiling (e.g., 6000 bps)
      'maxplaybackrate=16000'     // Forces narrowband/mediumband SILK speech mode
    ].join(';');

    const lines = sdp.split('\r\n');
    let fmtpFound = false;
    let modifiedLines = [];

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      // Check for existing a=fmtp:<opusPayload> line
      if (line.startsWith(`a=fmtp:${opusPayload} `)) {
        fmtpFound = true;
        // Merge or replace parameters
        line = `a=fmtp:${opusPayload} ${opusParams}`;
      }

      modifiedLines.push(line);

      // If we just pushed the rtpmap line and fmtp doesn't exist yet, insert it right after
      if (line.startsWith(`a=rtpmap:${opusPayload} opus/48000/2`) && !fmtpFound) {
        // Look ahead to see if fmtp is right next; if not, we can inject it
        const nextLine = lines[i + 1] || '';
        if (!nextLine.startsWith(`a=fmtp:${opusPayload}`)) {
          modifiedLines.push(`a=fmtp:${opusPayload} ${opusParams}`);
          fmtpFound = true;
        }
      }
    }

    return modifiedLines.join('\r\n');
  }

  /**
   * Inject b=AS and b=TIAS bandwidth limits into media sections.
   * Enforces SDP-level decoder throttling on both iOS Safari and Android Chrome.
   * @param {string} sdp - The SDP string
   * @param {number} videoKbps - Video limit in kbps (e.g. 32)
   * @param {number} audioKbps - Audio limit in kbps (e.g. 6)
   * @returns {string} - Modified SDP string
   */
  static injectBandwidthBLine(sdp, videoKbps = 32, audioKbps = 6) {
    if (!sdp || typeof sdp !== 'string') return sdp;

    const lines = sdp.split('\r\n');
    const result = [];
    let currentMedia = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Detect m= section headers
      if (line.startsWith('m=video')) {
        currentMedia = 'video';
      } else if (line.startsWith('m=audio')) {
        currentMedia = 'audio';
      } else if (line.startsWith('m=application')) {
        currentMedia = 'application';
      }

      // Skip existing bandwidth lines to avoid duplicates
      if (line.startsWith('b=AS:') || line.startsWith('b=TIAS:')) {
        continue;
      }

      result.push(line);

      // Inject b= lines right after c=IN line in each media section
      if (line.startsWith('c=IN IP4') || line.startsWith('c=IN IP6')) {
        if (currentMedia === 'video' && videoKbps > 0) {
          result.push(`b=AS:${videoKbps}`);
          result.push(`b=TIAS:${Math.round(videoKbps * 1000)}`);
        } else if (currentMedia === 'audio' && audioKbps > 0) {
          result.push(`b=AS:${audioKbps}`);
          result.push(`b=TIAS:${Math.round(audioKbps * 1000)}`);
        }
      }
    }

    return result.join('\r\n');
  }

  /**
   * Prioritize VP8 or H264 for hardware decoding efficiency on mobile devices.
   * @param {string} sdp - The SDP string
   * @param {string} kind - 'video' or 'audio'
   * @param {string} mimeType - e.g. 'VP8' or 'H264'
   * @returns {string} - Modified SDP
   */
  static preferCodec(sdp, kind = 'video', mimeType = 'VP8') {
    if (!sdp || typeof sdp !== 'string') return sdp;

    const lines = sdp.split('\r\n');
    let mLineIndex = -1;
    let preferredPayloads = [];

    // Find payloads matching the mimeType
    const rtpmapRegex = new RegExp(`^a=rtpmap:(\\d+)\\s+${mimeType}/`, 'i');
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(rtpmapRegex);
      if (match) {
        preferredPayloads.push(match[1]);
      }
    }

    if (preferredPayloads.length === 0) return sdp;

    // Locate the corresponding m=<kind> line
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(`m=${kind} `)) {
        mLineIndex = i;
        break;
      }
    }

    if (mLineIndex === -1) return sdp;

    // The m= line format is: m=<kind> <port> <proto> <payload1> <payload2> ...
    const parts = lines[mLineIndex].split(' ');
    if (parts.length > 3) {
      const header = parts.slice(0, 3);
      const existingPayloads = parts.slice(3);

      // Re-order: preferred payloads first, followed by the rest
      const newPayloadOrder = [
        ...preferredPayloads.filter(p => existingPayloads.includes(p)),
        ...existingPayloads.filter(p => !preferredPayloads.includes(p))
      ];

      lines[mLineIndex] = [...header, ...newPayloadOrder].join(' ');
    }

    return lines.join('\r\n');
  }

  /**
   * Combined Master Optimizer applying Opus, Bandwidth, and Codec optimizations
   * @param {string} sdp - Raw SDP string
   * @param {Object} options - { audioBitrate, videoBitrateKbps, preferVp8 }
   */
  static applyAll(sdp, options = {}) {
    let modified = sdp;
    const audioBps = options.audioBitrate || 6000;
    const audioKbps = Math.max(1, Math.ceil(audioBps / 1000));
    const videoKbps = options.videoBitrateKbps || 32;

    // 1. Optimize Opus audio
    modified = SDPHacker.optimizeOpus(modified, { audioBitrate: audioBps });

    // 2. Inject bandwidth caps if video is enabled
    if (videoKbps > 0) {
      modified = SDPHacker.injectBandwidthBLine(modified, videoKbps, audioKbps);
      // Prefer VP8 for maximum WebRTC Android/iOS baseline compatibility
      modified = SDPHacker.preferCodec(modified, 'video', 'VP8');
    } else {
      modified = SDPHacker.injectBandwidthBLine(modified, 0, audioKbps);
    }

    return modified;
  }
}

// Attach to window for standard script usage
if (typeof window !== 'undefined') {
  window.SDPHacker = SDPHacker;
}

// Export for CommonJS / Module bundlers if present
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SDPHacker;
}

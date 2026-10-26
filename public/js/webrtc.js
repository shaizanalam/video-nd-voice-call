/**
 * PULSE-LINK: Adaptive P2P WebRTC Engine & Congestion Governor
 * Handles NAT traversal (STUN/TURN), dynamic sender bitrate throttling,
 * Opus SDP munging, auto-downgrade congestion governor, and vocal clarity DSP.
 */

class WebRTCEngine {
  /**
   * Bandwidth Profiles
   */
  static PROFILES = {
    SURVIVAL_2G: {
      name: '2G Voice Survival',
      description: '6 kbps Voice Only - Max resilience for 2G / EDGE',
      video: false,
      audioBitrate: 6000,
      videoBitrate: 0,
      fps: 0,
      width: 0,
      height: 0
    },
    ULTRA_LOW_VIDEO: {
      name: 'Ultra-Low Video (120p @ 8fps)',
      description: '~40 kbps Total (32k video + 8k voice)',
      video: { width: { ideal: 160, max: 240 }, height: { ideal: 120, max: 180 }, frameRate: { ideal: 8, max: 10 } },
      audioBitrate: 8000,
      videoBitrate: 32000,
      fps: 8,
      width: 160,
      height: 120
    },
    LOW_VIDEO: {
      name: 'Low Video (180p @ 12fps)',
      description: '~87 kbps Total (75k video + 12k voice)',
      video: { width: { ideal: 240, max: 320 }, height: { ideal: 180, max: 240 }, frameRate: { ideal: 12, max: 15 } },
      audioBitrate: 12000,
      videoBitrate: 75000,
      fps: 12,
      width: 240,
      height: 180
    },
    BALANCED_VIDEO: {
      name: 'Balanced Video (240p @ 15fps)',
      description: '~170 kbps Total (150k video + 20k voice)',
      video: { width: { ideal: 320, max: 480 }, height: { ideal: 240, max: 360 }, frameRate: { ideal: 15, max: 20 } },
      audioBitrate: 20000,
      videoBitrate: 150000,
      fps: 15,
      width: 320,
      height: 240
    }
  };

  /**
   * @param {Object} options
   * @param {Object} options.socket - Socket.io instance
   * @param {string} options.roomId - Active Room ID
   * @param {HTMLVideoElement} [options.localVideo] - Local video preview element
   * @param {HTMLVideoElement} [options.remoteVideo] - Remote video display element
   * @param {string} [options.profileKey='SURVIVAL_2G'] - Initial profile
   * @param {boolean} [options.autoGovernorEnabled=true] - Auto downgrade on lag
   * @param {Function} [options.onStatusChange] - Status state callback
   * @param {Function} [options.onProfileChange] - Callback when profile changes
   * @param {Function} [options.onChatMessage] - Callback when data-channel message arrives
   * @param {Function} [options.onAlert] - Callback for tactical HUD alerts
   */
  constructor(options = {}) {
    this.socket = options.socket;
    this.roomId = options.roomId;
    this.localVideo = options.localVideo || null;
    this.remoteVideo = options.remoteVideo || null;
    this.currentProfileKey = options.profileKey || 'SURVIVAL_2G';
    this.autoGovernorEnabled = options.autoGovernorEnabled !== false;
    this.onStatusChange = options.onStatusChange || null;
    this.onProfileChange = options.onProfileChange || null;
    this.onChatMessage = options.onChatMessage || null;
    this.onAlert = options.onAlert || null;

    this.peerConnection = null;
    this.localStream = null;
    this.remoteStream = null;
    this.dataChannel = null;
    this.isInitiator = false;

    // Congestion Governor Counters
    this.badQualityConsecutiveChecks = 0;
    this.governorThresholdChecks = 3; // 3 consecutive checks (~3-4.5 seconds)

    // Web Audio Vocal Clarity Pipeline
    this.audioCtx = null;
    this.vocalFilterSource = null;
    this.vocalFilterBiquad = null;
    this.vocalCompressor = null;
    this.vocalBoostEnabled = false;

    // ICE Configuration
    this.iceConfig = this.buildIceConfiguration();

    this.setupSocketEvents();
  }

  buildIceConfiguration() {
    // Default high-piercing STUN/TURN topology
    const iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443',
          'turn:openrelay.metered.ca:443?transport=tcp'
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ];

    // Check localStorage for custom TURN settings
    try {
      const customTurn = localStorage.getItem('pulse_custom_turn');
      if (customTurn) {
        const parsed = JSON.parse(customTurn);
        if (parsed.urls) {
          iceServers.unshift(parsed);
        }
      }
    } catch (e) {
      console.warn('[WebRTCEngine] Error reading custom TURN:', e);
    }

    return {
      iceServers,
      iceCandidatePoolSize: 2,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    };
  }

  setupSocketEvents() {
    if (!this.socket) return;

    this.socket.on('peer-ready', async () => {
      this.isInitiator = true;
      this.updateStatus('PEER DETECTED - INITIATING LINK...', 'amber');
      await this.initiateCall();
    });

    this.socket.on('signal', async (data) => {
      await this.handleSignal(data);
    });

    this.socket.on('mode-sync', (data) => {
      if (data.mode && data.mode !== this.currentProfileKey) {
        this.applyProfile(data.mode, false); // sync locally without re-emitting
        if (typeof this.onAlert === 'function') {
          this.onAlert(`[MODE SYNC] Remote peer switched to ${data.mode} (${data.reason || 'Manual'})`);
        }
      }
    });

    this.socket.on('peer-disconnected', (data) => {
      this.updateStatus('PEER DISCONNECTED (RECONNECTING 30s)...', 'crimson');
      if (typeof this.onAlert === 'function') {
        this.onAlert('Peer disconnected. Waiting for auto-reconnect...');
      }
    });
  }

  updateStatus(text, color) {
    if (typeof this.onStatusChange === 'function') {
      this.onStatusChange(text, color);
    }
  }

  /**
   * Acquire local hardware media stream according to current profile
   */
  async acquireMedia(profileKey = this.currentProfileKey) {
    this.currentProfileKey = profileKey;
    const profile = WebRTCEngine.PROFILES[profileKey];

    // Stop previous local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
    }

    const audioConstraints = {
      channelCount: 1,
      sampleRate: 16000,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    };

    const constraints = {
      audio: audioConstraints,
      video: profile.video ? profile.video : false
    };

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);

      if (this.localVideo) {
        this.localVideo.srcObject = this.localStream;
      }

      return this.localStream;
    } catch (err) {
      console.warn('[WebRTCEngine] Failed video constraints, falling back to audio-only:', err);
      // Fallback to audio only
      constraints.video = false;
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.currentProfileKey = 'SURVIVAL_2G';
      return this.localStream;
    }
  }

  /**
   * Initialize PeerConnection instance
   */
  createPeerConnection() {
    if (this.peerConnection) {
      try {
        this.peerConnection.close();
      } catch (e) {}
    }

    this.peerConnection = new RTCPeerConnection(this.iceConfig);

    // Attach local stream tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        this.peerConnection.addTrack(track, this.localStream);
      });
    }

    // ICE candidate generation
    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('signal', {
          roomId: this.roomId,
          type: 'candidate',
          candidate: event.candidate
        });
      }
    };

    // Remote track listener
    this.peerConnection.ontrack = (event) => {
      if (!this.remoteStream) {
        this.remoteStream = new MediaStream();
        if (this.remoteVideo) {
          this.remoteVideo.srcObject = this.remoteStream;
        }
      }
      this.remoteStream.addTrack(event.track);

      // Route audio to Vocal Clarity DSP if enabled
      if (event.track.kind === 'audio') {
        this.setupVocalFilter(event.streams[0] || this.remoteStream);
      }
    };

    // ICE Connection state handler & Auto ICE Restart
    this.peerConnection.oniceconnectionstatechange = async () => {
      const state = this.peerConnection.iceConnectionState;
      if (state === 'connected' || state === 'completed') {
        this.updateStatus('CONNECTED - P2P ENCRYPTED', 'emerald');
        await this.applySenderBitrateLimits();
      } else if (state === 'disconnected') {
        this.updateStatus('ICE DISCONNECTED - RECONNECTING...', 'amber');
        this.restartIceGracefully();
      } else if (state === 'failed') {
        this.updateStatus('ICE FAILED - TRIGGERING ICE RESTART', 'crimson');
        this.restartIceGracefully();
      }
    };

    // Data Channel setup for resilient text
    if (this.isInitiator) {
      this.setupDataChannel(this.peerConnection.createDataChannel('pulse-channel'));
    } else {
      this.peerConnection.ondatachannel = (event) => {
        this.setupDataChannel(event.channel);
      };
    }

    return this.peerConnection;
  }

  setupDataChannel(channel) {
    this.dataChannel = channel;
    this.dataChannel.onopen = () => {
      console.log('[WebRTCEngine] RTCDataChannel Open');
    };
    this.dataChannel.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (typeof this.onChatMessage === 'function') {
          this.onChatMessage(parsed);
        }
      } catch (e) {
        if (typeof this.onChatMessage === 'function') {
          this.onChatMessage({ text: event.data, sender: 'Peer' });
        }
      }
    };
  }

  sendChatMessage(messageObj) {
    const payloadStr = JSON.stringify(messageObj);
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(payloadStr);
      return true;
    } else if (this.socket) {
      // Fallback over Socket.io
      this.socket.emit('chat-msg', {
        roomId: this.roomId,
        ...messageObj
      });
      return true;
    }
    return false;
  }

  /**
   * Initiate Call as Offer Initiator
   */
  async initiateCall() {
    this.createPeerConnection();

    const offer = await this.peerConnection.createOffer();
    const profile = WebRTCEngine.PROFILES[this.currentProfileKey];

    // Munge SDP for Opus 6kbps & b=AS limits
    const hackedSdp = SDPHacker.applyAll(offer.sdp, {
      audioBitrate: profile.audioBitrate,
      videoBitrateKbps: Math.round(profile.videoBitrate / 1000)
    });

    await this.peerConnection.setLocalDescription(new RTCSessionDescription({
      type: 'offer',
      sdp: hackedSdp
    }));

    this.socket.emit('signal', {
      roomId: this.roomId,
      type: 'offer',
      sdp: this.peerConnection.localDescription.sdp
    });
  }

  /**
   * Handle incoming WebRTC signaling messages
   */
  async handleSignal(data) {
    if (!this.peerConnection) {
      this.createPeerConnection();
    }

    if (data.type === 'offer') {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription({
        type: 'offer',
        sdp: data.sdp
      }));

      const answer = await this.peerConnection.createAnswer();
      const profile = WebRTCEngine.PROFILES[this.currentProfileKey];

      const hackedSdp = SDPHacker.applyAll(answer.sdp, {
        audioBitrate: profile.audioBitrate,
        videoBitrateKbps: Math.round(profile.videoBitrate / 1000)
      });

      await this.peerConnection.setLocalDescription(new RTCSessionDescription({
        type: 'answer',
        sdp: hackedSdp
      }));

      this.socket.emit('signal', {
        roomId: this.roomId,
        type: 'answer',
        sdp: this.peerConnection.localDescription.sdp
      });
    } else if (data.type === 'answer') {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription({
        type: 'answer',
        sdp: data.sdp
      }));
    } else if (data.type === 'candidate' && data.candidate) {
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.warn('[WebRTCEngine] Candidate error:', err);
      }
    }
  }

  /**
   * Apply RTCRtpSender parameter limits dynamically on the fly
   */
  async applySenderBitrateLimits() {
    if (!this.peerConnection) return;

    const profile = WebRTCEngine.PROFILES[this.currentProfileKey];
    const senders = this.peerConnection.getSenders();

    for (const sender of senders) {
      if (!sender.track) continue;

      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }

      if (sender.track.kind === 'video') {
        if (profile.videoBitrate > 0) {
          params.encodings[0].maxBitrate = profile.videoBitrate;
          params.encodings[0].maxFramerate = profile.fps || 10;
          params.encodings[0].scaleResolutionDownBy = 1.0;
          params.degradationPreference = 'maintain-resolution'; // preserve visual clarity over framerate
        } else {
          params.encodings[0].maxBitrate = 0;
        }
      } else if (sender.track.kind === 'audio') {
        params.encodings[0].maxBitrate = profile.audioBitrate;
        params.encodings[0].networkPriority = 'high'; // Prioritize voice in router queues
      }

      try {
        await sender.setParameters(params);
      } catch (err) {
        console.warn('[WebRTCEngine] Sender parameters notice:', err);
      }
    }
  }

  /**
   * Change Profile Dynamically
   */
  async applyProfile(profileKey, broadcast = true) {
    if (!WebRTCEngine.PROFILES[profileKey]) return;
    this.currentProfileKey = profileKey;
    const profile = WebRTCEngine.PROFILES[profileKey];

    // Toggle video track enabled state
    if (this.localStream) {
      const videoTrack = this.localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = Boolean(profile.video);
      }
    }

    await this.applySenderBitrateLimits();

    if (broadcast && this.socket) {
      this.socket.emit('mode-sync', {
        roomId: this.roomId,
        mode: profileKey,
        reason: 'User profile change'
      });
    }

    if (typeof this.onProfileChange === 'function') {
      this.onProfileChange(profileKey, profile);
    }
  }

  /**
   * Emergency 2G Kill-Switch: Instantly kill video and lock to 6kbps voice
   */
  async trigger2GEmergencyKillSwitch() {
    if (this.localStream) {
      const videoTrack = this.localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = false;
      }
    }

    await this.applyProfile('SURVIVAL_2G', true);

    if (typeof this.onAlert === 'function') {
      this.onAlert('[KILL-SWITCH] 2G Survival Mode Activated. Video Killed, Audio Capped at 6 kbps.');
    }
  }

  /**
   * Inspect telemetry metrics and auto-downgrade profile if connection is failing
   */
  evaluateCongestionGovernor(metrics) {
    if (!this.autoGovernorEnabled) return;

    // Check conditions: Packet Loss > 12% or RTT > 650ms
    const isDegraded = metrics.packetLossPercent > 12 || metrics.rttMs > 650;

    if (isDegraded) {
      this.badQualityConsecutiveChecks++;
      if (this.badQualityConsecutiveChecks >= this.governorThresholdChecks) {
        this.badQualityConsecutiveChecks = 0;
        this.stepDownProfileTier();
      }
    } else {
      this.badQualityConsecutiveChecks = Math.max(0, this.badQualityConsecutiveChecks - 1);
    }
  }

  stepDownProfileTier() {
    const tierOrder = ['BALANCED_VIDEO', 'LOW_VIDEO', 'ULTRA_LOW_VIDEO', 'SURVIVAL_2G'];
    const currentIndex = tierOrder.indexOf(this.currentProfileKey);

    if (currentIndex >= 0 && currentIndex < tierOrder.length - 1) {
      const nextTier = tierOrder[currentIndex + 1];
      this.applyProfile(nextTier, true);

      const msg = `[AUTO-GOVERNOR] High packet loss/latency detected. Stepped down to ${WebRTCEngine.PROFILES[nextTier].name}`;
      if (typeof this.onAlert === 'function') {
        this.onAlert(msg);
      }
    }
  }

  /**
   * Automatic ICE Restart when roaming or network drops
   */
  async restartIceGracefully() {
    if (!this.peerConnection || this.peerConnection.signalingState === 'closed') return;

    try {
      const offer = await this.peerConnection.createOffer({ iceRestart: true });
      const profile = WebRTCEngine.PROFILES[this.currentProfileKey];

      const hackedSdp = SDPHacker.applyAll(offer.sdp, {
        audioBitrate: profile.audioBitrate,
        videoBitrateKbps: Math.round(profile.videoBitrate / 1000)
      });

      await this.peerConnection.setLocalDescription(new RTCSessionDescription({
        type: 'offer',
        sdp: hackedSdp
      }));

      this.socket.emit('signal', {
        roomId: this.roomId,
        type: 'offer',
        sdp: this.peerConnection.localDescription.sdp
      });
    } catch (err) {
      console.warn('[WebRTCEngine] ICE restart error:', err);
    }
  }

  /**
   * Web Audio API: 300Hz-3400Hz Vocal Clarity Bandpass Filter & Dynamics Compressor
   */
  setupVocalFilter(remoteStream) {
    try {
      if (!this.audioCtx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AudioCtx();
      }

      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      this.vocalFilterSource = this.audioCtx.createMediaStreamSource(remoteStream);

      // Bandpass Filter: Boost speech clarity between 300 Hz and 3400 Hz
      this.vocalFilterBiquad = this.audioCtx.createBiquadFilter();
      this.vocalFilterBiquad.type = 'bandpass';
      this.vocalFilterBiquad.frequency.value = 1850;
      this.vocalFilterBiquad.Q.value = 0.8;

      // Dynamics Compressor: Prevents speech distortion while boosting soft whisper
      this.vocalCompressor = this.audioCtx.createDynamicsCompressor();
      this.vocalCompressor.threshold.setValueAtTime(-24, this.audioCtx.currentTime);
      this.vocalCompressor.knee.setValueAtTime(30, this.audioCtx.currentTime);
      this.vocalCompressor.ratio.setValueAtTime(12, this.audioCtx.currentTime);
      this.vocalCompressor.attack.setValueAtTime(0.003, this.audioCtx.currentTime);
      this.vocalCompressor.release.setValueAtTime(0.25, this.audioCtx.currentTime);

      this.updateAudioRouting();
    } catch (err) {
      console.warn('[WebRTCEngine] Vocal clarity DSP init error:', err);
    }
  }

  setVocalBoost(enable) {
    this.vocalBoostEnabled = Boolean(enable);
    this.updateAudioRouting();
  }

  updateAudioRouting() {
    if (!this.vocalFilterSource || !this.audioCtx) return;

    try {
      this.vocalFilterSource.disconnect();
      if (this.vocalFilterBiquad) this.vocalFilterBiquad.disconnect();
      if (this.vocalCompressor) this.vocalCompressor.disconnect();

      if (this.vocalBoostEnabled && this.vocalFilterBiquad && this.vocalCompressor) {
        // Route through DSP pipeline
        this.vocalFilterSource.connect(this.vocalFilterBiquad);
        this.vocalFilterBiquad.connect(this.vocalCompressor);
        this.vocalCompressor.connect(this.audioCtx.destination);
      } else {
        // Direct passthrough
        this.vocalFilterSource.connect(this.audioCtx.destination);
      }
    } catch (e) {
      console.warn('[WebRTCEngine] Routing error:', e);
    }
  }

  toggleMic() {
    if (!this.localStream) return false;
    const track = this.localStream.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      return track.enabled;
    }
    return false;
  }

  toggleCam() {
    if (!this.localStream) return false;
    const track = this.localStream.getVideoTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      return track.enabled;
    }
    return false;
  }

  close() {
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
  }
}

if (typeof window !== 'undefined') {
  window.WebRTCEngine = WebRTCEngine;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = WebRTCEngine;
}

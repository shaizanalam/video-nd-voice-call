/**
 * PULSE CALL: WhatsApp & Instagram Call Controller
 * Ultra-simple consumer interface powered by the resilient 6kbps Opus engine
 */

document.addEventListener('DOMContentLoaded', () => {
  // PWA Service Worker Registration
  if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[PWA] SW registration notice:', err);
    });
  }

  // --- Socket.io Setup ---
  const socket = io({
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 20000
  });

  let webrtcEngine = null;
  let pttEngine = null;
  let telemetryMonitor = null;
  let currentRoomId = '';
  let callTimerInterval = null;
  let callStartTime = null;

  // --- DOM References ---
  const lobbyOverlay = document.getElementById('lobby-overlay');
  const roomInput = document.getElementById('room-id-input');
  const contactNameDisplay = document.getElementById('contact-name');
  const callTimerDisplay = document.getElementById('call-timer');

  const voiceCallBtn = document.getElementById('voice-call-btn');
  const videoCallBtn = document.getElementById('video-call-btn');
  const pttOnlyBtn = document.getElementById('ptt-only-btn');
  const shareLinkBtn = document.getElementById('share-link-btn');

  // Video / Voice Stage Elements
  const remoteVideo = document.getElementById('remote-video');
  const localVideo = document.getElementById('local-video');
  const localPip = document.getElementById('local-pip');
  const voiceCallStage = document.getElementById('voice-call-stage');
  const voiceModeText = document.getElementById('voice-mode-text');

  // Floating Walkie-Talkie Button
  const pttMainBtn = document.getElementById('ptt-main-btn');
  const pttRecTimer = document.getElementById('ptt-rec-timer');
  const pttBtnLabel = document.getElementById('ptt-btn-label');

  // Bottom Control Dock Elements
  const micBtn = document.getElementById('mic-btn');
  const micIconOn = document.getElementById('mic-icon-on');
  const micIconOff = document.getElementById('mic-icon-off');

  const camBtn = document.getElementById('cam-btn');
  const camIconOn = document.getElementById('cam-icon-on');
  const camIconOff = document.getElementById('cam-icon-off');

  const killswitchBtn = document.getElementById('killswitch-btn');
  const vocalBoostBtn = document.getElementById('vocal-boost-btn');
  const endLinkBtn = document.getElementById('end-link-btn');

  // Network Pill & Sheet
  const networkPillBtn = document.getElementById('network-pill-btn');
  const netDot = document.getElementById('net-dot');
  const netLabel = document.getElementById('net-label');
  const netModal = document.getElementById('net-modal');
  const closeNetBtn = document.getElementById('close-net-btn');
  const diagTotal = document.getElementById('diag-total');
  const metricRtt = document.getElementById('metric-rtt');
  const metricLoss = document.getElementById('metric-loss');
  const diagPath = document.getElementById('diag-path');

  // Comms Drawer Elements
  const commsDrawer = document.getElementById('comms-drawer');
  const toggleDrawerBtn = document.getElementById('toggle-drawer-btn');
  const drawerCloseBtn = document.getElementById('drawer-close-btn');
  const commsFeed = document.getElementById('comms-feed');
  const chatInput = document.getElementById('chat-input');
  const chatSendBtn = document.getElementById('chat-send-btn');
  const unreadDot = document.getElementById('unread-dot');

  // Toast Container
  const toastContainer = document.getElementById('toast-container');

  // --- 1. Parse URL Query Parameters ---
  function parseQueryParams() {
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    if (room) {
      roomInput.value = room.trim();
      contactNameDisplay.innerText = room.trim();
    }
  }

  parseQueryParams();

  // --- 2. Toast Notifications ---
  function showToast(message, duration = 3000) {
    const toast = document.createElement('div');
    toast.className = 'tactical-toast';
    toast.innerText = message;
    toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // --- 3. Share Invite Link for WhatsApp ---
  shareLinkBtn.addEventListener('click', () => {
    const rawRoom = roomInput.value.trim() || 'Sister';
    const url = `${window.location.origin}/?room=${encodeURIComponent(rawRoom)}&mode=SURVIVAL_2G`;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => {
        showToast('✓ WhatsApp link copied to clipboard!');
      }).catch(() => {
        prompt('Copy WhatsApp invite link:', url);
      });
    } else {
      prompt('Copy WhatsApp invite link:', url);
    }
  });

  // --- 4. Call Duration Timer ---
  function startCallTimer() {
    if (callTimerInterval) clearInterval(callTimerInterval);
    callStartTime = Date.now();
    callTimerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const ss = String(elapsed % 60).padStart(2, '0');
      callTimerDisplay.innerText = `${mm}:${ss}`;
    }, 1000);
  }

  function stopCallTimer() {
    if (callTimerInterval) clearInterval(callTimerInterval);
    callTimerInterval = null;
  }

  // --- 5. Start Call (Voice or Video) ---
  async function startCall(profileKey) {
    const rawRoom = roomInput.value.trim() || 'Sister';
    currentRoomId = rawRoom.toUpperCase();
    contactNameDisplay.innerText = rawRoom;

    callTimerDisplay.innerText = 'Calling...';

    // 1. Initialize WebRTC Engine
    webrtcEngine = new WebRTCEngine({
      socket,
      roomId: currentRoomId,
      localVideo,
      remoteVideo,
      profileKey,
      autoGovernorEnabled: true,
      onStatusChange: (text, color) => {
        if (text.includes('CONNECTED')) {
          startCallTimer();
          netDot.style.backgroundColor = '#25d366';
        } else if (text.includes('RECONNECTING') || text.includes('DISCONNECTED')) {
          callTimerDisplay.innerText = 'Reconnecting...';
          netDot.style.backgroundColor = '#f59e0b';
        }
      },
      onProfileChange: (key, profile) => {
        updateStageForProfile(key);
      },
      onChatMessage: (data) => {
        appendChatMessage(data, false);
        if (commsDrawer.classList.contains('collapsed')) {
          unreadDot.classList.remove('hidden');
        }
      },
      onAlert: (msg) => showToast(msg, 4000)
    });

    // 2. Initialize Push-to-Talk (Walkie-Talkie) Engine
    pttEngine = new PushToTalkEngine({
      socket,
      roomId: currentRoomId,
      peerName: 'You',
      pttButton: pttMainBtn,
      timerDisplay: pttRecTimer,
      voiceLogContainer: commsFeed,
      onStateChange: ({ isRecording }) => {
        if (isRecording) {
          pttBtnLabel.innerText = 'Recording...';
        } else {
          pttBtnLabel.innerText = 'Hold to Talk';
        }
      }
    });

    // 3. Telemetry Monitor
    telemetryMonitor = new TelemetryMonitor({
      onStatsUpdate: (metrics) => {
        const total = `${metrics.totalKbps} kbps`;
        netLabel.innerText = total;
        if (diagTotal) diagTotal.innerText = total;
        if (metricRtt) metricRtt.innerText = `${metrics.rttMs}ms`;
        if (metricLoss) metricLoss.innerText = `${metrics.packetLossPercent}%`;
        if (diagPath) diagPath.innerText = metrics.connectionPath;

        if (webrtcEngine) {
          webrtcEngine.evaluateCongestionGovernor(metrics);
        }
      }
    });

    // 4. Acquire Media & Join Room
    try {
      await webrtcEngine.acquireMedia(profileKey);
      telemetryMonitor.setPeerConnection(webrtcEngine.peerConnection);
      telemetryMonitor.start(1000);

      // Hide lobby
      lobbyOverlay.classList.add('hidden');
      updateStageForProfile(profileKey);

      socket.emit('join-room', {
        roomId: currentRoomId,
        peerName: 'You'
      });
    } catch (err) {
      alert('Unable to access microphone/camera: ' + err.message);
      callTimerDisplay.innerText = 'Call failed';
    }
  }

  voiceCallBtn.addEventListener('click', () => startCall('SURVIVAL_2G'));
  videoCallBtn.addEventListener('click', () => startCall('ULTRA_LOW_VIDEO'));

  // Walkie-Talkie Only Mode
  pttOnlyBtn.addEventListener('click', () => {
    const rawRoom = roomInput.value.trim() || 'Sister';
    currentRoomId = rawRoom.toUpperCase();
    contactNameDisplay.innerText = rawRoom;

    pttEngine = new PushToTalkEngine({
      socket,
      roomId: currentRoomId,
      peerName: 'You',
      pttButton: pttMainBtn,
      timerDisplay: pttRecTimer,
      voiceLogContainer: commsFeed
    });

    socket.emit('join-room', {
      roomId: currentRoomId,
      peerName: 'You'
    });

    lobbyOverlay.classList.add('hidden');
    updateStageForProfile('SURVIVAL_2G');
    callTimerDisplay.innerText = 'Walkie-Talkie Active';
    showToast('Walkie-Talkie Mode: Hold button to talk.');
  });

  // --- 6. Stage Management (Voice vs Video) ---
  function updateStageForProfile(profileKey) {
    const profile = WebRTCEngine.PROFILES[profileKey];
    const isVoiceOnly = !profile.video;

    if (isVoiceOnly) {
      voiceCallStage.classList.add('active');
      localPip.classList.add('hidden');
      camIconOn.classList.add('hidden');
      camIconOff.classList.remove('hidden');
      camBtn.classList.add('muted');
      voiceModeText.innerText = 'Low Data Voice (6 kbps)';
    } else {
      voiceCallStage.classList.remove('active');
      localPip.classList.remove('hidden');
      camIconOn.classList.remove('hidden');
      camIconOff.classList.add('hidden');
      camBtn.classList.remove('muted');
    }
  }

  // --- 7. Dock Controls (Mic, Video, 2G Mode, Boost, End) ---
  micBtn.addEventListener('click', () => {
    if (!webrtcEngine) return;
    const enabled = webrtcEngine.toggleMic();
    if (enabled) {
      micIconOn.classList.remove('hidden');
      micIconOff.classList.add('hidden');
      micBtn.classList.remove('muted');
    } else {
      micIconOn.classList.add('hidden');
      micIconOff.classList.remove('hidden');
      micBtn.classList.add('muted');
    }
  });

  camBtn.addEventListener('click', () => {
    if (!webrtcEngine) return;
    const enabled = webrtcEngine.toggleCam();
    if (enabled) {
      camIconOn.classList.remove('hidden');
      camIconOff.classList.add('hidden');
      camBtn.classList.remove('muted');
      localPip.classList.remove('hidden');
      voiceCallStage.classList.remove('active');
    } else {
      camIconOn.classList.add('hidden');
      camIconOff.classList.remove('hidden');
      camBtn.classList.add('muted');
      localPip.classList.add('hidden');
      voiceCallStage.classList.add('active');
    }
  });

  killswitchBtn.addEventListener('click', async () => {
    if (!webrtcEngine) return;
    await webrtcEngine.trigger2GEmergencyKillSwitch();
    updateStageForProfile('SURVIVAL_2G');
    showToast('✓ 2G Survival Mode active (6 kbps voice)');
  });

  vocalBoostBtn.addEventListener('click', () => {
    if (!webrtcEngine) return;
    const willEnable = !webrtcEngine.vocalBoostEnabled;
    webrtcEngine.setVocalBoost(willEnable);
    if (willEnable) {
      vocalBoostBtn.classList.add('active');
      showToast('✓ Vocal Clarity Boost ON (300Hz-3.4kHz)');
    } else {
      vocalBoostBtn.classList.remove('active');
      showToast('Vocal Boost OFF');
    }
  });

  endLinkBtn.addEventListener('click', () => {
    stopCallTimer();
    window.location.reload();
  });

  // --- 8. Network Sheet Toggle ---
  networkPillBtn.addEventListener('click', () => {
    netModal.classList.remove('hidden');
  });

  closeNetBtn.addEventListener('click', () => {
    netModal.classList.add('hidden');
  });

  // --- 9. Comms Drawer & Text Chat ---
  toggleDrawerBtn.addEventListener('click', () => {
    commsDrawer.classList.toggle('collapsed');
    unreadDot.classList.add('hidden');
  });

  drawerCloseBtn.addEventListener('click', () => {
    commsDrawer.classList.add('collapsed');
  });

  function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    const messageObj = {
      text,
      sender: 'You',
      timestamp: Date.now(),
      id: Math.random().toString(36).substring(2, 9)
    };

    if (webrtcEngine) {
      webrtcEngine.sendChatMessage(messageObj);
    } else {
      socket.emit('chat-msg', { roomId: currentRoomId, ...messageObj });
    }

    appendChatMessage(messageObj, true);
    chatInput.value = '';
  }

  chatSendBtn.addEventListener('click', sendChatMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendChatMessage();
  });

  function appendChatMessage(msg, isOutbound) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${isOutbound ? 'outbound' : 'inbound'}`;
    const timeStr = new Date(msg.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    bubble.innerHTML = `
      <div style="font-size: 10px; opacity: 0.7; margin-bottom: 2px;">${isOutbound ? 'You' : (msg.sender || 'Sister')} • ${timeStr}</div>
      <div>${escapeHtml(msg.text)}</div>
    `;

    commsFeed.appendChild(bubble);
    commsFeed.scrollTop = commsFeed.scrollHeight;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.innerText = str;
    return div.innerHTML;
  }

  socket.on('chat-msg', (data) => {
    appendChatMessage(data, false);
    if (commsDrawer.classList.contains('collapsed')) {
      unreadDot.classList.remove('hidden');
    }
  });

  socket.on('room-created', () => {
    callTimerDisplay.innerText = 'Ringing...';
  });

  socket.on('room-joined', () => {
    callTimerDisplay.innerText = 'Connecting...';
  });

  socket.on('room-full', () => {
    alert('This room already has 2 active callers.');
    window.location.reload();
  });
});

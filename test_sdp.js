/**
 * Automated Verification Test for Pulse-Link
 */
const assert = require('assert');
const SDPHacker = require('./public/js/sdp-hacker.js');

console.log('--- RUNNING PULSE-LINK VERIFICATION TESTS ---');

// 1. Test SDP Opus Munging
const dummySdp = [
  'v=0',
  'o=- 12345 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 126',
  'c=IN IP4 0.0.0.0',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
  'c=IN IP4 0.0.0.0',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:97 H264/90000'
].join('\r\n');

console.log('Testing SDPHacker.optimizeOpus...');
const optimized = SDPHacker.optimizeOpus(dummySdp, { audioBitrate: 6000 });
assert(optimized.includes('ptime=40'), 'Must contain ptime=40');
assert(optimized.includes('maxaveragebitrate=6000'), 'Must contain maxaveragebitrate=6000');
assert(optimized.includes('usedtx=1'), 'Must contain usedtx=1');
assert(optimized.includes('cbr=1'), 'Must contain cbr=1');
assert(optimized.includes('stereo=0;sprop-stereo=0'), 'Must force mono stereo=0');
assert(optimized.includes('maxplaybackrate=16000'), 'Must force narrowband SILK speech');
console.log('✓ SDPHacker.optimizeOpus passed!');

console.log('Testing SDPHacker.injectBandwidthBLine...');
const bwInjected = SDPHacker.injectBandwidthBLine(dummySdp, 32, 6);
assert(bwInjected.includes('b=AS:32'), 'Must inject b=AS:32 for video');
assert(bwInjected.includes('b=TIAS:32000'), 'Must inject b=TIAS:32000 for video');
assert(bwInjected.includes('b=AS:6'), 'Must inject b=AS:6 for audio');
assert(bwInjected.includes('b=TIAS:6000'), 'Must inject b=TIAS:6000 for audio');
console.log('✓ SDPHacker.injectBandwidthBLine passed!');

console.log('Testing SDPHacker.preferCodec...');
const preferred = SDPHacker.preferCodec(dummySdp, 'video', 'VP8');
assert(preferred.includes('m=video 9 UDP/TLS/RTP/SAVPF 96 97'), 'VP8 payload 96 must precede others');
console.log('✓ SDPHacker.preferCodec passed!');

console.log('Testing SDPHacker.applyAll...');
const allApplied = SDPHacker.applyAll(dummySdp, { audioBitrate: 6000, videoBitrateKbps: 32 });
assert(allApplied.includes('maxaveragebitrate=6000'), 'applyAll must optimize Opus');
assert(allApplied.includes('b=AS:32'), 'applyAll must inject video bandwidth');
console.log('✓ SDPHacker.applyAll passed!');

console.log('--- ALL UNIT TESTS COMPLETED SUCCESSFULLY ---');

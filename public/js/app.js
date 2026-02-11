/**
 * TAC-NET Tactical Comm System v1.1
 * Focus: High-reliability Mobile-to-Desktop Audio
 */

class TacticalComm {
    constructor() {
        this.socket = null;
        this.localStream = null;
        this.audioCtx = null;
        this.mainGain = null;
        this.analyser = null;
        this.peers = {};
        this.missionId = '';
        this.operatorName = '';

        this.iceServers = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
            { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
        ];

        this.initUI();
    }

    initUI() {
        this.loginScreen = document.getElementById('login-screen');
        this.missionInput = document.getElementById('mission-code');
        this.nameInput = document.getElementById('operator-name');
        this.joinBtn = document.getElementById('join-btn');
        this.pttBtn = document.getElementById('ptt-trigger');
        this.debugLog = document.getElementById('debug-log');
        this.displayMission = document.getElementById('display-mission');
        this.statusDot = document.getElementById('status-dot');
        this.statusText = document.getElementById('status-text');
        this.peerList = document.getElementById('peer-list');

        this.joinBtn.addEventListener('click', () => this.startSession());

        // PTT Events
        const startTx = () => this.setTransmission(true);
        const stopTx = () => this.setTransmission(false);

        this.pttBtn.addEventListener('mousedown', startTx);
        this.pttBtn.addEventListener('mouseup', stopTx);
        this.pttBtn.addEventListener('mouseleave', stopTx);
        this.pttBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startTx(); });
        this.pttBtn.addEventListener('touchend', (e) => { e.preventDefault(); stopTx(); });

        window.addEventListener('keydown', (e) => {
            if (e.code === 'Space' && !e.repeat && document.activeElement.tagName !== 'INPUT') startTx();
        });
        window.addEventListener('keyup', (e) => {
            if (e.code === 'Space') stopTx();
        });
    }

    log(msg, type = 'sys') {
        const div = document.createElement('div');
        div.className = `log-entry ${type}`;
        div.textContent = `> [${new Date().toLocaleTimeString()}] ${msg}`;
        this.debugLog.appendChild(div);
        this.debugLog.scrollTop = this.debugLog.scrollHeight;
    }

    async initAudio() {
        try {
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });

            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });

            const source = this.audioCtx.createMediaStreamSource(this.localStream);
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 256;
            source.connect(this.analyser);

            // Gain node for outgoing PTT only
            this.mainGain = this.audioCtx.createGain();
            this.mainGain.gain.value = 0;
            source.connect(this.mainGain);

            this.processedDestination = this.audioCtx.createMediaStreamDestination();
            this.mainGain.connect(this.processedDestination);

            // IMPORTANT: DONT connect source to audioCtx.destination to avoid local echo

            this.log('Tactical Audio initialized (Local Loopback Disabled)', 'sys');
            this.startVisualizer();

            if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
        } catch (err) {
            this.log(`Mic Error: ${err.message}`, 'err');
        }
    }

    setTransmission(active) {
        if (!this.mainGain || !this.audioCtx) return;
        const now = this.audioCtx.currentTime;
        if (active) {
            this.mainGain.gain.setTargetAtTime(1.0, now, 0.01);
            this.pttBtn.classList.add('active');
            this.socket.emit('ptt-status', { roomId: this.missionId, active: true });
        } else {
            this.mainGain.gain.setTargetAtTime(0.0, now, 0.01);
            this.pttBtn.classList.remove('active');
            this.socket.emit('ptt-status', { roomId: this.missionId, active: false });
        }
    }

    async startSession() {
        const mission = this.missionInput.value.trim().toUpperCase();
        const name = this.nameInput.value.trim();
        if (!mission || !name) return;
        this.missionId = mission;
        this.operatorName = name;
        await this.initAudio();
        this.initSocket();
        this.loginScreen.style.display = 'none';
        this.displayMission.textContent = `MISSION: ${this.missionId}`;
    }

    initSocket() {
        this.socket = io();
        this.socket.on('connect', () => {
            this.statusDot.className = 'online';
            this.statusText.textContent = 'ONLINE';
            this.socket.emit('join-room', this.missionId);
        });

        this.socket.on('room-users', (users) => {
            users.forEach(userId => this.initWebRTC(userId, true));
        });

        this.socket.on('signal', async (data) => {
            const { from, signal } = data;
            if (!this.peers[from]) this.initWebRTC(from, false);
            const peer = this.peers[from];

            try {
                if (signal.sdp) {
                    await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                    if (signal.sdp.type === 'offer') {
                        const answer = await peer.pc.createAnswer();
                        await peer.pc.setLocalDescription(answer);
                        this.socket.emit('signal', { to: from, signal: { sdp: peer.pc.localDescription } });
                    }
                    peer.candidates.forEach(cand => peer.pc.addIceCandidate(new RTCIceCandidate(cand)).catch(e => { }));
                    peer.candidates = [];
                } else if (signal.candidate) {
                    if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(e => { });
                    else peer.candidates.push(signal.candidate);
                }
            } catch (err) { console.error("Signaling Error:", err); }
        });

        this.socket.on('peer-ptt', (data) => {
            const el = document.getElementById(`peer-${data.id}`);
            if (el) data.active ? el.classList.add('active') : el.classList.remove('active');
        });

        this.socket.on('user-left', (userId) => {
            if (this.peers[userId]) {
                this.peers[userId].pc.close();
                delete this.peers[userId];
                document.getElementById(`audio-${userId}`)?.remove();
                this.updatePeerUI();
            }
        });
    }

    initWebRTC(userId, isOfferer) {
        if (this.peers[userId]) return;
        const pc = new RTCPeerConnection({ iceServers: this.iceServers, iceCandidatePoolSize: 10 });
        this.peers[userId] = { pc, candidates: [] };

        this.processedDestination.stream.getTracks().forEach(track => {
            pc.addTrack(track, this.processedDestination.stream);
        });

        pc.onicecandidate = (e) => {
            if (e.candidate) this.socket.emit('signal', { to: userId, signal: { candidate: e.candidate } });
        };

        pc.ontrack = (e) => {
            this.log(`Direct stream link with ${userId}`, 'net');
            this.playRemoteStream(e.streams[0], userId);
        };

        pc.oniceconnectionstatechange = () => {
            this.log(`Link: ${pc.iceConnectionState}`);
            if (pc.iceConnectionState === 'failed') pc.restartIce();
        };

        if (isOfferer) {
            pc.onnegotiationneeded = async () => {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                this.socket.emit('signal', { to: userId, signal: { sdp: pc.localDescription } });
            };
        }
        this.updatePeerUI();
    }

    playRemoteStream(stream, userId) {
        let audioEl = document.getElementById(`audio-${userId}`);
        if (!audioEl) {
            audioEl = document.createElement('audio');
            audioEl.id = `audio-${userId}`;
            audioEl.autoplay = true;
            audioEl.playsInline = true;
            audioEl.style.width = '100px';
            audioEl.style.height = '30px';
            audioEl.style.marginTop = '5px';
            audioEl.classList.add('tactical-audio-node');

            // Add to the peer item UI
            const peerDiv = document.getElementById(`peer-${userId}`);
            if (peerDiv) peerDiv.appendChild(audioEl);
            else document.body.appendChild(audioEl);
        }

        audioEl.srcObject = stream;

        // Connect to analyser for visual verification ONLY
        try {
            const remoteSource = this.audioCtx.createMediaStreamSource(stream);
            remoteSource.connect(this.analyser);
        } catch (e) { }

        const attemptPlay = () => {
            audioEl.play().catch(e => {
                this.log("Audio waiting for user tap...", "err");
            });
        };

        attemptPlay();
        ['click', 'touchstart'].forEach(e => window.addEventListener(e, attemptPlay, { once: true }));
    }

    updatePeerUI() {
        this.peerList.innerHTML = '';
        Object.keys(this.peers).forEach(id => {
            const div = document.createElement('div');
            div.className = 'operator-item';
            div.id = `peer-${id}`;
            div.innerHTML = `<div class="op-avatar">OP</div><div class="op-info"><div class="op-name">${id.substring(0, 6)}</div><div class="op-status">READY</div></div>`;
            this.peerList.appendChild(div);
        });
    }

    startVisualizer() {
        const canvas = document.getElementById('waves');
        const ctx = canvas.getContext('2d');
        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        const draw = () => {
            requestAnimationFrame(draw);
            this.analyser.getByteFrequencyData(dataArray);
            if (canvas.width !== canvas.clientWidth) {
                canvas.width = canvas.clientWidth;
                canvas.height = canvas.clientHeight;
            }
            ctx.fillStyle = 'rgba(19, 19, 20, 0.4)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const barWidth = (canvas.width / bufferLength) * 2;
            let barHeight;
            let x = 0;
            let active = this.pttBtn.classList.contains('active') || document.querySelectorAll('.operator-item.active').length > 0;
            ctx.fillStyle = active ? '#6EE7B7' : '#3B82F6';
            for (let i = 0; i < bufferLength; i++) {
                barHeight = dataArray[i] / 2;
                ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
                x += barWidth + 1;
            }
        };
        draw();
    }
}

window.addEventListener('DOMContentLoaded', () => { window.tacNet = new TacticalComm(); });

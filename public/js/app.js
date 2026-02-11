/**
 * TAC-NET Tactical Comm System
 * Engineering logic for WebRTC + Web Audio API
 */

class TacticalComm {
    constructor() {
        this.socket = null;
        this.localStream = null;
        this.audioCtx = null;
        this.mainGain = null;
        this.analyser = null;
        this.peers = {}; // socketId -> RTCPeerConnection
        this.missionId = '';
        this.operatorName = '';

        this.iceServers = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
            { urls: 'stun:stun.ekiga.net' },
            { urls: 'stun:stun.ideasip.com' },
            { urls: 'stun:stun.schlund.de' },
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

        this.pttBtn.addEventListener('mousedown', () => this.setTransmission(true));
        this.pttBtn.addEventListener('mouseup', () => this.setTransmission(false));
        this.pttBtn.addEventListener('mouseleave', () => this.setTransmission(false));

        this.pttBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.setTransmission(true);
        });
        this.pttBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            this.setTransmission(false);
        });

        window.addEventListener('keydown', (e) => {
            if (e.code === 'Space' && !e.repeat) {
                if (document.activeElement.tagName !== 'INPUT') {
                    this.setTransmission(true);
                }
            }
        });
        window.addEventListener('keyup', (e) => {
            if (e.code === 'Space') {
                this.setTransmission(false);
            }
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
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            this.log(`AudioCtx: ${this.audioCtx.state}`);

            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
                video: false
            });

            const source = this.audioCtx.createMediaStreamSource(this.localStream);
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 256;
            source.connect(this.analyser);

            // Gain node for PTT
            this.mainGain = this.audioCtx.createGain();
            this.mainGain.gain.value = 0;
            source.connect(this.mainGain);

            // IMPORTANT: For now, we also connect directly to a MediaStreamDestination 
            // BUT we'll send the raw localStream for testing if negotiation persists in failing
            this.processedDestination = this.audioCtx.createMediaStreamDestination();
            this.mainGain.connect(this.processedDestination);

            this.log('Audio Engine Online', 'sys');
            this.startVisualizer();

            const unlock = async () => {
                if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
                window.removeEventListener('click', unlock);
                window.removeEventListener('touchstart', unlock);
            };
            window.addEventListener('click', unlock);
            window.addEventListener('touchstart', unlock);

        } catch (err) {
            this.log(`Audio Init Error: ${err.message}`, 'err');
            alert("Micrófono bloqueado o no encontrado.");
        }
    }

    setTransmission(active) {
        if (!this.mainGain || !this.audioCtx) return;
        const now = this.audioCtx.currentTime;
        if (active) {
            this.mainGain.gain.setTargetAtTime(1.0, now, 0.01);
            this.pttBtn.classList.add('active');
            this.log('TRANSMITTING...', 'net');
            this.socket.emit('ptt-status', { roomId: this.missionId, active: true });
        } else {
            this.mainGain.gain.setTargetAtTime(0.0, now, 0.01);
            this.pttBtn.classList.remove('active');
            this.log('IDLE', 'sys');
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
        this.socket.on('user-joined', (userId) => this.log(`Peer entered: ${userId}`));
        this.socket.on('room-users', (users) => {
            users.forEach(userId => this.initWebRTC(userId, true));
        });
        this.socket.on('signal', async (data) => {
            const { from, signal } = data;
            if (!this.peers[from]) this.initWebRTC(from, false);
            const pc = this.peers[from];
            try {
                if (signal.sdp) {
                    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                    if (signal.sdp.type === 'offer') {
                        const answer = await pc.createAnswer();
                        await pc.setLocalDescription(answer);
                        this.socket.emit('signal', { to: from, signal: { sdp: pc.localDescription } });
                    }
                } else if (signal.candidate) {
                    await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
                }
            } catch (err) { console.error(err); }
        });
        this.socket.on('peer-ptt', (data) => {
            const el = document.getElementById(`peer-${data.id}`);
            if (el) data.active ? el.classList.add('active') : el.classList.remove('active');
        });
        this.socket.on('user-left', (userId) => {
            if (this.peers[userId]) {
                this.peers[userId].close();
                delete this.peers[userId];
                document.getElementById(`audio-${userId}`)?.remove();
                this.updatePeerUI();
            }
        });
    }

    initWebRTC(userId, isOfferer) {
        if (this.peers[userId]) return;
        const pc = new RTCPeerConnection({ iceServers: this.iceServers, iceCandidatePoolSize: 10 });
        this.peers[userId] = pc;

        // CRITICAL: Use processed destination to respect PTT gain
        this.processedDestination.stream.getTracks().forEach(track => {
            pc.addTrack(track, this.processedDestination.stream);
        });

        pc.onicecandidate = (e) => {
            if (e.candidate) this.socket.emit('signal', { to: userId, signal: { candidate: e.candidate } });
        };
        pc.ontrack = (e) => {
            this.log(`Track from ${userId}`, 'net');
            this.playRemoteStream(e.streams[0], userId);
        };
        pc.oniceconnectionstatechange = () => {
            this.log(`ICE ${userId}: ${pc.iceConnectionState}`);
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
            audioEl.style.display = 'none';
            document.body.appendChild(audioEl);
        }
        audioEl.srcObject = stream;
        const play = async () => {
            try {
                if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
                await audioEl.play();
                const remoteSource = this.audioCtx.createMediaStreamSource(stream);
                remoteSource.connect(this.analyser); // Connect to analyser to see waves
                remoteSource.connect(this.audioCtx.destination);
            } catch (e) { this.log("Tap screen to unlock audio", "err"); }
        };
        play();
        ['click', 'touchstart'].forEach(evt => window.addEventListener(evt, play, { once: true }));
    }

    updatePeerUI() {
        this.peerList.innerHTML = '';
        Object.keys(this.peers).forEach(id => {
            const div = document.createElement('div');
            div.className = 'operator-item';
            div.id = `peer-${id}`;
            div.innerHTML = `<div class="op-avatar">OP</div><div class="op-info"><div class="op-name">${id.substring(0, 6)}</div><div class="op-status">ACTIVO</div></div>`;
            this.peerList.appendChild(div);
        });
    }

    startVisualizer() {
        const canvas = document.getElementById('waves');
        const ctx = canvas.getContext('2d');
        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8ClampedArray(bufferLength);
        const draw = () => {
            requestAnimationFrame(draw);
            this.analyser.getByteFrequencyData(dataArray);
            if (canvas.width !== canvas.clientWidth) {
                canvas.width = canvas.clientWidth;
                canvas.height = canvas.clientHeight;
            }
            ctx.fillStyle = 'rgba(19, 19, 20, 0.5)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const barWidth = (canvas.width / bufferLength) * 2.5;
            let barHeight;
            let x = 0;
            let someoneTalking = this.pttBtn.classList.contains('active') || document.querySelectorAll('.operator-item.active').length > 0;
            ctx.fillStyle = someoneTalking ? '#6EE7B7' : '#3B82F6';
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

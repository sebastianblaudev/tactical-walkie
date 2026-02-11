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

        // Configuration
        this.iceServers = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            // Public free TURN servers from OpenRelayProject
            {
                urls: 'turn:openrelay.metered.ca:443',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            {
                urls: 'turn:openrelay.metered.ca:443?transport=tcp',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            }
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

        // PTT Logic
        this.pttBtn.addEventListener('mousedown', () => this.setTransmission(true));
        this.pttBtn.addEventListener('mouseup', () => this.setTransmission(false));
        this.pttBtn.addEventListener('mouseleave', () => this.setTransmission(false));

        // Mobile Touch
        this.pttBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.setTransmission(true);
        });
        this.pttBtn.addEventListener('touchend', (e) => {
            e.preventDefault();
            this.setTransmission(false);
        });

        // Keybind (Space)
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
            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });

            // Source from mic
            const source = this.audioCtx.createMediaStreamSource(this.localStream);

            // Main Gain for PTT (This will control what is SENT to others)
            this.mainGain = this.audioCtx.createGain();
            this.mainGain.gain.setValueAtTime(0, this.audioCtx.currentTime);

            // Analyser for visualizer
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 256;

            // MediaStream Destination (This is the "processed" stream we send via WebRTC)
            this.processedDestination = this.audioCtx.createMediaStreamDestination();

            // Graph: mic -> gain -> destination (to send)
            //              \-> analyser (to see)
            source.connect(this.mainGain);
            this.mainGain.connect(this.processedDestination);
            source.connect(this.analyser);

            this.log('Audio Engine Online', 'sys');
            this.startVisualizer();

            // Unlock AudioContext for mobile/safari
            const unlock = async () => {
                if (this.audioCtx.state === 'suspended') {
                    await this.audioCtx.resume();
                }
                window.removeEventListener('click', unlock);
                window.removeEventListener('touchstart', unlock);
            };
            window.addEventListener('click', unlock);
            window.addEventListener('touchstart', unlock);

        } catch (err) {
            this.log(`Audio Init Error: ${err.message}`, 'err');
            alert("Error de Audio: Por favor permite el acceso al micrófono.");
        }
    }

    setTransmission(active) {
        if (!this.mainGain || !this.audioCtx) return;

        const now = this.audioCtx.currentTime;
        if (active) {
            this.mainGain.gain.setTargetAtTime(1.0, now, 0.01);
            this.pttBtn.classList.add('active');
            this.log('TRANSMITTING...', 'net');
            // Visual feedback on peer list
            this.socket.emit('ptt-status', { roomId: this.missionId, active: true });
        } else {
            this.mainGain.gain.setTargetAtTime(0.0, now, 0.01);
            this.pttBtn.classList.remove('active');
            this.log('RECEIVING/IDLE', 'sys');
            this.socket.emit('ptt-status', { roomId: this.missionId, active: false });
        }
    }

    async startSession() {
        const mission = this.missionInput.value.trim().toUpperCase();
        const name = this.nameInput.value.trim();

        if (!mission || !name) {
            alert("Completa los datos de acceso.");
            return;
        }

        this.missionId = mission;
        this.operatorName = name;

        await this.initAudio();
        this.initSocket();

        this.loginScreen.style.display = 'none';
        this.displayMission.textContent = `MISSION: ${this.missionId}`;
        this.log(`Joined Mission: ${this.missionId}`);
    }

    initSocket() {
        this.socket = io();

        this.socket.on('connect', () => {
            this.statusDot.className = 'online';
            this.statusText.textContent = 'ONLINE';
            this.log('Signal Link Established', 'net');
            this.socket.emit('join-room', this.missionId);
        });

        this.socket.on('user-joined', (userId) => {
            this.log(`New peer detected: ${userId}`, 'sys');
            // We DON'T initiate here. We wait for the new user to send us an offer.
            // This prevents double-handshakes.
        });

        this.socket.on('room-users', (users) => {
            users.forEach(userId => {
                this.log(`Establishing link with: ${userId}`, 'sys');
                this.initWebRTC(userId, true); // We are the newcomer, we initiate
            });
        });

        this.socket.on('signal', async (data) => {
            const { from, signal } = data;

            if (!this.peers[from]) {
                this.initWebRTC(from, false);
            }

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
            } catch (err) {
                console.error("Signal Handling Error:", err);
            }
        });

        this.socket.on('peer-ptt', (data) => {
            const el = document.getElementById(`peer-${data.id}`);
            if (el) {
                if (data.active) el.classList.add('active');
                else el.classList.remove('active');
            }
        });

        this.socket.on('user-left', (userId) => {
            this.log(`Peer offline: ${userId}`, 'err');
            if (this.peers[userId]) {
                this.peers[userId].close();
                delete this.peers[userId];
                // Remove associated audio element
                const audioEl = document.getElementById(`audio-${userId}`);
                if (audioEl) audioEl.remove();
                this.updatePeerUI();
            }
        });
    }

    initWebRTC(userId, isOfferer) {
        if (this.peers[userId]) return;

        const pc = new RTCPeerConnection({ iceServers: this.iceServers });
        this.peers[userId] = pc;

        // CRITICAL: We add tracks from our PROCESSED stream (affected by PTT gain)
        this.processedDestination.stream.getTracks().forEach(track => {
            pc.addTrack(track, this.processedDestination.stream);
        });

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.socket.emit('signal', { to: userId, signal: { candidate: event.candidate } });
            }
        };

        pc.ontrack = (event) => {
            this.log(`Stream incoming from ${userId}`, 'net');
            this.playRemoteStream(event.streams[0], userId);
        };

        pc.onconnectionstatechange = () => {
            this.log(`Link state (${userId}): ${pc.connectionState}`, 'sys');
            if (pc.connectionState === 'failed') {
                this.peers[userId].close();
                delete this.peers[userId];
                // Re-initiate connection if failed
                this.initWebRTC(userId, true);
            }
        };

        if (isOfferer) {
            pc.onnegotiationneeded = async () => {
                try {
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    this.socket.emit('signal', { to: userId, signal: { sdp: pc.localDescription } });
                } catch (err) {
                    console.error(err);
                }
            };
        }

        this.updatePeerUI();
    }

    playRemoteStream(stream, userId) {
        // MOBILE FIX: Use an visible (but tiny) audio element with controls=false 
        // Some mobile browsers throttle or mute audio elements that are display:none
        let audioEl = document.getElementById(`audio-${userId}`);
        if (!audioEl) {
            audioEl = document.createElement('audio');
            audioEl.id = `audio-${userId}`;
            audioEl.autoplay = true;
            audioEl.playsInline = true; // Critical for iOS
            // Minimal styling to keep it "hidden" but active
            audioEl.style.position = 'absolute';
            audioEl.style.width = '1px';
            audioEl.style.height = '1px';
            audioEl.style.opacity = '0.01';
            document.body.appendChild(audioEl);
        }

        audioEl.srcObject = stream;

        // Final attempt to hear via AudioContext (High Fidelity)
        const play = () => {
            audioEl.play().catch(e => {
                this.log("Autoplay blocked. Tap anywhere to hear.", "err");
            });

            // Connect to AudioContext destination for better sound
            try {
                const remoteSource = this.audioCtx.createMediaStreamSource(stream);
                remoteSource.connect(this.audioCtx.destination);
            } catch (e) { console.error("AudioCtx routing failed:", e); }
        };

        play();

        // Re-attempt play on user interaction to clear any final blocks
        window.addEventListener('click', () => audioEl.play(), { once: true });
        window.addEventListener('touchstart', () => audioEl.play(), { once: true });
    }

    updatePeerUI() {
        this.peerList.innerHTML = '';
        Object.keys(this.peers).forEach(id => {
            const div = document.createElement('div');
            div.className = 'operator-item';
            div.id = `peer-${id}`;
            div.innerHTML = `
                <div class="op-avatar">OP</div>
                <div class="op-info">
                    <div class="op-name">${id.substring(0, 8)}</div>
                    <div class="op-status">ENLACE ACTIVO</div>
                </div>
            `;
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
            this.analyser.getByteTimeDomainData(dataArray);

            // Resize canvas if needed
            if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
                canvas.width = canvas.clientWidth;
                canvas.height = canvas.clientHeight;
            }

            ctx.fillStyle = 'rgba(19, 19, 20, 0.2)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            ctx.lineWidth = 2;
            ctx.strokeStyle = this.pttBtn.classList.contains('active') ? '#6EE7B7' : '#3B82F6';

            ctx.beginPath();
            const sliceWidth = canvas.width * 1.0 / bufferLength;
            let x = 0;

            for (let i = 0; i < bufferLength; i++) {
                const v = dataArray[i] / 128.0;
                const y = v * canvas.height / 2;

                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }

                x += sliceWidth;
            }

            ctx.lineTo(canvas.width, canvas.height / 2);
            ctx.stroke();
        };

        draw();
    }
}

// Global initialization
window.addEventListener('DOMContentLoaded', () => {
    window.tacNet = new TacticalComm();
});

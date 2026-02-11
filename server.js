const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Store room users
const rooms = {};

io.on('connection', (socket) => {
    console.log(`[SYS] User connected: ${socket.id}`);

    socket.on('join-room', (roomId) => {
        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = [];
        }

        // Notify others in the room to start handshake with the new user
        rooms[roomId].forEach(userId => {
            io.to(userId).emit('user-joined', socket.id);
        });

        rooms[roomId].push(socket.id);
        console.log(`[SYS] User ${socket.id} joined mission: ${roomId}`);

        // Return current users to the new user (so they know who else is there)
        socket.emit('room-users', rooms[roomId].filter(id => id !== socket.id));
    });

    socket.on('signal', (data) => {
        // data contains { to: userId, from: socket.id, signal: webrtcSignalData }
        io.to(data.to).emit('signal', {
            from: socket.id,
            signal: data.signal
        });
    });

    socket.on('ptt-status', (data) => {
        // Broadcast to others in the room
        socket.to(data.roomId).emit('peer-ptt', {
            id: socket.id,
            active: data.active
        });
    });

    socket.on('disconnect', () => {
        console.log(`[SYS] User disconnected: ${socket.id}`);
        for (const roomId in rooms) {
            const index = rooms[roomId].indexOf(socket.id);
            if (index !== -1) {
                rooms[roomId].splice(index, 1);
                io.to(roomId).emit('user-left', socket.id);

                if (rooms[roomId].length === 0) {
                    delete rooms[roomId];
                }
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`[TAC-NET] Tactical Server running on port ${PORT}`);
});

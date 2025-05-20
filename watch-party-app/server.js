// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// In-memory store for rooms. In a production app, use a database.
let rooms = {}; // { roomId: { mediaUrl, mediaType, playbackState, currentTime, hostSocketId, participants: [{id, isHost}] } }

const MAX_PARTICIPANTS_PER_ROOM = 10; // Example limit

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('createRoom', ({ mediaUrl, mediaType }) => {
        let roomId = generateRoomId();
        while (rooms[roomId]) { // Ensure unique room ID
            roomId = generateRoomId();
        }

        rooms[roomId] = {
            mediaUrl,
            mediaType: mediaType || 'video', // Default to video
            playbackState: 'paused',
            currentTime: 0,
            hostSocketId: socket.id,
            participants: [{ id: socket.id, isHost: true }]
        };
        socket.join(roomId);
        socket.emit('roomCreated', { roomId, mediaUrl, mediaType: rooms[roomId].mediaType });
        console.log(`Room created: ${roomId} by ${socket.id} with media ${mediaUrl}`);
        broadcastParticipants(roomId);
    });

    socket.on('joinRoom', ({ roomId }) => {
        const room = rooms[roomId];
        if (room) {
            if (room.participants.length >= MAX_PARTICIPANTS_PER_ROOM) {
                socket.emit('roomFull');
                console.log(`User ${socket.id} failed to join room ${roomId}: Room full.`);
                return;
            }

            socket.join(roomId);
            room.participants.push({ id: socket.id, isHost: false });

            socket.emit('joinedRoom', { 
                roomId, 
                mediaUrl: room.mediaUrl, 
                mediaType: room.mediaType,
                playbackState: room.playbackState,
                currentTime: room.currentTime
            });
            // Send a more detailed initial sync to the new user
            socket.emit('initialSync', {
                mediaUrl: room.mediaUrl,
                mediaType: room.mediaType,
                playbackState: room.playbackState,
                currentTime: room.currentTime,
                isHost: false // New joiner is not host by default
            });

            // Notify other participants in the room
            socket.to(roomId).emit('userJoined', { userId: socket.id });
            console.log(`User ${socket.id} joined room: ${roomId}`);
            broadcastParticipants(roomId);
        } else {
            socket.emit('roomNotFound');
            console.log(`User ${socket.id} tried to join non-existent room: ${roomId}`);
        }
    });

    socket.on('playbackAction', (data) => {
        const { roomId, action, time, mediaUrl, mediaType } = data;
        const room = rooms[roomId];

        if (room && room.hostSocketId === socket.id) { // Only host can control playback
            console.log(`Playback action in room ${roomId} by host ${socket.id}: ${action}`, data);

            if (action === 'load' && mediaUrl) { // Host changes media
                room.mediaUrl = mediaUrl;
                room.mediaType = mediaType || 'video';
                room.currentTime = 0;
                room.playbackState = 'paused'; // Reset state for new media
                // Broadcast new media to all, including new time and state
                io.to(roomId).emit('playbackUpdate', { 
                    action: 'load', 
                    mediaUrl: room.mediaUrl, 
                    mediaType: room.mediaType,
                    currentTime: room.currentTime,
                    playbackState: room.playbackState 
                });
            } else {
                // Update server state
                if (time !== undefined) room.currentTime = time;
                if (action === 'play') room.playbackState = 'playing';
                if (action === 'pause') room.playbackState = 'paused';
                if (action === 'seek') {
                    // playbackState might not change on seek, depends on if it was playing/paused
                }
                if (action === 'timeUpdate' && room.playbackState === 'playing') {
                    // This is a periodic sync from host, useful if clients drift
                }
                if (action === 'ended') {
                    room.playbackState = 'paused'; // Or 'ended' if you have specific logic
                    // room.currentTime = room.duration || time; // Assuming duration might be passed
                }

                // Broadcast action to other participants in the room
                socket.to(roomId).emit('playbackUpdate', { action, time: room.currentTime, playbackState: room.playbackState });
            }
        } else if (room && room.hostSocketId !== socket.id) {
            console.log(`User ${socket.id} (not host) tried to send playbackAction in room ${roomId}. Ignoring.`);
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        // Find which room the user was in and remove them
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const participantIndex = room.participants.findIndex(p => p.id === socket.id);

            if (participantIndex !== -1) {
                room.participants.splice(participantIndex, 1);
                console.log(`User ${socket.id} removed from room ${roomId}`);

                if (room.participants.length === 0) {
                    // If room is empty, delete it
                    delete rooms[roomId];
                    console.log(`Room ${roomId} is empty and has been deleted.`);
                } else {
                    // If the host disconnected, assign a new host
                    if (room.hostSocketId === socket.id) {
                        room.hostSocketId = room.participants[0].id; // Assign first participant as new host
                        room.participants[0].isHost = true;
                        io.to(room.hostSocketId).emit('hostAssigned'); // Notify the new host
                        console.log(`Host disconnected from room ${roomId}. New host: ${room.hostSocketId}`);
                    }
                    // Notify remaining participants
                    socket.to(roomId).emit('userDisconnected', { userId: socket.id });
                    broadcastParticipants(roomId);
                }
                break; // User can only be in one room as per this logic
            }
        }
    });

    function broadcastParticipants(roomId) {
        if (rooms[roomId]) {
            io.to(roomId).emit('participantsUpdate', rooms[roomId].participants);
        }
    }
});

function generateRoomId() {
    // Simple 6-character random string for room ID
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`Access the application at http://localhost:${PORT}`);
});
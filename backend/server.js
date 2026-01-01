const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// CORS configuration
const allowedOrigins = [
  'http://localhost:3000',
  process.env.FRONTEND_URL,
  /\.onrender\.com$/
];

const io = new Server(server, {
  cors: {
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      
      const isAllowed = allowedOrigins.some(allowed => {
        if (allowed instanceof RegExp) {
          return allowed.test(origin);
        }
        return allowed === origin;
      });
      
      if (isAllowed) {
        callback(null, true);
      } else {
        callback(null, true); // Allow all origins for development
      }
    },
    methods: ['GET', 'POST'],
    credentials: true
  }
});

app.use(cors({
  origin: function (origin, callback) {
    callback(null, true);
  },
  credentials: true
}));

app.use(express.json());

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Multer configuration for memory storage
const storage = multer.memoryStorage();
const upload = multer({ 
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// File paths
const usersPath = path.join(__dirname, 'users.json');
const messagesPath = path.join(__dirname, 'messages.json');

// Helper functions to read/write JSON files
const readJSON = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '[]');
      return [];
    }
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data || '[]');
  } catch (error) {
    console.error(`Error reading ${filePath}:`, error);
    return [];
  }
};

const writeJSON = (filePath, data) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error(`Error writing ${filePath}:`, error);
  }
};

// Store online users
const onlineUsers = new Map();

// API Routes
app.get('/', (req, res) => {
  res.json({ message: 'WhatsApp Chat Backend is running!' });
});

// Login endpoint
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = readJSON(usersPath);
  
  const user = users.find(u => u.username === username && u.password === password);
  
  if (user) {
    const { password: _, ...userWithoutPassword } = user;
    res.json({ success: true, user: userWithoutPassword });
  } else {
    res.status(401).json({ success: false, message: 'Invalid credentials' });
  }
});

// Get all users (for user list)
app.get('/api/users', (req, res) => {
  const users = readJSON(usersPath);
  const usersWithoutPasswords = users.map(({ password, ...user }) => user);
  res.json(usersWithoutPasswords);
});

// Get chat history between two users
app.get('/api/messages/:senderId/:receiverId', (req, res) => {
  const { senderId, receiverId } = req.params;
  const messages = readJSON(messagesPath);
  
  const chatMessages = messages.filter(msg => 
    (msg.senderId === senderId && msg.receiverId === receiverId) ||
    (msg.senderId === receiverId && msg.receiverId === senderId)
  );
  
  res.json(chatMessages);
});

// Upload file to Cloudinary
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const file = req.file;
    const mimeType = file.mimetype;
    let resourceType = 'auto';
    let fileType = 'file';

    // Determine file type
    if (mimeType.startsWith('image/')) {
      resourceType = 'image';
      fileType = 'image';
    } else if (mimeType.startsWith('video/')) {
      resourceType = 'video';
      fileType = 'video';
    } else {
      resourceType = 'raw';
      fileType = 'file';
    }

    // Upload to Cloudinary
    const uploadPromise = new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          resource_type: resourceType,
          folder: 'whatsapp-chat',
          public_id: `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`,
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(file.buffer);
    });

    const result = await uploadPromise;

    res.json({
      success: true,
      url: result.secure_url,
      fileType,
      fileName: file.originalname,
      mimeType
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed', details: error.message });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // User comes online
  socket.on('user_online', (userId) => {
    onlineUsers.set(userId, socket.id);
    io.emit('online_users', Array.from(onlineUsers.keys()));
    console.log(`User ${userId} is online`);
  });

  // Join a chat room
  socket.on('join_chat', ({ senderId, receiverId }) => {
    const roomId = [senderId, receiverId].sort().join('_');
    socket.join(roomId);
    console.log(`User joined room: ${roomId}`);
  });

  // Send message
  socket.on('send_message', (messageData) => {
    const messages = readJSON(messagesPath);
    
    const newMessage = {
      id: Date.now().toString(),
      ...messageData,
      timestamp: new Date().toISOString()
    };
    
    messages.push(newMessage);
    writeJSON(messagesPath, messages);

    const roomId = [messageData.senderId, messageData.receiverId].sort().join('_');
    io.to(roomId).emit('receive_message', newMessage);
    
    // Also emit to receiver's socket directly for notification
    const receiverSocketId = onlineUsers.get(messageData.receiverId);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('new_message_notification', newMessage);
    }

    console.log('Message sent:', newMessage);
  });

  // Typing indicator
  socket.on('typing', ({ senderId, receiverId, isTyping }) => {
    const receiverSocketId = onlineUsers.get(receiverId);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('user_typing', { senderId, isTyping });
    }
  });

  // User disconnects
  socket.on('disconnect', () => {
    for (const [userId, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) {
        onlineUsers.delete(userId);
        io.emit('online_users', Array.from(onlineUsers.keys()));
        console.log(`User ${userId} went offline`);
        break;
      }
    }
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
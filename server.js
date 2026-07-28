require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const webpush = require('web-push');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Khóa VAPID (Môi trường Code test tạo mới mỗi lần chạy)
const vapidKeys = webpush.generateVAPIDKeys();
const PUBLIC_VAPID_KEY = vapidKeys.publicKey;
const PRIVATE_VAPID_KEY = vapidKeys.privateKey;
webpush.setVapidDetails('mailto:hi@bloodconnect.com', PUBLIC_VAPID_KEY, PRIVATE_VAPID_KEY);

// MongoDB Schema
const UserSchema = new mongoose.Schema({
  name: String, phone: String, email: String, bloodType: String,
  location: { lat: Number, lng: Number },
  distance: String, // Lưu tạm để dễ test
  donationCount: { type: Number, default: 0 },
  pushSubscription: Object,
  isOnline: { type: Boolean, default: false },
  chats: [{ text: String, sender: String, hospitalId: String, time: String, image: String }]
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);

// --- REST API ROUTES ---
app.get('/api/vapid-key', (req, res) => res.json({ publicKey: PUBLIC_VAPID_KEY }));

// Hàm tính khoảng cách cơ bản (Haversine)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; 
    const dLat = (lat2 - lat1) * (Math.PI/180);
    const dLon = (lon2 - lon1) * (Math.PI/180);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1*(Math.PI/180)) * Math.cos(lat2*(Math.PI/180)) * Math.sin(dLon/2) * Math.sin(dLon/2); 
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
    return R * c;
}

app.post('/api/users/sync', async (req, res) => {
   const { phone, name, email, bloodType, location, pushSubscription, mockId } = req.body;
   try {
       // Tạo query linh hoạt cho test
       let query = mockId ? { _id: mockId } : { phone };
       
       let user = null;
       if (mockId) {
          user = await User.findById(mockId);
       } else {
          user = await User.findOne({ phone });
       }
       
       if (!user) {
           user = new User({ name, phone, email, bloodType, location, pushSubscription, isOnline: true });
       } else {
           if (location) user.location = location;
           if (pushSubscription) user.pushSubscription = pushSubscription;
           user.isOnline = true;
       }
       await user.save();
       // Trả về id dưới dạng string để Frontend dể tương tác
       res.json({ user: { ...user._doc, id: user._id.toString() } });
   } catch(e) { res.status(500).json({ error: e.message }) }
});

app.get('/api/users/scan', async (req, res) => {
   const { bloodType, radius, lat, lng } = req.query;
   try {
       const query = bloodType === 'all' ? {} : { bloodType };
       const users = await User.find(query);
       
       const results = users.map(u => {
           if (!u.location) return null;
           // Tính khoảng cách tới bệnh viện
           const dist = calculateDistance(lat, lng, u.location.lat, u.location.lng);
           if (dist <= parseFloat(radius || 9999)) {
               return { ...u._doc, id: u._id.toString(), distance: dist.toFixed(1) };
           }
           return null;
       }).filter(Boolean);

       // Sort khoảng cách
       results.sort((a,b) => parseFloat(a.distance) - parseFloat(b.distance));
       res.json({ donors: results });
   } catch(e) { res.status(500).json({ error: e.message }) }
});

// Lấy lịch sử chat
app.get('/api/users/:id/chats', async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if(!user) return res.status(404).json({error: "Not found"});
        res.json({ chats: user.chats || [] });
    } catch(e) { res.status(500).json({ error: e.message }) }
});

// Lấy toàn bộ users (Dành cho Hộp thư Inbox)
app.get('/api/users', async (req, res) => {
    try {
        const users = await User.find({});
        res.json({ users: users.map(u => ({ ...u._doc, id: u._id.toString() })) });
    } catch(e) { res.status(500).json({ error: e.message }) }
});

// Gửi tin nhắn thông thường qua API (dành cho Chat)
app.post('/api/users/:id/chats', async (req, res) => {
    try {
        const { text, sender, hospitalId, image } = req.body;
        const user = await User.findById(req.params.id);
        if(!user) return res.status(404).json({error: "Not found"});
        
        const newMsg = { text, sender, hospitalId, time: new Date().toISOString(), image };
        user.chats.push(newMsg);
        await user.save();
        
        // Phát sự kiện realtime qua Socket
        io.to(user._id.toString()).emit('receive-message', newMsg);
        io.to(`hospital_${hospitalId}`).emit('receive-message', { userId: user._id.toString(), msg: newMsg });

        res.json({ success: true, message: newMsg });
    } catch(e) { res.status(500).json({ error: e.message }) }
});

// Gửi Còi Báo Động (Web Push Protocol)
app.post('/api/emergency/push', async (req, res) => {
    const { userId, hospitalName, hospitalId, bloodType } = req.body;
    try {
        const user = await User.findById(userId);
        if(!user) return res.status(404).json({error: "Not found"});
        
        const systemMsg = { text: `[HỆ THỐNG] Đã phát còi báo động khẩn cấp tới ${user.name} qua Push Notification.`, sender: hospitalName, hospitalId, time: new Date().toISOString() };
        user.chats.push(systemMsg);
        await user.save();

        // Đẩy Realtime Chat qua Socket liền 
        io.to(user._id.toString()).emit('receive-message', systemMsg);
        io.to(`hospital_${hospitalId}`).emit('receive-message', { userId: user._id.toString(), msg: systemMsg });

        if (user.pushSubscription && user.pushSubscription.endpoint) {
            const payload = JSON.stringify({
                title: '🚨 MỆNH LỆNH CỨU VIỆN',
                body: `Bệnh viện ${hospitalName} đang rất cần ${bloodType}. VUI LÒNG ĐẾN NGAY! Lộ trình đã mở.`,
            });
            try {
               await webpush.sendNotification(user.pushSubscription, payload);
            } catch(e) { console.error("WebPush Error:", e) }
        }

        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }) }
});

// --- SOCKET.IO REALTIME ---
io.on('connection', (socket) => {
    console.log('[Socket] Có người vừa kết nối: ', socket.id);

    // Người Dùng join phòng riêng của ID mình
    socket.on('join-donor', (userId) => {
        socket.join(userId);
        console.log(`[Socket] Donor ${userId} tham gia vòng lặp`);
    });

    // Bệnh viện join phòng riêng (để nhận tin báo của tất cả donor hướng tới mình)
    socket.on('join-hospital', (hospitalId) => {
        socket.join(`hospital_${hospitalId}`);
        console.log(`[Socket] Bệnh viện ${hospitalId} tham gia vòng lặp`);
    });

    socket.on('disconnect', () => {
        console.log('[Socket] Mất tín hiệu ngắt kết nối: ', socket.id);
    });
});

// Chạy DB & Server
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/medical_command_center').then(() => {
   const port = process.env.PORT || 5000;
   server.listen(port, () => {
       console.log(`🚀 MERN Backend & Socket.io đang chạy tại http://localhost:${port}`);
   });
}).catch(e => console.error(e));

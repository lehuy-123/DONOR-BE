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
  weight: Number,
  height: Number,
  age: Number,
  lastDonationDate: String,
  pushSubscription: Object,
  isOnline: { type: Boolean, default: false },
  sessionToken: String,
  chats: [{ text: String, sender: String, hospitalId: String, time: String, image: String }]
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);

const BroadcastSchema = new mongoose.Schema({
  hospitalId: String,
  hospitalName: String,
  bloodTypes: [String],
  message: String,
  type: { type: String, default: 'daily' }, // 'daily' (trong ngày) hoặc 'schedule' (đặt lịch)
  scheduleDate: String, // 'YYYY-MM-DD'
  maxDonors: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  responders: [{
      userId: String,
      name: String,
      phone: String,
      bloodType: String,
      status: String, // "Đồng Ý" hoặc "Từ Chối"
      // Chi tiết Form Hỗ Trợ
      supportType: String,
      helperName: String,
      helperPhone: String,
      helperBloodType: String,
      helperLat: Number,
      helperLng: Number,
      respondedAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

const Broadcast = mongoose.model('Broadcast', BroadcastSchema);

const EmergencyMissionSchema = new mongoose.Schema({
  hospitalId: String,
  userId: String,
  user: Object, // Toàn bộ thông tin donor tại thời điểm đó
  status: { type: String, default: 'ĐANG ĐẾN' }, // 'ĐANG ĐẾN', 'ĐÃ ĐẾN', 'ĐÃ HIẾN MÁU'
  isCompleted: { type: Boolean, default: false }
}, { timestamps: true });

const EmergencyMission = mongoose.model('EmergencyMission', EmergencyMissionSchema);

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
   const { phone, name, email, bloodType, location, pushSubscription, mockId, donationCount, isOnline, weight, height, age, lastDonationDate } = req.body;
   try {
       // Tạo query linh hoạt cho test
       let query = mockId ? { _id: mockId } : { phone };
       
       let user = null;
       let newSessionToken = null;
       if (mockId) {
          user = await User.findById(mockId);
          if (!user) {
              return res.status(401).json({ error: "Phiên đăng nhập không hợp lệ hoặc tài khoản đã bị xóa." });
          }
       } else {
          // Gắn cờ hiệu tạo session mới vì đây là luồng đăng nhập (không truyền mockId)
          newSessionToken = Math.random().toString(36).substring(2, 15);
          
          const existingUserByEmail = await User.findOne({ email });
          const existingUserByPhone = await User.findOne({ phone });
          
          if (existingUserByEmail && existingUserByPhone) {
              if (existingUserByEmail._id.toString() !== existingUserByPhone._id.toString()) {
                  return res.status(400).json({ error: "Email và Số điện thoại này đang thuộc về 2 tài khoản khác nhau!" });
              }
              user = existingUserByEmail;
          } else if (existingUserByEmail) {
              if (existingUserByEmail.phone !== phone) {
                  return res.status(400).json({ error: `Email ${email} đã được đăng ký với một số điện thoại khác!` });
              }
              user = existingUserByEmail;
          } else if (existingUserByPhone) {
              if (existingUserByPhone.email !== email) {
                  return res.status(400).json({ error: `Số điện thoại ${phone} đã được đăng ký với một email khác!` });
              }
              user = existingUserByPhone;
          }
       }
       
       if (!user) {
           user = new User({ 
               name, phone, email, bloodType, location, pushSubscription, 
               isOnline: isOnline !== undefined ? isOnline : true,
               donationCount: donationCount || 0,
               weight, height, age, lastDonationDate
           });
       } else {
           if (location) user.location = location;
           if (pushSubscription) user.pushSubscription = pushSubscription;
           if (name) user.name = name;
           if (phone) user.phone = phone;
           if (bloodType) user.bloodType = bloodType;
           if (donationCount !== undefined) user.donationCount = donationCount;
           if (weight !== undefined) user.weight = weight;
           if (height !== undefined) user.height = height;
           if (age !== undefined) user.age = age;
           if (lastDonationDate !== undefined) user.lastDonationDate = lastDonationDate;
           user.isOnline = isOnline !== undefined ? isOnline : true;
       }
       
       if (newSessionToken) {
           user.sessionToken = newSessionToken;
       }
       
       await user.save();
       
       if (newSessionToken) {
           io.to(user._id.toString()).emit('force-logout', newSessionToken);
       }
       
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

// Danh sách broadcast toàn cục
app.get('/api/broadcasts', async (req, res) => {
    try {
        const broadcasts = await Broadcast.find({ isActive: true }).sort({ createdAt: -1 });
        res.json({ broadcasts: broadcasts.map(b => ({ ...b._doc, id: b._id.toString() })) });
    } catch (e) { res.status(500).json({ error: e.message }) }
});

// Bệnh viện đăng broadcast khẩn
app.post('/api/broadcasts', async (req, res) => {
    try {
        const { hospitalId, hospitalName, bloodTypes, message, type, scheduleDate, maxDonors } = req.body;
        const newBroadcast = new Broadcast({ hospitalId, hospitalName, bloodTypes, message, type, scheduleDate, maxDonors });
        await newBroadcast.save();
        
        // Bắn Socket Realtime tới TOÀN BỘ NGƯỜI DÙNG (Kênh 'global-broadcast')
        io.emit('new-broadcast', { ...newBroadcast._doc, id: newBroadcast._id.toString() });
        
        res.json({ success: true, broadcast: { ...newBroadcast._doc, id: newBroadcast._id.toString() } });
    } catch (e) { res.status(500).json({ error: e.message }) }
});

// Donor phản hồi Broadcast
app.post('/api/broadcasts/:id/respond', async (req, res) => {
    try {
        const { userId, status, supportType, helperName, helperPhone, helperBloodType, helperLat, helperLng } = req.body;
        const broadcast = await Broadcast.findById(req.params.id);
        const user = await User.findById(userId);
        
        if (!broadcast || !user) return res.status(404).json({ error: "Không tìm thấy" });
        
        // Xóa phản hồi cũ nếu có
        broadcast.responders = broadcast.responders.filter(r => r.userId !== userId);
        
        // Khoảng thời gian
        const respondedAt = new Date().toISOString();

        // Thêm phản hồi mới
        broadcast.responders.push({
            userId, name: user.name, phone: user.phone, bloodType: user.bloodType, status,
            supportType, helperName, helperPhone, helperBloodType, helperLat, helperLng, respondedAt
        });
        
        await broadcast.save();
        
        // Báo cho Bệnh viện (Realtime cập nhật danh sách)
        io.to(`hospital_${broadcast.hospitalId}`).emit('broadcast-update', { id: broadcast._id.toString(), responders: broadcast.responders });
        
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }) }
});

// Lấy toàn bộ users (Dành cho Hộp thư Inbox)
app.get('/api/users', async (req, res) => {
    try {
        const users = await User.find({});
        res.json({ users: users.map(u => ({ ...u._doc, id: u._id.toString() })) });
    } catch(e) { res.status(500).json({ error: e.message }) }
});

// --- CẬP NHẬT: QUẢN LÝ LỆNH ĐIỀU ĐỘNG KHẨN (ROUTINE) ---
app.get('/api/emergency-missions', async (req, res) => {
    const { hospitalId, userId } = req.query;
    try {
        const query = { isCompleted: false };
        if (hospitalId) query.hospitalId = hospitalId;
        if (userId) query.userId = userId;
        
        const missions = await EmergencyMission.find(query).sort({ createdAt: -1 });
        res.json({ missions: missions.map(m => ({ ...m._doc, id: m._id.toString() })) });
    } catch(e) { res.status(500).json({ error: e.message }) }
});

app.post('/api/emergency-missions', async (req, res) => {
    const { hospitalId, userId, user, status } = req.body;
    try {
        // Hủy các mission cũ chưa hoàn thành của donor này
        await EmergencyMission.updateMany({ userId, isCompleted: false }, { isCompleted: true });
        
        const newMission = new EmergencyMission({ hospitalId, userId, user, status, isCompleted: false });
        await newMission.save();
        
        const payload = { ...newMission._doc, id: newMission._id.toString() };
        
        // Báo cho bệnh viện
        io.to(`hospital_${hospitalId}`).emit('emergency-mission-update', payload);
        // Báo lại cho donor nếu cần
        io.to(userId).emit('emergency-mission-update', payload);
        
        res.json({ success: true, mission: payload });
    } catch(e) { res.status(500).json({ error: e.message }) }
});

app.put('/api/emergency-missions/:id/status', async (req, res) => {
    try {
        const { status } = req.body; 
        const mission = await EmergencyMission.findById(req.params.id);
        if (!mission) return res.status(404).json({error: "Not found"});
        
        mission.status = status;
        if (status === 'ĐÃ HIẾN MÁU') {
            mission.isCompleted = true;
            // Optionally update user donationCount
            const u = await User.findById(mission.userId);
            if(u) {
                u.donationCount = (u.donationCount || 0) + 1;
                u.lastDonationDate = new Date().toISOString();
                await u.save();
            }
        }
        await mission.save();
        
        const payload = { ...mission._doc, id: mission._id.toString() };
        io.to(`hospital_${mission.hospitalId}`).emit('emergency-mission-update', payload);
        io.to(mission.userId).emit('emergency-mission-update', payload);
        
        res.json({ success: true, mission: payload });
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
               await webpush.sendNotification(user.pushSubscription, payload, {
                   urgency: 'high',
                   TTL: 86400
               });
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

    socket.on('emergency-response', (payload) => {
        io.to(`hospital_${payload.hospitalId}`).emit('emergency-response', payload);
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

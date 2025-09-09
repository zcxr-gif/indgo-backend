// server.js (Updated for AWS S3)

// 1. IMPORT DEPENDENCIES
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const multerS3 = require('multer-s3');
require('dotenv').config();

// 2. INITIALIZE EXPRESS APP & AWS S3 CLIENT
const app = express();
const PORT = process.env.PORT || 5000;

// Configure the AWS S3 client
const s3Client = new S3Client({
    region: process.env.AWS_REGION, // e.g., 'us-east-2'
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

// 3. MIDDLEWARE
app.use(cors());
// NOTE: express.json() is applied on a per-route basis where needed.

// --- REMOVED STATIC FILE SERVER ---
// app.use('/uploads', express.static(path.join(__dirname, 'uploads'))); // No longer needed

// Multer configuration for AWS S3 uploads
const upload = multer({
    storage: multerS3({
        s3: s3Client,
        bucket: process.env.AWS_S3_BUCKET_NAME,
        contentType: multerS3.AUTO_CONTENT_TYPE, // Automatically set content type
        metadata: function (req, file, cb) {
            cb(null, { fieldName: file.fieldname });
        },
        key: function (req, file, cb) {
            let folder = 'misc/'; // Default folder

            if (file.fieldname === 'profilePicture') {
                folder = 'profiles/';
            } else if (file.fieldname === 'eventImage' || file.fieldname === 'highlightImage') {
                folder = 'community/';
            }
            
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            const fileName = file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname);
            cb(null, folder + fileName);
        }
    })
});

// 4. CONNECT TO MONGODB DATABASE
mongoose.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
}).then(() => console.log('MongoDB connected successfully.'))
  .catch(err => console.error('MongoDB connection error:', err));


// 5. DEFINE SCHEMAS AND MODELS (No changes needed here)

// --- User Schema ---
const UserSchema = new mongoose.Schema({
    name: { type: String, default: 'New Staff Member' },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { 
        type: String, 
        enum: [
            'staff', 'pilot', 'admin',
            'Chief Executive Officer (CEO)', 'Chief Operating Officer (COO)', 'PIREP Manager (PM)',
            'Pilot Relations & Recruitment Manager (PR)', 'Technology & Design Manager (TDM)',
            'Head of Training (COT)', 'Chief Marketing Officer (CMO)', 'Route Manager (RM)',
            'Events Manager (EM)', 'Flight Instructor (FI)'
        ], 
        default: 'staff' 
    },
    bio: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    discord: { type: String, default: '' },
    ifc: { type: String, default: '' },
    youtube: { type: String, default: '' },
    preferredContact: { 
        type: String, 
        enum: ['none', 'discord', 'ifc', 'youtube'],
        default: 'none' 
    },
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

// --- Admin Log Schema ---
const AdminLogSchema = new mongoose.Schema({
    adminUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true, enum: ['ROLE_UPDATE', 'USER_DELETE'] },
    targetUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    details: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
});
const AdminLog = mongoose.model('AdminLog', AdminLogSchema);


// --- Event Schema ---
const EventSchema = new mongoose.Schema({
    title: { type: String, required: true },
    date: { type: Date, required: true },
    description: { type: String, required: true },
    imageUrl: { type: String }, // Optional image
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now }
});
const Event = mongoose.model('Event', EventSchema);

// --- Highlight Schema ---
const HighlightSchema = new mongoose.Schema({
    title: { type: String, required: true },
    winnerName: { type: String, required: true },
    description: { type: String },
    imageUrl: { type: String, required: true }, // Required image
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now }
});
const Highlight = mongoose.model('Highlight', HighlightSchema);

// 6. HELPER FUNCTION & AUTH MIDDLEWARE

// NEW: Helper function to delete an object from S3
const deleteS3Object = async (imageUrl) => {
    if (!imageUrl) return;
    try {
        const url = new URL(imageUrl);
        const key = url.pathname.substring(1); // Remove leading '/'
        const command = new DeleteObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET_NAME,
            Key: key,
        });
        await s3Client.send(command);
        console.log(`Successfully deleted ${key} from S3.`);
    } catch (error) {
        console.error(`Failed to delete object from S3: ${imageUrl}`, error);
    }
};

const authMiddleware = (req, res, next) => {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
        return res.status(401).json({ message: 'Access denied. No token provided.' });
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (ex) {
        res.status(400).json({ message: 'Invalid token.' });
    }
};

const isAdmin = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ message: 'Access denied. Administrator privileges required.' });
    }
};

const isCommunityManager = (req, res, next) => {
    const authorizedRoles = [
        'Chief Executive Officer (CEO)', 'Chief Operating Officer (COO)', 'admin',
        'Chief Marketing Officer (CMO)', 'Events Manager (EM)'
    ];
    if (req.user && authorizedRoles.includes(req.user.role)) {
        next();
    } else {
        res.status(403).json({ message: 'Access denied. You do not have permission to manage community content.' });
    }
};

// 7. API ROUTES (ENDPOINTS)

// --- Community Content Routes ---

// POST a new event
app.post('/api/events', authMiddleware, isCommunityManager, upload.single('eventImage'), async (req, res) => {
    try {
        const { title, date, description } = req.body;
        const newEvent = new Event({
            title,
            date,
            description,
            author: req.user._id,
            // S3 provides the full URL in `req.file.location`
            imageUrl: req.file ? req.file.location : undefined
        });
        await newEvent.save();
        res.status(201).json({ message: 'Event created successfully!', event: newEvent });
    } catch (error) {
        console.error("Error creating event:", error);
        res.status(500).json({ message: 'Server error while creating event.' });
    }
});

// GET all events (public)
app.get('/api/events', async (req, res) => {
    try {
        const events = await Event.find().sort({ date: -1 });
        res.json(events);
    } catch (error) {
        res.status(500).json({ message: 'Server error while fetching events.' });
    }
});

// POST a new highlight
app.post('/api/highlights', authMiddleware, isCommunityManager, upload.single('highlightImage'), async (req, res) => {
    try {
        const { title, winnerName, description } = req.body;
        if (!req.file) {
            return res.status(400).json({ message: 'An image is required for a highlight.' });
        }
        const newHighlight = new Highlight({
            title,
            winnerName,
            description,
            author: req.user._id,
            // S3 provides the full URL in `req.file.location`
            imageUrl: req.file.location
        });
        await newHighlight.save();
        res.status(201).json({ message: 'Highlight created successfully!', highlight: newHighlight });
    } catch (error) {
        console.error("Error creating highlight:", error);
        res.status(500).json({ message: 'Server error while creating highlight.' });
    }
});

// GET all highlights (public)
app.get('/api/highlights', async (req, res) => {
    try {
        const highlights = await Highlight.find().sort({ createdAt: -1 });
        res.json(highlights);
    } catch (error) {
        res.status(500).json({ message: 'Server error while fetching highlights.' });
    }
});

// DELETE an event
app.delete('/api/events/:id', authMiddleware, isCommunityManager, async (req, res) => {
    try {
        const event = await Event.findById(req.params.id);
        if (!event) {
            return res.status(404).json({ message: 'Event not found.' });
        }
        // If there's an image, delete it from S3
        if (event.imageUrl) {
            await deleteS3Object(event.imageUrl);
        }
        await Event.findByIdAndDelete(req.params.id);
        res.json({ message: 'Event deleted successfully.' });
    } catch (error) {
        console.error('Error deleting event:', error);
        res.status(500).json({ message: 'Server error while deleting event.' });
    }
});

// DELETE a highlight
app.delete('/api/highlights/:id', authMiddleware, isCommunityManager, async (req, res) => {
    try {
        const highlight = await Highlight.findById(req.params.id);
        if (!highlight) {
            return res.status(404).json({ message: 'Highlight not found.' });
        }
        // Delete the associated image from S3
        await deleteS3Object(highlight.imageUrl);
        await Highlight.findByIdAndDelete(req.params.id);
        res.json({ message: 'Highlight deleted successfully.' });
    } catch (error) {
        console.error('Error deleting highlight:', error);
        res.status(500).json({ message: 'Server error while deleting highlight.' });
    }
});

// --- User and Staff Routes ---

// PUBLIC ROUTE: Get all staff members
app.get('/api/staff', async (req, res) => {
    try {
        const staffMembers = await User.find({
                role: {
                    $in: [
                        'staff', 'admin', 'Chief Executive Officer (CEO)', 'Chief Operating Officer (COO)',
                        'PIREP Manager (PM)', 'Pilot Relations & Recruitment Manager (PR)',
                        'Technology & Design Manager (TDM)', 'Head of Training (COT)',
                        'Chief Marketing Officer (CMO)', 'Route Manager (RM)',
                        'Events Manager (EM)', 'Flight Instructor (FI)'
                    ]
                }
            })
            .select('-password')
            .sort({ createdAt: -1 });
        res.json(staffMembers);
    } catch (error) {
        console.error('Error fetching staff:', error);
        res.status(500).json({ message: 'Server error while fetching staff members.' });
    }
});

// PUBLIC ROUTE: Login a user
app.post('/api/login', express.json(), async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: 'Invalid email or password.' });
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(400).json({ message: 'Invalid email or password.' });
    const token = jwt.sign({ _id: user._id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: '3h' });
    res.json({ token });
});

// PROTECTED ROUTE: Get current user's data
app.get('/api/me', authMiddleware, async (req, res) => {
    const user = await User.findById(req.user._id).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found.' });
    res.json(user);
});

// PROTECTED ROUTE: Update current user's profile
app.put('/api/me', authMiddleware, upload.single('profilePicture'), async (req, res) => {
    const { name, bio, discord, ifc, youtube, preferredContact } = req.body;
    const updatedData = { 
        name, 
        bio,
        discord,
        ifc,
        youtube,
        preferredContact
    };

    if (req.file) {
        // If a new picture was uploaded, delete the old one from S3 first
        const oldUser = await User.findById(req.user._id);
        if (oldUser && oldUser.imageUrl) {
            await deleteS3Object(oldUser.imageUrl);
        }
        // S3 provides the full URL in `req.file.location`
        updatedData.imageUrl = req.file.location;
    }

    try {
        const user = await User.findByIdAndUpdate(req.user._id, updatedData, { new: true }).select('-password');
        if (!user) return res.status(404).json({ message: 'User not found.' });
        
        const token = jwt.sign({ _id: user._id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: '3h' });
        res.json({ message: 'Profile updated successfully!', user, token });

    } catch (error) {
        console.error('Error updating profile:', error);
        res.status(500).json({ message: 'Server error while updating profile.' });
    }
});

// PROTECTED ROUTE: Change current user's password
app.post('/api/me/password', authMiddleware, express.json(), async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters long.' });
    }
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    await User.findByIdAndUpdate(req.user._id, { password: hashedPassword });
    res.json({ message: 'Password updated successfully!' });
});


// --- Admin-Only Routes ---

// ADMIN-ONLY ROUTE: Create a new user
app.post('/api/users', authMiddleware, isAdmin, express.json(), async (req, res) => {
    const { email, password, role } = req.body;
    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ message: 'User with this email already exists.' });
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    user = new User({
        email,
        password: hashedPassword,
        role
    });
    await user.save();
    res.status(201).json({ message: 'User created successfully.', userId: user._id });
});

// ADMIN-ONLY ROUTE: Get all users for management
app.get('/api/users', authMiddleware, isAdmin, async (req, res) => {
    try {
        const users = await User.find().select('-password');
        res.json(users);
    } catch (error) {
        res.status(500).json({ message: 'Server error while fetching users.' });
    }
});

// ADMIN-ONLY ROUTE: Update a user's role
app.put('/api/users/:userId/role', authMiddleware, isAdmin, express.json(), async (req, res) => {
    const { userId } = req.params;
    const { newRole } = req.body;
    const allowedRoles = User.schema.path('role').enumValues;
    if (!allowedRoles.includes(newRole)) {
        return res.status(400).json({ message: 'Invalid role specified.' });
    }
    try {
        const targetUser = await User.findById(userId);
        if (!targetUser) return res.status(404).json({ message: 'User not found.' });
        const oldRole = targetUser.role;
        targetUser.role = newRole;
        await targetUser.save();
        const log = new AdminLog({
            adminUser: req.user._id,
            action: 'ROLE_UPDATE',
            targetUser: userId,
            details: `Changed role for ${targetUser.email} from '${oldRole}' to '${newRole}'.`
        });
        await log.save();
        res.json({ message: `User role successfully updated to ${newRole}.` });
    } catch (error) {
        res.status(500).json({ message: 'Server error while updating user role.' });
    }
});

// ADMIN-ONLY ROUTE: Delete a user
app.delete('/api/users/:userId', authMiddleware, isAdmin, async (req, res) => {
    const { userId } = req.params;
    if (req.user._id === userId) {
        return res.status(400).json({ message: 'You cannot delete your own admin account.' });
    }
    try {
        const userToDelete = await User.findById(userId);
        if (!userToDelete) return res.status(404).json({ message: 'User not found.' });

        // IMPORTANT: Also delete the user's profile picture from S3
        if (userToDelete.imageUrl) {
            await deleteS3Object(userToDelete.imageUrl);
        }

        const deletedUserEmail = userToDelete.email;
        await User.findByIdAndDelete(userId);
        const log = new AdminLog({
            adminUser: req.user._id,
            action: 'USER_DELETE',
            details: `Deleted user with email ${deletedUserEmail}.`
        });
        await log.save();
        res.json({ message: 'User deleted successfully.' });
    } catch (error) {
        res.status(500).json({ message: 'Server error while deleting user.' });
    }
});

// ADMIN-ONLY ROUTE: View activity logs
app.get('/api/logs', authMiddleware, isAdmin, async (req, res) => {
    try {
        const logs = await AdminLog.find()
            .populate('adminUser', 'name email')
            .populate('targetUser', 'name email')
            .sort({ timestamp: -1 });
        res.json(logs);
    } catch (error) {
        res.status(500).json({ message: 'Server error while fetching logs.' });
    }
});

// 8. START THE SERVER
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
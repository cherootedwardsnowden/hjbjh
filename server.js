const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// In-memory storage for file data (replaces MongoDB)
const fileDatabase = new Map();

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadsDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB limit
    },
    fileFilter: function (req, file, cb) {
        // Accept all file types
        cb(null, true);
    }
});

// Generate unique file ID
function generateFileId() {
    return crypto.randomBytes(8).toString('hex');
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ 
                success: false, 
                message: 'No file uploaded' 
            });
        }

        const fileId = generateFileId();
        const fileData = {
            id: fileId,
            originalName: req.file.originalname,
            filename: req.file.filename,
            mimetype: req.file.mimetype,
            size: req.file.size,
            uploadDate: new Date().toISOString(),
            downloadCount: 0,
            path: req.file.path
        };

        // Store in memory database
        fileDatabase.set(fileId, fileData);

        const downloadUrl = `${req.protocol}://${req.get('host')}/download/${fileId}`;

        res.json({
            success: true,
            message: 'File uploaded successfully',
            fileId: fileId,
            downloadUrl: downloadUrl,
            filename: req.file.originalname,
            size: req.file.size
        });

    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Upload failed: ' + error.message 
        });
    }
});

// Download endpoint
app.get('/download/:fileId', (req, res) => {
    try {
        const fileId = req.params.fileId;
        const fileData = fileDatabase.get(fileId);

        if (!fileData) {
            return res.status(404).json({ 
                success: false, 
                message: 'File not found' 
            });
        }

        // Check if file exists on disk
        if (!fs.existsSync(fileData.path)) {
            fileDatabase.delete(fileId);
            return res.status(404).json({ 
                success: false, 
                message: 'File not found on server' 
            });
        }

        // Increment download count
        fileData.downloadCount++;
        fileDatabase.set(fileId, fileData);

        // Send file
        res.download(fileData.path, fileData.originalName, (err) => {
            if (err) {
                console.error('Download error:', err);
                if (!res.headersSent) {
                    res.status(500).json({ 
                        success: false, 
                        message: 'Download failed' 
                    });
                }
            }
        });

    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Download failed: ' + error.message 
        });
    }
});

// Get file info endpoint
app.get('/file/:fileId', (req, res) => {
    try {
        const fileId = req.params.fileId;
        const fileData = fileDatabase.get(fileId);

        if (!fileData) {
            return res.status(404).json({ 
                success: false, 
                message: 'File not found' 
            });
        }

        res.json({
            success: true,
            file: {
                id: fileData.id,
                originalName: fileData.originalName,
                size: fileData.size,
                mimetype: fileData.mimetype,
                uploadDate: fileData.uploadDate,
                downloadCount: fileData.downloadCount
            }
        });

    } catch (error) {
        console.error('File info error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to get file info' 
        });
    }
});

// Delete file endpoint
app.delete('/file/:fileId', (req, res) => {
    try {
        const fileId = req.params.fileId;
        const fileData = fileDatabase.get(fileId);

        if (!fileData) {
            return res.status(404).json({ 
                success: false, 
                message: 'File not found' 
            });
        }

        // Delete file from disk
        if (fs.existsSync(fileData.path)) {
            fs.unlinkSync(fileData.path);
        }

        // Remove from database
        fileDatabase.delete(fileId);

        res.json({
            success: true,
            message: 'File deleted successfully'
        });

    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Delete failed: ' + error.message 
        });
    }
});

// List all files endpoint
app.get('/files', (req, res) => {
    try {
        const files = Array.from(fileDatabase.values()).map(file => ({
            id: file.id,
            originalName: file.originalName,
            size: file.size,
            mimetype: file.mimetype,
            uploadDate: file.uploadDate,
            downloadCount: file.downloadCount
        }));

        res.json({
            success: true,
            files: files,
            count: files.length
        });

    } catch (error) {
        console.error('List files error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to list files' 
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        success: true, 
        status: 'OK',
        filesCount: fileDatabase.size,
        uptime: process.uptime()
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ 
        success: false, 
        message: 'Internal server error' 
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        success: false, 
        message: 'Endpoint not found' 
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Upload endpoint: http://localhost:${PORT}/upload`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});

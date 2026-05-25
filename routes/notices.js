// ============================================
// PHASE 1: NOTICE BOARD - BACKEND
// Production-ready Notice API endpoints
// ============================================

// Add this to your server.js file

const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');

const router = express.Router();
const logger = require('./logger'); // Use from server.js

// ─────────────────────────────────────────
// SSE CLIENTS REGISTRY
// Maintains list of connected SSE clients
// ─────────────────────────────────────────

let sseClients = []; // Array of response objects

function broadcastSSE(eventType, data) {
    logger.info(`Broadcasting SSE: ${eventType} to ${sseClients.length} clients`);
    
    const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    
    sseClients.forEach((res, index) => {
        res.write(message);
        
        // Remove closed connections
        res.on('error', () => {
            sseClients.splice(index, 1);
        });
    });
}

// ─────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────

/**
 * Admin Authentication Middleware
 * Verifies admin password from header
 */
function adminAuth(req, res, next) {
    const providedPassword = req.headers['x-admin-password'];
    
    if (!providedPassword) {
        return res.status(401).json({
            success: false,
            error: 'Admin password required'
        });
    }
    
    // Hash the provided password
    const hash = crypto.createHash('sha256').update(providedPassword).digest('hex');
    
    // Compare with ADMIN_PASSWORD_HASH from env
    if (hash.toUpperCase() !== (process.env.ADMIN_PASSWORD_HASH || '').toUpperCase()) {
        logger.warn('Failed admin authentication attempt');
        return res.status(401).json({
            success: false,
            error: 'Invalid admin password'
        });
    }
    
    // Authentication successful
    req.adminUser = { authenticated: true };
    next();
}

/**
 * Input Validation Middleware
 * Sanitizes and validates notice data
 */
function validateNotice(req, res, next) {
    const { title, content, category, priority, expiresAt } = req.body;
    
    // Validate title
    if (!title || typeof title !== 'string') {
        return res.status(400).json({
            success: false,
            error: 'Title is required and must be a string'
        });
    }
    if (title.trim().length < 5 || title.length > 200) {
        return res.status(400).json({
            success: false,
            error: 'Title must be between 5 and 200 characters'
        });
    }
    
    // Validate content
    if (!content || typeof content !== 'string') {
        return res.status(400).json({
            success: false,
            error: 'Content is required and must be a string'
        });
    }
    if (content.trim().length < 10 || content.length > 5000) {
        return res.status(400).json({
            success: false,
            error: 'Content must be between 10 and 5000 characters'
        });
    }
    
    // Validate category
    const validCategories = ['business', 'event', 'public', 'jobs', 'general'];
    if (category && !validCategories.includes(category)) {
        return res.status(400).json({
            success: false,
            error: `Category must be one of: ${validCategories.join(', ')}`
        });
    }
    
    // Validate priority
    const validPriorities = ['high', 'normal', 'low'];
    if (priority && !validPriorities.includes(priority)) {
        return res.status(400).json({
            success: false,
            error: `Priority must be one of: ${validPriorities.join(', ')}`
        });
    }
    
    // Validate expiration date
    if (expiresAt) {
        const date = new Date(expiresAt);
        if (isNaN(date.getTime())) {
            return res.status(400).json({
                success: false,
                error: 'Invalid expiration date format'
            });
        }
        if (date <= new Date()) {
            return res.status(400).json({
                success: false,
                error: 'Expiration date must be in the future'
            });
        }
    }
    
    // Sanitize HTML (basic)
    req.body.title = sanitizeHTML(title.trim());
    req.body.content = sanitizeHTML(content.trim());
    req.body.category = category || 'general';
    req.body.priority = priority || 'normal';
    
    next();
}

/**
 * Basic HTML sanitization
 * Prevents XSS attacks
 */
function sanitizeHTML(text) {
    if (!text) return '';
    
    return text
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;')
        .replace(/\//g, '&#x2F;');
}

// ─────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────

/**
 * GET /api/notices
 * Fetch all active notices with filtering, search, and pagination
 * 
 * Query Parameters:
 *   - category: Filter by category
 *   - priority: Filter by priority
 *   - search: Full-text search in title and content
 *   - page: Page number (default: 1)
 *   - limit: Items per page (default: 10, max: 50)
 */
router.get('/api/notices', async (req, res) => {
    try {
        const { category, priority, search, page = 1, limit = 10 } = req.query;
        
        // Validate pagination
        const pageNum = Math.max(1, parseInt(page) || 1);
        const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 10));
        const offset = (pageNum - 1) * limitNum;
        
        // Build query dynamically
        let countQuery = 'SELECT COUNT(*) as total FROM notices WHERE is_archived = false AND (expires_at IS NULL OR expires_at > NOW())';
        let dataQuery = `
            SELECT 
                id,
                title,
                content,
                category,
                priority,
                expires_at as "expiresAt",
                created_at as "createdAt",
                created_by as "createdBy",
                EXTRACT(DAY FROM (expires_at - NOW()))::INT as "daysUntilExpiry"
            FROM notices 
            WHERE is_archived = false AND (expires_at IS NULL OR expires_at > NOW())
        `;
        
        const params = [];
        let paramIndex = 1;
        
        // Apply category filter
        if (category && category !== 'all') {
            const filterClause = ` AND category = $${paramIndex}`;
            countQuery += filterClause;
            dataQuery += filterClause;
            params.push(category);
            paramIndex++;
        }
        
        // Apply priority filter
        if (priority && priority !== 'all') {
            const filterClause = ` AND priority = $${paramIndex}`;
            countQuery += filterClause;
            dataQuery += filterClause;
            params.push(priority);
            paramIndex++;
        }
        
        // Apply search filter (search in title and content)
        if (search && search.trim()) {
            const searchTerm = `%${search.trim()}%`;
            const searchClause = ` AND (title ILIKE $${paramIndex} OR content ILIKE $${paramIndex + 1})`;
            countQuery += searchClause;
            dataQuery += searchClause;
            params.push(searchTerm, searchTerm);
            paramIndex += 2;
        }
        
        // Get total count
        const countResult = await req.pool.query(countQuery, params.slice(0, paramIndex - 1));
        const total = parseInt(countResult.rows[0].total);
        const totalPages = Math.ceil(total / limitNum);
        
        // Add ordering and pagination
        dataQuery += ` ORDER BY priority DESC, created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
        params.push(limitNum, offset);
        
        // Get notices
        const result = await req.pool.query(dataQuery, params);
        
        // Log request
        logger.info(`Fetched ${result.rows.length} notices (page ${pageNum} of ${totalPages})`);
        
        res.json({
            success: true,
            data: {
                notices: result.rows,
                pagination: {
                    page: pageNum,
                    limit: limitNum,
                    total,
                    totalPages,
                    hasNextPage: pageNum < totalPages,
                    hasPreviousPage: pageNum > 1
                }
            }
        });
        
    } catch (error) {
        logger.error('Error fetching notices:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch notices'
        });
    }
});

/**
 * GET /api/notices/stream
 * Server-Sent Events (SSE) stream for real-time notice updates
 * 
 * Establishes persistent connection and broadcasts updates to all connected clients
 */
router.get('/api/notices/stream', (req, res) => {
    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // Add this client to active clients list
    sseClients.push(res);
    const clientIndex = sseClients.length - 1;
    
    logger.info(`SSE client connected. Total clients: ${sseClients.length}`);
    
    // Send initial connection message
    res.write(`event: connected\ndata: {"message": "Connected to notice stream"}\n\n`);
    
    // Handle client disconnect
    req.on('close', () => {
        sseClients.splice(clientIndex, 1);
        logger.info(`SSE client disconnected. Total clients: ${sseClients.length}`);
    });
    
    // Keep connection alive with heartbeat
    const heartbeat = setInterval(() => {
        res.write(`: heartbeat\n\n`);
    }, 30000); // Every 30 seconds
    
    res.on('close', () => {
        clearInterval(heartbeat);
    });
});

/**
 * POST /api/admin/notices
 * Create a new notice (admin only)
 * 
 * Headers:
 *   - x-admin-password: Admin password
 * 
 * Body:
 *   - title: Notice title (max 200 chars)
 *   - content: Notice content (max 5000 chars)
 *   - category: 'business' | 'event' | 'public' | 'jobs' | 'general'
 *   - priority: 'high' | 'normal' | 'low'
 *   - expiresAt: ISO date string (optional)
 */
router.post('/api/admin/notices', adminAuth, validateNotice, async (req, res) => {
    try {
        const { title, content, category, priority, expiresAt } = req.body;
        
        const query = `
            INSERT INTO notices 
            (title, content, category, priority, expires_at, created_by, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
            RETURNING 
                id,
                title,
                content,
                category,
                priority,
                expires_at as "expiresAt",
                created_at as "createdAt",
                created_by as "createdBy"
        `;
        
        const result = await req.pool.query(query, [
            title,
            content,
            category,
            priority,
            expiresAt || null,
            'admin'
        ]);
        
        const notice = result.rows[0];
        
        // Broadcast to all connected SSE clients
        broadcastSSE('notice-created', notice);
        
        logger.info(`Notice created: ${notice.id} (${notice.title})`);
        
        res.status(201).json({
            success: true,
            message: 'Notice created successfully',
            data: notice
        });
        
    } catch (error) {
        logger.error('Error creating notice:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to create notice'
        });
    }
});

/**
 * PUT /api/admin/notices/:id
 * Update an existing notice (admin only)
 */
router.put('/api/admin/notices/:id', adminAuth, validateNotice, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, content, category, priority, expiresAt } = req.body;
        
        // Verify notice exists
        const checkQuery = 'SELECT id FROM notices WHERE id = $1';
        const checkResult = await req.pool.query(checkQuery, [id]);
        
        if (checkResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Notice not found'
            });
        }
        
        const query = `
            UPDATE notices 
            SET title = $1, content = $2, category = $3, priority = $4, 
                expires_at = $5, updated_at = NOW()
            WHERE id = $6
            RETURNING 
                id,
                title,
                content,
                category,
                priority,
                expires_at as "expiresAt",
                created_at as "createdAt",
                created_by as "createdBy",
                updated_at as "updatedAt"
        `;
        
        const result = await req.pool.query(query, [
            title,
            content,
            category,
            priority,
            expiresAt || null,
            id
        ]);
        
        const notice = result.rows[0];
        
        // Broadcast update to all connected clients
        broadcastSSE('notice-updated', notice);
        
        logger.info(`Notice updated: ${id}`);
        
        res.json({
            success: true,
            message: 'Notice updated successfully',
            data: notice
        });
        
    } catch (error) {
        logger.error('Error updating notice:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to update notice'
        });
    }
});

/**
 * DELETE /api/admin/notices/:id
 * Delete a notice (admin only)
 * Soft delete - sets is_archived to true
 */
router.delete('/api/admin/notices/:id', adminAuth, async (req, res) => {
    try {
        const { id } = req.params;
        
        // Soft delete (archive)
        const query = `
            UPDATE notices 
            SET is_archived = true, updated_at = NOW()
            WHERE id = $1
            RETURNING id
        `;
        
        const result = await req.pool.query(query, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Notice not found'
            });
        }
        
        // Broadcast deletion to all connected clients
        broadcastSSE('notice-deleted', { id });
        
        logger.info(`Notice deleted (archived): ${id}`);
        
        res.json({
            success: true,
            message: 'Notice deleted successfully'
        });
        
    } catch (error) {
        logger.error('Error deleting notice:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to delete notice'
        });
    }
});

/**
 * GET /api/admin/notices
 * Get all notices (including archived) for admin view
 */
router.get('/api/admin/notices', adminAuth, async (req, res) => {
    try {
        const query = `
            SELECT 
                id,
                title,
                content,
                category,
                priority,
                expires_at as "expiresAt",
                created_at as "createdAt",
                updated_at as "updatedAt",
                created_by as "createdBy",
                is_archived as "isArchived"
            FROM notices 
            ORDER BY created_at DESC
            LIMIT 100
        `;
        
        const result = await req.pool.query(query);
        
        res.json({
            success: true,
            data: {
                notices: result.rows,
                total: result.rows.length
            }
        });
        
    } catch (error) {
        logger.error('Error fetching admin notices:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch notices'
        });
    }
});

/**
 * GET /api/notices/categories
 * Get list of available notice categories
 */
router.get('/api/notices/categories', (req, res) => {
    res.json({
        success: true,
        data: {
            categories: ['business', 'event', 'public', 'jobs', 'general']
        }
    });
});

/**
 * GET /api/notices/priorities
 * Get list of available priorities
 */
router.get('/api/notices/priorities', (req, res) => {
    res.json({
        success: true,
        data: {
            priorities: ['high', 'normal', 'low']
        }
    });
});

// ─────────────────────────────────────────
// ERROR HANDLING
// ─────────────────────────────────────────

router.use((error, req, res, next) => {
    logger.error('Notice API error:', error.message);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// ─────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────

module.exports = router;

// ============================================
// HOW TO INTEGRATE INTO SERVER.JS
// ============================================

/*

In your server.js, add:

// 1. Import the router
const noticesRouter = require('./routes/notices');

// 2. After database setup, add middleware to attach pool to request
app.use((req, res, next) => {
  req.pool = pool;  // PostgreSQL connection pool
  next();
});

// 3. Mount the router
app.use(noticesRouter);

// Now all routes will be available:
// GET  /api/notices
// GET  /api/notices/stream
// POST /api/admin/notices
// PUT  /api/admin/notices/:id
// DELETE /api/admin/notices/:id

*/

// ============================================
// TESTING WITH CURL
// ============================================

/*

# Get all notices
curl http://localhost:3000/api/notices

# Get business notices
curl http://localhost:3000/api/notices?category=business

# Search notices
curl http://localhost:3000/api/notices?search=water

# Create notice (admin)
curl -X POST http://localhost:3000/api/admin/notices \
  -H "Content-Type: application/json" \
  -H "x-admin-password: your_password" \
  -d '{
    "title": "Test Notice",
    "content": "This is a test notice",
    "category": "business",
    "priority": "normal",
    "expiresAt": "2026-06-23T23:59:59Z"
  }'

# Update notice
curl -X PUT http://localhost:3000/api/admin/notices/notice-id \
  -H "Content-Type: application/json" \
  -H "x-admin-password: your_password" \
  -d '{"title": "Updated Title", "content": "Updated content", ...}'

# Delete notice
curl -X DELETE http://localhost:3000/api/admin/notices/notice-id \
  -H "x-admin-password: your_password"

# Stream real-time updates
curl http://localhost:3000/api/notices/stream

*/

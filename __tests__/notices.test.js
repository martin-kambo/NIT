// ============================================
// PHASE 1: NOTICE BOARD - TEST SUITE
// Jest + Supertest
// ============================================

// Installation: npm install --save-dev jest supertest

const request = require('supertest');
const { Pool } = require('pg');

// Mock data
const mockNotice = {
    title: 'Test Notice',
    content: 'This is a test notice for unit testing',
    category: 'event',
    priority: 'normal'
};

const invalidNotice = {
    title: 'Hi',  // Too short
    content: 'short'  // Too short
};

const adminPassword = process.env.ADMIN_PASSWORD_HASH || 'test_admin';

// ============================================
// API ENDPOINT TESTS
// ============================================

describe('Notice Board API', () => {

    let app;
    let pool;

    beforeAll(async () => {
        // Initialize Express app and database
        // This assumes you have server.js exported
        app = require('../server');
        
        // For testing, use test database or mock
        // Alternatively, connect to test database
    });

    afterAll(async () => {
        // Close database connections
        // await pool.end();
    });

    // ─────────────────────────────────────────
    // GET /api/notices
    // ─────────────────────────────────────────

    describe('GET /api/notices', () => {

        test('should return all notices with pagination', async () => {
            const response = await request(app)
                .get('/api/notices')
                .expect(200);

            expect(response.body).toHaveProperty('success', true);
            expect(response.body).toHaveProperty('data');
            expect(response.body.data).toHaveProperty('notices');
            expect(response.body.data).toHaveProperty('pagination');
            expect(Array.isArray(response.body.data.notices)).toBe(true);
        });

        test('should have correct pagination structure', async () => {
            const response = await request(app)
                .get('/api/notices')
                .expect(200);

            const { pagination } = response.body.data;
            expect(pagination).toHaveProperty('page');
            expect(pagination).toHaveProperty('limit');
            expect(pagination).toHaveProperty('total');
            expect(pagination).toHaveProperty('totalPages');
            expect(pagination).toHaveProperty('hasNextPage');
            expect(pagination).toHaveProperty('hasPreviousPage');
        });

        test('should filter by category', async () => {
            const response = await request(app)
                .get('/api/notices?category=business')
                .expect(200);

            const notices = response.body.data.notices;
            notices.forEach(notice => {
                expect(notice.category).toBe('business');
            });
        });

        test('should filter by priority', async () => {
            const response = await request(app)
                .get('/api/notices?priority=high')
                .expect(200);

            const notices = response.body.data.notices;
            notices.forEach(notice => {
                expect(notice.priority).toBe('high');
            });
        });

        test('should search in title and content', async () => {
            const response = await request(app)
                .get('/api/notices?search=market')
                .expect(200);

            const notices = response.body.data.notices;
            notices.forEach(notice => {
                const titleMatch = notice.title.toLowerCase().includes('market');
                const contentMatch = notice.content.toLowerCase().includes('market');
                expect(titleMatch || contentMatch).toBe(true);
            });
        });

        test('should handle pagination', async () => {
            const response = await request(app)
                .get('/api/notices?page=1&limit=5')
                .expect(200);

            const { notices, pagination } = response.body.data;
            expect(notices.length).toBeLessThanOrEqual(5);
            expect(pagination.limit).toBe(5);
            expect(pagination.page).toBe(1);
        });

        test('should return empty results for non-matching search', async () => {
            const response = await request(app)
                .get('/api/notices?search=xyz123nonexistent')
                .expect(200);

            expect(response.body.data.notices.length).toBe(0);
        });

        test('should have correct notice structure', async () => {
            const response = await request(app)
                .get('/api/notices')
                .expect(200);

            if (response.body.data.notices.length > 0) {
                const notice = response.body.data.notices[0];
                expect(notice).toHaveProperty('id');
                expect(notice).toHaveProperty('title');
                expect(notice).toHaveProperty('content');
                expect(notice).toHaveProperty('category');
                expect(notice).toHaveProperty('priority');
                expect(notice).toHaveProperty('createdAt');
                expect(notice).toHaveProperty('createdBy');
            }
        });

        test('should not show archived notices', async () => {
            const response = await request(app)
                .get('/api/notices')
                .expect(200);

            const notices = response.body.data.notices;
            notices.forEach(notice => {
                expect(notice.isArchived).not.toBe(true);
            });
        });

        test('should not show expired notices', async () => {
            const response = await request(app)
                .get('/api/notices')
                .expect(200);

            const notices = response.body.data.notices;
            // All notices should have expiresAt in future or null
            // (This depends on test data setup)
        });
    });

    // ─────────────────────────────────────────
    // GET /api/notices/stream (SSE)
    // ─────────────────────────────────────────

    describe('GET /api/notices/stream', () => {

        test('should establish SSE connection', async () => {
            const response = await request(app)
                .get('/api/notices/stream')
                .set('Accept', 'text/event-stream');

            expect(response.status).toBe(200);
            expect(response.headers['content-type']).toContain('text/event-stream');
        });

        test('should have correct SSE headers', async () => {
            const response = await request(app)
                .get('/api/notices/stream');

            expect(response.headers['cache-control']).toBe('no-cache');
            expect(response.headers['connection']).toBe('keep-alive');
        });
    });

    // ─────────────────────────────────────────
    // POST /api/admin/notices
    // ─────────────────────────────────────────

    describe('POST /api/admin/notices', () => {

        test('should reject request without password', async () => {
            const response = await request(app)
                .post('/api/admin/notices')
                .send(mockNotice)
                .expect(401);

            expect(response.body.success).toBe(false);
            expect(response.body.error).toContain('password');
        });

        test('should reject request with wrong password', async () => {
            const response = await request(app)
                .post('/api/admin/notices')
                .set('x-admin-password', 'wrong_password')
                .send(mockNotice)
                .expect(401);

            expect(response.body.success).toBe(false);
        });

        test('should reject notice with title too short', async () => {
            const response = await request(app)
                .post('/api/admin/notices')
                .set('x-admin-password', adminPassword)
                .send(invalidNotice)
                .expect(400);

            expect(response.body.success).toBe(false);
            expect(response.body.error).toContain('Title');
        });

        test('should reject notice with content too short', async () => {
            const response = await request(app)
                .post('/api/admin/notices')
                .set('x-admin-password', adminPassword)
                .send({
                    title: 'Valid Title Here',
                    content: 'short',
                    category: 'business',
                    priority: 'normal'
                })
                .expect(400);

            expect(response.body.success).toBe(false);
            expect(response.body.error).toContain('Content');
        });

        test('should reject notice with invalid category', async () => {
            const response = await request(app)
                .post('/api/admin/notices')
                .set('x-admin-password', adminPassword)
                .send({
                    ...mockNotice,
                    category: 'invalid_category'
                })
                .expect(400);

            expect(response.body.success).toBe(false);
            expect(response.body.error).toContain('Category');
        });

        test('should reject notice with invalid priority', async () => {
            const response = await request(app)
                .post('/api/admin/notices')
                .set('x-admin-password', adminPassword)
                .send({
                    ...mockNotice,
                    priority: 'urgent'
                })
                .expect(400);

            expect(response.body.success).toBe(false);
            expect(response.body.error).toContain('Priority');
        });

        test('should reject expired date in future', async () => {
            const pastDate = new Date();
            pastDate.setDate(pastDate.getDate() - 1);

            const response = await request(app)
                .post('/api/admin/notices')
                .set('x-admin-password', adminPassword)
                .send({
                    ...mockNotice,
                    expiresAt: pastDate.toISOString()
                })
                .expect(400);

            expect(response.body.success).toBe(false);
            expect(response.body.error).toContain('future');
        });

        test('should create valid notice', async () => {
            const futureDate = new Date();
            futureDate.setDate(futureDate.getDate() + 30);

            const response = await request(app)
                .post('/api/admin/notices')
                .set('x-admin-password', adminPassword)
                .send({
                    ...mockNotice,
                    expiresAt: futureDate.toISOString()
                })
                .expect(201);

            expect(response.body.success).toBe(true);
            expect(response.body.data).toHaveProperty('id');
            expect(response.body.data.title).toBe(mockNotice.title);
            expect(response.body.data.category).toBe(mockNotice.category);
        });

        test('should sanitize HTML in title', async () => {
            const response = await request(app)
                .post('/api/admin/notices')
                .set('x-admin-password', adminPassword)
                .send({
                    title: '<img src=x onerror="alert(1)"> Test',
                    content: 'This is a test notice for XSS prevention',
                    category: 'business',
                    priority: 'normal'
                })
                .expect(201);

            expect(response.body.data.title).not.toContain('<img');
            expect(response.body.data.title).toContain('&lt;img');
        });

        test('should sanitize HTML in content', async () => {
            const response = await request(app)
                .post('/api/admin/notices')
                .set('x-admin-password', adminPassword)
                .send({
                    title: 'XSS Test Notice',
                    content: '<script>alert("XSS")</script> Content here',
                    category: 'business',
                    priority: 'normal'
                })
                .expect(201);

            expect(response.body.data.content).not.toContain('<script>');
            expect(response.body.data.content).toContain('&lt;script&gt;');
        });
    });

    // ─────────────────────────────────────────
    // PUT /api/admin/notices/:id
    // ─────────────────────────────────────────

    describe('PUT /api/admin/notices/:id', () => {

        let testNoticeId;

        beforeAll(async () => {
            // Create a test notice first
            const futureDate = new Date();
            futureDate.setDate(futureDate.getDate() + 30);

            const response = await request(app)
                .post('/api/admin/notices')
                .set('x-admin-password', adminPassword)
                .send({
                    ...mockNotice,
                    expiresAt: futureDate.toISOString()
                });

            if (response.body.success) {
                testNoticeId = response.body.data.id;
            }
        });

        test('should reject without password', async () => {
            const response = await request(app)
                .put(`/api/admin/notices/${testNoticeId}`)
                .send({ ...mockNotice, title: 'Updated Title' })
                .expect(401);

            expect(response.body.success).toBe(false);
        });

        test('should update notice', async () => {
            const response = await request(app)
                .put(`/api/admin/notices/${testNoticeId}`)
                .set('x-admin-password', adminPassword)
                .send({
                    ...mockNotice,
                    title: 'Updated Notice Title'
                })
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(response.body.data.title).toBe('Updated Notice Title');
        });

        test('should return 404 for non-existent notice', async () => {
            const response = await request(app)
                .put('/api/admin/notices/00000000-0000-0000-0000-000000000000')
                .set('x-admin-password', adminPassword)
                .send(mockNotice)
                .expect(404);

            expect(response.body.success).toBe(false);
        });
    });

    // ─────────────────────────────────────────
    // DELETE /api/admin/notices/:id
    // ─────────────────────────────────────────

    describe('DELETE /api/admin/notices/:id', () => {

        let testNoticeId;

        beforeAll(async () => {
            // Create a test notice first
            const futureDate = new Date();
            futureDate.setDate(futureDate.getDate() + 30);

            const response = await request(app)
                .post('/api/admin/notices')
                .set('x-admin-password', adminPassword)
                .send({
                    ...mockNotice,
                    expiresAt: futureDate.toISOString()
                });

            if (response.body.success) {
                testNoticeId = response.body.data.id;
            }
        });

        test('should reject without password', async () => {
            const response = await request(app)
                .delete(`/api/admin/notices/${testNoticeId}`)
                .expect(401);

            expect(response.body.success).toBe(false);
        });

        test('should delete notice', async () => {
            const response = await request(app)
                .delete(`/api/admin/notices/${testNoticeId}`)
                .set('x-admin-password', adminPassword)
                .expect(200);

            expect(response.body.success).toBe(true);
        });

        test('should return 404 for non-existent notice', async () => {
            const response = await request(app)
                .delete('/api/admin/notices/00000000-0000-0000-0000-000000000000')
                .set('x-admin-password', adminPassword)
                .expect(404);

            expect(response.body.success).toBe(false);
        });

        test('should soft delete (archive) not hard delete', async () => {
            // After deletion, notice should still exist in DB but with is_archived=true
            // This would require database inspection
        });
    });

    // ─────────────────────────────────────────
    // GET /api/notices/categories
    // ─────────────────────────────────────────

    describe('GET /api/notices/categories', () => {

        test('should return list of categories', async () => {
            const response = await request(app)
                .get('/api/notices/categories')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(Array.isArray(response.body.data.categories)).toBe(true);
            expect(response.body.data.categories).toContain('business');
            expect(response.body.data.categories).toContain('event');
            expect(response.body.data.categories).toContain('public');
            expect(response.body.data.categories).toContain('jobs');
        });
    });

    // ─────────────────────────────────────────
    // GET /api/notices/priorities
    // ─────────────────────────────────────────

    describe('GET /api/notices/priorities', () => {

        test('should return list of priorities', async () => {
            const response = await request(app)
                .get('/api/notices/priorities')
                .expect(200);

            expect(response.body.success).toBe(true);
            expect(Array.isArray(response.body.data.priorities)).toBe(true);
            expect(response.body.data.priorities).toContain('high');
            expect(response.body.data.priorities).toContain('normal');
            expect(response.body.data.priorities).toContain('low');
        });
    });
});

// ============================================
// SECURITY TESTS
// ============================================

describe('Security', () => {

    let app;

    beforeAll(() => {
        app = require('../server');
    });

    test('should prevent SQL injection in search', async () => {
        const response = await request(app)
            .get("/api/notices?search='; DROP TABLE notices; --")
            .expect(200);

        // Should not cause error, just return empty results
        expect(response.body.success).toBe(true);
    });

    test('should prevent XSS via notice title', async () => {
        const response = await request(app)
            .post('/api/admin/notices')
            .set('x-admin-password', adminPassword)
            .send({
                title: '<img src=x onerror="alert(1)"> Test',
                content: 'This is test content for security testing',
                category: 'business',
                priority: 'normal'
            })
            .expect(201);

        // HTML should be escaped
        expect(response.body.data.title).toContain('&lt;');
        expect(response.body.data.title).not.toContain('<img');
    });

    test('should prevent XSS via notice content', async () => {
        const response = await request(app)
            .post('/api/admin/notices')
            .set('x-admin-password', adminPassword)
            .send({
                title: 'XSS Test Notice',
                content: '<script>alert("XSS")</script> Content',
                category: 'business',
                priority: 'normal'
            })
            .expect(201);

        expect(response.body.data.content).toContain('&lt;script&gt;');
        expect(response.body.data.content).not.toContain('<script>');
    });

    test('should authenticate admin requests', async () => {
        const response = await request(app)
            .post('/api/admin/notices')
            .send({
                title: 'Unauthorized Notice',
                content: 'This should not be created',
                category: 'business',
                priority: 'normal'
            })
            .expect(401);

        expect(response.body.success).toBe(false);
    });
});

// ============================================
// PERFORMANCE TESTS
// ============================================

describe('Performance', () => {

    let app;

    beforeAll(() => {
        app = require('../server');
    });

    test('should return results in < 500ms', async () => {
        const start = Date.now();

        await request(app)
            .get('/api/notices')
            .expect(200);

        const duration = Date.now() - start;
        expect(duration).toBeLessThan(500);
    });

    test('should handle large pagination efficiently', async () => {
        const start = Date.now();

        await request(app)
            .get('/api/notices?page=10&limit=50')
            .expect(200);

        const duration = Date.now() - start;
        expect(duration).toBeLessThan(500);
    });
});
